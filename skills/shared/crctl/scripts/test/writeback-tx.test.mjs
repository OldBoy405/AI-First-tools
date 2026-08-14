// CR-2026-038：writeback 内部 generator/preflight、baseline 原子发布与恢复集成测试。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  applyWriteback, canonicalWritebackBusinessInput, prepareWritebackCandidate,
  resolveRepositories, resolveWritebackCandidate,
} from '../lib/workspace-transactions.mjs';
import { git, runCrctl, sha256, makeCodeApprovedFixture, originMasterCount } from './merge-fixture.mjs';

function makeMergedFixture() {
  const f = makeCodeApprovedFixture();
  const { base, kb, cr } = f;
  const r = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.phase, 'complete', JSON.stringify(r.json || r.errJson));
  return { base, kb, cr, txws: r.json.operationalWorkspace };
}

function atomicCallbacks(txws, cr, observed) {
  return {
    validateBaselineAdvance: ({ workspace, plannedExisting }) => {
      assert.equal(workspace, txws);
      assert.deepEqual([...plannedExisting].sort(), ['specs/_index.yml', 'specs/test-spec/PRD.md', 'specs/test-spec/SDD.md']);
      const rel = `change-requests/${cr}/cr.md`;
      const beforeText = fs.readFileSync(path.join(txws, rel), 'utf8');
      return { from: 'merging', to: 'writing-back', trigger: 'writeback-prd-sdd', path: rel, beforeText, beforeSha256: sha256(beforeText) };
    },
    emitStatusEvent: (event) => { observed.status.push(event); },
    emitAdvanceAudit: (event) => { observed.audit.push(event); },
  };
}

test('TASK-01：writeback 业务输入使用固定键序 canonical digest', () => {
  const got = canonicalWritebackBusinessInput({
    cr: 'CR-2026-038', stage: 'traceability', specId: 'tools-cr-lifecycle',
    targetVersion: 'v0.1.0', milestoneFile: 'change-requests\\CR-2026-038\\milestone.yml',
  });
  assert.equal(got.canonicalJson, '{"cr":"CR-2026-038","stage":"traceability","specId":"tools-cr-lifecycle","targetVersion":"0.1.0","milestoneName":null,"brief":null,"milestoneFile":"change-requests/CR-2026-038/milestone.yml"}');
  assert.equal(got.digest, crypto.createHash('sha256').update(got.canonicalJson).digest('hex'));
});

test('TASK-01：固定 generator 只在 ignored candidate 目录生成单次 snapshot', () => {
  const { base, cr, txws } = makeMergedFixture();
  try {
    const expected = resolveWritebackCandidate(txws, cr, 'baseline');
    const got = prepareWritebackCandidate({ txws, cr, stage: 'baseline', specId: 'test-spec', targetVersion: 'v0.2' });
    assert.equal(got.noop, false);
    assert.equal(got.candidate.manifest, expected.manifest);
    assert.equal(got.snapshot.parsed.targetVersion, '0.2');
    assert.deepEqual(got.snapshot.files.map((f) => f.path), ['specs/_index.yml', 'specs/test-spec/PRD.md', 'specs/test-spec/SDD.md']);
    assert.equal(spawnSync('git', ['check-ignore', '-q', expected.dir], { cwd: txws }).status, 0);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-02：内部 baseline 路径同一 commit 发布状态并在 origin-confirmed 后投影', async () => {
  const { base, kb, cr, txws } = makeMergedFixture();
  try {
    const observed = { status: [], audit: [] };
    const result = await applyWriteback(resolveRepositories(kb), {
      cr, stage: 'baseline', specId: 'test-spec', targetVersion: 'v0.2', workspace: kb,
      ...atomicCallbacks(txws, cr, observed),
    });
    assert.equal(result.phase, 'complete');
    assert.equal(result.status, 'writing-back');
    assert.deepEqual(result.warnings, []);
    const bare = path.join(base, 'origin-kb.git');
    const head = git(bare, ['rev-parse', 'master']);
    assert.equal(head, result.commit);
    assert.match(git(bare, ['show', `${head}:change-requests/${cr}/cr.md`]), /^status: writing-back$/m);
    assert.ok(git(bare, ['ls-tree', '-r', '--name-only', head]).includes('specs/test-spec/PRD.md'));
    assert.equal(observed.status.length, 1);
    assert.equal(observed.audit.length, 1);
    assert.equal(observed.status[0].commit, head);
    assert.equal(observed.audit[0].commit, head);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-02：journal-created 恢复冻结 transitionAt，业务参数漂移硬阻断', async () => {
  const { base, kb, cr, txws } = makeMergedFixture();
  try {
    const ctx = resolveRepositories(kb);
    const observed = { status: [], audit: [] };
    const input = { cr, stage: 'baseline', specId: 'test-spec', targetVersion: '0.2', workspace: kb, ...atomicCallbacks(txws, cr, observed) };
    process.env.CRCTL_FAULT_POINT = 'writeback-after-journal-create';
    await assert.rejects(() => applyWriteback(ctx, input), (e) => e.code === 'FAULT_INJECTED');
    delete process.env.CRCTL_FAULT_POINT;
    await assert.rejects(() => applyWriteback(ctx, { ...input, targetVersion: '0.3' }), (e) => e.code === 'TX_INPUT_CONFLICT');
    const txDir = path.join(kb, '.crctl', 'transactions', 'writeback', `${cr}-baseline`);
    const txId = fs.readdirSync(txDir)[0];
    const before = JSON.parse(fs.readFileSync(path.join(txDir, txId, 'journal.json'), 'utf8'));
    const result = await applyWriteback(ctx, input);
    const crMd = git(path.join(base, 'origin-kb.git'), ['show', `${result.commit}:change-requests/${cr}/cr.md`]);
    assert.ok(crMd.includes(`updated-at: "${before.createdAt}"`));
  } finally {
    delete process.env.CRCTL_FAULT_POINT;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('TASK-02：投影失败不反转 Git，重放只补缺项', async () => {
  const { base, kb, cr, txws } = makeMergedFixture();
  try {
    const ctx = resolveRepositories(kb);
    const observed = { status: [], audit: [] };
    const callbacks = atomicCallbacks(txws, cr, observed);
    const input = { cr, stage: 'baseline', specId: 'test-spec', targetVersion: '0.2', workspace: kb, ...callbacks };
    const first = await applyWriteback(ctx, { ...input, emitStatusEvent: () => { throw new Error('outbox unavailable'); } });
    assert.equal(first.warnings[0].code, 'EMIT_FAILED');
    assert.equal(observed.audit.length, 1);
    const head = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
    const second = await applyWriteback(ctx, input);
    assert.equal(second.changed, false);
    assert.deepEqual(second.warnings, []);
    assert.equal(observed.status.length, 1);
    assert.equal(observed.audit.length, 1);
    assert.equal(git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']), head);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-04：公共 CLI 只收业务输入，baseline 同 commit 且幂等；旧/错 stage 参数拒绝', () => {
  const { base, kb, cr } = makeMergedFixture();
  try {
    const rejected = [
      ['--candidate', 'x/manifest.json'],
      ['--candidate=x/manifest.json'],
      ['--milestone-file', 'milestone.yml'],
    ];
    for (const extra of rejected) {
      const bad = runCrctl(['writeback-apply', cr, '--stage', 'baseline', ...extra, '--spec-id', 'test-spec', '--target-version', '0.2', '--workspace', kb], { cwd: kb });
      assert.notEqual(bad.status, 0, `应拒绝 ${extra.join(' ')}`);
      assert.equal(bad.errJson.error.code, 'BAD_ARGS');
    }
    const traceBad = runCrctl(['writeback-apply', cr, '--stage', 'traceability', '--milestone-file', 'milestone.yml', '--milestone-name', 'ignored', '--spec-id', 'test-spec', '--target-version', '0.2', '--workspace', kb], { cwd: kb });
    assert.notEqual(traceBad.status, 0);
    assert.equal(traceBad.errJson.error.code, 'BAD_ARGS');
    const args = ['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.2', '--workspace', kb];
    const first = runCrctl(args, { cwd: kb });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.json.status, 'writing-back');
    assert.match(first.json.commit, /^[0-9a-f]{40}$/);
    const bare = path.join(base, 'origin-kb.git');
    assert.match(git(bare, ['show', `${first.json.commit}:change-requests/${cr}/cr.md`]), /^status: writing-back$/m);
    const count = originMasterCount(base, 'kb');
    const second = runCrctl(args, { cwd: kb });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.changed, false);
    assert.equal(second.json.commit, first.json.commit);
    assert.equal(originMasterCount(base, 'kb'), count);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-04：writeback-after-commit fault 经同一业务命令续跑不重复 commit', () => {
  const { base, kb, cr } = makeMergedFixture();
  try {
    const args = ['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.2', '--workspace', kb];
    const first = runCrctl(args, { cwd: kb, env: { CRCTL_FAULT_POINT: 'writeback-after-commit' } });
    assert.notEqual(first.status, 0);
    assert.equal(first.errJson.error.code, 'FAULT_INJECTED');
    const second = runCrctl(args, { cwd: kb });
    assert.equal(second.status, 0, second.stderr);
    const log = git(path.join(base, 'origin-kb.git'), ['log', '--format=%s']);
    assert.equal((log.match(/^writeback baseline/g) || []).length, 1);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('review repair：commit 后 origin 前进先清除未发布事务，再以同一业务命令重建', () => {
  const { base, kb, cr } = makeMergedFixture();
  try {
    const args = ['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.2', '--workspace', kb];
    const faulted = runCrctl(args, { cwd: kb, env: { CRCTL_FAULT_POINT: 'writeback-after-commit' } });
    assert.equal(faulted.errJson.error.code, 'FAULT_INJECTED');
    git(kb, ['fetch', 'origin']);
    git(kb, ['reset', '--hard', 'origin/master']);
    fs.writeFileSync(path.join(kb, 'concurrent.txt'), 'concurrent\n');
    git(kb, ['add', 'concurrent.txt']);
    git(kb, ['commit', '-q', '-m', 'concurrent trunk']);
    git(kb, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
    const stale = runCrctl(args, { cwd: kb });
    assert.notEqual(stale.status, 0);
    assert.equal(stale.errJson.error.code, 'WRITEBACK_REMOTE_STALE');
    const recovered = runCrctl(args, { cwd: kb });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.ok(git(path.join(base, 'origin-kb.git'), ['show', `${recovered.json.commit}:concurrent.txt`]).includes('concurrent'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('review repair：commit 后 graphDigest 漂移硬阻断旧事务', async () => {
  const { base, kb, cr, txws } = makeMergedFixture();
  try {
    const observed = { status: [], audit: [] };
    const input = { cr, stage: 'baseline', specId: 'test-spec', targetVersion: '0.2', workspace: kb, ...atomicCallbacks(txws, cr, observed) };
    process.env.CRCTL_FAULT_POINT = 'writeback-after-commit';
    await assert.rejects(() => applyWriteback(resolveRepositories(kb), input), (e) => e.code === 'FAULT_INJECTED');
    delete process.env.CRCTL_FAULT_POINT;
    const graphPath = path.join(kb, 'dir-graph.yaml');
    fs.writeFileSync(graphPath, fs.readFileSync(graphPath, 'utf8').replace('    trunk: master', '    trunk: main'));
    await assert.rejects(() => applyWriteback(resolveRepositories(kb), input), (e) => e.code === 'GRAPH_CHANGED_DURING_TRANSACTION');
  } finally {
    delete process.env.CRCTL_FAULT_POINT;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('TASK-04：traceability 公共业务参数全链路', () => {
  const { base, kb, cr, txws } = makeMergedFixture();
  try {
    const baseline = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.2', '--workspace', kb], { cwd: kb });
    assert.equal(baseline.status, 0, baseline.stderr);
    const milestone = path.join(txws, 'milestone.yml');
    fs.writeFileSync(milestone, `cr: ${cr}\nmilestone: M1\ntarget-version: "0.2"\nstatus: writing-back\nfr-chain:\n  - fr: FR-1\n    title: 原子回写\n    tasks: [${cr}-TASK-01]\n`);
    const trace = runCrctl(['writeback-apply', cr, '--stage', 'traceability', '--spec-id', 'test-spec', '--target-version', '0.2', '--milestone-file', 'milestone.yml', '--workspace', kb], { cwd: kb });
    assert.equal(trace.status, 0, trace.stderr);
    const head = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
    assert.ok(git(path.join(base, 'origin-kb.git'), ['show', `${head}:specs/test-spec/traceability.yml`]).includes(`- cr: ${cr}`));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

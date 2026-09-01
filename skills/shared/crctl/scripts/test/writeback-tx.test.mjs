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

/** CR-2026-041：补齐 traceability generator 需要的 7 份证据（makeCodeApprovedFixture 仅含 dev-plan/code + development-start/code）。 */
function addEvidenceFiles(txws, cr) {
  const crDir = path.join(txws, 'change-requests', cr);
  fs.mkdirSync(path.join(crDir, 'review-annotations'), { recursive: true });
  fs.writeFileSync(path.join(crDir, 'review-annotations', 'requirement.yml'), `cr-id: ${cr}\nreview-type: requirement\nverdict: pass\n`);
  fs.writeFileSync(path.join(crDir, 'review-annotations', 'sdd.yml'), `cr-id: ${cr}\nreview-type: tech-design\nverdict: pass\n`);
  fs.writeFileSync(path.join(crDir, 'approval.yml'), `requirement:\n  via: crctl-approve\ntech-design:\n  via: crctl-approve\n` + fs.readFileSync(path.join(crDir, 'approval.yml'), 'utf8'));
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
    // CR-2026-057 FR-14：新版本守卫先行命中（cr.md=0.2 与输入 0.3 不一致），不再到达既有 journal 的 TX_INPUT_CONFLICT
    await assert.rejects(() => applyWriteback(ctx, { ...input, targetVersion: '0.3' }), (e) => e.code === 'WRITEBACK_VERSION_MISMATCH');
    const txDir = path.join(kb, '.crctl', 'transactions', 'writeback', `${cr}-baseline`);
    const txId = fs.readdirSync(txDir)[0];
    const before = JSON.parse(fs.readFileSync(path.join(txDir, txId, 'journal.json'), 'utf8'));
    const result = await applyWriteback(ctx, input);
    const crMd = git(path.join(base, 'origin-kb.git'), ['show', `${result.commit}:change-requests/${cr}/cr.md`]);
    assert.ok(crMd.includes(`updated: "${before.createdAt}"`)); // CR-2026-039 TASK-03：时间字段收敛为单一 updated
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
    addEvidenceFiles(txws, cr);
    const milestone = path.join(txws, 'milestone.yml');
    fs.writeFileSync(milestone, `cr: ${cr}\nmilestone: M1\ntarget-version: "0.2"\nfr-chain:\n  - fr: FR-1\n    title: 原子回写\n    tasks: [${cr}-TASK-01]\n`);
    const trace = runCrctl(['writeback-apply', cr, '--stage', 'traceability', '--spec-id', 'test-spec', '--target-version', '0.2', '--milestone-file', 'milestone.yml', '--workspace', kb], { cwd: kb });
    assert.equal(trace.status, 0, trace.stderr);
    const head = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
    assert.ok(git(path.join(base, 'origin-kb.git'), ['show', `${head}:specs/test-spec/traceability.yml`]).includes(`- cr: ${cr}`));
    assert.ok(git(path.join(base, 'origin-kb.git'), ['show', `${head}:specs/test-spec/traceability.yml`]).includes('evidence:'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

/* ────────────────────────── CR-2026-057 FR-14：writeback-apply 版本守卫 ────────────────────────── */

/** 失败观察点快照：specs 哈希 / candidate 目录 / writeback journal / 锁 / cr.md / origin commit 数。 */
function snapshotSixPoints(base, kb, cr, txws) {
  const specFiles = ['specs/_index.yml', 'specs/test-spec/PRD.md', 'specs/test-spec/SDD.md'];
  const specs = specFiles.map((p) => {
    const f = path.join(txws, ...p.split('/'));
    return fs.existsSync(f) ? sha256(fs.readFileSync(f, 'utf8')) : null;
  });
  const candidates = path.join(txws, '.crctl', 'candidates');
  const journals = path.join(kb, '.crctl', 'transactions', 'writeback');
  const locks = path.join(kb, '.crctl', 'locks');
  const list = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).sort() : []);
  return {
    specs,
    candidateDirs: list(candidates),
    journalEntries: list(journals),
    locks: list(locks),
    crMdSha: sha256(fs.readFileSync(path.join(txws, 'change-requests', cr, 'cr.md'), 'utf8')),
    originCount: originMasterCount(base, 'kb'),
  };
}

test('CR-2026-057 FR-14/AC-14：三 stage × 三错误码零观察点 + 同参重试同码无增量', () => {
  const vectors = [
    { args: ['--target-version', '0.9'], code: 'WRITEBACK_VERSION_MISMATCH' },
    { args: ['--target-version', 'unassigned'], code: 'WRITEBACK_VERSION_UNASSIGNED' },
    { args: ['--target-version', 'n/a'], code: 'WRITEBACK_VERSION_INVALID' },
  ];
  for (const stage of ['baseline', 'tasks', 'traceability']) {
    for (const v of vectors) {
      const { base, kb, cr, txws } = makeMergedFixture();
      try {
        const stageArgs = stage === 'traceability' ? ['--milestone-file', 'milestone.yml'] : [];
        const args = ['writeback-apply', cr, '--stage', stage, '--spec-id', 'test-spec', ...v.args, ...stageArgs, '--workspace', kb];
        const before = snapshotSixPoints(base, kb, cr, txws);
        const r = runCrctl(args, { cwd: kb });
        assert.notEqual(r.status, 0, `${stage} ${v.code} 必须非零退出`);
        assert.equal(r.errJson.error.code, v.code, `${stage} ${v.code}: ${r.stderr}`);
        assert.deepEqual(snapshotSixPoints(base, kb, cr, txws), before, `${stage} ${v.code} 失败后六项禁止观察点必须字节级不变`);
        // 同参重试：同码且无增量痕迹
        const r2 = runCrctl(args, { cwd: kb });
        assert.notEqual(r2.status, 0);
        assert.equal(r2.errJson.error.code, v.code);
        assert.deepEqual(snapshotSixPoints(base, kb, cr, txws), before, `${stage} ${v.code} 同参重试必须无增量痕迹`);
      } finally { fs.rmSync(base, { recursive: true, force: true }); }
    }
  }
});

test('CR-2026-057 FR-14/AC-14.6：版本错误优先于 WRITEBACK_STATE_MISMATCH（status=code-approved 未 merge 夹具）', () => {
  const { base, kb, cr } = makeCodeApprovedFixture();
  try {
    // 未 merge：authority 为 cr-worktree（守卫若缺失会得 WRITEBACK_STATE_MISMATCH）；
    // 版本不一致必须先命中 WRITEBACK_VERSION_MISMATCH
    const mismatch = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.9', '--workspace', kb], { cwd: kb });
    assert.notEqual(mismatch.status, 0);
    assert.equal(mismatch.errJson.error.code, 'WRITEBACK_VERSION_MISMATCH');
    const invalid = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', 'n/a', '--workspace', kb], { cwd: kb });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.errJson.error.code, 'WRITEBACK_VERSION_INVALID');
    // 版本一致且真实 → 守卫放行，随后才得既有 WRITEBACK_STATE_MISMATCH（authority 非 Transaction Workspace）
    const stateMismatch = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.2', '--workspace', kb], { cwd: kb });
    assert.notEqual(stateMismatch.status, 0);
    assert.equal(stateMismatch.errJson.error.code, 'WRITEBACK_STATE_MISMATCH');
    assert.equal(originMasterCount(base, 'kb'), 2, '全部失败路径不得产生新 commit');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-057 FR-14/B-SDD-003：缺 flag → BAD_ARGS；显式空串 → WRITEBACK_VERSION_INVALID', () => {
  const { base, kb, cr } = makeCodeApprovedFixture();
  try {
    const missing = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.notEqual(missing.status, 0);
    assert.equal(missing.errJson.error.code, 'BAD_ARGS');
    const empty = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '', '--workspace', kb], { cwd: kb });
    assert.notEqual(empty.status, 0);
    assert.equal(empty.errJson.error.code, 'WRITEBACK_VERSION_INVALID', '显式空串必须进守卫（与缺 flag 不同码）');
    assert.equal(originMasterCount(base, 'kb'), 2, '失败路径不得产生新 commit');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-057 FR-14/B-SDD-002：v0.2 输入回灌规范化值——journal businessInputDigest/manifest targetVersion 为 0.2', async () => {
  const { base, kb, cr, txws } = makeMergedFixture();
  try {
    const observed = { status: [], audit: [] };
    const result = await applyWriteback(resolveRepositories(kb), {
      cr, stage: 'baseline', specId: 'test-spec', targetVersion: 'v0.2', workspace: kb,
      ...atomicCallbacks(txws, cr, observed),
    });
    assert.equal(result.phase, 'complete');
    const journalDir = path.join(kb, '.crctl', 'transactions', 'writeback', `${cr}-baseline`);
    const txId = fs.readdirSync(journalDir)[0];
    const journal = JSON.parse(fs.readFileSync(path.join(journalDir, txId, 'journal.json'), 'utf8'));
    const canonical = canonicalWritebackBusinessInput({ cr, stage: 'baseline', specId: 'test-spec', targetVersion: '0.2', milestoneFile: null });
    assert.equal(journal.writeback.targetVersion, '0.2', 'payload.targetVersion 必须是回灌后的规范化值');
    assert.equal(journal.writeback.businessInputDigest, canonical.digest, 'businessInputDigest 必须基于规范化值');
    const manifest = JSON.parse(fs.readFileSync(path.join(txws, '.crctl', 'candidates', cr, 'baseline', 'manifest.json'), 'utf8'));
    assert.equal(manifest.targetVersion, '0.2', 'generator 消费的 --version 必须是规范化串 0.2');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

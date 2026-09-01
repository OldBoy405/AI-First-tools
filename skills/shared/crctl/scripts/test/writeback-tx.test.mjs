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

function makeMergedFixture({ targetVersion = '0.2' } = {}) {
  const f = makeCodeApprovedFixture({ targetVersion });
  const { base, kb, cr, kbWt } = f;
  const r = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.phase, 'complete', JSON.stringify(r.json || r.errJson));
  return { base, kb, cr, kbWt, txws: r.json.operationalWorkspace };
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

/** 失败观察点快照：specs 哈希 / candidate 目录 / writeback journal / 锁 / cr.md / _backlog.yml / origin commit 数。 */
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
    backlogSha: sha256(fs.readFileSync(path.join(txws, 'change-requests', '_backlog.yml'), 'utf8')),
    originCount: originMasterCount(base, 'kb'),
  };
}

test('CR-2026-057 FR-14/AC-14：三 stage × 两错误码零观察点 + 同参重试同码无增量（unassigned 向量并入 AC-1.2/AC-1.3 冻结负向向量，CR-2026-058 B-DP-03）', () => {
  const vectors = [
    { args: ['--target-version', '0.9'], code: 'WRITEBACK_VERSION_MISMATCH' },
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

/* ────────────────────────── CR-2026-058：回灌语义（FR-1/FR-2/FR-2.1/FR-2.2/FR-3/FR-6，AC-1～AC-6） ──────────────────────────
 * 冻结向量标识（B-DP-03 正反语义向量证明载体）：
 *   AC-1.1 = 放行向量（cr.md=unassigned + 输入真实版本 → 放行回灌，不得为 UNASSIGNED）；
 *   AC-1.2 = 输入侧 unassigned 负向（cr.md 真实 + 输入 unassigned → UNASSIGNED）；
 *   AC-1.3 = 两侧 unassigned 负向（→ UNASSIGNED）。
 * 本文件中 WRITEBACK_VERSION_UNASSIGNED 期望只允许出现在测试名含 AC-1.2/AC-1.3 的测试块内
 * （TASK-05 静态核对）；旧「cr.md=unassigned + 真实输入 → UNASSIGNED」正向拒绝断言与 AC-1.1 同
 * (fixture,输入) 组合、期望互斥，零残留可判定。 */

function readJournalPayload(kb, cr, stage) {
  const dir = path.join(kb, '.crctl', 'transactions', 'writeback', `${cr}-${stage}`);
  const txId = fs.readdirSync(dir)[0];
  return { txId, payload: JSON.parse(fs.readFileSync(path.join(dir, txId, 'journal.json'), 'utf8')).writeback };
}

/** 在 txws _backlog.yml 的 CR 条目块内改写 target-version 行（行级，条目外字节不动）。 */
function editTxwsBacklogVersion(txws, cr, newLine) {
  const p = path.join(txws, 'change-requests', '_backlog.yml');
  const text = fs.readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
  const lines = text.split('\n');
  const idRe = new RegExp('^[ \\t]*- id:\\s*["\']?' + cr + '["\']?\\s*$');
  const idx = lines.findIndex((l) => idRe.test(l));
  assert.ok(idx >= 0, `_backlog.yml 缺少 ${cr} 条目`);
  const tIdx = lines.findIndex((l, i) => i > idx && /^[ \t]*target-version:/.test(l));
  assert.ok(tIdx >= 0, `_backlog.yml ${cr} 条目缺 target-version 行`);
  const indent = (lines[tIdx].match(/^[ \t]*/) || [''])[0];
  lines[tIdx] = `${indent}target-version: ${newLine}`;
  fs.writeFileSync(p, lines.join('\n'));
}

/** 删除 _backlog.yml 中 CR 条目块的 target-version 行（缺失行 → WRITEBACK_VERSION_INVALID backlogReason=missing 向量，B-CODE-02）。 */
function removeTxwsBacklogVersionLine(txws, cr) {
  const p = path.join(txws, 'change-requests', '_backlog.yml');
  const text = fs.readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
  const lines = text.split('\n');
  const idRe = new RegExp('^[ \\t]*- id:\\s*["\']?' + cr + '["\']?\\s*$');
  const idx = lines.findIndex((l) => idRe.test(l));
  assert.ok(idx >= 0, `_backlog.yml 缺少 ${cr} 条目`);
  const tIdx = lines.findIndex((l, i) => i > idx && /^[ \t]*target-version:/.test(l));
  assert.ok(tIdx >= 0, `_backlog.yml ${cr} 条目缺 target-version 行`);
  lines.splice(tIdx, 1);
  fs.writeFileSync(p, lines.join('\n'));
}

/** 删除 _backlog.yml 中 CR 条目块（0 命中 → ENTRY_NOT_IN_BACKLOG 向量）。 */
function deleteBacklogEntry(txws, cr) {
  const p = path.join(txws, 'change-requests', '_backlog.yml');
  const text = fs.readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
  const lines = text.split('\n');
  const idRe = new RegExp('^[ \\t]*- id:\\s*["\']?' + cr + '["\']?\\s*$');
  const idx = lines.findIndex((l) => idRe.test(l));
  assert.ok(idx >= 0);
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^[ \t]*- id:/.test(lines[i])) { end = i; break; }
  }
  fs.writeFileSync(p, lines.slice(0, idx).concat(lines.slice(end)).join('\n').replace(/\n{3,}/g, '\n\n'));
}

/** 复制 _backlog.yml 中 CR 条目块（命中 >1 → WRITEBACK_BACKLOG_ENTRY_DUPLICATE 向量）。 */
function duplicateBacklogEntry(txws, cr) {
  const p = path.join(txws, 'change-requests', '_backlog.yml');
  const text = fs.readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
  const lines = text.split('\n');
  const idRe = new RegExp('^[ \\t]*- id:\\s*["\']?' + cr + '["\']?\\s*$');
  const idx = lines.findIndex((l) => idRe.test(l));
  assert.ok(idx >= 0);
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^[ \t]*- id:/.test(lines[i])) { end = i; break; }
  }
  lines.splice(end, 0, ...lines.slice(idx, end));
  fs.writeFileSync(p, lines.join('\n'));
}

/** 冻结产物哈希（NFR-6：回灌不得触碰 prd/sdd/plan/tasks）。 */
function frozenArtifactsHash(txws, cr) {
  const rels = ['prd.md', 'sdd.md', 'plan.md', 'tasks/TASK-01.md', 'tasks/_index.yml'];
  return rels.map((p) => sha256(fs.readFileSync(path.join(txws, 'change-requests', cr, ...p.split('/')), 'utf8')));
}

const ledgersOf = (bare, commit, cr) => ({
  crMd: git(bare, ['show', `${commit}:change-requests/${cr}/cr.md`]),
  backlog: git(bare, ['show', `${commit}:change-requests/_backlog.yml`]),
});

/** B-CODE-03：writeback commit 的变更集（diff-tree vs 父提交）——证明业务文件在本 commit 被实际修改，
 * 而非 ls-tree 存在性断言（fixture 初始 trunk 已创建 specs 路径，存在性无法证明本 commit 修改了业务文件）。 */
const changedPathsOf = (bare, commit) => git(bare, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).split('\n').filter(Boolean);

// AC-1.1（冻结名，放行向量）：cr.md=unassigned + 输入真实版本 → 放行并回灌，不得为 WRITEBACK_VERSION_UNASSIGNED
test('CR-2026-058 AC-1.1：merged 夹具 cr.md=unassigned + 0.30 → 放行回灌两账本（含 v0.30 规范化等价）', () => {
  for (const input of ['0.30', 'v0.30']) {
    const { base, kb, cr } = makeMergedFixture({ targetVersion: 'unassigned' });
    try {
      const args = ['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', input, '--workspace', kb];
      const r = runCrctl(args, { cwd: kb });
      assert.equal(r.status, 0, `${input}: ${r.stderr}`);
      assert.equal(r.json.phase, 'complete', `${input}: 放行并回灌成功（不得为版本错误）`);
      const head = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
      const { crMd, backlog } = ledgersOf(path.join(base, 'origin-kb.git'), head, cr);
      assert.match(crMd, /^target-version: 0\.30$/m, `${input}: cr.md 版本行已回灌`);
      assert.match(crMd, /^status: writing-back$/m, `${input}: baseline status 变迁同 commit`);
      assert.match(backlog, /^\s*target-version: 0\.30$/m, `${input}: _backlog.yml 条目版本行已回灌`);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

// AC-1.2（冻结名，输入侧 unassigned 负向）：cr.md 真实 + 输入 unassigned → UNASSIGNED + 零观察点 + 同参重试同码
test('CR-2026-058 AC-1.2：cr.md 真实 + 输入 unassigned → WRITEBACK_VERSION_UNASSIGNED 零观察点（三 stage）', () => {
  for (const stage of ['baseline', 'tasks', 'traceability']) {
    const { base, kb, cr, txws } = makeMergedFixture();
    try {
      const stageArgs = stage === 'traceability' ? ['--milestone-file', 'milestone.yml'] : [];
      const args = ['writeback-apply', cr, '--stage', stage, '--spec-id', 'test-spec', '--target-version', 'unassigned', ...stageArgs, '--workspace', kb];
      const before = snapshotSixPoints(base, kb, cr, txws);
      const r = runCrctl(args, { cwd: kb });
      assert.notEqual(r.status, 0);
      assert.equal(r.errJson.error.code, 'WRITEBACK_VERSION_UNASSIGNED', r.stderr);
      assert.deepEqual(snapshotSixPoints(base, kb, cr, txws), before, `${stage} 输入侧 unassigned 失败后六项禁止观察点字节级不变`);
      const r2 = runCrctl(args, { cwd: kb });
      assert.notEqual(r2.status, 0);
      assert.equal(r2.errJson.error.code, 'WRITEBACK_VERSION_UNASSIGNED');
      assert.deepEqual(snapshotSixPoints(base, kb, cr, txws), before, `${stage} 同参重试无增量痕迹`);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

// AC-1.3（冻结名，两侧 unassigned 负向）：→ UNASSIGNED + 零观察点
test('CR-2026-058 AC-1.3：两侧 unassigned → WRITEBACK_VERSION_UNASSIGNED 零观察点', () => {
  const { base, kb, cr, txws } = makeMergedFixture({ targetVersion: 'unassigned' });
  try {
    const args = ['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', 'unassigned', '--workspace', kb];
    const before = snapshotSixPoints(base, kb, cr, txws);
    const r = runCrctl(args, { cwd: kb });
    assert.notEqual(r.status, 0);
    assert.equal(r.errJson.error.code, 'WRITEBACK_VERSION_UNASSIGNED', r.stderr);
    assert.deepEqual(snapshotSixPoints(base, kb, cr, txws), before, '两侧 unassigned 失败后六项禁止观察点字节级不变');
    const r2 = runCrctl(args, { cwd: kb });
    assert.notEqual(r2.status, 0);
    assert.equal(r2.errJson.error.code, 'WRITEBACK_VERSION_UNASSIGNED');
    assert.deepEqual(snapshotSixPoints(base, kb, cr, txws), before, '同参重试无增量痕迹');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// AC-2.1：成功回灌原子性（baseline 必须走 2.1）——两账本同 commit + 冻结产物不动 + tasks/traceability 版本行无新 diff
test('CR-2026-058 AC-2.1：成功回灌原子性——两账本同 commit、冻结产物哈希全等、后续 stage 版本行无新 diff', () => {
  const { base, kb, cr, txws } = makeMergedFixture({ targetVersion: 'unassigned' });
  try {
    const before = snapshotSixPoints(base, kb, cr, txws);
    const frozenBefore = frozenArtifactsHash(txws, cr);
    const args = ['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb];
    const first = runCrctl(args, { cwd: kb });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.json.changed, true);
    const bare = path.join(base, 'origin-kb.git');
    const baselineCommit = first.json.commit;
    const { crMd, backlog } = ledgersOf(bare, baselineCommit, cr);
    assert.match(crMd, /^target-version: 0\.30$/m);
    assert.match(crMd, /^status: writing-back$/m);
    assert.match(backlog, /^\s*target-version: 0\.30$/m);
    // baseline status 变迁与版本回灌同一次 commit（B-CODE-03：diff-tree 变更集断言——
    // 两账本 + 三项 baseline 业务文件必须在本 commit 被实际修改，ls-tree 存在性不足证）
    const changed = changedPathsOf(bare, baselineCommit);
    for (const p of [`change-requests/${cr}/cr.md`, 'change-requests/_backlog.yml', 'specs/_index.yml', 'specs/test-spec/PRD.md', 'specs/test-spec/SDD.md']) {
      assert.ok(changed.includes(p), `${p} 在 baseline writeback commit 变更集内（diff-tree）`);
    }
    assert.deepEqual(frozenArtifactsHash(txws, cr), frozenBefore, 'prd/sdd/plan/tasks 字节级不变（NFR-6）');
    // tasks/traceability 各跑一次：版本行无新 diff（git log --follow 两账本路径仅首 commit 含版本行变更）
    const tasksRun = runCrctl(['writeback-apply', cr, '--stage', 'tasks', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb], { cwd: kb });
    assert.equal(tasksRun.status, 0, tasksRun.stderr);
    addEvidenceFiles(txws, cr);
    const milestone = path.join(txws, 'milestone.yml');
    fs.writeFileSync(milestone, `cr: ${cr}\nmilestone: M1\ntarget-version: "0.30"\nfr-chain:\n  - fr: FR-1\n    title: 原子回写\n    tasks: [${cr}-TASK-01]\n`);
    const traceRun = runCrctl(['writeback-apply', cr, '--stage', 'traceability', '--spec-id', 'test-spec', '--target-version', '0.30', '--milestone-file', 'milestone.yml', '--workspace', kb], { cwd: kb });
    assert.equal(traceRun.status, 0, traceRun.stderr);
    const head = git(bare, ['rev-parse', 'master']);
    const final = ledgersOf(bare, head, cr);
    assert.match(final.crMd, /^target-version: 0\.30$/m, 'tasks/traceability 后 cr.md 版本行不变');
    assert.match(final.backlog, /^\s*target-version: 0\.30$/m, 'tasks/traceability 后 _backlog.yml 版本行不变');
    assert.equal(git(bare, ['show', `${head}:change-requests/${cr}/cr.md`]), crMd, 'cr.md 无新 diff（与 baseline commit 全等）');
    assert.equal(git(bare, ['show', `${head}:change-requests/_backlog.yml`]), backlog, '_backlog.yml 无新 diff（与 baseline commit 全等）');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// AC-2.2：backlog 冲突五向量（txws authority 上直接构造；全部拒绝路径六项零观察点 + 零 commit）
test('CR-2026-058 AC-2.2：backlog 预检五向量——冲突/缺失/重复/非法/幂等', () => {
  // 1) 条目已是另一真实版本 0.29
  {
    const { base, kb, cr, txws } = makeMergedFixture({ targetVersion: 'unassigned' });
    try {
      editTxwsBacklogVersion(txws, cr, '0.29');
      const before = snapshotSixPoints(base, kb, cr, txws);
      const r = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb], { cwd: kb });
      assert.equal(r.status, 1);
      assert.equal(r.errJson.error.code, 'WRITEBACK_BACKLOG_VERSION_MISMATCH', r.stderr);
      assert.equal(r.errJson.error.backlog, '0.29');
      assert.equal(r.errJson.error.input, '0.30');
      assert.deepEqual(snapshotSixPoints(base, kb, cr, txws), before, '冲突拒绝：六项零观察点');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
  // 2) 删除条目 → ENTRY_NOT_IN_BACKLOG
  {
    const { base, kb, cr, txws } = makeMergedFixture({ targetVersion: 'unassigned' });
    try {
      deleteBacklogEntry(txws, cr);
      const before = snapshotSixPoints(base, kb, cr, txws);
      const r = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb], { cwd: kb });
      assert.equal(r.status, 1);
      assert.equal(r.errJson.error.code, 'ENTRY_NOT_IN_BACKLOG', r.stderr);
      assert.equal(r.errJson.error.cr, cr);
      assert.deepEqual(snapshotSixPoints(base, kb, cr, txws), before, '缺失拒绝：六项零观察点');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
  // 3) 复制条目命中 >1 → WRITEBACK_BACKLOG_ENTRY_DUPLICATE 且 count>=2
  {
    const { base, kb, cr, txws } = makeMergedFixture({ targetVersion: 'unassigned' });
    try {
      duplicateBacklogEntry(txws, cr);
      const before = snapshotSixPoints(base, kb, cr, txws);
      const r = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb], { cwd: kb });
      assert.equal(r.status, 1);
      assert.equal(r.errJson.error.code, 'WRITEBACK_BACKLOG_ENTRY_DUPLICATE', r.stderr);
      assert.ok(r.errJson.error.count >= 2, `count=${r.errJson.error.count}`);
      assert.deepEqual(snapshotSixPoints(base, kb, cr, txws), before, '重复拒绝：六项零观察点');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
  // 4) 条目 target-version 非法（n/a）→ WRITEBACK_VERSION_INVALID：扁平信封保留 cr/input/inputReason/crMdReason 并列 backlogReason（B-CODE-02）
  {
    const { base, kb, cr, txws } = makeMergedFixture({ targetVersion: 'unassigned' });
    try {
      editTxwsBacklogVersion(txws, cr, 'n/a');
      const before = snapshotSixPoints(base, kb, cr, txws);
      const r = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb], { cwd: kb });
      assert.equal(r.status, 1);
      assert.equal(r.errJson.error.code, 'WRITEBACK_VERSION_INVALID', r.stderr);
      assert.equal(r.errJson.error.cr, cr, '扁平信封含 cr');
      assert.equal(r.errJson.error.input, '0.30', '扁平信封含原始 input');
      assert.equal(r.errJson.error.inputReason, null, 'input 已过 guard，inputReason=null');
      assert.equal(r.errJson.error.crMdReason, null, 'cr.md 已过 guard，crMdReason=null');
      assert.equal(r.errJson.error.backlogReason, 'forbidden', `backlogReason=${r.errJson.error.backlogReason}`);
      assert.equal(r.errJson.error.details, undefined, '失败信封扁平，无 error.details');
      assert.deepEqual(snapshotSixPoints(base, kb, cr, txws), before, '非法拒绝：六项零观察点');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
  // 4b) 条目缺少 target-version 行 → WRITEBACK_VERSION_INVALID：同样扁平信封（backlogReason=missing，B-CODE-02）
  {
    const { base, kb, cr, txws } = makeMergedFixture({ targetVersion: 'unassigned' });
    try {
      removeTxwsBacklogVersionLine(txws, cr);
      const before = snapshotSixPoints(base, kb, cr, txws);
      const r = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb], { cwd: kb });
      assert.equal(r.status, 1);
      assert.equal(r.errJson.error.code, 'WRITEBACK_VERSION_INVALID', r.stderr);
      assert.equal(r.errJson.error.cr, cr, '扁平信封含 cr');
      assert.equal(r.errJson.error.input, '0.30', '扁平信封含原始 input');
      assert.equal(r.errJson.error.inputReason, null);
      assert.equal(r.errJson.error.crMdReason, null);
      assert.equal(r.errJson.error.backlogReason, 'missing', `backlogReason=${r.errJson.error.backlogReason}`);
      assert.equal(r.errJson.error.details, undefined, '失败信封扁平，无 error.details');
      assert.deepEqual(snapshotSixPoints(base, kb, cr, txws), before, '缺失拒绝：六项零观察点');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
  // 5) 条目已=输入 0.30、cr.md 仍 unassigned → 放行只回灌 cr.md，backlog 版本行无 diff
  {
    const { base, kb, cr, txws } = makeMergedFixture({ targetVersion: 'unassigned' });
    try {
      editTxwsBacklogVersion(txws, cr, '0.30');
      const backlogPath = path.join(txws, 'change-requests', '_backlog.yml');
      const backlogBefore = sha256(fs.readFileSync(backlogPath, 'utf8'));
      const r = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb], { cwd: kb });
      assert.equal(r.status, 0, r.stderr);
      const head = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
      const { crMd } = ledgersOf(path.join(base, 'origin-kb.git'), head, cr);
      assert.match(crMd, /^target-version: 0\.30$/m, 'cr.md 已回灌');
      assert.equal(sha256(fs.readFileSync(backlogPath, 'utf8')), backlogBefore, 'backlog 幂等：条目已=输入，版本行无 diff');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

/** 直接 tasks/traceability 回灌夹具（SDD §6.2 AC-2.3 可达性）：txws 直接构造 status=writing-back + 两账本
 * target-version=unassigned（工作树修改，不提交；generator 前置只校验 cr.md status）。 */
function makeDirectWritingBackFixture() {
  const f = makeMergedFixture();
  const { txws, cr } = f;
  const crMdPath = path.join(txws, 'change-requests', cr, 'cr.md');
  const crMd = fs.readFileSync(crMdPath, 'utf8').replaceAll('\r\n', '\n');
  fs.writeFileSync(crMdPath, crMd.replace(/^status: .*$/m, 'status: writing-back').replace(/^target-version: .*$/m, 'target-version: unassigned'));
  editTxwsBacklogVersion(txws, cr, 'unassigned');
  return f;
}

// AC-2.3：三故障点 + 1b 部分 apply 冻结回归（CRCTL_FAULT_POINT 既有注入点，零新增）
test('CR-2026-058 AC-2.3.1：writeback-after-apply 中断重试——direct tasks 回灌由 payload 重建（B-SDD-01）', () => {
  const { base, kb, cr } = makeDirectWritingBackFixture();
  try {
    const args = ['writeback-apply', cr, '--stage', 'tasks', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb];
    const countBefore = originMasterCount(base, 'kb');
    const first = runCrctl(args, { cwd: kb, env: { CRCTL_FAULT_POINT: 'writeback-after-apply' } });
    assert.equal(first.status, 1);
    assert.equal(first.errJson.error.code, 'FAULT_INJECTED');
    assert.equal(originMasterCount(base, 'kb'), countBefore, '中断后 origin 无 writeback commit');
    // 同参重试（不设 env）：guard 读 cr.md 已真实版本（refill=false），cr.md 条目仅由 payload.versionRefill.crMd 重建
    const second = runCrctl(args, { cwd: kb });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.phase, 'complete');
    const bare = path.join(base, 'origin-kb.git');
    const log = git(bare, ['log', '--format=%s']);
    assert.equal((log.match(/^writeback tasks/g) || []).length, 1, 'origin 恰好一个 writeback tasks commit');
    const head = git(bare, ['rev-parse', 'master']);
    const { crMd, backlog } = ledgersOf(bare, head, cr);
    assert.match(crMd, /^target-version: 0\.30$/m, '重试 commit 含 cr.md 版本行');
    assert.match(backlog, /^\s*target-version: 0\.30$/m, '重试 commit 含 _backlog.yml 版本行');
    assert.ok(git(bare, ['ls-tree', '-r', '--name-only', head]).split('\n').some((p) => p.startsWith('delivery/task/')), '重试 commit 含本 stage 业务文件');
    assert.ok(second.json.files.includes(`change-requests/${cr}/cr.md`), 'stdout files 含 cr.md');
    assert.ok(second.json.files.includes('change-requests/_backlog.yml'), 'stdout files 含 _backlog.yml');
    // B-CODE-03：故障恢复断言同步采用 diff-tree 变更集口径——两账本 + 本 stage 业务文件在本 commit 被实际修改
    const changed = changedPathsOf(bare, head);
    assert.ok(changed.includes(`change-requests/${cr}/cr.md`), '重试 commit 变更集含 cr.md（diff-tree）');
    assert.ok(changed.includes('change-requests/_backlog.yml'), '重试 commit 变更集含 _backlog.yml（diff-tree）');
    assert.ok(changed.some((p) => p.startsWith('delivery/task/')), '重试 commit 变更集含本 stage 业务文件（diff-tree）');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-058 AC-2.3.1b：tx-apply-between-rename 部分 apply 冻结回归（B-SDD-01）', () => {
  const { base, kb, cr, txws } = makeDirectWritingBackFixture();
  try {
    const args = ['writeback-apply', cr, '--stage', 'tasks', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb];
    const first = runCrctl(args, { cwd: kb, env: { CRCTL_FAULT_POINT: 'tx-apply-between-rename' } });
    assert.equal(first.status, 1);
    assert.equal(first.errJson.error.code, 'FAULT_INJECTED');
    // manifest state=prepared（rename 间中断）
    const { txId, payload: frozen } = readJournalPayload(kb, cr, 'tasks');
    assert.ok(frozen.versionRefill, 'payload.versionRefill 已随 save(start) 落盘');
    const manifestPath = path.join(kb, '.crctl', 'transactions', 'writeback', `${cr}-tasks`, txId, 'write-set.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.state, 'prepared');
    // 夹具把 txws _backlog.yml 置为 payload.versionRefill.backlog.afterText（构造「backlog 已 after、cr.md 仍 unassigned」现场）
    fs.writeFileSync(path.join(txws, 'change-requests', '_backlog.yml'), frozen.versionRefill.backlog.afterText);
    const second = runCrctl(args, { cwd: kb });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.phase, 'complete');
    // payload 保持首次落盘值（不重算、backlog 条目不降为 null）
    const after = readJournalPayload(kb, cr, 'tasks');
    assert.equal(after.txId, txId, '同一事务');
    assert.ok(after.payload.versionRefill.backlog, 'payload.versionRefill.backlog 保持首次落盘值（冻结）');
    assert.equal(after.payload.versionRefill.backlog.afterText, frozen.versionRefill.backlog.afterText);
    const bare = path.join(base, 'origin-kb.git');
    const head = git(bare, ['rev-parse', 'master']);
    const { crMd, backlog } = ledgersOf(bare, head, cr);
    assert.match(crMd, /^target-version: 0\.30$/m);
    assert.match(backlog, /^\s*target-version: 0\.30$/m);
    assert.ok(git(bare, ['ls-tree', '-r', '--name-only', head]).split('\n').some((p) => p.startsWith('delivery/task/')), 'commit 含业务文件');
    assert.ok(second.json.files.includes(`change-requests/${cr}/cr.md`), 'stdout files 含 cr.md');
    assert.ok(second.json.files.includes('change-requests/_backlog.yml'), 'stdout files 含 _backlog.yml');
    // B-CODE-03：diff-tree 变更集口径同步（两账本 + 本 stage 业务文件）
    const changed = changedPathsOf(bare, head);
    assert.ok(changed.includes(`change-requests/${cr}/cr.md`), '重试 commit 变更集含 cr.md（diff-tree）');
    assert.ok(changed.includes('change-requests/_backlog.yml'), '重试 commit 变更集含 _backlog.yml（diff-tree）');
    assert.ok(changed.some((p) => p.startsWith('delivery/task/')), '重试 commit 变更集含本 stage 业务文件（diff-tree）');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-058 AC-2.3.2：writeback-after-commit 中断重试——不新增 commit、两账本版本行在唯一 commit 内', () => {
  const { base, kb, cr } = makeMergedFixture({ targetVersion: 'unassigned' });
  try {
    const args = ['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb];
    const first = runCrctl(args, { cwd: kb, env: { CRCTL_FAULT_POINT: 'writeback-after-commit' } });
    assert.equal(first.status, 1);
    assert.equal(first.errJson.error.code, 'FAULT_INJECTED');
    const second = runCrctl(args, { cwd: kb });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.phase, 'complete');
    const bare = path.join(base, 'origin-kb.git');
    const log = git(bare, ['log', '--format=%s']);
    assert.equal((log.match(/^writeback baseline/g) || []).length, 1, '重试不新增 commit');
    const { crMd, backlog } = ledgersOf(bare, second.json.commit, cr);
    assert.match(crMd, /^target-version: 0\.30$/m);
    assert.match(backlog, /^\s*target-version: 0\.30$/m);
    // B-CODE-03：唯一 commit 的变更集同时含两账本与三项 baseline 业务文件（diff-tree 口径）
    const changed = changedPathsOf(bare, second.json.commit);
    for (const p of [`change-requests/${cr}/cr.md`, 'change-requests/_backlog.yml', 'specs/_index.yml', 'specs/test-spec/PRD.md', 'specs/test-spec/SDD.md']) {
      assert.ok(changed.includes(p), `${p} 在 writeback baseline commit 变更集内（diff-tree）`);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-058 AC-2.3.3：writeback-after-push 中断重试——commit 不变、origin 不新增、两账本保持映像', () => {
  const { base, kb, cr } = makeMergedFixture({ targetVersion: 'unassigned' });
  try {
    const args = ['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb];
    const first = runCrctl(args, { cwd: kb, env: { CRCTL_FAULT_POINT: 'writeback-after-push' } });
    assert.equal(first.status, 1);
    assert.equal(first.errJson.error.code, 'FAULT_INJECTED');
    const countBefore = originMasterCount(base, 'kb');
    const { payload } = readJournalPayload(kb, cr, 'baseline');
    const interruptedSha = payload.commit;
    const second = runCrctl(args, { cwd: kb });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.phase, 'complete');
    assert.equal(second.json.commit, interruptedSha, 'commit 等于中断前 journal 已记录 sha');
    assert.equal(originMasterCount(base, 'kb'), countBefore, 'origin 不新增 commit');
    const { crMd, backlog } = ledgersOf(path.join(base, 'origin-kb.git'), second.json.commit, cr);
    assert.match(crMd, /^target-version: 0\.30$/m);
    assert.match(backlog, /^\s*target-version: 0\.30$/m);
    // B-CODE-03：diff-tree 变更集口径同步（两账本 + 三项 baseline 业务文件）
    const bare = path.join(base, 'origin-kb.git');
    const changed = changedPathsOf(bare, second.json.commit);
    for (const p of [`change-requests/${cr}/cr.md`, 'change-requests/_backlog.yml', 'specs/_index.yml', 'specs/test-spec/PRD.md', 'specs/test-spec/SDD.md']) {
      assert.ok(changed.includes(p), `${p} 在 writeback baseline commit 变更集内（diff-tree）`);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// AC-3（FR-3 分叉）：worktree 与 txws 版本分裂——守卫以 txws 为准、只回灌 txws；code-approved 上 MISMATCH 仍优先；回退 refill=false → STATE_MISMATCH 零写入
test('CR-2026-058 AC-3.1：worktree cr.md 版本漂移不影响守卫——以 txws 为准放行回灌、worktree 内容不变', () => {
  const { base, kb, cr, kbWt } = makeMergedFixture({ targetVersion: 'unassigned' });
  try {
    // merged 夹具 merge 后手改 requirement worktree 副本 cr.md 的 target-version（提交，cr.md 在 post-review 白名单内；不影响 txws）
    const wtCrMd = path.join(kbWt, 'change-requests', cr, 'cr.md');
    const wtText = fs.readFileSync(wtCrMd, 'utf8').replaceAll('\r\n', '\n').replace(/^target-version: .*$/m, 'target-version: 0.9');
    fs.writeFileSync(wtCrMd, wtText);
    git(kbWt, ['add', '-A']);
    git(kbWt, ['commit', '-q', '-m', 'drift worktree version']);
    const r = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    const bare = path.join(base, 'origin-kb.git');
    const { crMd, backlog } = ledgersOf(bare, r.json.commit, cr);
    assert.match(crMd, /^target-version: 0\.30$/m, 'txws cr.md 已回灌 0.30');
    assert.match(backlog, /^\s*target-version: 0\.30$/m, 'txws _backlog.yml 已回灌 0.30');
    assert.match(fs.readFileSync(wtCrMd, 'utf8'), /^target-version: 0\.9$/m, 'worktree 副本内容不变（只回灌 txws）');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-058 AC-3.2：窄解析器回退（source=cr-worktree）refill=false → WRITEBACK_STATE_MISMATCH 零写入', () => {
  const f = makeCodeApprovedFixture({ targetVersion: 'unassigned' });
  const { base, kb, cr, kbWt } = f;
  try {
    const list = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).sort() : []);
    const before = {
      crMdSha: sha256(fs.readFileSync(path.join(kbWt, 'change-requests', cr, 'cr.md'), 'utf8')),
      backlogSha: sha256(fs.readFileSync(path.join(kb, 'change-requests', '_backlog.yml'), 'utf8')),
      journals: list(path.join(kb, '.crctl', 'transactions', 'writeback')),
      locks: list(path.join(kb, '.crctl', 'locks')),
      originCount: originMasterCount(base, 'kb'),
    };
    const r = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 1);
    assert.equal(r.errJson.error.code, 'WRITEBACK_STATE_MISMATCH', r.stderr);
    const after = {
      crMdSha: sha256(fs.readFileSync(path.join(kbWt, 'change-requests', cr, 'cr.md'), 'utf8')),
      backlogSha: sha256(fs.readFileSync(path.join(kb, 'change-requests', '_backlog.yml'), 'utf8')),
      journals: list(path.join(kb, '.crctl', 'transactions', 'writeback')),
      locks: list(path.join(kb, '.crctl', 'locks')),
      originCount: originMasterCount(base, 'kb'),
    };
    assert.deepEqual(after, before, '回退场景回灌禁用：零观察点字节级不变');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// AC-6：CLI 信封（公共 CLI 断言，非库函数返回值）
test('CR-2026-058 AC-6.1：回灌首次成功信封——phase=complete、changed=true、files 含两账本、recoverCommand 规范化版本', () => {
  const { base, kb, cr } = makeMergedFixture({ targetVersion: 'unassigned' });
  try {
    const args = ['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', 'v0.30', '--workspace', kb];
    const r = runCrctl(args, { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.op, 'writeback-apply');
    assert.equal(r.json.phase, 'complete', 'phase 严格 complete');
    assert.equal(r.json.changed, true);
    assert.equal(r.json.status, 'writing-back');
    assert.match(r.json.commit, /^[0-9a-f]{40}$/);
    assert.ok(r.json.files.includes(`change-requests/${cr}/cr.md`), `files 含 cr.md: ${JSON.stringify(r.json.files)}`);
    assert.ok(r.json.files.includes('change-requests/_backlog.yml'), `files 含 _backlog.yml: ${JSON.stringify(r.json.files)}`);
    assert.ok(r.json.recoverCommand.includes('--target-version "0.30"'), `recoverCommand 含规范化 --target-version: ${r.json.recoverCommand}`);
    assert.equal(r.errJson, null, '成功路径 stderr 不可解析为 {error:{code}} 冲突信封');
    // 同参第二次：changed=false、commit/files 与首次相同（仍含两账本路径）
    const second = runCrctl(args, { cwd: kb });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.phase, 'complete');
    assert.equal(second.json.changed, false);
    assert.equal(second.json.commit, r.json.commit);
    assert.deepEqual(second.json.files, r.json.files);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-058 AC-6.2：回灌失败信封——exit 1、stdout 无成功对象、error.backlog/error.input 扁平并入', () => {
  const { base, kb, cr, txws } = makeMergedFixture({ targetVersion: 'unassigned' });
  try {
    editTxwsBacklogVersion(txws, cr, '0.29');
    const r = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.30', '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 1);
    assert.equal(r.json, null, 'stdout 无成功 JSON 对象（失败信封只在 stderr）');
    assert.equal(r.errJson.error.code, 'WRITEBACK_BACKLOG_VERSION_MISMATCH', r.stderr);
    assert.equal(r.errJson.error.backlog, '0.29');
    assert.equal(r.errJson.error.input, '0.30');
    assert.equal(r.errJson.error.details, undefined, '失败信封扁平，无 error.details');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

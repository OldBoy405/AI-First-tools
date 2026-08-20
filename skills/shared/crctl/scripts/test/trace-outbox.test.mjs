// CR-2026-049 TASK-02：writeback trace intent journal 与 complete replay 测试。
// AC-1 outbox 写失败 → writeback 完成 + warning + journal pending（完整 payload）；
// AC-2 恢复后重跑同一 writeback-apply → 补发成功、state=emitted、确定性文件名；
// AC-3 删除 txws/candidate 后重放仍成功（不触碰 operational workspace 解析）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { applyWriteback, resolveRepositories } from '../lib/workspace-transactions.mjs';
import { git, runCrctl, sha256 } from './merge-fixture.mjs';

import { makeCodeApprovedFixture, originMasterCount } from './merge-fixture.mjs';

function makeMergedFixture() {
  const fx = makeCodeApprovedFixture();
  const { base, kb, cr } = fx;
  const r = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.phase, 'complete', JSON.stringify(r.json || r.errJson));
  return { base, kb, cr, txws: r.json.operationalWorkspace };
}

function addEvidenceFiles(txws, cr) {
  const crDir = path.join(txws, 'change-requests', cr);
  fs.mkdirSync(path.join(crDir, 'review-annotations'), { recursive: true });
  fs.writeFileSync(path.join(crDir, 'review-annotations', 'requirement.yml'), `cr-id: ${cr}\nreview-type: requirement\nverdict: pass\n`);
  fs.writeFileSync(path.join(crDir, 'review-annotations', 'sdd.yml'), `cr-id: ${cr}\nreview-type: tech-design\nverdict: pass\n`);
  fs.writeFileSync(path.join(crDir, 'approval.yml'), `requirement:\n  via: crctl-approve\ntech-design:\n  via: crctl-approve\n` + fs.readFileSync(path.join(crDir, 'approval.yml'), 'utf8'));
}

function makeTraceFixture() {
  const { base, kb, cr, txws } = makeMergedFixture();
  const baseline = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.2', '--workspace', kb], { cwd: kb });
  assert.equal(baseline.status, 0, baseline.stderr);
  addEvidenceFiles(txws, cr);
  const milestone = path.join(txws, 'milestone.yml');
  fs.writeFileSync(milestone, `cr: ${cr}\nmilestone: M1\ntarget-version: "0.2"\nfr-chain:\n  - fr: FR-1\n    title: 原子回写\n    tasks: [${cr}-TASK-01]\n`);
  return { base, kb, cr, txws };
}

function readWritebackJournal(kb, cr) {
  const root = path.join(kb, '.crctl', 'transactions', 'writeback', `${cr}-traceability`);
  if (!fs.existsSync(root)) return null;
  const txIds = fs.readdirSync(root).sort();
  const p = path.join(root, txIds[txIds.length - 1], 'journal.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('TASK-02 AC-1：outbox 写失败 → writeback 完成、warning、journal pending 且含完整 payload', async () => {
  const { base, kb, cr, txws } = makeTraceFixture();
  try {
    const emitted = [];
    const ctx = resolveRepositories(kb);
    const input = {
      cr, stage: 'traceability', specId: 'test-spec', targetVersion: '0.2',
      milestoneFile: 'milestone.yml', workspace: kb,
      emitTraceEvent: (ev) => { throw new Error('outbox unavailable'); },
    };
    const result = await applyWriteback(ctx, input);
    assert.equal(result.phase, 'complete');
    assert.ok(result.warnings.some((w) => w.code === 'EMIT_FAILED' && w.event_kind === 'trace'), JSON.stringify(result.warnings));
    const j = readWritebackJournal(kb, cr);
    assert.equal(j.writeback.traceOutbox.state, 'pending');
    const intent = j.writeback.traceOutbox;
    assert.ok(intent.commit, 'intent.commit 非空');
    assert.equal(intent.dedupName, `trace-${cr}-${intent.commit}.json`);
    assert.equal(intent.payload.spec_id, 'test-spec');
    assert.equal(intent.payload.traceability['spec-id'], 'test-spec');
    assert.equal(intent.payload.traceability['cr-ref'], cr);
    assert.ok(Array.isArray(intent.payload.traceability.milestones), 'milestones 数组');
    assert.equal(sha256(JSON.stringify(intent.payload)), intent.payloadSha256, 'payload digest 与重算一致');
    assert.equal(emitted.length, 0);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-02 AC-2：恢复后重跑 → 补发成功、state=emitted、确定性文件名', async () => {
  const { base, kb, cr, txws } = makeTraceFixture();
  try {
    const ctx = resolveRepositories(kb);
    const failInput = {
      cr, stage: 'traceability', specId: 'test-spec', targetVersion: '0.2',
      milestoneFile: 'milestone.yml', workspace: kb,
      emitTraceEvent: () => { throw new Error('outbox unavailable'); },
    };
    const first = await applyWriteback(ctx, failInput);
    assert.ok(first.warnings.some((w) => w.code === 'EMIT_FAILED' && w.event_kind === 'trace'));
    const j0 = readWritebackJournal(kb, cr);
    assert.equal(j0.writeback.traceOutbox.state, 'pending');
    const commit = j0.writeback.traceOutbox.commit;

    const emitted = [];
    const second = await applyWriteback(ctx, {
      cr, stage: 'traceability', specId: 'test-spec', targetVersion: '0.2',
      milestoneFile: 'milestone.yml', workspace: kb,
      emitTraceEvent: (ev) => { emitted.push(ev); return ev.dedupName; },
    });
    assert.equal(second.replayedTrace, true);
    assert.equal(emitted.length, 1, '恰好补发一次');
    assert.equal(emitted[0].dedupName, `trace-${cr}-${commit}.json`);
    assert.equal(emitted[0].commit, commit);
    assert.equal(emitted[0].payload.spec_id, 'test-spec');
    const j1 = readWritebackJournal(kb, cr);
    assert.equal(j1.writeback.traceOutbox.state, 'emitted');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-02 AC-3：删除 txws/candidate 后重放仍成功（不触碰 operational workspace 解析）', async () => {
  const { base, kb, cr, txws } = makeTraceFixture();
  try {
    const ctx = resolveRepositories(kb);
    const failInput = {
      cr, stage: 'traceability', specId: 'test-spec', targetVersion: '0.2',
      milestoneFile: 'milestone.yml', workspace: kb,
      emitTraceEvent: () => { throw new Error('outbox unavailable'); },
    };
    await applyWriteback(ctx, failInput);
    const j0 = readWritebackJournal(kb, cr);
    assert.equal(j0.writeback.traceOutbox.state, 'pending');
    const commit = j0.writeback.traceOutbox.commit;

    // 删除 txws 与 candidate：replay 必须只依赖 journal intent
    git(kb, ['worktree', 'remove', '--force', txws]);
    assert.ok(!fs.existsSync(txws), 'txws 已删除');

    const emitted = [];
    const replay = await applyWriteback(ctx, {
      cr, stage: 'traceability', specId: 'test-spec', targetVersion: '0.2',
      milestoneFile: 'milestone.yml', workspace: kb,
      emitTraceEvent: (ev) => { emitted.push(ev); return ev.dedupName; },
    });
    assert.equal(replay.replayedTrace, true);
    assert.equal(replay.phase, 'complete');
    assert.equal(emitted[0].dedupName, `trace-${cr}-${commit}.json`);
    const j1 = readWritebackJournal(kb, cr);
    assert.equal(j1.writeback.traceOutbox.state, 'emitted');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

/* ─────────────────── TASK-03：archive trace pending 前置门 ─────────────────── */

async function makePendingTraceFixture() {
  const { base, kb, cr, txws } = makeTraceFixture();
  const ctx = resolveRepositories(kb);
  const result = await applyWriteback(ctx, {
    cr, stage: 'traceability', specId: 'test-spec', targetVersion: '0.2',
    milestoneFile: 'milestone.yml', workspace: kb,
    emitTraceEvent: () => { throw new Error('outbox unavailable'); },
  });
  assert.ok(result.warnings.some((w) => w.code === 'EMIT_FAILED' && w.event_kind === 'trace'));
  assert.equal(readWritebackJournal(kb, cr).writeback.traceOutbox.state, 'pending');
  return { base, kb, cr, txws };
}

test('TASK-03 AC-1：pending + outbox 不可写 → ARCHIVE_TRACE_PENDING，零 commit/push/cleanup，现场保留', async () => {
  const { base, kb, cr, txws } = await makePendingTraceFixture();
  try {
    const n0 = originMasterCount(base, 'kb');
    const archiveJournalDir = path.join(kb, '.crctl', 'transactions', 'archive', cr);
    const r = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb, env: { CRCTL_OUTBOX_FAIL: '1' } });
    assert.notEqual(r.status, 0, 'gate 必须硬阻断');
    assert.match(r.stderr, /ARCHIVE_TRACE_PENDING/);
    assert.equal(originMasterCount(base, 'kb'), n0, '零 authority 写入');
    assert.equal(fs.existsSync(archiveJournalDir), false, '零 archive journal 创建');
    assert.ok(fs.existsSync(txws), '现场保留');
    assert.equal(readWritebackJournal(kb, cr).writeback.traceOutbox.state, 'pending');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-03 AC-2：pending + outbox 恢复 → 重跑 archive 成功，journal emitted，无重复事件文件', async () => {
  const { base, kb, cr, txws } = await makePendingTraceFixture();
  try {
    const r0 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb, env: { CRCTL_OUTBOX_FAIL: '1' } });
    assert.notEqual(r0.status, 0);
    // 保持 txws clean（证据输入文件提交、milestone 删除），重跑 archive 才能到 complete
    fs.rmSync(path.join(txws, 'milestone.yml'), { force: true });
    git(txws, ['add', '-A']);
    git(txws, ['commit', '-q', '-m', 'evidence fixture']);
    const r1 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r1.json.phase, 'complete', JSON.stringify(r1.json || r1.errJson));
    assert.equal(readWritebackJournal(kb, cr).writeback.traceOutbox.state, 'emitted');
    const outboxDir = path.join(kb, '.crctl', 'outbox');
    const traceFiles = fs.readdirSync(outboxDir).filter((f) => f.startsWith(`trace-${cr}-`));
    assert.equal(traceFiles.length, 1, 'trace 事件文件唯一（gate 补发后不重复）');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-03 AC-3：emitted 直接通过不重复发射；journal 缺失 → ARCHIVE_TRACE_FACT_MISSING', async () => {
  const f1 = makeTraceFixture();
  const { base, kb, cr, txws } = f1;
  try {
    const rt = runCrctl(['writeback-apply', cr, '--stage', 'traceability', '--spec-id', 'test-spec', '--target-version', '0.2', '--milestone-file', 'milestone.yml', '--workspace', kb], { cwd: kb });
    assert.equal(rt.status, 0, rt.stderr);
    fs.rmSync(path.join(txws, 'milestone.yml'), { force: true });
    git(txws, ['add', '-A']);
    git(txws, ['commit', '-q', '-m', 'evidence fixture']);
    const outboxDir = path.join(kb, '.crctl', 'outbox');
    const before = fs.readdirSync(outboxDir).filter((f) => f.startsWith(`trace-${cr}-`)).length;
    const r = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    const after = fs.readdirSync(outboxDir).filter((f) => f.startsWith(`trace-${cr}-`)).length;
    assert.equal(after, before, 'emitted 不重复发射');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }

  const f2 = makeTraceFixture();
  const { base: b2, kb: k2, cr: c2, txws: t2 } = f2;
  try {
    const rt = runCrctl(['writeback-apply', c2, '--stage', 'traceability', '--spec-id', 'test-spec', '--target-version', '0.2', '--milestone-file', 'milestone.yml', '--workspace', k2], { cwd: k2 });
    assert.equal(rt.status, 0, rt.stderr);
    fs.rmSync(path.join(k2, '.crctl', 'transactions', 'writeback', `${c2}-traceability`), { recursive: true, force: true });
    const r = runCrctl(['archive', c2, '--spec-id', 'test-spec', '--workspace', k2], { cwd: k2 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ARCHIVE_TRACE_FACT_MISSING/);
  } finally { fs.rmSync(b2, { recursive: true, force: true }); }
});

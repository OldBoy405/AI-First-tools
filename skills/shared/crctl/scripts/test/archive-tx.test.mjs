// CR-2026-031 TASK-09：archive 与 cleanup-pending 集成测试。
// 覆盖：happy path（四账本同批 + trailer + cleanup 全清 + 幂等重放）、cleanup fault 续跑
// （cleanup-pending 保持 archived、重跑只续清理不重复 commit）、dirty worktree 零删除保留、
// rejected CR（preservedRefs 未合并远端 ref 保留、账本落主 checkout + push trunk）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, runCrctl, sha256, makeCodeApprovedFixture, originMasterCount } from './merge-fixture.mjs';
import { archiveCr, resolveRepositories } from '../lib/workspace-transactions.mjs';

/** merge + 原子 baseline writeback → archive 前置就绪；txws 返回。补齐证据文件 + 写含 evidence 块的 traceability（CR-2026-041 证据门前置）。 */
function makeWritebackFixture() {
  const f = makeCodeApprovedFixture();
  const { base, kb, cr } = f;
  const r = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.phase, 'complete', JSON.stringify(r.json || r.errJson));
  const txws = r.json.operationalWorkspace;
  const rb = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--spec-id', 'test-spec', '--target-version', '0.2', '--workspace', kb], { cwd: kb });
  assert.equal(rb.status, 0, rb.stderr);
  assert.equal(rb.json.status, 'writing-back');
  // 补齐证据文件；traceability 段由真实 writeback-traceability 生成（CR-2026-049 起 archive 前置门要求 trace journal）
  addEvidenceFiles(txws, cr);
  fs.writeFileSync(path.join(txws, 'milestone.yml'), `cr: ${cr}\nmilestone: M0\ntarget-version: "0.2"\nfr-chain:\n  - fr: FR-1\n    title: 原子回写\n    tasks: [${cr}-TASK-01]\n`);
  const rt = runCrctl(['writeback-apply', cr, '--stage', 'traceability', '--spec-id', 'test-spec', '--target-version', '0.2', '--milestone-file', 'milestone.yml', '--workspace', kb], { cwd: kb });
  assert.equal(rt.status, 0, rt.stderr);
  assert.equal(rt.json.phase, 'complete', JSON.stringify(rt.json || rt.errJson));
  // 证据输入文件与 milestone.yml 不入 writeback 精确 staged set，提交并删除保持 txws clean（archive 要求）
  fs.rmSync(path.join(txws, 'milestone.yml'), { force: true });
  git(txws, ['add', '-A']);
  git(txws, ['commit', '-q', '-m', 'evidence fixture']);
  return { base, kb, cr, txws };
}

/** 补齐 7 份 canonical 证据中的 requirement/sdd 两份 review 与 requirement/tech-design 两段 approval。 */
function addEvidenceFiles(txws, cr) {
  const crDir = path.join(txws, 'change-requests', cr);
  fs.mkdirSync(path.join(crDir, 'review-annotations'), { recursive: true });
  fs.writeFileSync(path.join(crDir, 'review-annotations', 'requirement.yml'), `cr-id: ${cr}\nreview-type: requirement\nverdict: pass\n`);
  fs.writeFileSync(path.join(crDir, 'review-annotations', 'sdd.yml'), `cr-id: ${cr}\nreview-type: tech-design\nverdict: pass\n`);
  fs.writeFileSync(path.join(crDir, 'approval.yml'), `requirement:\n  via: crctl-approve\ntech-design:\n  via: crctl-approve\n` + fs.readFileSync(path.join(crDir, 'approval.yml'), 'utf8'));
}

/** 在 txws 补齐 7 份 canonical 证据文件并写含 evidence 块的 traceability.yml（CR-2026-041）。 */
function writeEvidenceTrace(txws, cr) {
  const crDir = path.join(txws, 'change-requests', cr);
  const shaOf = (p) => sha256(fs.readFileSync(p, 'utf8').replaceAll('\r\n', '\n'));
  // makeCodeApprovedFixture 只有 dev-plan/code 两份 review + development-start/code 两段 approval，补齐剩余
  fs.writeFileSync(path.join(crDir, 'review-annotations', 'requirement.yml'), `cr-id: ${cr}\nreview-type: requirement\nverdict: pass\n`);
  fs.writeFileSync(path.join(crDir, 'review-annotations', 'sdd.yml'), `cr-id: ${cr}\nreview-type: tech-design\nverdict: pass\n`);
  fs.writeFileSync(path.join(crDir, 'approval.yml'), `requirement:\n  via: crctl-approve\ntech-design:\n  via: crctl-approve\n` + fs.readFileSync(path.join(crDir, 'approval.yml'), 'utf8'));
  // 七项 evidence path
  const rel = (k) => `change-requests/${cr}/${k}`;
  const testPath = rel('test-report.md');
  const rReq = rel('review-annotations/requirement.yml');
  const rSdd = rel('review-annotations/sdd.yml');
  const rDp = rel('review-annotations/dev-plan.yml');
  const rCode = rel('review-annotations/code.yml');
  const apPath = rel('approval.yml');
  const mcPath = rel('merge-commits.yml');
  const L = [
    '# trace', 'spec-id: test-spec', `cr-ref: ${cr}`, `cr-history: [${cr}]`, 'target-version: "0.2"',
    'baseline-since: "0.2"', 'generated-at: "2026-08-15T00:00:00+08:00"', '', 'milestones:',
    `  - cr: ${cr}`, '    milestone: M0', '    target-version: "0.2"', '    merge-commits:',
    '      - repo: kb', '        trunk: master', '        sha: x', '    frs:', '      - fr: FR-1',
    '    evidence:',
    `      test: { status: pass, path: ${testPath}, sha256: ${shaOf(path.join(crDir, 'test-report.md'))} }`,
    '      reviews:',
    `        requirement: { verdict: pass, path: ${rReq}, sha256: ${shaOf(path.join(crDir, 'review-annotations', 'requirement.yml'))} }`,
    `        tech-design: { verdict: pass, path: ${rSdd}, sha256: ${shaOf(path.join(crDir, 'review-annotations', 'sdd.yml'))} }`,
    `        dev-plan: { verdict: pass, path: ${rDp}, sha256: ${shaOf(path.join(crDir, 'review-annotations', 'dev-plan.yml'))} }`,
    `        code: { verdict: pass, path: ${rCode}, sha256: ${shaOf(path.join(crDir, 'review-annotations', 'code.yml'))} }`,
    `      approval: { status: approved, path: ${apPath}, sha256: ${shaOf(path.join(crDir, 'approval.yml'))} }`,
    `      merge: { status: merged, path: ${mcPath}, sha256: ${shaOf(path.join(crDir, 'merge-commits.yml'))} }`,
  ];
  fs.mkdirSync(path.join(txws, 'specs', 'test-spec'), { recursive: true });
  fs.writeFileSync(path.join(txws, 'specs', 'test-spec', 'traceability.yml'), L.join('\n') + '\n');
}

/** CR-2026-060 G4：new mode archive 夹具——merge + baseline（省略 spec/version）+ 证据 + new traceability（无 milestone-file）。 */
function makeNewModeArchiveFixture() {
  const f = makeCodeApprovedFixture({ targetVersion: '0.2', targetSpecId: 'test-spec', enrichedPlan: true });
  const { base, kb, cr } = f;
  const r = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.phase, 'complete', JSON.stringify(r.json || r.errJson));
  const txws = r.json.operationalWorkspace;
  const rb = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--workspace', kb], { cwd: kb });
  assert.equal(rb.status, 0, rb.stderr);
  assert.equal(rb.json.status, 'writing-back');
  addEvidenceFiles(txws, cr);
  const rt = runCrctl(['writeback-apply', cr, '--stage', 'traceability', '--workspace', kb], { cwd: kb });
  assert.equal(rt.status, 0, rt.stderr);
  assert.equal(rt.json.phase, 'complete', JSON.stringify(rt.json || rt.errJson));
  git(txws, ['add', '-A']);
  git(txws, ['commit', '-q', '-m', 'evidence fixture']);
  return { base, kb, cr, txws };
}

test('TASK-09 AC-1：happy path — 四账本同批 + trailer + cleanup 全清 + 幂等重放', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    const r = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.phase, 'complete', JSON.stringify(r.json || r.errJson));
    assert.equal(r.json.status, 'archived');
    assert.equal(r.json.changed, true);
    assert.match(r.json.txId, /^[0-9a-f]{32}$/);
    // origin trunk 头部 = archive commit + trailer
    const bare = path.join(base, 'origin-kb.git');
    const head = git(bare, ['rev-parse', 'master']);
    const msg = git(bare, ['cat-file', '-p', head]);
    assert.ok(msg.includes('AI-First-Op: archive'));
    assert.ok(msg.includes(`AI-First-CR: ${cr}`));
    // 四账本同 commit：cr.md=archived、backlog 移出、history 追加、index 终态
    assert.ok(git(bare, ['show', `${head}:change-requests/${cr}/cr.md`]).includes('status: archived'));
    const backlog = git(bare, ['show', `${head}:change-requests/_backlog.yml`]);
    assert.ok(!backlog.includes(`- id: ${cr}`), 'backlog 条目已移出');
    const history = git(bare, ['show', `${head}:change-requests/_history.yml`]);
    assert.ok(history.includes(`- id: ${cr}`) && history.includes('final-status: archived') && history.includes('writeback-spec-id: test-spec') && history.includes('notify-log:'));
    const index = git(bare, ['show', `${head}:change-requests/_index.yml`]);
    assert.ok(index.includes(`- id: ${cr}`) && /status: archived/.test(index));
    // cleanup 全清：txws 不存在、CR worktree 不存在、本地分支不存在、远端 requirement ref 删除
    assert.ok(!fs.existsSync(txws), 'txws 已删除');
    assert.ok(!fs.existsSync(path.join(kb, '.rayai-worktrees', 'knowledge-base', 'requirement', cr)), 'kb CR worktree 已删除');
    assert.ok(!fs.existsSync(path.join(kb, '.rayai-worktrees', 'multica', 'requirement', cr)), 'multica CR worktree 已删除');
    const localRef = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/requirement/${cr}`], { cwd: kb, encoding: 'utf8' });
    assert.notEqual(localRef.status, 0, '本地 requirement 分支已删除');
    const remoteRefDel = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/requirement/${cr}`], { cwd: bare, encoding: 'utf8' });
    assert.notEqual(remoteRefDel.status, 0, '远端 requirement ref 已删除');
    // 幂等重放：changed=false 零新 commit
    const n0 = originMasterCount(base, 'kb');
    const r2 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.changed, false);
    assert.equal(r2.json.phase, 'complete');
    assert.equal(originMasterCount(base, 'kb'), n0);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-09 AC-1：cleanup fault → CR_ARCHIVE_CLEANUP_PENDING（status 恒 archived），重跑只续清理不重复 commit', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    const r1 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb, env: { CRCTL_FAULT_POINT: 'archive-during-cleanup' } });
    assert.equal(r1.status, 0, 'cleanup fault 不抛错：' + r1.stderr);
    assert.equal(r1.json.phase, 'cleanup-pending');
    assert.equal(r1.json.status, 'archived');
    assert.equal(r1.json.changed, true);
    // 发布已完成（origin 有 archive commit），cleanup 被 fault 中断（txws 可能已删，剩余资源保留）
    const bare = path.join(base, 'origin-kb.git');
    assert.ok(git(bare, ['cat-file', '-p', 'master']).includes('AI-First-Op: archive'));
    // 重跑：只续清理，不重复账本 commit
    const n0 = originMasterCount(base, 'kb');
    const r2 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.phase, 'complete', JSON.stringify(r2.json || r2.errJson));
    assert.equal(originMasterCount(base, 'kb'), n0, '重跑不得新增 commit');
    assert.ok(!fs.existsSync(txws), 'txws 已清理');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-09 AC-2：dirty CR worktree 零删除 → cleanup-pending 保留现场；清理后重跑 complete', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    // 在 multica CR worktree 制造 dirty
    const mwt = path.join(kb, '.rayai-worktrees', 'multica', 'requirement', cr);
    fs.writeFileSync(path.join(mwt, 'dirty.txt'), 'x\n');
    const r1 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r1.json.phase, 'cleanup-pending');
    assert.ok(r1.json.remaining.some((x) => x.kind === 'cr-worktree' && x.repo === 'multica'), 'dirty worktree 保留在 remaining');
    assert.ok(fs.existsSync(mwt), 'dirty worktree 零删除');
    // 清理 dirty 后重跑 → complete
    fs.rmSync(path.join(mwt, 'dirty.txt'));
    const r2 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.phase, 'complete', JSON.stringify(r2.json || r2.errJson));
    assert.ok(!fs.existsSync(mwt), '清理后 worktree 删除');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('review repair：archive 删除 requirement ref 前必须证明 source 已合入 origin trunk', () => {
  const { base, kb, cr } = makeWritebackFixture();
  try {
    const baseSha = git(kb, ['rev-parse', 'master']);
    const tree = git(kb, ['rev-parse', `${baseSha}^{tree}`]);
    const unmerged = git(kb, ['commit-tree', tree, '-p', baseSha, '-m', 'unmerged release source']);
    git(kb, ['push', '-q', '--force', 'origin', `${unmerged}:refs/heads/requirement/${cr}`]);
    const r = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.phase, 'cleanup-pending');
    assert.ok(r.json.remaining.some((x) => x.kind === 'remote-ref' && x.why === 'not-merged'));
    assert.equal(git(path.join(base, 'origin-kb.git'), ['rev-parse', `refs/heads/requirement/${cr}`]), unmerged, '未证明 merged 的 source ref 必须保留');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-09 AC-2：rejected CR — authority 来自 CR worktree，归档在 detached trunk 提交并保留未合并 ref', () => {
  const f = makeCodeApprovedFixture();
  const { base, kb, kbWt, cr } = f;
  try {
    const crDir = path.join(kbWt, 'change-requests', cr);
    fs.writeFileSync(path.join(crDir, 'cr.md'), `---\nid: ${cr}\nstatus: rejected\nupdated-at: "2026-08-11T21:00:00+08:00"\n---\n`);
    git(kbWt, ['add', '-A']);
    git(kbWt, ['commit', '-q', '-m', 'reject']);
    git(kbWt, ['push', '-q', 'origin', `HEAD:refs/heads/requirement/${cr}`]);
    const r = runCrctl(['archive', cr, '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.phase, 'complete', JSON.stringify(r.json || r.errJson));
    assert.equal(r.json.status, 'rejected');
    // preservedRefs：未合并远端 requirement ref 保留
    assert.ok(r.json.preservedRefs.some((x) => x.includes('kb') && x.includes(`requirement/${cr}`)), 'preservedRefs 含 kb 未合并 ref: ' + JSON.stringify(r.json.preservedRefs));
    const bare = path.join(base, 'origin-kb.git');
    assert.ok(git(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/requirement/${cr}`]), '远端 requirement ref 保留');
    // 账本：主 checkout push trunk（archive commit 在 master）
    const head = git(bare, ['rev-parse', 'master']);
    assert.ok(git(bare, ['cat-file', '-p', head]).includes('AI-First-Op: archive'));
    assert.ok(git(bare, ['show', `${head}:change-requests/${cr}/cr.md`]).includes('status: rejected'));
    const history = git(bare, ['show', `${head}:change-requests/_history.yml`]);
    assert.ok(history.includes('final-status: rejected'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

/* ───────────── CR-2026-032 TASK-01：ARC-03/04 契约红测（TASK-02 实现前按预期失败） ─────────────
 * 冻结向量：固定返回、必需 emitter、正常 archive outbox schema v1、cleanup 回显、dirty 保留、
 * outbox 失败 warning/补发、预存 dedup 命中、rejected/withdrawn 零事件、complete 幂等重放、
 * remote rebuild 最终 SHA。断言只读新契约字段与事件内容，不删除/放宽既有 TASK-09 断言。 */

/** 过滤 kb installation workspace outbox 中本 CR 的 archive 事件文件名（按确定性 dedup_name 前缀）。 */
function archiveOutboxFiles(kb, cr) {
  const dir = path.join(kb, '.crctl', 'outbox');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith(`archive-${cr}-`));
}

/** 读取 kb installation workspace outbox 中本 CR 的全部事件 JSON（内容级断言；解析失败硬失败，不静默降级）。 */
function outboxEventsForCr(kb, cr) {
  const dir = path.join(kb, '.crctl', 'outbox');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((ev) => ev.cr_id === cr);
}

test('TASK-01 RED-1：happy path 固定返回 commit/lastCleanupError/recoverCommand/warnings', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    const r = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.phase, 'complete');
    assert.equal(r.json.status, 'archived');
    const head = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
    assert.equal(r.json.commit, head, 'commit = origin 带 trailer 的最终 SHA');
    assert.equal(r.json.lastCleanupError, null);
    assert.deepEqual(r.json.remaining, []);
    assert.deepEqual(r.json.preservedRefs, []);
    assert.ok(r.json.recoverCommand.includes('crctl archive ' + cr), 'recoverCommand 可执行续跑');
    assert.deepEqual(r.json.warnings, []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-01 RED-2：必需 emitter — 缺失/非法在 lock/journal/commit/push/outbox 前 ARCHIVE_EMITTER_REQUIRED', async () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    const ctx = resolveRepositories(kb);
    const n0 = originMasterCount(base, 'kb');
    const journalDir = path.join(kb, '.crctl', 'transactions', 'archive', cr);
    await assert.rejects(
      archiveCr(ctx, { cr, specId: 'test-spec', workspace: kb }),
      (e) => e.code === 'ARCHIVE_EMITTER_REQUIRED', '缺失 adapter 必须硬失败');
    assert.equal(fs.existsSync(journalDir), false, 'archive journal 目录未创建（任何副作用前失败）');
    assert.equal(originMasterCount(base, 'kb'), n0, 'origin 零新 commit');
    assert.deepEqual(archiveOutboxFiles(kb, cr), [], '无 archive outbox 文件');
    await assert.rejects(
      archiveCr(ctx, { cr, specId: 'test-spec', workspace: kb, emitArchiveEvent: 'not-a-function' }),
      (e) => e.code === 'ARCHIVE_EMITTER_REQUIRED', '非函数 adapter 同样硬失败');
    assert.equal(originMasterCount(base, 'kb'), n0, '非法 adapter 零新 commit');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-01 RED-3：正常归档产生唯一 schema v1 archive 事件（六业务字段 + 真实 SHA）', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    const r = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.phase, 'complete');
    const head = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
    const files = archiveOutboxFiles(kb, cr);
    assert.equal(files.length, 1, '恰好一个 archive 事件文件');
    assert.equal(files[0], `archive-${cr}-${head}.json`, '确定性 dedup 文件名');
    assert.equal(r.json.outbox, files[0], '返回本次事件文件名');
    const ev = JSON.parse(fs.readFileSync(path.join(kb, '.crctl', 'outbox', files[0]), 'utf8'));
    assert.equal(ev.v, 1);
    assert.equal(ev.event_kind, 'archive');
    assert.equal(ev.cr_id, cr);
    assert.equal(ev.from_status, 'writing-back');
    assert.equal(ev.to_status, 'archived');
    assert.equal(ev.trigger, 'cr-archive');
    assert.equal(ev.commit_sha, head, 'commit_sha = origin 最终 archive SHA');
    assert.ok(ev.actor && ev.actor.length > 0, 'actor 非空');
    assert.ok(ev.occurred_at, 'occurred_at 由 emitOutboxEvent 生成');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-01 RED-4：cleanup fault → pending + 非空 lastCleanupError + 真实 commit；重跑零新 commit', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    const r1 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb, env: { CRCTL_FAULT_POINT: 'archive-during-cleanup' } });
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r1.json.phase, 'cleanup-pending');
    assert.equal(r1.json.status, 'archived');
    const head = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
    assert.equal(r1.json.commit, head, 'commit 已在 fault 前确认');
    assert.ok(r1.json.lastCleanupError, 'cleanup 执行异常必须非空错误码');
    assert.ok(r1.json.recoverCommand.includes('crctl archive ' + cr));
    assert.deepEqual(r1.json.warnings, []);
    const n0 = originMasterCount(base, 'kb');
    const r2 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.phase, 'complete', JSON.stringify(r2.json || r2.errJson));
    assert.equal(r2.json.lastCleanupError, null, '成功清理后错误码归 null');
    assert.equal(r2.json.commit, head);
    assert.equal(originMasterCount(base, 'kb'), n0, '续跑只续清理，零新 commit');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-01 RED-5：dirty worktree — remaining 非空而 lastCleanupError=null（资源保留≠执行异常）', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    const mwt = path.join(kb, '.rayai-worktrees', 'multica', 'requirement', cr);
    fs.writeFileSync(path.join(mwt, 'dirty.txt'), 'x\n');
    const r1 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r1.json.phase, 'cleanup-pending');
    assert.equal(r1.json.lastCleanupError, null, 'dirty 保留不是执行异常');
    assert.ok(r1.json.remaining.some((x) => x.kind === 'cr-worktree' && x.repo === 'multica'));
    assert.ok(r1.json.commit, 'commit 已确认');
    assert.ok(fs.existsSync(mwt), 'dirty worktree 零删除');
    fs.rmSync(path.join(mwt, 'dirty.txt'));
    const r2 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.phase, 'complete', JSON.stringify(r2.json || r2.errJson));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-01 RED-6：outbox 失败 → exit 0 + EMIT_FAILED warning + authority 不回滚；重跑补发零新 commit', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    const outDir = path.join(kb, '.crctl', 'outbox');
    fs.rmSync(outDir, { recursive: true, force: true }); // baseline 已产生 status outbox；本例隔离 archive emitter
    fs.writeFileSync(outDir, 'conflict\n'); // outbox 目录被占位为普通文件 → emitOutboxEvent mkdirSync 失败
    const n0 = originMasterCount(base, 'kb');
    const r1 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r1.status, 0, 'outbox 失败不得失败归档：' + r1.stderr);
    assert.equal(r1.json.phase, 'complete', JSON.stringify(r1.json || r1.errJson));
    assert.deepEqual(r1.json.warnings, [{ code: 'EMIT_FAILED', event_kind: 'archive' }]);
    assert.equal(r1.json.outbox, undefined, '未发送不返回 outbox 文件名');
    assert.equal(originMasterCount(base, 'kb'), n0 + 1, 'authority 已发布（一次 archive commit），不回滚');
    fs.rmSync(outDir);
    const r2 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(r2.json.warnings, [], '补发成功无 warning');
    assert.equal(originMasterCount(base, 'kb'), n0 + 1, '补发零新 commit');
    const files = archiveOutboxFiles(kb, cr);
    assert.equal(files.length, 1, '补发后恰好一个 archive 事件');
    const ev = JSON.parse(fs.readFileSync(path.join(kb, '.crctl', 'outbox', files[0]), 'utf8'));
    assert.equal(ev.event_kind, 'archive');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-01 RED-7：预存确定性 dedup 文件 → 命中同名补记，数量不增、内容不覆盖', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    const outDir = path.join(kb, '.crctl', 'outbox');
    fs.rmSync(outDir, { recursive: true, force: true }); // baseline status outbox 不属于本 archive dedup 断言
    fs.writeFileSync(outDir, 'conflict\n');
    const r1 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r1.status, 0, r1.stderr);
    assert.deepEqual(r1.json.warnings, [{ code: 'EMIT_FAILED', event_kind: 'archive' }]);
    fs.rmSync(outDir);
    const head = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
    fs.mkdirSync(outDir, { recursive: true });
    const dedupName = `archive-${cr}-${head}.json`;
    fs.writeFileSync(path.join(outDir, dedupName), '{"placeholder":true}\n'); // 文件写成功但 journal 未标记的崩溃窗
    const n1 = originMasterCount(base, 'kb');
    const r2 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.phase, 'complete', JSON.stringify(r2.json || r2.errJson));
    assert.deepEqual(r2.json.warnings, []);
    assert.equal(r2.json.outbox, dedupName, '命中确定性文件即视为已发送');
    const files = archiveOutboxFiles(kb, cr);
    assert.equal(files.length, 1, '命中预存文件，数量不增');
    assert.equal(fs.readFileSync(path.join(outDir, dedupName), 'utf8'), '{"placeholder":true}\n', '不覆盖既有内容');
    assert.equal(originMasterCount(base, 'kb'), n1, '零新 commit');
    const r3 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r3.status, 0, r3.stderr);
    assert.deepEqual(r3.json.warnings, []);
    assert.equal(archiveOutboxFiles(kb, cr).length, 1, 'complete 重放不再生成事件');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-01 RED-8：rejected/withdrawn — 固定返回、零事件（archive/status）、preservedRefs 保留', () => {
  for (const finalStatus of ['rejected', 'withdrawn']) {
    const f = makeCodeApprovedFixture();
    const { base, kb, kbWt, cr } = f;
    try {
      const crDir = path.join(kbWt, 'change-requests', cr);
      fs.writeFileSync(path.join(crDir, 'cr.md'), `---\nid: ${cr}\nstatus: ${finalStatus}\nupdated-at: "2026-08-11T21:00:00+08:00"\n---\n`);
      git(kbWt, ['add', '-A']);
      git(kbWt, ['commit', '-q', '-m', finalStatus]);
      git(kbWt, ['push', '-q', 'origin', `HEAD:refs/heads/requirement/${cr}`]);
      const r = runCrctl(['archive', cr, '--workspace', kb], { cwd: kb });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.status, finalStatus);
      const head = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
      assert.equal(r.json.commit, head, `${finalStatus} 同样返回固定 commit`);
      assert.equal(r.json.lastCleanupError, null);
      assert.deepEqual(r.json.warnings, []);
      assert.equal(r.json.outbox, undefined, `${finalStatus} 不发送事件`);
      assert.deepEqual(archiveOutboxFiles(kb, cr), [], `${finalStatus} 无 archive 事件文件`);
      // AC-5 / SDD §4.6：内容级断言两种终止状态均无 archive 事件，也无第二终态 status 事件
      const evs = outboxEventsForCr(kb, cr);
      assert.equal(evs.filter((e) => e.event_kind === 'archive').length, 0, `${finalStatus} 无 archive 事件（outbox JSON 内容级）`);
      assert.equal(evs.filter((e) => e.event_kind === 'status').length, 0, `${finalStatus} 无第二终态 status 事件`);
      // AC-5：preservedRefs 既有行为保持——未合并远端 requirement ref 保留
      assert.ok(r.json.preservedRefs.some((x) => x.includes('kb') && x.includes(`requirement/${cr}`)), `${finalStatus} preservedRefs 含 kb 未合并 ref: ` + JSON.stringify(r.json.preservedRefs));
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

test('TASK-01 RED-9：complete 幂等重放 — changed=false、固定字段、outbox 数量不增', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    const r1 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r1.status, 0, r1.stderr);
    const head = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
    const nFiles0 = archiveOutboxFiles(kb, cr).length;
    assert.equal(nFiles0, 1);
    const n0 = originMasterCount(base, 'kb');
    const r2 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.phase, 'complete');
    assert.equal(r2.json.changed, false);
    assert.equal(r2.json.commit, head, '重放返回同一最终 SHA');
    assert.equal(r2.json.lastCleanupError, null);
    assert.deepEqual(r2.json.warnings, []);
    assert.equal(r2.json.outbox, undefined, '已发送重放不再产生事件');
    assert.equal(archiveOutboxFiles(kb, cr).length, nFiles0, 'outbox 文件数量不增');
    assert.equal(originMasterCount(base, 'kb'), n0, '零新 commit');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-01 RED-10：remote rebuild — 返回 commit 与事件 commit_sha 均为最终 origin SHA', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    const r1 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb, env: { CRCTL_FAULT_POINT: 'archive-after-commit' } });
    assert.equal(r1.status, 1, 'fault 注入必须非零退出');
    // 他人推进 origin trunk（本地 archive commit 未 push 时）；kb 本地 master 先同步到 origin 再前进
    git(kb, ['fetch', '-q', 'origin']);
    git(kb, ['reset', '--hard', 'origin/master']);
    git(kb, ['commit', '--allow-empty', '-q', '-m', 'other progress']);
    git(kb, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
    const r2 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    const head = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
    assert.equal(r2.json.commit, head, 'rebuild 后返回最终 SHA');
    const files = archiveOutboxFiles(kb, cr);
    assert.equal(files.length, 1, '全程只产生一个 archive 事件');
    const ev = JSON.parse(fs.readFileSync(path.join(kb, '.crctl', 'outbox', files[0]), 'utf8'));
    assert.equal(ev.commit_sha, head, '事件只用最终 confirmed SHA，旧 SHA 不得出现');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

/* ───────────── CR-2026-041 归档证据门 ───────────── */

test('CR-2026-041 证据门：evidence digest 漂移 → ARCHIVE_EVIDENCE_DRIFT 硬失败且零 journal/authority', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    const tp = path.join(txws, 'specs', 'test-spec', 'traceability.yml');
    const t = fs.readFileSync(tp, 'utf8');
    fs.writeFileSync(tp, t.replace(/sha256: [0-9a-f]{64}/, 'sha256: ' + '0'.repeat(64)));
    git(txws, ['add', 'specs/test-spec/traceability.yml']);
    git(txws, ['commit', '-q', '-m', 'drift']);
    const n0 = originMasterCount(base, 'kb');
    const journalDir = path.join(kb, '.crctl', 'transactions', 'archive', cr);
    fs.rmSync(journalDir, { recursive: true, force: true });
    const r = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.notEqual(r.status, 0, '证据漂移必须失败');
    assert.ok(/ARCHIVE_EVIDENCE_DRIFT|ARCHIVE_EVIDENCE/.test(r.stderr), '错误码应为 ARCHIVE_EVIDENCE_*：' + r.stderr);
    assert.equal(originMasterCount(base, 'kb'), n0, '证据门失败零 authority 写入');
    assert.equal(fs.existsSync(journalDir), false, '证据门失败零 journal 创建');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-041 证据门：证据缺失 → ARCHIVE_EVIDENCE 硬失败且零 journal', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    // 删除一份 review 证据源文件（traceability evidence 块仍引用，重读失败 → 缺失）
    fs.rmSync(path.join(txws, 'change-requests', cr, 'review-annotations', 'requirement.yml'));
    git(txws, ['add', '-A']);
    git(txws, ['commit', '-q', '-m', 'drop evidence']);
    const n0 = originMasterCount(base, 'kb');
    const journalDir = path.join(kb, '.crctl', 'transactions', 'archive', cr);
    fs.rmSync(journalDir, { recursive: true, force: true });
    const r = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.notEqual(r.status, 0, '证据缺失必须失败');
    assert.ok(/ARCHIVE_EVIDENCE/.test(r.stderr), '错误码应为 ARCHIVE_EVIDENCE_*：' + r.stderr);
    assert.equal(originMasterCount(base, 'kb'), n0, '证据门失败零 authority 写入');
    assert.equal(fs.existsSync(journalDir), false, '证据门失败零 journal 创建');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

/* ───────────── CR-2026-054 TASK-03 archive 候选校验（ARCHIVE_YAML_INVALID） ───────────── */

/** 在 txws 写入损坏文件并提交（模拟权威基线损坏；不 commit 会留下 dirty 干扰断言） */
function corruptAndCommit(txws, rel, text) {
  const p = path.join(txws, rel);
  fs.writeFileSync(p, text);
  git(txws, ['add', rel]);
  git(txws, ['commit', '-q', '-m', 'corrupt candidate']);
}

test('CR-2026-054 候选校验：首次构建损坏候选 → ARCHIVE_YAML_INVALID 且零 stage/commit/push', () => {
  const cases = [
    {
      label: 'history 根为序列 → 追加 record 无法消费',
      corrupt: (txws) => corruptAndCommit(txws, 'change-requests/_history.yml', '- not-a-map\n'),
      expect: { category: 'unconsumed-line', file: '_history.yml' },
    },
    {
      label: 'backlog 根行不可解释',
      corrupt: (txws) => {
        const bp = path.join(txws, 'change-requests', '_backlog.yml');
        const text = fs.readFileSync(bp, 'utf8').replaceAll('\r\n', '\n');
        corruptAndCommit(txws, 'change-requests/_backlog.yml', text.replace(/^schema:.*\n/, 'just text\n'));
      },
      expect: { category: 'invalid-shape', file: '_backlog.yml' },
    },
    {
      label: 'backlog 仍含目标 CR（重复条目）',
      corrupt: (txws, cr) => {
        const bp = path.join(txws, 'change-requests', '_backlog.yml');
        const text = fs.readFileSync(bp, 'utf8').replaceAll('\r\n', '\n');
        const entry = text.split('\n').filter((l) => l.trimStart().startsWith('- id: '))[0];
        corruptAndCommit(txws, 'change-requests/_backlog.yml', text.trimEnd() + '\n' + entry + '\n    title: dup\n');
      },
      expect: { category: 'archive-invariant', file: '_backlog.yml' },
    },
    {
      label: 'history 全局 id 重复',
      corrupt: (txws) => {
        const body = [
          'history:',
          '  - id: OTHER-1',
          '    final-status: archived',
          '  - id: OTHER-1',
          '    final-status: archived',
          '',
        ].join('\n');
        corruptAndCommit(txws, 'change-requests/_history.yml', body);
      },
      expect: { category: 'archive-invariant', file: '_history.yml' },
    },
    {
      label: 'history final-status 非法',
      corrupt: (txws) => {
        const body = [
          'history:',
          '  - id: OTHER-1',
          '    final-status: garbage',
          '',
        ].join('\n');
        corruptAndCommit(txws, 'change-requests/_history.yml', body);
      },
      expect: { category: 'archive-invariant', file: '_history.yml' },
    },
    {
      label: 'index 目标 CR 条目重复',
      corrupt: (txws, cr) => {
        const ip = path.join(txws, 'change-requests', '_index.yml');
        const text = fs.readFileSync(ip, 'utf8').replaceAll('\r\n', '\n');
        const entry = text.split('\n').filter((l) => l.trimStart().startsWith('- id: '))[0];
        corruptAndCommit(txws, 'change-requests/_index.yml', text.trimEnd() + '\n' + entry + '\n');
      },
      expect: { category: 'archive-invariant', file: '_index.yml' },
    },
    {
      label: 'history tab 缩进',
      corrupt: (txws) => {
        corruptAndCommit(txws, 'change-requests/_history.yml', 'history:\n\t- id: OTHER-1\n');
      },
      expect: { category: 'invalid-indentation', file: '_history.yml' },
    },
    {
      label: 'cr.md frontmatter 重复 id（行号偏移回完整文件）',
      corrupt: (txws, cr) => {
        const cp = path.join(txws, 'change-requests', cr, 'cr.md');
        const text = fs.readFileSync(cp, 'utf8').replaceAll('\r\n', '\n');
        const norm = text.replace(/^id:.*$/m, (m) => `${m}\nid: ${cr}`);
        corruptAndCommit(txws, `change-requests/${cr}/cr.md`, norm);
      },
      expect: { category: 'duplicate-key', file: 'cr.md' },
    },
  ];
  for (const c of cases) {
    const { base, kb, cr, txws } = makeWritebackFixture();
    try {
      c.corrupt(txws, cr);
      const headBefore = git(txws, ['rev-parse', 'HEAD']);
      const n0 = originMasterCount(base, 'kb');
      const r = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
      assert.notEqual(r.status, 0, `${c.label}：候选校验必须失败`);
      assert.ok(r.stderr.includes('ARCHIVE_YAML_INVALID'), `${c.label}：错误码 ARCHIVE_YAML_INVALID 缺失：${r.stderr}`);
      assert.ok(r.stderr.includes(c.expect.category), `${c.label}：category=${c.expect.category} 缺失：${r.stderr}`);
      assert.ok(r.stderr.includes(c.expect.file), `${c.label}：file=${c.expect.file} 缺失：${r.stderr}`);
      assert.ok(/@line \d+|archive-invariant/.test(r.stderr), `${c.label}：诊断行号缺失：${r.stderr}`);
      assert.equal(git(txws, ['status', '--porcelain']), '', `${c.label}：失败后工作区/stage 必须干净`);
      assert.equal(git(txws, ['rev-parse', 'HEAD']), headBefore, `${c.label}：失败后 HEAD 不得移动`);
      assert.equal(originMasterCount(base, 'kb'), n0, `${c.label}：失败零 commit/push`);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

test('CR-2026-054 候选校验：history 缺少必需根键 → ARCHIVE_YAML_INVALID 且零 stage/commit/push', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    // The generated target entry remains a valid list item, but under the wrong root key.
    corruptAndCommit(txws, 'change-requests/_history.yml', 'legacy-history:\n  - id: OTHER-1\n    final-status: archived\n');
    const headBefore = git(txws, ['rev-parse', 'HEAD']);
    const n0 = originMasterCount(base, 'kb');
    const r = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.notEqual(r.status, 0, '缺少 history 根键必须失败');
    assert.ok(r.stderr.includes('ARCHIVE_YAML_INVALID'), r.stderr);
    assert.ok(r.stderr.includes('_history.yml') && r.stderr.includes('invalid-shape'), r.stderr);
    assert.equal(git(txws, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(originMasterCount(base, 'kb'), n0);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-054 候选校验：index 缺少必需根键 → ARCHIVE_YAML_INVALID 且零 stage/commit/push', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    const ip = path.join(txws, 'change-requests', '_index.yml');
    const text = fs.readFileSync(ip, 'utf8').replaceAll('change-requests:', 'legacy-index:');
    corruptAndCommit(txws, 'change-requests/_index.yml', text);
    const headBefore = git(txws, ['rev-parse', 'HEAD']);
    const n0 = originMasterCount(base, 'kb');
    const r = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.notEqual(r.status, 0, '缺少 change-requests 根键必须失败');
    assert.ok(r.stderr.includes('ARCHIVE_YAML_INVALID'), r.stderr);
    assert.ok(r.stderr.includes('_index.yml') && r.stderr.includes('invalid-shape'), r.stderr);
    assert.equal(git(txws, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(originMasterCount(base, 'kb'), n0);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-054 候选校验：remote rebuild 损坏基线 → ARCHIVE_YAML_INVALID 且零新增 commit', () => {
  const { base, kb, cr, txws } = makeWritebackFixture();
  try {
    // r1：archive 本地 commit 后注入 fault（不 push），journal 停在 committed
    const r1 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb, env: { CRCTL_FAULT_POINT: 'archive-after-commit' } });
    assert.equal(r1.status, 1, 'fault 注入必须非零退出');
    // 他人推进 origin trunk 时携带损坏 history（模拟新基线坏账本），本 CR 的 rebuild 路径必须拒绝
    git(kb, ['fetch', '-q', 'origin']);
    git(kb, ['reset', '--hard', 'origin/master']);
    fs.writeFileSync(path.join(kb, 'change-requests', '_history.yml'), 'history:\n  - id: OTHER-1\n    final-status: archived\n  - id: OTHER-1\n    final-status: archived\n');
    git(kb, ['add', 'change-requests/_history.yml']);
    git(kb, ['commit', '-q', '-m', 'other progress with corrupt history']);
    git(kb, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
    const n0 = originMasterCount(base, 'kb');
    const r2 = runCrctl(['archive', cr, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.notEqual(r2.status, 0, 'rebuild 遇损坏候选必须失败');
    assert.ok(r2.stderr.includes('ARCHIVE_YAML_INVALID'), '错误码 ARCHIVE_YAML_INVALID 缺失：' + r2.stderr);
    assert.ok(r2.stderr.includes('_history.yml') && r2.stderr.includes('archive-invariant'), '诊断应指向 _history.yml 全局不变量：' + r2.stderr);
    assert.equal(originMasterCount(base, 'kb'), n0, 'rebuild 失败零新增 archive commit');
    assert.equal(git(txws, ['rev-parse', 'HEAD']), git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']), 'txws 停在他人基线，不产生本地提交');
    assert.equal(git(txws, ['status', '--porcelain']), '', 'rebuild 失败后 txws 工作区/stage 干净');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

/* ────────────────────────── CR-2026-060 G4：archive new mode journal 重放（AC-13） ────────────────────────── */

test('CR-2026-060 AC-13：new mode archive 省略 --spec-id 首跑持久化 payload；清理后重放只读 journal（无需 spec-id）', () => {
  const { base, kb, cr, txws } = makeNewModeArchiveFixture();
  try {
    const r1 = runCrctl(['archive', cr, '--workspace', kb], { cwd: kb });
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r1.json.phase, 'complete', JSON.stringify(r1.json || r1.errJson));
    assert.equal(r1.json.status, 'archived');
    assert.equal(r1.json.changed, true);
    assert.ok(!fs.existsSync(txws), 'txws 已清理');
    // journal payload 持久化 mode/specId/targetSpecId（重放事实源）
    const journalDir = path.join(kb, '.crctl', 'transactions', 'archive', cr);
    const txId = fs.readdirSync(journalDir)[0];
    const j = JSON.parse(fs.readFileSync(path.join(journalDir, txId, 'journal.json'), 'utf8'));
    assert.equal(j.archive.mode, 'new');
    assert.equal(j.archive.specId, 'test-spec');
    assert.equal(j.archive.targetSpecId, 'test-spec');
    // 清理后重放：不传 --spec-id，只读 journal payload，不重新解析已删除的 CR worktree/txws
    const r2 = runCrctl(['archive', cr, '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.phase, 'complete', JSON.stringify(r2.json || r2.errJson));
    assert.equal(r2.json.changed, false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-060 AC-13：new mode 首跑 txws 缺失 → ARCHIVE_SPEC_REQUIRED（映射 WRITEBACK_SPEC_REQUIRED，不回退 cr-worktree）', () => {
  const f = makeCodeApprovedFixture({ targetVersion: '0.2', targetSpecId: 'test-spec', enrichedPlan: true });
  const { base, kb, cr } = f;
  try {
    const r = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.phase, 'complete', JSON.stringify(r.json || r.errJson));
    fs.rmSync(r.json.operationalWorkspace, { recursive: true, force: true });
    const a = runCrctl(['archive', cr, '--workspace', kb], { cwd: kb });
    assert.notEqual(a.status, 0);
    assert.equal(a.errJson.error.code, 'ARCHIVE_SPEC_REQUIRED', a.stderr);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

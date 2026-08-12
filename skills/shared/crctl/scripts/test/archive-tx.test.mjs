// CR-2026-031 TASK-09：archive 与 cleanup-pending 集成测试。
// 覆盖：happy path（四账本同批 + trailer + cleanup 全清 + 幂等重放）、cleanup fault 续跑
// （cleanup-pending 保持 archived、重跑只续清理不重复 commit）、dirty worktree 零删除保留、
// rejected CR（preservedRefs 未合并远端 ref 保留、账本落主 checkout + push trunk）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, runCrctl, sha256, makeCodeApprovedFixture, originMasterCount } from './merge-fixture.mjs';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WB_SCRIPTS = path.resolve(SCRIPTS, '..', '..', '..', '..', 'skills', 'writeback', 'scripts');
const PRD_SDD = path.join(WB_SCRIPTS, 'writeback-prd-sdd.mjs');

function runScript(script, cwd, args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: parse(r.stdout) };
}

/** merge + baseline writeback + advance writing-back → archive 前置就绪；txws 返回。 */
function makeWritebackFixture() {
  const f = makeCodeApprovedFixture();
  const { base, kb, cr } = f;
  const r = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.phase, 'complete', JSON.stringify(r.json || r.errJson));
  const txws = r.json.operationalWorkspace;
  // baseline candidate + apply（merging 阶段）
  const out = path.join(txws, '.cand-a');
  fs.mkdirSync(out, { recursive: true });
  const g = runScript(PRD_SDD, txws, ['--workspace', txws, '--cr', cr, '--spec', 'test-spec', '--version', '0.2', '--candidate-out', out]);
  assert.equal(g.code, 0, g.stderr);
  const rb = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--candidate', path.join(out, 'manifest.json'), '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
  assert.equal(rb.status, 0, rb.stderr);
  // advance merging -> writing-back（txws）
  const ra = runCrctl(['advance', cr, '--to', 'writing-back', '--trigger', 'writeback-prd-sdd', '--expect', 'merging', '--embedded', '--spec-id', 'test-spec'], { cwd: txws });
  assert.equal(ra.status, 0, ra.stderr);
  // traceability 落点存在性（archive 前置）；提交保持 txws clean（否则 archive cleanup 视为 dirty 零删除）
  fs.rmSync(path.join(txws, '.cand-a'), { recursive: true, force: true }); // 清理 candidate 残留
  fs.mkdirSync(path.join(txws, 'specs', 'test-spec'), { recursive: true });
  fs.writeFileSync(path.join(txws, 'specs', 'test-spec', 'traceability.yml'), '# trace\nmilestones:\n');
  git(txws, ['add', 'specs/test-spec/traceability.yml']);
  git(txws, ['commit', '-q', '-m', 'traceability fixture']);
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

test('TASK-09 AC-2：rejected CR — 账本落主 checkout + push trunk，未合并远端 ref 保留为 preservedRefs', () => {
  const f = makeCodeApprovedFixture();
  const { base, kb, cr } = f;
  try {
    // 构造 rejected：主 checkout cr.md status=rejected（reject 评审产物在主 checkout）
    const crDir = path.join(kb, 'change-requests', cr);
    fs.writeFileSync(path.join(crDir, 'cr.md'), `---\nid: ${cr}\nstatus: rejected\nupdated-at: "2026-08-11T21:00:00+08:00"\n---\n`);
    git(kb, ['add', '-A']);
    git(kb, ['commit', '-q', '-m', 'reject']);
    git(kb, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
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

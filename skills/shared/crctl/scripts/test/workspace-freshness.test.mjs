// CR-2026-043 TASK-01/02：workspace freshness 分类与 ff-only 同步事务测试。
// 复用 merge-fixture（三 bare origin + 三仓 dir-graph）；真实 Git，无 mock。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { git, runCrctl, makeFixture } from './merge-fixture.mjs';
import { TxError, resolveRepositories, classifyWorkspaceFreshness, isAncestorOrThrow, syncWorkspaceToTrunk } from '../lib/workspace-transactions.mjs';
import { acquireLock } from '../lib/durable-tx.mjs';

const CR = 'CR-2026-043';

function wtPath(kb, repo, cr) {
  return path.join(kb, '.rayai-worktrees', repo === 'kb' ? 'knowledge-base' : repo, 'requirement', cr);
}

/** 三仓 requirement/{CR} 分支 + worktree，与 origin/master 同 SHA（初始全 fresh）。 */
function makeFreshnessFixture() {
  const f = makeFixture();
  const { kb, others } = f;
  for (const [repo, wd] of Object.entries({ kb, ...others })) {
    git(wd, ['branch', `requirement/${CR}`, 'master']);
    git(wd, ['worktree', 'add', wtPath(kb, repo, CR), `requirement/${CR}`]);
  }
  return f;
}

/** 外部推进 origin/{name} 的 master（worktree 之外，模拟 trunk 前进）。 */
function advanceTrunk(base, name, tag) {
  const wd = path.join(base, `ext-${name}-${tag}`);
  git(base, ['clone', '-q', path.join(base, `origin-${name}.git`), wd]);
  git(wd, ['config', 'user.email', 'ext@aifirst.dev']);
  git(wd, ['config', 'user.name', 'Ext']);
  fs.writeFileSync(path.join(wd, `advance-${tag}.txt`), `${name} trunk advance ${tag}\n`);
  git(wd, ['add', '-A']);
  git(wd, ['commit', '-q', '-m', `trunk advance ${tag}`]);
  git(wd, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
  return git(wd, ['rev-parse', 'HEAD']);
}

/** 在 CR worktree 内提交（分支独有提交，模拟开发态/发散）。 */
function advanceBranch(kb, repo, tag) {
  const wt = wtPath(kb, repo, CR);
  fs.writeFileSync(path.join(wt, `branch-${tag}.txt`), `${repo} branch advance ${tag}\n`);
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-q', '-m', `branch advance ${tag}`]);
  return git(wt, ['rev-parse', 'HEAD']);
}

const classify = (kb) => classifyWorkspaceFreshness(resolveRepositories(kb), CR);
const repoFact = (result, repo) => result.repositories.find((r) => r.repo === repo);

test('TASK-01：HEAD==trunk → 全仓 fresh，allFresh=true，syncable=false（AC-1）', () => {
  const f = makeFreshnessFixture();
  try {
    const r = classify(f.kb);
    assert.equal(r.allFresh, true);
    assert.equal(r.syncable, false);
    assert.deepEqual(r.repositories.map((x) => x.repo), ['kb', 'multica', 'tools'], 'repo id 稳定排序');
    for (const fact of r.repositories) {
      assert.equal(fact.freshness, 'fresh');
      assert.equal(fact.workspaceClassification, 'healthy');
      assert.equal(fact.canFastForward, false);
      assert.equal(fact.headSha, fact.trunkSha);
      assert.equal(fact.branch, `requirement/${CR}`);
    }
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-01：ahead-only（分支有独有提交、trunk 未动）→ fresh，不误报 behind/diverged（AC-1）', () => {
  const f = makeFreshnessFixture();
  try {
    advanceBranch(f.kb, 'tools', 'ahead');
    const r = classify(f.kb);
    assert.equal(r.allFresh, true);
    assert.equal(repoFact(r, 'tools').freshness, 'fresh');
    assert.notEqual(repoFact(r, 'tools').headSha, repoFact(r, 'tools').trunkSha, 'HEAD 确实领先');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-01：trunk 前进 → behind-clean，canFastForward=true，syncable=true（AC-1）', () => {
  const f = makeFreshnessFixture();
  try {
    const newTrunk = advanceTrunk(f.base, 'tools', 'b1');
    const r = classify(f.kb);
    const fact = repoFact(r, 'tools');
    assert.equal(r.allFresh, false);
    assert.equal(r.syncable, true);
    assert.equal(fact.freshness, 'behind-clean');
    assert.equal(fact.canFastForward, true);
    assert.equal(fact.trunkSha, newTrunk, 'trunkSha 为 fetch 后捕获值');
    assert.equal(repoFact(r, 'kb').freshness, 'fresh', '未动仓保持 fresh');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-01：双方独有提交 → diverged，syncable=false（AC-1）', () => {
  const f = makeFreshnessFixture();
  try {
    advanceBranch(f.kb, 'multica', 'd1');
    advanceTrunk(f.base, 'multica', 'd2');
    const r = classify(f.kb);
    const fact = repoFact(r, 'multica');
    assert.equal(fact.freshness, 'diverged');
    assert.equal(fact.canFastForward, false);
    assert.equal(r.syncable, false, 'diverged 阻断 syncable');
    assert.equal(r.allFresh, false);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-01：非 healthy 基础分类透传 → unknown 且 reason=分类值（AC-1）', () => {
  const f = makeFreshnessFixture();
  try {
    // dirty：worktree 内未提交文件
    fs.writeFileSync(path.join(wtPath(f.kb, 'multica', CR), 'uncommitted.txt'), 'dirty\n');
    // branch-only：worktree 目录被删（本地分支仍在）
    fs.rmSync(wtPath(f.kb, 'tools', CR), { recursive: true, force: true });
    const r = classify(f.kb);
    const dirty = repoFact(r, 'multica');
    assert.equal(dirty.workspaceClassification, 'dirty');
    assert.equal(dirty.freshness, 'unknown');
    assert.equal(dirty.reason, 'dirty');
    const missing = repoFact(r, 'tools');
    assert.equal(missing.workspaceClassification, 'branch-only');
    assert.equal(missing.freshness, 'unknown');
    assert.equal(missing.reason, 'branch-only');
    assert.equal(r.syncable, false);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-01：wrong-branch → unknown 且 reason=wrong-branch（AC-1）', () => {
  const f = makeFreshnessFixture();
  try {
    git(wtPath(f.kb, 'tools', CR), ['checkout', '-q', '-b', 'not-the-cr-branch']);
    const r = classify(f.kb);
    const fact = repoFact(r, 'tools');
    assert.equal(fact.workspaceClassification, 'wrong-branch');
    assert.equal(fact.freshness, 'unknown');
    assert.equal(fact.reason, 'wrong-branch');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-01：origin/{trunk} 不可确认 → WORKSPACE_TRUNK_UNAVAILABLE 硬失败（AC-2）', () => {
  const f = makeFreshnessFixture();
  try {
    // 把 kb 的 trunk 指向不存在的 ref（fetch 成功但 rev-parse 失败）
    const dg = path.join(f.kb, 'dir-graph.yaml');
    fs.writeFileSync(dg, fs.readFileSync(dg, 'utf8').replace('trunk: master\n    role: knowledge-base', 'trunk: no/such-branch\n    role: knowledge-base'));
    assert.throws(() => classify(f.kb), (e) => e instanceof TxError && e.code === 'WORKSPACE_TRUNK_UNAVAILABLE');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-01：merge-base 退出码 >1 → TX_GIT_FAILED，不得降级为 diverged/unknown（AC-2）', () => {
  const f = makeFreshnessFixture();
  try {
    const wt = wtPath(f.kb, 'kb', CR);
    const head = git(wt, ['rev-parse', 'HEAD']);
    // 非法对象名使 git 以 128 退出（既非 0 也非 1）
    assert.throws(() => isAncestorOrThrow(wt, 'not-a-real-sha', head), (e) => e instanceof TxError && e.code === 'TX_GIT_FAILED');
    // 正常否定（构造 diverged 后互查非祖先方向）退出码 1 → false
    advanceBranch(f.kb, 'kb', 'neg');
    advanceTrunk(f.base, 'kb', 'neg');
    const r = classify(f.kb);
    assert.equal(repoFact(r, 'kb').freshness, 'diverged', 'status=1 走正常 diverged 路径');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

/* ────────────────────────── CLI：crctl workspace freshness ────────────────────────── */

const readAudit = (kb) => {
  const p = path.join(kb, '.crctl', 'audit.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
};

test('TASK-01 CLI：allFresh → exit 0 且不写 audit（AC-2）', () => {
  const f = makeFreshnessFixture();
  try {
    const r = runCrctl(['workspace', 'freshness', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.op, 'workspace-freshness');
    assert.equal(r.json.allFresh, true);
    assert.equal(readAudit(f.kb).filter((a) => a.kind === 'workspace-freshness').length, 0, '成功全 fresh 零 audit');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-01 CLI：behind-clean → exit 0、syncable=true、写一条业务阻断 audit（AC-2）', () => {
  const f = makeFreshnessFixture();
  try {
    advanceTrunk(f.base, 'tools', 'cli1');
    const r = runCrctl(['workspace', 'freshness', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.syncable, true);
    const audits = readAudit(f.kb).filter((a) => a.kind === 'workspace-freshness');
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].blocked, [{ repo: 'tools', freshness: 'behind-clean', reason: null }]);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-01 CLI：diverged 是可比较的正常结构化结果 → exit 0 + audit，由 Skill 路由 manual（AC-2）', () => {
  const f = makeFreshnessFixture();
  try {
    advanceBranch(f.kb, 'multica', 'cli2');
    advanceTrunk(f.base, 'multica', 'cli2');
    const r = runCrctl(['workspace', 'freshness', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r.status, 0, r.stderr);
    const fact = r.json.repositories.find((x) => x.repo === 'multica');
    assert.equal(fact.freshness, 'diverged');
    assert.equal(r.json.allFresh, false);
    assert.equal(r.json.syncable, false);
    const audits = readAudit(f.kb).filter((a) => a.kind === 'workspace-freshness');
    assert.equal(audits.length, 1, '业务阻断先 audit 再输出');
    assert.equal(audits[0].blocked[0].freshness, 'diverged');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-01 CLI：trunk 不可确认 → 非零退出、失败 audit 先写入（AC-2）', () => {
  const f = makeFreshnessFixture();
  try {
    const dg = path.join(f.kb, 'dir-graph.yaml');
    fs.writeFileSync(dg, fs.readFileSync(dg, 'utf8').replace('trunk: master\n    role: knowledge-base', 'trunk: no/such-branch\n    role: knowledge-base'));
    const r = runCrctl(['workspace', 'freshness', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.notEqual(r.status, 0);
    assert.equal(r.errJson.error.code, 'WORKSPACE_TRUNK_UNAVAILABLE');
    const audits = readAudit(f.kb).filter((a) => a.kind === 'workspace-freshness');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].error, 'WORKSPACE_TRUNK_UNAVAILABLE');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-01 CLI：额外 flag → BAD_ARGS（AC-2）', () => {
  const f = makeFreshnessFixture();
  try {
    const r = runCrctl(['workspace', 'freshness', CR, '--mode', 'resume', '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r.status, 1);
    assert.equal(r.errJson.error.code, 'BAD_ARGS');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

/* ────────────────────────── TASK-02：syncWorkspaceToTrunk 事务 ────────────────────────── */

const sync = (kb) => syncWorkspaceToTrunk(resolveRepositories(kb), { cr: CR });

function journals(kb, cr) {
  const base = path.join(kb, '.crctl', 'transactions', 'workspace', cr);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).sort().map((txId) => JSON.parse(fs.readFileSync(path.join(base, txId, 'journal.json'), 'utf8').replaceAll('\r\n', '\n')));
}

const headOf = (kb, repo) => git(wtPath(kb, repo, CR), ['rev-parse', 'HEAD']);

test('TASK-02：behind-clean ff-only 成功，afterSha==捕获 trunk SHA，journal complete（AC-1）', async () => {
  const f = makeFreshnessFixture();
  try {
    const newTrunk = advanceTrunk(f.base, 'tools', 's1');
    const r = await sync(f.kb);
    assert.equal(r.phase, 'complete');
    assert.equal(r.changed, true);
    assert.ok(r.txId);
    const rec = r.repositories.find((x) => x.repo === 'tools');
    assert.equal(rec.action, 'fast-forwarded');
    assert.equal(rec.afterSha, newTrunk);
    assert.equal(headOf(f.kb, 'tools'), newTrunk, 'worktree HEAD 已前移');
    assert.equal(r.repositories.find((x) => x.repo === 'kb').action, 'unchanged');
    const js = journals(f.kb, CR);
    assert.equal(js.length, 1);
    assert.equal(js[0].phase, 'complete');
    assert.match(r.recoverCommand, /workspace sync/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-02：全 fresh no-op → changed=false、txId=null、零 journal（AC-1/AC-2）', async () => {
  const f = makeFreshnessFixture();
  try {
    const r = await sync(f.kb);
    assert.equal(r.changed, false);
    assert.equal(r.txId, null);
    assert.equal(journals(f.kb, CR).length, 0, '全 fresh 不创建空 journal');
    assert.ok(r.repositories.every((x) => x.action === 'unchanged'));
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-02：dirty/diverged/unknown 阻断 → 零写入零 journal（AC-2）', async () => {
  const f = makeFreshnessFixture();
  try {
    fs.writeFileSync(path.join(wtPath(f.kb, 'tools', CR), 'uncommitted.txt'), 'dirty\n');
    await assert.rejects(() => sync(f.kb), (e) => e.code === 'WORKSPACE_SYNC_BLOCKED');
    assert.equal(journals(f.kb, CR).length, 0);
    fs.rmSync(path.join(wtPath(f.kb, 'tools', CR), 'uncommitted.txt'));
    advanceBranch(f.kb, 'tools', 'dv');
    advanceTrunk(f.base, 'tools', 'dv');
    const before = headOf(f.kb, 'tools');
    await assert.rejects(() => sync(f.kb), (e) => e.code === 'WORKSPACE_FRESHNESS_DIVERGED');
    assert.equal(headOf(f.kb, 'tools'), before, 'diverged 零写入');
    assert.equal(journals(f.kb, CR).length, 0, '阻断不创建 journal');
    // branch-only（unknown）：删 worktree 目录
    fs.rmSync(wtPath(f.kb, 'multica', CR), { recursive: true, force: true });
    await assert.rejects(() => sync(f.kb), (e) => e.code === 'WORKSPACE_SYNC_BLOCKED');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-02：ws-sync-after-repo 故障注入后续跑只使用 journal 原始 intent（AC-2）', async () => {
  const f = makeFreshnessFixture();
  try {
    const kbTarget = advanceTrunk(f.base, 'kb', 'f1');
    const toolsTarget = advanceTrunk(f.base, 'tools', 'f1');
    process.env.CRCTL_FAULT_POINT = 'ws-sync-after-repo';
    await assert.rejects(() => sync(f.kb), (e) => e.code === 'FAULT_INJECTED');
    delete process.env.CRCTL_FAULT_POINT;
    const mid = journals(f.kb, CR);
    assert.equal(mid.length, 1);
    assert.equal(mid[0].phase, 'syncing', '第一仓已落盘');
    const intentBefore = JSON.stringify(mid[0].workspace.repos.map((r) => [r.repo, r.beforeSha, r.targetTrunkSha]));
    const r = await sync(f.kb);
    assert.equal(r.phase, 'complete');
    const after = journals(f.kb, CR);
    assert.equal(after.length, 1, '续跑复用同一事务，不新建');
    assert.equal(JSON.stringify(after[0].workspace.repos.map((r) => [r.repo, r.beforeSha, r.targetTrunkSha])), intentBefore, '原始 intent 未被重算');
    assert.equal(headOf(f.kb, 'kb'), kbTarget);
    assert.equal(headOf(f.kb, 'tools'), toolsTarget);
    assert.ok(r.repositories.every((x) => ['fast-forwarded', 'unchanged'].includes(x.action)));
  } finally { delete process.env.CRCTL_FAULT_POINT; fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('代码评审 B1：单 pending 仓 crash-after-ff 重跑保持 changed=true，并重核已完成仓（回归）', async () => {
  const f = makeFreshnessFixture();
  try {
    const before = headOf(f.kb, 'tools');
    advanceTrunk(f.base, 'tools', 'b1-single');
    process.env.CRCTL_FAULT_POINT = 'ws-sync-after-repo';
    await assert.rejects(() => sync(f.kb), (e) => e.code === 'FAULT_INJECTED');
    delete process.env.CRCTL_FAULT_POINT;
    const resumed = await sync(f.kb);
    assert.equal(resumed.changed, true, '事务已执行 ff，重跑不得误报 changed=false');
    assert.equal(resumed.repositories.find((r) => r.repo === 'tools').action, 'fast-forwarded');
    // 新 fixture 验证 fast-forwarded 记录若被外部改写，恢复必须阻断而非 complete。
    const g = makeFreshnessFixture();
    try {
      const gBefore = headOf(g.kb, 'tools');
      advanceTrunk(g.base, 'tools', 'b1-drift');
      process.env.CRCTL_FAULT_POINT = 'ws-sync-after-repo';
      await assert.rejects(() => sync(g.kb), (e) => e.code === 'FAULT_INJECTED');
      delete process.env.CRCTL_FAULT_POINT;
      git(wtPath(g.kb, 'tools', CR), ['reset', '--hard', '-q', gBefore]); // 测试专用：模拟外部改写已 ff 仓
      await assert.rejects(() => sync(g.kb), (e) => e.code === 'WORKSPACE_FRESHNESS_CHANGED');
      assert.ok(journals(g.kb, CR).every((j) => j.phase !== 'complete'));
    } finally { delete process.env.CRCTL_FAULT_POINT; fs.rmSync(g.base, { recursive: true, force: true }); }
    assert.notEqual(before, headOf(f.kb, 'tools'));
  } finally { delete process.env.CRCTL_FAULT_POINT; fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('代码评审 B2：intentDigest 绑定全仓；在途 unchanged 仓 HEAD 漂移硬阻断（回归）', async () => {
  const f = makeFreshnessFixture();
  try {
    advanceTrunk(f.base, 'tools', 'b2'); // tools pending，kb/multica unchanged
    process.env.CRCTL_FAULT_POINT = 'ws-sync-after-preflight';
    await assert.rejects(() => sync(f.kb), (e) => e.code === 'FAULT_INJECTED');
    delete process.env.CRCTL_FAULT_POINT;
    const j = journals(f.kb, CR)[0];
    const repos = j.workspace.repos.map((r) => ({ repo: r.repo, beforeSha: r.beforeSha, targetTrunkSha: r.targetTrunkSha }));
    const expected = crypto.createHash('sha256').update(JSON.stringify({ graphDigest: j.graphDigest, cr: CR, repos }), 'utf8').digest('hex');
    assert.equal(j.inputDigest, expected, 'digest 覆盖全部 3 仓，不只 pending 仓');
    advanceBranch(f.kb, 'kb', 'b2-drift'); // preflight 时 unchanged 的仓发生漂移
    await assert.rejects(() => sync(f.kb), (e) => e.code === 'WORKSPACE_FRESHNESS_CHANGED');
    assert.notEqual(headOf(f.kb, 'tools'), j.workspace.repos.find((r) => r.repo === 'tools').targetTrunkSha, '后续 pending 仓零写入');
  } finally { delete process.env.CRCTL_FAULT_POINT; fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('代码评审 B3：ff-only 执行失败精确映射 WORKSPACE_SYNC_CONFLICT（回归）', async () => {
  const f = makeFreshnessFixture();
  try {
    advanceTrunk(f.base, 'tools', 'b3');
    const wt = wtPath(f.kb, 'tools', CR);
    const rawIndex = git(wt, ['rev-parse', '--git-path', 'index']);
    const indexPath = path.isAbsolute(rawIndex) ? rawIndex : path.resolve(wt, rawIndex);
    const lockPath = `${indexPath}.lock`;
    fs.writeFileSync(lockPath, 'force merge index lock failure\n');
    try {
      await assert.rejects(() => sync(f.kb), (e) => e.code === 'WORKSPACE_SYNC_CONFLICT' && e.extra.repo === 'tools');
    } finally { fs.rmSync(lockPath, { force: true }); }
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('代码评审 B4：status --porcelain 技术失败不得被误判 clean/fresh（回归）', () => {
  const f = makeFreshnessFixture();
  try {
    const wt = wtPath(f.kb, 'kb', CR);
    const rawIndex = git(wt, ['rev-parse', '--git-path', 'index']);
    const indexPath = path.isAbsolute(rawIndex) ? rawIndex : path.resolve(wt, rawIndex);
    fs.writeFileSync(indexPath, 'corrupt index\n');
    assert.throws(() => classify(f.kb), (e) => e instanceof TxError && e.code === 'TX_GIT_FAILED');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-02：latest complete 后 trunk 再前进 → 新事务（createAfterComplete），旧 journal 保留（AC-2）', async () => {
  const f = makeFreshnessFixture();
  try {
    advanceTrunk(f.base, 'tools', 'n1');
    const first = await sync(f.kb);
    const second = advanceTrunk(f.base, 'tools', 'n2');
    const r = await sync(f.kb);
    assert.equal(r.changed, true);
    assert.notEqual(r.txId, first.txId);
    assert.equal(headOf(f.kb, 'tools'), second);
    const js = journals(f.kb, CR);
    assert.equal(js.length, 2, '旧 complete journal 不删除');
    assert.ok(js.every((j) => j.phase === 'complete'));
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-02：外部回退到旧 beforeSha → WORKSPACE_FRESHNESS_CHANGED（不复用旧 complete）（AC-2）', async () => {
  const f = makeFreshnessFixture();
  try {
    const beforeSha = headOf(f.kb, 'kb');
    advanceTrunk(f.base, 'kb', 'rb');
    await sync(f.kb);
    git(wtPath(f.kb, 'kb', CR), ['reset', '--hard', '-q', beforeSha]); // 测试专用：模拟外部回退
    await assert.rejects(() => sync(f.kb), (e) => e.code === 'WORKSPACE_FRESHNESS_CHANGED');
    assert.equal(headOf(f.kb, 'kb'), beforeSha, '阻断零写入');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-02：在途事务期间 trunk 漂移 → 恢复时 WORKSPACE_FRESHNESS_CHANGED（AC-2）', async () => {
  const f = makeFreshnessFixture();
  try {
    advanceTrunk(f.base, 'kb', 'dr1');
    process.env.CRCTL_FAULT_POINT = 'ws-sync-after-preflight';
    await assert.rejects(() => sync(f.kb), (e) => e.code === 'FAULT_INJECTED');
    delete process.env.CRCTL_FAULT_POINT;
    advanceTrunk(f.base, 'kb', 'dr2'); // trunk 在 preflight 后前进
    await assert.rejects(() => sync(f.kb), (e) => e.code === 'WORKSPACE_FRESHNESS_CHANGED');
    assert.ok(journals(f.kb, CR).every((j) => j.phase !== 'complete'));
  } finally { delete process.env.CRCTL_FAULT_POINT; fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-02：在途事务期间 HEAD 漂移（分支新增提交）→ WORKSPACE_FRESHNESS_CHANGED（AC-2）', async () => {
  const f = makeFreshnessFixture();
  try {
    advanceTrunk(f.base, 'kb', 'hd1');
    process.env.CRCTL_FAULT_POINT = 'ws-sync-after-preflight';
    await assert.rejects(() => sync(f.kb), (e) => e.code === 'FAULT_INJECTED');
    delete process.env.CRCTL_FAULT_POINT;
    advanceBranch(f.kb, 'kb', 'hd2');
    await assert.rejects(() => sync(f.kb), (e) => e.code === 'WORKSPACE_FRESHNESS_CHANGED');
  } finally { delete process.env.CRCTL_FAULT_POINT; fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-02：并发锁 → TX_LOCK_HELD（AC-2）', async () => {
  const f = makeFreshnessFixture();
  try {
    advanceTrunk(f.base, 'tools', 'lk');
    const lock = await acquireLock({ root: f.kb, scope: `workspace-sync-${CR}`, op: 'workspace', cr: CR });
    try {
      const r = runCrctl(['workspace', 'sync', CR, '--workspace', f.kb], { cwd: f.kb });
      assert.notEqual(r.status, 0);
      assert.equal(r.errJson.error.code, 'TX_LOCK_HELD');
    } finally { await lock.release(); }
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-02：重跑幂等不重复提交（AC-2）', async () => {
  const f = makeFreshnessFixture();
  try {
    advanceTrunk(f.base, 'tools', 'idem');
    const first = await sync(f.kb);
    assert.equal(first.changed, true);
    const headAfter = headOf(f.kb, 'tools');
    const second = await sync(f.kb);
    assert.equal(second.changed, false);
    assert.equal(second.txId, null);
    assert.equal(headOf(f.kb, 'tools'), headAfter, 'HEAD 不再移动');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

/* ────────────────────────── TASK-05：双 gate 集成场景（真实 Git fixture，CLI 端到端） ──────────────────────────
 * replay 节点序列断言在 pipeline-structure.test.mjs（契约层）；此处验证 gate 决策链的事实演化。 */

test('TASK-05 集成：implement gate——behind-clean → sync → 重核 allFresh → 允许进入实施（AC-2）', () => {
  const f = makeFreshnessFixture();
  try {
    advanceTrunk(f.base, 'tools', 'ig1');
    const fr1 = runCrctl(['workspace', 'freshness', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(fr1.status, 0, fr1.stderr);
    assert.equal(fr1.json.syncable, true, 'gate 拦截到可同步事实');
    const sy = runCrctl(['workspace', 'sync', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(sy.status, 0, sy.stderr);
    assert.equal(sy.json.changed, true);
    const fr2 = runCrctl(['workspace', 'freshness', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(fr2.status, 0);
    assert.equal(fr2.json.allFresh, true, '同步后重核全 fresh，可进入 implement-code');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-05 集成：implement gate——diverged → abort 且零写入（AC-2）', () => {
  const f = makeFreshnessFixture();
  try {
    advanceBranch(f.kb, 'tools', 'ig2');
    advanceTrunk(f.base, 'tools', 'ig2');
    const before = headOf(f.kb, 'tools');
    const fr = runCrctl(['workspace', 'freshness', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(fr.status, 0);
    assert.equal(fr.json.syncable, false, 'diverged 不可同步，gate 应 abort');
    const sy = runCrctl(['workspace', 'sync', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.notEqual(sy.status, 0);
    assert.equal(sy.errJson.error.code, 'WORKSPACE_FRESHNESS_DIVERGED');
    assert.equal(headOf(f.kb, 'tools'), before, '零自动写入');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-05 集成：review gate 可同步轨——分支无独有提交且 trunk 前进 → sync 后重核 allFresh（AC-2）', () => {
  const f = makeFreshnessFixture();
  try {
    advanceTrunk(f.base, 'multica', 'rg1');
    const fr = runCrctl(['workspace', 'freshness', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(fr.status, 0);
    assert.equal(fr.json.syncable, true);
    const sy = runCrctl(['workspace', 'sync', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(sy.status, 0, sy.stderr);
    const fr2 = runCrctl(['workspace', 'freshness', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(fr2.json.allFresh, true, '同步后可按 replayNodes 重建证据再评审');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-05 集成：review gate 人工轨——实施后独有提交 + trunk 前进 → diverged/manual 零自动写入；人工恢复后重入（AC-2）', () => {
  const f = makeFreshnessFixture();
  try {
    advanceBranch(f.kb, 'tools', 'rg2');          // 实施期 CR 独有提交
    const newTrunk = advanceTrunk(f.base, 'tools', 'rg2'); // trunk 前进 → diverged
    const before = headOf(f.kb, 'tools');
    const fr = runCrctl(['workspace', 'freshness', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(fr.json.repositories.find((r) => r.repo === 'tools').freshness, 'diverged');
    const sy = runCrctl(['workspace', 'sync', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(sy.errJson.error.code, 'WORKSPACE_FRESHNESS_DIVERGED');
    assert.equal(headOf(f.kb, 'tools'), before, '无自动 merge/rebase/盲目重试');
    // 人工处理：把分支事实恢复为可比较状态（此处模拟人工重基底）后重入 gate
    git(wtPath(f.kb, 'tools', CR), ['reset', '--hard', '-q', newTrunk]);
    const fr2 = runCrctl(['workspace', 'freshness', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(fr2.status, 0);
    assert.equal(fr2.json.repositories.find((r) => r.repo === 'tools').freshness, 'fresh', '人工恢复后重新可比较');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-02 CLI：成功与失败均在输出前写 workspace-sync audit（AC-3）', () => {
  const f = makeFreshnessFixture();
  try {
    advanceTrunk(f.base, 'tools', 'au1');
    const good = runCrctl(['workspace', 'sync', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(good.status, 0, good.stderr);
    let audits = readAudit(f.kb).filter((a) => a.kind === 'workspace-sync');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].changed, true);
    assert.equal(audits[0].repos.find((r) => r.repo === 'tools').action, 'fast-forwarded');
    // 失败路径：dirty 阻断
    fs.writeFileSync(path.join(wtPath(f.kb, 'tools', CR), 'uncommitted.txt'), 'dirty\n');
    advanceTrunk(f.base, 'tools', 'au2'); // 制造 behind-clean 使 syncable，但 dirty 阻断
    const bad = runCrctl(['workspace', 'sync', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.notEqual(bad.status, 0);
    assert.equal(bad.errJson.error.code, 'WORKSPACE_SYNC_BLOCKED');
    audits = readAudit(f.kb).filter((a) => a.kind === 'workspace-sync');
    assert.equal(audits.length, 2);
    assert.equal(audits[1].error, 'WORKSPACE_SYNC_BLOCKED');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

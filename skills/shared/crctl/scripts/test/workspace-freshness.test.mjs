// CR-2026-043 TASK-01/02：workspace freshness 分类与 ff-only 同步事务测试。
// 复用 merge-fixture（三 bare origin + 三仓 dir-graph）；真实 Git，无 mock。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { git, runCrctl, makeFixture } from './merge-fixture.mjs';
import { TxError, resolveRepositories, classifyWorkspaceFreshness, isAncestorOrThrow } from '../lib/workspace-transactions.mjs';

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

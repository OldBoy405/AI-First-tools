// CR-2026-057 TASK-04：crctl version-set 集成测试。
// 覆盖：正向全链同步（AC-13/AC-15）、幂等短路、负向四错误码零写入、允许状态抽样与终态拒绝、
// 中断重试闭环（B-SDD-005：允许状态校验 → 恢复 → tracked-clean → 漂移检查）、禁止状态零恢复、
// 键隔离（外部 dirty 不被恢复）。零依赖，node:test/node:assert。
// 运行：node --test skills/shared/crctl/scripts/test/version-set.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixture, git, runCrctl, sha256, originMasterCount } from './merge-fixture.mjs';

const YEAR = String(new Date().getFullYear());

const kbWt = (kb, cr) => path.join(kb, '.rayai-worktrees', 'knowledge-base', 'requirement', cr);
const crDirIn = (ws, cr) => path.join(ws, 'change-requests', cr);

function registerUnassigned(kb) {
  const r = runCrctl(['register', '--registration-key', 'key-abc-123', '--title', 'VersionSetTest',
    '--owner-requirement', 'Ray', '--owner-development', 'Ray', '--owner-test', 'Ray',
    '--target-version', 'unassigned', '--workspace', kb], { cwd: kb });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.targetVersion, 'unassigned');
  return r.json.cr;
}

/** 在 KB CR worktree 落 prd/sdd/plan/TASK-01/TASK-02（frontmatter target-version: unassigned）并 commit。 */
function addDerived(kb, cr) {
  const wt = kbWt(kb, cr);
  const dir = crDirIn(wt, cr);
  const fm = (extra) => `---\nid: derived\n${extra}\n---\n# body\n`;
  fs.writeFileSync(path.join(dir, 'prd.md'), fm('target-version: unassigned'));
  fs.writeFileSync(path.join(dir, 'sdd.md'), fm('target-version: unassigned'));
  fs.writeFileSync(path.join(dir, 'plan.md'), fm('target-version: unassigned'));
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks', 'TASK-01.md'), fm('target-version: unassigned'));
  fs.writeFileSync(path.join(dir, 'tasks', 'TASK-02.md'), fm('target-version: unassigned'));
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-q', '-m', 'add derived docs']);
}

const SIX_CLASSES = ['cr.md', '_backlog.yml', 'prd.md', 'sdd.md', 'plan.md', 'tasks/TASK-01.md', 'tasks/TASK-02.md'];

function readVersionOf(kb, cr, rel) {
  const wt = kbWt(kb, cr);
  if (rel === '_backlog.yml') {
    const text = fs.readFileSync(path.join(wt, 'change-requests', '_backlog.yml'), 'utf8').replaceAll('\r\n', '\n');
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^- id:/.test(l) && l.includes(cr));
    for (let i = start + 1; i < lines.length; i++) {
      if (/^- id:/.test(lines[i])) break;
      const m = /^[ \t]*target-version:\s*(.+)$/.exec(lines[i]);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
    return null;
  }
  const text = fs.readFileSync(path.join(wt, 'change-requests', cr, rel), 'utf8').replaceAll('\r\n', '\n');
  const m = /^target-version:\s*(.+)$/m.exec(text.split('---\n')[1] || '');
  return m ? m[1].replace(/^["']|["']$/g, '').trim() : null;
}

function branchCommitCount(kb, cr) {
  const wt = kbWt(kb, cr);
  return Number(git(wt, ['rev-list', '--count', 'HEAD']));
}

function versionSetCommits(kb, cr) {
  const wt = kbWt(kb, cr);
  return (git(wt, ['log', '--format=%s']).match(/^\[cr\] version-set/g) || []).length;
}

test('CR-2026-057 FR-15/AC-15：正向全链同步——六类文件全等 to.value、JSON from/to/files、不改 status', () => {
  const { base, kb } = makeFixture();
  try {
    const cr = registerUnassigned(kb);
    addDerived(kb, cr);
    const beforeCount = branchCommitCount(kb, cr);
    const r = runCrctl(['version-set', cr, '--to', '0.30', '--workspace', kbWt(kb, cr)], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.op, 'version-set');
    assert.equal(r.json.cr, cr);
    assert.equal(r.json.from, 'unassigned');
    assert.equal(r.json.to, '0.30');
    assert.equal(r.json.changed, true);
    assert.ok(Array.isArray(r.json.files) && r.json.files.length >= 6, `files 应覆盖六类文件: ${JSON.stringify(r.json.files)}`);
    for (const rel of SIX_CLASSES) assert.equal(readVersionOf(kb, cr, rel), '0.30', `${rel} 必须同步为 0.30`);
    assert.equal(branchCommitCount(kb, cr), beforeCount + 1, '恰一个新 commit');
    assert.equal(versionSetCommits(kb, cr), 1);
    const headMsg = git(kbWt(kb, cr), ['log', '-1', '--format=%B']);
    assert.match(headMsg, new RegExp(`^\\[cr\\] version-set ${cr} unassigned -> 0\\.30`));
    assert.match(headMsg, /AI-First-Tx: [0-9a-f]{32}/);
    const md = fs.readFileSync(crDirIn(kbWt(kb, cr), cr) + path.sep + 'cr.md', 'utf8');
    assert.match(md, /^status: drafting$/m, 'version-set 不改变 CR status');
    assert.ok(!fs.existsSync(path.join(crDirIn(kbWt(kb, cr), cr), 'approval.yml')), '不写 approval.yml');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-057 FR-15/AC-15：幂等重跑 changed=false 零新 commit', () => {
  const { base, kb } = makeFixture();
  try {
    const cr = registerUnassigned(kb);
    addDerived(kb, cr);
    const first = runCrctl(['version-set', cr, '--to', '0.30', '--workspace', kbWt(kb, cr)], { cwd: kb });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.json.changed, true);
    const before = branchCommitCount(kb, cr);
    const second = runCrctl(['version-set', cr, '--to', '0.30', '--workspace', kbWt(kb, cr)], { cwd: kb });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.changed, false);
    assert.deepEqual(second.json.files, []);
    assert.equal(branchCommitCount(kb, cr), before, '幂等重跑零新 commit');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-057 FR-15/AC-15：负向——非法 --to（unassigned/畸形/缺值）→ VERSION_SET_INVALID/BAD_ARGS 零写入', () => {
  for (const [args, code] of [
    [['--to', 'unassigned'], 'VERSION_SET_INVALID'],
    [['--to', '0.30.0.1'], 'VERSION_SET_INVALID'],
    [['--to', 'tbd'], 'VERSION_SET_INVALID'],
    [['--to', ''], 'VERSION_SET_INVALID'],
    [[], 'BAD_ARGS'],
  ]) {
    const { base, kb } = makeFixture();
    try {
      const cr = registerUnassigned(kb);
      addDerived(kb, cr);
      const before = branchCommitCount(kb, cr);
      const r = runCrctl(['version-set', cr, ...args, '--workspace', kbWt(kb, cr)], { cwd: kb });
      assert.notEqual(r.status, 0, `应拒绝 ${JSON.stringify(args)}`);
      assert.equal(r.errJson.error.code, code, `${JSON.stringify(args)}: ${r.stderr}`);
      assert.equal(branchCommitCount(kb, cr), before, '失败必须零 commit');
      for (const rel of SIX_CLASSES) assert.equal(readVersionOf(kb, cr, rel), 'unassigned', `${rel} 必须保持 unassigned`);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

test('CR-2026-057 FR-15/AC-15：负向——merging 与终态 → VERSION_SET_STATE_INVALID 零写入', () => {
  for (const status of ['merging', 'rejected']) {
    const { base, kb } = makeFixture();
    try {
      const cr = registerUnassigned(kb);
      addDerived(kb, cr);
      const wt = kbWt(kb, cr);
      const md = crDirIn(wt, cr) + path.sep + 'cr.md';
      fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace(/^status: drafting$/m, `status: ${status}`));
      git(wt, ['add', '-A']);
      git(wt, ['commit', '-q', '-m', `status -> ${status}`]);
      const before = branchCommitCount(kb, cr);
      const r = runCrctl(['version-set', cr, '--to', '0.30', '--workspace', wt], { cwd: kb });
      assert.notEqual(r.status, 0);
      assert.equal(r.errJson.error.code, 'VERSION_SET_STATE_INVALID', `status=${status}: ${r.stderr}`);
      assert.equal(branchCommitCount(kb, cr), before, '失败必须零 commit');
      assert.equal(readVersionOf(kb, cr, 'cr.md'), 'unassigned');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

test('CR-2026-057 FR-15/AC-15：负向——派生产物漂移（cr.md 手改真实版本而 PRD 仍 unassigned）→ VERSION_SET_DERIVED_DRIFT 零写入', () => {
  const { base, kb } = makeFixture();
  try {
    const cr = registerUnassigned(kb);
    addDerived(kb, cr);
    const wt = kbWt(kb, cr);
    const md = crDirIn(wt, cr) + path.sep + 'cr.md';
    fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace(/^target-version: unassigned$/m, 'target-version: 0.30'));
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-q', '-m', 'hand-edit cr.md version']);
    const before = branchCommitCount(kb, cr);
    const r = runCrctl(['version-set', cr, '--to', '0.40', '--workspace', wt], { cwd: kb });
    assert.notEqual(r.status, 0);
    assert.equal(r.errJson.error.code, 'VERSION_SET_DERIVED_DRIFT', r.stderr);
    assert.equal(branchCommitCount(kb, cr), before, '失败必须零 commit');
    assert.equal(readVersionOf(kb, cr, 'prd.md'), 'unassigned', 'PRD 保持原样（零写入）');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-057 FR-15/AC-15：负向——backlog 条目缺 target-version → VERSION_SET_DERIVED_DRIFT 零写入', () => {
  const { base, kb } = makeFixture();
  try {
    const cr = registerUnassigned(kb);
    addDerived(kb, cr);
    const wt = kbWt(kb, cr);
    const bp = path.join(wt, 'change-requests', '_backlog.yml');
    fs.writeFileSync(bp, fs.readFileSync(bp, 'utf8').replace(/^[ \t]*target-version:.*\r?\n?/m, ''));
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-q', '-m', 'drop backlog target-version']);
    const before = branchCommitCount(kb, cr);
    const r = runCrctl(['version-set', cr, '--to', '0.30', '--workspace', wt], { cwd: kb });
    assert.notEqual(r.status, 0);
    assert.equal(r.errJson.error.code, 'VERSION_SET_DERIVED_DRIFT', r.stderr);
    assert.equal(branchCommitCount(kb, cr), before, '失败必须零 commit');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-057 FR-15/B-SDD-005：中断重试闭环——tx-apply-between-rename 中断后重跑，恰 1 commit、全程无 WORKTREE_DIRTY/DERIVED_DRIFT', () => {
  const { base, kb } = makeFixture();
  try {
    const cr = registerUnassigned(kb);
    addDerived(kb, cr);
    const wt = kbWt(kb, cr);
    const r1 = runCrctl(['version-set', cr, '--to', '0.30', '--workspace', wt], { cwd: kb, env: { CRCTL_FAULT_POINT: 'tx-apply-between-rename' } });
    assert.notEqual(r1.status, 0);
    assert.equal(r1.errJson.error.code, 'FAULT_INJECTED');
    // 残留：ledger journal 存在（未收敛事务）
    const ledgerDir = path.join(kb, '.crctl', 'transactions', 'ledger');
    assert.ok(fs.existsSync(ledgerDir), '中断必须留下 ledger journal 残留');
    // 无注入重跑：可恢复优先路径先回滚 → 新事务成功
    const r2 = runCrctl(['version-set', cr, '--to', '0.30', '--workspace', wt], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.changed, true);
    assert.equal(r2.json.from, 'unassigned');
    assert.equal(r2.json.to, '0.30');
    assert.equal(versionSetCommits(kb, cr), 1, '重跑全程恰 1 个 version-set commit');
    for (const rel of SIX_CLASSES) assert.equal(readVersionOf(kb, cr, rel), '0.30', `${rel} 必须同步为 0.30`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-057 FR-15/B-SDD-005：ledger-after-commit 中断 → 重跑按 head+trailer 识别已提交 → changed=false 零新 commit', () => {
  const { base, kb } = makeFixture();
  try {
    const cr = registerUnassigned(kb);
    addDerived(kb, cr);
    const wt = kbWt(kb, cr);
    const r1 = runCrctl(['version-set', cr, '--to', '0.30', '--workspace', wt], { cwd: kb, env: { CRCTL_FAULT_POINT: 'ledger-after-commit' } });
    assert.notEqual(r1.status, 0);
    assert.equal(r1.errJson.error.code, 'FAULT_INJECTED');
    assert.equal(versionSetCommits(kb, cr), 1, 'commit 已落盘');
    const r2 = runCrctl(['version-set', cr, '--to', '0.30', '--workspace', wt], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.changed, false, '按 head+AI-First-Tx trailer 识别已提交 → 幂等');
    assert.equal(versionSetCommits(kb, cr), 1, '零新 commit');
    for (const rel of SIX_CLASSES) assert.equal(readVersionOf(kb, cr, rel), '0.30', `${rel} 已等于 to.value`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-057 FR-15/B-SDD-005：禁止状态零恢复——merging 夹具预置 version/{cr} 残留 → STATE_INVALID 且 journal 原样保留', () => {
  const { base, kb } = makeFixture();
  try {
    const cr = registerUnassigned(kb);
    addDerived(kb, cr);
    const wt = kbWt(kb, cr);
    // 先制造残留：fault 中断一次（journal 留下未收敛事务）
    const r0 = runCrctl(['version-set', cr, '--to', '0.30', '--workspace', wt], { cwd: kb, env: { CRCTL_FAULT_POINT: 'tx-apply-between-rename' } });
    assert.equal(r0.errJson.error.code, 'FAULT_INJECTED');
    const ledgerDir = path.join(kb, '.crctl', 'transactions', 'ledger');
    const residueBefore = fs.readdirSync(ledgerDir, { recursive: true }).sort();
    assert.ok(residueBefore.length > 0, '前置：必须存在 version ledger 残留');
    // 清掉 fault 留下的部分写集（保留 journal 残留），再转 merging
    git(wt, ['reset', '--hard', 'HEAD']);
    const md = crDirIn(wt, cr) + path.sep + 'cr.md';
    fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace(/^status: drafting$/m, 'status: merging'));
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-q', '-m', 'status -> merging']);
    const before = branchCommitCount(kb, cr);
    const r1 = runCrctl(['version-set', cr, '--to', '0.40', '--workspace', wt], { cwd: kb });
    assert.notEqual(r1.status, 0);
    assert.equal(r1.errJson.error.code, 'VERSION_SET_STATE_INVALID', r1.stderr);
    assert.deepEqual(fs.readdirSync(ledgerDir, { recursive: true }).sort(), residueBefore, '禁止状态必须零恢复：journal 原样保留');
    assert.equal(branchCommitCount(kb, cr), before, '禁止状态零 commit');
    assert.equal(readVersionOf(kb, cr, 'cr.md'), 'unassigned', '禁止状态零写入');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-057 FR-15/B-SDD-005：键隔离——无残留但外部 tracked 变更 → VERSION_SET_WORKTREE_DIRTY 且不被恢复', () => {
  const { base, kb } = makeFixture();
  try {
    const cr = registerUnassigned(kb);
    addDerived(kb, cr);
    const wt = kbWt(kb, cr);
    // 外部 tracked 变更：先 commit 一个外部文件，再修改它（tracked dirty）
    fs.writeFileSync(path.join(wt, 'external.txt'), 'external v1\n');
    git(wt, ['add', 'external.txt']);
    git(wt, ['commit', '-q', '-m', 'add external file']);
    fs.writeFileSync(path.join(wt, 'external.txt'), 'external dirty v2\n');
    const r = runCrctl(['version-set', cr, '--to', '0.30', '--workspace', wt], { cwd: kb });
    assert.notEqual(r.status, 0);
    assert.equal(r.errJson.error.code, 'VERSION_SET_WORKTREE_DIRTY', r.stderr);
    assert.equal(fs.readFileSync(path.join(wt, 'external.txt'), 'utf8'), 'external dirty v2\n', '外部 dirty 必须保留（不被恢复）');
    for (const rel of SIX_CLASSES) assert.equal(readVersionOf(kb, cr, rel), 'unassigned', `${rel} 零写入`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-057 FR-15/AC-15：允许状态抽样——developing / code-approved 正向成功', () => {
  for (const status of ['developing', 'code-approved']) {
    const { base, kb } = makeFixture();
    try {
      const cr = registerUnassigned(kb);
      addDerived(kb, cr);
      const wt = kbWt(kb, cr);
      const md = crDirIn(wt, cr) + path.sep + 'cr.md';
      fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace(/^status: drafting$/m, `status: ${status}`));
      git(wt, ['add', '-A']);
      git(wt, ['commit', '-q', '-m', `status -> ${status}`]);
      const r = runCrctl(['version-set', cr, '--to', '0.30', '--workspace', wt], { cwd: kb });
      assert.equal(r.status, 0, `status=${status}: ${r.stderr}`);
      assert.equal(r.json.changed, true);
      assert.equal(readVersionOf(kb, cr, 'cr.md'), '0.30');
      const mdAfter = fs.readFileSync(md, 'utf8');
      assert.match(mdAfter, new RegExp(`^status: ${status}$`, 'm'), 'version-set 不改变 status');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

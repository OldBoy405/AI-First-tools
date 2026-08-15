// CR-2026-031 TASK-03：repository resolver / canonical path / phase authority 单元测试。
// 直接 import lib 模块（TASK-03 无 CLI 面；CLI 接线自 TASK-05 起随业务事务进入）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  resolveRepositories, getRepository, resolveOperationalWorkspace, txWorkspacePath, TxError,
} from '../lib/workspace-transactions.mjs';

function makeRepoGraphFixture(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'crctl-resolver-'));
  const ws = path.join(base, 'ws');
  fs.mkdirSync(path.join(ws, 'change-requests'), { recursive: true });
  fs.mkdirSync(path.join(base, 'multica'));
  fs.mkdirSync(path.join(base, 'tools'));
  const repos = opts.repos || [
    '  - id: ai-first-platform-docs\n    path: "."\n    trunk: master\n    role: knowledge-base',
    '  - id: multica\n    path: "../multica"\n    trunk: main\n    role: code',
    '  - id: tools\n    path: "../tools"\n    trunk: custom/main\n    role: code',
  ];
  fs.writeFileSync(path.join(ws, 'dir-graph.yaml'),
    `schema: "ai-first.tools.dir-graph/v1"\nworkspace:\n  root: "."\nrepositories:\n${repos.join('\n')}\n`);
  return { base, ws };
}

function writeCrMdStatus(root, cr, status) {
  const dir = path.join(root, 'change-requests', cr);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cr.md'), `---\nid: ${cr}\nstatus: ${status}\n---\n`);
}

const expectTxError = (fn, code) => {
  try { fn(); } catch (e) {
    assert.ok(e instanceof TxError, `应为 TxError，实际 ${e && e.constructor && e.constructor.name}: ${e}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`期望 ${code}，但没有抛错`);
};

test('TASK-03：三仓 fixture 返回稳定排序 repo map、graphDigest、canonical path（AC-2）', () => {
  const { base, ws } = makeRepoGraphFixture();
  try {
    const a = resolveRepositories(ws);
    const b = resolveRepositories(ws);
    assert.deepEqual(a.repositories.map((r) => r.id), ['ai-first-platform-docs', 'multica', 'tools'], '按 id 排序');
    assert.equal(a.graphDigest, b.graphDigest, 'graphDigest 稳定');
    assert.match(a.graphDigest, /^[0-9a-f]{64}$/);
    assert.equal(a.knowledgeBaseRepoId, 'ai-first-platform-docs');
    const kb = a.repositories[0];
    assert.equal(kb.bucket, 'knowledge-base', 'knowledge-base role → knowledge-base bucket');
    assert.equal(kb.rootPath, fs.realpathSync(ws), 'canonical rootPath');
    assert.equal(a.repositories[1].bucket, 'multica', '非 kb role → repo.id bucket');
    assert.equal(a.repositories[2].trunk, 'custom/main');
    for (const r of a.repositories) {
      assert.equal(r.worktreePath, path.join(a.installRoot, '.rayai-worktrees', r.bucket, 'requirement'));
    }
    assert.equal(a.cr, null);
    assert.equal(a.branch, null);
    assert.equal(a.installRoot, ws, '非 git fixture 回退 opWs');
    assert.ok(!fs.existsSync(path.join(base, '.rayai-worktrees')), 'resolver 零副作用：不创建目录');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-03：workspace 位于 CR worktree 内时以主 checkout 为 InstWS 并反解 cr/branch', () => {
  const { base, ws } = makeRepoGraphFixture();
  try {
    // 真实 linked worktree：deriveInstallRoot 靠 git common-dir 回到主 checkout
    const sh = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
    sh(['init', '-q', '-b', 'master'], ws);
    sh(['config', 'user.email', 'test@aifirst.dev'], ws);
    sh(['config', 'user.name', 'Test'], ws);
    sh(['commit', '-q', '--allow-empty', '-m', 'init'], ws);
    const crWs = path.join(ws, '.rayai-worktrees', 'knowledge-base', 'requirement', 'CR-2026-999');
    fs.mkdirSync(path.dirname(crWs), { recursive: true });
    sh(['worktree', 'add', '-q', '-b', 'requirement/CR-2026-999', crWs], ws);
    const ctx = resolveRepositories(crWs);
    const installStat = fs.statSync(ctx.installRoot);
    const mainStat = fs.statSync(ws);
    assert.equal(installStat.dev, mainStat.dev, 'InstWS 与主 checkout 位于同一文件系统');
    assert.equal(installStat.ino, mainStat.ino, 'InstWS = 主 checkout，不是 linked worktree');
    assert.equal(ctx.cr, 'CR-2026-999');
    assert.equal(ctx.branch, 'requirement/CR-2026-999');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-03：未知 repo / inactive repo 精确错误（AC-1）', () => {
  const { base, ws } = makeRepoGraphFixture({
    repos: [
      '  - id: ai-first-platform-docs\n    path: "."\n    trunk: master\n    role: knowledge-base',
      '  - id: multica\n    path: "../multica"\n    trunk: main\n    role: code\n    active: false',
      '  - id: tools\n    path: "../tools"\n    trunk: custom/main\n    role: code',
    ],
  });
  try {
    const ctx = resolveRepositories(ws);
    assert.deepEqual(ctx.repositories.map((r) => r.id), ['ai-first-platform-docs', 'tools'], 'inactive 不进 map');
    assert.ok(getRepository(ctx, 'tools'));
    expectTxError(() => getRepository(ctx, 'multica-renamed'), 'REPO_NOT_FOUND');
    expectTxError(() => getRepository(ctx, 'multica'), 'REPO_INACTIVE');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-03：声明非法 → REPO_GRAPH_INVALID / REPO_GRAPH_NOT_FOUND（AC-1）', () => {
  // 缺 trunk
  let f = makeRepoGraphFixture({ repos: ['  - id: ai-first-platform-docs\n    path: "."\n    role: knowledge-base'] });
  try { expectTxError(() => resolveRepositories(f.ws), 'REPO_GRAPH_INVALID'); }
  finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  // absolute path
  f = makeRepoGraphFixture({ repos: [
    '  - id: ai-first-platform-docs\n    path: "."\n    trunk: master\n    role: knowledge-base',
    '  - id: evil\n    path: "C:/somewhere"\n    trunk: main\n    role: code',
  ] });
  try { expectTxError(() => resolveRepositories(f.ws), 'REPO_GRAPH_INVALID'); }
  finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  // 非法 role
  f = makeRepoGraphFixture({ repos: ['  - id: ai-first-platform-docs\n    path: "."\n    trunk: master\n    role: docs'] });
  try { expectTxError(() => resolveRepositories(f.ws), 'REPO_GRAPH_INVALID'); }
  finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  // 无 knowledge-base role
  f = makeRepoGraphFixture({ repos: ['  - id: multica\n    path: "../multica"\n    trunk: main\n    role: code'] });
  try { expectTxError(() => resolveRepositories(f.ws), 'REPO_GRAPH_INVALID'); }
  finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  // dir-graph.yaml 缺失
  f = makeRepoGraphFixture();
  fs.rmSync(path.join(f.ws, 'dir-graph.yaml'));
  try { expectTxError(() => resolveRepositories(f.ws), 'REPO_GRAPH_NOT_FOUND'); }
  finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-03：path 不存在 → REPO_PATH_NOT_FOUND；末段 symlink escape → REPO_PATH_ESCAPE（AC-1）', () => {
  let f = makeRepoGraphFixture({ repos: [
    '  - id: ai-first-platform-docs\n    path: "."\n    trunk: master\n    role: knowledge-base',
    '  - id: ghost\n    path: "../ghost"\n    trunk: main\n    role: code',
  ] });
  try { expectTxError(() => resolveRepositories(f.ws), 'REPO_PATH_NOT_FOUND'); }
  finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  // symlink/junction escape：声明路径末段指向他处
  f = makeRepoGraphFixture();
  const elsewhere = path.join(f.base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const link = path.join(f.base, 'tools-link');
  try {
    fs.symlinkSync(elsewhere, link, 'junction');
  } catch {
    fs.rmSync(f.base, { recursive: true, force: true });
    return; // 平台不允许建链接时跳过（目标平台 Windows 支持 junction）
  }
  fs.writeFileSync(path.join(f.ws, 'dir-graph.yaml'),
    `repositories:\n  - id: ai-first-platform-docs\n    path: "."\n    trunk: master\n    role: knowledge-base\n  - id: tools-link\n    path: "../tools-link"\n    trunk: main\n    role: code\n`);
  try {
    const err = expectTxError(() => resolveRepositories(f.ws), 'REPO_PATH_ESCAPE');
    assert.ok(err.extra.realpath.includes('elsewhere'));
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('TASK-03：pre-finalize authority = CR worktree（AC-3）', () => {
  const { base, ws } = makeRepoGraphFixture();
  try {
    const cr = 'CR-2026-900';
    const crWs = path.join(ws, '.rayai-worktrees', 'knowledge-base', 'requirement', cr);
    writeCrMdStatus(crWs, cr, 'developing');
    const ctx = resolveRepositories(ws);
    const op = resolveOperationalWorkspace(ctx, cr);
    assert.equal(op.source, 'cr-worktree');
    assert.equal(op.phase, 'developing');
    assert.equal(op.path, crWs);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-03：post-finalize authority = Transaction Workspace，绝不返回主 checkout / 旧 CR worktree（AC-3）', () => {
  const { base, ws } = makeRepoGraphFixture();
  try {
    const cr = 'CR-2026-901';
    const crWs = path.join(ws, '.rayai-worktrees', 'knowledge-base', 'requirement', cr);
    writeCrMdStatus(crWs, cr, 'merging');
    const ctx = resolveRepositories(ws);
    // txws 缺失 → 硬失败，不得回退主 checkout 或 CR worktree
    expectTxError(() => resolveOperationalWorkspace(ctx, cr), 'OPERATIONAL_WORKSPACE_MISSING');
    // txws 存在且自洽 → authority 切换
    const txws = txWorkspacePath(ctx, cr);
    assert.equal(txws, path.join(ws, '.crctl', 'transaction-workspaces', cr), 'txws 路径约定');
    assert.ok(txws !== ws && !txws.startsWith(crWs), 'txws 不是主 checkout 也不是旧 CR worktree');
    writeCrMdStatus(txws, cr, 'merging');
    let op = resolveOperationalWorkspace(ctx, cr);
    assert.equal(op.source, 'transaction-workspace');
    assert.equal(op.phase, 'merging');
    assert.equal(op.path, txws);
    // txws 状态不自洽 → 硬失败
    writeCrMdStatus(txws, cr, 'drafting');
    expectTxError(() => resolveOperationalWorkspace(ctx, cr), 'OPERATIONAL_WORKSPACE_INCONSISTENT');
    // CR worktree cr.md 缺失 → 硬失败
    writeCrMdStatus(txws, cr, 'writing-back');
    fs.rmSync(path.join(crWs, 'change-requests', cr, 'cr.md'));
    expectTxError(() => resolveOperationalWorkspace(ctx, cr), 'CR_WORKTREE_STATUS_MISSING');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

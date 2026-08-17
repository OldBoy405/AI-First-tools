// CR-2026-031 TASK-05：幂等 register 与 workspace 生命周期集成测试。
// 三 bare remote fixture；覆盖 happy path、幂等续跑、input mismatch、fault point 重入、
// rebuild（push 竞争）、graph 漂移硬阻断、dirty trunk 零写入、inspect 七分类与 cleanup 零风险删除。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CRCTL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'crctl.mjs');
const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const YEAR = String(new Date().getFullYear());

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, input: opts.input });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return (r.stdout || '').trim();
}

function runCrctl(args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [CRCTL, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: parse(r.stdout), errJson: parse(r.stderr) };
}

/** 三仓 + 三 bare origin fixture；kb 为 knowledge-base role 且是 InstWS。 */
function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'crctl-register-'));
  const kb = path.join(base, 'kb');
  const others = { multica: path.join(base, 'multica'), tools: path.join(base, 'tools') };
  for (const n of ['kb', 'multica', 'tools']) git(base, ['init', '-q', '--bare', '-b', 'master', `origin-${n}.git`]);
  const initRepo = (wd, originName) => {
    fs.mkdirSync(wd, { recursive: true });
    git(wd, ['init', '-q', '-b', 'master']);
    git(wd, ['config', 'user.email', 'test@aifirst.dev']);
    git(wd, ['config', 'user.name', 'Test']);
    git(wd, ['remote', 'add', 'origin', path.join(base, `origin-${originName}.git`)]);
  };
  initRepo(kb, 'kb');
  initRepo(others.multica, 'multica');
  initRepo(others.tools, 'tools');
  // 最小 tools 包：身份标志 + gates.json（register/workspace 不消费 gates 内容）
  const pkg = path.join(base, 'tools-pkg');
  fs.mkdirSync(path.join(pkg, 'skills', 'shared', 'crctl', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'skills', 'shared', 'crctl', 'gates.json'), '{}');
  fs.writeFileSync(path.join(pkg, 'AGENTS.md'), '');
  fs.writeFileSync(path.join(pkg, 'dir-graph.yaml'), '');
  fs.writeFileSync(path.join(pkg, 'skills', '_index.yml'), '');
  fs.writeFileSync(path.join(pkg, 'skills', 'shared', 'crctl', 'scripts', 'crctl.mjs'), '');
  fs.mkdirSync(path.join(kb, 'change-requests'), { recursive: true });
  fs.writeFileSync(path.join(kb, '.gitignore'), '.rayai-worktrees/\n.crctl/\n');
  fs.writeFileSync(path.join(kb, 'change-requests', '_backlog.yml'), 'schema: cr-backlog/v2\nchange-requests:\n');
  fs.writeFileSync(path.join(kb, 'change-requests', '_index.yml'), 'change-requests:\n');
  fs.writeFileSync(path.join(kb, 'dir-graph.yaml'), [
    'schema: "ai-first.tools.dir-graph/v1"',
    'workspace:',
    '  root: "."',
    '  tools_package_path: "../tools-pkg"',
    'repositories:',
    '  - id: kb',
    '    path: "."',
    '    trunk: master',
    '    role: knowledge-base',
    '  - id: multica',
    '    path: "../multica"',
    '    trunk: master',
    '    role: code',
    '  - id: tools',
    '    path: "../tools"',
    '    trunk: master',
    '    role: code',
    '',
  ].join('\n'));
  for (const wd of [kb, others.multica, others.tools]) {
    git(wd, ['add', '-A']);
    git(wd, ['commit', '-q', '--allow-empty', '-m', 'init']);
    git(wd, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
  }
  return { base, kb, others };
}

const regArgs = (kb, overrides = {}) => {
  const flags = {
    'registration-key': 'key-abc-123',
    title: 'TestCR',
    'owner-requirement': 'Ray',
    'owner-development': 'Ray',
    'owner-test': 'Ray',
    ...overrides,
  };
  const args = ['register', '--workspace', kb];
  for (const [k, v] of Object.entries(flags)) args.push(`--${k}`, v);
  return args;
};

const masterCount = (wd) => Number(git(wd, ['rev-list', '--count', 'master']));
const originMasterCount = (base, name) => Number(git(path.join(base, `origin-${name}.git`), ['rev-list', '--count', 'master']));
const wtPath = (kb, repo, cr) => path.join(kb, '.rayai-worktrees', repo, 'requirement', cr);
const journalDir = (kb) => path.join(kb, '.crctl', 'transactions', 'register');

function readJournal(kb) {
  const keys = fs.readdirSync(journalDir(kb));
  assert.equal(keys.length, 1, '一个 registration key 只允许一个事务目录');
  const txs = fs.readdirSync(path.join(journalDir(kb), keys[0]));
  assert.equal(txs.length, 1, '同 key 同输入只允许一个 txId');
  return JSON.parse(fs.readFileSync(path.join(journalDir(kb), keys[0], txs[0], 'journal.json'), 'utf8'));
}

test('TASK-05 AC-1：happy path 三账本+trailer commit+lease push+三仓 worktree', () => {
  const { base, kb } = makeFixture();
  try {
    const r = runCrctl(regArgs(kb), { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.json.cr, new RegExp(`^CR-${YEAR}-001$`));
    assert.equal(r.json.phase, 'complete');
    assert.equal(r.json.changed, true);
    assert.match(r.json.txId, /^[0-9a-f]{32}$/);
    // origin 恰好多一个 registration commit，且带全部 trailer（key 仅 SHA-256）
    assert.equal(originMasterCount(base, 'kb'), 2);
    const log = git(kb, ['log', '-1', '--format=%B', 'master']);
    for (const t of ['AI-First-Op: register', `AI-First-Tx: ${r.json.txId}`, `AI-First-CR: ${r.json.cr}`, `AI-First-Registration-Key-SHA256: ${sha256('key-abc-123')}`]) {
      assert.ok(log.includes(t), `trailer 缺失: ${t}`);
    }
    assert.ok(!log.includes('key-abc-123'), 'registration key 明文不得出现在 commit');
    // 三账本落 trunk
    assert.ok(fs.existsSync(path.join(kb, 'change-requests', r.json.cr, 'cr.md')));
    assert.ok(fs.readFileSync(path.join(kb, 'change-requests', '_backlog.yml'), 'utf8').includes(`- id: ${r.json.cr}`));
    assert.ok(fs.readFileSync(path.join(kb, 'change-requests', '_index.yml'), 'utf8').includes(`- id: ${r.json.cr}`));
    // 三仓 worktree + 分支
    for (const repo of ['knowledge-base', 'multica', 'tools']) {
      const p = wtPath(kb, repo, r.json.cr);
      assert.ok(fs.existsSync(p), `worktree 缺失: ${repo}`);
      assert.equal(git(p, ['symbolic-ref', '--short', 'HEAD']), `requirement/${r.json.cr}`);
    }
    assert.equal(readJournal(kb).phase, 'complete');
    assert.match(r.json.recoverCommand, /crctl register/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-05 AC-1：同 key 同输入重跑复用 CR-ID/txId，零重复副作用', () => {
  const { base, kb } = makeFixture();
  try {
    const r1 = runCrctl(regArgs(kb), { cwd: kb });
    assert.equal(r1.status, 0, r1.stderr);
    const r2 = runCrctl(regArgs(kb), { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.cr, r1.json.cr);
    assert.equal(r2.json.txId, r1.json.txId);
    assert.equal(r2.json.changed, false, '已完成事务重跑不再产生副作用');
    assert.equal(originMasterCount(base, 'kb'), 2, '不得重复 commit/push');
    const backlog = fs.readFileSync(path.join(kb, 'change-requests', '_backlog.yml'), 'utf8');
    assert.equal(backlog.split(`- id: ${r1.json.cr}`).length - 1, 1, '账本不得重复追加');
    for (const repo of ['knowledge-base', 'multica', 'tools']) {
      const list = git(path.join(kb, '..', repo === 'knowledge-base' ? 'kb' : repo), ['worktree', 'list']);
      assert.equal(list.split('\n').filter((l) => l.includes(`requirement/${r1.json.cr}`)).length, 1);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-05 AC-1：同 key 不同输入返回 REGISTRATION_INPUT_MISMATCH 且零写入', () => {
  const { base, kb } = makeFixture();
  try {
    const r1 = runCrctl(regArgs(kb), { cwd: kb });
    assert.equal(r1.status, 0, r1.stderr);
    const before = originMasterCount(base, 'kb');
    const r2 = runCrctl(regArgs(kb, { title: 'OtherTitle' }), { cwd: kb });
    assert.notEqual(r2.status, 0);
    assert.equal(r2.errJson.error.code, 'REGISTRATION_INPUT_MISMATCH');
    assert.equal(originMasterCount(base, 'kb'), before);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-05 AC-1：dirty trunk 返回 REGISTRATION_TRUNK_DIRTY 且仓库零写入', () => {
  const { base, kb } = makeFixture();
  try {
    fs.writeFileSync(path.join(kb, 'stray.txt'), 'x');
    const shaBefore = git(kb, ['rev-parse', 'master']);
    const r = runCrctl(regArgs(kb), { cwd: kb });
    assert.notEqual(r.status, 0);
    assert.equal(r.errJson.error.code, 'REGISTRATION_TRUNK_DIRTY');
    assert.equal(git(kb, ['rev-parse', 'master']), shaBefore);
    assert.equal(originMasterCount(base, 'kb'), 1);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-05 AC-1：register-after-commit fault 重跑同 CR-ID/txId 续完 push', () => {
  const { base, kb } = makeFixture();
  try {
    const r1 = runCrctl(regArgs(kb), { cwd: kb, env: { CRCTL_FAULT_POINT: 'register-after-commit' } });
    assert.notEqual(r1.status, 0);
    assert.equal(r1.errJson.error.code, 'FAULT_INJECTED');
    const cr = r1.errJson.error.cr;
    assert.match(cr, new RegExp(`^CR-${YEAR}-001$`));
    assert.ok(git(kb, ['log', '-1', '--format=%B']).includes('AI-First-Op: register'), '本地 commit 已生成');
    assert.equal(originMasterCount(base, 'kb'), 1, 'fault 发生在 push 前');
    const r2 = runCrctl(regArgs(kb), { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.cr, cr);
    assert.equal(originMasterCount(base, 'kb'), 2, '重跑只补 push，不重复 commit');
    assert.equal(r2.json.phase, 'complete');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-05 AC-2：第一仓 worktree 成功后 fault，重跑只补后续仓', () => {
  const { base, kb } = makeFixture();
  try {
    const r1 = runCrctl(regArgs(kb), { cwd: kb, env: { CRCTL_FAULT_POINT: 'register-between-worktrees' } });
    assert.notEqual(r1.status, 0);
    const cr = readJournal(kb).register.cr;
    // 排序后第一仓 = kb（bucket knowledge-base）已建，其余未建
    assert.ok(fs.existsSync(wtPath(kb, 'knowledge-base', cr)));
    assert.ok(!fs.existsSync(wtPath(kb, 'multica', cr)));
    assert.ok(!fs.existsSync(wtPath(kb, 'tools', cr)));
    const r2 = runCrctl(regArgs(kb), { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.cr, cr);
    for (const repo of ['knowledge-base', 'multica', 'tools']) assert.ok(fs.existsSync(wtPath(kb, repo, cr)));
    const j = readJournal(kb);
    assert.deepEqual(j.register.worktrees.sort(), ['kb', 'multica', 'tools']);
    assert.equal(originMasterCount(base, 'kb'), 2, 'worktree 阶段不得再 push');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-05 AC-1/5.1：push 竞争（remote 被他人推进）时 rebuild 到新 origin base', () => {
  const { base, kb } = makeFixture();
  try {
    const r1 = runCrctl(regArgs(kb), { cwd: kb, env: { CRCTL_FAULT_POINT: 'register-after-commit' } });
    assert.notEqual(r1.status, 0);
    // 竞争者：clone origin-kb 并推一个无关 commit
    const clone = path.join(base, 'rival');
    git(base, ['clone', '-q', path.join(base, 'origin-kb.git'), clone]);
    git(clone, ['config', 'user.email', 'rival@aifirst.dev']);
    git(clone, ['config', 'user.name', 'Rival']);
    fs.writeFileSync(path.join(clone, 'rival.txt'), 'rival');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '-q', '-m', 'rival commit']);
    git(clone, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
    const r2 = runCrctl(regArgs(kb), { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(originMasterCount(base, 'kb'), 3, 'init + rival + rebuilt register');
    const log = git(kb, ['log', '--format=%s', 'master']);
    assert.ok(log.includes('rival commit'));
    assert.ok(log.includes(`register ${r2.json.cr}`));
    const backlog = fs.readFileSync(path.join(kb, 'change-requests', '_backlog.yml'), 'utf8');
    assert.equal(backlog.split(`- id: ${r2.json.cr}`).length - 1, 1, 'rebuild 后账本仍只一条');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('review repair：register remote stale 后用户改动出现时拒绝 reset --hard', () => {
  const { base, kb } = makeFixture();
  try {
    const r1 = runCrctl(regArgs(kb), { cwd: kb, env: { CRCTL_FAULT_POINT: 'register-after-commit' } });
    assert.notEqual(r1.status, 0);
    const clone = path.join(base, 'rival-dirty');
    git(base, ['clone', '-q', path.join(base, 'origin-kb.git'), clone]);
    git(clone, ['config', 'user.email', 'rival@aifirst.dev']);
    git(clone, ['config', 'user.name', 'Rival']);
    fs.writeFileSync(path.join(clone, 'rival.txt'), 'rival');
    git(clone, ['add', '-A']); git(clone, ['commit', '-q', '-m', 'rival']);
    git(clone, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
    fs.writeFileSync(path.join(kb, 'user-uncommitted.txt'), 'must survive');
    const r2 = runCrctl(regArgs(kb), { cwd: kb });
    assert.notEqual(r2.status, 0);
    assert.equal(r2.errJson.error.code, 'REGISTRATION_TRUNK_DIRTY');
    assert.equal(fs.readFileSync(path.join(kb, 'user-uncommitted.txt'), 'utf8'), 'must survive');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-05 AC-1：副作用出现后 graph 变化返回 GRAPH_CHANGED_DURING_TRANSACTION', () => {
  const { base, kb } = makeFixture();
  try {
    const r1 = runCrctl(regArgs(kb), { cwd: kb, env: { CRCTL_FAULT_POINT: 'register-after-commit' } });
    assert.notEqual(r1.status, 0);
    // 修改 dir-graph 声明（trunk 参与 graphDigest；副作用已存在：本地 commit）
    const g = path.join(kb, 'dir-graph.yaml');
    fs.writeFileSync(g, fs.readFileSync(g, 'utf8').replace(
      '  - id: tools\n    path: "../tools"\n    trunk: master',
      '  - id: tools\n    path: "../tools"\n    trunk: custom-master'));
    git(kb, ['add', 'dir-graph.yaml']);
    git(kb, ['commit', '-q', '-m', 'graph change']);
    const r2 = runCrctl(regArgs(kb), { cwd: kb });
    assert.notEqual(r2.status, 0);
    assert.equal(r2.errJson.error.code, 'GRAPH_CHANGED_DURING_TRANSACTION');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-05 AC-2：inspect 七分类 + ensure resume 只补缺 + cleanup 零风险删除', () => {
  const { base, kb, others } = makeFixture();
  try {
    const cr = `CR-${YEAR}-999`;
    // 全 missing
    let r = runCrctl(['workspace', 'inspect', cr, '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.resources.map((x) => x.classification), ['missing', 'missing', 'missing']);
    // branch-only（multica 本地分支）/ remote-only（tools 远端分支）
    git(others.multica, ['branch', `requirement/${cr}`, 'master']);
    git(others.tools, ['push', '-q', 'origin', `master:refs/heads/requirement/${cr}`]);
    git(others.tools, ['fetch', '-q', 'origin']);
    r = runCrctl(['workspace', 'inspect', cr, '--workspace', kb], { cwd: kb });
    const byRepo = Object.fromEntries(r.json.resources.map((x) => [x.repo, x.classification]));
    assert.equal(byRepo.kb, 'missing');
    assert.equal(byRepo.multica, 'branch-only');
    assert.equal(byRepo.tools, 'remote-only');
    // ensure resume：三仓全补齐，remote-only 从 origin 分支建
    r = runCrctl(['workspace', 'ensure', cr, '--mode', 'resume', '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.changed, true);
    for (const repo of ['knowledge-base', 'multica', 'tools']) {
      assert.equal(git(wtPath(kb, repo, cr), ['symbolic-ref', '--short', 'HEAD']), `requirement/${cr}`);
    }
    assert.equal(git(others.tools, ['rev-parse', `requirement/${cr}`]), git(others.tools, ['rev-parse', `origin/requirement/${cr}`]), 'remote-only 必须 track origin 分支');
    // 重复 ensure：零变化
    r = runCrctl(['workspace', 'ensure', cr, '--mode', 'resume', '--workspace', kb], { cwd: kb });
    assert.equal(r.json.changed, false);
    // 构造 dirty / wrong-branch / path-unregistered
    fs.writeFileSync(path.join(wtPath(kb, 'multica', cr), 'dirty.txt'), 'x');
    const kbWt = wtPath(kb, 'knowledge-base', cr);
    git(kbWt, ['checkout', '-q', '-b', 'tmp-other-branch']);
    fs.rmSync(wtPath(kb, 'tools', cr), { recursive: true, force: true });
    git(others.tools, ['worktree', 'prune']);
    fs.mkdirSync(wtPath(kb, 'tools', cr), { recursive: true });
    r = runCrctl(['workspace', 'inspect', cr, '--workspace', kb], { cwd: kb });
    const byRepo2 = Object.fromEntries(r.json.resources.map((x) => [x.repo, x.classification]));
    assert.equal(byRepo2.multica, 'dirty');
    assert.equal(byRepo2.kb, 'wrong-branch');
    assert.equal(byRepo2.tools, 'path-unregistered');
    // cleanup：三类风险状态一律保留（零删除）
    r = runCrctl(['workspace', 'cleanup', cr, '--mode', 'partial', '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.changed, false);
    assert.deepEqual(r.json.resources.map((x) => x.action).sort(), ['kept', 'kept', 'kept']);
    assert.ok(fs.existsSync(path.join(wtPath(kb, 'multica', cr), 'dirty.txt')));
    // 恢复 kb worktree 到健康后 cleanup 只删它；分支保留
    git(kbWt, ['checkout', '-q', `requirement/${cr}`]);
    git(kbWt, ['branch', '-q', '-D', 'tmp-other-branch']);
    r = runCrctl(['workspace', 'cleanup', cr, '--mode', 'partial', '--workspace', kb], { cwd: kb });
    assert.equal(r.json.changed, true);
    assert.ok(!fs.existsSync(kbWt), '干净 worktree 被删除');
    assert.equal(git(others.multica, ['rev-parse', '--verify', `refs/heads/requirement/${cr}`]).length, 40, '未合并分支保留');
    assert.equal(git(kb, ['rev-parse', '--verify', `refs/heads/requirement/${cr}`]).length, 40, '未合并分支保留');
    assert.equal(git(path.join(base, 'origin-tools.git'), ['rev-parse', '--verify', `refs/heads/requirement/${cr}`]).length, 40, '远端分支保留');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-10：register 成功 → outbox 发 status+owners 事件（同真实 commit SHA、owners changes 恰 3 项）；幂等重跑零事件', () => {
  const { base, kb } = makeFixture();
  try {
    const r1 = runCrctl(regArgs(kb), { cwd: kb });
    assert.equal(r1.status, 0, r1.stderr);
    const commitSe = (r1.json.sideEffects || []).find((s) => s.kind === 'commit');
    assert.ok(commitSe, 'register 必须有 commit 副作用');
    assert.ok(r1.json.outbox && r1.json.outbox.status && r1.json.outbox.owners, 'status+owners 事件必须发出');
    assert.deepEqual(r1.json.warnings, []);
    const outDir = path.join(kb, '.crctl', 'outbox');
    const events = fs.readdirSync(outDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')));
    const status = events.find((e) => e.event_kind === 'status' && e.trigger === 'requirement-register');
    const owners = events.find((e) => e.event_kind === 'owners' && e.trigger === 'requirement-register');
    assert.ok(status && owners, 'outbox 必须落盘 status+owners 注册事件');
    for (const ev of [status, owners]) {
      assert.equal(ev.cr_id, r1.json.cr);
      assert.equal(ev.from_status, '(new)');
      assert.equal(ev.to_status, 'drafting');
      assert.equal(ev.commit_sha, commitSe.sha, '事件 commit_sha 必须是真实 register commit SHA');
    }
    assert.equal(owners.payload.changes.length, 3);
    for (const role of ['requirement', 'development', 'test']) {
      assert.ok(owners.payload.owners[role] && owners.payload.owners[role].id, `owners.${role} 缺失`);
    }
    // 幂等重跑：changed=false 且零新事件
    const before = fs.readdirSync(outDir).length;
    const r2 = runCrctl(regArgs(kb), { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.changed, false);
    assert.equal(r2.json.outbox, undefined, '重跑不得重发事件');
    assert.equal(fs.readdirSync(outDir).length, before);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('CR-2026-044 TASK-05: workspace inspect 输出 authority operationalWorkspace；missing 时结构化错误不猜路径', () => {
  const { base, kb } = makeFixture();
  try {
    const cr = `CR-${YEAR}-999`;
    // missing 态：resources 照常诊断，authority 为 null + 结构化错误码（不猜路径）
    let r = runCrctl(['workspace', 'inspect', cr, '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.operationalWorkspace, null);
    assert.ok(r.json.operationalWorkspaceError && r.json.operationalWorkspaceError.code, 'missing 时必须给结构化错误码');
    // register 后 healthy：operationalWorkspace === knowledge-base CR worktree（既有 resolver 唯一事实）
    r = runCrctl(regArgs(kb), { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    const regCr = r.json.cr;
    r = runCrctl(['workspace', 'inspect', regCr, '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.operationalWorkspaceError, null);
    assert.equal(r.json.operationalWorkspace, wtPath(kb, 'knowledge-base', regCr));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

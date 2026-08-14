// crctl.mjs 测试（架构评审 R3/R4）。
// 覆盖：approve 的 TTY 强制（人类在环，无旁路）、状态机合法/非法转换、
// EVIDENCE_DRIFT 检测（本次新增的证据哈希复核逻辑）。
//
// 零依赖：仅用 node:test / node:assert，通过 spawnSync 黑盒调用 crctl.mjs
// （不 import 其内部函数，避免为了可测试性改动 CLI 本身的公开面）。
//
// 运行：node --test skills/shared/crctl/scripts/test/crctl.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
// CR-2026-039 TASK-03：纯函数单测直接 import（与 archive-tx/checkpoint-tx 等测试同模式；不改变 CLI 公开面）
import { crMdStatusText, refreshCrMdUpdated } from '../lib/workspace-transactions.mjs';

const CRCTL = path.resolve(import.meta.dirname, '..', 'crctl.mjs');
// 真实 tools 包根（test → scripts → crctl → shared → skills → tools 共 5 层）：
// 既有测试默认通过 ws/dir-graph.yaml#workspace.tools_package_path 指向它（CR-2026-028 FR-1/FR-4 后配置来源收敛）
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');

function sha16(text) {
  // 与 crctl.mjs 的 evidenceSha16 同口径：行尾规范化后哈希（防 autocrlf 误报）
  return crypto.createHash('sha256').update(text.replaceAll('\r\n', '\n'), 'utf8').digest('hex').slice(0, 16);
}

function runCrctl(args, env) {
  const r = spawnSync(process.execPath, [CRCTL, ...args], { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  let stdout = null;
  try { stdout = JSON.parse(r.stdout); } catch { /* 非 JSON 输出（如 help）忽略 */ }
  let stderr = null;
  try { stderr = JSON.parse(r.stderr); } catch { /* ignore */ }
  return { status: r.status, stdout, stderr, rawStdout: r.stdout, rawStderr: r.stderr };
}

function runCrctlWrapped(args, prelude, input = '') {
  const script = `${prelude}\nprocess.argv = [process.execPath, ${JSON.stringify(CRCTL)}, ...process.argv.slice(1)];\nawait import(${JSON.stringify(pathToFileURL(CRCTL).href)});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, ...args], { encoding: 'utf8', input });
  let stderr = null;
  try { stderr = JSON.parse(r.stderr); } catch { /* ignore */ }
  return { status: r.status, stderr, rawStdout: r.stdout, rawStderr: r.stderr };
}

function runCrctlInTty(args, input = 'yes\n') {
  return runCrctlWrapped(args, [
    `Object.defineProperty(process.stdin, 'isTTY', { value: true });`,
    `Object.defineProperty(process.stdout, 'isTTY', { value: true });`,
  ].join('\n'), input);
}

/** 建一个一次性临时 workspace；返回目录路径，调用方负责在 test 结束时 rmSync。
 * 默认写入 dir-graph.yaml 声明 workspace.tools_package_path 指向真实 tools 包（CR-2026-028 FR-1），
 * 使既有测试语义不变（仍读真实 tools 配置），同时覆盖 resolver 契约；
 * 传 opts.toolsRoot 可指向定制 fixture（sentinel / 失败场景）。 */
function makeWorkspace(opts = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crctl-test-'));
  mkdirSync(path.join(dir, 'change-requests'), { recursive: true });
  const toolsRoot = opts.toolsRoot || PACKAGE_ROOT;
  writeFileSync(path.join(dir, 'dir-graph.yaml'),
    `workspace:\n  tools_package_path: ${JSON.stringify(toolsRoot)}\n`, 'utf8');
  return dir;
}

/* ── CR-2026-028 FR-9：最小 tools 包 fixture（四标志 + sentinel 配置，不修改真实 checkout）── */

const FIXTURE_DIR_GRAPH = [
  'change-request-track:',
  '  state_machine:',
  '    field: "status"',
  '    transitions:',
  '      - { from: sentinel-drafting, to: sentinel-reviewing, trigger: "sentinel-advance" }',
].join('\n') + '\n';

const FIXTURE_GATES = {
  approvalStages: {},
  statusGates: {},
  reviewLoops: {},
  evidence: { 'sentinel': 'change-requests/{cr}/sentinel-evidence.md' },
};

const FIXTURE_PIPELINE = {
  id: 'sentinel',
  nodes: [{ ref: 'sentinel-node', reviewLoop: { maxAttempts: 3, passCondition: { allOf: [
    { path: 'verdict', equals: 'pass' }, { path: 'blockers', isEmpty: true } ] } } }],
};

// setupBriefWs 专用：requirement 审批门禁（对齐真实 gates.json 的 requirement 段，供回显测试触发 passCondition）
const BRIEF_GATES = {
  approvalStages: {
    requirement: {
      to: 'requirement-approved',
      trigger: 'approve-requirement',
      expect: ['requirement-reviewing'],
      approvalSection: 'requirement',
      evidence: { $default: 'change-requests/{cr}/review-annotations/requirement.yml' },
      passCondition: { pipeline: 'requirement-authoring', nodeRef: 'review-requirement' },
    },
  },
  statusGates: {
    'requirement-reviewing': [
      { type: 'fileExists', path: 'change-requests/{cr}/prd.md' },
      { type: 'passCondition', stage: 'requirement' },
    ],
    'requirement-approved': [
      { type: 'passCondition', stage: 'requirement' },
      { type: 'approval', section: 'requirement' },
    ],
  },
  reviewLoops: { 'review-requirement': { pipeline: 'requirement-authoring' } },
};

const FIXTURE_RULES = {
  git: [{ sub: 'status', shapes: ['--sentinel-shape'] }],
  forbiddenFlags: ['--push'],
};

/** 建一次性最小 tools 包 fixture（四标志齐全 + sentinel 配置）。 */
function makeToolsFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crctl-tools-fixture-'));
  writeFileSync(path.join(dir, 'AGENTS.md'), '# fixture tools\n', 'utf8');
  writeFileSync(path.join(dir, 'dir-graph.yaml'), FIXTURE_DIR_GRAPH, 'utf8');
  mkdirSync(path.join(dir, 'skills'), { recursive: true });
  writeFileSync(path.join(dir, 'skills', '_index.yml'), 'skills: []\n', 'utf8');
  mkdirSync(path.join(dir, 'skills', 'shared', 'crctl', 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'skills', 'shared', 'crctl', 'scripts', 'crctl.mjs'), '// fixture marker\n', 'utf8');
  writeFileSync(path.join(dir, 'skills', 'shared', 'crctl', 'gates.json'), JSON.stringify(FIXTURE_GATES), 'utf8');
  mkdirSync(path.join(dir, 'pipeline-templates'), { recursive: true });
  writeFileSync(path.join(dir, 'pipeline-templates', 'sentinel.pipeline.json'), JSON.stringify(FIXTURE_PIPELINE), 'utf8');
  mkdirSync(path.join(dir, 'skills', 'shared', 'controlled-shell'), { recursive: true });
  writeFileSync(path.join(dir, 'skills', 'shared', 'controlled-shell', 'rules.json'), JSON.stringify(FIXTURE_RULES), 'utf8');
  return dir;
}

/**
 * 写 _backlog.yml fixture。默认含 owners 三角色（完整合规模板），
 * 通过 opts.owners=false 可关闭（如测试非法 owners 校验场景）。
 * 通过 opts.schema 可指定 schema 版本（如 'cr-backlog/v2'）。
 */
function writeBacklog(ws, entries, opts = {}) {
  const lines = [];
  lines.push(`schema: ${opts.schema || 'cr-backlog/v2'}`); // CR-2026-031 TASK-02：fixture 默认 v2（最低支持 schema）
  lines.push('change-requests:');
  for (const e of entries) {
    lines.push(`  - id: ${e.id}`);
    if (e.status !== undefined) lines.push(`    status: ${e.status}`);
    if (e.title) lines.push(`    title: ${e.title}`);
    if (opts.owners !== false) {
      lines.push(
        '    owners:',
        '      requirement:',
        '        id: Ray',
        '        assigned-at: "2026-08-04T12:00:00+08:00"',
        '      development:',
        '        id: Ray',
        '        assigned-at: "2026-08-04T12:00:00+08:00"',
        '      test:',
        '        id: Ray',
        '        assigned-at: "2026-08-04T12:00:00+08:00"',
      );
    }
  }
  writeFileSync(path.join(ws, 'change-requests', '_backlog.yml'), lines.join('\n') + '\n');
}

/**
 * 写 cr.md fixture。默认含 owners 三角色（完整合规模板），
 * 通过 opts.owners=false 可关闭。extra 可追加额外 frontmatter 行。
 */
function writeCrMd(ws, cr, status, opts = {}) {
  const dir = path.join(ws, 'change-requests', cr);
  mkdirSync(dir, { recursive: true });
  const lines = ['---', `id: ${cr}`, `status: ${status}`];
  if (opts.owners !== false) {
    lines.push(
      'owners:',
      '  requirement:',
      '    id: Ray',
      '    assigned-at: "2026-08-04T12:00:00+08:00"',
      '  development:',
      '    id: Ray',
      '    assigned-at: "2026-08-04T12:00:00+08:00"',
      '  test:',
      '    id: Ray',
      '    assigned-at: "2026-08-04T12:00:00+08:00"',
    );
  }
  if (opts.extra) lines.push(...opts.extra);
  lines.push('---', '');
  writeFileSync(path.join(dir, 'cr.md'), lines.join('\n'));
}

/**
 * 一键建 CR fixture：同时写 _backlog.yml 条目 + cr.md（状态一致）。
 * 这是大多数测试的推荐入口——避免分别调 writeBacklog/writeCrMd 时漏掉一边。
 * opts 透传给 writeBacklog/writeCrMd。
 */
function writeCrEntry(ws, cr, status, opts = {}) {
  writeBacklog(ws, [{ id: cr, status }], opts);
  writeCrMd(ws, cr, status, opts);
}

function writeApprovalYml(ws, cr, section, fields) {
  const dir = path.join(ws, 'change-requests', cr);
  mkdirSync(dir, { recursive: true });
  const lines = [`${section}:`, ...Object.entries(fields).map(([k, v]) => `  ${k}: ${typeof v === 'string' ? `"${v}"` : v}`)];
  writeFileSync(path.join(dir, 'approval.yml'), lines.join('\n') + '\n');
}

// CR-2026-027 TASK-06：写 _index.yml fixture（归档终态更新目标）
function writeIndex(ws, entries) {
  const dir = path.join(ws, 'change-requests');
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (const e of entries) {
    lines.push(`- id: ${e.id}`);
    lines.push(`    title: ${e.title}`);
    if (e.status) lines.push(`    status: ${e.status}`);
    if (e.created) lines.push(`    created: "${e.created}"`);
  }
  writeFileSync(path.join(dir, '_index.yml'), lines.join('\n') + '\n');
}

function writeEvidence(ws, cr, relFromCrDir, content) {
  const p = path.join(ws, 'change-requests', cr, relFromCrDir);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

// ── approve：人类在环，无旁路（治理⑤）─────────────────────────────────
test('approve 拒绝非交互式调用（spawnSync 下 stdin 恒非 TTY），无 --stage 之外的旁路参数', () => {
  const ws = makeWorkspace();
  try {
    const r = runCrctl(['approve', 'CR-TEST-1', '--stage', 'requirement', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'APPROVAL_REQUIRES_HUMAN');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('approve 对未知 --stage 直接拒绝（在 TTY 检查之前）', () => {
  const ws = makeWorkspace();
  try {
    const r = runCrctl(['approve', 'CR-TEST-1', '--stage', 'not-a-real-stage', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'BAD_ARGS');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── 状态机：合法与非法转换 ────────────────────────────────────────────
test('advance：合法转换（drafting -> rejected，无门禁声明的终态）成功', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-TEST-1', 'drafting');
    const r = runCrctl(['advance', 'CR-TEST-1', '--to', 'rejected', '--trigger', 'cr-review-record:reject', '--workspace', ws, '--no-commit']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.advanced, true);
    assert.equal(r.stdout.to, 'rejected');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('advance：非法转换（状态机中不存在的 trigger）被拒绝，不写入任何文件', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }]);
    writeCrMd(ws, 'CR-TEST-1', 'drafting');
    const r = runCrctl(['advance', 'CR-TEST-1', '--to', 'code-approved', '--trigger', 'made-up-trigger', '--workspace', ws, '--no-commit']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'CR_STATUS_TRANSITION_NOT_ALLOWED');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── EVIDENCE_DRIFT：本次新增的证据哈希复核（架构评审 R4）────────────────
test('gate：approval 段哈希与证据文件当前内容一致 -> 通过，不报 EVIDENCE_DRIFT', () => {
  const ws = makeWorkspace();
  const cr = 'CR-TEST-1';
  try {
    const evidenceText = 'verdict: pass\nblockers: []\n';
    writeEvidence(ws, cr, 'review-annotations/requirement.yml', evidenceText);
    writeApprovalYml(ws, cr, 'requirement', {
      approver: 'alice', 'approved-at': '2026-07-28T10:00:00+08:00', via: 'crctl-approve',
      'evidence-sha256-16': sha16(evidenceText), 'target-status': 'requirement-approved',
    });
    const r = runCrctl(['gate', cr, '--for', 'requirement-approved', '--workspace', ws]);
    const approvalCheck = r.stdout.checks.find((c) => c.type === 'approval');
    assert.equal(approvalCheck.ok, true);
    assert.equal(approvalCheck.code, undefined);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('gate：审批后证据文件被改动 -> approval 段报 EVIDENCE_DRIFT（此前该场景完全检测不到，是本次修的缺口）', () => {
  const ws = makeWorkspace();
  const cr = 'CR-TEST-1';
  try {
    const originalText = 'verdict: pass\nblockers: []\n';
    writeEvidence(ws, cr, 'review-annotations/requirement.yml', originalText);
    writeApprovalYml(ws, cr, 'requirement', {
      approver: 'alice', 'approved-at': '2026-07-28T10:00:00+08:00', via: 'crctl-approve',
      'evidence-sha256-16': sha16(originalText), 'target-status': 'requirement-approved',
    });
    // 审批之后，有人偷偷改了证据文件（比如把失败的评审结果改成通过）
    writeEvidence(ws, cr, 'review-annotations/requirement.yml', 'verdict: pass\nblockers: []\n# tampered\n');

    const r = runCrctl(['gate', cr, '--for', 'requirement-approved', '--workspace', ws]);
    const approvalCheck = r.stdout.checks.find((c) => c.type === 'approval');
    assert.equal(approvalCheck.ok, false);
    assert.equal(approvalCheck.code, 'EVIDENCE_DRIFT');
    assert.match(approvalCheck.why, /EVIDENCE_DRIFT/);
    assert.equal(r.status, 1, 'gate 命令在任一 check 不通过时应以非零退出');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('gate：证据文件仅行尾从 LF 变为 CRLF（autocrlf 检出）-> 不误报 EVIDENCE_DRIFT（CR-2026-001 回写期实测回归）', () => {
  const ws = makeWorkspace();
  const cr = 'CR-TEST-1';
  try {
    const lfText = 'verdict: pass\nblockers: []\n';
    // 审批时证据是 LF（worktree 内），记录的哈希按 LF 计算
    writeApprovalYml(ws, cr, 'requirement', {
      approver: 'alice', 'approved-at': '2026-07-28T10:00:00+08:00', via: 'crctl-approve',
      'evidence-sha256-16': sha16(lfText), 'target-status': 'requirement-approved',
    });
    // 合并后 Windows autocrlf 把同一内容检出为 CRLF —— 内容未被篡改
    writeEvidence(ws, cr, 'review-annotations/requirement.yml', lfText.replaceAll('\n', '\r\n'));

    const r = runCrctl(['gate', cr, '--for', 'requirement-approved', '--workspace', ws]);
    const approvalCheck = r.stdout.checks.find((c) => c.type === 'approval');
    assert.equal(approvalCheck.ok, true, `行尾差异不是篡改，不应报 EVIDENCE_DRIFT（why=${approvalCheck.why}）`);
    assert.equal(approvalCheck.code, undefined);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('gate：approval 段缺失字段（未经 crctl approve 写入）-> 拒绝，且不会误判为 EVIDENCE_DRIFT', () => {
  const ws = makeWorkspace();
  const cr = 'CR-TEST-1';
  try {
    writeEvidence(ws, cr, 'review-annotations/requirement.yml', 'verdict: pass\nblockers: []\n');
    // 不写 approval.yml，模拟"从未审批"
    const r = runCrctl(['gate', cr, '--for', 'requirement-approved', '--workspace', ws]);
    const approvalCheck = r.stdout.checks.find((c) => c.type === 'approval');
    assert.equal(approvalCheck.ok, false);
    assert.equal(approvalCheck.code, undefined);
    assert.match(approvalCheck.why, /缺失或非 crctl approve 写入/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── controlled-shell rules.json 单一事实源（CR-2026-002 TASK-01）──────────
test('git：rules.json 缺失 -> SHELL_UNAVAILABLE 结构化错误，不崩溃不放行', () => {
  const ws = makeWorkspace();
  try {
    const r = runCrctl(['git', 'status', '--short', '--workspace', ws],
      { CRCTL_RULES_PATH: path.join(ws, 'no-such-rules.json') });
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'SHELL_UNAVAILABLE');
    assert.match(r.stderr.error.message, /缺失或损坏/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('git：rules.json 损坏（非法 JSON）-> SHELL_UNAVAILABLE 结构化错误', () => {
  const ws = makeWorkspace();
  try {
    const bad = path.join(ws, 'rules-broken.json');
    writeFileSync(bad, '{ this is not json');
    const r = runCrctl(['git', 'status', '--short', '--workspace', ws], { CRCTL_RULES_PATH: bad });
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'SHELL_UNAVAILABLE');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('git：rules.json 正常加载后语义与原硬编码表一致（禁子命令/禁旗标仍拦截）', () => {
  const ws = makeWorkspace();
  try {
    // 不在白名单的子命令
    let r = runCrctl(['git', 'rebase', 'main', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'FORBIDDEN_SUBCOMMAND');
    // 白名单子命令 + 配置注入旗标
    r = runCrctl(['git', 'status', '--short', '-c', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'FORBIDDEN_SUBCOMMAND');
    assert.match(r.stderr.error.message, /配置注入/);
    // 白名单形态不匹配
    r = runCrctl(['git', 'push', '--force', 'origin', 'main', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'FORBIDDEN_SUBCOMMAND');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── outbox 事件通道（CR-2026-002 TASK-02）────────────────────────────────

function readOutbox(ws) {
  const dir = path.join(ws, '.crctl', 'outbox');
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => ({ file: f, ev: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }));
  } catch { return []; }
}

test('outbox：advance 成功（--no-commit，即 embedded 半边）-> 写入合 schema 的 status 事件且 commit_sha 为 pending: 占位符（CR-2026-003 契约更新，旧契约为空串）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-TEST-1', 'drafting');
    const r = runCrctl(['advance', 'CR-TEST-1', '--to', 'rejected', '--trigger', 'cr-review-record:reject', '--workspace', ws, '--no-commit']);
    assert.equal(r.status, 0);
    const events = readOutbox(ws);
    assert.equal(events.length, 1);
    const { ev } = events[0];
    assert.equal(ev.v, 1);
    assert.equal(ev.event_kind, 'status');
    assert.equal(ev.cr_id, 'CR-TEST-1');
    assert.equal(ev.from_status, 'drafting');
    assert.equal(ev.to_status, 'rejected');
    assert.equal(ev.trigger, 'cr-review-record:reject');
    assert.match(ev.commit_sha, /^pending:\d+:\d+:\d+$/, 'embedded 占位 sha（与 multica projectableSha 的契约字面量）');
    assert.ok(ev.occurred_at && ev.actor !== undefined && typeof ev.payload === 'object');
    // 文件名片段消毒后不含冒号（Windows 文件名合法性）
    assert.match(events[0].file, /^\d{8}T\d{9}Z-CR-TEST-1-status-[A-Za-z0-9]{1,8}\.json$/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('outbox：advance 被拒（非法转换）-> 不写任何事件', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }]);
    writeCrMd(ws, 'CR-TEST-1', 'drafting');
    const r = runCrctl(['advance', 'CR-TEST-1', '--to', 'code-approved', '--trigger', 'made-up-trigger', '--workspace', ws, '--no-commit']);
    assert.equal(r.status, 1);
    assert.equal(readOutbox(ws).length, 0);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('outbox：git push 成功 -> checkpoint 事件携带 HEAD sha 与从提交信息提取的 CR-ID（embedded 补全通道）', () => {
  const ws = makeWorkspace();
  const bare = mkdtempSync(path.join(os.tmpdir(), 'crctl-test-bare-'));
  try {
    const g = (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    };
    g(['init', '--bare'], bare);
    g(['init', '-b', 'master'], ws);
    g(['config', 'user.email', 'test@test'], ws);
    g(['config', 'user.name', 'tester'], ws);
    writeCrEntry(ws, 'CR-2026-001', 'drafting'); // 保证有可提交内容；CR-ID 用生产格式（提取正则为 CR-\d{4}-\d{3}）
    g(['add', '-A'], ws);
    g(['commit', '-m', '[cr] status CR-2026-001 drafting -> requirement-reviewing'], ws);
    g(['remote', 'add', 'origin', bare], ws);

    const r = runCrctl(['git', 'push', '-u', 'origin', 'master', '--workspace', ws]);
    assert.equal(r.status, 0);
    const events = readOutbox(ws).filter((e) => e.ev.event_kind === 'checkpoint');
    assert.equal(events.length, 1);
    const { ev } = events[0];
    assert.equal(ev.cr_id, 'CR-2026-001');
    assert.match(ev.commit_sha, /^[0-9a-f]{40}$/);
    assert.match(ev.payload.headMessage, /CR-2026-001/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

// ── evidence-digest 统一 + grant 验签（CR-2026-002 TASK-03）──────────────
import { generateKeyPairSync, sign as cryptoSign, createHash } from 'node:crypto';

const VECTORS_DIR = path.resolve(import.meta.dirname, 'fixtures', 'digest-vectors');

function canonicalDigestOf(texts) {
  // 按 §B.2 公式独立实现（测试侧对照，不 import crctl 内部函数）
  const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
  return sha(texts.map((t) => sha(t.replaceAll('\r\n', '\n'))).join(''));
}

test('digest-vectors：共享测试向量自洽（expected.json 与 §B.2 公式一致），供 Go 侧对照', () => {
  const expected = JSON.parse(readFileSync(path.join(VECTORS_DIR, 'expected.json'), 'utf8'));
  const texts = expected.files.map((f) => readFileSync(path.join(VECTORS_DIR, f), 'utf8'));
  assert.equal(canonicalDigestOf(texts), expected.digest);
});

test('gate：evidence-digest（统一字段，多文件 canonical）一致 -> 通过；篡改任一文件 -> EVIDENCE_DRIFT', () => {
  const ws = makeWorkspace();
  const cr = 'CR-TEST-1';
  try {
    const codeYml = readFileSync(path.join(VECTORS_DIR, 'review-annotations-code.yml'), 'utf8');
    const report = readFileSync(path.join(VECTORS_DIR, 'test-report.md'), 'utf8');
    writeEvidence(ws, cr, 'review-annotations/code.yml', codeYml);
    writeEvidence(ws, cr, 'test-report.md', report);
    const expected = JSON.parse(readFileSync(path.join(VECTORS_DIR, 'expected.json'), 'utf8'));
    writeApprovalYml(ws, cr, 'code', {
      approver: 'alice', 'approved-at': '2026-07-31T10:00:00+08:00', via: 'crctl-approve',
      'evidence-digest': expected.digest, 'target-status': 'code-approved',
    });
    // merging 门禁只查 approval#code —— crctl 的 canonical 实现必须与共享向量口径一致（conformance）
    let r = runCrctl(['gate', cr, '--for', 'merging', '--workspace', ws]);
    let check = r.stdout.checks.find((c) => c.type === 'approval');
    assert.equal(check.ok, true, `crctl canonical 实现应与共享向量一致（why=${check.why}）`);
    // 篡改第二个证据文件 → 漂移
    writeEvidence(ws, cr, 'test-report.md', report + '# tampered\n');
    r = runCrctl(['gate', cr, '--for', 'merging', '--workspace', ws]);
    check = r.stdout.checks.find((c) => c.type === 'approval');
    assert.equal(check.ok, false);
    assert.equal(check.code, 'EVIDENCE_DRIFT');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('gate：历史 evidence-sha256-16 字段（废弃）仍被兼容复核，不报错不阻塞（AC-7②）', () => {
  const ws = makeWorkspace();
  const cr = 'CR-TEST-1';
  try {
    const text = 'verdict: pass\nblockers: []\n';
    writeEvidence(ws, cr, 'review-annotations/requirement.yml', text);
    writeApprovalYml(ws, cr, 'requirement', {
      approver: 'alice', 'approved-at': '2026-07-28T10:00:00+08:00', via: 'crctl-approve',
      'evidence-sha256-16': sha16(text), 'target-status': 'requirement-approved',
    });
    const r = runCrctl(['gate', cr, '--for', 'requirement-approved', '--workspace', ws]);
    const check = r.stdout.checks.find((c) => c.type === 'approval');
    assert.equal(check.ok, true);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// grant 测试基建：真实 Ed25519 密钥对 + 可级联 advance 的 workspace
function makeGrantWorkspace() {
  const ws = makeWorkspace();
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: ws, encoding: 'utf8', shell: false });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 'tester']);
  writeCrEntry(ws, 'CR-2026-001', 'requirement-reviewing');
  writeEvidence(ws, 'CR-2026-001', 'review-annotations/requirement.yml', 'verdict: pass\nblockers: []\n');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(path.join(ws, '.crctl', 'keys'), { recursive: true });
  writeFileSync(path.join(ws, '.crctl', 'keys', 'approval-test.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
  return { ws, privateKey };
}

function makeGrant(ws, privateKey, overrides = {}) {
  const evidenceText = readFileSync(path.join(ws, 'change-requests', 'CR-2026-001', 'review-annotations', 'requirement.yml'), 'utf8');
  const grant = {
    v: 1, cr_id: 'CR-2026-001', stage: 'requirement', decision: 'approve',
    approver: 'alice@corp', approved_at: '2026-07-31T10:30:00+08:00',
    evidence_digest: canonicalDigestOf([evidenceText]),
    key_id: 'approval-test',
    ...overrides,
  };
  const canonical = `v1|${grant.cr_id}|${grant.stage}|${grant.decision}|${grant.approver}|${grant.approved_at}|${grant.evidence_digest}`;
  grant.signature = overrides.signature ?? cryptoSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
  const gp = path.join(ws, 'grant.json');
  writeFileSync(gp, JSON.stringify(grant, null, 2));
  return gp;
}

test('approve --grant：验签通过 -> 非 TTY 放行，写 server-approve 段并级联 advance（AC-4⑥ 通过路径）', () => {
  const { ws, privateKey } = makeGrantWorkspace();
  try {
    const gp = makeGrant(ws, privateKey);
    const r = runCrctl(['approve', 'CR-2026-001', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.advanced, true);
    assert.equal(r.stdout.to, 'requirement-approved');
    const approval = readFileSync(path.join(ws, 'change-requests', 'CR-2026-001', 'approval.yml'), 'utf8');
    assert.match(approval, /via: server-approve/);
    assert.match(approval, /evidence-digest: /);
    assert.match(approval, /key-id: "approval-test"/);
    // gate 复核：server-approve 段被承认，且签名重验证通过
    const g2 = runCrctl(['gate', 'CR-2026-001', '--for', 'requirement-approved', '--workspace', ws]);
    const check = g2.stdout.checks.find((c) => c.type === 'approval');
    assert.equal(check.ok, true, `server-approve 应被 gate 承认且验签通过（why=${check.why}）`);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('approve --grant：签名伪造 -> SIGNATURE_INVALID；digest 不符 -> EVIDENCE_DRIFT；挪用他 CR -> GRANT_MISMATCH', () => {
  const { ws, privateKey } = makeGrantWorkspace();
  try {
    // 伪造签名（长度合法的 base64，但不是有效 Ed25519 签名）
    let gp = makeGrant(ws, privateKey, { signature: Buffer.alloc(64, 7).toString('base64') });
    let r = runCrctl(['approve', 'CR-2026-001', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'SIGNATURE_INVALID');
    // digest 不符：对"错的 digest"给出有效签名，证明 digest 比对独立于验签生效
    gp = makeGrant(ws, privateKey, { evidence_digest: canonicalDigestOf(['verdict: pass\nblockers: []\n# other version\n']) });
    r = runCrctl(['approve', 'CR-2026-001', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'EVIDENCE_DRIFT');
    // 挪用：grant 归属另一个 CR
    gp = makeGrant(ws, privateKey, { cr_id: 'CR-2026-999' });
    r = runCrctl(['approve', 'CR-2026-001', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'GRANT_MISMATCH');
    // 三次拒绝全程未写 approval.yml
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-2026-001', 'approval.yml')), false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-027 TASK-03：approve 原子提交（FR-8）────────────────────
test('CR-2026-027 FR-8：grant 审批 approval.yml 与 cr.md 单次原子提交（同 commit，无分提交残留）', () => {
  const { ws, privateKey } = makeGrantWorkspace();
  try {
    const gp = makeGrant(ws, privateKey);
    const r = runCrctl(['approve', 'CR-2026-001', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.advanced, true);
    assert.equal(r.stdout.to, 'requirement-approved');
    // 单次提交：最近 commit 同时含 approval.yml 与 cr.md，且消息为原子 approve 形态
    const show = spawnSync('git', ['show', '--stat', '--oneline', 'HEAD'], { cwd: ws, encoding: 'utf8' });
    assert.match(show.stdout, /approval\.yml/);
    assert.match(show.stdout, /cr\.md/);
    assert.match(show.stdout, /\[cr\] approve CR-2026-001 requirement approval\+status -> requirement-approved/);
    // approval.yml 与 cr.md 不再悬空（fixture 其他文件为测试前置，本测试只看这两个文件）
    const st = spawnSync('git', ['status', '--porcelain'], { cwd: ws, encoding: 'utf8' });
    assert.ok(!st.stdout.includes('approval.yml'), 'approval.yml 不得留在未提交状态');
    assert.ok(!st.stdout.includes('cr.md'), 'cr.md 不得留在未提交状态');
    // 状态已推进且 approval 段可被 gate 承认（server-approve + 签名重验证）
    const g2 = runCrctl(['gate', 'CR-2026-001', '--for', 'requirement-approved', '--workspace', ws]);
    const check = g2.stdout.checks.find((c) => c.type === 'approval');
    assert.equal(check.ok, true, `server-approve 应被 gate 承认且验签通过（why=${check.why}）`);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 FR-8：证据漂移时 grant 拒绝且零文件写入（approval.yml/cr.md 均不落盘，无 outbox）', () => {
  const { ws, privateKey } = makeGrantWorkspace();
  try {
    const gp = makeGrant(ws, privateKey, { evidence_digest: canonicalDigestOf(['verdict: pass\nblockers: []\n# tampered\n']) });
    const r = runCrctl(['approve', 'CR-2026-001', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'EVIDENCE_DRIFT');
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-2026-001', 'approval.yml')), false, 'approval.yml 不得落盘');
    const md = readFileSync(path.join(ws, 'change-requests', 'CR-2026-001', 'cr.md'), 'utf8');
    assert.match(md, /status: requirement-reviewing/, 'cr.md 不得推进');
    assert.equal(existsSync(path.join(ws, '.crctl', 'outbox')), false, '不得发 status outbox');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 FR-8：runGateChecks evidence override —— 候选 approval 缺 via 时 GATE_BLOCKED（零写入前提的 seam 验证）', () => {
  const ws = makeWorkspace();
  const cr = 'CR-TEST-1';
  try {
    writeCrEntry(ws, cr, 'requirement-reviewing');
    writeEvidence(ws, cr, 'review-annotations/requirement.yml', 'verdict: pass\nblockers: []\n');
    // 构造缺 via 的 approval.yml（approval checker 与 evidence override 共用同一判定路径）
    writeFileSync(path.join(ws, 'change-requests', cr, 'approval.yml'), 'requirement:\n  approver: "alice"\n  approved-at: "2026-08-10T00:00:00+08:00"\n', 'utf8');
    // gate 验证：缺 via 的 approval 段 → 不通过（与 override 同路径的 approval checker）
    const r = runCrctl(['gate', cr, '--for', 'requirement-approved', '--workspace', ws]);
    const check = r.stdout.checks.find((c) => c.type === 'approval');
    assert.equal(check.ok, false);
    assert.match(check.why, /via 必须为 crctl-approve 或 server-approve/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-027 TASK-04：archived TASK 完成门禁五步判定（FR-9/D-8）────
test('CR-2026-027 FR-9：archived 门禁五步判定 —— 缺 index/空列表/全 pending/部分 done/delivery 缺失均拦截，全就绪放行', () => {
  const ws = makeWorkspace();
  const cr = 'CR-TEST-1';
  try {
    writeCrEntry(ws, cr, 'writing-back');
    const taskDir = path.join(ws, 'change-requests', cr, 'tasks');
    const gateArchived = () => runCrctl(['gate', cr, '--for', 'archived', '--workspace', ws]).stdout.checks.find((c) => c.type === 'deliveryIndexComplete');
    // ① index 缺失 → TASK_INDEX_MISSING（缺文件不得解释为 no-task）
    assert.equal(gateArchived().code, 'TASK_INDEX_MISSING');
    // ② 空列表 → TASK_LIST_EMPTY
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, '_index.yml'), 'schema: cr-tasks/v1\ncr: CR-TEST-1\ntasks: []\n');
    assert.equal(gateArchived().code, 'TASK_LIST_EMPTY');
    // ③ 全 pending → TASK_STATUS_INCOMPLETE
    writeFileSync(path.join(taskDir, '_index.yml'), 'schema: cr-tasks/v1\ncr: CR-TEST-1\ntasks:\n  - { id: CR-TEST-1-TASK-01, status: pending }\n');
    assert.equal(gateArchived().code, 'TASK_STATUS_INCOMPLETE');
    // ④ 全 done 但 delivery 缺失 → DELIVERY_INDEX_MISSING
    writeFileSync(path.join(taskDir, '_index.yml'), 'schema: cr-tasks/v1\ncr: CR-TEST-1\ntasks:\n  - { id: CR-TEST-1-TASK-01, status: done }\n');
    assert.equal(gateArchived().code, 'DELIVERY_INDEX_MISSING');
    // ⑤ 全 done + delivery 齐 → 放行
    mkdirSync(path.join(ws, 'delivery', 'task'), { recursive: true });
    writeFileSync(path.join(ws, 'delivery', 'task', '_index.yaml'), 'schema: delivery-task/v1\ntasks:\n  - { id: CR-TEST-1-TASK-01 }\n');
    assert.equal(gateArchived().ok, true);
    // ⑥ 部分 done → TASK_STATUS_INCOMPLETE（混合状态同样拦截）
    writeFileSync(path.join(taskDir, '_index.yml'), 'schema: cr-tasks/v1\ncr: CR-TEST-1\ntasks:\n  - { id: CR-TEST-1-TASK-01, status: done }\n  - { id: CR-TEST-1-TASK-02, status: pending }\n');
    assert.equal(gateArchived().code, 'TASK_STATUS_INCOMPLETE');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('gate：检出 EVIDENCE_DRIFT -> outbox 出现 audit 事件（payload 只有摘要，无证据内容）；重复 gate 不重复堆积', () => {
  const ws = makeWorkspace();
  const cr = 'CR-TEST-1';
  try {
    const originalText = 'verdict: pass\nblockers: []\n';
    writeEvidence(ws, cr, 'review-annotations/requirement.yml', originalText);
    writeApprovalYml(ws, cr, 'requirement', {
      approver: 'alice', 'approved-at': '2026-07-28T10:00:00+08:00', via: 'crctl-approve',
      'evidence-sha256-16': sha16(originalText), 'target-status': 'requirement-approved',
    });
    writeEvidence(ws, cr, 'review-annotations/requirement.yml', 'verdict: pass\nblockers: []\n# tampered\n');

    runCrctl(['gate', cr, '--for', 'requirement-approved', '--workspace', ws]);
    runCrctl(['gate', cr, '--for', 'requirement-approved', '--workspace', ws]); // 第二次观测

    const outbox = path.join(ws, '.crctl', 'outbox');
    const files = readdirSync(outbox).filter((f) => f.startsWith('audit-drift-'));
    assert.equal(files.length, 1, '同一份漂移在待采集期间只留一份（确定性文件名去重）');
    const ev = JSON.parse(readFileSync(path.join(outbox, files[0]), 'utf8'));
    assert.equal(ev.v, 1);
    assert.equal(ev.event_kind, 'audit');
    assert.equal(ev.cr_id, cr);
    assert.equal(ev.payload.action, 'aifirst.evidence_drift');
    assert.equal(ev.payload.stage, 'requirement');
    assert.notEqual(ev.payload.expected_digest, ev.payload.actual_digest);
    assert.ok(ev.payload.detected_at);
    assert.ok(!JSON.stringify(ev.payload).includes('tampered'), 'payload 不得包含证据内容');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-003 T01：embedded 占位 sha（幂等键碰撞修复，"pending:" 为跨语言契约字面量）──
test('advance --embedded：连续两次 embedded 的 outbox 事件 commit_sha 均以 pending: 开头且互不相同；非 embedded 仍为真实 HEAD sha', () => {
  const ws = makeWorkspace();
  try {
    // 初始化 git 仓（非 embedded 路径需要真实 commit）
    const run = (args) => spawnSync('git', ['-C', ws, ...args], { encoding: 'utf8' });
    run(['init', '-b', 'master']); run(['config', 'user.email', 't@t']); run(['config', 'user.name', 't']);
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }, { id: 'CR-TEST-2', status: 'requirement-approved' }]);
    writeCrMd(ws, 'CR-TEST-1', 'drafting');
    writeCrMd(ws, 'CR-TEST-2', 'requirement-approved');
    // CR-TEST-1：非 embedded（drafting -> requirement-reviewing，需评审证据）
    writeEvidence(ws, 'CR-TEST-1', 'review-annotations/requirement.yml', 'verdict: pass\nblockers: []\n');
    writeFileSync(path.join(ws, 'change-requests', 'CR-TEST-1', 'prd.md'), '# prd\n');
    run(['add', '-A']); run(['commit', '-m', 'wip: seed']);
    const r1 = runCrctl(['advance', 'CR-TEST-1', '--to', 'requirement-reviewing', '--trigger', 'review-requirement', '--workspace', ws]);
    assert.ok(r1.stdout && r1.stdout.advanced === true, `r1 failed: ${(r1.rawStdout||'').slice(0,200)} STDERR: ${(r1.rawStderr||'').slice(0,300)}`);
    // CR-TEST-2：连续两次 embedded（requirement-approved -> tech-designing -> tech-design-review-pending）
    // tech-designing 门禁校验 requirement 审批段，补齐审批记录与匹配证据
    const ev2 = 'verdict: pass\nblockers: []\n';
    writeEvidence(ws, 'CR-TEST-2', 'review-annotations/requirement.yml', ev2);
    writeApprovalYml(ws, 'CR-TEST-2', 'requirement', {
      approver: 'alice', 'approved-at': '2026-07-31T10:00:00+08:00', via: 'crctl-approve',
      'evidence-sha256-16': sha16(ev2), 'target-status': 'requirement-approved',
    });
    writeFileSync(path.join(ws, 'change-requests', 'CR-TEST-2', 'prd.md'), '# prd\n');
    writeFileSync(path.join(ws, 'change-requests', 'CR-TEST-2', 'sdd.md'), '# sdd\n');
    const r2 = runCrctl(['advance', 'CR-TEST-2', '--to', 'tech-designing', '--trigger', 'write-tech-design', '--embedded', '--workspace', ws]);
    assert.equal(r2.stdout.advanced, true, JSON.stringify(r2.stdout || r2.stderr).slice(0, 300));
    const r3 = runCrctl(['advance', 'CR-TEST-2', '--to', 'tech-design-review-pending', '--trigger', 'write-tech-design-complete', '--embedded', '--workspace', ws]);
    assert.equal(r3.stdout.advanced, true, JSON.stringify(r3.stdout || r3.stderr).slice(0, 300));

    const outbox = path.join(ws, '.crctl', 'outbox');
    const events = readdirSync(outbox).filter((f) => f.includes('-status-'))
      .map((f) => JSON.parse(readFileSync(path.join(outbox, f), 'utf8')));
    const nonEmbedded = events.find((e) => e.cr_id === 'CR-TEST-1');
    const embedded = events.filter((e) => e.cr_id === 'CR-TEST-2');
    // 非 embedded：真实 40 位 hex sha（不受本修复影响）
    assert.match(nonEmbedded.commit_sha, /^[0-9a-f]{40}$/, `非 embedded 应为真实 sha：${nonEmbedded.commit_sha}`);
    // embedded：pending: 前缀（与 multica projectableSha 的跨语言契约字面量）且互不相同
    assert.equal(embedded.length, 2);
    for (const e of embedded) assert.match(e.commit_sha, /^pending:\d+:\d+:\d+$/, `占位符格式：${e.commit_sha}`);
    assert.notEqual(embedded[0].commit_sha, embedded[1].commit_sha, '两次 embedded 的占位符必须不同（幂等键不再碰撞）');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});


// ── CR-2026-018：状态单写 cr.md + _backlog.yml 注册索引化 ─────────────────────

// AC-1：advance 只写 cr.md，_backlog.yml 不变
test('CR-2026-018 AC-1：advance 后 _backlog.yml 内容不变（单写 cr.md）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-TEST-1', 'drafting');
    const before = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const r = runCrctl(['advance', 'CR-TEST-1', '--to', 'rejected', '--trigger', 'cr-review-record:reject', '--workspace', ws, '--no-commit']);
    assert.equal(r.status, 0);
    const after = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.equal(after, before, '_backlog.yml 不应被 advance 修改');
    // cr.md 被更新
    const crmd = readFileSync(path.join(ws, 'change-requests', 'CR-TEST-1', 'cr.md'), 'utf8');
    assert.match(crmd, /status: rejected/);
    // result.files 只含 cr.md
    assert.equal(r.stdout.files.length, 1);
    assert.match(r.stdout.files[0], /cr\.md$/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// AC-2a（TASK-02 修订）：cr.md 缺 status → CR_MD_STATUS_MISSING（v1 backlog 回退读已删除）
test('CR-2026-031 TASK-02：cr.md 无 status → CR_MD_STATUS_MISSING（不再回退读 backlog）', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }]);
    // 不写 cr.md
    const r = runCrctl(['status', 'CR-TEST-1', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'CR_MD_STATUS_MISSING');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// AC-2b：v2 布局（backlog 无 status，cr.md 有）→ 权威读，无 legacySource
test('CR-2026-018 AC-2b：v2 布局权威读（backlog 无 status，cr.md 有）', () => {
  const ws = makeWorkspace();
  try {
    // v2 backlog：无 status 行
    writeBacklog(ws, [{ id: 'CR-TEST-1', title: 'test' }], { schema: 'cr-backlog/v2' });
    writeCrMd(ws, 'CR-TEST-1', 'developing');
    const r = runCrctl(['status', 'CR-TEST-1', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.status, 'developing');
    assert.equal(r.stdout.legacySource, undefined);
    assert.ok(!r.stdout.warnings || !r.stdout.warnings.some((w) => w.code === 'MIXED_LAYOUT_WARN'));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// AC-3a：validate v2 正常（backlog 无 status 行，cr.md 一致）→ 无告警
test('CR-2026-018 AC-3a：validate v2 布局一致，无告警', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', title: 'test' }]);
    writeCrMd(ws, 'CR-TEST-1', 'drafting');
    const r = runCrctl(['validate', 'change-requests/_backlog.yml', '--workspace', ws]);
    assert.equal(r.status, 0, JSON.stringify(r.stderr || r.stdout).slice(0, 300));
    assert.equal(r.stdout.valid, true);
    assert.ok(!r.stdout.warnings || r.stdout.warnings.length === 0);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// AC-3b（TASK-02 修订）：validate v1 backlog（无 schema 声明）→ UNSUPPORTED_BACKLOG_SCHEMA 硬失败，文件不变
test('CR-2026-031 TASK-02：validate v1 backlog → UNSUPPORTED_BACKLOG_SCHEMA 零写', () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'change-requests:\n  - id: CR-TEST-1\n    status: drafting\n');
    const before = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const r = runCrctl(['validate', 'change-requests/_backlog.yml', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'UNSUPPORTED_BACKLOG_SCHEMA');
    assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), before);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// AC-3c：validate v2 LEGACY_STATUS_FIELD（v2 schema 但条目仍含 status）→ warning
test('CR-2026-018 AC-3c：validate v2 LEGACY_STATUS_FIELD 告警', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }], { schema: 'cr-backlog/v2' });
    const r = runCrctl(['validate', 'change-requests/_backlog.yml', '--workspace', ws]);
    assert.equal(r.status, 0, JSON.stringify(r.stderr || r.stdout).slice(0, 300));
    assert.equal(r.stdout.valid, true);
    assert.ok(r.stdout.warnings && r.stdout.warnings.some((w) => w.includes('LEGACY_STATUS_FIELD')));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// CR-2026-031 TASK-02：永久迁移兼容删除回归
test('CR-2026-031 TASK-02：v1 backlog 读命令路径 → UNSUPPORTED_BACKLOG_SCHEMA 零写', () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'change-requests:\n  - id: CR-V1\n    status: drafting\n');
    writeCrMd(ws, 'CR-V1', 'drafting');
    const before = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const r = runCrctl(['status', 'CR-V1', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'UNSUPPORTED_BACKLOG_SCHEMA');
    assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), before, '失败零写');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-031 TASK-02：已退役命令统一拒绝（cr-metrics/migrate-backlog/task allocate）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    const r1 = runCrctl(['cr-metrics', '--workspace', ws]);
    assert.equal(r1.status, 1);
    assert.equal(r1.stderr.error.code, 'BAD_ARGS');
    const r2 = runCrctl(['migrate-backlog', '--workspace', ws]);
    assert.equal(r2.status, 1);
    assert.equal(r2.stderr.error.code, 'BAD_ARGS');
    const r3 = runCrctl(['task', 'allocate', 'CR-T1', '--workspace', ws]);
    assert.equal(r3.status, 1);
    assert.equal(r3.stderr.error.code, 'BAD_ARGS');
    assert.match(r3.stderr.error.message, /仅支持子命令 init\/done/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// CR_MD_WRITE_FAILED（TASK-02 修订）：cr.md 缺失时 resolveCrState 先于写入硬失败
test('CR-2026-031 TASK-02：advance 时 cr.md 缺失 → CR_MD_STATUS_MISSING', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }]);
    // 不写 cr.md
    const r = runCrctl(['advance', 'CR-TEST-1', '--to', 'rejected', '--trigger', 'cr-review-record:reject', '--workspace', ws, '--no-commit']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'CR_MD_STATUS_MISSING');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// AC-11：混版布局告警（cr.md 与 backlog 双写且不一致 → cr.md 胜 + MIXED_LAYOUT_WARN）
test('CR-2026-018 AC-11：混版布局告警（cr.md 与 backlog 不一致）', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }]);
    writeCrMd(ws, 'CR-TEST-1', 'developing');
    // 注：backlog 与 cr.md status 故意不一致，不能用 writeCrEntry
    const r = runCrctl(['status', 'CR-TEST-1', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.status, 'developing', 'cr.md 为准');
    assert.ok(r.stdout.warnings && r.stdout.warnings.some((w) => w.code === 'MIXED_LAYOUT_WARN'));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-019：账本子命令（task done；merge-metadata/archive-move 已于 CR-2026-031 TASK-10 随旧命令删除）+ AC-9 入库（FR-7） ──
// SDD §7.2 测试矩阵：AC-1/2/3/5/7 全覆盖；CAS_CONFLICT 分支黑盒无法注入读后改时序，
// command-level durable transaction 的 kill/restart 原子性由 fault-harness 黑盒覆盖。

function writeTaskIndex(ws, cr, tasks) {
  const dir = path.join(ws, 'change-requests', cr, 'tasks');
  mkdirSync(dir, { recursive: true });
  const lines = [`cr-ref: ${cr}`, 'tasks:'];
  for (const t of tasks) {
    lines.push(`  - id: ${t.id}`);
    if (t.title) lines.push(`    title: ${t.title}`);
    lines.push(`    status: ${t.status}`);
    if (t.doneAt) lines.push(`    done-at: "${t.doneAt}"`);
    lines.push(`    estimate: ${t.estimate || '4h'}`);
    lines.push(`    depends-on: ${JSON.stringify(t.dependsOn || [])}`);
  }
  writeFileSync(path.join(dir, '_index.yml'), lines.join('\n') + '\n');
}

function writeTaskCard(ws, cr, number, { title, estimate = '4h', dependsOn = [], eol = '\n' }) {
  const nn = String(number).padStart(2, '0');
  const dir = path.join(ws, 'change-requests', cr, 'tasks');
  mkdirSync(dir, { recursive: true });
  const text = [
    '---',
    `id: ${cr}-TASK-${nn}`,
    'type: TASK',
    `cr-ref: ${cr}`,
    `title: ${JSON.stringify(title)}`,
    'status: pending',
    `estimate: ${estimate}`,
    `depends-on: ${JSON.stringify(dependsOn)}`,
    '---',
    '',
    `# TASK-${nn}`,
    '',
  ].join('\n').replaceAll('\n', eol);
  writeFileSync(path.join(dir, `TASK-${nn}.md`), text, 'utf8');
}

test('CR-2026-037 task init：合法 TASK 集合创建 canonical 索引并汇总工时', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'tech-design-reviewed');
    writeTaskCard(ws, 'CR-T1', 1, { title: 'core: init', estimate: '8h' });
    writeTaskCard(ws, 'CR-T1', 2, { title: 'adopt', estimate: '4h', dependsOn: ['CR-T1-TASK-01'] });
    const r = runCrctl(['task', 'init', 'CR-T1', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.deepEqual({ op: r.stdout.op, taskCount: r.stdout.taskCount, totalEstimateHours: r.stdout.totalEstimateHours, changed: r.stdout.changed },
      { op: 'task-init', taskCount: 2, totalEstimateHours: 12, changed: true });
    const idx = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml'), 'utf8');
    assert.equal(idx, [
      'cr-id: CR-T1',
      'tasks:',
      '  - id: CR-T1-TASK-01',
      '    title: "core: init"',
      '    status: pending',
      '    estimate: 8h',
      '    depends-on: []',
      '  - id: CR-T1-TASK-02',
      '    title: "adopt"',
      '    status: pending',
      '    estimate: 4h',
      '    depends-on: [CR-T1-TASK-01]',
      '',
    ].join('\n'));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-037 task init：CRLF 输入、no-op 与 pending refresh 保持确定性', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    writeTaskCard(ws, 'CR-T1', 1, { title: 'quoted "title"', estimate: '3h', eol: '\r\n' });
    const first = runCrctl(['task', 'init', 'CR-T1', '--workspace', ws]);
    assert.equal(first.status, 0, first.rawStderr);
    const p = path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml');
    const canonical = readFileSync(p, 'utf8');
    assert.ok(!canonical.includes('\r'));
    const auditPath = path.join(ws, '.crctl', 'audit.log');
    const auditBefore = readFileSync(auditPath, 'utf8');
    const second = runCrctl(['task', 'init', 'CR-T1', '--workspace', ws]);
    assert.equal(second.status, 0, second.rawStderr);
    assert.equal(second.stdout.changed, false);
    assert.equal(readFileSync(p, 'utf8'), canonical);
    assert.equal(readFileSync(auditPath, 'utf8'), auditBefore);
    writeTaskCard(ws, 'CR-T1', 1, { title: 'revised', estimate: '5h' });
    const third = runCrctl(['task', 'init', 'CR-T1', '--workspace', ws]);
    assert.equal(third.status, 0, third.rawStderr);
    assert.equal(third.stdout.changed, true);
    assert.equal(third.stdout.totalEstimateHours, 5);
    assert.match(readFileSync(p, 'utf8'), /title: "revised"/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-037 task init：坏卡表驱动硬失败且零索引写入', () => {
  const cases = [
    ['empty', null, 'TASK_SET_EMPTY'],
    ['bad-id', 'id: WRONG', 'TASK_CARD_INVALID'],
    ['bad-estimate', 'estimate: 0h', 'TASK_CARD_INVALID'],
    ['bad-depends', 'depends-on: nope', 'TASK_CARD_INVALID'],
  ];
  for (const [name, replacement, code] of cases) {
    const ws = makeWorkspace();
    try {
      writeCrEntry(ws, 'CR-T1', 'tech-design-reviewed');
      if (replacement) {
        writeTaskCard(ws, 'CR-T1', 1, { title: name });
        const p = path.join(ws, 'change-requests', 'CR-T1', 'tasks', 'TASK-01.md');
        const raw = readFileSync(p, 'utf8');
        const field = replacement.split(':')[0];
        writeFileSync(p, raw.replace(new RegExp(`^${field}:.*$`, 'm'), replacement));
      }
      const r = runCrctl(['task', 'init', 'CR-T1', '--workspace', ws]);
      assert.equal(r.status, 1, `${name}: ${r.rawStderr}`);
      assert.equal(r.stderr.error.code, code, name);
      assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml')), false, name);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
});

test('CR-2026-037 task init：悬空依赖与环均在写前拒绝', () => {
  for (const mode of ['unknown', 'self', 'cycle']) {
    const ws = makeWorkspace();
    try {
      writeCrEntry(ws, 'CR-T1', 'tech-design-reviewed');
      if (mode === 'unknown') writeTaskCard(ws, 'CR-T1', 1, { title: 'x', dependsOn: ['CR-T1-TASK-99'] });
      if (mode === 'self') writeTaskCard(ws, 'CR-T1', 1, { title: 'x', dependsOn: ['CR-T1-TASK-01'] });
      if (mode === 'cycle') {
        writeTaskCard(ws, 'CR-T1', 1, { title: 'x', dependsOn: ['CR-T1-TASK-02'] });
        writeTaskCard(ws, 'CR-T1', 2, { title: 'y', dependsOn: ['CR-T1-TASK-01'] });
      }
      const r = runCrctl(['task', 'init', 'CR-T1', '--workspace', ws]);
      assert.equal(r.status, 1, `${mode}: ${r.rawStderr}`);
      assert.equal(r.stderr.error.code, mode === 'unknown' ? 'DEPENDS_ON_UNKNOWN' : 'TASK_DEPENDENCY_CYCLE');
      assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml')), false);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
});

test('CR-2026-037 task init：已有进度与非法状态 fail-closed', () => {
  for (const existing of [
    [{ id: 'CR-T1-TASK-01', title: 'x', status: 'done', doneAt: '2026-08-13T00:00:00Z' }],
    [{ id: 'CR-T1-TASK-01', title: 'x', status: 'unknown' }],
  ]) {
    const ws = makeWorkspace();
    try {
      writeCrEntry(ws, 'CR-T1', 'task-breakdown');
      writeTaskCard(ws, 'CR-T1', 1, { title: 'x' });
      writeTaskIndex(ws, 'CR-T1', existing);
      const p = path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml');
      const before = readFileSync(p, 'utf8');
      const r = runCrctl(['task', 'init', 'CR-T1', '--workspace', ws]);
      assert.equal(r.status, 1, r.rawStderr);
      assert.equal(r.stderr.error.code, 'TASK_INDEX_HAS_PROGRESS');
      assert.equal(readFileSync(p, 'utf8'), before);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    writeTaskCard(ws, 'CR-T1', 1, { title: 'x' });
    const r = runCrctl(['task', 'init', 'CR-T1', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'ILLEGAL_LEDGER_STATE');
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml')), false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-037 task-breakdown：缺索引时 gate/next 阻断，task init 后 gate 通过', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    writeFileSync(path.join(ws, 'change-requests', 'CR-T1', 'plan.md'), '# plan\n');
    writeTaskCard(ws, 'CR-T1', 1, { title: 'x' });
    let r = runCrctl(['gate', 'CR-T1', '--for', 'task-breakdown', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout.pass, false);
    assert.ok(r.stdout.checks.some((check) => check.type === 'fileExists' && check.ok === false && path.basename(check.path) === '_index.yml'));
    r = runCrctl(['advance', 'CR-T1', '--to', 'task-breakdown', '--trigger', 'write-dev-tasks', '--expect', 'task-breakdown', '--workspace', ws, '--no-commit']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'GATE_BLOCKED');
    r = runCrctl(['next', 'CR-T1', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.next, 'write-dev-tasks');
    assert.match(r.stdout.why, /crctl task init/);
    r = runCrctl(['task', 'init', 'CR-T1', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    r = runCrctl(['gate', 'CR-T1', '--for', 'task-breakdown', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.pass, true);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-037 task init：读间 TASK 变化与索引 CAS 冲突均零覆盖', () => {
  for (const mode of ['task', 'index']) {
    const ws = makeWorkspace();
    try {
      writeCrEntry(ws, 'CR-T1', 'task-breakdown');
      writeTaskCard(ws, 'CR-T1', 1, { title: 'x' });
      if (mode === 'index') writeTaskIndex(ws, 'CR-T1', [{ id: 'CR-T1-TASK-01', title: 'old', status: 'pending' }]);
      const suffix = mode === 'task' ? 'TASK-01.md' : '_index.yml';
      const prelude = `
        const fs = (await import('node:fs')).default;
        const original = fs.readFileSync.bind(fs);
        let reads = 0;
        fs.readFileSync = function(p, ...args) {
          if (String(p).endsWith(${JSON.stringify(suffix)})) {
            reads++;
            if (reads === 2) fs.appendFileSync(p, '# concurrent\\n');
          }
          return original(p, ...args);
        };
      `;
      const indexPath = path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml');
      const before = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
      const r = runCrctlWrapped(['task', 'init', 'CR-T1', '--workspace', ws], prelude);
      assert.equal(r.status, 1, `${mode}: ${r.rawStderr}`);
      assert.equal(r.stderr.error.code, mode === 'task' ? 'TASK_SET_CHANGED' : 'CAS_CONFLICT');
      if (mode === 'task') assert.equal(existsSync(indexPath), false);
      else assert.equal(readFileSync(indexPath, 'utf8'), before + '# concurrent\n');
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
});

test('CR-2026-037 Prompt 采纳：Skill/Pipeline 调 task init 且不指导直写索引', () => {
  const root = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
  const skill = readFileSync(path.join(root, 'skills', 'develop', 'write-dev-tasks', 'SKILL.md'), 'utf8');
  const pipelineText = readFileSync(path.join(root, 'pipeline-templates', 'code-implementation.pipeline.json'), 'utf8');
  const pipeline = JSON.parse(pipelineText);
  assert.match(skill, /crctl task init/);
  assert.match(skill, /禁止 Agent\/Skill 手写/);
  assert.doesNotMatch(skill, /重新生成.*TASK 与 `_index\.yml`/);
  assert.match(pipelineText, /crctl task init/);
  assert.match(pipelineText, /不得手写索引/);
  assert.doesNotMatch(pipelineText, /同时生成 tasks\/_index\.yml/);
  assert.equal(pipeline.nodes.length, 15); // CR-2026-039 TASK-04：新增评审后审批前 checkpoint 节点（…0015）
});

test('task done：正常路径 pending→done + done-at + audit 记录（AC-1）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    writeTaskIndex(ws, 'CR-T1', [{ id: 'CR-T1-TASK-01', title: 'x', status: 'pending' }]);
    const r = runCrctl(['task', 'done', 'CR-T1', '--task', 'CR-T1-TASK-01', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.op, 'task-done');
    assert.equal(r.stdout.task, 'CR-T1-TASK-01');
    assert.equal(r.stdout.status, 'done');
    const idx = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml'), 'utf8');
    assert.match(idx, /status: done/);
    assert.match(idx, /done-at: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const audit = readFileSync(path.join(ws, '.crctl', 'audit.log'), 'utf8');
    assert.match(audit, /"op":"task-done"/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('task done：不存在的 --task 非零退出且文件无变更（AC-1）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    writeTaskIndex(ws, 'CR-T1', [{ id: 'CR-T1-TASK-01', title: 'x', status: 'pending' }]);
    const before = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml'), 'utf8');
    const r = runCrctl(['task', 'done', 'CR-T1', '--task', 'CR-T1-TASK-99', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'TASK_NOT_FOUND');
    assert.equal(readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml'), 'utf8'), before);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('task done：已 done 的任务非零退出且文件无变更（AC-1）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    writeTaskIndex(ws, 'CR-T1', [{ id: 'CR-T1-TASK-01', title: 'x', status: 'done', doneAt: '2026-08-04T12:00:00+08:00' }]);
    const before = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml'), 'utf8');
    const r = runCrctl(['task', 'done', 'CR-T1', '--task', 'CR-T1-TASK-01', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'TASK_ALREADY_DONE');
    assert.equal(readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml'), 'utf8'), before);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('task done：紧凑多块 _index.yml 中标记中间任务不粘连相邻块（T04 教训延伸）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    writeTaskIndex(ws, 'CR-T1', [
      { id: 'CR-T1-TASK-01', title: 'a', status: 'pending' },
      { id: 'CR-T1-TASK-02', title: 'b', status: 'pending' },
      { id: 'CR-T1-TASK-03', title: 'c', status: 'pending' },
    ]);
    const r = runCrctl(['task', 'done', 'CR-T1', '--task', 'CR-T1-TASK-02', '--workspace', ws]);
    assert.equal(r.status, 0);
    const idx = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml'), 'utf8');
    assert.match(idx, /- id: CR-T1-TASK-02\n    title: b\n    status: done/);
    assert.ok(idx.includes('- id: CR-T1-TASK-03'), 'TASK-03 块必须保持独立（不得与 TASK-02 尾行粘连）');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('task done：非 developing 态非零退出（ILLEGAL_LEDGER_STATE）且无写（AC-5）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'requirement-approved');
    writeTaskIndex(ws, 'CR-T1', [{ id: 'CR-T1-TASK-01', title: 'x', status: 'pending' }]);
    const before = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml'), 'utf8');
    const r = runCrctl(['task', 'done', 'CR-T1', '--task', 'CR-T1-TASK-01', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'ILLEGAL_LEDGER_STATE');
    assert.equal(readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml'), 'utf8'), before);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});


// ── CR-2026-027 TASK-06：三终态 / 中文 reason / 收件人矩阵 ────────────


test('TASK-10：旧 casWriteMulti/tryCasWriteMulti 与专属 fault point 已删除', () => {
  const crctlSrc = readFileSync(CRCTL, 'utf8');
  const durableSrc = readFileSync(path.join(path.dirname(CRCTL), 'lib', 'durable-tx.mjs'), 'utf8');
  assert.doesNotMatch(crctlSrc, /\b(?:try)?casWriteMulti\b/);
  assert.doesNotMatch(durableSrc, /ledger-cas-multi-between-rename/);
  assert.match(crctlSrc, /beginLedgerCommand/);
  assert.match(durableSrc, /recoverLedgerTransaction/);
});

test('AC-9：merge-tree 对 _backlog.yml 零冲突（分支推进只写 cr.md，master 注册新 CR）（FR-7/AC-7）', () => {
  const ws = makeWorkspace();
  try {
    const git = (args) => {
      const r = spawnSync('git', ['-C', ws, ...args], { encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
      return (r.stdout || '').trim();
    };
    git(['init', '-b', 'master']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 'tester']);
    writeFileSync(path.join(ws, 'change-requests', '_backlog.yml'),
      'change-requests:\n  - id: CR-X\n    title: x\n  - id: CR-Y\n    title: y\n');
    mkdirSync(path.join(ws, 'change-requests', 'CR-X'), { recursive: true });
    writeFileSync(path.join(ws, 'change-requests', 'CR-X', 'cr.md'), '---\nid: CR-X\nstatus: drafting\n---\n');
    mkdirSync(path.join(ws, 'change-requests', 'CR-Y'), { recursive: true });
    writeFileSync(path.join(ws, 'change-requests', 'CR-Y', 'cr.md'), '---\nid: CR-Y\nstatus: drafting\n---\n');
    git(['add', '-A']);
    git(['commit', '-m', 'init: register CR-X and CR-Y']);
    git(['checkout', '-b', 'requirement/CR-X']);
    for (let i = 1; i <= 3; i++) {
      writeFileSync(path.join(ws, 'change-requests', 'CR-X', 'cr.md'),
        `---\nid: CR-X\nstatus: developing\nupdated-at: "2026-08-04T${15 + i}:00:00+08:00"\n---\n`);
      git(['add', '-A']);
      git(['commit', '-m', `[cr] status CR-X advance-${i}`]);
    }
    git(['checkout', 'master']);
    writeFileSync(path.join(ws, 'change-requests', '_backlog.yml'),
      'change-requests:\n  - id: CR-X\n    title: x\n  - id: CR-Y\n    title: y\n  - id: CR-Z\n    title: z\n');
    mkdirSync(path.join(ws, 'change-requests', 'CR-Z'), { recursive: true });
    writeFileSync(path.join(ws, 'change-requests', 'CR-Z', 'cr.md'), '---\nid: CR-Z\nstatus: drafting\n---\n');
    git(['add', '-A']);
    git(['commit', '-m', '[cr] register CR-Z']);
    const r = spawnSync('git', ['-C', ws, 'merge-tree', '--write-tree', 'master', 'requirement/CR-X'], { encoding: 'utf8' });
    const output = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, `merge-tree 应无冲突 exit 0，实际 exit ${r.status}:\n${output.slice(0, 800)}`);
    assert.ok(!(output.includes('_backlog.yml') && output.includes('CONFLICT')), `_backlog.yml 不应有冲突:\n${output.slice(0, 800)}`);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-020 复盘落地：漂移治理轻量修复（FR-2 分叉检测 / FR-4 spec-id fail-fast / FR-5 修复指引 / FR-8 branch 契约） ──

test('FR-4：advance 到需 specs 落点的目标态却缺 --spec-id → 命令入口 BAD_ARGS fail-fast，cr.md 未推进', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'merging');
    // merging -> writing-back（trigger writeback-prd-sdd）门禁需 specs/{spec}/PRD.md 等
    const r = runCrctl(['advance', 'CR-T1', '--to', 'writing-back', '--trigger', 'writeback-prd-sdd', '--workspace', ws, '--no-commit']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'BAD_ARGS');
    assert.match(r.stderr.error.message, /--spec-id/);
    // fail-fast 在写入前：cr.md 仍为 merging
    assert.match(readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8'), /status: merging/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});


test('FR-2：主 workspace 视图陈旧、CR worktree 分支已推进 → status 报 STATUS_DIVERGED 指向 worktree', () => {
  const ws = makeWorkspace();
  const wt = ws + '-wt';
  const git = (args) => spawnSync('git', ['-C', ws, ...args], { encoding: 'utf8' });
  try {
    assert.equal(git(['init', '-b', 'master']).status, 0);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 'tester']);
    writeCrEntry(ws, 'CR-T1', 'drafting');
    git(['add', '-A']);
    git(['commit', '-m', 'init: register CR-T1 drafting']);
    // 建 CR worktree（分支 requirement/CR-T1），把其 cr.md 推进到 developing（模拟并行会话进度）
    const wr = git(['worktree', 'add', '-b', 'requirement/CR-T1', wt]);
    assert.equal(wr.status, 0, `worktree add 失败: ${wr.stderr}`);
    const wtCrMd = path.join(wt, 'change-requests', 'CR-T1', 'cr.md');
    writeFileSync(wtCrMd, readFileSync(wtCrMd, 'utf8').replace('status: drafting', 'status: developing'));
    // 从主 workspace 读 status：视图 drafting，但应告警 worktree 已 developing
    const r = runCrctl(['status', 'CR-T1', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.status, 'drafting');
    const div = (r.stdout.warnings || []).find((w) => w.code === 'STATUS_DIVERGED');
    assert.ok(div, `期望 STATUS_DIVERGED，实际 warnings=${JSON.stringify(r.stdout.warnings)}`);
    assert.match(div.message, /requirement\/CR-T1/);
    assert.match(div.message, /developing/);
  } finally {
    spawnSync('git', ['-C', ws, 'worktree', 'remove', '--force', wt], { encoding: 'utf8' });
    rmSync(ws, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test('FR-2 回退：非 git workspace 的 status 不触发 STATUS_DIVERGED、不产生副作用（保持纯读）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    const r = runCrctl(['status', 'CR-T1', '--workspace', ws]);
    assert.equal(r.status, 0);
    const codes = (r.stdout.warnings || []).map((w) => w.code);
    assert.ok(!codes.includes('STATUS_DIVERGED'), '非 git 工作区不应有分叉告警');
    assert.ok(!existsSync(path.join(ws, '.crctl', 'audit.log')), 'status 在非 git 工作区不应写 audit.log（.git 门控命中，未触达 controlledGit）');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-021 TASK-02：review-record（S1，判断/写入分离）──────────────

function writeReviewPayload(ws, cr, stage, content) {
  const dir = path.join(ws, '.crctl', 'tmp');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'review-' + stage + '.yml');
  writeFileSync(p, content);
  return p;
}

test('review-record：tech-design stage 写入 sdd.yml（非 tech-design.yml）+ payload 删除 + 元数据 crctl 生成（AC-1）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'tech-design-review-pending');
    writeEvidence(ws, 'CR-T1', 'sdd.md', '---\nid: CR-T1-sdd\n---\n');
    const payload = writeReviewPayload(ws, 'CR-T1', 'tech-design',
      'verdict: pass\nblockers: []\ndimensions:\n  structure: ok\n  consistency: ok\nsuggestions:\n  - "abc"\n');
    const r = runCrctl(['review-record', 'CR-T1', '--stage', 'tech-design', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.op, 'review-record');
    assert.ok(r.stdout.file.replaceAll('\\', '/').endsWith('review-annotations/sdd.yml'), '应写 sdd.yml（非 tech-design.yml）: ' + r.stdout.file);
    assert.equal(existsSync(payload), false, '临时 payload 应被删除');
    const out = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'review-annotations', 'sdd.yml'), 'utf8');
    assert.ok(out.includes('verdict: pass'), 'verdict 写入');
    assert.ok(out.includes('blockers: []'), '空 blockers 用 flow 空数组');
    assert.ok(out.includes('structure: "ok"'), 'dimensions 写入');
    assert.ok(out.includes('reviewer:'), 'reviewer 由 crctl 生成');
    assert.ok(out.includes('reviewed-at:'), 'reviewed-at 由 crctl 生成');
    assert.ok(out.includes('suggestions:') && out.includes('abc'), 'suggestions 写入');
    assert.ok(out.includes('review-type: tech-design'), 'review-type 写入');
    assert.ok(out.includes('cr-id: CR-T1'), 'cr-id 写入');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review-record：verdict 非法 → SCHEMA_INVALID，不写 canonical、payload 保留', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'requirement-reviewing');
    const payload = writeReviewPayload(ws, 'CR-T1', 'requirement', 'verdict: maybe\nblockers: []\ndimensions:\n  a: b\n');
    const r = runCrctl(['review-record', 'CR-T1', '--stage', 'requirement', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'SCHEMA_INVALID');
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-T1', 'review-annotations', 'requirement.yml')), false, '不得写入 canonical');
    assert.equal(existsSync(payload), true, '非法 payload 不得被删除');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review-record：前置态非法（drafting 对 code stage）→ ILLEGAL_LEDGER_STATE，文件零变更（§0 范式；code 前置态=developing）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    const payload = writeReviewPayload(ws, 'CR-T1', 'code', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r = runCrctl(['review-record', 'CR-T1', '--stage', 'code', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'ILLEGAL_LEDGER_STATE');
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-T1', 'review-annotations', 'code.yml')), false, '前置态非法不得写文件');
    assert.equal(existsSync(payload), true, '前置态非法不得消费 payload');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review-record：未知 stage → STAGE_UNKNOWN', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'requirement-reviewing');
    const r = runCrctl(['review-record', 'CR-T1', '--stage', 'bogus', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'STAGE_UNKNOWN');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review-record：--bump-attempt 级联 attempt 记账（复用既有 bumpAttempt）', () => {
  const { ws } = makeCodeStageWorkspace();
  try {
    writeCrEntry(ws, 'CR-D1', 'developing');
    writeReviewPayload(ws, 'CR-D1', 'code', 'verdict: block\nblockers:\n  - "bug A"\ndimensions:\n  a: b\n');
    const r = runCrctl(['review-record', 'CR-D1', '--stage', 'code', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.attempt.current, 1, 'attempt 级联为 1');
    const loop = readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'review-loop.yml'), 'utf8');
    assert.ok(loop.includes('current-attempt: 1'), 'review-loop.yml 记账');
    assert.ok(loop.includes('review-code'), 'loop ref = review-code');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review-record：payload 缺失 → PAYLOAD_NOT_FOUND', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'requirement-reviewing');
    const r = runCrctl(['review-record', 'CR-T1', '--stage', 'requirement', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'PAYLOAD_NOT_FOUND');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-021 TASK-03：review-note（S2，supplemental-reviews 追加）─────

test('review-note：无 approval.yml 时创建文件并写入 supplemental-reviews（AC-2）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    const r = runCrctl(['review-note', 'CR-T1', '--stage', 'code', '--note', '补充意见', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.op, 'review-note');
    const out = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'approval.yml'), 'utf8');
    assert.ok(out.includes('supplemental-reviews:'), '创建 supplemental-reviews 段');
    assert.ok(out.includes('decision: note'), 'decision=note');
    assert.ok(out.includes('notes: "补充意见"'), 'notes 写入');
    assert.ok(out.includes('status-at-record: developing'), 'status-at-record 写入');
    assert.ok(out.includes('reviewer:') && out.includes('recorded-at:'), '身份/时间戳由 crctl 生成');
    assert.ok(!out.includes('requirement:'), '不得写入审批段');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review-note：已有四审批段时追加，四段本体零改动（安全边界）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    writeApprovalYml(ws, 'CR-T1', 'code', { approver: 'Human', 'approved-at': '2026-08-04T12:00:00+08:00', via: 'crctl-approve' });
    const before = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'approval.yml'), 'utf8');
    const r = runCrctl(['review-note', 'CR-T1', '--note', '追加意见', '--workspace', ws]);
    assert.equal(r.status, 0);
    const after = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'approval.yml'), 'utf8');
    assert.ok(after.includes('supplemental-reviews:'), '追加 supplemental-reviews 段');
    assert.ok(after.includes('追加意见'), 'notes 存在');
    assert.ok(after.includes('code:\n  approver: "Human"'), 'code 审批段本体不变');
    assert.ok(after.startsWith(before.trimEnd()), '既有内容原样保留（追加在尾部）');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review-note：--by 传入 → BAD_ARGS 拒绝（非静默忽略，AC-2）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    const r = runCrctl(['review-note', 'CR-T1', '--note', 'x', '--by', 'Someone', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'BAD_ARGS');
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-T1', 'approval.yml')), false, '拒绝后不得写文件');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review-note：终态（archived）→ ILLEGAL_LEDGER_STATE，文件零变更', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'archived');
    const r = runCrctl(['review-note', 'CR-T1', '--note', 'x', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'ILLEGAL_LEDGER_STATE');
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-T1', 'approval.yml')), false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review-note：同一文件二次追加 → 两条记录共存（数组追加语义）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    assert.equal(runCrctl(['review-note', 'CR-T1', '--note', '意见一', '--workspace', ws]).status, 0);
    assert.equal(runCrctl(['review-note', 'CR-T1', '--note', '意见二', '--workspace', ws]).status, 0);
    const out = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'approval.yml'), 'utf8');
    const count = (out.match(/decision: note/g) || []).length;
    assert.equal(count, 2, '两条补充审查记录共存');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-021 TASK-04：owner-set / backlog-set（S4/S5）；checkpoint-add 已随 CR-2026-033 删除，checkpoint 深原语测试见 checkpoint-tx.test.mjs ──

test('owner-set：更新 owners.{role}.id + assigned-at（AC-3）', () => {
  const ws = makeGitWorkspace();
  try {
    // CR-2026-030 TASK-03：owner-set 收敛为正式移交原语——需要真实 git 仓 + 双投影一致的完整 Owner fixture
    writeOwnerEntry(ws, 'CR-T1', 'drafting');
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-m', '[cr] seed']);
    const r = runCrctl(['owner-set', 'CR-T1', '--role', 'development', '--id', 'Alice', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.changed, true);
    const out = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.ok(out.includes('id: Alice'), '新负责人写入 backlog');
    assert.ok(out.match(/assigned-at: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00"/), 'assigned-at 由 crctl 生成');
    assert.ok(out.includes('id: Ray'), '其他角色 owner 不受影响');
    const md = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8');
    assert.ok(md.includes('id: Alice'), '新负责人同步写入 cr.md（双投影）');
    assert.ok(md.includes('reason: formal-handover'), 'owner-history 追加一条正式移交');
    assert.ok(/^updated: "\d{4}-\d{2}-\d{2}T/m.test(md), 'owner-set 刷新单一 updated（CR-2026-039 TASK-03）');
    assert.ok(!md.includes('updated-at'), '不得双字段共存');
    assert.ok(r.stdout.commit && r.stdout.commit.sha, '形成隔离 commit');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('owner-set：非法 role → BAD_ARGS；终态 → ILLEGAL_LEDGER_STATE', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    const r1 = runCrctl(['owner-set', 'CR-T1', '--role', 'bogus', '--id', 'X', '--workspace', ws]);
    assert.equal(r1.status, 1);
    assert.equal(r1.stderr.error.code, 'BAD_ARGS');
    writeCrEntry(ws, 'CR-T2', 'archived');
    const r2 = runCrctl(['owner-set', 'CR-T2', '--role', 'requirement', '--id', 'X', '--workspace', ws]);
    assert.equal(r2.status, 1);
    assert.equal(r2.stderr.error.code, 'ILLEGAL_LEDGER_STATE');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('backlog-set：prd-path 白名单写入（AC-3）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    const r = runCrctl(['backlog-set', 'CR-T1', '--field', 'prd-path', '--value', 'change-requests/CR-T1/prd.md', '--workspace', ws]);
    assert.equal(r.status, 0);
    const out = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.ok(out.includes('prd-path: "change-requests/CR-T1/prd.md"'), 'prd-path 写入');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('backlog-set：status 硬拒 → FIELD_NOT_ALLOWED（AC-3）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    const before = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const r = runCrctl(['backlog-set', 'CR-T1', '--field', 'status', '--value', 'archived', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'FIELD_NOT_ALLOWED');
    assert.ok(String(r.stderr.error.message).includes('advance'), '提示改用 advance');
    assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), before);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-021 TASK-05：inbox-emit（notify-log 事件追加）──

test('inbox-emit：notify-log 追加 + notify-pending 合并去重（AC-5 对应）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    const r1 = runCrctl(['inbox-emit', 'CR-T1', '--event', 'code-reviewing', '--to', '["Ray","Alice"]', '--workspace', ws]);
    assert.equal(r1.status, 0);
    const r2 = runCrctl(['inbox-emit', 'CR-T1', '--event', 'code-approved', '--to', 'Alice,Bob', '--payload', '{"decision":"approve"}', '--workspace', ws]);
    assert.equal(r2.status, 0);
    const out = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.ok(out.includes('notify-log:'), 'notify-log 段创建');
    assert.equal((out.match(/handled: false/g) || []).length, 2, '两条 notify-log 条目');
    assert.ok(out.includes('event: code-reviewing') && out.includes('event: code-approved'), '事件写入');
    assert.ok(out.includes('payload: {"decision":"approve"}'), 'payload 写入');
    assert.ok(out.includes('notify-pending: ["Ray","Alice","Bob"]'), 'notify-pending 合并且去重');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('inbox-emit：终态（archived）→ ILLEGAL_LEDGER_STATE 零写', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'archived');
    const before = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const r = runCrctl(['inbox-emit', 'CR-T1', '--event', 'archived', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'ILLEGAL_LEDGER_STATE');
    assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), before);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('inbox-emit：缺 --event → BAD_ARGS；--payload 非法 JSON → BAD_ARGS', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    const r1 = runCrctl(['inbox-emit', 'CR-T1', '--workspace', ws]);
    assert.equal(r1.status, 1);
    assert.equal(r1.stderr.error.code, 'BAD_ARGS');
    const r2 = runCrctl(['inbox-emit', 'CR-T1', '--event', 'x', '--payload', 'not-json', '--workspace', ws]);
    assert.equal(r2.status, 1);
    assert.equal(r2.stderr.error.code, 'BAD_ARGS');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});


test('report：状态直方图 + 周期活动计数（AC-6）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    writeCrEntry(ws, 'CR-T2', 'drafting');
    writeFileSync(path.join(ws, 'change-requests', '_history.yml'),
      'history:\n  - id: CR-OLD\n    final-status: archived\n    archived-at: "2026-08-03T10:00:00+08:00"\n');
    const r = runCrctl(['report', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.op, 'report');
    assert.equal(r.stdout.active, 2, '在途 2 个');
    assert.equal(r.stdout.archived, 1, '归档 1 个');
    assert.equal(r.stdout.statusHistogram.developing, 1);
    assert.equal(r.stdout.statusHistogram.drafting, 1);
    assert.equal(r.stdout.statusHistogram.archived, 1);
    assert.equal(r.stdout.period, null, '未传 --period 时回显 null');
    assert.equal(r.stdout.periodActivity.byDay['2026-08-03'], 1, '按日活动计数');
    assert.equal(r.stdout.periodActivity.byMonth['2026-08'], 1, '按月活动计数');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('report --period：真正按窗口过滤 periodActivity（窗口外不计入，累计总数不受影响，AC-6）', () => {
  const ws = makeWorkspace();
  try {
    // 本地日历日（与 crctl.mjs periodCutoffDay 的 getFullYear/getMonth/getDate 口径一致，避免 UTC/本地时区错位导致的边界闪烁）
    const fmt = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const today = new Date();
    const recent = fmt(today); // 窗口内
    const old = fmt(new Date(today.getTime() - 400 * 86400000)); // 远早于任何 <90d 窗口
    writeFileSync(path.join(ws, 'change-requests', '_history.yml'),
      `history:\n  - id: CR-OLD\n    final-status: archived\n    archived-at: "${old}T10:00:00+08:00"\n` +
      `  - id: CR-NEW\n    final-status: archived\n    archived-at: "${recent}T10:00:00+08:00"\n`);
    const rNoPeriod = runCrctl(['report', '--workspace', ws]);
    assert.equal(rNoPeriod.stdout.archived, 2, '无 --period 时累计总数含全部历史');
    assert.equal(rNoPeriod.stdout.periodActivity.byDay[old], 1, '无 --period 时窗口外的一天也计入 periodActivity');
    const rPeriod = runCrctl(['report', '--period', '7d', '--workspace', ws]);
    assert.equal(rPeriod.status, 0);
    assert.equal(rPeriod.stdout.period, '7d');
    assert.equal(rPeriod.stdout.archived, 2, '--period 不影响累计总数（SLA/直方图口径）');
    assert.equal(rPeriod.stdout.periodActivity.byDay[recent], 1, '窗口内的一天计入 periodActivity');
    assert.equal(rPeriod.stdout.periodActivity.byDay[old], undefined, '窗口外的一天被 --period 过滤，不再计入 periodActivity');
    const rBad = runCrctl(['report', '--period', 'not-a-period', '--workspace', ws]);
    assert.equal(rBad.status, 1);
    assert.equal(rBad.stderr.error.code, 'BAD_ARGS', '非法 --period 格式硬拒，而非静默忽略');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});


// ── CR-2026-022 TASK-06：approve 驳回回退转换（FR-12，D-1 + B3）──

test('approve 驳回回退：四 stage 状态机声明 reject 转换（status legalNext 可见）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R', 'requirement-reviewing');
    const r1 = runCrctl(['status', 'CR-R', '--workspace', ws]);
    assert.equal(r1.status, 0);
    assert.ok(r1.stdout.legalNext.some((t) => t.trigger === 'approve-requirement:reject -> write-requirement-prd' && t.to === 'drafting'), '需求驳回回退 drafting（D-1）');
    writeCrEntry(ws, 'CR-D', 'task-breakdown');
    const r2 = runCrctl(['status', 'CR-D', '--workspace', ws]);
    assert.equal(r2.status, 0);
    assert.ok(r2.stdout.legalNext.some((t) => t.trigger === 'approve-dev-start:reject -> write-dev-plan' && t.to === 'tech-design-reviewed'), '开发启动驳回回退 tech-design-reviewed（B3）');
    writeCrEntry(ws, 'CR-T', 'tech-design-review-pending');
    const r3 = runCrctl(['status', 'CR-T', '--workspace', ws]);
    assert.ok(r3.stdout.legalNext.some((t) => t.trigger === 'approve-tech-design:reject -> write-tech-design'), '技术设计驳回回退既有转换');
    writeCrEntry(ws, 'CR-C', 'code-reviewing');
    const r4 = runCrctl(['status', 'CR-C', '--workspace', ws]);
    assert.ok(r4.stdout.legalNext.some((t) => t.trigger === 'approve-code:reject -> implement-code'), '代码驳回回退既有转换');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-022 TASK-13：cmdNext writing-back 改查 specs 产物（FR-21）──

test('cmdNext writing-back：specs/ 唯一目录且 traceability.yml 存在才建议可归档（FR-21）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-W', 'writing-back');
    mkdirSync(path.join(ws, 'change-requests', 'CR-W'), { recursive: true });
    writeFileSync(path.join(ws, 'change-requests', 'CR-W', 'traceability.yml'), 'cr-id: CR-W\n'); // 开发期工作稿（旧逻辑误判依据）
    // 无 specs/ 目录 → 建议先回写，不判可归档
    const r1 = runCrctl(['next', 'CR-W', '--workspace', ws]);
    assert.equal(r1.status, 0);
    assert.notEqual(r1.stdout.next, 'cr-archive', '无 specs 目录不得建议归档');
    // 唯一 specs 子目录但无 traceability.yml → 建议回写链
    mkdirSync(path.join(ws, 'specs', 'ai-first-platform'), { recursive: true });
    const r2 = runCrctl(['next', 'CR-W', '--workspace', ws]);
    assert.notEqual(r2.stdout.next, 'cr-archive');
    // writeback 产物就位 → 建议 cr-archive
    writeFileSync(path.join(ws, 'specs', 'ai-first-platform', 'traceability.yml'), 'cr-id: CR-W\n');
    const r3 = runCrctl(['next', 'CR-W', '--workspace', ws]);
    assert.equal(r3.stdout.next, 'cr-archive', 'specs 追溯链就位方可归档');
    // 多 specs 子目录 → 显式报错不猜
    mkdirSync(path.join(ws, 'specs', 'another'), { recursive: true });
    const r4 = runCrctl(['next', 'CR-W', '--workspace', ws]);
    assert.notEqual(r4.stdout.next, 'cr-archive', '多 spec 目录不得猜测');
    assert.ok(r4.stdout.why.includes('无法唯一确定 spec_id'), 'why 显式说明多目录');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-025 TASK-01：task done depends-on 一跳依赖守卫（FR-6/FR-7/FR-10，SDD §4.2） ──

function writeRawTaskIndex(ws, cr, text) {
  const dir = path.join(ws, 'change-requests', cr, 'tasks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '_index.yml'), text);
  return path.join(dir, '_index.yml');
}

test('CR-2026-025 守卫①：前置未 done → DEPENDS_ON_NOT_DONE，退出非 0 且 _index.yml 未变（AC-7，不带引号形态）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-G1', 'developing');
    const p = writeRawTaskIndex(ws, 'CR-G1', [
      'cr-ref: CR-G1', 'tasks:',
      '  - id: CR-G1-TASK-01', '    status: pending', '    depends-on: []',
      '  - id: CR-G1-TASK-02', '    status: pending', '    depends-on: [CR-G1-TASK-01]',
    ].join('\n') + '\n');
    const before = readFileSync(p, 'utf8');
    const r = runCrctl(['task', 'done', 'CR-G1', '--task', 'CR-G1-TASK-02', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'DEPENDS_ON_NOT_DONE');
    assert.deepEqual(r.stderr.error.notDone, [{ id: 'CR-G1-TASK-01', status: 'pending' }]);
    assert.match(r.stderr.error.message, /若前置互相等待，检查 depends-on 是否成环/);
    assert.equal(readFileSync(p, 'utf8'), before);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 守卫②：前置全 done → 正常写入 status: done 与 done-at（AC-8）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-G1', 'developing');
    writeRawTaskIndex(ws, 'CR-G1', [
      'cr-ref: CR-G1', 'tasks:',
      '  - id: CR-G1-TASK-01', '    status: done', '    done-at: "2026-08-09T01:00:00+08:00"', '    depends-on: []',
      '  - id: CR-G1-TASK-02', '    status: pending', '    depends-on: [CR-G1-TASK-01]',
    ].join('\n') + '\n');
    const r = runCrctl(['task', 'done', 'CR-G1', '--task', 'CR-G1-TASK-02', '--workspace', ws]);
    assert.equal(r.status, 0);
    const idx = readFileSync(path.join(ws, 'change-requests', 'CR-G1', 'tasks', '_index.yml'), 'utf8');
    assert.match(idx, /- id: CR-G1-TASK-02\n    status: done\n    done-at:/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 守卫③：depends-on 缺失与空数组均放行（AC-9，D-5）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-G1', 'developing');
    writeRawTaskIndex(ws, 'CR-G1', [
      'cr-ref: CR-G1', 'tasks:',
      '  - id: CR-G1-TASK-01', '    status: pending',   // 缺失字段是任务登记的正常形态（B-8）
      '  - id: CR-G1-TASK-02', '    status: pending', '    depends-on: []',
    ].join('\n') + '\n');
    const r1 = runCrctl(['task', 'done', 'CR-G1', '--task', 'CR-G1-TASK-01', '--workspace', ws]);
    assert.equal(r1.status, 0);
    const r2 = runCrctl(['task', 'done', 'CR-G1', '--task', 'CR-G1-TASK-02', '--workspace', ws]);
    assert.equal(r2.status, 0);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 守卫④：depends-on 指向不存在 TASK → DEPENDS_ON_UNKNOWN（AC-9，FR-7）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-G1', 'developing');
    writeRawTaskIndex(ws, 'CR-G1', [
      'cr-ref: CR-G1', 'tasks:',
      '  - id: CR-G1-TASK-01', '    status: pending', '    depends-on: [CR-G1-TASK-99]',
    ].join('\n') + '\n');
    const r = runCrctl(['task', 'done', 'CR-G1', '--task', 'CR-G1-TASK-01', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'DEPENDS_ON_UNKNOWN');
    assert.deepEqual(r.stderr.error.unknown, ['CR-G1-TASK-99']);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 守卫⑤：带引号 ["ID"] 形态与不带引号等价（FR-10⑤，钉 parseYaml unquote）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-G1', 'developing');
    writeRawTaskIndex(ws, 'CR-G1', [
      'cr-ref: CR-G1', 'tasks:',
      '  - id: CR-G1-TASK-01', '    status: pending', '    depends-on: []',
      '  - id: CR-G1-TASK-02', '    status: pending', '    depends-on: ["CR-G1-TASK-01"]',
    ].join('\n') + '\n');
    const r = runCrctl(['task', 'done', 'CR-G1', '--task', 'CR-G1-TASK-02', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'DEPENDS_ON_NOT_DONE');
    assert.deepEqual(r.stderr.error.notDone, [{ id: 'CR-G1-TASK-01', status: 'pending' }]);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 守卫⑥：depends-on 非数组形态 → 复用 SCHEMA_INVALID，不新增错误码（TD-BL-3）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-G1', 'developing');
    writeRawTaskIndex(ws, 'CR-G1', [
      'cr-ref: CR-G1', 'tasks:',
      '  - id: CR-G1-TASK-01', '    status: pending', '    depends-on: CR-G1-TASK-99',
    ].join('\n') + '\n');
    const r = runCrctl(['task', 'done', 'CR-G1', '--task', 'CR-G1-TASK-01', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'SCHEMA_INVALID');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 守卫⑦：环 A→B→A 与自引用 A→A 均有限时间返回 DEPENDS_ON_NOT_DONE（AC-10，D-6 一跳天然挡环）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-G1', 'developing');
    writeRawTaskIndex(ws, 'CR-G1', [
      'cr-ref: CR-G1', 'tasks:',
      '  - id: CR-G1-TASK-A', '    status: pending', '    depends-on: [CR-G1-TASK-B]',
      '  - id: CR-G1-TASK-B', '    status: pending', '    depends-on: [CR-G1-TASK-A]',
      '  - id: CR-G1-TASK-S', '    status: pending', '    depends-on: [CR-G1-TASK-S]',
    ].join('\n') + '\n');
    const rA = runCrctl(['task', 'done', 'CR-G1', '--task', 'CR-G1-TASK-A', '--workspace', ws]);
    assert.equal(rA.status, 1);
    assert.equal(rA.stderr.error.code, 'DEPENDS_ON_NOT_DONE');
    const rS = runCrctl(['task', 'done', 'CR-G1', '--task', 'CR-G1-TASK-S', '--workspace', ws]);
    assert.equal(rS.status, 1);
    assert.equal(rS.stderr.error.code, 'DEPENDS_ON_NOT_DONE');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-025 TASK-02：isEmpty 失败回显收敛（FR-11~FR-15，SDD §4.3） ──
// fixture：passCondition 判据运行时读自 pipeline JSON（B-15），测试仓内写最小
// requirement-authoring.pipeline.json；状态机复制 2 条所需转换（fixture 自含，不碰权威源）。

const LONG_BLOCKERS = Array.from({ length: 7 }, (_, i) => `超长blocker-${i}-` + 'x'.repeat(500));
const LONG_ANNOTATION = 'verdict: block\nblockers:\n' + LONG_BLOCKERS.map((b) => `  - "${b}"`).join('\n') + '\n';

function setupBriefWs(cr, status, annotation) {
  const ws = makeWorkspace();
  // 定制 tools fixture（CR-2026-028 FR-1：配置来源收敛后，pipeline 与状态机从 Tools Root 读）
  const fixture = path.join(ws, '_fixture-tools');
  mkdirSync(path.join(fixture, 'skills', 'shared', 'crctl', 'scripts'), { recursive: true });
  writeFileSync(path.join(fixture, 'AGENTS.md'), '# fixture tools\n', 'utf8');
  writeFileSync(path.join(fixture, 'skills', '_index.yml'), 'skills: []\n', 'utf8');
  writeFileSync(path.join(fixture, 'skills', 'shared', 'crctl', 'scripts', 'crctl.mjs'), '// marker\n', 'utf8');
  writeFileSync(path.join(fixture, 'skills', 'shared', 'crctl', 'gates.json'), JSON.stringify(BRIEF_GATES), 'utf8');
  mkdirSync(path.join(fixture, 'pipeline-templates'), { recursive: true });
  writeFileSync(path.join(fixture, 'dir-graph.yaml'), [
    'change-request-track:',
    '  state_machine:',
    '    field: "status"',
    '    transitions:',
    '      - { from: drafting, to: requirement-reviewing, trigger: "review-requirement" }',
    '      - { from: requirement-reviewing, to: requirement-approved, trigger: "approve-requirement" }',
  ].join('\n') + '\n');
  writeFileSync(path.join(fixture, 'pipeline-templates', 'requirement-authoring.pipeline.json'), JSON.stringify({
    id: 'requirement-authoring',
    nodes: [{ ref: 'review-requirement', reviewLoop: { maxAttempts: 3, passCondition: { allOf: [
      { path: 'verdict', equals: 'pass' }, { path: 'blockers', isEmpty: true } ] } } }],
  }));
  writeFileSync(path.join(ws, 'dir-graph.yaml'),
    `workspace:\n  tools_package_path: ${JSON.stringify(fixture)}\n`, 'utf8');
  writeCrEntry(ws, cr, status);
  writeEvidence(ws, cr, 'prd.md', '# prd\n');
  if (annotation != null) writeEvidence(ws, cr, 'review-annotations/requirement.yml', annotation);
  return ws;
}

test('CR-2026-025 回显①②③④：gate 超长 blockers → actual 数组截断、why 条数指针、无原文（AC-12）', () => {
  const ws = setupBriefWs('CR-B1', 'drafting', LONG_ANNOTATION);
  try {
    const r = runCrctl(['gate', 'CR-B1', '--for', 'requirement-reviewing', '--workspace', ws]);
    assert.equal(r.status, 1);
    const pc = r.stdout.checks.find((c) => c.type === 'passCondition');
    assert.equal(pc.ok, false);
    const isEmptyDetail = pc.detail.find((d) => d.cond && d.cond.isEmpty === true && !d.ok);
    assert.ok(Array.isArray(isEmptyDetail.actual), 'actual 必须仍是数组（FR-13/NFR-3）');
    assert.equal(isEmptyDetail.actual.length, 7);
    for (const item of isEmptyDetail.actual) assert.ok(item.length <= 120 + 12, `每项 ≤ ITEM_MAX+后缀：${item.length}`);
    assert.match(isEmptyDetail.actual[0], /^超长blocker-0-x{20,}…\(\+\d+字\)$/);
    assert.match(isEmptyDetail.why, /^期望 blockers 为空，实际 7 条（详见 /);
    for (const b of LONG_BLOCKERS) assert.ok(!JSON.stringify(pc.detail).includes(b), 'detail 不得含任一完整原文');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 回显④：失败的 advance → GATE_BLOCKED message 不含 blocker 原文（AC-13）', () => {
  const ws = setupBriefWs('CR-B1', 'requirement-reviewing', LONG_ANNOTATION);
  try {
    const r = runCrctl(['advance', 'CR-B1', '--to', 'requirement-approved', '--trigger', 'approve-requirement', '--no-commit', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'GATE_BLOCKED');
    for (const b of LONG_BLOCKERS) assert.ok(!r.stderr.error.message.includes(b), 'message 不得含 blocker 原文');
    const gate = r.stderr.error.gate;
    const pc = gate.checks.find((c) => c.type === 'passCondition');
    const isEmptyDetail = pc.detail.find((d) => d.cond && d.cond.isEmpty === true && !d.ok);
    assert.ok(Array.isArray(isEmptyDetail.actual) && isEmptyDetail.actual.length === 7);
    assert.match(isEmptyDetail.why, /实际 7 条（详见/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 回显⑤：标量 equals 失败输出与改动前一致（D-9 零变化）', () => {
  const ws = setupBriefWs('CR-B1', 'drafting', 'verdict: block\nblockers: []\n');
  try {
    const r = runCrctl(['gate', 'CR-B1', '--for', 'requirement-reviewing', '--workspace', ws]);
    assert.equal(r.status, 1);
    const pc = r.stdout.checks.find((c) => c.type === 'passCondition');
    const eqDetail = pc.detail.find((d) => d.cond && 'equals' in d.cond && !d.ok);
    assert.equal(eqDetail.actual, 'block');
    assert.equal(eqDetail.why, '期望 verdict=pass，实际 "block"');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 回显⑥：标量 isEmpty 失败路径保持现状（非数组不走截断，D-9）', () => {
  const ws = setupBriefWs('CR-B1', 'drafting', 'verdict: pass\nblockers: "not-empty-scalar"\n');
  try {
    const r = runCrctl(['gate', 'CR-B1', '--for', 'requirement-reviewing', '--workspace', ws]);
    assert.equal(r.status, 1);
    const pc = r.stdout.checks.find((c) => c.type === 'passCondition');
    const isEmptyDetail = pc.detail.find((d) => d.cond && d.cond.isEmpty === true && !d.ok);
    assert.equal(isEmptyDetail.actual, 'not-empty-scalar');
    assert.equal(isEmptyDetail.why, '期望 blockers 为空，实际 "not-empty-scalar"');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 回显⑦：blockers 空数组 → isEmpty 通过（收敛不得影响判定本身）', () => {
  const ws = setupBriefWs('CR-B1', 'drafting', 'verdict: pass\nblockers: []\n');
  try {
    const r = runCrctl(['gate', 'CR-B1', '--for', 'requirement-reviewing', '--workspace', ws]);
    assert.equal(r.status, 0);
    const pc = r.stdout.checks.find((c) => c.type === 'passCondition');
    assert.equal(pc.ok, true);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-025 TASK-03：review-record 三账本一致写 + cmdNext drafting 路由（FR-16~FR-21，SDD §4.4） ──
// 说明：④的 CAS 注入失败黑盒无法构造读后改时序，沿用 CR-2026-019 先例——
// durable ledger transaction 原子语义已有 fault-harness 向量兜底，此处覆盖前置结构错误的零写入。

function writePrd(ws, cr, content) { return writeEvidence(ws, cr, 'prd.md', content); }
function readTrace(ws, cr) { return readFileSync(path.join(ws, 'change-requests', cr, 'traceability.yml'), 'utf8'); }

test('CR-2026-025 投影①a：requirement 非 bump + current-attempt=0 → 投影空 attempts，不伪造 attempt=1（plan v0.1.1）+ subject 摘要', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R1', 'drafting');
    writePrd(ws, 'CR-R1', '# prd body\n');
    writeReviewPayload(ws, 'CR-R1', 'requirement', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r = runCrctl(['review-record', 'CR-R1', '--stage', 'requirement', '--workspace', ws]);
    assert.equal(r.status, 0);
    const ann = readFileSync(path.join(ws, 'change-requests', 'CR-R1', 'review-annotations', 'requirement.yml'), 'utf8');
    assert.match(ann, /^subject-file: change-requests\/CR-R1\/prd.md$/m);
    assert.match(ann, /^subject-sha256: [0-9a-f]{64}$/m);
    const tr = readTrace(ws, 'CR-R1');
    assert.match(tr, /^cr-id: CR-R1$/m);
    assert.match(tr, /^  requirement:$/m);
    assert.match(tr, /^      current-attempt: 0$/m);
    assert.match(tr, /^      attempts: \[\]$/m);
    assert.ok(!tr.includes('repair-target:'), 'pass 轨顶层省略 repair-target（CR-2026-027 FR-13 真值表）');
    assert.ok(!existsSync(path.join(ws, 'change-requests', 'CR-R1', 'review-loop.yml')), '非 bump 不创建 review-loop.yml');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 投影①b：tech-design 与 code stage 同构投影（repair-target 分别为 write-tech-design / implement-code）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R1', 'tech-design-review-pending');
    writeEvidence(ws, 'CR-R1', 'sdd.md', '---\nid: CR-R1-sdd\n---\n');
    writeReviewPayload(ws, 'CR-R1', 'tech-design', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r1 = runCrctl(['review-record', 'CR-R1', '--stage', 'tech-design', '--workspace', ws]);
    assert.equal(r1.status, 0);
    let tr = readTrace(ws, 'CR-R1');
    assert.match(tr, /^  tech-design:$/m);
    assert.match(tr, /^    annotation: "change-requests\/CR-R1\/review-annotations\/sdd.yml"$/m);
    assert.ok(!tr.includes('repair-target:'), 'pass 轨顶层省略 repair-target（CR-2026-027 FR-13 真值表）');
    // subject-sha256 在 annotation（sdd.yml）而非 trace 投影（CR-2026-027 FR-16）
    const sddAnn = readFileSync(path.join(ws, 'change-requests', 'CR-R1', 'review-annotations', 'sdd.yml'), 'utf8');
    assert.ok(sddAnn.includes('subject-file: change-requests/CR-R1/sdd.md'), 'annotation 应含 subject-file');
    assert.ok(sddAnn.includes('subject-sha256: '), 'annotation 应含 subject-sha256');
  } finally { rmSync(ws, { recursive: true, force: true }); }
  const ws2 = makeCodeStageWorkspace().ws;
  try {
    writeCrEntry(ws2, 'CR-D1', 'developing');
    writeReviewPayload(ws2, 'CR-D1', 'code', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r2 = runCrctl(['review-record', 'CR-D1', '--stage', 'code', '--workspace', ws2]);
    assert.equal(r2.status, 0, r2.rawStderr);
    const tr2 = readTrace(ws2, 'CR-D1');
    assert.match(tr2, /^  code:$/m);
    assert.ok(!tr2.includes('repair-target:'), 'pass 轨顶层省略 repair-target（CR-2026-027 FR-13 真值表）');
  } finally { rmSync(ws2, { recursive: true, force: true }); }
});

test('CR-2026-025 投影①c：trace 已有 requirement 投影时首次写 tech-design 成功（TD-BL-4 合法分支），既有块保留', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R1', 'tech-design-review-pending');
    writeEvidence(ws, 'CR-R1', 'sdd.md', '---\nid: CR-R1-sdd\n---\n');
    writeEvidence(ws, 'CR-R1', 'traceability.yml', [
      'cr-id: CR-R1', 'reviews:', '  requirement:', '    reviewer: "x"', '    verdict: pass',
      '    reviewed-at: "2026-08-09T00:00:00+08:00"', '    blocker-count: 0',
      '    annotation: "change-requests/CR-R1/review-annotations/requirement.yml"',
      '    repair-target: write-requirement-prd', '    review-loop:', '      current-attempt: 1',
      '      max-attempts: 3', '      attempts:', '        - attempt: 1',
      '          reviewed-at: "2026-08-09T00:00:00+08:00"', '          result: pass',
      '          blocker-count: 0', '          repair-target: write-requirement-prd',
    ].join('\n') + '\n');
    writeReviewPayload(ws, 'CR-R1', 'tech-design', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r = runCrctl(['review-record', 'CR-R1', '--stage', 'tech-design', '--workspace', ws]);
    assert.equal(r.status, 0, JSON.stringify(r.stderr));
    const tr = readTrace(ws, 'CR-R1');
    assert.match(tr, /^  requirement:$/m);
    assert.match(tr, /^  tech-design:$/m);
    assert.match(tr, /^    reviewer: "x"$/m, 'requirement 既有投影保留');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 投影①d：目标 stage 已存在但缺 review-loop/attempts → TRACE_SHAPE，三账本均不落盘（收紧口径，非空值兜底）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R1', 'tech-design-review-pending');
    const badTrace = 'cr-id: CR-R1\nreviews:\n  tech-design:\n    reviewer: "x"\n    verdict: pass\n';
    writeEvidence(ws, 'CR-R1', 'traceability.yml', badTrace);
    writeReviewPayload(ws, 'CR-R1', 'tech-design', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r = runCrctl(['review-record', 'CR-R1', '--stage', 'tech-design', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'TRACE_SHAPE');
    assert.equal(readTrace(ws, 'CR-R1'), badTrace, 'trace 不得变化');
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-R1', 'review-annotations', 'sdd.yml')), false, 'annotation 不得写入');
    assert.ok(existsSync(path.join(ws, '.crctl', 'tmp', 'review-tech-design.yml')), 'payload 保留供重试');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 投影②：两轮 bump 后三账本一致（attempt/verdict/blocker-count/时间），attempts 保留两轮历史', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R1', 'drafting');
    writePrd(ws, 'CR-R1', '# prd body\n');
    writeReviewPayload(ws, 'CR-R1', 'requirement', 'verdict: block\nblockers:\n  - "b1"\ndimensions:\n  a: b\n');
    assert.equal(runCrctl(['review-record', 'CR-R1', '--stage', 'requirement', '--bump-attempt', '--workspace', ws]).status, 0);
    writeReviewPayload(ws, 'CR-R1', 'requirement', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r2 = runCrctl(['review-record', 'CR-R1', '--stage', 'requirement', '--bump-attempt', '--workspace', ws]);
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout.attempt.current, 2);
    const ann = readFileSync(path.join(ws, 'change-requests', 'CR-R1', 'review-annotations', 'requirement.yml'), 'utf8');
    const loop = readFileSync(path.join(ws, 'change-requests', 'CR-R1', 'review-loop.yml'), 'utf8');
    const tr = readTrace(ws, 'CR-R1');
    const annAt = ann.match(/^reviewed-at: "(.+)"$/m)[1];
    assert.match(loop, /current-attempt: 2/);
    assert.ok(loop.includes('attempt: 1') && loop.includes('attempt: 2'), 'loop 保留两轮');
    assert.match(tr, /^      current-attempt: 2$/m);
    assert.match(tr, /^        - attempt: 1$/m);
    assert.match(tr, /^        - attempt: 2$/m);
    assert.match(tr, /^          result: block$/m);
    assert.match(tr, /^          result: pass$/m);
    assert.match(tr, /^          blocker-count: 1$/m);
    assert.match(tr, /^          blocker-count: 0$/m);
    const tryAt2 = tr.split('- attempt: 2')[1];
    assert.ok(tryAt2.includes(`reviewed-at: "${annAt}"`), 'trace 第 2 轮时间与 annotation/loop 同一 recordedAt');
    assert.ok(loop.includes(`at: "${annAt}"`), 'loop 第 2 轮时间与 annotation 一致');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 投影③：trace 缺失创建骨架；已有其他顶层段与既有 stage 时非目标文本 LF 规范化后逐字节保留（AC-19）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R1', 'tech-design-review-pending');
    writeEvidence(ws, 'CR-R1', 'sdd.md', '---\nid: CR-R1-sdd\n---\n');
    const head = '# 头部手工注释\ncr-id: CR-R1\nreviews:\n  requirement:\n    reviewer: "keep"\n    verdict: pass\ntests:\n  unit: pass\n';
    writeEvidence(ws, 'CR-R1', 'traceability.yml', head);
    writeReviewPayload(ws, 'CR-R1', 'tech-design', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r = runCrctl(['review-record', 'CR-R1', '--stage', 'tech-design', '--workspace', ws]);
    assert.equal(r.status, 0, JSON.stringify(r.stderr));
    const tr = readTrace(ws, 'CR-R1');
    assert.ok(tr.startsWith('# 头部手工注释\ncr-id: CR-R1\n'), '头部注释与 cr-id 逐字节保留');
    assert.match(tr, /^    reviewer: "keep"$/m, '既有 requirement 块保留');
    assert.match(tr, /^tests:\n  unit: pass$/m, 'tests 段保留');
    assert.match(tr, /^  tech-design:$/m);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 投影④：cr-id 不匹配 → TRACE_SHAPE，受控文件 sha256 均不变且 payload 保留（AC-20/AC-21）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R1', 'drafting');
    writePrd(ws, 'CR-R1', '# prd body\n');
    const badTrace = 'cr-id: CR-OTHER\nreviews:\n';
    writeEvidence(ws, 'CR-R1', 'traceability.yml', badTrace);
    writeReviewPayload(ws, 'CR-R1', 'requirement', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const before = sha16(badTrace);
    const r = runCrctl(['review-record', 'CR-R1', '--stage', 'requirement', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'TRACE_SHAPE');
    assert.equal(sha16(readTrace(ws, 'CR-R1')), before);
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-R1', 'review-annotations', 'requirement.yml')), false);
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-R1', 'review-loop.yml')), false);
    assert.ok(existsSync(path.join(ws, '.crctl', 'tmp', 'review-requirement.yml')), 'payload 保留');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 路由⑤⑥⑦⑧：cmdNext drafting 按摘要分流（AC-22，FR-20 决策表）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R1', 'drafting');
    const prdPath = path.join(ws, 'change-requests', 'CR-R1', 'prd.md');
    writePrd(ws, 'CR-R1', '# prd v1\n');
    writeReviewPayload(ws, 'CR-R1', 'requirement', 'verdict: block\nblockers:\n  - "b1"\ndimensions:\n  a: b\n');
    assert.equal(runCrctl(['review-record', 'CR-R1', '--stage', 'requirement', '--bump-attempt', '--workspace', ws]).status, 0);
    // ⑤ 同摘要 block → 回修
    let n = runCrctl(['next', 'CR-R1', '--workspace', ws]);
    assert.equal(n.stdout.next, 'write-requirement-prd');
    assert.match(n.stdout.why, /blockers=1/);
    // ⑦ 仅 LF/CRLF 差异不视为已回修
    writeFileSync(prdPath, '# prd v1\r\n');
    n = runCrctl(['next', 'CR-R1', '--workspace', ws]);
    assert.equal(n.stdout.next, 'write-requirement-prd');
    // ⑥ PRD 实质修改 → 重审
    writeFileSync(prdPath, '# prd v2 实质修订\n');
    n = runCrctl(['next', 'CR-R1', '--workspace', ws]);
    assert.equal(n.stdout.next, 'review-requirement');
    assert.match(n.stdout.why, /证据过时/);
    // ⑧ 无摘要旧证据 → 兼容行为 review-requirement
    writeEvidence(ws, 'CR-R1', 'review-annotations/requirement.yml', 'cr-id: CR-R1\nreview-type: requirement\nverdict: block\nblockers:\n  - "old"\n');
    n = runCrctl(['next', 'CR-R1', '--workspace', ws]);
    assert.equal(n.stdout.next, 'review-requirement');
    assert.match(n.stdout.why, /无摘要/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 路由回归：drafting 无证据/通过证据时仍建议 review-requirement（FR-20④现状保留）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R1', 'drafting');
    let n = runCrctl(['next', 'CR-R1', '--workspace', ws]);
    assert.equal(n.stdout.next, 'write-requirement-prd', 'prd 缺失 → write-requirement-prd');
    writePrd(ws, 'CR-R1', '# prd\n');
    n = runCrctl(['next', 'CR-R1', '--workspace', ws]);
    assert.equal(n.stdout.next, 'review-requirement');
    writeEvidence(ws, 'CR-R1', 'review-annotations/requirement.yml', 'cr-id: CR-R1\nverdict: pass\nblockers: []\nsubject-sha256: "deadbeef"\n');
    n = runCrctl(['next', 'CR-R1', '--workspace', ws]);
    assert.equal(n.stdout.next, 'review-requirement', 'pass 证据不算失败证据，维持现状');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-025 implement-code 回修 attempt-1：BL-1~BL-3 回归向量 ──

test('CR-2026-025 回修 BL-1：tasks 根结构缺失/非数组 → TASK_INDEX_SHAPE，退出非 0 且文件哈希不变（禁止静默降级绕过守卫）', () => {
  for (const malformed of ['cr-ref: CR-G1\n', 'cr-ref: CR-G1\ntasks: not-a-list\n']) {
    const ws = makeWorkspace();
    try {
      writeCrEntry(ws, 'CR-G1', 'developing');
      const p = writeRawTaskIndex(ws, 'CR-G1', malformed);
      const before = readFileSync(p, 'utf8');
      const r = runCrctl(['task', 'done', 'CR-G1', '--task', 'CR-G1-TASK-01', '--workspace', ws]);
      assert.equal(r.status, 1);
      assert.equal(r.stderr.error.code, 'TASK_INDEX_SHAPE');
      assert.equal(readFileSync(p, 'utf8'), before, '文件不得变化');
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
});

test('CR-2026-025 回修 BL-2：reviews.<stage>: null → TRACE_SHAPE，三账本不变且 payload 保留（仅 undefined 可首写）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R1', 'tech-design-review-pending');
    const badTrace = 'cr-id: CR-R1\nreviews:\n  tech-design: null\n';
    writeEvidence(ws, 'CR-R1', 'traceability.yml', badTrace);
    writeReviewPayload(ws, 'CR-R1', 'tech-design', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r = runCrctl(['review-record', 'CR-R1', '--stage', 'tech-design', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'TRACE_SHAPE');
    assert.equal(sha16(readTrace(ws, 'CR-R1')), sha16(badTrace));
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-R1', 'review-annotations', 'sdd.yml')), false);
    assert.ok(existsSync(path.join(ws, '.crctl', 'tmp', 'review-tech-design.yml')), 'payload 保留');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 回修 BL-3：重复顶层 reviews: 段 → TRACE_SHAPE 原子拒写（FR-18/AC-21 唯一定位）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R1', 'tech-design-review-pending');
    writeEvidence(ws, 'CR-R1', 'sdd.md', '---\nid: CR-R1-sdd\n---\n');
    const badTrace = 'cr-id: CR-R1\nreviews:\n  requirement:\n    reviewer: "x"\n    verdict: pass\nreviews:\n  requirement:\n    reviewer: "y"\n    verdict: block\n';
    writeEvidence(ws, 'CR-R1', 'traceability.yml', badTrace);
    writeReviewPayload(ws, 'CR-R1', 'tech-design', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r = runCrctl(['review-record', 'CR-R1', '--stage', 'tech-design', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'TRACE_SHAPE');
    assert.equal(sha16(readTrace(ws, 'CR-R1')), sha16(badTrace), 'trace 不得变化');
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-R1', 'review-annotations', 'sdd.yml')), false, 'annotation 不得写入');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-027 TASK-08：review-record 输出契约与 review cycle（FR-13/FR-16）──
test('CR-2026-027 FR-13：review-record 输出 files/attempt/route/repairTarget（pass 轨 route=pass 且 repairTarget=null）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    writePrd(ws, 'CR-T1', '# prd body\n');
    writeReviewPayload(ws, 'CR-T1', 'requirement', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r = runCrctl(['review-record', 'CR-T1', '--stage', 'requirement', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.deepEqual(r.stdout.attempt, { current: 0, max: 3, bumped: false });
    assert.equal(r.stdout.route, 'pass');
    assert.equal(r.stdout.repairTarget, null);
    assert.ok(Array.isArray(r.stdout.files) && r.stdout.files.length === 2, 'files 只列实际写入（annotation + traceability，未 bump 无 review-loop）');
    assert.ok(r.stdout.files.every((f) => !f.includes('review-loop.yml')), '未 bump 不得虚列 review-loop.yml');
    // 非 dev-plan block → route=repair + 默认修复目标
    writeReviewPayload(ws, 'CR-T1', 'requirement', 'verdict: block\nblockers:\n  - "b1"\ndimensions:\n  a: b\n');
    const r2 = runCrctl(['review-record', 'CR-T1', '--stage', 'requirement', '--bump-attempt', '--workspace', ws]);
    assert.equal(r2.status, 0, r2.rawStderr);
    assert.equal(r2.stdout.route, 'repair');
    assert.equal(r2.stdout.repairTarget, 'write-requirement-prd');
    assert.equal(r2.stdout.attempt.bumped, true);
    assert.ok(r2.stdout.files.some((f) => f.includes('review-loop.yml')), 'bump 时 files 含 review-loop.yml');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 FR-16：post-PASS SDD 修订 + 较新 upstream blocker → tech-design 自动开启 cycle=2/attempt=1，旧 attempts 保留', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'tech-design-review-pending');
    writeEvidence(ws, 'CR-T1', 'sdd.md', '---\nid: CR-T1-sdd\n---\nv1\n');
    // cycle 1：三轮 block（attempt 1-3 满）
    for (let i = 0; i < 3; i++) {
      writeReviewPayload(ws, 'CR-T1', 'tech-design', 'verdict: block\nblockers:\n  - "b"\ndimensions:\n  a: b\n');
      assert.equal(runCrctl(['review-record', 'CR-T1', '--stage', 'tech-design', '--bump-attempt', '--workspace', ws]).status, 0);
    }
    // cycle 1 末轮 PASS（attempt 3 刷新为 pass）
    writeReviewPayload(ws, 'CR-T1', 'tech-design', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    assert.equal(runCrctl(['review-record', 'CR-T1', '--stage', 'tech-design', '--workspace', ws]).status, 0);
    // 较新的 dev-plan upstream blocker：reviewed-at 用动态未来时间（UTC Z 偏移）——
    // epoch 比较下无论时区偏移均晚于 sdd 的 nowIso()，避免写死时刻导致的时间依赖（b4）
    const futureAt = new Date(Date.now() + 3600000).toISOString();
    writeEvidence(ws, 'CR-T1', 'review-annotations/dev-plan.yml', `cr-id: CR-T1\nreview-type: dev-plan\nreviewer: "r"\nreviewed-at: "${futureAt}"\nverdict: block\nrepair-target: write-tech-design\nblockers:\n  - "upstream"\n`);
    // SDD 修订（digest 变化）
    writeEvidence(ws, 'CR-T1', 'sdd.md', '---\nid: CR-T1-sdd\n---\nv2\n');
    // tech-design bump → 新 cycle：cycle=2/attempt=1，旧 attempts 保留
    writeReviewPayload(ws, 'CR-T1', 'tech-design', 'verdict: block\nblockers:\n  - "b2"\ndimensions:\n  a: b\n');
    const r = runCrctl(['review-record', 'CR-T1', '--stage', 'tech-design', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.attempt.current, 1, '新 cycle 从 attempt=1 重新计');
    assert.equal(r.stdout.attempt.bumped, true);
    const loop = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'review-loop.yml'), 'utf8');
    assert.match(loop, /current-cycle: 2/);
    assert.match(loop, /current-attempt: 1/);
    assert.ok(loop.includes('cycle: 2'), '新 cycle attempt 带 cycle 字段');
    assert.ok(loop.includes('attempt: 1') && loop.includes('attempt: 2') && loop.includes('attempt: 3'), '旧 cycle attempts 完整保留');
    const tr = readTrace(ws, 'CR-T1');
    assert.ok(tr.includes('- attempt: 1') && tr.includes('- attempt: 2') && tr.includes('- attempt: 3'), 'trace 旧 attempts 保留');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-027 TASK-07：终态查询 / next 路由 freshness / inbox-emit 校验（FR-12/FR-16/FR-11）──
test('CR-2026-027 FR-12：终态 CR status/next 只读查询（archived/rejected/withdrawn → terminal + next:null），冲突/缺 final-status 硬失败', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-OTHER', status: 'drafting' }]); // CR-OLD 已归档：仅存 _history.yml（TASK-10 删 archive-move 后终态构造改为直写等价结构）
    writeCrMd(ws, 'CR-OLD', 'archived');
    writeCrMd(ws, 'CR-OTHER', 'drafting');
    writeIndex(ws, [{ id: 'CR-OLD', title: 'O', status: 'archived', created: '2026-08-01T00:00:00+08:00' }]);
    writeFileSync(path.join(ws, 'change-requests', '_history.yml'), ['history:', '  - id: CR-OLD', '    final-status: archived', '    archived-at: "2026-08-11T00:00:00+08:00"', ''].join('\n'));
    // status/next 终态查询
    const st = runCrctl(['status', 'CR-OLD', '--workspace', ws]);
    assert.equal(st.status, 0);
    assert.equal(st.stdout.status, 'archived');
    assert.equal(st.stdout.terminal, true);
    assert.deepEqual(st.stdout.source, { history: 'change-requests/_history.yml' });
    assert.equal(st.stdout.next, null);
    const nx = runCrctl(['next', 'CR-OLD', '--workspace', ws]);
    assert.equal(nx.status, 0, '终态 next 不报错');
    assert.equal(nx.stdout.next, null);
    assert.equal(nx.stdout.status, 'archived');
    // 写命令对终态维持拒绝（不 fallback 引入可写性）
    const adv = runCrctl(['advance', 'CR-OLD', '--to', 'drafting', '--trigger', 'x', '--workspace', ws]);
    assert.equal(adv.status, 1);
    assert.equal(adv.stderr.error.code, 'CR_STATUS_NOT_FOUND');
    // history 缺 final-status → 硬失败（CR-BAD 仅存在于 history，不写 backlog）
    writeFileSync(path.join(ws, 'change-requests', '_history.yml'), 'history:\n  - id: CR-BAD\n');
    const bad = runCrctl(['next', 'CR-BAD', '--workspace', ws]);
    assert.equal(bad.status, 1);
    assert.equal(bad.stderr.error.code, 'HISTORY_FINAL_STATUS_MISSING');
    // backlog/history 同存 → CR_LOCATION_CONFLICT（CR-DUP 同时出现在两处）
    const bpFile = path.join(ws, 'change-requests', '_backlog.yml');
    writeFileSync(bpFile, readFileSync(bpFile, 'utf8') + '  - id: CR-DUP\n    status: withdrawn\n');
    writeFileSync(path.join(ws, 'change-requests', '_history.yml'), 'history:\n  - id: CR-DUP\n    final-status: withdrawn\n');
    const dup = runCrctl(['next', 'CR-DUP', '--workspace', ws]);
    assert.equal(dup.status, 1);
    assert.equal(dup.stderr.error.code, 'CR_LOCATION_CONFLICT');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 FR-16：next task-breakdown 路由 —— 无/畸形 dev-plan → review-dev-plan；PASS → approve dev-start；repair/upstream/exhausted 正确分流', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    mkdirSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks'), { recursive: true });
    writeFileSync(path.join(ws, 'change-requests', 'CR-T1', 'plan.md'), '# plan\n');
    writeFileSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', '_index.yml'), 'tasks: []\n');
    // 无 dev-plan.yml → review-dev-plan（不得误报 approve dev-start）
    let r = runCrctl(['next', 'CR-T1', '--workspace', ws]);
    assert.equal(r.stdout.next, 'review-dev-plan');
    // 畸形 → review-dev-plan
    writeEvidence(ws, 'CR-T1', 'review-annotations/dev-plan.yml', 'cr-id: CR-T1\nverdict: maybe\n');
    r = runCrctl(['next', 'CR-T1', '--workspace', ws]);
    assert.equal(r.stdout.next, 'review-dev-plan');
    // PASS → approve dev-start（CR-2026-039 TASK-02 起：fresh 轨需携 subject-sha256）
    writeEvidence(ws, 'CR-T1', 'tasks/TASK-01.md', '# TASK-01\n');
    writeEvidence(ws, 'CR-T1', 'review-annotations/dev-plan.yml', `cr-id: CR-T1\nreviewer: "r"\nreviewed-at: "2026-08-10T00:00:00+08:00"\nverdict: pass\nblockers: []\nsubject-sha256: ${expectDevPlanDigest(ws, 'CR-T1')}\n`);
    r = runCrctl(['next', 'CR-T1', '--workspace', ws]);
    assert.equal(r.stdout.next, 'crctl approve --stage dev-start');
    assert.equal(r.stdout.humanApproval, true);
    // repair BLOCK → write-dev-plan
    writeEvidence(ws, 'CR-T1', 'review-annotations/dev-plan.yml', 'cr-id: CR-T1\nreviewer: "r"\nreviewed-at: "2026-08-10T00:00:00+08:00"\nverdict: block\nblockers:\n  - "b1"\n');
    r = runCrctl(['next', 'CR-T1', '--workspace', ws]);
    assert.equal(r.stdout.next, 'write-dev-plan');
    // upstream BLOCK → write-tech-design
    writeEvidence(ws, 'CR-T1', 'review-annotations/dev-plan.yml', 'cr-id: CR-T1\nreviewer: "r"\nreviewed-at: "2026-08-10T00:00:00+08:00"\nverdict: block\nrepair-target: write-tech-design\nblockers:\n  - "up"\n');
    r = runCrctl(['next', 'CR-T1', '--workspace', ws]);
    assert.equal(r.stdout.next, 'write-tech-design');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 FR-16：tech-design-review-pending freshness —— SDD digest 不一致/较新 upstream blocker → review-tech-design；fresh PASS → approve', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'tech-design-review-pending');
    writeEvidence(ws, 'CR-T1', 'sdd.md', '---\nid: CR-T1-sdd\n---\nv1\n');
    // 旧 PASS annotation（含 digest）
    const digestV1 = crypto.createHash('sha256').update('---\nid: CR-T1-sdd\n---\nv1\n', 'utf8').digest('hex');
    writeEvidence(ws, 'CR-T1', 'review-annotations/sdd.yml', `cr-id: CR-T1\nreviewer: "r"\nreviewed-at: "2026-08-09T00:00:00+08:00"\nverdict: pass\nblockers: []\nsubject-file: change-requests/CR-T1/sdd.md\nsubject-sha256: ${digestV1}\n`);
    // fresh PASS → approve tech-design
    let r = runCrctl(['next', 'CR-T1', '--workspace', ws]);
    assert.equal(r.stdout.next, 'crctl approve --stage tech-design');
    // SDD 修订（digest 变化）→ review-tech-design
    writeEvidence(ws, 'CR-T1', 'sdd.md', '---\nid: CR-T1-sdd\n---\nv2\n');
    r = runCrctl(['next', 'CR-T1', '--workspace', ws]);
    assert.equal(r.stdout.next, 'review-tech-design');
    // 较新的 dev-plan upstream blocker（SDD 未再动）→ review-tech-design
    writeEvidence(ws, 'CR-T1', 'review-annotations/dev-plan.yml', 'cr-id: CR-T1\nreviewer: "r"\nreviewed-at: "2026-08-10T00:00:00+08:00"\nverdict: block\nrepair-target: write-tech-design\nblockers:\n  - "up"\n');
    r = runCrctl(['next', 'CR-T1', '--workspace', ws]);
    assert.equal(r.stdout.next, 'review-tech-design');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 FR-11：inbox-emit 空 --to 拒绝 —— 缺失/空串/去重后为空 → BAD_ARGS 且不写 notify-log', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    // 缺失 --to
    let r = runCrctl(['inbox-emit', 'CR-T1', '--event', 'note', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'BAD_ARGS');
    // 空串
    r = runCrctl(['inbox-emit', 'CR-T1', '--event', 'note', '--to', '', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'BAD_ARGS');
    const backlog = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.ok(!backlog.includes('notify-log'), '无收件人时不得写 notify-log');
    // 正常 --to 仍工作
    r = runCrctl(['inbox-emit', 'CR-T1', '--event', 'note', '--to', 'alice', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-026 TASK-07：dev-plan stage 双轨路由与 repair-target（FR-6/6a/6b/14，SDD §3.1/§3.2/§4.3） ──
// 门禁向量（⑥⑦⑧⑨）经 code review suggestion-2 落地为 spawnSync 可驱动的非 TTY 等价向量（grant/手写 approval 夹具）；
// ⑩ 四 stage 回归由本文件既有用例全量覆盖。

function writeDevPlanPayload(ws, cr, verdict, extra = '') {
  const blockers = extra.includes('blockers:') ? '' : 'blockers: []\n';
  return writeReviewPayload(ws, cr, 'dev-plan', `verdict: ${verdict}
${blockers}${extra}dimensions:
  sdd-to-plan: ok
  plan-to-tasks: ok
  task-executability: ok
  dependency-topology: ok
  interface-contracts: ok
  acceptance-verifiability: ok
  scope-and-simplicity: ok
  risk-and-rollback: ok
`);
}

// CR-2026-039 TASK-01：review-record --stage dev-plan 需要 plan.md + 非空 TASK 集（composite digest subject）。
function seedDevPlanSubjects(ws, cr, opts = {}) {
  writeEvidence(ws, cr, 'plan.md', opts.plan ?? '# plan\n');
  writeEvidence(ws, cr, 'tasks/TASK-01.md', opts.task01 ?? '# TASK-01\n');
  if (opts.task02 != null) writeEvidence(ws, cr, 'tasks/TASK-02.md', opts.task02);
}

/** CR-2026-039 TASK-01：与实现同构的独立 digest 重算（测试侧不复用 crctl 内部函数）。 */
function expectDevPlanDigest(ws, cr) {
  const lf = (t) => t.replaceAll('\r\n', '\n');
  const entries = [{ path: `change-requests/${cr}/plan.md`, content: lf(readFileSync(path.join(ws, 'change-requests', cr, 'plan.md'), 'utf8')) }];
  const names = readdirSync(path.join(ws, 'change-requests', cr, 'tasks')).filter((f) => /^TASK-.*\.md$/.test(f)).sort();
  for (const f of names) entries.push({ path: `change-requests/${cr}/tasks/${f}`, content: lf(readFileSync(path.join(ws, 'change-requests', cr, 'tasks', f), 'utf8')) });
  return crypto.createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
}

test('CR-2026-026 ①: review-record --stage dev-plan 在 task-breakdown 落盘三账本 + pass 轨省略 repair-target（suggestion-1）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    seedDevPlanSubjects(ws, 'CR-T1');
    const payload = writeDevPlanPayload(ws, 'CR-T1', 'pass');
    const r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.verdict, 'pass');
    assert.equal(r.stdout.attempt.current, 1);
    const ann = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'review-annotations', 'dev-plan.yml'), 'utf8');
    assert.ok(!ann.includes('repair-target:'), 'pass 轨 annotation 省略 repair-target（suggestion-1）');
    assert.ok(ann.includes('review-type: dev-plan'));
    const trace = readTrace(ws, 'CR-T1');
    assert.ok(trace.includes('reviews:\n  dev-plan:'), 'traceability 投影');
    assert.ok(!/^    repair-target:/m.test(trace), 'pass 轨投影顶层省略 repair-target');
    assert.ok(trace.includes('          repair-target: write-dev-plan'), 'attempts 轮次历史保留缺省 repair-target（schema 稳定）');
    const loop = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'review-loop.yml'), 'utf8');
    assert.ok(loop.includes('review-dev-plan'), 'review-loop ref');
    assert.equal(existsSync(payload), false, 'payload 已删除');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-026 ②: repair-target 非法值 → SCHEMA_INVALID 且三账本不变', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    const payload = writeDevPlanPayload(ws, 'CR-T1', 'block', 'repair-target: bogus\n');
    const r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'SCHEMA_INVALID');
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-T1', 'review-annotations', 'dev-plan.yml')), false, '不得写 canonical');
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-T1', 'traceability.yml')), false, 'traceability 不变');
    assert.equal(existsSync(payload), true, '非法 payload 保留');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-026 ③: UPSTREAM 路由（repair-target=write-tech-design）跳过 bump：attempt 不递增、attempts 不追加', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    seedDevPlanSubjects(ws, 'CR-T1');
    // 先跑一轮普通 block（attempt 1）
    writeDevPlanPayload(ws, 'CR-T1', 'block');
    let r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.stdout.attempt.current, 1);
    // 再跑 upstream block：attempt 不递增
    const loopPath = path.join(ws, 'change-requests', 'CR-T1', 'review-loop.yml');
    const loopBefore = readFileSync(loopPath, 'utf8');
    writeDevPlanPayload(ws, 'CR-T1', 'block', 'repair-target: write-tech-design\n');
    r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    const ann = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'review-annotations', 'dev-plan.yml'), 'utf8');
    assert.ok(ann.includes('repair-target: write-tech-design'), 'annotation 顶层落 upstream');
    const trace = readTrace(ws, 'CR-T1');
    assert.ok(trace.includes('current-attempt: 1'), 'traceability attempt 不递增（保持 1）');
    assert.ok(!trace.includes('- attempt: 2'), 'traceability attempts 不追加第 2 轮');
    const loopAfter = readFileSync(loopPath, 'utf8');
    assert.equal(loopAfter, loopBefore, 'review-loop.yml 内容不变（UPSTREAM 跳过 bump，不递增不追加）');
    assert.ok(!loopAfter.includes('- attempt: 2'), 'review-loop attempts 不追加第 2 轮');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-026 ④: NORMAL/PASS 路由走既有 bump：attempt 递增', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    seedDevPlanSubjects(ws, 'CR-T1');
    writeDevPlanPayload(ws, 'CR-T1', 'block');
    let r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.stdout.attempt.current, 1);
    const ann1 = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'review-annotations', 'dev-plan.yml'), 'utf8');
    assert.ok(ann1.includes('repair-target: write-dev-plan'), '普通 block 轨缺省 repair-target 落盘');
    writeDevPlanPayload(ws, 'CR-T1', 'pass');
    r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.stdout.attempt.current, 2, '普通轨/PASS attempt 递增');
    const trace = readTrace(ws, 'CR-T1');
    assert.ok(trace.includes('- attempt: 1') && trace.includes('- attempt: 2'), 'attempts 保留两轮');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-026 ⑤: 并存优先——repair-target=write-tech-design 且普通 blocker 并存 → upstream 路由且不 bump', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    seedDevPlanSubjects(ws, 'CR-T1');
    writeDevPlanPayload(ws, 'CR-T1', 'block', 'repair-target: write-tech-design\nblockers:\n  - "普通 plan 覆盖缺失"\n');
    const r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    const ann = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'review-annotations', 'dev-plan.yml'), 'utf8');
    assert.ok(ann.includes('repair-target: write-tech-design'), '并存时 upstream 优先');
    const trace = readTrace(ws, 'CR-T1');
    assert.ok(trace.includes('current-attempt: 0'), '无历史时并存不递增（保持 0）');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-026 code review suggestion-2：门禁向量自动化（⑥-⑨，非 TTY 等价） ──
// 夹具：真实 Ed25519 密钥 + 三文件证据（dev-plan.yml/plan.md/tasks/_index.yml），
// evidence digest 顺序与 canonicalEvidenceDigest 一致（evidence 值字典序：plan.md < review-annotations < tasks）。

function makeDevStartWorkspace() {
  const ws = makeWorkspace();
  // approve 级联 advance 需要 git 仓（与 makeGrantWorkspace 同款）
  const g = (args) => { const r = spawnSync('git', args, { cwd: ws, encoding: 'utf8', shell: false }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); };
  g(['init', '-b', 'master']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 'tester']);
  writeCrEntry(ws, 'CR-D1', 'task-breakdown');
  writeEvidence(ws, 'CR-D1', 'plan.md', '# plan\n');
  writeEvidence(ws, 'CR-D1', 'tasks/_index.yml', 'tasks:\n  - id: CR-D1-TASK-01\n');
  writeEvidence(ws, 'CR-D1', 'tasks/TASK-01.md', '# TASK-01\n');
  // CR-2026-039 TASK-02：PASS annotation 携 subject-sha256（fresh 轨夹具；legacy 无 digest 由 CR-2026-039 用例专验）
  writeEvidence(ws, 'CR-D1', 'review-annotations/dev-plan.yml', `cr-id: CR-D1\nreview-type: dev-plan\nverdict: pass\nblockers: []\ndimensions:\n  sdd-to-plan: ok\nsubject-sha256: ${expectDevPlanDigest(ws, 'CR-D1')}\n`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(path.join(ws, '.crctl', 'keys'), { recursive: true });
  writeFileSync(path.join(ws, '.crctl', 'keys', 'approval-test.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
  return { ws, privateKey };
}

function devStartEvidenceTexts(ws) {
  // CR-2026-027 代码评审回修（b9）：dev-start 证据集不含 tasks/_index.yml（开发期可变，避免 EVIDENCE_DRIFT），与 gates.json 声明对齐
  return [
    readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'plan.md'), 'utf8'),
    readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'review-annotations', 'dev-plan.yml'), 'utf8'),
  ];
}

function makeDevStartGrant(ws, privateKey, overrides = {}) {
  const grant = {
    v: 1, cr_id: 'CR-D1', stage: 'dev-start', decision: 'approve',
    approver: 'alice@corp', approved_at: '2026-08-09T10:30:00+08:00',
    evidence_digest: canonicalDigestOf(devStartEvidenceTexts(ws)),
    key_id: 'approval-test',
    ...overrides,
  };
  const canonical = `v1|${grant.cr_id}|${grant.stage}|${grant.decision}|${grant.approver}|${grant.approved_at}|${grant.evidence_digest}`;
  grant.signature = overrides.signature ?? cryptoSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
  const gp = path.join(ws, 'grant.json');
  writeFileSync(gp, JSON.stringify(grant, null, 2));
  return gp;
}

function writeDevStartApproval(ws, extra = {}) {
  writeApprovalYml(ws, 'CR-D1', 'development-start', {
    approver: 'alice', 'approved-at': '2026-08-09T10:30:00+08:00', via: 'crctl-approve',
    'evidence-digest': canonicalDigestOf(devStartEvidenceTexts(ws)), 'target-status': 'developing',
    ...extra,
  });
}

test('CR-2026-026 ⑥: approve --grant dev-start 门禁升级生效（evidence+passCondition），非 TTY 放行到 developing（FR-10）', () => {
  const { ws, privateKey } = makeDevStartWorkspace();
  try {
    const gp = makeDevStartGrant(ws, privateKey);
    const r = runCrctl(['approve', 'CR-D1', '--stage', 'dev-start', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.to, 'developing');
    const approval = readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'approval.yml'), 'utf8');
    assert.match(approval, /development-start:/);
    assert.match(approval, /evidence-digest: /);
    assert.match(approval, /via: server-approve/);
    const state = runCrctl(['status', 'CR-D1', '--workspace', ws]);
    assert.equal(state.stdout.status, 'developing', '级联推进 developing');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-026 ⑥b: dev-plan 评审未通过（verdict=block）→ approve --grant dev-start 被 GATE_BLOCKED，不写审批（AC-10）', () => {
  const { ws, privateKey } = makeDevStartWorkspace();
  try {
    writeEvidence(ws, 'CR-D1', 'review-annotations/dev-plan.yml', 'cr-id: CR-D1\nreview-type: dev-plan\nverdict: block\nblockers:\n  - "x"\ndimensions:\n  sdd-to-plan: ok\n');
    const gp = makeDevStartGrant(ws, privateKey); // digest 与签名均按 block 版本重签，证明拦截来自 passCondition 而非 digest
    const r = runCrctl(['approve', 'CR-D1', '--stage', 'dev-start', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'GATE_BLOCKED');
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-D1', 'approval.yml')), false, '不写合法审批段');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-026 ⑦: developing 目标态门禁——缺 TASK-*.md 时 advance 被拦截，补齐后放行（AC-11a）', () => {
  const ws = makeDevStartWorkspace().ws;
  try {
    rmSync(path.join(ws, 'change-requests', 'CR-D1', 'tasks', 'TASK-01.md'));
    writeDevStartApproval(ws); // 合法审批段（digest 匹配当前证据）
    let r = runCrctl(['advance', 'CR-D1', '--to', 'developing', '--trigger', 'approve-dev-start', '--expect', 'task-breakdown', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'GATE_BLOCKED');
    writeEvidence(ws, 'CR-D1', 'tasks/TASK-01.md', '# TASK-01\n');
    r = runCrctl(['advance', 'CR-D1', '--to', 'developing', '--trigger', 'approve-dev-start', '--expect', 'task-breakdown', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-026 ⑧: 审批后篡改 dev-plan 证据 → gate 检出 EVIDENCE_DRIFT 且 advance 被拦截（AC-12）', () => {
  const ws = makeDevStartWorkspace().ws;
  try {
    writeDevStartApproval(ws);
    writeEvidence(ws, 'CR-D1', 'review-annotations/dev-plan.yml', 'cr-id: CR-D1\nreview-type: dev-plan\nverdict: pass\nblockers: []\n# tampered\ndimensions:\n  sdd-to-plan: ok\n');
    const g = runCrctl(['gate', 'CR-D1', '--for', 'developing', '--workspace', ws]);
    const check = g.stdout.checks.find((c) => c.type === 'approval');
    assert.equal(check.ok, false);
    assert.equal(check.code, 'EVIDENCE_DRIFT');
    const r = runCrctl(['advance', 'CR-D1', '--to', 'developing', '--trigger', 'approve-dev-start', '--expect', 'task-breakdown', '--workspace', ws]);
    assert.equal(r.status, 1, 'advance 被拦截');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-026 ⑨: 三轮普通 BLOCK 后第 4 轮 --bump-attempt → LOOP_EXHAUSTED（AC-13）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    seedDevPlanSubjects(ws, 'CR-T1');
    for (let i = 1; i <= 3; i++) {
      writeDevPlanPayload(ws, 'CR-T1', 'block');
      const r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
      assert.equal(r.status, 0, r.rawStderr);
      assert.equal(r.stdout.attempt.current, i);
    }
    writeDevPlanPayload(ws, 'CR-T1', 'block');
    const r4 = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r4.status, 1);
    assert.equal(r4.stderr.error.code, 'LOOP_EXHAUSTED');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-039 TASK-01：dev-plan composite digest（SDD §4.1/§4.2；AC-1～AC-4） ──

function readAnnotationDigest(ws, cr) {
  const ann = readFileSync(path.join(ws, 'change-requests', cr, 'review-annotations', 'dev-plan.yml'), 'utf8').replaceAll('\r\n', '\n');
  return /^subject-sha256: ([0-9a-f]{64})$/m.exec(ann)?.[1] ?? null;
}

test('CR-2026-039 TASK-01 AC-1: pass 轨与 block 轨 annotation 均含 subject-sha256 且与独立重算相等', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    seedDevPlanSubjects(ws, 'CR-T1', { task02: '# TASK-02\n' });
    writeDevPlanPayload(ws, 'CR-T1', 'block');
    let r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(readAnnotationDigest(ws, 'CR-T1'), expectDevPlanDigest(ws, 'CR-T1'), 'block 轨 digest 与独立重算相等');
    writeDevPlanPayload(ws, 'CR-T1', 'pass');
    r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(readAnnotationDigest(ws, 'CR-T1'), expectDevPlanDigest(ws, 'CR-T1'), 'pass 轨 digest 与独立重算相等');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-039 TASK-01 AC-2: plan/TASK 内容或集合变化改 digest；仅改 _index.yml 不变；LF 与 CRLF 同 digest', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    seedDevPlanSubjects(ws, 'CR-T1', { task02: '# TASK-02\n' });
    writeEvidence(ws, 'CR-T1', 'tasks/_index.yml', 'tasks: []\n');
    const record = (verdict, bump) => {
      writeDevPlanPayload(ws, 'CR-T1', verdict);
      const r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', ...(bump ? ['--bump-attempt'] : []), '--workspace', ws]);
      assert.equal(r.status, 0, r.rawStderr);
      return readAnnotationDigest(ws, 'CR-T1');
    };
    const d0 = record('pass', true);
    // 改 plan.md → digest 变
    writeEvidence(ws, 'CR-T1', 'plan.md', '# plan v2\n');
    const d1 = record('pass');
    assert.notEqual(d1, d0, 'plan.md 修订改变 digest');
    // 改任一 TASK → digest 变
    writeEvidence(ws, 'CR-T1', 'tasks/TASK-01.md', '# TASK-01 v2\n');
    const d2 = record('pass');
    assert.notEqual(d2, d1, 'TASK 内容修订改变 digest');
    // 增 TASK → digest 变；删 TASK → digest 变
    writeEvidence(ws, 'CR-T1', 'tasks/TASK-03.md', '# TASK-03\n');
    const d3 = record('pass');
    assert.notEqual(d3, d2, '增 TASK 改变 digest');
    rmSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', 'TASK-03.md'));
    const d4 = record('pass');
    assert.equal(d4, d2, '删回原集合恢复原 digest（集合决定）');
    // 仅改 tasks/_index.yml → digest 不变
    writeEvidence(ws, 'CR-T1', 'tasks/_index.yml', 'tasks:\n  - id: CR-T1-TASK-01\n');
    const d5 = record('pass');
    assert.equal(d5, d4, '_index.yml 不进 digest');
    // CRLF 检出 → 同 digest
    const crlf = (rel) => writeFileSync(path.join(ws, 'change-requests', 'CR-T1', ...rel.split('/')), readFileSync(path.join(ws, 'change-requests', 'CR-T1', ...rel.split('/')), 'utf8').replaceAll('\n', '\r\n'));
    crlf('plan.md'); crlf('tasks/TASK-01.md'); crlf('tasks/TASK-02.md');
    const d6 = record('pass');
    assert.equal(d6, d5, 'CRLF 规范化后 digest 不变（纪律 #1）');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-039 TASK-01 AC-3: plan.md 缺失与 TASK 集为空 → SUBJECT_NOT_FOUND + repairTarget 且零账本写入', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    const annP = path.join(ws, 'change-requests', 'CR-T1', 'review-annotations', 'dev-plan.yml');
    const traceP = path.join(ws, 'change-requests', 'CR-T1', 'traceability.yml');
    const loopP = path.join(ws, 'change-requests', 'CR-T1', 'review-loop.yml');
    // plan.md 缺失 → repairTarget=write-dev-plan
    writeEvidence(ws, 'CR-T1', 'tasks/TASK-01.md', '# TASK-01\n');
    writeDevPlanPayload(ws, 'CR-T1', 'pass');
    let r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'SUBJECT_NOT_FOUND');
    assert.ok(r.stderr.error.message.includes('plan.md 缺失'), 'why 含 plan.md 缺失');
    assert.equal(r.stderr.error.repairTarget, 'write-dev-plan');
    assert.equal(existsSync(annP), false, 'annotation 零写入');
    assert.equal(existsSync(traceP), false, 'traceability 零写入');
    assert.equal(existsSync(loopP), false, 'review-loop 零写入');
    // TASK 集为空 → repairTarget=write-dev-tasks
    writeEvidence(ws, 'CR-T1', 'plan.md', '# plan\n');
    rmSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', 'TASK-01.md'));
    writeDevPlanPayload(ws, 'CR-T1', 'pass');
    r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'SUBJECT_NOT_FOUND');
    assert.ok(r.stderr.error.message.includes('集合为空'), 'why 含集合为空');
    assert.equal(r.stderr.error.repairTarget, 'write-dev-tasks');
    assert.equal(existsSync(annP), false, 'annotation 零写入');
    assert.equal(existsSync(traceP), false, 'traceability 零写入');
    assert.equal(existsSync(loopP), false, 'review-loop 零写入');
    // tasks/ 目录缺失 → repairTarget=write-dev-tasks
    rmSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks'), { recursive: true, force: true });
    writeDevPlanPayload(ws, 'CR-T1', 'pass');
    r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'SUBJECT_NOT_FOUND');
    assert.ok(r.stderr.error.message.includes('tasks/ 缺失'));
    assert.equal(r.stderr.error.repairTarget, 'write-dev-tasks');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-039 TASK-01 AC-4: 内容拼接边界不同（不同 TASK 集合划分）不产生相同 digest', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    // 集合 A：两个 TASK 内容分别为 'ab' 与 'cd'
    seedDevPlanSubjects(ws, 'CR-T1', { task01: 'ab', task02: 'cd' });
    writeDevPlanPayload(ws, 'CR-T1', 'pass');
    let r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    const dA = readAnnotationDigest(ws, 'CR-T1');
    // 集合 B：单 TASK 内容为 'abcd'（拼接歧义向量）
    rmSync(path.join(ws, 'change-requests', 'CR-T1', 'tasks', 'TASK-02.md'));
    writeEvidence(ws, 'CR-T1', 'tasks/TASK-01.md', 'abcd');
    writeDevPlanPayload(ws, 'CR-T1', 'pass');
    r = runCrctl(['review-record', 'CR-T1', '--stage', 'dev-plan', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.notEqual(readAnnotationDigest(ws, 'CR-T1'), dA, '不同集合划分不产生相同 digest');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-039 TASK-02：next 与 developing 门禁双消费点 digest freshness（SDD §4.3；AC-1～AC-4） ──

test('CR-2026-039 TASK-02 AC-1: PASS+fresh → next suggest approve dev-start；approve --grant 放行到 developing', () => {
  const { ws, privateKey } = makeDevStartWorkspace();
  try {
    const n = runCrctl(['next', 'CR-D1', '--workspace', ws]);
    assert.equal(n.stdout.next, 'crctl approve --stage dev-start');
    assert.equal(n.stdout.humanApproval, true);
    const gp = makeDevStartGrant(ws, privateKey);
    const r = runCrctl(['approve', 'CR-D1', '--stage', 'dev-start', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.to, 'developing');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-039 TASK-02 AC-2: PASS+drift（plan/TASK 改后）→ next suggest review-dev-plan；approve 硬失败且零写入', () => {
  const { ws, privateKey } = makeDevStartWorkspace();
  try {
    // 评审后改 plan.md → digest 漂移
    writeFileSync(path.join(ws, 'change-requests', 'CR-D1', 'plan.md'), '# plan drifted\n');
    const n = runCrctl(['next', 'CR-D1', '--workspace', ws]);
    assert.equal(n.stdout.next, 'review-dev-plan');
    assert.ok(n.stdout.why.includes('digest 漂移'), 'next why 含 digest 漂移说明');
    // 按漂移后证据重签发 grant：验签通过但 developing 门禁 freshness 拦截
    const gp = makeDevStartGrant(ws, privateKey);
    const r = runCrctl(['approve', 'CR-D1', '--stage', 'dev-start', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'GATE_BLOCKED');
    const pc = r.stderr.error.gate.checks.find((c) => c.type === 'passCondition');
    assert.equal(pc.ok, false);
    assert.ok(pc.why.includes('digest 漂移'), 'gateBlockers 含 digest 不一致说明');
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-D1', 'approval.yml')), false, 'approval.yml 零写入');
    const crMd = readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'cr.md'), 'utf8');
    assert.ok(crMd.includes('status: task-breakdown'), 'cr.md 零写入（状态不变）');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-039 TASK-02 AC-3: legacy 无 subject-sha256 的 PASS → next suggest review-dev-plan；approve 硬失败', () => {
  const { ws, privateKey } = makeDevStartWorkspace();
  try {
    writeEvidence(ws, 'CR-D1', 'review-annotations/dev-plan.yml', 'cr-id: CR-D1\nreview-type: dev-plan\nverdict: pass\nblockers: []\ndimensions:\n  sdd-to-plan: ok\n');
    const n = runCrctl(['next', 'CR-D1', '--workspace', ws]);
    assert.equal(n.stdout.next, 'review-dev-plan');
    assert.ok(n.stdout.why.includes('subject-sha256'), 'next why 说明 legacy 无 digest');
    const gp = makeDevStartGrant(ws, privateKey);
    const r = runCrctl(['approve', 'CR-D1', '--stage', 'dev-start', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'GATE_BLOCKED');
    const pc = r.stderr.error.gate.checks.find((c) => c.type === 'passCondition');
    assert.equal(pc.ok, false);
    assert.ok(pc.why.includes('subject-sha256'));
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-D1', 'approval.yml')), false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-039 TASK-02 AC-4: 删除全部 TASK → next suggest write-dev-tasks（结构化路由）；approve 硬失败且 why 含 subject 不完整', () => {
  const { ws, privateKey } = makeDevStartWorkspace();
  try {
    rmSync(path.join(ws, 'change-requests', 'CR-D1', 'tasks', 'TASK-01.md'));
    const n = runCrctl(['next', 'CR-D1', '--workspace', ws]);
    assert.equal(n.stdout.next, 'write-dev-tasks');
    assert.ok(n.stdout.why.includes('集合为空'), 'next why 透传 subject 不完整原因');
    const gp = makeDevStartGrant(ws, privateKey);
    const r = runCrctl(['approve', 'CR-D1', '--stage', 'dev-start', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'GATE_BLOCKED');
    const pc = r.stderr.error.gate.checks.find((c) => c.type === 'passCondition');
    assert.equal(pc.ok, false);
    assert.ok(pc.why.includes('subject 不完整'));
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-D1', 'approval.yml')), false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-039 TASK-03：cr.md 时间字段统一为 updated（SDD §4.4；AC-1～AC-3） ──

test('CR-2026-039 TASK-03 AC-1: refreshCrMdUpdated/crMdStatusText 纯函数——legacy updated-at 清除、updated 原位刷新/追加、无残留空行、CRLF 一致', () => {
  const at = '2026-08-15T10:00:00+08:00';
  // legacy updated-at → 单一 updated，无残留无空行
  assert.equal(refreshCrMdUpdated('id: X\nupdated-at: "2026-01-01T00:00:00+08:00"\nstatus: drafting', at),
    'id: X\nstatus: drafting\nupdated: "2026-08-15T10:00:00+08:00"');
  // 已有 updated → 原位刷新
  assert.equal(refreshCrMdUpdated(`id: X\nupdated: "2026-01-01T00:00:00+08:00"`, at), `id: X\nupdated: "${at}"`);
  // 两者皆无 → 追加
  assert.equal(refreshCrMdUpdated('id: X\nstatus: drafting', at), `id: X\nstatus: drafting\nupdated: "${at}"`);
  // 双字段共存输入（损坏态）→ 收敛为单一 updated
  assert.equal(refreshCrMdUpdated(`id: X\nupdated-at: "a"\nupdated: "b"`, at), `id: X\nupdated: "${at}"`);
  // updated-at 在首行 → 删后不留前导空行
  assert.equal(refreshCrMdUpdated(`updated-at: "a"\nid: X`, at), `id: X\nupdated: "${at}"`);
  // crMdStatusText：status 替换 + 时间字段收敛
  const legacy = '---\nid: X\nstatus: drafting\nupdated-at: "2026-01-01T00:00:00+08:00"\n---\nbody\n';
  assert.equal(crMdStatusText(legacy, 'developing', { at }),
    `---\nid: X\nstatus: developing\nupdated: "${at}"\n---\nbody\n`);
  // CRLF 来源文本规范化后与 LF 结果一致
  const crlf = legacy.replaceAll('\n', '\r\n');
  assert.equal(crMdStatusText(crlf, 'developing', { at }),
    `---\nid: X\nstatus: developing\nupdated: "${at}"\n---\nbody\n`);
});

test('CR-2026-039 TASK-03 AC-2: owner-set 后 cr.md updated 刷新为移交时间戳；legacy updated-at 被清除不共存', () => {
  const ws = makeGitWorkspace();
  try {
    writeOwnerEntry(ws, 'CR-T1', 'drafting', { extraCrMd: ['updated-at: "2026-01-01T00:00:00+08:00"'] });
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-m', '[cr] seed']);
    const r = runCrctl(['owner-set', 'CR-T1', '--role', 'development', '--id', 'Alice', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    const md = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8').replaceAll('\r\n', '\n');
    assert.ok(!md.includes('updated-at'), 'legacy updated-at 被清除');
    const m = /^updated: "([^"]+)"$/m.exec(md);
    assert.ok(m, 'updated 存在');
    const handoverAt = /to: Alice, at: "([^"]+)"/.exec(md)?.[1];
    assert.equal(m[1], handoverAt, 'updated 与移交时间戳同源（handoverAt）');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-039 TASK-03 AC-3: advance 产物 frontmatter 单一 updated（无双字段）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'tech-design-reviewed');
    writeEvidence(ws, 'CR-T1', 'plan.md', '# plan\n');
    writeEvidence(ws, 'CR-T1', 'tasks/_index.yml', 'cr-id: CR-T1\ntasks: []\n');
    writeEvidence(ws, 'CR-T1', 'tasks/TASK-01.md', '# TASK-01\n');
    const r = runCrctl(['advance', 'CR-T1', '--to', 'task-breakdown', '--trigger', 'write-dev-tasks', '--expect', 'tech-design-reviewed', '--workspace', ws, '--no-commit']);
    assert.equal(r.status, 0, r.rawStderr);
    const md = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8').replaceAll('\r\n', '\n');
    assert.ok(/^updated: "\d{4}-\d{2}-\d{2}T/m.test(md), 'advance 写入单一 updated');
    assert.ok(!md.includes('updated-at'), '无双字段');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// CR-2026-030 review repair（pass-at-max）：attempt 计数到顶但最新一轮评审 verdict=pass 时
// 无需再自修复，advance 不得被 LOOP_EXHAUSTED 阻断（与 review-code SKILL「pass 即可推进」契约一致）；
// verdict=block 时仍必须 LOOP_EXHAUSTED 阻断。
test('CR-2026-030 review repair：review-code pass at maxAttempts 可推进 code-reviewing；block at max 仍阻断（AC-13 边界）', () => {
  const seedLoop = (ws, attempts) => writeEvidence(ws, 'CR-T1', 'review-loop.yml',
    '# 由 crctl attempt 维护，请勿手工编辑\nloops:\n  review-code:\n    current-cycle: 1\n' +
    `    current-attempt: ${attempts}\n    attempts:\n` +
    Array.from({ length: attempts }, (_, i) =>
      `      - { attempt: ${i + 1}, at: \"2026-08-11T10:00:0${i}+08:00\", by: \"tester\", cycle: 1 }`).join('\n') + '\n');
  // ① pass at max（3/3）→ 推进 code-reviewing 成功
  const ws1 = makeWorkspace();
  try {
    writeCrEntry(ws1, 'CR-T1', 'developing');
    seedLoop(ws1, 3);
    writeEvidence(ws1, 'CR-T1', 'review-annotations/code.yml', 'verdict: pass\nblockers: []\n');
    writeEvidence(ws1, 'CR-T1', 'test-report.md', '---\nstatus: pass\n---\n');
    const r = runCrctl(['advance', 'CR-T1', '--to', 'code-reviewing', '--trigger', 'review-code', '--expect', 'developing', '--workspace', ws1, '--no-commit']);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.advanced, true);
  } finally { rmSync(ws1, { recursive: true, force: true }); }
  // ② block at max（3/3）→ attemptsWithinLimit 仍为 LOOP_EXHAUSTED 阻断
  const ws2 = makeWorkspace();
  try {
    writeCrEntry(ws2, 'CR-T1', 'developing');
    seedLoop(ws2, 3);
    writeEvidence(ws2, 'CR-T1', 'review-annotations/code.yml', 'verdict: block\nblockers:\n  - \"still broken\"\n');
    writeEvidence(ws2, 'CR-T1', 'test-report.md', '---\nstatus: pass\n---\n');
    const r = runCrctl(['advance', 'CR-T1', '--to', 'code-reviewing', '--trigger', 'review-code', '--expect', 'developing', '--workspace', ws2, '--no-commit']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'GATE_BLOCKED');
    const att = r.stderr.error.gate.checks.find((c) => c.type === 'attemptsWithinLimit');
    assert.ok(att, 'gate 必须包含 attemptsWithinLimit 检查');
    assert.equal(att.ok, false, 'block at max 必须仍 LOOP_EXHAUSTED');
    assert.equal(att.why, 'LOOP_EXHAUSTED：自修复轮次已用尽，禁止继续推进，须人工处理');
  } finally { rmSync(ws2, { recursive: true, force: true }); }
  // ③ pass at 2/3（未耗尽）→ 正常推进（回归）
  const ws3 = makeWorkspace();
  try {
    writeCrEntry(ws3, 'CR-T1', 'developing');
    seedLoop(ws3, 2);
    writeEvidence(ws3, 'CR-T1', 'review-annotations/code.yml', 'verdict: pass\nblockers: []\n');
    writeEvidence(ws3, 'CR-T1', 'test-report.md', '---\nstatus: pass\n---\n');
    const r = runCrctl(['advance', 'CR-T1', '--to', 'code-reviewing', '--trigger', 'review-code', '--expect', 'developing', '--workspace', ws3, '--no-commit']);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.advanced, true);
  } finally { rmSync(ws3, { recursive: true, force: true }); }
});

// ── CR-2026-027 代码评审回修（b1~b9 覆盖 test-coverage 缺口）──
test('CR-2026-027 回修 b1：findHistoryEntry 在同级下一条目停止（不被后续条目字段覆盖）+ history 重复 CR 硬失败', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-LIVE', status: 'drafting' }]);
    writeCrMd(ws, 'CR-LIVE', 'drafting');
    writeFileSync(path.join(ws, 'change-requests', '_history.yml'),
      'history:\n  - id: CR-A\n    title: A\n    final-status: archived\n  - id: CR-B\n    title: B\n    final-status: rejected\n');
    const stA = runCrctl(['status', 'CR-A', '--workspace', ws]);
    assert.equal(stA.status, 0, stA.rawStderr);
    assert.equal(stA.stdout.status, 'archived', 'CR-A 终态不被后续 CR-B 的 final-status 覆盖');
    const stB = runCrctl(['status', 'CR-B', '--workspace', ws]);
    assert.equal(stB.stdout.status, 'rejected');
    writeFileSync(path.join(ws, 'change-requests', '_history.yml'),
      'history:\n  - id: CR-A\n    final-status: archived\n  - id: CR-A\n    final-status: rejected\n');
    const dup = runCrctl(['status', 'CR-A', '--workspace', ws]);
    assert.equal(dup.status, 1);
    assert.equal(dup.stderr.error.code, 'HISTORY_DUPLICATE_ENTRY');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 回修 b6：inbox-emit JSON 标量拒绝 + 空元素去重后为空 → BAD_ARGS，去重列表放行', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    const r1 = runCrctl(['inbox-emit', 'CR-T1', '--event', 'x', '--to', '"alice"', '--workspace', ws]);
    assert.equal(r1.status, 1);
    assert.equal(r1.stderr.error.code, 'BAD_ARGS');
    const r2 = runCrctl(['inbox-emit', 'CR-T1', '--event', 'x', '--to', '["", " "]', '--workspace', ws]);
    assert.equal(r2.status, 1);
    assert.equal(r2.stderr.error.code, 'BAD_ARGS');
    const r3 = runCrctl(['inbox-emit', 'CR-T1', '--event', 'x', '--to', '["a","a","b"]', '--workspace', ws]);
    assert.equal(r3.status, 0, r3.rawStderr);
    assert.deepEqual(r3.stdout.to, ['a', 'b']);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 回修 b4：tech-design freshness 用 epoch 比较——跨时区偏移（+08:00 vs Z）正确判定较新上游 blocker，非法时间戳硬失败', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'tech-design-review-pending');
    const sddBody = '---\nid: CR-T1-sdd\n---\nbody\n';
    writeEvidence(ws, 'CR-T1', 'sdd.md', sddBody);
    const sddDigest = createHash('sha256').update(sddBody.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
    writeEvidence(ws, 'CR-T1', 'review-annotations/sdd.yml', `cr-id: CR-T1\nreview-type: tech-design\nverdict: pass\nblockers: []\nreviewed-at: "2026-08-10T10:00:00+08:00"\nsubject-file: change-requests/CR-T1/sdd.md\nsubject-sha256: ${sddDigest}\n`);
    writeEvidence(ws, 'CR-T1', 'review-annotations/dev-plan.yml', 'cr-id: CR-T1\nreview-type: dev-plan\nverdict: block\nrepair-target: write-tech-design\nblockers:\n  - "up"\nreviewed-at: "2026-08-10T03:00:00Z"\n');
    const r = runCrctl(['next', 'CR-T1', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.next, 'review-tech-design', 'epoch 判定上游 blocker 较新 → 重审（字符串序会误判为较旧）');
    writeEvidence(ws, 'CR-T1', 'review-annotations/dev-plan.yml', 'cr-id: CR-T1\nreview-type: dev-plan\nverdict: block\nrepair-target: write-tech-design\nblockers:\n  - "up"\nreviewed-at: "not-a-date"\n');
    const bad = runCrctl(['next', 'CR-T1', '--workspace', ws]);
    assert.equal(bad.status, 1);
    assert.equal(bad.stderr.error.code, 'BAD_TIMESTAMP');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 回修 b3：traceability review-loop 投影含 current-cycle 与 attempts[].cycle', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    writePrd(ws, 'CR-T1', '# prd\n');
    writeReviewPayload(ws, 'CR-T1', 'requirement', 'verdict: block\nblockers:\n  - "x"\ndimensions:\n  a: b\n');
    const r = runCrctl(['review-record', 'CR-T1', '--stage', 'requirement', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    const tr = readTrace(ws, 'CR-T1');
    assert.match(tr, /current-cycle: 1/, 'review-loop 投影含 current-cycle');
    assert.match(tr, /cycle: 1/, 'attempts 条目含 cycle');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 回修 b8：developing 且 code.yml verdict=block → next=implement-code（回修而非再评审）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    writeEvidence(ws, 'CR-T1', 'test-report.md', '---\nstatus: pass\n---\n');
    writeEvidence(ws, 'CR-T1', 'review-annotations/code.yml', 'cr-id: CR-T1\nreview-type: code\nverdict: block\nblockers:\n  - "b"\n');
    const r = runCrctl(['next', 'CR-T1', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.next, 'implement-code', 'code.yml block → 回修 implement-code');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 回修 b9：tasks/_index.yml 开发期变动不触发 development-start EVIDENCE_DRIFT', () => {
  const ws = makeDevStartWorkspace().ws;
  try {
    writeDevStartApproval(ws); // digest 只覆盖 plan+dev-plan（不含 task-index）
    const idxP = path.join(ws, 'change-requests', 'CR-D1', 'tasks', '_index.yml');
    writeFileSync(idxP, readFileSync(idxP, 'utf8') + '# task done marker\n');
    const g = runCrctl(['gate', 'CR-D1', '--for', 'developing', '--workspace', ws]);
    const check = g.stdout.checks.find((c) => c.type === 'approval');
    assert.equal(check.ok, true, 'b9：task-index 不入 digest，_index.yml 变动不产生 EVIDENCE_DRIFT');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-027 代码评审二轮（b10）：dev-start 审批闭环 ──
test('CR-2026-027 回修 b10：approve --resign 真实 TTY 成功路径执行 CAS、审计、提交并安全序列化标量', () => {
  const ws = makeDevStartWorkspace().ws;
  try {
    const oldEvidence = devStartEvidenceTexts(ws).concat([readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'tasks', '_index.yml'), 'utf8')]);
    writeDevStartApproval(ws, { 'evidence-digest': canonicalDigestOf(oldEvidence) });
    const approvalP = path.join(ws, 'change-requests', 'CR-D1', 'approval.yml');
    writeFileSync(approvalP, readFileSync(approvalP, 'utf8').replaceAll('\n', '\r\n'));
    const before = readFileSync(approvalP, 'utf8');
    assert.ok(before.includes('\r\n'), 'fixture 使用 Windows CRLF 行尾');
    const reason = 'evidence "definition #1" C:\\gates\nchanged';
    const approver = 'reviewer "x"\\ops';
    const r = runCrctlInTty(['approve', 'CR-D1', '--stage', 'dev-start', '--resign', reason, '--approver', approver, '--workspace', ws]);
    assert.equal(r.status, 0, `${r.rawStdout}\n${r.rawStderr}`);
    const migrated = readFileSync(approvalP, 'utf8');
    assert.notEqual(migrated, before, 'TTY 确认后 approval.yml 应由真实 --resign 路径改写');
    assert.ok(migrated.includes(`    by: ${JSON.stringify(approver)}`), 'approver 使用 YAML 安全标量序列化');
    assert.ok(migrated.includes(`    reason: ${JSON.stringify(reason)}`), 'reason 的引号、反斜杠与换行必须转义为单个 YAML 标量');
    assert.ok(!migrated.includes('\r'), 'resign 定点编辑先将 CRLF 规范化为 LF');
    assert.match(migrated, /approver: "alice"/, '原审批人保留');
    assert.match(migrated, /approved-at: "2026-08-09T10:30:00\+08:00"/, '原审批时间保留');
    assert.match(migrated, /via: "crctl-approve"/, '原审批轨道保留');
    assert.match(migrated, /target-status: "developing"/, '原目标状态保留');
    const gate = runCrctl(['gate', 'CR-D1', '--for', 'developing', '--workspace', ws]);
    assert.equal(gate.stdout.checks.find((c) => c.type === 'approval').ok, true, '真实迁移后 gate 复绿');
    const validate = runCrctl(['validate', 'change-requests/CR-D1/approval.yml', '--workspace', ws]);
    assert.equal(validate.status, 0, validate.rawStderr);
    const audit = readFileSync(path.join(ws, '.crctl', 'audit.log'), 'utf8');
    assert.match(audit, /"kind":"approve-resign".*"result":"resigned"/, '真实路径写入成功审计');
    const show = spawnSync('git', ['show', '--name-only', '--format=%s', 'HEAD'], { cwd: ws, encoding: 'utf8' });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /approval\.yml/, '真实路径受控提交 approval.yml');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 回修 b10：approve --resign 对非唯一账本结构硬失败且零副作用', () => {
  const cases = [
    ['重复审批段', (text) => `${text}\n${text}`],
    ['重复 evidence-digest', (text) => text.replace(/^  evidence-digest:.*$/m, '$&\n$&')],
    ['缺失 evidence-digest', (text) => text.replace(/^  evidence-digest:.*\n?/m, '')],
  ];
  for (const [name, corrupt] of cases) {
    const ws = makeDevStartWorkspace().ws;
    try {
      writeDevStartApproval(ws, { 'evidence-digest': 'legacy-digest' });
      const approvalP = path.join(ws, 'change-requests', 'CR-D1', 'approval.yml');
      const before = corrupt(readFileSync(approvalP, 'utf8'));
      writeFileSync(approvalP, before);
      const auditP = path.join(ws, '.crctl', 'audit.log');
      const auditBefore = existsSync(auditP) ? readFileSync(auditP, 'utf8') : '';
      const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ws, encoding: 'utf8' }).stdout;
      const r = runCrctlInTty(['approve', 'CR-D1', '--stage', 'dev-start', '--resign', 'evidence-definition-change', '--workspace', ws]);
      assert.equal(r.status, 1, `${name}: ${r.rawStdout}\n${r.rawStderr}`);
      assert.equal(r.stderr.error.code, 'SCHEMA_INVALID', `${name} 必须硬失败`);
      assert.equal(readFileSync(approvalP, 'utf8'), before, `${name} 不得改写 approval.yml`);
      assert.equal(existsSync(auditP) ? readFileSync(auditP, 'utf8') : '', auditBefore, `${name} 不得写审计`);
      assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ws, encoding: 'utf8' }).stdout, headBefore, `${name} 不得提交`);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
});

test('CR-2026-027 回修 b10：approve --resign 拒绝 server-approve，避免旧签名绑定新 digest', () => {
  const { ws, privateKey } = makeDevStartWorkspace();
  try {
    const grantPath = makeDevStartGrant(ws, privateKey);
    const grant = JSON.parse(readFileSync(grantPath, 'utf8'));
    writeApprovalYml(ws, 'CR-D1', 'development-start', {
      approver: grant.approver, 'approved-at': grant.approved_at, via: 'server-approve',
      'evidence-digest': 'legacy-digest', 'target-status': 'developing',
      'grant-approved-at': grant.approved_at, 'key-id': grant.key_id, signature: grant.signature,
    });
    const approvalP = path.join(ws, 'change-requests', 'CR-D1', 'approval.yml');
    const before = readFileSync(approvalP, 'utf8');
    const r = runCrctlInTty(['approve', 'CR-D1', '--stage', 'dev-start', '--resign', 'evidence-definition-change', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'RESIGN_SERVER_APPROVAL_UNSUPPORTED');
    assert.equal(readFileSync(approvalP, 'utf8'), before, '拒绝 server-approve resign 时审批段不变');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 回修 b10：approve --resign 非交互式调用拒绝（人类在环，无旁路）', () => {
  const ws = makeDevStartWorkspace().ws;
  try {
    writeDevStartApproval(ws);
    const r = runCrctl(['approve', 'CR-D1', '--stage', 'dev-start', '--resign', 'evidence-definition-change', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'APPROVAL_REQUIRES_HUMAN', '非 TTY 一律拒绝，无旁路');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-028 FR-1/FR-3/FR-4：Tools Root 唯一解析（TASK-02/03，AC-6/AC-7/AC-8）──

test('resolveToolsRoot：相对/绝对声明归一到同一 realpath，workspace 空壳 tools 不参与回退（AC-1/AC-3）', () => {
  const fixture = makeToolsFixture();
  const absWs = makeWorkspace({ toolsRoot: fixture });
  const relWs = makeWorkspace({ toolsRoot: fixture });
  try {
    for (const ws of [absWs, relWs]) writeCrEntry(ws, 'CR-T1', 'sentinel-drafting');
    mkdirSync(path.join(relWs, 'tools'), { recursive: true }); // 同名空壳不得成为候选
    const relative = path.relative(relWs, fixture);
    writeFileSync(path.join(relWs, 'dir-graph.yaml'),
      `workspace:\n  tools_package_path: ${JSON.stringify(relative)}\n`, 'utf8');

    const abs = runCrctl(['status', 'CR-T1', '--workspace', absWs]);
    const rel = runCrctl(['status', 'CR-T1', '--workspace', relWs]);
    assert.equal(abs.status, 0, abs.rawStderr);
    assert.equal(rel.status, 0, rel.rawStderr);
    assert.equal(realpathSync(abs.stdout.source.stateMachine), realpathSync(rel.stdout.source.stateMachine), '相对/绝对声明归一到同一状态机来源');
    assert.ok(!rel.stdout.source.stateMachine.replaceAll('\\', '/').includes('/tools/dir-graph.yaml'), '不读取 workspace 空壳 tools');

    writeFileSync(path.join(relWs, 'dir-graph.yaml'), 'workspace:\n  tools_package_path: ./missing-tools\n', 'utf8');
    const broken = runCrctl(['status', 'CR-T1', '--workspace', relWs]);
    assert.equal(broken.status, 1, '声明破坏后硬失败，不回退空壳 tools');
    assert.equal(broken.stderr.error.code, 'TOOLS_PACKAGE_NOT_FOUND');
    assert.equal(broken.stderr.error.reason, 'path-not-exists');
  } finally {
    rmSync(absWs, { recursive: true, force: true });
    rmSync(relWs, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('resolveToolsRoot：缺失/无效 tools_package_path 硬失败 TOOLS_PACKAGE_NOT_FOUND（表驱动，零回退）', () => {
  const cases = [
    { name: '缺 dir-graph.yaml', mutate: (ws) => rmSync(path.join(ws, 'dir-graph.yaml')) },
    { name: '字段缺失', mutate: (ws) => writeFileSync(path.join(ws, 'dir-graph.yaml'), 'workspace:\n  other: 1\n') },
    { name: '非字符串', mutate: (ws) => writeFileSync(path.join(ws, 'dir-graph.yaml'), 'workspace:\n  tools_package_path: [a, b]\n') },
    { name: '空值', mutate: (ws) => writeFileSync(path.join(ws, 'dir-graph.yaml'), 'workspace:\n  tools_package_path: ""\n') },
    { name: '路径不存在', mutate: (ws) => writeFileSync(path.join(ws, 'dir-graph.yaml'), 'workspace:\n  tools_package_path: "C:/no/such/tools"\n') },
  ];
  for (const c of cases) {
    const ws = makeWorkspace();
    try {
      writeCrEntry(ws, 'CR-T1', 'drafting');
      c.mutate(ws);
      const r = runCrctl(['status', 'CR-T1', '--workspace', ws]);
      assert.equal(r.status, 1, c.name);
      assert.equal(r.stderr.error.code, 'TOOLS_PACKAGE_NOT_FOUND', c.name);
      assert.ok(r.stderr.error.instRoot, `${c.name} detail 含 instRoot`);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
});

test('resolveToolsRoot：四标志任一缺失 → TOOLS_PACKAGE_NOT_FOUND（identity-marker-missing）', () => {
  for (const rel of ['AGENTS.md', 'dir-graph.yaml', 'skills/_index.yml', 'skills/shared/crctl/scripts/crctl.mjs']) {
    const fixture = makeToolsFixture();
    const ws = makeWorkspace({ toolsRoot: fixture });
    try {
      writeCrEntry(ws, 'CR-T1', 'drafting');
      rmSync(path.join(fixture, rel), { recursive: true, force: true });
      const r = runCrctl(['status', 'CR-T1', '--workspace', ws]);
      assert.equal(r.status, 1, `缺 ${rel}`);
      assert.equal(r.stderr.error.code, 'TOOLS_PACKAGE_NOT_FOUND', `缺 ${rel}`);
      assert.ok((r.stderr.error.missing || []).includes(rel), `missing 含 ${rel}`);
    } finally { rmSync(ws, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }); }
  }
});

test('四类配置来自同一 Tools Root：状态机 sentinel 转换可 advance（AC-6）', () => {
  const fixture = makeToolsFixture();
  const ws = makeWorkspace({ toolsRoot: fixture });
  try {
    writeCrEntry(ws, 'CR-S1', 'sentinel-drafting');
    const r = runCrctl(['advance', 'CR-S1', '--to', 'sentinel-reviewing', '--trigger', 'sentinel-advance', '--no-commit', '--workspace', ws]);
    assert.equal(r.status, 0, `fixture 状态机转换生效: ${r.rawStderr}`);
    assert.equal(r.stdout.to, 'sentinel-reviewing');
  } finally { rmSync(ws, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }); }
});

test('四类配置来自同一 Tools Root：gates sentinel statusGate + pipeline sentinel nodeRef（AC-6）', () => {
  const fixture = makeToolsFixture();
  const gates = {
    ...FIXTURE_GATES,
    statusGates: { 'sentinel-state': [
      { type: 'fileExists', path: 'change-requests/{cr}/sentinel-evidence.md' },
      { type: 'passCondition', stage: 'sentinel' },
    ] },
    approvalStages: { sentinel: {
      evidence: { $default: 'change-requests/{cr}/review-annotations/sentinel.yml' },
      passCondition: { pipeline: 'sentinel', nodeRef: 'sentinel-node' },
    } },
  };
  writeFileSync(path.join(fixture, 'skills/shared/crctl/gates.json'), JSON.stringify(gates));
  const ws = makeWorkspace({ toolsRoot: fixture });
  try {
    writeCrEntry(ws, 'CR-S1', 'sentinel-state');
    mkdirSync(path.join(ws, 'change-requests', 'CR-S1', 'review-annotations'), { recursive: true });
    writeFileSync(path.join(ws, 'change-requests', 'CR-S1', 'sentinel-evidence.md'), 'sentinel\n');
    writeFileSync(path.join(ws, 'change-requests', 'CR-S1', 'review-annotations', 'sentinel.yml'), 'verdict: pass\nblockers: []\n');
    const r = runCrctl(['gate', 'CR-S1', '--for', 'sentinel-state', '--workspace', ws]);
    assert.equal(r.status, 0, `fixture gates+pipeline 生效: ${r.rawStderr}`);
    assert.equal(r.stdout.pass, true);
    const pc = r.stdout.checks.find((c) => c.type === 'passCondition');
    assert.equal(pc.ok, true, 'sentinel pipeline passCondition 来自 fixture');
  } finally { rmSync(ws, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }); }
});

test('四类配置来自同一 Tools Root：rules sentinel 形状生效（AC-6）', () => {
  const fixture = makeToolsFixture();
  const ws = makeWorkspace({ toolsRoot: fixture });
  try {
    const r = runCrctl(['git', 'status', '--short', '--workspace', ws]);
    assert.equal(r.status, 1, 'fixture rules 只允许 --sentinel-shape');
    assert.equal(r.stderr.error.code, 'FORBIDDEN_SUBCOMMAND', 'git status 无 sentinel 形状 → 拒绝（rules 来自 fixture 而非真实 tools）');
  } finally { rmSync(ws, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }); }
});

test('CRCTL_RULES_PATH：有效显式 rules 优先于 Tools Root 默认 rules（AC-7）', () => {
  const fixture = makeToolsFixture();
  const ws = makeWorkspace({ toolsRoot: fixture });
  try {
    const init = spawnSync('git', ['init', '-b', 'main'], { cwd: ws, encoding: 'utf8', shell: false });
    assert.equal(init.status, 0, init.stderr);
    const override = path.join(ws, 'rules-override.json');
    writeFileSync(override, JSON.stringify({
      git: [{ sub: 'status', shapes: ['^--short$'] }],
      forbiddenFlags: ['-c', '-C', '--exec'],
    }), 'utf8');
    const r = runCrctl(['git', 'status', '--short', '--workspace', ws], { CRCTL_RULES_PATH: override });
    assert.equal(r.status, 0, `有效显式覆盖应允许 --short（fixture 默认仅允许 --sentinel-shape）: ${r.rawStderr}`);
  } finally { rmSync(ws, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }); }
});

test('配置来源恒由 ws/tools_package_path 决定：真实 checkout 脚本 + fixture 配置仍生效（AC-6）', () => {
  const fixture = makeToolsFixture();
  const ws = makeWorkspace({ toolsRoot: fixture });
  try {
    writeCrEntry(ws, 'CR-S1', 'sentinel-drafting');
    const r = runCrctl(['advance', 'CR-S1', '--to', 'sentinel-reviewing', '--trigger', 'sentinel-advance', '--no-commit', '--workspace', ws]);
    assert.equal(r.status, 0, `真实 checkout 脚本 + fixture 配置仍生效: ${r.rawStderr}`);
    assert.equal(r.stdout.to, 'sentinel-reviewing');
  } finally { rmSync(ws, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true }); }
});

// ── CR-2026-028 AC-8：源码审查断言（四 loader 同一 resolver、成功值缓存、无 module-scope 全局）──

test('AC-8：四 loader 均显式接收 ws 并调用同一 resolveToolsRoot(ws)；main/controlledGit 各自接线（源码静态断言）', () => {
  const src = readFileSync(CRCTL, 'utf8').replace(/\r\n/g, '\n');
  // 四个 loader 定义均带 ws 参数
  for (const sig of ['function loadStateMachine(ws)', 'function loadGates(ws)', 'function loadPipeline(ws, id)', 'function loadShellRules(ws)']) {
    assert.ok(src.includes(sig), `定义存在: ${sig}`);
  }
  // 四个 loader 内部调用同一 resolver
  const loaderBodies = ['loadStateMachine', 'loadGates', 'loadPipeline', 'loadShellRules']
    .map((f) => src.slice(src.indexOf(`function ${f}(`)));
  for (const body of loaderBodies) {
    assert.ok(body.slice(0, body.indexOf('\nfunction ')) .includes('resolveToolsRoot('), `${body.slice(0, 20)} 调用 resolveToolsRoot`);
  }
  // main() eager loadGates(ws)；controlledGit 内 loadShellRules(ws)
  const mainTail = src.slice(src.indexOf('function main()'));
  assert.ok(mainTail.includes('loadGates(ws)'), 'main() eager loadGates(ws)');
  const cg = src.slice(src.indexOf('function controlledGit('), src.indexOf('function controlledGit(') + 1200);
  assert.ok(cg.includes('loadShellRules(ws)'), 'controlledGit 内 loadShellRules(ws)');
  // toolsRootCache：单值成功缓存；_shellRules 独立；无 module-scope workspace 全局
  const cacheDecl = src.slice(src.indexOf('let toolsRootCache'), src.indexOf('let toolsRootCache') + 160);
  assert.match(cacheDecl, /undefined=未解析, string=成功/, 'toolsRootCache 仅成功值');
  assert.equal((src.match(/toolsRootCache = /g) || []).length, 1, 'toolsRootCache 仅一处赋值');
  assert.ok(src.includes('let _shellRules;'), '_shellRules 独立声明');
  assert.ok(!/^let ws\s*=|^const ws\s*=/m.test(src), '无 module-scope workspace 全局');
  // resolver/loader 区域无 Map 缓存（全文件 new Map 仅 task 索引用途）
  const resolverZone = src.slice(src.indexOf('let toolsRootCache'), src.indexOf('function loadShellRules(ws)'));
  assert.ok(!resolverZone.includes('new Map('), 'Tools Root 区域无 Map 缓存');
  assert.ok(!src.includes('telemetry'), '无 telemetry');
});

// ── CR-2026-029 TASK-03：merge pipeline 发布联调走查文本静态断言 ──

test('CR-2026-029：merge-feature-branch 收敛为 crctl merge 单深原语（TASK-10），merge-verification 由深原语落盘', () => {
  const md = readFileSync(path.join(PACKAGE_ROOT, 'skills', 'writeback', 'merge-feature-branch', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(md.includes('crctl merge {cr_id}'), '一次深原语调用');
  assert.ok(!/runGit/.test(md), '不写 Git 命令序列');
  assert.ok(!/merge --no-commit|--no-ff|merge --abort/.test(md), '无手工 merge 流程');
  assert.ok(md.includes('merge-verification.md'), 'merge-verification 产出契约（由深原语落盘）');
  assert.ok(md.includes('operational_workspace'), '透传 operational_workspace');
});
test('CR-2026-029：feature-writeback pipeline 各节点 prompt 收敛为深原语调用（TASK-10）', () => {
  const pl = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'pipeline-templates', 'feature-writeback.pipeline.json'), 'utf8'));
  const merge = pl.nodes.find((n) => n.ref === 'merge-feature-branch');
  assert.ok(merge, 'merge-feature-branch 节点存在');
  assert.ok(merge.prompt.includes('crctl merge {{inputs.cr_id}}'), 'prompt 含 crctl merge 深原语');
  assert.ok(merge.prompt.includes('operational_workspace'), 'prompt 透传 operational_workspace');
  assert.ok(!merge.prompt.includes('--no-ff') && !merge.prompt.includes('merge --abort'), '无手工 merge 流程');
  const wb = pl.nodes.find((n) => n.ref === 'writeback-prd-sdd');
  assert.ok(wb.prompt.includes('writeback-apply'), 'writeback 节点含 writeback-apply');
  const arc = pl.nodes.find((n) => n.ref === 'cr-archive');
  assert.ok(arc.prompt.includes('crctl archive {{inputs.cr_id}}'), 'archive 节点含 crctl archive 深原语');
  assert.ok(!arc.prompt.includes('archive-move'), '无 archive-move 旧命令');
});

test('CR-2026-029：write-dev-tasks 无发布联调类任务拆分指引（FR-3）', () => {
  const skill = readFileSync(path.join(PACKAGE_ROOT, 'skills', 'develop', 'write-dev-tasks', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const pl = readFileSync(path.join(PACKAGE_ROOT, 'pipeline-templates', 'code-implementation.pipeline.json'), 'utf8').replace(/\r\n/g, '\n');
  for (const [name, text] of [['write-dev-tasks', skill], ['code-implementation', pl]]) {
    assert.ok(!/发布.{0,12}联调|联调.{0,12}TASK|发布类任务拆分/.test(text), `${name} 不含发布联调类 TASK 拆分指引`);
  }
});

// ══════════════════════════════════════════════════════════════════════
// CR-2026-030 TASK-01：TCA-001~004 失败优先测试基线（red tests）
// 输入：SDD v0.1.1 §7.1~§7.2；输出：供 TASK-02~05 实现转绿的黑盒断言。
// 覆盖 PRD AC-1~AC-22、AC-24~AC-25 的 crctl 运行时面；Skill/Pipeline
// 静态契约由 TASK-06 承接（AC-26/AC-30/AC-31）。
// 不删除既有 189 项测试；新增向量在对应生产能力落地前按预期失败。
// ══════════════════════════════════════════════════════════════════════

/** 在 ws 里直跑 git（测试侧免白名单）。 */
function git(ws, args) {
  const r = spawnSync('git', ['-C', ws, ...args], { encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** 一次性临时 git 仓 workspace（真实 repo：clean baseline 语义依赖它）。 */
function makeGitWorkspace() {
  const ws = makeWorkspace();
  git(ws, ['init', '-b', 'master']);
  git(ws, ['config', 'user.email', 't@t']);
  git(ws, ['config', 'user.name', 'tester']);
  return ws;
}

/** 读 .crctl/audit.log 为对象数组（文件不存在返回 []）。 */
function auditLines(ws) {
  const p = path.join(ws, '.crctl', 'audit.log');
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** 列出 .crctl/outbox/*.json 文件名（目录不存在返回 []）。 */
function outboxFiles(ws) {
  const p = path.join(ws, '.crctl', 'outbox');
  return existsSync(p) ? readdirSync(p).filter((f) => f.endsWith('.json')) : [];
}

function outboxEvents(ws) {
  return outboxFiles(ws).map((f) => JSON.parse(readFileSync(path.join(ws, '.crctl', 'outbox', f), 'utf8')));
}

/**
 * 双投影一致的完整 Owner fixture：cr.md（owner/owners/owner-history/handover-history）
 * + _backlog.yml（owner/owners）。opts.backlogOwners 可注入 backlog 侧漂移（cr.md 不变）。
 */
function writeOwnerEntry(ws, cr, status, opts = {}) {
  const at = opts.assignedAt || '2026-08-04T12:00:00+08:00';
  const mdOwners = opts.crMdOwners || { requirement: 'Ray', development: 'Ray', test: 'Ray' };
  const blOwners = opts.backlogOwners || mdOwners;
  const dir = path.join(ws, 'change-requests', cr);
  mkdirSync(dir, { recursive: true });
  const crMd = ['---', `id: ${cr}`, `status: ${status}`, `owner: ${mdOwners.requirement}`, 'owners:',
    ...Object.entries(mdOwners).flatMap(([r, id]) => [`  ${r}:`, `    id: ${id}`, `    assigned-at: "${at}"`]),
    'owner-history:',
    ...Object.entries(mdOwners).map(([r, id]) => `  - { role: ${r}, from: "", to: ${id}, at: "${at}", reason: initial-assignment }`),
    'handover-history: []',
    ...(opts.extraCrMd || []), '---', ''];
  writeFileSync(path.join(dir, 'cr.md'), crMd.join('\n'));
  const bl = ['schema: cr-backlog/v2', 'change-requests:', `  - id: ${cr}`, `    title: T`, `    owner: ${blOwners.requirement}`, '    owners:',
    ...Object.entries(blOwners).flatMap(([r, id]) => [`      ${r}:`, `        id: ${id}`, `        assigned-at: "${at}"`]),
    ...(opts.extraBacklog || [])];
  writeFileSync(path.join(ws, 'change-requests', '_backlog.yml'), bl.join('\n') + '\n');
}

/** 构造 owner-set dirty fixture（kind: staged-only|unstaged-only|mixed-same|mixed-diff）。
 * 两个 tracked 文件 prd.md/sdd.md 在 seed 提交中；untracked 另造 scratch.txt。 */
function dirtyOwnerFixture(kind) {
  const ws = makeGitWorkspace();
  writeOwnerEntry(ws, 'CR-T1', 'drafting');
  writeFileSync(path.join(ws, 'change-requests', 'CR-T1', 'prd.md'), '# prd\n');
  writeFileSync(path.join(ws, 'change-requests', 'CR-T1', 'sdd.md'), '# sdd\n');
  git(ws, ['add', '-A']);
  git(ws, ['commit', '-m', '[cr] seed']);
  writeFileSync(path.join(ws, 'scratch.txt'), 'untracked\n'); // 恒定 untracked 存在：验证其不阻塞 dirty 判定
  const prd = path.join(ws, 'change-requests', 'CR-T1', 'prd.md');
  const sdd = path.join(ws, 'change-requests', 'CR-T1', 'sdd.md');
  if (kind === 'staged-only') { writeFileSync(prd, '# prd v2\n'); git(ws, ['add', 'change-requests/CR-T1/prd.md']); }
  else if (kind === 'unstaged-only') writeFileSync(prd, '# prd v2\n');
  else if (kind === 'mixed-same') { writeFileSync(prd, '# prd v2\n'); git(ws, ['add', 'change-requests/CR-T1/prd.md']); writeFileSync(prd, '# prd v3\n'); }
  else if (kind === 'mixed-diff') { writeFileSync(prd, '# prd v2\n'); git(ws, ['add', 'change-requests/CR-T1/prd.md']); writeFileSync(sdd, '# sdd v2\n'); }
  return ws;
}

/** 写 owner-set 前置注册文件（cr-init 三文件基线：空 backlog + 空 index）。 */
function writeRegistrationBase(ws) {
  writeBacklog(ws, []);
  writeIndex(ws, []);
  git(ws, ['add', '-A']);
  git(ws, ['commit', '-m', '[cr] seed']);
}

// ── TASK-01/FR-1：三 Owner 原子注册（AC-1~AC-2）────────────────────────


// ── TASK-01/FR-2：注册提交与真实 SHA 事件（AC-3~AC-5）──────────────────


// ── TASK-01/FR-3~FR-5：Owner 正式移交原语（AC-7~AC-16）─────────────────

test('CR-2026-030 TASK-01：owner-set 双投影漂移 → OWNER_PROJECTION_DRIFT 零写入（AC-7）', () => {
  const ws = makeGitWorkspace();
  try {
    writeOwnerEntry(ws, 'CR-T1', 'drafting', { backlogOwners: { requirement: 'Ray', development: 'Alice', test: 'Ray' } });
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-m', '[cr] seed']);
    const md0 = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8');
    const bl0 = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const head0 = git(ws, ['rev-parse', 'HEAD']);
    const r = runCrctl(['owner-set', 'CR-T1', '--role', 'development', '--id', 'Bob', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'OWNER_PROJECTION_DRIFT');
    assert.equal(readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8'), md0, 'cr.md 零写入');
    assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), bl0, 'backlog 零写入');
    assert.equal(git(ws, ['rev-parse', 'HEAD']), head0);
    assert.equal(git(ws, ['status', '--short']), '', 'worktree 分层不变');
    assert.equal(auditLines(ws).filter((a) => a.op === 'owner-set').length, 0);
    assert.equal(outboxFiles(ws).length, 0);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 TASK-01：owner-set 真实移交——双投影同步、owner-history 仅一条、不追加 handover-history、commit 只含两账本（AC-8/AC-16）', () => {
  const ws = makeGitWorkspace();
  try {
    writeOwnerEntry(ws, 'CR-T1', 'drafting');
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-m', '[cr] seed']);
    const head0 = git(ws, ['rev-parse', 'HEAD']);
    const r = runCrctl(['owner-set', 'CR-T1', '--role', 'development', '--id', 'Alice', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.changed, true);
    assert.equal(r.stdout.role, 'development');
    assert.equal(r.stdout.from, 'Ray');
    assert.equal(r.stdout.to, 'Alice');
    assert.ok(r.stdout.handoverAt && r.stdout.commit && r.stdout.commit.sha, 'handoverAt + commit sha 返回');
    const md = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8');
    assert.ok(md.includes('owner: Ray'), 'requirement 兼容 owner 不受 development 移交影响');
    assert.ok(md.includes('id: Alice'), 'cr.md development 投影更新');
    const hist = [...md.matchAll(/^\s*- \{ role: development, from: Ray, to: Alice, at: "([^"]+)", reason: formal-handover \}$/gm)];
    assert.equal(hist.length, 1, 'owner-history 只追加一条 formal-handover');
    assert.equal(hist[0][1], r.stdout.handoverAt, 'history at == 本次唯一时间戳');
    assert.ok(!md.includes('handover-history:\n  -'), 'handover-history 不追加');
    const bl = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.ok(bl.includes('id: Alice'), 'backlog development 投影更新');
    assert.notEqual(git(ws, ['rev-parse', 'HEAD']), head0, '形成新 commit');
    const files = git(ws, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').filter(Boolean);
    assert.deepEqual(files.sort(), ['change-requests/CR-T1/cr.md', 'change-requests/_backlog.yml'], '成功 commit 只含两账本');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 review repair：owner-set 将 owner-history: [] 展开后追加，不得把条目插到 frontmatter 首行（AC-8）', () => {
  const ws = makeGitWorkspace();
  try {
    writeOwnerEntry(ws, 'CR-T1', 'drafting');
    const mdPath = path.join(ws, 'change-requests', 'CR-T1', 'cr.md');
    const md = readFileSync(mdPath, 'utf8').replace(/owner-history:\n(?:  - .*\n){3}/, 'owner-history: []\n');
    writeFileSync(mdPath, md);
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-m', '[cr] seed empty owner history']);

    const r = runCrctl(['owner-set', 'CR-T1', '--role', 'development', '--id', 'Alice', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    const updated = readFileSync(mdPath, 'utf8');
    assert.match(updated, /^---\nid: CR-T1\n/, 'frontmatter 首个字段仍为 id');
    assert.match(updated, /owner-history:\n  - \{ role: development, from: Ray, to: Alice, /, '空 flow 展开后追加 formal-handover');
    const status = runCrctl(['status', 'CR-T1', '--workspace', ws]);
    assert.equal(status.status, 0, status.rawStderr);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 TASK-01：owner-set requirement 移交——cr.md 与 backlog 顶层兼容 owner 同步（AC-8）', () => {
  const ws = makeGitWorkspace();
  try {
    writeOwnerEntry(ws, 'CR-T1', 'drafting');
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-m', '[cr] seed']);
    const r = runCrctl(['owner-set', 'CR-T1', '--role', 'requirement', '--id', 'Boss', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.changed, true);
    const md = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8');
    const bl = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.equal([...md.matchAll(/^owner: (\S+)$/gm)].filter((m) => m[1] === 'Boss').length, 1, 'cr.md 顶层 owner 同步');
    assert.equal([...bl.matchAll(/^    owner: (\S+)$/gm)].filter((m) => m[1] === 'Boss').length, 1, 'backlog 顶层 owner 同步');
    assert.ok(md.includes('reason: formal-handover') && bl.includes('id: Boss'));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 TASK-01：owner-set note 只进 owner-history/inbox，不进 owners outbox 与成功 audit（AC-8/AC-13）', () => {
  const ws = makeGitWorkspace();
  try {
    writeOwnerEntry(ws, 'CR-T1', 'drafting');
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-m', '[cr] seed']);
    const r = runCrctl(['owner-set', 'CR-T1', '--role', 'test', '--id', 'Tina', '--note', '移交说明', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    const md = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8');
    assert.ok(/note: "移交说明"|note: 移交说明/.test(md), 'note 进入 cr.md owner-history');
    const events = outboxEvents(ws);
    const ownersEv = events.find((e) => e.event_kind === 'owners');
    const inboxEv = events.find((e) => e.event_kind === 'inbox');
    assert.ok(ownersEv && inboxEv, 'owners + inbox 两类 outbox 事件存在');
    assert.equal(ownersEv.commit_sha, r.stdout.commit.sha, 'owners 事件 SHA == 真实 commit SHA');
    assert.equal(inboxEv.commit_sha, r.stdout.commit.sha, 'inbox 事件与 owners 同一 SHA');
    assert.ok(!JSON.stringify(ownersEv.payload).includes('移交说明'), 'owners payload 不含 note');
    assert.equal(ownersEv.payload.changes.length, 1, 'owners change 恰一项');
    assert.ok(!ownersEv.payload.changes[0].note, 'change 不含 note');
    assert.ok(!ownersEv.payload.subject && !ownersEv.payload.body, 'owners payload 无 subject/body');
    assert.equal(ownersEv.payload.handover_at, r.stdout.handoverAt, 'owners handover_at == 唯一时间戳');
    assert.equal(inboxEv.payload.event, 'owner-handover');
    assert.ok(JSON.stringify(inboxEv.payload).includes('移交说明'), 'note 进入 inbox payload');
    assert.equal(inboxEv.payload.handover_at, r.stdout.handoverAt, 'inbox handover_at == 唯一时间戳');
    const okAudits = auditLines(ws).filter((a) => a.op === 'owner-set' && a.result === 'ok');
    assert.equal(okAudits.length, 1);
    assert.ok(!JSON.stringify(okAudits[0]).includes('移交说明'), '成功 audit 不含 note');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 TASK-01：owner-set 同值重放（clean）→ changed=false 且时间/历史/notify/audit/commit/outbox 全不变（AC-10）', () => {
  const ws = makeGitWorkspace();
  try {
    writeOwnerEntry(ws, 'CR-T1', 'drafting');
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-m', '[cr] seed']);
    const head0 = git(ws, ['rev-parse', 'HEAD']);
    const md0 = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8');
    const bl0 = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const r = runCrctl(['owner-set', 'CR-T1', '--role', 'development', '--id', 'Ray', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.changed, false);
    assert.equal(r.stdout.id, 'Ray');
    assert.equal(git(ws, ['rev-parse', 'HEAD']), head0, '无 commit');
    assert.equal(readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8'), md0, 'cr.md 不变（含 assigned-at）');
    assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), bl0, 'backlog 不变');
    assert.equal(auditLines(ws).filter((a) => a.op === 'owner-set').length, 0, '无成功 audit');
    assert.equal(outboxFiles(ws).length, 0, '无 outbox');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 TASK-01：owner-set tracked dirty（staged-only/unstaged-only/mixed-same/mixed-diff）→ OWNER_WORKTREE_DIRTY 零副作用（AC-16）', () => {
  for (const kind of ['staged-only', 'unstaged-only', 'mixed-same', 'mixed-diff']) {
    const ws = dirtyOwnerFixture(kind);
    try {
      const md0 = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8');
      const bl0 = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
      const st0 = git(ws, ['status', '--short']);
      const head0 = git(ws, ['rev-parse', 'HEAD']);
      const r = runCrctl(['owner-set', 'CR-T1', '--role', 'development', '--id', 'Alice', '--workspace', ws]);
      assert.equal(r.status, 1, kind);
      assert.equal(r.stderr.error.code, 'OWNER_WORKTREE_DIRTY', kind);
      assert.ok(Array.isArray(r.stderr.error.staged) && Array.isArray(r.stderr.error.unstaged), `${kind} 分列 staged/unstaged 路径`);
      assert.equal(readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8'), md0, `${kind} cr.md 零写入`);
      assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), bl0, `${kind} backlog 零写入`);
      assert.equal(git(ws, ['status', '--short']), st0, `${kind} 既有分层不变`);
      assert.equal(git(ws, ['rev-parse', 'HEAD']), head0, `${kind} HEAD 不变`);
      assert.equal(auditLines(ws).filter((a) => a.op === 'owner-set').length, 0, `${kind} 无 audit`);
      assert.equal(outboxFiles(ws).length, 0, `${kind} 无 outbox`);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
});

test('CR-2026-030 TASK-01：owner-set untracked-only 不阻塞——真实移交成功（AC-16）', () => {
  const ws = makeGitWorkspace();
  try {
    writeOwnerEntry(ws, 'CR-T1', 'drafting');
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-m', '[cr] seed']);
    writeFileSync(path.join(ws, 'scratch.txt'), 'untracked\n');
    const r = runCrctl(['owner-set', 'CR-T1', '--role', 'development', '--id', 'Alice', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.changed, true, 'untracked 不阻塞正式移交');
    assert.ok(r.stdout.commit && r.stdout.commit.sha, '形成 commit');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review repair：owner-set rename 间隙崩溃后整组回滚并安全重试', () => {
  const ws = makeGitWorkspace();
  try {
    writeOwnerEntry(ws, 'CR-T1', 'drafting');
    git(ws, ['add', '-A']); git(ws, ['commit', '-m', '[cr] seed']);
    const r1 = runCrctl(['owner-set', 'CR-T1', '--role', 'development', '--id', 'Alice', '--workspace', ws], { CRCTL_FAULT_POINT: 'tx-apply-between-rename' });
    assert.equal(r1.status, 1);
    assert.equal(r1.stderr.error.code, 'FAULT_INJECTED');
    const r2 = runCrctl(['owner-set', 'CR-T1', '--role', 'development', '--id', 'Alice', '--workspace', ws]);
    assert.equal(r2.status, 0, r2.rawStderr);
    assert.equal(r2.stdout.changed, true);
    assert.equal(git(ws, ['log', '--format=%s', '--grep=owner handover']).split('\n').filter(Boolean).length, 1);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 TASK-01：owner-set commit 失败 → OWNER_COMMIT_FAILED/changed=false/rolled_back=true，恢复 clean baseline（AC-14）', () => {
  const ws = makeGitWorkspace();
  try {
    writeOwnerEntry(ws, 'CR-T1', 'drafting');
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-m', '[cr] seed']);
    mkdirSync(path.join(ws, '.githooks'), { recursive: true });
    writeFileSync(path.join(ws, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    git(ws, ['config', 'core.hooksPath', '.githooks']);
    const md0 = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8');
    const bl0 = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const head0 = git(ws, ['rev-parse', 'HEAD']);
    const r = runCrctl(['owner-set', 'CR-T1', '--role', 'development', '--id', 'Alice', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'OWNER_COMMIT_FAILED');
    assert.equal(r.stderr.error.changed, false);
    assert.equal(r.stderr.error.rolled_back, true);
    assert.equal(readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'cr.md'), 'utf8'), md0, 'cr.md 恢复原文');
    assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), bl0, 'backlog 恢复原文');
    assert.equal(git(ws, ['status', '--porcelain', '--untracked-files=no']), '', 'tracked clean baseline 恢复（untracked 不算 dirty）');
    assert.equal(git(ws, ['rev-parse', 'HEAD']), head0, 'HEAD 不变');
    assert.equal(auditLines(ws).filter((a) => a.op === 'owner-set' && a.result === 'ok').length, 0, '无成功 audit');
    assert.equal(outboxFiles(ws).length, 0, '无 outbox');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 TASK-01：owner-set 恢复失败 → OWNER_COMMIT_ROLLBACK_FAILED 并列出受影响文件（AC-15）', () => {
  const ws = makeGitWorkspace();
  try {
    writeOwnerEntry(ws, 'CR-T1', 'drafting');
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-m', '[cr] seed']);
    mkdirSync(path.join(ws, '.githooks'), { recursive: true });
    writeFileSync(path.join(ws, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    git(ws, ['config', 'core.hooksPath', '.githooks']);
    // lock-owner/journal/blob/manifest/apply 共 10 次 rename；第 11 次是 rollback 首次恢复
    const prelude = [
      "import fs from 'node:fs';",
      'const rn = fs.renameSync.bind(fs);',
      'let n = 0;',
      "fs.renameSync = (a, b) => { n += 1; if (n >= 11) throw new Error('injected rename failure'); return rn(a, b); };",
    ].join('\n');
    const r = runCrctlWrapped(['owner-set', 'CR-T1', '--role', 'development', '--id', 'Alice', '--workspace', ws], prelude);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'OWNER_COMMIT_ROLLBACK_FAILED', r.rawStderr);
    assert.ok(Array.isArray(r.stderr.error.affected), '列出受影响文件');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── TASK-01/FR-6~FR-7：签名 grant 双模式与 reject（AC-17~AC-22）────────

/** 四 stage 审批 fixture：真实 git 仓 + 该 stage 前置证据 + 回退目标态所需历史门禁文件。 */
function makeStageWorkspace(stage) {
  const ws = makeGitWorkspace();
  const cr = 'CR-G1';
  const ev = (rel, content) => writeEvidence(ws, cr, rel, content);
  if (stage === 'requirement') {
    writeCrEntry(ws, cr, 'requirement-reviewing');
    ev('review-annotations/requirement.yml', 'verdict: pass\nblockers: []\n');
  } else if (stage === 'tech-design') {
    writeCrEntry(ws, cr, 'tech-design-review-pending');
    ev('review-annotations/requirement.yml', 'verdict: pass\nblockers: []\n');
    writeApprovalYml(ws, cr, 'requirement', {
      approver: 'alice', 'approved-at': '2026-08-10T10:00:00+08:00', via: 'crctl-approve',
      'evidence-digest': canonicalDigestOf(['verdict: pass\nblockers: []\n']), 'target-status': 'requirement-approved',
    });
    ev('sdd.md', '# sdd\n');
    ev('review-annotations/sdd.yml', 'verdict: pass\nblockers: []\n');
  } else if (stage === 'dev-start') {
    writeCrEntry(ws, cr, 'task-breakdown');
    ev('plan.md', '# plan\n');
    ev('tasks/_index.yml', 'tasks:\n  - id: CR-G1-TASK-01\n');
    ev('tasks/TASK-01.md', '# TASK-01\n');
    // CR-2026-039 TASK-02/03：freshness 需 digest（fixture 一致携 subject-sha256）
    ev('review-annotations/dev-plan.yml', `verdict: pass\nblockers: []\nsubject-sha256: ${expectDevPlanDigest(ws, cr)}\n`);
    ev('sdd.md', '# sdd\n');
    ev('review-annotations/sdd.yml', 'verdict: pass\nblockers: []\n');
    writeApprovalYml(ws, cr, 'tech-design', {
      approver: 'alice', 'approved-at': '2026-08-10T10:00:00+08:00', via: 'crctl-approve',
      'evidence-digest': canonicalDigestOf(['verdict: pass\nblockers: []\n']), 'target-status': 'tech-design-reviewed',
    });
  } else if (stage === 'code') {
    writeCrEntry(ws, cr, 'code-reviewing');
    ev('plan.md', '# plan\n');
    ev('tasks/_index.yml', 'tasks:\n  - id: CR-G1-TASK-01\n');
    ev('tasks/TASK-01.md', '# TASK-01\n');
    // CR-2026-039 TASK-02：reject 回退 developing 同样过 passCondition(dev-start) 门禁，freshness 需 digest
    const devPlanAnn = `verdict: pass\nblockers: []\nsubject-sha256: ${expectDevPlanDigest(ws, cr)}\n`;
    ev('review-annotations/dev-plan.yml', devPlanAnn);
    writeApprovalYml(ws, cr, 'development-start', {
      approver: 'alice', 'approved-at': '2026-08-10T10:00:00+08:00', via: 'crctl-approve',
      'evidence-digest': canonicalDigestOf(['# plan\n', devPlanAnn]), 'target-status': 'developing',
    });
    ev('review-annotations/code.yml', 'verdict: pass\nblockers: []\n');
    ev('test-report.md', '# report\n');
  }
  git(ws, ['add', '-A']);
  git(ws, ['commit', '-m', '[cr] seed']);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(path.join(ws, '.crctl', 'keys'), { recursive: true });
  writeFileSync(path.join(ws, '.crctl', 'keys', 'approval-test.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
  return { ws, privateKey };
}

/** 按 gates.json evidence 声明顺序取 stage 证据文本（与 canonicalEvidenceDigest 排序一致）。 */
function stageEvidenceTexts(ws, stage) {
  const cr = 'CR-G1';
  const read = (rel) => readFileSync(path.join(ws, 'change-requests', cr, rel), 'utf8');
  if (stage === 'requirement') return [read('review-annotations/requirement.yml')];
  if (stage === 'tech-design') return [read('review-annotations/sdd.yml')];
  if (stage === 'dev-start') return [read('plan.md'), read('review-annotations/dev-plan.yml')];
  return [read('review-annotations/code.yml'), read('test-report.md')];
}

/** 签发 stage grant（decision 可覆盖为 reject；signature 可覆盖为伪造）。 */
function makeStageGrant(ws, privateKey, stage, overrides = {}) {
  const grant = {
    v: 1, cr_id: 'CR-G1', stage, decision: 'approve',
    approver: 'alice@corp', approved_at: '2026-08-11T10:00:00+08:00',
    evidence_digest: canonicalDigestOf(stageEvidenceTexts(ws, stage)),
    key_id: 'approval-test',
    ...overrides,
  };
  const canonical = `v1|${grant.cr_id}|${grant.stage}|${grant.decision}|${grant.approver}|${grant.approved_at}|${grant.evidence_digest}`;
  grant.signature = overrides.signature ?? cryptoSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
  const gp = path.join(ws, 'grant.json');
  writeFileSync(gp, JSON.stringify(grant, null, 2));
  return gp;
}

test('CR-2026-030 TASK-01：四 stage reject grant → APPROVAL_DECLINED_ROLLED_BACK + 各自权威 trigger 回退（AC-18/AC-20）', () => {
  const cases = [
    { stage: 'requirement', to: 'drafting', trigger: 'approve-requirement:reject -> write-requirement-prd' },
    { stage: 'tech-design', to: 'tech-designing', trigger: 'approve-tech-design:reject -> write-tech-design' },
    { stage: 'dev-start', to: 'tech-design-reviewed', trigger: 'approve-dev-start:reject -> write-dev-plan' },
    { stage: 'code', to: 'developing', trigger: 'approve-code:reject -> implement-code' },
  ];
  for (const c of cases) {
    const { ws, privateKey } = makeStageWorkspace(c.stage);
    try {
      const gp = makeStageGrant(ws, privateKey, c.stage, { decision: 'reject' });
      const r = runCrctl(['approve', 'CR-G1', '--stage', c.stage, '--grant', gp, '--workspace', ws]);
      assert.equal(r.status, 1, `${c.stage}: ${r.rawStderr}`);
      assert.equal(r.stderr.error.code, 'APPROVAL_DECLINED_ROLLED_BACK', c.stage);
      assert.equal(r.stderr.error.decision, 'reject', c.stage);
      assert.equal(r.stderr.error.stage, c.stage, c.stage);
      assert.equal(r.stderr.error.rolledBackTo, c.to, c.stage);
      assert.equal(r.stderr.error.trigger, c.trigger, c.stage);
      assert.equal(r.stderr.error.changed, true, c.stage);
      assert.ok(!JSON.stringify(r.stderr.error).includes('rerunHint'), `${c.stage} 无 rerunHint`);
      const md = readFileSync(path.join(ws, 'change-requests', 'CR-G1', 'cr.md'), 'utf8');
      assert.ok(md.includes(`status: ${c.to}`), `${c.stage} 回退到 ${c.to}`);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
});

test('CR-2026-030 TASK-01：reject grant 伪造签名 → SIGNATURE_INVALID 零写入（AC-19）', () => {
  const { ws, privateKey } = makeStageWorkspace('requirement');
  try {
    const gp = makeStageGrant(ws, privateKey, 'requirement', { decision: 'reject', signature: 'Zm9yZ2Vk' });
    const md0 = readFileSync(path.join(ws, 'change-requests', 'CR-G1', 'cr.md'), 'utf8');
    const head0 = git(ws, ['rev-parse', 'HEAD']);
    const r = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'SIGNATURE_INVALID');
    assert.equal(readFileSync(path.join(ws, 'change-requests', 'CR-G1', 'cr.md'), 'utf8'), md0, 'cr.md 零写入');
    assert.equal(git(ws, ['rev-parse', 'HEAD']), head0);
    assert.equal(outboxFiles(ws).length, 0, '无 outbox');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 TASK-01：reject grant 跨 CR → GRANT_MISMATCH；证据漂移 → EVIDENCE_DRIFT；错误状态 → GRANT_STATE_MISMATCH（AC-19/AC-22）', () => {
  const { ws, privateKey } = makeStageWorkspace('requirement');
  try {
    // 跨 CR 挪用
    let gp = makeStageGrant(ws, privateKey, 'requirement', { decision: 'reject', cr_id: 'CR-OTHER' });
    let r = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'GRANT_MISMATCH');
    // 证据漂移：先按原证据签发 grant，再改动证据文件（digest 失配）
    gp = makeStageGrant(ws, privateKey, 'requirement', { decision: 'reject' });
    writeEvidence(ws, 'CR-G1', 'review-annotations/requirement.yml', 'verdict: pass\nblockers: []\n# changed\n');
    r = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'EVIDENCE_DRIFT');
    // 错误状态：恢复证据后把 CR 推到审批目标态（模拟已推进）
    writeEvidence(ws, 'CR-G1', 'review-annotations/requirement.yml', 'verdict: pass\nblockers: []\n');
    const md = readFileSync(path.join(ws, 'change-requests', 'CR-G1', 'cr.md'), 'utf8');
    writeFileSync(path.join(ws, 'change-requests', 'CR-G1', 'cr.md'), md.replace('status: requirement-reviewing', 'status: requirement-approved'));
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-m', '[cr] moved']);
    gp = makeStageGrant(ws, privateKey, 'requirement', { decision: 'reject' });
    r = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'GRANT_STATE_MISMATCH', '非邻接结果态');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 TASK-01：approve 紧邻目标态 replay（持久化字段完全一致）→ changed=false 零副作用（AC-21）', () => {
  const { ws, privateKey } = makeStageWorkspace('requirement');
  try {
    const gp = makeStageGrant(ws, privateKey, 'requirement');
    const r1 = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r1.status, 0, r1.rawStderr);
    const head1 = git(ws, ['rev-parse', 'HEAD']);
    const audits1 = auditLines(ws).length;
    const outbox1 = outboxFiles(ws).length;
    const r2 = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r2.status, 0, r2.rawStderr);
    assert.equal(r2.stdout.changed, false, '幂等重放 changed=false');
    assert.equal(git(ws, ['rev-parse', 'HEAD']), head1, '无新 commit');
    assert.equal(auditLines(ws).length, audits1, '无新 audit');
    assert.equal(outboxFiles(ws).length, outbox1, '无新 outbox');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 TASK-01：reject 紧邻回退态 replay → APPROVAL_DECLINED_ROLLED_BACK/changed=false（AC-21）', () => {
  const { ws, privateKey } = makeStageWorkspace('requirement');
  try {
    const gp = makeStageGrant(ws, privateKey, 'requirement', { decision: 'reject' });
    const r1 = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r1.status, 1);
    assert.equal(r1.stderr.error.code, 'APPROVAL_DECLINED_ROLLED_BACK');
    assert.equal(r1.stderr.error.changed, true);
    const head1 = git(ws, ['rev-parse', 'HEAD']);
    const r2 = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r2.status, 1);
    assert.equal(r2.stderr.error.code, 'APPROVAL_DECLINED_ROLLED_BACK', '紧邻回退态重放仍返回业务结果');
    assert.equal(r2.stderr.error.changed, false, '重放 changed=false');
    assert.equal(git(ws, ['rev-parse', 'HEAD']), head1, '无新 commit');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review repair：approve rename 间隙崩溃后整组回滚并安全重试', () => {
  const { ws, privateKey } = makeStageWorkspace('requirement');
  try {
    const gp = makeStageGrant(ws, privateKey, 'requirement');
    const r1 = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws], { CRCTL_FAULT_POINT: 'tx-apply-between-rename' });
    assert.equal(r1.status, 1);
    assert.equal(r1.stderr.error.code, 'FAULT_INJECTED');
    const r2 = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r2.status, 0, r2.rawStderr);
    assert.equal(r2.stdout.to, 'requirement-approved');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review repair：approve commit 后崩溃由 tx trailer 判定已提交，不回滚 authority', () => {
  const { ws, privateKey } = makeStageWorkspace('requirement');
  try {
    const gp = makeStageGrant(ws, privateKey, 'requirement');
    const r1 = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws], { CRCTL_FAULT_POINT: 'ledger-after-commit' });
    assert.equal(r1.status, 1);
    assert.equal(r1.stderr.error.code, 'FAULT_INJECTED');
    const head = git(ws, ['rev-parse', 'HEAD']);
    assert.match(git(ws, ['log', '-1', '--format=%B']), /AI-First-Tx:/);
    const r2 = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r2.status, 0, r2.rawStderr);
    assert.equal(r2.stdout.changed, false);
    assert.equal(git(ws, ['rev-parse', 'HEAD']), head, '恢复不得重复 commit 或回滚已提交 authority');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review repair：approve commit 失败由 ledger transaction 回滚，修复 hook 后同 grant 可安全重试', () => {
  const { ws, privateKey } = makeStageWorkspace('requirement');
  try {
    mkdirSync(path.join(ws, '.githooks'), { recursive: true });
    writeFileSync(path.join(ws, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    git(ws, ['config', 'core.hooksPath', '.githooks']);
    const gp = makeStageGrant(ws, privateKey, 'requirement');
    const r1 = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r1.status, 1, 'commit 失败为技术失败');
    git(ws, ['config', '--unset', 'core.hooksPath']);
    const head1 = git(ws, ['rev-parse', 'HEAD']);
    assert.match(readFileSync(path.join(ws, 'change-requests', 'CR-G1', 'cr.md'), 'utf8'), /status:\s*requirement-reviewing/, '失败后状态回滚');
    assert.equal(git(ws, ['status', '--porcelain', '--untracked-files=no']), '', '失败后 index/worktree 恢复 clean baseline');
    const r2 = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r2.status, 0, r2.rawStderr);
    assert.notEqual(git(ws, ['rev-parse', 'HEAD']), head1, '重试形成唯一成功 commit');
    assert.equal(r2.stdout.to, 'requirement-approved');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 TASK-01：approve 持久化字段不一致 → GRANT_STATE_MISMATCH（AC-22）', () => {
  const { ws, privateKey } = makeStageWorkspace('requirement');
  try {
    const gp = makeStageGrant(ws, privateKey, 'requirement');
    const r1 = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r1.status, 0, r1.rawStderr);
    // 篡改 approval.yml 的 approver（模拟持久化字段漂移）
    const ap = path.join(ws, 'change-requests', 'CR-G1', 'approval.yml');
    writeFileSync(ap, readFileSync(ap, 'utf8').replace('approver: "alice@corp"', 'approver: "mallory@corp"'));
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-m', '[cr] tamper']);
    const r2 = runCrctl(['approve', 'CR-G1', '--stage', 'requirement', '--grant', gp, '--workspace', ws]);
    assert.equal(r2.status, 1);
    assert.equal(r2.stderr.error.code, 'GRANT_STATE_MISMATCH', '持久化字段不一致');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── TASK-01/FR-8：review-dev-plan 三路运行时契约（AC-24~AC-25）─────────

/** dev-plan 评审前置 fixture：task-breakdown + 回退目标态门禁文件（sdd 审批链）。 */
function writeDevPlanReviewFixture(ws, cr) {
  writeCrEntry(ws, cr, 'task-breakdown');
  writeEvidence(ws, cr, 'plan.md', '# plan\n');
  writeEvidence(ws, cr, 'tasks/_index.yml', `tasks:\n  - id: ${cr}-TASK-01\n`);
  writeEvidence(ws, cr, 'tasks/TASK-01.md', '# TASK-01\n');
  writeEvidence(ws, cr, 'sdd.md', '# sdd\n');
  writeEvidence(ws, cr, 'review-annotations/sdd.yml', 'verdict: pass\nblockers: []\n');
  writeApprovalYml(ws, cr, 'tech-design', {
    approver: 'alice', 'approved-at': '2026-08-10T10:00:00+08:00', via: 'crctl-approve',
    'evidence-digest': canonicalDigestOf(['verdict: pass\nblockers: []\n']), 'target-status': 'tech-design-reviewed',
  });
}

test('CR-2026-030 TASK-01：review-dev-plan NORMAL 完整 trigger 可执行（task-breakdown → tech-design-reviewed）（AC-24）', () => {
  const ws = makeWorkspace();
  try {
    writeDevPlanReviewFixture(ws, 'CR-T1');
    const r = runCrctl(['advance', 'CR-T1', '--to', 'tech-design-reviewed', '--trigger', 'review-dev-plan:block -> write-dev-plan', '--expect', 'task-breakdown', '--embedded', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.to, 'tech-design-reviewed');
    assert.equal(r.stdout.from, 'task-breakdown');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 TASK-01：review-dev-plan 短 trigger（review-dev-plan:block）运行时拒绝（AC-24）', () => {
  const ws = makeWorkspace();
  try {
    writeDevPlanReviewFixture(ws, 'CR-T1');
    const r = runCrctl(['advance', 'CR-T1', '--to', 'tech-design-reviewed', '--trigger', 'review-dev-plan:block', '--expect', 'task-breakdown', '--embedded', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'CR_STATUS_TRANSITION_NOT_ALLOWED', '短 trigger 在运行时仍被拒绝');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-030 TASK-01：review-dev-plan UPSTREAM trigger 可执行（task-breakdown → tech-design-review-pending）（AC-25）', () => {
  const ws = makeWorkspace();
  try {
    writeDevPlanReviewFixture(ws, 'CR-T1');
    const r = runCrctl(['advance', 'CR-T1', '--to', 'tech-design-review-pending', '--trigger', 'review-dev-plan:upstream-design-blocker', '--expect', 'task-breakdown', '--embedded', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.to, 'tech-design-review-pending');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

/* ── CR-2026-031 TASK-06：signed release snapshot（SDD §3.4 / FR-06）──────────────
 * fixture：单仓（kb = ws 本体）+ 真实 linked worktree 承载被评审源 HEAD；
 * 受控 artifact = prd/sdd/plan/tasks（落在 kb trunk 视图）。 */
function makeCodeStageWorkspace() {
  const { ws, privateKey } = makeDevStartWorkspace();
  const g = (args, cwd = ws) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); };
  // dir-graph 增加 repositories 声明（TASK-03 resolver 消费；state_machine 缺省回落 tools 包）
  writeFileSync(path.join(ws, 'dir-graph.yaml'),
    `workspace:\n  tools_package_path: ${JSON.stringify(PACKAGE_ROOT)}\nrepositories:\n  - id: kb\n    path: "."\n    trunk: master\n    role: knowledge-base\n`, 'utf8');
  writeCrEntry(ws, 'CR-D1', 'developing');
  writeEvidence(ws, 'CR-D1', 'prd.md', '# PRD\n');
  writeEvidence(ws, 'CR-D1', 'sdd.md', '# SDD\n');
  writeEvidence(ws, 'CR-D1', 'test-report.md', '---\nstatus: pass\n---\n');
  g(['add', '-A']); g(['commit', '-q', '-m', 'code stage fixtures']);
  g(['branch', 'requirement/CR-D1']);
  g(['worktree', 'add', path.join('.rayai-worktrees', 'knowledge-base', 'requirement', 'CR-D1'), 'requirement/CR-D1']);
  return { ws, privateKey };
}

const CODE_REVIEW_PAYLOAD = 'cr-id: CR-D1\nreview-type: code\nverdict: pass\nblockers: []\ndimensions:\n  spec-conformance: ok\nsuggestions: []\n';

function writeCodeReviewPayload(ws, extra = '') {
  const p = path.join(ws, '.crctl', 'tmp', 'review-code.yml');
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, CODE_REVIEW_PAYLOAD + extra, 'utf8');
  return p;
}

function codeStageEvidenceTexts(ws) {
  // gates.json approvalStages.code.evidence：code.yml + test-report.md（rel 字典序：review-annotations < test-report）
  return [
    readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'review-annotations', 'code.yml'), 'utf8'),
    readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'test-report.md'), 'utf8'),
  ];
}

function makeCodeGrant(ws, privateKey, overrides = {}) {
  const grant = {
    v: 1, cr_id: 'CR-D1', stage: 'code', decision: 'approve',
    approver: 'alice@corp', approved_at: '2026-08-11T21:00:00+08:00',
    evidence_digest: canonicalDigestOf(codeStageEvidenceTexts(ws)),
    key_id: 'approval-test',
    ...overrides,
  };
  const canonical = `v1|${grant.cr_id}|${grant.stage}|${grant.decision}|${grant.approver}|${grant.approved_at}|${grant.evidence_digest}`;
  grant.signature = overrides.signature ?? cryptoSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
  const gp = path.join(ws, 'grant-code.json');
  writeFileSync(gp, JSON.stringify(grant, null, 2));
  return gp;
}

/** review-record(code) + advance code-reviewing，返回注入后的 annotation 文本。 */
function runCodeReviewAndAdvance(ws) {
  writeCodeReviewPayload(ws);
  let r = runCrctl(['review-record', 'CR-D1', '--stage', 'code', '--workspace', ws]);
  assert.equal(r.status, 0, r.rawStderr);
  r = runCrctl(['advance', 'CR-D1', '--to', 'code-reviewing', '--trigger', 'review-code', '--expect', 'developing', '--workspace', ws]);
  assert.equal(r.status, 0, r.rawStderr);
  return readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'review-annotations', 'code.yml'), 'utf8');
}

/** 测试侧 YAML 读取：直接 import lib/yaml-subset（与被测实现同源，断言结构而非字节）。 */
let _parseYamlImpl = null;
async function parseYamlTest(text) {
  if (!_parseYamlImpl) _parseYamlImpl = (await import('../lib/yaml-subset.mjs')).parseYaml;
  return _parseYamlImpl(text.replace(/\r\n/g, '\n'));
}

test('TASK-06 ①: payload 伪造 release-subjects -> RELEASE_SUBJECTS_FORGED，annotation 零写入（AC-1）', async () => {
  const { ws } = makeCodeStageWorkspace();
  try {
    writeCodeReviewPayload(ws, 'release-subjects:\n  version: 1\n');
    const r = runCrctl(['review-record', 'CR-D1', '--stage', 'code', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'RELEASE_SUBJECTS_FORGED');
    assert.equal(existsSync(path.join(ws, 'change-requests', 'CR-D1', 'review-annotations', 'code.yml')), false, '零写入');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('TASK-06 ②: review-record --stage code 机器注入 release-subjects：逐仓 source SHA + artifact digest 与独立重算一致（AC-1/AC-2）', async () => {
  const { ws } = makeCodeStageWorkspace();
  try {
    const annotation = runCodeReviewAndAdvance(ws);
    const doc = await parseYamlTest(annotation);
    const rs = doc['release-subjects'];
    assert.ok(rs, 'annotation 必须含机器注入的 release-subjects');
    assert.equal(rs.version, 1);
    assert.equal(rs.repositories.length, 1);
    assert.equal(rs.repositories[0].repo, 'kb');
    assert.equal(rs.repositories[0]['remote-ref'], 'refs/heads/requirement/CR-D1');
    // reviewed-source-sha = CR worktree HEAD（独立 git 重算）
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(ws, '.rayai-worktrees', 'knowledge-base', 'requirement', 'CR-D1'), encoding: 'utf8' }).stdout.trim();
    assert.equal(rs.repositories[0]['reviewed-source-sha'], head);
    // artifact 哈希独立重算（CRLF→LF）
    const sha = (t) => createHash('sha256').update(t.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
    const want = {
      'change-requests/CR-D1/prd.md': sha(readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'prd.md'), 'utf8')),
      'change-requests/CR-D1/sdd.md': sha(readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'sdd.md'), 'utf8')),
      'change-requests/CR-D1/plan.md': sha(readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'plan.md'), 'utf8')),
      'change-requests/CR-D1/tasks/_index.yml': sha(readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'tasks', '_index.yml'), 'utf8')),
      'change-requests/CR-D1/tasks/TASK-01.md': sha(readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'tasks', 'TASK-01.md'), 'utf8')),
    };
    assert.equal(rs.artifacts.algorithm, 'sha256');
    assert.equal(rs.artifacts.canonicalization, 'crlf-to-lf+path-sort');
    assert.deepEqual(rs.artifacts.files.map((f) => f.path), Object.keys(want).sort(), '路径排序且集合恰为受控集');
    for (const f of rs.artifacts.files) assert.equal(f.sha256, want[f.path], `artifact hash 一致: ${f.path}`);
    assert.equal(rs.artifacts.digest, createHash('sha256').update(rs.artifacts.files.map((f) => `${f.path}:${f.sha256}`).join('\n'), 'utf8').digest('hex'));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('TASK-06 ③: approve --grant code 重核通过 -> release-subjects 原样复制到 approval.yml#code 并被 evidence-digest 签入（AC-2）', () => {
  const { ws, privateKey } = makeCodeStageWorkspace();
  try {
    const annotation = runCodeReviewAndAdvance(ws);
    const gp = makeCodeGrant(ws, privateKey);
    const r = runCrctl(['approve', 'CR-D1', '--stage', 'code', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.to, 'code-approved');
    const approval = readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'approval.yml'), 'utf8');
    // 字节语义一致：approval 段内块 = annotation 块每行缩进 2 格
    const annotationBlock = annotation.replace(/\r\n/g, '\n').slice(annotation.replace(/\r\n/g, '\n').indexOf('release-subjects:'));
    const wantBlock = annotationBlock.split('\n').filter((l) => l.length > 0).map((l) => `  ${l}`).join('\n');
    assert.ok(approval.replace(/\r\n/g, '\n').includes(wantBlock), 'approval.yml#code.release-subjects 与 annotation 块字节语义一致');
    assert.match(approval, /evidence-digest: /);
    const state = runCrctl(['status', 'CR-D1', '--workspace', ws]);
    assert.equal(state.stdout.status, 'code-approved');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('TASK-06 ④: approve 前各类漂移全部 RELEASE_SUBJECT_DRIFT 零写入，kind 精确分类（AC-1/AC-3）', () => {
  const { ws, privateKey } = makeCodeStageWorkspace();
  try {
    runCodeReviewAndAdvance(ws);
    const approvalP = path.join(ws, 'change-requests', 'CR-D1', 'approval.yml');
    const crMdP = path.join(ws, 'change-requests', 'CR-D1', 'cr.md');
    const crMdBefore = readFileSync(crMdP, 'utf8');
    let gp = null;
    const expectDrift = (kind) => {
      const r = runCrctl(['approve', 'CR-D1', '--stage', 'code', '--grant', gp, '--workspace', ws]);
      assert.equal(r.status, 1, `kind=${kind} 应失败`);
      assert.equal(r.stderr.error.code, 'RELEASE_SUBJECT_DRIFT');
      assert.equal(r.stderr.error.kind, kind);
      assert.equal(existsSync(approvalP), false, `kind=${kind} approval.yml 零写入`);
      assert.equal(readFileSync(crMdP, 'utf8'), crMdBefore, `kind=${kind} cr.md 零写入`);
    };
    // annotation 缺 release-subjects（verdict 仍 pass，passCondition 不拦截；grant 按截断版证据重签，避开 EVIDENCE_DRIFT）-> kind=missing
    const codeYmlP = path.join(ws, 'change-requests', 'CR-D1', 'review-annotations', 'code.yml');
    const annotation = readFileSync(codeYmlP, 'utf8');
    writeFileSync(codeYmlP, annotation.slice(0, annotation.indexOf('release-subjects:')), 'utf8');
    gp = makeCodeGrant(ws, privateKey);
    expectDrift('missing');
    writeFileSync(codeYmlP, annotation, 'utf8');
    gp = makeCodeGrant(ws, privateKey); // 恢复完整 annotation 后按原版证据重签
    const wt = path.join(ws, '.rayai-worktrees', 'knowledge-base', 'requirement', 'CR-D1');
    // PRD/SDD/TASK authority 均在 CR worktree。
    writeFileSync(path.join(wt, 'change-requests', 'CR-D1', 'prd.md'), '# PRD tampered\n', 'utf8');
    expectDrift('prd');
    writeFileSync(path.join(wt, 'change-requests', 'CR-D1', 'prd.md'), '# PRD\n', 'utf8');
    writeFileSync(path.join(wt, 'change-requests', 'CR-D1', 'sdd.md'), '# SDD tampered\n', 'utf8');
    expectDrift('sdd');
    writeFileSync(path.join(wt, 'change-requests', 'CR-D1', 'sdd.md'), '# SDD\n', 'utf8');
    writeFileSync(path.join(wt, 'change-requests', 'CR-D1', 'tasks', 'TASK-01.md'), '# TASK-01 tampered\n', 'utf8');
    expectDrift('task');
    writeFileSync(path.join(wt, 'change-requests', 'CR-D1', 'tasks', 'TASK-01.md'), '# TASK-01\n', 'utf8');
    // 被评审源 HEAD 漂移（worktree 新增 commit）-> kind=code
    writeFileSync(path.join(wt, 'late.txt'), 'late change\n', 'utf8');
    spawnSync('git', ['add', '-A'], { cwd: wt });
    spawnSync('git', ['commit', '-q', '-m', 'late'], { cwd: wt });
    expectDrift('code');
    // 恢复 HEAD 后：远端 requirement 分支被改写（本地 ref 模拟 remote ref 漂移）-> kind=code（reason=remote-ref-drift）
    spawnSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: wt });
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'forged remote'], { cwd: wt });
    const forgedSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: wt });
    const remoteRef = 'refs/remotes/origin/requirement/CR-D1';
    spawnSync('git', ['update-ref', remoteRef, forgedSha], { cwd: ws });
    const rRemote = runCrctl(['approve', 'CR-D1', '--stage', 'code', '--grant', gp, '--workspace', ws]);
    assert.equal(rRemote.status, 1, 'remote-ref-drift 应失败');
    assert.equal(rRemote.stderr.error.code, 'RELEASE_SUBJECT_DRIFT');
    assert.equal(rRemote.stderr.error.reason, 'remote-ref-drift');
    spawnSync('git', ['update-ref', '-d', remoteRef], { cwd: ws });
    // grant 未被消费、状态未动：恢复 worktree HEAD 后原 grant 仍可放行
    const r = runCrctl(['approve', 'CR-D1', '--stage', 'code', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.to, 'code-approved');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('TASK-06 ⑥: TTY approve code 路径同样重核并复制 release-subjects 签入（AC-2）', () => {
  const { ws } = makeCodeStageWorkspace();
  try {
    runCodeReviewAndAdvance(ws);
    const annotation = readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'review-annotations', 'code.yml'), 'utf8');
    const r = runCrctlInTty(['approve', 'CR-D1', '--stage', 'code', '--workspace', ws]);
    assert.equal(r.status, 0, 'RAWSTDERR: ' + JSON.stringify(r.rawStderr));
    assert.ok(r.rawStdout.includes('code-approved'), 'TTY approve 输出目标状态');
    const approval = readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'approval.yml'), 'utf8');
    const norm = (t) => t.replace(/\r\n/g, '\n');
    const annotationBlock = norm(annotation).slice(norm(annotation).indexOf('release-subjects:'));
    const wantBlock = annotationBlock.split('\n').filter((l) => l.length > 0).map((l) => `  ${l}`).join('\n');
    assert.ok(norm(approval).includes(wantBlock), 'TTY 路径 approval.yml#code.release-subjects 与 annotation 块字节语义一致');
    assert.match(approval, /evidence-digest: /);
    assert.match(approval, /via: crctl-approve/);
    // 紧邻目标态重放：非 TTY 调用仍被拒（人类在环无旁路），approval.yml 零写入
    const before = readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'approval.yml'), 'utf8');
    const r2 = runCrctl(['approve', 'CR-D1', '--stage', 'code', '--workspace', ws]);
    assert.equal(r2.status, 1, '非 TTY 重放应被拒');
    assert.equal(r2.stderr.error.code, 'APPROVAL_REQUIRES_HUMAN');
    assert.equal(readFileSync(path.join(ws, 'change-requests', 'CR-D1', 'approval.yml'), 'utf8'), before, '非 TTY 重放零写入');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-039 TASK-04 AC-5: KB 白名单后继提交 approve-code 仍可通过；非白名单路径 → post-review-path-drift 零写入', () => {
  const { ws, privateKey } = makeCodeStageWorkspace();
  try {
    runCodeReviewAndAdvance(ws);
    const wt = path.join(ws, '.rayai-worktrees', 'knowledge-base', 'requirement', 'CR-D1');
    const g = (args) => { const r = spawnSync('git', args, { cwd: wt, encoding: 'utf8', shell: false }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); };
    // 白名单后继：仅 cr.md + review-annotations/ 变化（crctl 自维护路径）→ 放行
    appendFileSync(path.join(wt, 'change-requests', 'CR-D1', 'cr.md'), '\n# checkpoint note\n');
    writeFileSync(path.join(wt, 'change-requests', 'CR-D1', 'review-annotations', 'note.yml'), 'note: post-review\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'kb whitelist successor']);
    let gp = makeCodeGrant(ws, privateKey);
    let r = runCrctl(['approve', 'CR-D1', '--stage', 'code', '--grant', gp, '--workspace', ws]);
    assert.equal(r.status, 0, `白名单后继应放行: ${r.rawStderr}`);
    assert.equal(r.stdout.to, 'code-approved');
  } finally { rmSync(ws, { recursive: true, force: true }); }
  // 非白名单路径 → post-review-path-drift 拒绝且零写入（独立 fixture）
  const { ws: ws2, privateKey: pk2 } = makeCodeStageWorkspace();
  try {
    runCodeReviewAndAdvance(ws2);
    const wt = path.join(ws2, '.rayai-worktrees', 'knowledge-base', 'requirement', 'CR-D1');
    const g = (args) => { const r = spawnSync('git', args, { cwd: wt, encoding: 'utf8', shell: false }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); };
    writeFileSync(path.join(wt, 'change-requests', 'CR-D1', 'notes.txt'), 'non-whitelisted\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'kb non-whitelist change']);
    const gp = makeCodeGrant(ws2, pk2);
    const r = runCrctl(['approve', 'CR-D1', '--stage', 'code', '--grant', gp, '--workspace', ws2]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'RELEASE_SUBJECT_DRIFT');
    assert.equal(r.stderr.error.reason, 'post-review-path-drift');
    assert.equal(existsSync(path.join(ws2, 'change-requests', 'CR-D1', 'approval.yml')), false, 'approval.yml 零写入');
  } finally { rmSync(ws2, { recursive: true, force: true }); }
});

test('TASK-06 ⑤: release-drift 单一回退转换 code-approved -> developing 合法；状态机口径 28 声明/50 展开（AC-3）', () => {
  const { ws } = makeDevStartWorkspace();
  try {
    writeDevStartApproval(ws);
    writeCrEntry(ws, 'CR-D1', 'code-approved');
    const r = runCrctl(['advance', 'CR-D1', '--to', 'developing', '--trigger', 'merge-feature-branch:release-drift -> implement-code', '--expect', 'code-approved', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.to, 'developing');
  } finally { rmSync(ws, { recursive: true, force: true }); }
  // 口径断言：唯一事实源 = tools 包 dir-graph.yaml（具名状态 15 不变）
  const dg = readFileSync(path.join(PACKAGE_ROOT, 'dir-graph.yaml'), 'utf8').replace(/\r\n/g, '\n');
  const declared = dg.match(/- \{ from: /g) || [];
  assert.equal(declared.length, 28, 'CR-2026-031 TASK-06 后声明转移 = 28');
  const anyActiveCount = (dg.match(/any-active:\n((?:        - .*\n)+)/) || ['', ''])[1].split('\n').filter((l) => l.trim()).length;
  const wildcardTriggers = (dg.match(/from: any-active/g) || []).length;
  assert.equal(declared.length - wildcardTriggers + anyActiveCount * wildcardTriggers, 50, 'wildcard 展开后 = 50');
});





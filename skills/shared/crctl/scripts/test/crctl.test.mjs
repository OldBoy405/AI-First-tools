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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CRCTL = path.resolve(import.meta.dirname, '..', 'crctl.mjs');

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

function runMigrateWithBacklogCasConflict(ws) {
  const backlog = path.join(ws, 'change-requests', '_backlog.yml');
  const prelude = `
import fs from 'node:fs';
const target = ${JSON.stringify(backlog)};
const read = fs.readFileSync.bind(fs);
const write = fs.writeFileSync.bind(fs);
let targetReads = 0;
fs.readFileSync = (file, ...args) => {
  if (path.resolve(String(file)) === path.resolve(target) && ++targetReads === 2) {
    write(target, read(target, 'utf8') + '# concurrent-writer\\n', 'utf8');
  }
  return read(file, ...args);
};`;
  return runCrctlWrapped(['migrate-backlog', '--no-commit', '--workspace', ws], `import path from 'node:path';\n${prelude}`);
}

/** 建一个一次性临时 workspace；返回目录路径，调用方负责在 test 结束时 rmSync。 */
function makeWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crctl-test-'));
  mkdirSync(path.join(dir, 'change-requests'), { recursive: true });
  return dir;
}

/**
 * 写 _backlog.yml fixture。默认含 owners 三角色（完整合规模板），
 * 通过 opts.owners=false 可关闭（如测试非法 owners 校验场景）。
 * 通过 opts.schema 可指定 schema 版本（如 'cr-backlog/v2'）。
 */
function writeBacklog(ws, entries, opts = {}) {
  const lines = [];
  if (opts.schema) lines.push(`schema: ${opts.schema}`);
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

// ── CR-2026-027 TASK-05：migrate-backlog 幽灵条目清理（FR-10/D-11）────
function writeBacklogWithGhost(ws, ghostTitle) {
  // v2 backlog + 正常条目 + 尾部幽灵块（B-12 实测形态：缺 id 行的 4 空格字段块）
  const text = [
    'schema: cr-backlog/v2',
    'change-requests:',
    '  - id: CR-2026-017',
    '    title: P3 组织智能 CR-E — 内部 Skill Market（E6）',
    '    created: "2026-08-04T06:55:00+08:00"',
    `    title: ${ghostTitle}`,
    '    summary: "幽灵条目残留（缺 id 行）"',
    '    created: "2026-08-08T16:44:35+08:00"',
  ].join('\n') + '\n';
  writeFileSync(path.join(ws, 'change-requests', '_backlog.yml'), text);
}

function writeHistoryWithArchived(ws, title) {
  const dir = path.join(ws, 'change-requests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '_history.yml'), `change-requests:\n  - id: CR-2026-024\n    title: ${title}\n    final-status: archived\n    archived-at: "2026-08-09T12:00:00+08:00"\n`);
}

function initGit(ws) {
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: ws, encoding: 'utf8', shell: false });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  g(['init', '-b', 'master']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 'tester']);
}

test('CR-2026-027 FR-10：migrate-backlog 幽灵块删除 —— 尾部缺 id 块被移除，正常条目字段恢复完整', () => {
  const ws = makeWorkspace();
  initGit(ws);
  try {
    const ghostTitle = 'Phase0 Tools 技能整合 — 端到端 Pipeline 最佳实践';
    writeBacklogWithGhost(ws, ghostTitle);
    writeHistoryWithArchived(ws, ghostTitle);
    const r = runCrctl(['migrate-backlog', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.ghost.removed, true);
    const text = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.ok(!text.includes(ghostTitle), '幽灵块必须消失');
    assert.ok(text.includes('CR-2026-017'), '正常条目保留');
    // CR-2026-017 的 title 恢复为自身（幽灵块删除后，唯一 title 行即 P3 标题）
    assert.ok(text.includes('title: P3 组织智能 CR-E — 内部 Skill Market（E6）'));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 FR-10：migrate-backlog 幂等 —— 再次运行 already-clean 且文件哈希不变', () => {
  const ws = makeWorkspace();
  initGit(ws);
  try {
    writeBacklogWithGhost(ws, 'Phase0 Tools 技能整合 — 端到端 Pipeline 最佳实践');
    writeHistoryWithArchived(ws, 'Phase0 Tools 技能整合 — 端到端 Pipeline 最佳实践');
    runCrctl(['migrate-backlog', '--workspace', ws]);
    const text = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const hash1 = sha16(text);
    const r2 = runCrctl(['migrate-backlog', '--workspace', ws]);
    assert.equal(r2.status, 0, r2.rawStderr);
    assert.equal(r2.stdout.ghost.removed, false);
    assert.equal(r2.stdout.ghost.reason, 'already-clean');
    const text2 = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.equal(sha16(text2), hash1, '幂等：文件哈希不得变化');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 FR-10：幽灵块无对应归档 -> GHOST_ENTRY_ORPHANED 硬失败且文件不变', () => {
  const ws = makeWorkspace();
  initGit(ws);
  try {
    writeBacklogWithGhost(ws, '幽灵孤儿条目');
    writeHistoryWithArchived(ws, '另一个不相关的归档标题');
    const r = runCrctl(['migrate-backlog', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'GHOST_ENTRY_ORPHANED');
    const text = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.ok(text.includes('幽灵孤儿条目'), '孤儿幽灵块不得被删除');
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

// AC-2a：v1 布局（backlog 有 status，cr.md 无）→ 回退读 + legacySource 标记
test('CR-2026-018 AC-2a：v1 布局回退读（backlog 有 status，cr.md 无）', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }]);
    // 不写 cr.md
    const r = runCrctl(['status', 'CR-TEST-1', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.status, 'drafting');
    assert.equal(r.stdout.legacySource, '_backlog.yml');
    assert.ok(r.stdout.warnings && r.stdout.warnings.some((w) => w.code === 'MIXED_LAYOUT_WARN'));
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

// AC-3a：validate v1 正常（backlog 有 status，cr.md 一致）→ 无告警
test('CR-2026-018 AC-3a：validate v1 布局一致，无告警', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-TEST-1', 'drafting');
    const r = runCrctl(['validate', 'change-requests/_backlog.yml', '--workspace', ws]);
    assert.equal(r.status, 0, JSON.stringify(r.stderr || r.stdout).slice(0, 300));
    assert.equal(r.stdout.valid, true);
    assert.ok(!r.stdout.warnings || r.stdout.warnings.length === 0);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// AC-3b：validate v1 漂移（backlog 与 cr.md 不一致）→ warning，退出码 0
test('CR-2026-018 AC-3b：validate v1 漂移告警（backlog 与 cr.md 不一致）', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }]);
    writeCrMd(ws, 'CR-TEST-1', 'developing');
    const r = runCrctl(['validate', 'change-requests/_backlog.yml', '--workspace', ws]);
    assert.equal(r.status, 0, JSON.stringify(r.stderr || r.stdout).slice(0, 300));
    assert.equal(r.stdout.valid, true);
    assert.ok(r.stdout.warnings && r.stdout.warnings.some((w) => w.includes('漂移')));
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

// AC-5a：migrate-backlog 成功（v1 → v2）
test('CR-2026-018 AC-5a：migrate-backlog 成功迁移 v1 → v2', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }, { id: 'CR-TEST-2', status: 'developing' }]);
    writeCrMd(ws, 'CR-TEST-1', 'drafting');
    writeCrMd(ws, 'CR-TEST-2', 'developing');
    // 注：两条目共享一个 backlog 文件，不能用 writeCrEntry（会互相覆盖 backlog）
    const r = runCrctl(['migrate-backlog', '--workspace', ws, '--no-commit']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.migrated, true);
    assert.equal(r.stdout.entries, 2);
    const after = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.match(after, /^schema: cr-backlog\/v2/m);
    assert.ok(!after.includes('status:'), '迁移后不应含 status 行');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// AC-5b：migrate-backlog 失败（backlog 与 cr.md 不一致）→ MIGRATE_STATUS_MISMATCH
test('CR-2026-018 AC-5b：migrate-backlog 不一致硬失败', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }]);
    writeCrMd(ws, 'CR-TEST-1', 'developing');
    const before = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    // 注：backlog 与 cr.md status 故意不一致，不能用 writeCrEntry
    const r = runCrctl(['migrate-backlog', '--workspace', ws, '--no-commit']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'MIGRATE_STATUS_MISMATCH');
    const after = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.equal(after, before, '失败时不应写入任何文件');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// AC-5c：migrate-backlog 幂等（v2 无 status 行 → already-migrated）
test('CR-2026-018 AC-5c：migrate-backlog 幂等（already-migrated）', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', title: 'test' }], { schema: 'cr-backlog/v2' });
    const r = runCrctl(['migrate-backlog', '--workspace', ws, '--no-commit']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.migrated, false);
    assert.equal(r.stdout.reason, 'already-migrated');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// CR_MD_WRITE_FAILED：advance 时 cr.md 缺失 → 硬失败
test('CR-2026-018：advance 时 cr.md 缺失 → CR_MD_WRITE_FAILED', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }]);
    // 不写 cr.md
    const r = runCrctl(['advance', 'CR-TEST-1', '--to', 'rejected', '--trigger', 'cr-review-record:reject', '--workspace', ws, '--no-commit']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'CR_MD_WRITE_FAILED');
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

// ── CR-2026-019：账本子命令（task done / merge-metadata / archive-move）+ AC-9 入库（FR-7） ──
// SDD §7.2 测试矩阵：AC-1/2/3/5/7 全覆盖；CAS_CONFLICT 分支黑盒无法注入读后改时序，
// 改为组件级验证 casWriteMulti 三阶段语义（AC-3 原子性），行为契约不变。

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

test('merge-metadata：无 merge-commits 键时创建并追加 {repo,trunk,sha}（AC-2）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'merging');
    const r = runCrctl(['merge-metadata', 'CR-T1', '--repo', 'ai-first-platform-docs', '--trunk', 'master', '--sha', 'abc123def456', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.op, 'merge-metadata');
    assert.equal(r.stdout.result, 'appended');
    const backlog = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.match(backlog, /merge-commits:/);
    assert.match(backlog, /- repo: ai-first-platform-docs/);
    assert.match(backlog, /trunk: master/);
    assert.match(backlog, /sha: abc123def456/);
    const audit = readFileSync(path.join(ws, '.crctl', 'audit.log'), 'utf8');
    assert.match(audit, /"op":"merge-metadata"/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('merge-metadata：已有键时追加 + 同 sha 幂等去重（AC-2）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'merging');
    const backlogPath = path.join(ws, 'change-requests', '_backlog.yml');
    let backlog = readFileSync(backlogPath, 'utf8');
    const NL = String.fromCharCode(10);
    writeFileSync(backlogPath, backlog.replace(new RegExp(NL + '$'), NL + '    merge-commits:' + NL + '      - repo: multica' + NL + '        trunk: main' + NL + '        sha: 111111111111' + NL));
    const r1 = runCrctl(['merge-metadata', 'CR-T1', '--repo', 'ai-first-platform-docs', '--trunk', 'master', '--sha', '222222222222', '--workspace', ws]);
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout.result, 'appended');
    backlog = readFileSync(backlogPath, 'utf8');
    assert.equal((backlog.match(/sha: 222222222222/g) || []).length, 1);
    // 同 sha 重复 → dup-idempotent，不新增
    const r2 = runCrctl(['merge-metadata', 'CR-T1', '--repo', 'ai-first-platform-docs', '--trunk', 'master', '--sha', '222222222222', '--workspace', ws]);
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout.result, 'dup-idempotent');
    backlog = readFileSync(backlogPath, 'utf8');
    assert.equal((backlog.match(/sha: 222222222222/g) || []).length, 1);
    assert.equal((backlog.match(/sha: /g) || []).length, 2);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('merge-metadata：非 merging/writing-back 态非零退出且无写（AC-5）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    const before = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const r = runCrctl(['merge-metadata', 'CR-T1', '--repo', 'r', '--trunk', 't', '--sha', 'abc123', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'ILLEGAL_LEDGER_STATE');
    assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), before);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('archive-move：正常路径 backlog 移除 + history 富化 + index 终态更新（AC-3/CR-2026-027 FR-11）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'archived');
    writeIndex(ws, [{ id: 'CR-T1', title: 'T1', status: 'drafting', created: '2026-08-01T00:00:00+08:00' }]);
    const r = runCrctl(['archive-move', 'CR-T1', '--final-status', 'archived', '--archive-reason', 'writeback done', '--spec-id', 'ai-first-platform', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.op, 'archive-move');
    assert.deepEqual(r.stdout.recipients, ['Ray']);
    const backlog = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.ok(!backlog.includes('CR-T1'), 'backlog 不应再包含 CR-T1 条目');
    const history = readFileSync(path.join(ws, 'change-requests', '_history.yml'), 'utf8');
    assert.match(history, /history:/);
    assert.match(history, /- id: CR-T1/);
    assert.match(history, /final-status: archived/);
    assert.match(history, /archive-reason: "writeback done"/);
    assert.match(history, /writeback-spec-id: ai-first-platform/);
    assert.match(history, /archived-at: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(history, /owners:/);
    // CR-2026-027 FR-11：archive event 入 history notify-log（同批写入）
    assert.match(history, /notify-log:/);
    assert.match(history, /event: archived/);
    assert.match(history, /to: \["Ray"\]/);
    assert.match(history, /writeback-spec-id: ai-first-platform/);
    // _index.yml 终态三字段（D-2）
    const index = readFileSync(path.join(ws, 'change-requests', '_index.yml'), 'utf8');
    assert.match(index, /status: archived/);
    assert.match(index, /archived-at: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(index, /writeback-spec-id: ai-first-platform/);
    assert.ok(index.includes('CR-T1'), 'index 条目保留（不删除）');
    // archive outbox 已发
    const outbox = path.join(ws, '.crctl', 'outbox');
    const evFiles = readdirSync(outbox).filter((f) => f.includes('archive'));
    assert.ok(evFiles.length > 0, 'CAS 成功后应发 archive outbox');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('archive-move：重复调用（已移出 backlog、history final-status 一致）→ already-archived 幂等零写入（TD-BL-3 + b2 双存冲突）', () => {
  const ws = makeWorkspace();
  try {
    // CR-T1 已归档：只在 history、不在 backlog（b2：幂等前提是 CR 已移出 backlog）；backlog 保留另一在途 CR
    writeBacklog(ws, [{ id: 'CR-OTHER', status: 'drafting' }]);
    const backlogPath = path.join(ws, 'change-requests', '_backlog.yml');
    const historyPath = path.join(ws, 'change-requests', '_history.yml');
    writeFileSync(historyPath, 'history:\n  - id: CR-T1\n    final-status: archived\n');
    const backlogBefore = readFileSync(backlogPath, 'utf8');
    const historyBefore = readFileSync(historyPath, 'utf8');
    const r = runCrctl(['archive-move', 'CR-T1', '--final-status', 'archived', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.equal(r.stdout.result, 'already-archived');
    assert.equal(r.stdout.finalStatus, 'archived');
    assert.equal(readFileSync(backlogPath, 'utf8'), backlogBefore, 'backlog 不得被写');
    assert.equal(readFileSync(historyPath, 'utf8'), historyBefore, 'history 不得被写');
    // 不一致 → FINAL_STATUS_MISMATCH
    const r2 = runCrctl(['archive-move', 'CR-T1', '--final-status', 'rejected', '--workspace', ws]);
    assert.equal(r2.status, 1);
    assert.equal(r2.stderr.error.code, 'FINAL_STATUS_MISMATCH');
    // b2：backlog/history 双存 → CR_LOCATION_CONFLICT（数据冲突，非幂等）
    writeBacklog(ws, [{ id: 'CR-OTHER', status: 'drafting' }, { id: 'CR-T1', status: 'archived' }]);
    const r3 = runCrctl(['archive-move', 'CR-T1', '--final-status', 'archived', '--workspace', ws]);
    assert.equal(r3.status, 1);
    assert.equal(r3.stderr.error.code, 'CR_LOCATION_CONFLICT');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-027 TASK-06：三终态 / 中文 reason / 收件人矩阵 ────────────
test('CR-2026-027 FR-11：rejected/withdrawn 终态归档 + 中文 archive-reason 完整保留（不经 Shell 转义）', () => {
  const ws = makeWorkspace();
  try {
    for (const finalStatus of ['rejected', 'withdrawn']) {
      const cr = `CR-T-${finalStatus}`;
      writeCrEntry(ws, cr, finalStatus);
      writeIndex(ws, [{ id: cr, title: finalStatus, status: finalStatus === 'rejected' ? 'requirement-reviewing' : 'tech-designing', created: '2026-08-01T00:00:00+08:00' }]);
      const r = runCrctl(['archive-move', cr, '--final-status', finalStatus, '--archive-reason', '中文原因：需求撤回', '--workspace', ws]);
      assert.equal(r.status, 0, r.rawStderr);
      const history = readFileSync(path.join(ws, 'change-requests', '_history.yml'), 'utf8');
      assert.match(history, new RegExp(`final-status: ${finalStatus}`));
      assert.match(history, /archive-reason: "中文原因：需求撤回"/);
      assert.match(history, /event: /);
      const index = readFileSync(path.join(ws, 'change-requests', '_index.yml'), 'utf8');
      assert.match(index, new RegExp(`status: ${finalStatus}`));
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-027 FR-11：收件人矩阵 —— owners 去重；legacy 顶层 owner 回退；空收件人 ARCHIVE_RECIPIENTS_MISSING', () => {
  const ws = makeWorkspace();
  try {
    // 三角色同人 → 去重为 1
    writeCrEntry(ws, 'CR-DEDUP', 'archived');
    writeIndex(ws, [{ id: 'CR-DEDUP', title: 'D', status: 'archived', created: '2026-08-01T00:00:00+08:00' }]);
    let r = runCrctl(['archive-move', 'CR-DEDUP', '--final-status', 'archived', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.deepEqual(r.stdout.recipients, ['Ray']);
    // legacy：无 owners 但有顶层 owner → 回退（writeBacklog 不支持 owner 字段，手动注入）
    const crLegacy = 'CR-LEGACY';
    writeBacklog(ws, [{ id: crLegacy, status: 'withdrawn' }], { owners: false });
    const bpLegacy = path.join(ws, 'change-requests', '_backlog.yml');
    writeFileSync(bpLegacy, readFileSync(bpLegacy, 'utf8').replace('    status: withdrawn', '    status: withdrawn\n    owner: legacy-user'));
    writeCrMd(ws, crLegacy, 'withdrawn', { owners: false });
    writeIndex(ws, [{ id: crLegacy, title: 'L', status: 'withdrawn', created: '2026-08-01T00:00:00+08:00' }]);
    r = runCrctl(['archive-move', crLegacy, '--final-status', 'withdrawn', '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    assert.deepEqual(r.stdout.recipients, ['legacy-user']);
    // 无 owners 且无顶层 owner → ARCHIVE_RECIPIENTS_MISSING（CAS 前硬失败，零写入）
    const crOrphan = 'CR-ORPHAN';
    writeBacklog(ws, [{ id: crOrphan, status: 'rejected' }], { owners: false });
    writeCrMd(ws, crOrphan, 'rejected', { owners: false });
    writeIndex(ws, [{ id: crOrphan, title: 'O', status: 'rejected', created: '2026-08-01T00:00:00+08:00' }]);
    r = runCrctl(['archive-move', crOrphan, '--final-status', 'rejected', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'ARCHIVE_RECIPIENTS_MISSING');
    assert.ok(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8').includes(crOrphan), 'backlog 不得被写');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('archive-move：非 archived 态非零退出且无写（AC-5）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'writing-back');
    const before = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const r = runCrctl(['archive-move', 'CR-T1', '--final-status', 'archived', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'ILLEGAL_LEDGER_STATE');
    assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), before);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('casWriteMulti：任一侧 CAS 失配则全部不落盘，无 write/rename（组件级三阶段语义，SDD §4.3）', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crctl-casw-'));
  try {
    const src = readFileSync(CRCTL, 'utf8').replaceAll('\r\n', '\n');
    const m = src.match(/function casWriteMulti\(writes\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'crctl.mjs 中应能提取 casWriteMulti 源码');
    // 源码函数提取后注入依赖，写入临时模块再 import（不 import crctl.mjs 本身，保持黑盒）
    const moduleText = [
      "const calls = [];",
      "const fail = (code, msg) => { throw new Error(code + ': ' + msg); };",
      "const readFileChecked = (p) => { calls.push(['read', p]); return p.endsWith('ok.txt') ? 'orig-a' : 'tampered-b'; };",
      "const sha256 = (t) => t;",
      "const fs = {",
      "  writeFileSync: (p) => calls.push(['write', p]),",
      "  renameSync: (t, d) => calls.push(['rename', t, d]),",
      "};",
      m[0],
      'export { casWriteMulti, calls };',
    ].join('\n');
    const modPath = path.join(dir, 'casw.mjs');
    writeFileSync(modPath, moduleText);
    const { casWriteMulti, calls } = await import(pathToFileURL(modPath).href);
    const p1 = path.join(dir, 'ok.txt');
    const p2 = path.join(dir, 'bad.txt');
    assert.throws(() => casWriteMulti([
      { path: p1, expectedHash: 'orig-a', newText: 'x' },
      { path: p2, expectedHash: 'orig-b', newText: 'y' },
    ]), /CAS_CONFLICT/);
    assert.ok(!calls.some((c) => c[0] === 'write' || c[0] === 'rename'), '阶段一失败后不得有任何 write/rename');
    calls.length = 0;
    casWriteMulti([
      { path: p1, expectedHash: 'orig-a', newText: 'x' },
      { path: p2, expectedHash: 'tampered-b', newText: 'y' },
    ]);
    assert.equal(calls.filter((c) => c[0] === 'write').length, 2, '全部校验通过后应写 2 个 temp');
    assert.equal(calls.filter((c) => c[0] === 'rename').length, 2, '应连续 rename 2 个文件');
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('FR-5：merge-metadata 非法前置态错误信息含「请先 crctl advance」修复指引', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    const r = runCrctl(['merge-metadata', 'CR-T1', '--repo', 'r', '--trunk', 't', '--sha', 'abc123', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'ILLEGAL_LEDGER_STATE');
    assert.match(r.stderr.error.message, /请先 crctl advance/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('FR-8：merge-metadata 追加条目自动补 branch: requirement/{cr}，必填集 {repo,trunk,sha} 不变', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'merging');
    const r = runCrctl(['merge-metadata', 'CR-T1', '--repo', 'tools', '--trunk', 'custom/main', '--sha', 'deadbeef01', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.branch, 'requirement/CR-T1');
    const backlog = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.match(backlog, /- repo: tools/);
    assert.match(backlog, /trunk: custom\/main/);
    assert.match(backlog, /sha: deadbeef01/);
    assert.match(backlog, /branch: requirement\/CR-T1/);
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
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    writeReviewPayload(ws, 'CR-T1', 'code', 'verdict: block\nblockers:\n  - "bug A"\ndimensions:\n  a: b\n');
    const r = runCrctl(['review-record', 'CR-T1', '--stage', 'code', '--bump-attempt', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.attempt.current, 1, 'attempt 级联为 1');
    const loop = readFileSync(path.join(ws, 'change-requests', 'CR-T1', 'review-loop.yml'), 'utf8');
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

// ── CR-2026-021 TASK-04：checkpoint-add / owner-set / backlog-set（S3/S4/S5）──

test('checkpoint-add：追加 checkpoints[] + remote-ref/last-push 元数据（AC-3）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'developing');
    const r = runCrctl(['checkpoint-add', 'CR-T1', '--repo', 'ai-first-platform-docs', '--sha', 'abc123', '--remote-ref', 'refs/heads/master', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.op, 'checkpoint-add');
    const out = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.ok(out.includes('checkpoints:'), 'checkpoints 段创建');
    assert.ok(out.includes('- repo: ai-first-platform-docs'), 'checkpoint 条目');
    assert.ok(out.includes('sha: abc123'), 'sha 写入');
    assert.ok(out.includes('remote-ref: "refs/heads/master"'), 'remote-ref 写入');
    assert.ok(out.includes('last-push-at:') && out.includes('last-push-by:'), '推送元数据由 crctl 生成');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('checkpoint-add：终态拒绝零写；非终态（含 drafting）可用（FR-11，CR-2026-022）', () => {
  const ws = makeWorkspace();
  try {
    // 终态（archived）拒绝，零写
    writeCrEntry(ws, 'CR-T1', 'archived');
    const before = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const r1 = runCrctl(['checkpoint-add', 'CR-T1', '--repo', 'r', '--sha', 's', '--workspace', ws]);
    assert.equal(r1.status, 1);
    assert.equal(r1.stderr.error.code, 'ILLEGAL_LEDGER_STATE');
    assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), before);
    // 非终态 drafting 可用（push-progress 在需求期也会调用，旧窄列表会炸 ILLEGAL_LEDGER_STATE）
    writeCrEntry(ws, 'CR-T2', 'drafting');
    const r2 = runCrctl(['checkpoint-add', 'CR-T2', '--repo', 'r', '--sha', 's2', '--workspace', ws]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8').includes('sha: s2'), 'drafting 态 checkpoint 落账');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('owner-set：更新 owners.{role}.id + assigned-at（AC-3）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    const r = runCrctl(['owner-set', 'CR-T1', '--role', 'development', '--id', 'Alice', '--workspace', ws]);
    assert.equal(r.status, 0);
    const out = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.ok(out.includes('id: Alice'), '新负责人写入');
    assert.ok(out.match(/assigned-at: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00"/), 'assigned-at 由 crctl 生成');
    assert.ok(out.includes('id: Ray'), '其他角色 owner 不受影响');
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

// ── CR-2026-021 TASK-06：cr-init（原子权威分配）──

test('cr-init：权威原子分配 — 三文件建档登记，返回分配到的 cr-id（AC-4）', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-2026-001', status: 'drafting' }]);
    writeCrMd(ws, 'CR-2026-001', 'drafting');
    writeFileSync(path.join(ws, 'change-requests', '_index.yml'), 'change-requests:\n  - id: CR-2026-001\n    title: x\n    status: drafting\n    created: "2026-08-01T00:00:00+08:00"\n');
    const r = runCrctl(['cr-init', '--title', '测试 CR', '--owner-requirement', 'Ray', '--year', '2026', '--workspace', ws]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.cr, 'CR-2026-002');
    const crMd = readFileSync(path.join(ws, 'change-requests', 'CR-2026-002', 'cr.md'), 'utf8');
    assert.ok(crMd.includes('id: CR-2026-002') && crMd.includes('status: drafting'), 'cr.md 建档');
    assert.ok(crMd.includes('title: 测试 CR'), 'title 写入 cr.md');
    assert.ok(crMd.includes('owner-history:') && crMd.includes('initial-assignment'), 'owner-history 生成');
    const backlog = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.ok(backlog.includes('- id: CR-2026-002'), 'backlog 追加');
    const index = readFileSync(path.join(ws, 'change-requests', '_index.yml'), 'utf8');
    assert.ok(index.includes('- id: CR-2026-002') && index.includes('status: drafting'), 'index 登记');
    // 无显式 cr-id 入参：传入位置参数应被忽略或报错（签名核对）
    const r2 = runCrctl(['cr-init', 'CR-X', '--title', 't', '--owner-requirement', 'R', '--year', '2026', '--workspace', ws]);
    assert.equal(r2.status, 0, 'cr-init 无 <cr-id> 位置参数（多余位置参数不影响）');
    assert.equal(r2.stdout.cr, 'CR-2026-003', '仍按内部 max+1 分配');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('cr-init：并发冲突 → 组件级 mismatch hash 注入，三文件均不落盘（SDD §5 范式）', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crctl-crinit-'));
  try {
    // 复用既有 casWriteMulti 组件级测试范式：从 crctl.mjs 提取 casWriteMulti 源码并注入 stub
    const src = readFileSync(CRCTL, 'utf8').replaceAll('\r\n', '\n');
    const m = src.match(/function casWriteMulti\(writes\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'crctl.mjs 中应能提取 casWriteMulti 源码');
    const calls = [];
    const fail = (code, msg) => { throw new Error(code + ': ' + msg); };
    const readFileChecked = (p) => { calls.push(['read', p]); return p.endsWith('ok.txt') ? 'orig-a' : 'tampered-b'; };
    const sha256 = (t) => t;
    const fs = {
      writeFileSync: (p) => calls.push(['write', p]),
      renameSync: (t, d) => calls.push(['rename', t, d]),
    };
    const moduleText = [
      'const calls = [];',
      "const fail = (code, msg) => { throw new Error(code + ': ' + msg); };",
      "const readFileChecked = (p) => { calls.push(['read', p]); return p.endsWith('ok.txt') ? 'orig-a' : 'tampered-b'; };",
      'const sha256 = (t) => t;',
      'const fs = {',
      "  writeFileSync: (p) => calls.push(['write', p]),",
      "  renameSync: (t, d) => calls.push(['rename', t, d]),",
      '};',
      m[0],
      'export { casWriteMulti, calls };',
    ].join('\n');
    const modPath = path.join(dir, 'casw.mjs');
    writeFileSync(modPath, moduleText);
    const { casWriteMulti, calls: c2 } = await import(pathToFileURL(modPath).href);
    // 三文件写：cr.md expectedHash=null + backlog/index 读时 hash；任一失配 → 整体 CAS_CONFLICT 无 write/rename
    const ok1 = path.join(dir, 'ok.txt'); // cr.md 对应（expectedHash null 且文件存在 → 冲突）
    assert.throws(() => casWriteMulti([
      { path: ok1, expectedHash: null, newText: 'x' },
      { path: path.join(dir, 'b.txt'), expectedHash: 'orig-b', newText: 'y' },
      { path: path.join(dir, 'i.txt'), expectedHash: 'orig-i', newText: 'z' },
    ]), /CAS_CONFLICT/);
    assert.ok(!c2.some((c) => c[0] === 'write' || c[0] === 'rename'), 'cr.md 已存在（创建冲突）时不得落任何盘');
    c2.length = 0;
    // 正常路径：全部 expectedHash 匹配 → 2 次 write + 2 次 rename（null 期望的 ok.txt 读后确认存在则冲突，这里换缺失文件）
    assert.throws(() => casWriteMulti([
      { path: path.join(dir, 'missing.txt'), expectedHash: null, newText: 'x' },
      { path: path.join(dir, 'ok.txt'), expectedHash: 'orig-a', newText: 'y' },
      { path: path.join(dir, 'bad.txt'), expectedHash: 'tampered-b', newText: 'z' },
    ]), /CAS_CONFLICT/);
    assert.ok(!c2.some((c) => c[0] === 'write' || c[0] === 'rename'), '任一侧 hash 失配不得落盘');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cr-init：缺 --title / --owner-requirement → BAD_ARGS', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-2026-001', status: 'drafting' }]);
    writeCrMd(ws, 'CR-2026-001', 'drafting');
    const r1 = runCrctl(['cr-init', '--owner-requirement', 'Ray', '--year', '2026', '--workspace', ws]);
    assert.equal(r1.status, 1);
    assert.equal(r1.stderr.error.code, 'BAD_ARGS');
    const r2 = runCrctl(['cr-init', '--title', 't', '--year', '2026', '--workspace', ws]);
    assert.equal(r2.status, 1);
    assert.equal(r2.stderr.error.code, 'BAD_ARGS');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-022 TASK-03：cr-init 注册元信息旗标（FR-9）──

test('cr-init：--summary/--source/--target-version 一次写齐，缺省值与旧硬编码同义（AC-4）', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-2026-001', status: 'drafting' }]);
    writeCrMd(ws, 'CR-2026-001', 'drafting');
    writeFileSync(path.join(ws, 'change-requests', '_index.yml'), 'change-requests:\n  - id: CR-2026-001\n    title: x\n    status: drafting\n    created: "2026-08-01T00:00:00+08:00"\n');
    // 带旗标：三字段一次原子写齐（cr.md + _backlog）
    const r = runCrctl(['cr-init', '--title', 'T', '--owner-requirement', 'Ray', '--year', '2026', '--summary', 'S: 含冒号', '--source', 'docs/analysis/x.md', '--target-version', '0.99', '--workspace', ws]);
    assert.equal(r.status, 0, r.stderr);
    const crMd = readFileSync(path.join(ws, 'change-requests', 'CR-2026-002', 'cr.md'), 'utf8');
    assert.ok(crMd.includes('summary: "S: 含冒号"'), 'summary 引号包裹写入 cr.md（含冒号不破坏 YAML）');
    assert.ok(crMd.includes('source: docs/analysis/x.md'), 'source 写入 cr.md');
    assert.ok(crMd.includes('target-version: 0.99'), 'target-version 写入 cr.md');
    const backlog = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    assert.ok(backlog.includes('summary: "S: 含冒号"') && backlog.includes('source: docs/analysis/x.md') && backlog.includes('target-version: 0.99'), '_backlog 三字段同步');
    // 不带旗标：缺省值与旧硬编码同义（向后兼容）
    const r2 = runCrctl(['cr-init', '--title', 'T2', '--owner-requirement', 'Ray', '--year', '2026', '--workspace', ws]);
    assert.equal(r2.status, 0, r2.stderr);
    const crMd2 = readFileSync(path.join(ws, 'change-requests', 'CR-2026-003', 'cr.md'), 'utf8');
    assert.ok(crMd2.includes('summary: ""'), '缺省 summary 为空串');
    assert.ok(crMd2.includes('source: manual'), '缺省 source=manual');
    assert.ok(crMd2.includes('target-version: tbd'), '缺省 target-version=tbd');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-021 TASK-07：task allocate（S7，TASK-ID CAS 分配）──

test('task allocate：顺序分配 TASK-ID + slug 兜底命名（AC-5）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    const dir = path.join(ws, 'change-requests', 'CR-T1', 'tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '_index.yml'), 'cr-id: CR-T1\ntasks:\n  - id: CR-T1-TASK-01\n    title: x\n    status: pending\n    estimate: 1h\n    depends-on: []\n');
    const r1 = runCrctl(['task', 'allocate', 'CR-T1', '--workspace', ws]);
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout.task, 'CR-T1-TASK-02');
    assert.equal(r1.stdout.slug, 'task-02', 'slug 缺失回退 task-{NN}');
    const r2 = runCrctl(['task', 'allocate', 'CR-T1', '--slug', 'fix-bug', '--workspace', ws]);
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout.task, 'CR-T1-TASK-03');
    assert.equal(r2.stdout.slug, 'fix-bug');
    const out = readFileSync(path.join(dir, '_index.yml'), 'utf8');
    assert.ok(out.includes('- id: CR-T1-TASK-02') && out.includes('- id: CR-T1-TASK-03'), '两条新任务登记');
    assert.ok(out.includes('slug: task-02') && out.includes('slug: fix-bug'), 'slug 写入');
    assert.ok(out.includes('status: pending'), '最小条目 status: pending');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('task allocate：非法前置态（drafting）→ ILLEGAL_LEDGER_STATE 零写', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    const dir = path.join(ws, 'change-requests', 'CR-T1', 'tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '_index.yml'), 'cr-id: CR-T1\ntasks: []\n');
    const before = readFileSync(path.join(dir, '_index.yml'), 'utf8');
    const r = runCrctl(['task', 'allocate', 'CR-T1', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'ILLEGAL_LEDGER_STATE');
    assert.equal(readFileSync(path.join(dir, '_index.yml'), 'utf8'), before);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('task allocate：tasks/_index.yml 缺失 → TASK_INDEX_NOT_FOUND', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
    const r = runCrctl(['task', 'allocate', 'CR-T1', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'TASK_INDEX_NOT_FOUND');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-021 TASK-08：worktree-path + report/cr-metrics（S9/S11 只读）──

test('worktree-path：确定性路径输出且不写任何文件（AC-6）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    const before = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const r1 = runCrctl(['worktree-path', 'CR-T1', '--repo', 'ai-first-platform-docs', '--workspace', ws]);
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout.bucket, 'knowledge-base', 'knowledge-base role → knowledge-base bucket');
    assert.ok(r1.stdout.path.replaceAll('\\', '/').endsWith('.rayai-worktrees/knowledge-base/requirement/CR-T1'), '路径模板拼接');
    const r2 = runCrctl(['worktree-path', 'CR-T1', '--repo', 'multica', '--workspace', ws]);
    assert.equal(r2.stdout.bucket, 'multica', '非 knowledge-base role → repo.id bucket');
    assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), before, '不得写任何文件');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('worktree-path：linked worktree 内调用以主 checkout 为根、无嵌套 .rayai-worktrees（CR-2026-028 FR-2）', () => {
  const ws = makeWorkspace();
  const wt = path.join(ws, 'linked-worktree');
  try {
    // 初始化 git 主仓并提交，使 linked worktree 的 common-dir 指向主 checkout 的 .git
    spawnSync('git', ['init', '-b', 'main'], { cwd: ws, encoding: 'utf8', shell: false });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws, encoding: 'utf8', shell: false });
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: ws, encoding: 'utf8', shell: false });
    writeCrEntry(ws, 'CR-T1', 'drafting');
    spawnSync('git', ['add', '.'], { cwd: ws, encoding: 'utf8', shell: false });
    const ci = spawnSync('git', ['commit', '-m', 'init'], { cwd: ws, encoding: 'utf8', shell: false });
    assert.equal(ci.status, 0, '主仓初始提交成功');

    const wa = spawnSync('git', ['worktree', 'add', '-b', 'requirement/CR-T1', wt], { cwd: ws, encoding: 'utf8', shell: false });
    assert.equal(wa.status, 0, `linked worktree 创建成功: ${wa.stderr}`);

    // 从 linked worktree 内调用：根基准必须是主 checkout（ws），不得拼出 <wt>/.rayai-worktrees/...
    const r = runCrctl(['worktree-path', 'CR-T1', '--repo', 'ai-first-platform-docs', '--workspace', wt]);
    assert.equal(r.status, 0, `linked worktree 调用成功: ${r.rawStderr}`);
    const p = r.stdout.path.replaceAll('\\', '/');
    assert.ok(p.startsWith(ws.replaceAll('\\', '/') + '/.rayai-worktrees/'), `以主 checkout 为根: ${p}`);
    assert.ok(!p.includes('/.rayai-worktrees/.rayai-worktrees/'), `无嵌套 .rayai-worktrees: ${p}`);
    assert.ok(p.endsWith('.rayai-worktrees/knowledge-base/requirement/CR-T1'), `路径模板不变: ${p}`);

    // 主 checkout 调用行为不变
    const r2 = runCrctl(['worktree-path', 'CR-T1', '--repo', 'multica', '--workspace', ws]);
    assert.ok(r2.stdout.path.replaceAll('\\', '/').endsWith('.rayai-worktrees/multica/requirement/CR-T1'));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('report/cr-metrics：状态直方图 + 周期活动计数（AC-6）', () => {
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
    const r2 = runCrctl(['cr-metrics', '--period', '30d', '--workspace', ws]);
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout.total, 3);
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

// ── CR-2026-021 TASK-09：git commit --template（S10）──

function initGitWs(ws, branch) {
  const git = (args) => {
    const r = spawnSync('git', ['-C', ws, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`);
    return (r.stdout || '').trim();
  };
  git(['init', '-b', branch]);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'tester']);
  return git;
}

test('git commit --template register：生成规范 message（AC-8 对应）', () => {
  const ws = makeWorkspace();
  try {
    const git = initGitWs(ws, 'requirement/CR-T1');
    writeFileSync(path.join(ws, 'a.txt'), 'x');
    git(['add', 'a.txt']);
    const r = runCrctl(['git', 'commit', '--template', 'register', '-m', '新需求', '--cwd', ws, '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    const msg = git(['log', '--oneline', '-1']);
    assert.ok(msg.includes('[cr] register CR-T1: 新需求'), `message=${msg}`); // git log --oneline 带 SHA 前缀
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('git commit --template：未知 kind → BAD_ARGS；无法确定 cr → BAD_ARGS', () => {
  const ws = makeWorkspace();
  try {
    const git = initGitWs(ws, 'master');
    writeFileSync(path.join(ws, 'a.txt'), 'x');
    git(['add', 'a.txt']);
    const r1 = runCrctl(['git', 'commit', '--template', 'bogus', '-m', 'x', '--cwd', ws, '--workspace', ws]);
    assert.equal(r1.status, 1);
    assert.equal(r1.stderr.error.code, 'BAD_ARGS');
    const r2 = runCrctl(['git', 'commit', '--template', 'register', '-m', '无CR编号', '--cwd', ws, '--workspace', ws]);
    assert.equal(r2.status, 1);
    assert.equal(r2.stderr.error.code, 'BAD_ARGS');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── CR-2026-022 TASK-04：git commit --template --cr 显式旗标 + 模板形态白名单对齐（FR-10）──

test('git commit --template --cr：master 分支直传已知 CR 号，跳过反向解析（AC-4）', () => {
  const ws = makeWorkspace();
  try {
    const git = initGitWs(ws, 'master');
    mkdirSync(path.join(ws, 'change-requests', 'CR-2026-009'), { recursive: true });
    writeFileSync(path.join(ws, 'a.txt'), 'x');
    git(['add', 'a.txt']);
    const r = runCrctl(['git', 'commit', '--template', 'register', '--cr', 'CR-2026-009', '-m', 'subject', '--cwd', ws, '--workspace', ws]);
    assert.equal(r.status, 0, r.rawStderr);
    const msg = git(['log', '--oneline', '-1']);
    assert.ok(msg.includes('[cr] register CR-2026-009: subject'), 'message=' + msg);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('git commit --template --cr：非法格式与不存在的 CR → BAD_ARGS', () => {
  const ws = makeWorkspace();
  try {
    const git = initGitWs(ws, 'master');
    writeFileSync(path.join(ws, 'a.txt'), 'x');
    git(['add', 'a.txt']);
    const r1 = runCrctl(['git', 'commit', '--template', 'register', '--cr', 'abc', '-m', 'x', '--cwd', ws, '--workspace', ws]);
    assert.equal(r1.status, 1);
    assert.equal(r1.stderr.error.code, 'BAD_ARGS');
    const r2 = runCrctl(['git', 'commit', '--template', 'register', '--cr', 'CR-2026-999', '-m', 'x', '--cwd', ws, '--workspace', ws]);
    assert.equal(r2.status, 1);
    assert.equal(r2.stderr.error.code, 'BAD_ARGS');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('git commit --template task-breakdown/writeback：生成形态命中 commit 白名单（现场坐实修复）', () => {
  const ws = makeWorkspace();
  try {
    const git = initGitWs(ws, 'requirement/CR-T1');
    writeFileSync(path.join(ws, 'a.txt'), 'x');
    git(['add', 'a.txt']);
    const r1 = runCrctl(['git', 'commit', '--template', 'task-breakdown', '-m', '5 tasks', '--cwd', ws, '--workspace', ws]);
    assert.equal(r1.status, 0, r1.rawStderr);
    assert.ok(git(['log', '--oneline', '-1']).includes('[cr] task-breakdown CR-T1: 5 tasks'));
    writeFileSync(path.join(ws, 'b.txt'), 'y');
    git(['add', 'b.txt']);
    const r2 = runCrctl(['git', 'commit', '--template', 'writeback', '-m', '回写', '--cwd', ws, '--workspace', ws]);
    assert.equal(r2.status, 0, r2.rawStderr);
    assert.ok(git(['log', '--oneline', '-1']).includes('[cr] writeback CR-T1: 回写'));
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
      '  - id: CR-G1-TASK-01', '    status: pending',   // 缺失字段是 task allocate 的正常形态（B-8）
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
  writeCrEntry(ws, cr, status);
  writeFileSync(path.join(ws, 'dir-graph.yaml'), [
    'change-request-track:',
    '  state_machine:',
    '    field: "status"',
    '    transitions:',
    '      - { from: drafting, to: requirement-reviewing, trigger: "review-requirement" }',
    '      - { from: requirement-reviewing, to: requirement-approved, trigger: "approve-requirement" }',
  ].join('\n') + '\n');
  mkdirSync(path.join(ws, 'tools', 'pipeline-templates'), { recursive: true });
  writeFileSync(path.join(ws, 'tools', 'pipeline-templates', 'requirement-authoring.pipeline.json'), JSON.stringify({
    id: 'requirement-authoring',
    nodes: [{ ref: 'review-requirement', reviewLoop: { maxAttempts: 3, passCondition: { allOf: [
      { path: 'verdict', equals: 'pass' }, { path: 'blockers', isEmpty: true } ] } } }],
  }));
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
// casWriteMulti 三阶段原子语义已有组件级向量兜底，此处以 TRACE_SHAPE 结构错误覆盖"三文件均不落盘 + payload 保留"。

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
  const ws2 = makeWorkspace();
  try {
    writeCrEntry(ws2, 'CR-R2', 'developing');
    writeReviewPayload(ws2, 'CR-R2', 'code', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r2 = runCrctl(['review-record', 'CR-R2', '--stage', 'code', '--workspace', ws2]);
    assert.equal(r2.status, 0);
    const tr2 = readTrace(ws2, 'CR-R2');
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

test('CR-2026-025 投影④：cr-id 不匹配 → TRACE_SHAPE，受控文件 sha256 均不变且 payload 保留（AC-20/AC-21 失败分支；CAS 原子性由 CR-2026-019 casWriteMulti 组件向量兜底）', () => {
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
    writeBacklog(ws, [{ id: 'CR-OLD', status: 'archived' }, { id: 'CR-OTHER', status: 'drafting' }]); // 常驻条目：backlog 归档后保持非空
    writeCrMd(ws, 'CR-OLD', 'archived');
    writeCrMd(ws, 'CR-OTHER', 'drafting');
    writeIndex(ws, [{ id: 'CR-OLD', title: 'O', status: 'archived', created: '2026-08-01T00:00:00+08:00' }]);
    runCrctl(['archive-move', 'CR-OLD', '--final-status', 'archived', '--workspace', ws]);
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
    // PASS → approve dev-start
    writeEvidence(ws, 'CR-T1', 'review-annotations/dev-plan.yml', 'cr-id: CR-T1\nreviewer: "r"\nreviewed-at: "2026-08-10T00:00:00+08:00"\nverdict: pass\nblockers: []\n');
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

test('CR-2026-026 ①: review-record --stage dev-plan 在 task-breakdown 落盘三账本 + pass 轨省略 repair-target（suggestion-1）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'task-breakdown');
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
  writeEvidence(ws, 'CR-D1', 'review-annotations/dev-plan.yml', 'cr-id: CR-D1\nreview-type: dev-plan\nverdict: pass\nblockers: []\ndimensions:\n  sdd-to-plan: ok\n');
  writeEvidence(ws, 'CR-D1', 'plan.md', '# plan\n');
  writeEvidence(ws, 'CR-D1', 'tasks/_index.yml', 'tasks:\n  - id: CR-D1-TASK-01\n');
  writeEvidence(ws, 'CR-D1', 'tasks/TASK-01.md', '# TASK-01\n');
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

test('CR-2026-027 回修 b5：v1 迁移叠加 orphan ghost → GHOST_ENTRY_ORPHANED 且 backlog 文件保持不变', () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(path.join(ws, 'change-requests', '_backlog.yml'),
      'change-requests:\n  - id: CR-V1\n    status: drafting\n    title: "孤儿幽灵"\n    title: "孤儿幽灵"\n');
    writeCrMd(ws, 'CR-V1', 'drafting');
    const before = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const r = runCrctl(['migrate-backlog', '--no-commit', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'GHOST_ENTRY_ORPHANED');
    assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), before, 'b5：失败时 backlog 文件不变');
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

// ── CR-2026-027 代码评审二轮（b10）：幽灵审计时序 + dev-start 审批迁移闭环 ──
test('CR-2026-027 回修 b10：幽灵清理真实 CAS_CONFLICT 保持 backlog 且零成功审计', () => {
  const ws = makeWorkspace();
  try {
    const ghostTitle = 'Phase0 Tools 技能整合 — 端到端 Pipeline 最佳实践';
    writeBacklogWithGhost(ws, ghostTitle);
    writeHistoryWithArchived(ws, ghostTitle);
    const before = readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8');
    const r = runMigrateWithBacklogCasConflict(ws);
    assert.equal(r.status, 1, r.rawStderr);
    assert.equal(r.stderr.error.code, 'CAS_CONFLICT');
    assert.equal(readFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'utf8'), before + '# concurrent-writer\n', '冲突写入之外，migrate 不得清理或覆盖 backlog');
    const auditText = existsSync(path.join(ws, '.crctl', 'audit.log')) ? readFileSync(path.join(ws, '.crctl', 'audit.log'), 'utf8') : '';
    assert.ok(!auditText.includes('"kind":"migrate-backlog-ghost"'), 'CAS_CONFLICT 不得产生 ghost 清理成功审计');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

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

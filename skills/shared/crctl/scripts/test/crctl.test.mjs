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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
import { readdirSync } from 'node:fs';

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
import { existsSync } from 'node:fs';

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

// ── TASK-10：漂移检出发 audit outbox 事件（activity_log 留证半边，AC-7③）──────
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

test('archive-move：正常路径 backlog 移除 + history 富化（final-status/archived-at）（AC-3）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'archived');
    const r = runCrctl(['archive-move', 'CR-T1', '--final-status', 'archived', '--archive-reason', 'writeback done', '--spec-id', 'ai-first-platform', '--workspace', ws]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.op, 'archive-move');
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
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('archive-move：重复归档（已在 history）→ ENTRY_ALREADY_IN_HISTORY 且两文件均无变更（AC-3 无半状态）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'archived');
    const backlogPath = path.join(ws, 'change-requests', '_backlog.yml');
    const historyPath = path.join(ws, 'change-requests', '_history.yml');
    writeFileSync(historyPath, 'history:\n  - id: CR-T1\n    final-status: archived\n');
    const backlogBefore = readFileSync(backlogPath, 'utf8');
    const historyBefore = readFileSync(historyPath, 'utf8');
    const r = runCrctl(['archive-move', 'CR-T1', '--final-status', 'archived', '--workspace', ws]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.error.code, 'ENTRY_ALREADY_IN_HISTORY');
    assert.equal(readFileSync(backlogPath, 'utf8'), backlogBefore, 'backlog 不得被写');
    assert.equal(readFileSync(historyPath, 'utf8'), historyBefore, 'history 不得被写');
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

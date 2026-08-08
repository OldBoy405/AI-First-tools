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
    assert.equal(r.stdout.attempt, 1, 'attempt 级联为 1');
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
    assert.match(tr, /^    repair-target: write-requirement-prd$/m);
    assert.ok(!existsSync(path.join(ws, 'change-requests', 'CR-R1', 'review-loop.yml')), '非 bump 不创建 review-loop.yml');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('CR-2026-025 投影①b：tech-design 与 code stage 同构投影（repair-target 分别为 write-tech-design / implement-code）', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R1', 'tech-design-review-pending');
    writeReviewPayload(ws, 'CR-R1', 'tech-design', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r1 = runCrctl(['review-record', 'CR-R1', '--stage', 'tech-design', '--workspace', ws]);
    assert.equal(r1.status, 0);
    let tr = readTrace(ws, 'CR-R1');
    assert.match(tr, /^  tech-design:$/m);
    assert.match(tr, /^    annotation: "change-requests\/CR-R1\/review-annotations\/sdd.yml"$/m);
    assert.match(tr, /^    repair-target: write-tech-design$/m);
    assert.ok(!tr.includes('subject-sha256'), 'tech-design 不写摘要（PRD §7 排除项）');
  } finally { rmSync(ws, { recursive: true, force: true }); }
  const ws2 = makeWorkspace();
  try {
    writeCrEntry(ws2, 'CR-R2', 'developing');
    writeReviewPayload(ws2, 'CR-R2', 'code', 'verdict: pass\nblockers: []\ndimensions:\n  a: b\n');
    const r2 = runCrctl(['review-record', 'CR-R2', '--stage', 'code', '--workspace', ws2]);
    assert.equal(r2.status, 0);
    const tr2 = readTrace(ws2, 'CR-R2');
    assert.match(tr2, /^  code:$/m);
    assert.match(tr2, /^    repair-target: implement-code$/m);
  } finally { rmSync(ws2, { recursive: true, force: true }); }
});

test('CR-2026-025 投影①c：trace 已有 requirement 投影时首次写 tech-design 成功（TD-BL-4 合法分支），既有块保留', () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-R1', 'tech-design-review-pending');
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
    assert.equal(r2.stdout.attempt, 2);
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

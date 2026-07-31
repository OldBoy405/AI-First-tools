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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

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

function writeBacklog(ws, entries) {
  const lines = ['change-requests:'];
  for (const e of entries) lines.push(`  - id: ${e.id}`, `    status: ${e.status}`);
  writeFileSync(path.join(ws, 'change-requests', '_backlog.yml'), lines.join('\n') + '\n');
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
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }]);
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
import { readdirSync, readFileSync } from 'node:fs';

function readOutbox(ws) {
  const dir = path.join(ws, '.crctl', 'outbox');
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => ({ file: f, ev: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }));
  } catch { return []; }
}

test('outbox：advance 成功（--no-commit，即 embedded 半边）-> 写入合 schema 的 status 事件且 commit_sha 为空', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }]);
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
    assert.equal(ev.commit_sha, '');
    assert.ok(ev.occurred_at && ev.actor !== undefined && typeof ev.payload === 'object');
    assert.match(events[0].file, /^\d{8}T\d{9}Z-CR-TEST-1-status-nosha\.json$/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('outbox：advance 被拒（非法转换）-> 不写任何事件', () => {
  const ws = makeWorkspace();
  try {
    writeBacklog(ws, [{ id: 'CR-TEST-1', status: 'drafting' }]);
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
    writeBacklog(ws, [{ id: 'CR-2026-001', status: 'drafting' }]); // 保证有可提交内容；CR-ID 用生产格式（提取正则为 CR-\d{4}-\d{3}）
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
  writeBacklog(ws, [{ id: 'CR-2026-001', status: 'requirement-reviewing' }]);
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

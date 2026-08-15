// CR-2026-040 TASK-04：结构化测试闭环测试。
// 覆盖：cr-test-plan/v1 plan 合同、argv 安全（shell:false）、失败分流（业务 block vs 技术 error）、
// marker 分区、command digest、幂等重放、atomic 发布。零依赖，node:test/node:assert。
// 运行：node --test skills/shared/crctl/scripts/test/test-cr.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  parseTestPlan, canonicalCommandSubject, parseAnalysisMarker, renderTestMachineReport,
  renderTestsTraceability, renderLoopText, resolveRepositories, testCr, TxError,
} from '../lib/workspace-transactions.mjs';
import { acquireLock } from '../lib/durable-tx.mjs';

const CRCTL = path.resolve(import.meta.dirname, '..', 'crctl.mjs');
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');

const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const expectTxError = (fn, code) => {
  try { fn(); } catch (e) {
    assert.ok(e instanceof TxError, `应为 TxError，实际 ${e && e.constructor && e.constructor.name}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`期望 ${code}，但没有抛错`);
};

/* ── 纯函数单元测试（非 git fixture：schema/字段/repo 校验先于 worktree 检查） ── */

function makeCtx() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'crctl-testcr-ctx-'));
  const ws = path.join(base, 'ws');
  mkdirSync(path.join(ws, 'change-requests'), { recursive: true });
  mkdirSync(path.join(base, 'tools'));
  writeFileSync(path.join(ws, 'dir-graph.yaml'),
    'workspace:\n  tools_package_path: "tools"\nrepositories:\n' +
    '  - id: ai-first-platform-docs\n    path: "."\n    trunk: master\n    role: knowledge-base\n' +
    '  - id: tools\n    path: "../tools"\n    trunk: main\n    role: code\n');
  return { base, ws, ctx: resolveRepositories(ws) };
}

test('parseTestPlan：schema 非 cr-test-plan/v1 → TEST_PLAN_SCHEMA_INVALID', () => {
  const { base, ctx } = makeCtx();
  try {
    expectTxError(() => parseTestPlan(JSON.stringify({ schema: 'nope', commands: [] }), ctx, 'CR-T1'), 'TEST_PLAN_SCHEMA_INVALID');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('parseTestPlan：空 commands / 字段类型错误 / 禁止字段 → TEST_PLAN_SCHEMA_INVALID', () => {
  const { base, ctx } = makeCtx();
  try {
    expectTxError(() => parseTestPlan(JSON.stringify({ schema: 'cr-test-plan/v1', commands: [] }), ctx, 'CR-T1'), 'TEST_PLAN_SCHEMA_INVALID');
    expectTxError(() => parseTestPlan(JSON.stringify({ schema: 'cr-test-plan/v1', commands: [{ repo: 1 }] }), ctx, 'CR-T1'), 'TEST_PLAN_SCHEMA_INVALID');
    expectTxError(() => parseTestPlan(JSON.stringify({ schema: 'cr-test-plan/v1', commands: [{ repo: 'tools', executable: 'node', command: 'x' }] }), ctx, 'CR-T1'), 'TEST_PLAN_SCHEMA_INVALID');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('parseTestPlan：未知 repo → TEST_REPO_NOT_FOUND；absolute cwd → TEST_CWD_ESCAPE', () => {
  const { base, ctx } = makeCtx();
  try {
    expectTxError(() => parseTestPlan(JSON.stringify({ schema: 'cr-test-plan/v1', commands: [{ repo: 'ghost', executable: 'node' }] }), ctx, 'CR-T1'), 'TEST_REPO_NOT_FOUND');
    expectTxError(() => parseTestPlan(JSON.stringify({ schema: 'cr-test-plan/v1', commands: [{ repo: 'tools', cwd: 'C:/abs', executable: 'node' }] }), ctx, 'CR-T1'), 'TEST_CWD_ESCAPE');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('canonicalCommandSubject：digest 稳定、修改命令后变化', () => {
  const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'tools', cwd: '.', executable: 'node', args: ['--test', 'x'], timeoutSeconds: 30 }] };
  const a = canonicalCommandSubject(plan);
  const b = canonicalCommandSubject(JSON.parse(JSON.stringify(plan)));
  assert.equal(a.digest, b.digest, '同语义 digest 稳定');
  assert.match(a.digest, /^[0-9a-f]{64}$/);
  const changed = { ...plan, commands: [{ ...plan.commands[0], args: ['--test', 'y'] }] };
  assert.notEqual(canonicalCommandSubject(changed).digest, a.digest, '修改 args 后 digest 变化');
});

test('parseAnalysisMarker：缺失 / 重复 / 合法唯一 literal', () => {
  assert.equal(parseAnalysisMarker(null).analysisSuffix, '');
  expectTxError(() => parseAnalysisMarker('# no marker\n'), 'TEST_MARKER_INVALID');
  const dup = '<!-- crctl:analysis-below -->\na\n<!-- crctl:analysis-below -->\nb\n';
  expectTxError(() => parseAnalysisMarker(dup), 'TEST_MARKER_INVALID');
  const ok = '---\nfrontmatter\n---\n\n# 报告\n\n<!-- crctl:analysis-below -->\n\n分析内容\n';
  assert.equal(parseAnalysisMarker(ok).analysisSuffix, '\n\n分析内容\n');
  // 兼容旧带说明前缀
  const legacy = '<!-- crctl:analysis-below 旧说明 -->\n\n旧分析\n';
  assert.equal(parseAnalysisMarker(legacy).analysisSuffix, '\n\n旧分析\n');
  const crlfAnalysis = '<!-- crctl:analysis-below -->\r\n\r\nline 1\r\nline 2\n';
  assert.equal(parseAnalysisMarker(crlfAnalysis).analysisSuffix, '\r\n\r\nline 1\r\nline 2\n');
});

test('renderTestMachineReport：frontmatter 字段与 kebab-case 结果字段', () => {
  const out = renderTestMachineReport({
    cr: 'CR-T1', status: 'block', tester: 'Ray', generatedAt: '2026-08-15T12:00:00+08:00',
    commandDigest: 'abc123', commands: [{
      repo: 'tools', cwd: '.', executable: 'node', args: ['--test', 'x.js'], timeoutSeconds: 600,
      exitCode: 1, signal: null, timedOut: false, started: true, log: 'change-requests/CR-T1/test-evidence/cmd-01.log',
    }],
  });
  assert.match(out, /^---\ncr: CR-T1\nstatus: block\n/);
  assert.match(out, /command-digest: abc123/);
  assert.match(out, /timeout-seconds: 600/);
  assert.match(out, /exit-code: 1/);
  assert.match(out, /timed-out: false/);
  assert.match(out, /log: change-requests\/CR-T1\/test-evidence\/cmd-01\.log/);
  assert.ok(!out.includes('<!-- crctl:analysis-below'), 'machine zone 不含 marker（marker 由 testCr 拼接）');
});

test('renderTestsTraceability：新增 / 替换 / 非法 tests 形状 / cr-id 不匹配', () => {
  const input = { cr: 'CR-T1', reportRel: 'change-requests/CR-T1/test-report.md', status: 'pass', tester: 'Ray', ownerAssignedAt: '2026-08-04T12:00:00+08:00', generatedAt: '2026-08-15T12:00:00+08:00', commandDigest: 'd', reviewLoop: 'write-test-report' };
  const fresh = renderTestsTraceability(null, input);
  assert.match(fresh, /^cr-id: CR-T1\ntests:\n/);
  const existing = 'cr-id: CR-T1\nreviews:\n  requirement:\n    verdict: pass\n';
  const added = renderTestsTraceability(existing, input);
  assert.match(added, /cr-id: CR-T1\n/);
  assert.match(added, /^tests:/m);
  assert.match(added, /reviews:/);
  expectTxError(() => renderTestsTraceability('cr-id: CR-T1\ntests: stale\n', input), 'TRACE_SHAPE');
  expectTxError(() => renderTestsTraceability('cr-id: CR-T1\ntests:\n  report: wrong.md\n', input), 'TRACE_SHAPE');
  expectTxError(() => renderTestsTraceability('cr-id: OTHER\n', input), 'TRACE_SHAPE');
});

test('renderLoopText：schema 稳定渲染', () => {
  const out = renderLoopText({ 'write-test-report': { 'current-cycle': 1, 'current-attempt': 2, attempts: [{ attempt: 1, at: '2026-08-15T12:00:00+08:00', by: 'Ray', cycle: 1 }, { attempt: 2, at: '2026-08-15T12:01:00+08:00', by: 'Ray', cycle: 1 }] } });
  assert.match(out, /# 由 crctl attempt 维护，请勿手工编辑\nloops:\n/);
  assert.match(out, /current-attempt: 2/);
  assert.match(out, /- \{ attempt: 2, at: "2026-08-15T12:01:00\+08:00", by: "Ray", cycle: 1 \}/);
});

/* ── 端到端 CLI（真实 git worktree fixture） ── */

function makeTestCrFixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'crctl-testcr-'));
  const ws = path.join(base, 'ws');
  mkdirSync(path.join(ws, 'change-requests'), { recursive: true });
  writeFileSync(path.join(ws, 'dir-graph.yaml'),
    'workspace:\n  tools_package_path: ' + JSON.stringify(PACKAGE_ROOT) + '\nrepositories:\n' +
    '  - id: ai-first-platform-docs\n    path: "."\n    trunk: master\n    role: knowledge-base\n');
  const sh = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  sh(['init', '-q', '-b', 'master'], ws);
  sh(['config', 'user.email', 'test@aifirst.dev'], ws);
  sh(['config', 'user.name', 'Test'], ws);
  sh(['commit', '-q', '--allow-empty', '-m', 'init'], ws);
  const crWs = path.join(ws, '.rayai-worktrees', 'knowledge-base', 'requirement', 'CR-TEST-1');
  sh(['worktree', 'add', '-q', '-b', 'requirement/CR-TEST-1', crWs], ws);
  const crDir = path.join(crWs, 'change-requests', 'CR-TEST-1');
  mkdirSync(crDir, { recursive: true });
  const owners = ['requirement', 'development', 'test']
    .flatMap((k) => [`  ${k}:`, `    id: Ray`, `    assigned-at: "2026-08-04T12:00:00+08:00"`]);
  writeFileSync(path.join(crDir, 'cr.md'), ['---', 'id: CR-TEST-1', 'status: developing', 'owners:', ...owners, '---', ''].join('\n'));
  return { base, ws, crWs };
}

function runCrctl(args, options = {}) {
  const r = spawnSync(process.execPath, [CRCTL, ...args], {
    encoding: 'utf8', cwd: options.cwd, env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  let stdout = null; try { stdout = JSON.parse(r.stdout); } catch { /* ignore */ }
  let stderr = null; try { stderr = JSON.parse(r.stderr); } catch { /* ignore */ }
  return { code: r.status, stdout, stderr, rawStdout: r.stdout, rawStderr: r.stderr };
}

function writePlan(crWs, plan) {
  const tmp = path.join(crWs, '.crctl', 'tmp');
  mkdirSync(tmp, { recursive: true });
  const p = path.join(tmp, 'test-plan.json');
  writeFileSync(p, JSON.stringify(plan));
  return p;
}

test('端到端：合法 plan → status pass，原子发布四类 authority', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'console.log("ok"); process.exit(0)'], timeoutSeconds: 30 }] };
    const planPath = writePlan(crWs, plan);
    const r = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.op, 'test');
    assert.equal(r.stdout.status, 'pass');
    assert.equal(r.stdout.attempt, 1);
    assert.equal(r.stdout.changed, true);
    const crDir = path.join(crWs, 'change-requests', 'CR-TEST-1');
    assert.ok(existsSync(path.join(crDir, 'test-report.md')));
    assert.ok(existsSync(path.join(crDir, 'test-evidence', 'cmd-01.log')));
    assert.ok(existsSync(path.join(crDir, 'review-loop.yml')));
    const trace = readFileSync(path.join(crDir, 'traceability.yml'), 'utf8');
    assert.match(trace, /^tests:/m);
    assert.match(trace, /status: pass/);
    const report = readFileSync(path.join(crDir, 'test-report.md'), 'utf8');
    assert.match(report, /command-digest: [0-9a-f]{64}/);
    assert.match(report, /<!-- crctl:analysis-below -->/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：--cmd 拒绝（BAD_ARGS），不执行命令、零 authority', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    const r = runCrctl(['test', 'CR-TEST-1', '--cmd', 'echo hi', '--workspace', crWs]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr.error.code, 'BAD_ARGS');
    assert.ok(!existsSync(path.join(crWs, 'change-requests', 'CR-TEST-1', 'test-report.md')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：argv 安全——args 含 shell 元字符不触发 shell 解释', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'console.log("ARGV_SAFE")', '; echo INJECTED', '$(echo INJECTED)'], timeoutSeconds: 30 }] };
    const planPath = writePlan(crWs, plan);
    const r = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(r.code, 0);
    const log = readFileSync(path.join(crWs, 'change-requests', 'CR-TEST-1', 'test-evidence', 'cmd-01.log'), 'utf8');
    const stdoutSection = log.split('--- stdout ---')[1] || '';
    assert.match(stdoutSection, /ARGV_SAFE/);
    assert.ok(!stdoutSection.includes('INJECTED'), 'shell 元字符不得被解释执行（只断言 stdout 段）');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：业务失败分流——non-zero 继续执行并发布 block，进程 exit 0', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    const plan = { schema: 'cr-test-plan/v1', commands: [
      { repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'process.exit(1)'], timeoutSeconds: 30 },
      { repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'console.log("second-ran"); process.exit(0)'], timeoutSeconds: 30 },
    ] };
    const planPath = writePlan(crWs, plan);
    const r = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(r.code, 0, '业务 block 仍 exit 0');
    assert.equal(r.stdout.status, 'block');
    assert.equal(r.stdout.commands.length, 2, '失败后剩余命令仍执行');
    assert.equal(r.stdout.commands[0].exitCode, 1);
    assert.equal(r.stdout.commands[1].exitCode, 0);
    assert.match(readFileSync(path.join(crWs, 'change-requests', 'CR-TEST-1', 'test-evidence', 'cmd-02.log'), 'utf8'), /second-ran/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：幂等重放——相同 plan 重放 changed=false 且不重复 attempt', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 }] };
    const planPath = writePlan(crWs, plan);
    const r1 = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(r1.stdout.changed, true);
    assert.equal(r1.stdout.attempt, 1);
    const r2 = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(r2.code, 0);
    assert.equal(r2.stdout.changed, false, '已完成事务重放 changed=false');
    assert.equal(r2.stdout.attempt, 1, '不重复 attempt');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：executable 启动失败 → TEST_EXECUTABLE_INVALID 零 authority', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'definitely-not-a-real-exe-xyz', args: [], timeoutSeconds: 30 }] };
    const planPath = writePlan(crWs, plan);
    const r = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr.error.code, 'TEST_EXECUTABLE_INVALID');
    assert.ok(!existsSync(path.join(crWs, 'change-requests', 'CR-TEST-1', 'test-report.md')), '技术失败零 authority');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：LF/CRLF plan 语义相同 → command digest 相同且不重复 attempt', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 }] };
    const planPath = writePlan(crWs, plan);
    const first = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    writeFileSync(planPath, JSON.stringify(plan, null, 2).replaceAll('\n', '\r\n'));
    const second = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(second.code, 0);
    assert.equal(second.stdout.commandDigest, first.stdout.commandDigest);
    assert.equal(second.stdout.changed, false);
    assert.equal(second.stdout.attempt, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：timeout 是业务 block，剩余命令继续执行', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    const plan = { schema: 'cr-test-plan/v1', commands: [
      { repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutSeconds: 1 },
      { repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'console.log("after-timeout")'], timeoutSeconds: 30 },
    ] };
    const r = runCrctl(['test', 'CR-TEST-1', '--plan', writePlan(crWs, plan), '--workspace', crWs]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.status, 'block');
    assert.equal(r.stdout.commands[0].timedOut, true);
    assert.equal(r.stdout.commands[1].exitCode, 0);
    assert.match(readFileSync(path.join(crWs, 'change-requests', 'CR-TEST-1', 'test-evidence', 'cmd-02.log'), 'utf8'), /after-timeout/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：新 attempt 逐字保留 marker 后分析；失败前不删除 complete journal', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 }] };
    const planPath = writePlan(crWs, plan);
    const first = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(first.stdout.attempt, 1);
    const reportPath = path.join(crWs, 'change-requests', 'CR-TEST-1', 'test-report.md');
    const original = readFileSync(reportPath, 'utf8');
    const analysis = '\n\n## 人工分析\nline 1\r\nline 2\n';
    writeFileSync(reportPath, original + analysis);
    const changed = { ...plan, commands: [{ ...plan.commands[0], args: ['-e', 'console.log("changed")'] }] };
    writeFileSync(planPath, JSON.stringify(changed));
    const second = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(second.code, 0);
    assert.equal(second.stdout.attempt, 2);
    assert.ok(readFileSync(reportPath, 'utf8').endsWith(analysis), '分析区字节原样保留');

    const validSecond = readFileSync(reportPath, 'utf8');
    writeFileSync(reportPath, validSecond.replace('<!-- crctl:analysis-below -->', '<!-- marker removed -->'));
    writeFileSync(planPath, JSON.stringify({ ...plan, commands: [{ ...plan.commands[0], args: ['-e', 'console.log("third")'] }] }));
    const failed = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr.error.code, 'TEST_MARKER_INVALID');
    writeFileSync(reportPath, validSecond);
    writeFileSync(planPath, JSON.stringify(changed));
    const replay = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(replay.stdout.changed, false, '失败的新 attempt 不得删除上一 complete journal');
    assert.equal(replay.stdout.attempt, 2);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：参与仓 HEAD 改变后同一 plan 生成新 attempt', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 }] };
    const planPath = writePlan(crWs, plan);
    const first = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(first.stdout.attempt, 1);
    writeFileSync(path.join(crWs, 'source-change.txt'), 'changed\n');
    spawnSync('git', ['add', 'source-change.txt'], { cwd: crWs, encoding: 'utf8', shell: false });
    const commit = spawnSync('git', ['commit', '-q', '-m', 'source change'], { cwd: crWs, encoding: 'utf8', shell: false });
    assert.equal(commit.status, 0, commit.stderr);
    const second = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(second.code, 0);
    assert.equal(second.stdout.changed, true);
    assert.equal(second.stdout.attempt, 2);
    const journals = path.join(crWs, '.crctl', 'transactions', 'test', 'CR-TEST-1');
    assert.equal(readdirSync(journals).length, 2, '新 attempt 完成后仍保留旧 complete journal');
    const replay = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(replay.stdout.changed, false);
    assert.equal(replay.stdout.attempt, 2);

    writeFileSync(path.join(crWs, 'source-change.txt'), 'changed-again\n');
    spawnSync('git', ['add', 'source-change.txt'], { cwd: crWs, encoding: 'utf8', shell: false });
    assert.equal(spawnSync('git', ['commit', '-q', '-m', 'source change 2'], { cwd: crWs, encoding: 'utf8', shell: false }).status, 0);
    assert.equal(runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]).stdout.attempt, 3);
    writeFileSync(path.join(crWs, 'source-change.txt'), 'changed-cycle-2\n');
    spawnSync('git', ['add', 'source-change.txt'], { cwd: crWs, encoding: 'utf8', shell: false });
    assert.equal(spawnSync('git', ['commit', '-q', '-m', 'source change cycle 2'], { cwd: crWs, encoding: 'utf8', shell: false }).status, 0);
    const nextCycle = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(nextCycle.code, 0);
    assert.equal(nextCycle.stdout.attempt, 1, 'PASS 后 source 变化开启下一 review cycle');
    const loop = readFileSync(path.join(crWs, 'change-requests', 'CR-TEST-1', 'review-loop.yml'), 'utf8');
    assert.match(loop, /write-test-report:\n    current-cycle: 2\n    current-attempt: 1/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：plan 只能位于 workspace/.crctl/tmp，拒绝 traversal/authority/symlink escape', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 }] };
    const outsideDir = path.join(base, 'outside');
    mkdirSync(outsideDir);
    const outside = path.join(outsideDir, 'plan.json');
    writeFileSync(outside, JSON.stringify(plan));
    const authority = path.join(crWs, 'change-requests', 'CR-TEST-1', 'plan.json');
    writeFileSync(authority, JSON.stringify(plan));
    for (const candidate of [outside, authority, path.join(crWs, '.crctl', 'tmp', '..', '..', 'change-requests', 'CR-TEST-1', 'plan.json')]) {
      const r = runCrctl(['test', 'CR-TEST-1', '--plan', candidate, '--workspace', crWs]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr.error.code, 'TEST_PLAN_PATH_INVALID');
    }
    const link = path.join(crWs, '.crctl', 'tmp', 'outside-link');
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = runCrctl(['test', 'CR-TEST-1', '--plan', path.join(link, 'plan.json'), '--workspace', crWs]);
    assert.equal(linked.code, 1);
    assert.equal(linked.stderr.error.code, 'TEST_PLAN_PATH_INVALID');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：cwd 拒绝 .. 段并将等价路径 canonicalize', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    mkdirSync(path.join(crWs, 'subdir'));
    const bad = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: 'subdir/..', executable: 'node', args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 }] };
    const rejected = runCrctl(['test', 'CR-TEST-1', '--plan', writePlan(crWs, bad), '--workspace', crWs]);
    assert.equal(rejected.code, 1);
    assert.equal(rejected.stderr.error.code, 'TEST_CWD_ESCAPE');
    const good = { ...bad, commands: [{ ...bad.commands[0], cwd: 'subdir/.' }] };
    const accepted = runCrctl(['test', 'CR-TEST-1', '--plan', writePlan(crWs, good), '--workspace', crWs]);
    assert.equal(accepted.code, 0);
    assert.equal(accepted.stdout.commands[0].cwd, 'subdir');

    const outside = path.join(base, 'outside-cwd');
    mkdirSync(outside);
    const link = path.join(crWs, 'outside-link');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const escaped = { ...bad, commands: [{ ...bad.commands[0], cwd: 'outside-link' }] };
    const symlinkEscape = runCrctl(['test', 'CR-TEST-1', '--plan', writePlan(crWs, escaped), '--workspace', crWs]);
    assert.equal(symlinkEscape.code, 1);
    assert.equal(symlinkEscape.stderr.error.code, 'TEST_CWD_ESCAPE');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：test scope lock 被持有时保守阻断且零 authority', async () => {
  const { base, crWs } = makeTestCrFixture();
  const lock = await acquireLock({ root: crWs, scope: 'test-CR-TEST-1', op: 'test', cr: 'CR-TEST-1' });
  try {
    const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 }] };
    const r = runCrctl(['test', 'CR-TEST-1', '--plan', writePlan(crWs, plan), '--workspace', crWs]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr.error.code, 'TX_LOCK_HELD');
    assert.ok(!existsSync(path.join(crWs, 'change-requests', 'CR-TEST-1', 'test-report.md')));
  } finally {
    await lock.release();
    rmSync(base, { recursive: true, force: true });
  }
});

test('端到端：BLOCK 到 maxAttempts 后硬停止且不执行新命令', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    const crDir = path.join(crWs, 'change-requests', 'CR-TEST-1');
    writeFileSync(path.join(crDir, 'test-report.md'), '---\ncr: CR-TEST-1\nstatus: block\ngenerated-by: crctl-test\n---\n\n<!-- crctl:analysis-below -->\n');
    writeFileSync(path.join(crDir, 'review-loop.yml'), renderLoopText({
      'write-test-report': {
        'current-cycle': 1, 'current-attempt': 3,
        attempts: [1, 2, 3].map((attempt) => ({ attempt, at: `2026-08-15T12:0${attempt}:00+08:00`, by: 'Ray', cycle: 1 })),
      },
    }));
    const sentinel = path.join(crWs, 'sentinel.txt');
    const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`], timeoutSeconds: 30 }] };
    const r = runCrctl(['test', 'CR-TEST-1', '--plan', writePlan(crWs, plan), '--workspace', crWs]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr.error.code, 'TEST_LOOP_EXHAUSTED');
    assert.ok(!existsSync(sentinel));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：非法 test journal 硬失败，不被 complete 幂等路径静默跳过', () => {
  const { base, crWs } = makeTestCrFixture();
  try {
    const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 }] };
    const planPath = writePlan(crWs, plan);
    const first = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(first.code, 0);
    const reportPath = path.join(crWs, 'change-requests', 'CR-TEST-1', 'test-report.md');
    const before = readFileSync(reportPath, 'utf8');
    const badDir = path.join(crWs, '.crctl', 'transactions', 'test', 'CR-TEST-1', 'bad-journal');
    mkdirSync(badDir);
    writeFileSync(path.join(badDir, 'journal.json'), '{bad');
    const replay = runCrctl(['test', 'CR-TEST-1', '--plan', planPath, '--workspace', crWs]);
    assert.equal(replay.code, 1);
    assert.equal(replay.stderr.error.code, 'TX_JOURNAL_INVALID');
    assert.equal(readFileSync(reportPath, 'utf8'), before);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('端到端：非法 review-loop 与 pipeline 配置硬失败且不执行命令', async () => {
  const first = makeTestCrFixture();
  try {
    const sentinel = path.join(first.crWs, 'sentinel.txt');
    writeFileSync(path.join(first.crWs, 'change-requests', 'CR-TEST-1', 'review-loop.yml'), 'loops: stale\n');
    const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`], timeoutSeconds: 30 }] };
    const r = runCrctl(['test', 'CR-TEST-1', '--plan', writePlan(first.crWs, plan), '--workspace', first.crWs]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr.error.code, 'TEST_REVIEW_LOOP_INVALID');
    assert.ok(!existsSync(sentinel));
  } finally { rmSync(first.base, { recursive: true, force: true }); }

  const second = makeTestCrFixture();
  try {
    const badTools = path.join(second.base, 'bad-tools');
    mkdirSync(path.join(badTools, 'pipeline-templates'), { recursive: true });
    writeFileSync(path.join(badTools, 'pipeline-templates', 'code-implementation.pipeline.json'), '{bad');
    const graph = readFileSync(path.join(second.ws, 'dir-graph.yaml'), 'utf8');
    writeFileSync(path.join(second.ws, 'dir-graph.yaml'), graph.replace(JSON.stringify(PACKAGE_ROOT), JSON.stringify(badTools)));
    const sentinel = path.join(second.crWs, 'sentinel.txt');
    const plan = { schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`], timeoutSeconds: 30 }] };
    const planPath = writePlan(second.crWs, plan);
    const ctx = resolveRepositories(second.crWs);
    await assert.rejects(() => testCr(ctx, { cr: 'CR-TEST-1', workspace: second.crWs, planPath }),
      (e) => e instanceof TxError && e.code === 'TEST_CONFIG_INVALID');
    assert.ok(!existsSync(sentinel));
  } finally { rmSync(second.base, { recursive: true, force: true }); }
});

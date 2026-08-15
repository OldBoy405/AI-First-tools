// CR-2026-031 TASK-01：确定性故障注入 harness 契约测试。
// 覆盖：CRCTL_FAULT_POINT 未设置零行为、未知 point 硬失败、命中 point 触发 FAULT_INJECTED，
// 以及 command-level ledger transaction 在 rename 间隙崩溃后的整组回滚与重试。
// 零依赖：仅用 node:test / node:assert，黑盒 spawnSync 调用 crctl.mjs。
// 运行：node --test skills/shared/crctl/scripts/test/fault-harness.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const CRCTL = path.resolve(import.meta.dirname, '..', 'crctl.mjs');
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');

const FAULT_ENV = 'CRCTL_FAULT_POINT';

// TASK-01 接口契约：测试侧统一 runner（后续 TASK 的事务红测复用此 helper）。
async function runCrctl(args, options = {}) {
  const { cwd, env, expectExit } = options;
  const r = spawnSync(process.execPath, [CRCTL, ...args], {
    encoding: 'utf8',
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  });
  let stdout = null;
  try { stdout = JSON.parse(r.stdout); } catch { /* 非 JSON 输出忽略 */ }
  let stderr = null;
  try { stderr = JSON.parse(r.stderr); } catch { /* ignore */ }
  if (expectExit !== undefined) assert.equal(r.status, expectExit, `期望 exit ${expectExit}，实际 ${r.status}：${r.stderr}`);
  return { code: r.status, stdout, stderr };
}

function makeWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crctl-fault-'));
  mkdirSync(path.join(dir, 'change-requests'), { recursive: true });
  writeFileSync(path.join(dir, 'dir-graph.yaml'),
    `workspace:\n  tools_package_path: ${JSON.stringify(PACKAGE_ROOT)}\n`, 'utf8');
  return dir;
}

function writeCrEntry(ws, cr, status) {
  const owners = ['requirement', 'development', 'test']
    .flatMap((k) => [`${k}:`, `  id: Ray`, `  assigned-at: "2026-08-04T12:00:00+08:00"`]);
  writeFileSync(path.join(ws, 'change-requests', '_backlog.yml'),
    ['schema: cr-backlog/v2', 'change-requests:', `  - id: ${cr}`, '    owners:',
      ...owners.map((l) => '      ' + l)].join('\n') + '\n');
  const dir = path.join(ws, 'change-requests', cr);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'cr.md'),
    ['---', `id: ${cr}`, `status: ${status}`, 'owners:',
      ...owners.map((l) => '  ' + l), '---', ''].join('\n'));
}

function setupTechDesignReview(ws, cr) {
  writeCrEntry(ws, cr, 'tech-design-review-pending');
  const sdd = path.join(ws, 'change-requests', cr, 'sdd.md');
  writeFileSync(sdd, `---\nid: ${cr}-sdd\n---\n`);
  const tmp = path.join(ws, '.crctl', 'tmp');
  mkdirSync(tmp, { recursive: true });
  writeFileSync(path.join(tmp, 'review-tech-design.yml'),
    'verdict: pass\nblockers: []\ndimensions:\n  structure: ok\nsuggestions: []\n');
}

function dirFingerprint(ws) {
  // 行尾规范化后哈希（纪律 #1）；覆盖受控账本文件集合的存在性与内容
  const files = ['change-requests/_backlog.yml', 'change-requests/CR-T1/cr.md',
    'change-requests/CR-T1/traceability.yml', 'change-requests/CR-T1/review-loop.yml'];
  return files.map((f) => {
    const p = path.join(ws, f);
    return existsSync(p) ? crypto.createHash('sha256').update(readFileSync(p, 'utf8').replaceAll('\r\n', '\n')).digest('hex').slice(0, 16) : 'MISSING';
  }).join('|');
}

test('fault harness：CRCTL_FAULT_POINT 未设置 → 零行为，正常命令不受影响', async () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    const r = await runCrctl(['status', 'CR-T1', '--workspace', ws], { expectExit: 0 });
    assert.equal(r.stdout.status, 'drafting');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('fault harness：未登记 point → UNKNOWN_FAULT_POINT 硬失败且零写入', async () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    const before = dirFingerprint(ws);
    const r = await runCrctl(['status', 'CR-T1', '--workspace', ws], { env: { [FAULT_ENV]: 'no-such-point' }, expectExit: 1 });
    assert.equal(r.stderr.error.code, 'UNKNOWN_FAULT_POINT');
    assert.ok(Array.isArray(r.stderr.error.known) && r.stderr.error.known.length > 0, '错误须携带已登记 point 列表');
    assert.equal(dirFingerprint(ws), before, '零写入');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('fault harness：命中挂接点 → FAULT_INJECTED 结构化退出并回显 point', async () => {
  const ws = makeWorkspace();
  try {
    setupTechDesignReview(ws, 'CR-T1');
    const r = await runCrctl(['review-record', 'CR-T1', '--stage', 'tech-design', '--bump-attempt', '--workspace', ws],
      { env: { [FAULT_ENV]: 'tx-apply-between-rename' }, expectExit: 1 });
    assert.equal(r.stderr.error.code, 'FAULT_INJECTED');
    assert.equal(r.stderr.error.point, 'tx-apply-between-rename');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('fault harness：point 已设置但执行路径未挂接 → 命令正常完成', async () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    const r = await runCrctl(['status', 'CR-T1', '--workspace', ws],
      { env: { [FAULT_ENV]: 'tx-apply-between-rename' }, expectExit: 0 });
    assert.equal(r.stdout.status, 'drafting');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('checkpoint fault points 已登记（CR-2026-033 T01）', async () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    for (const p of ['checkpoint-after-source-commit', 'checkpoint-after-push', 'checkpoint-after-confirm', 'checkpoint-after-metadata-commit', 'checkpoint-after-metadata-push']) {
      const r = await runCrctl(['status', 'CR-T1', '--workspace', ws], { env: { [FAULT_ENV]: p }, expectExit: 0 });
      assert.equal(r.stdout.status, 'drafting', `${p} 已登记（不报 UNKNOWN_FAULT_POINT）`);
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('review repair：ledger rename 间隙中断后，下次同命令先整组回滚再成功重试', async () => {
  const ws = makeWorkspace();
  try {
    setupTechDesignReview(ws, 'CR-T1');
    await runCrctl(['review-record', 'CR-T1', '--stage', 'tech-design', '--bump-attempt', '--workspace', ws],
      { env: { [FAULT_ENV]: 'tx-apply-between-rename' }, expectExit: 1 });
    const crDir = path.join(ws, 'change-requests', 'CR-T1');
    assert.ok(existsSync(path.join(crDir, 'review-annotations', 'sdd.yml')), '故障确实命中首个 rename 后窗口');
    const r = await runCrctl(['review-record', 'CR-T1', '--stage', 'tech-design', '--bump-attempt', '--workspace', ws], { expectExit: 0 });
    assert.equal(r.stdout.attempt.current, 1, '回滚后重试只登记一次 attempt');
    assert.ok(existsSync(path.join(crDir, 'review-annotations', 'sdd.yml')));
    assert.ok(existsSync(path.join(crDir, 'traceability.yml')));
    assert.ok(existsSync(path.join(crDir, 'review-loop.yml')));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

/* ── CR-2026-040 TASK-05：test 记录阶段故障矩阵 ─────────────────────────── */

function makeTestCrFixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'crctl-fault-test-'));
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
  const crWs = path.join(ws, '.rayai-worktrees', 'knowledge-base', 'requirement', 'CR-T1');
  sh(['worktree', 'add', '-q', '-b', 'requirement/CR-T1', crWs], ws);
  const crDir = path.join(crWs, 'change-requests', 'CR-T1');
  mkdirSync(crDir, { recursive: true });
  const owners = ['requirement', 'development', 'test']
    .flatMap((k) => [`  ${k}:`, `    id: Ray`, `    assigned-at: "2026-08-04T12:00:00+08:00"`]);
  writeFileSync(path.join(crDir, 'cr.md'), ['---', 'id: CR-T1', 'status: developing', 'owners:', ...owners, '---', ''].join('\n'));
  const tmp = path.join(crWs, '.crctl', 'tmp');
  mkdirSync(tmp, { recursive: true });
  const planPath = path.join(tmp, 'test-plan.json');
  writeFileSync(planPath, JSON.stringify({ schema: 'cr-test-plan/v1', commands: [{ repo: 'ai-first-platform-docs', cwd: '.', executable: 'node', args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 }] }));
  return { base, ws, crWs, planPath };
}

test('fault harness：test 记录阶段 tx-apply-between-rename 中断后恢复，attempt 不重复', async () => {
  const { base, crWs, planPath } = makeTestCrFixture();
  try {
    const r1 = await runCrctl(['test', 'CR-T1', '--plan', planPath, '--workspace', crWs],
      { env: { [FAULT_ENV]: 'tx-apply-between-rename' }, expectExit: 1 });
    assert.equal(r1.stderr.error.code, 'FAULT_INJECTED');
    // 恢复：去掉 fault point，重跑完整 plan
    const r2 = await runCrctl(['test', 'CR-T1', '--plan', planPath, '--workspace', crWs], { expectExit: 0 });
    assert.equal(r2.stdout.attempt, 1, '恢复后 attempt 不重复');
    const crDir = path.join(crWs, 'change-requests', 'CR-T1');
    assert.ok(existsSync(path.join(crDir, 'test-report.md')), '恢复后 authority 完整');
    assert.ok(existsSync(path.join(crDir, 'traceability.yml')));
    assert.ok(existsSync(path.join(crDir, 'review-loop.yml')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('fault harness：test 记录阶段 tx-apply-before-complete 中断后恢复并标 complete', async () => {
  const { base, crWs, planPath } = makeTestCrFixture();
  try {
    const r1 = await runCrctl(['test', 'CR-T1', '--plan', planPath, '--workspace', crWs],
      { env: { [FAULT_ENV]: 'tx-apply-before-complete' }, expectExit: 1 });
    assert.equal(r1.stderr.error.code, 'FAULT_INJECTED');
    const r2 = await runCrctl(['test', 'CR-T1', '--plan', planPath, '--workspace', crWs], { expectExit: 0 });
    assert.equal(r2.stdout.attempt, 1, 'complete 标记前中断恢复后 attempt 不重复');
    const r3 = await runCrctl(['test', 'CR-T1', '--plan', planPath, '--workspace', crWs], { expectExit: 0 });
    assert.equal(r3.stdout.changed, false, '恢复标 complete 后重放幂等 changed=false');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

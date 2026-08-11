// CR-2026-031 TASK-01：确定性故障注入 harness 契约测试。
// 覆盖：CRCTL_FAULT_POINT 未设置零行为、未知 point 硬失败、命中 point 触发 FAULT_INJECTED、
// 以及旧实现 casWriteMulti 连续 rename 间隙的半状态基线暴露（该基线测试随 TASK-02 删除 casWriteMulti 一并退役）。
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
    ['change-requests:', `  - id: ${cr}`, `    status: ${status}`, '    owners:',
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
      { env: { [FAULT_ENV]: 'ledger-cas-multi-between-rename' }, expectExit: 1 });
    assert.equal(r.stderr.error.code, 'FAULT_INJECTED');
    assert.equal(r.stderr.error.point, 'ledger-cas-multi-between-rename');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('fault harness：point 已设置但执行路径未挂接 → 命令正常完成', async () => {
  const ws = makeWorkspace();
  try {
    writeCrEntry(ws, 'CR-T1', 'drafting');
    const r = await runCrctl(['status', 'CR-T1', '--workspace', ws],
      { env: { [FAULT_ENV]: 'ledger-cas-multi-between-rename' }, expectExit: 0 });
    assert.equal(r.stdout.status, 'drafting');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('旧实现半状态基线：casWriteMulti rename 间隙中断 → annotation 已落、traceability/review-loop 未落（红基线，TASK-02 随函数退役）', async () => {
  const ws = makeWorkspace();
  try {
    setupTechDesignReview(ws, 'CR-T1');
    await runCrctl(['review-record', 'CR-T1', '--stage', 'tech-design', '--bump-attempt', '--workspace', ws],
      { env: { [FAULT_ENV]: 'ledger-cas-multi-between-rename' }, expectExit: 1 });
    const crDir = path.join(ws, 'change-requests', 'CR-T1');
    assert.ok(existsSync(path.join(crDir, 'review-annotations', 'sdd.yml')), '第一个 rename 已落盘（半状态第一侧）');
    assert.ok(!existsSync(path.join(crDir, 'traceability.yml')), '第二个 rename 未执行（半状态暴露）');
    assert.ok(!existsSync(path.join(crDir, 'review-loop.yml')), '第三个 rename 未执行（半状态暴露）');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

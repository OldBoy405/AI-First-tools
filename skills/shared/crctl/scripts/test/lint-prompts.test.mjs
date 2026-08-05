// lint-prompts.mjs 测试（CR-2026-021 TASK-11，SDD §4.3/AC-13）
// 零依赖：node:test + spawnSync 黑盒调用，fixture 落在临时目录，不污染真实仓。
// 运行：node --test skills/shared/crctl/scripts/test/lint-prompts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LINT = path.resolve(import.meta.dirname, '..', 'lint-prompts.mjs');
const RULES = path.resolve(import.meta.dirname, '..', '..', '..', 'controlled-shell', 'rules.json');

function makeFixture(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lint-prompts-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function runLint(args) {
  const r = spawnSync(process.execPath, [LINT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CRCTL_RULES_PATH: RULES },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('R1：手写 guard-deny 文件且同段无 crctl → CONTRADICTS', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 评审\n\n将结论写入 change-requests/CR-1/approval.yml 的 requirement 段。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.equal(r.status, 0, 'report 模式不阻断');
    assert.ok(r.stdout.includes('R1') && r.stdout.includes('CONTRADICTS'), `应命中 R1: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R1 豁免：同段含 crctl 调用（正确示范）不误报', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 评审\n\n改用 crctl review-record --stage requirement 写入 review-annotations。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('CONTRADICTS'), `不应误报: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R1 豁免：<!-- lint-prompts:ignore --> 跳过该段', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 说明\n\n<!-- lint-prompts:ignore -->\n历史原因：曾经手写 change-requests/_backlog.yml 的 status。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('CONTRADICTS'), `ignore 段不应报: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R2：裸 git 命令 → CONTRADICTS；crctl git 形态不报', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 提交\n\n执行 git commit -m "x" 提交变更。\n\n# 迁移后\n\n执行 crctl git commit -m "x" 提交变更。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('R2'), `应命中 R2: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R3/R4：cr-status-set / 六字段口径 → STALE-REF / CONTRADICTS', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 推进\n\n调用 cr-status-set 推进状态；merge-commits 校验六字段必填。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(r.stdout.includes('R3') && r.stdout.includes('STALE-REF'), `应命中 R3: ${r.stdout}`);
    assert.ok(r.stdout.includes('R4') && r.stdout.includes('CONTRADICTS'), `应命中 R4: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R5：手写 review-loop 记账（配合写动词）→ OUTDATED', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 测试\n\n测试后将 review-loop.current-attempt 与 attempts[] 写入 traceability。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(r.stdout.includes('R5') && r.stdout.includes('OUTDATED'), `应命中 R5: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R5 不误报：passCondition 读取声明（无写动词）', () => {
  const dir = makeFixture({
    'pipeline-templates/p.pipeline.json': JSON.stringify({
      nodes: [{ ref: 'review-x', prompt: 'passCondition 读取 review-loop.current-attempt 判定轮次。', reviewLoop: { maxAttempts: 3 } }],
    }),
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(!r.stdout.includes('OUTDATED'), `读取声明不应报 R5: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R6：test-report.md 手写 frontmatter → CONTRADICTS', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 测试报告\n\n手写 test-report.md 的 status: pass 与 commands: 段。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(r.stdout.includes('R6') && r.stdout.includes('CONTRADICTS'), `应命中 R6: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('enforce 模式：有 CONTRADICTS/STALE-REF → exit 1 + LINT_DRIFT', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 评审\n\n手写 change-requests/CR-1/cr.md 的 status。\n',
  });
  try {
    const r = runLint(['--mode', 'enforce', '--root', dir]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('LINT_DRIFT'), `stderr 应含 LINT_DRIFT: ${r.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('enforce 模式：零漂移 → exit 0', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 推进\n\n使用 crctl advance --to X --trigger Y 推进状态。\n',
  });
  try {
    const r = runLint(['--mode', 'enforce', '--root', dir]);
    assert.equal(r.status, 0, `干净 fixture 应通过 enforce: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

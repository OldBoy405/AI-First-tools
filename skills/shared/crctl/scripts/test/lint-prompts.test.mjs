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

// CR-2026-030 TASK-01：R7 权威字面量校验的 fixture 最小合法 dir-graph.yaml（缺省写入，可被 files 覆盖）
const MINI_DIR_GRAPH = [
  'change-request-track:',
  '  state_machine:',
  '    field: "status"',
  '    transitions:',
  '      - { from: task-breakdown, to: tech-design-reviewed, trigger: "review-dev-plan:block -> write-dev-plan" }',
  '      - { from: task-breakdown, to: tech-design-review-pending, trigger: "review-dev-plan:upstream-design-blocker" }',
  '      - { from: code-approved, to: merging, trigger: "merge-feature-branch" }',
].join('\n') + '\n';

function makeFixture(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lint-prompts-'));
  if (files['dir-graph.yaml'] === undefined) files['dir-graph.yaml'] = MINI_DIR_GRAPH;
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
    'skills/x/SKILL.md': '# 推进\n\n使用 `crctl advance --to tech-design-reviewed --trigger "review-dev-plan:block -> write-dev-plan" --embedded` 推进状态。\n',
  });
  try {
    const r = runLint(['--mode', 'enforce', '--root', dir]);
    assert.equal(r.status, 0, `干净 fixture 应通过 enforce: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── CR-2026-022 TASK-15：R7/R8 规则 + 豁免范围收窄（FR-24~26）──

test('R7：crctl advance 全角分隔符/伪旗标 → CONTRADICTS', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 推进\n\n调用 `crctl advance --to archived、`trigger=cr-archive`、`expected_current_status=writing-back`）推进。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(r.stdout.includes('R7') && r.stdout.includes('CONTRADICTS'), `应命中 R7: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R7：advance 缺 --trigger → CONTRADICTS；完整形态不报', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 推进\n\n调用 `crctl advance --to merging --embedded` 推进。\n\n# 正确\n\n调用 `crctl advance --to merging --trigger merge-feature-branch --embedded` 推进。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(r.stdout.includes('R7'), `应命中缺 trigger 的 R7: ${r.stdout}`);
    assert.ok(!r.stdout.includes('merge-feature-branch --embedded` 推进'), '完整形态不报');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R7：backlog-set 字段越白名单 + --template subject 缺 CR 编号 → CONTRADICTS', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 账本\n\n运行 crctl backlog-set CR-1 --field status --value x。\n\n# 提交\n\n运行 crctl git commit --template writeback -m \"回写\" --cwd w。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(r.stdout.includes('backlog-set --field 越白名单'), `应命中字段越界: ${r.stdout}`);
    assert.ok(r.stdout.includes('subject 必须含 CR 编号'), `应命中 template 缺编号: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R8：函数式 inbox-emit + 枚举外 event → CONTRADICTS；合法 event 不报', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 通知\n\ninbox-emit(to: \"a\")\ncrctl inbox-emit CR-1 --event bogus-event --to a\ncrctl inbox-emit CR-1 --event owner-handover --to a\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(r.stdout.includes('函数式 inbox-emit'), `应命中函数式: ${r.stdout}`);
    assert.ok(r.stdout.includes('bogus-event'), `应命中枚举外 event: ${r.stdout}`);
    assert.ok(!r.stdout.includes('owner-handover'), '合法 event 不报');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('豁免收窄：注释与违规行隔 3+ 行 → 仍命中；±1 行内 → 豁免（FR-25 契约）', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 说明\n<!-- lint-prompts:ignore --> 描述：历史说明\n\n\n\n历史原因：曾经手写 change-requests/_backlog.yml 的 status。\n\n# 相邻\n<!-- lint-prompts:ignore --> 描述：仅此段\n此处解释 change-requests/_backlog.yml 的写入流程。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(r.stdout.includes('skills/x/SKILL.md:6'), `隔 3+ 行违规仍应命中（R1 at line 6）: ${r.stdout}`);
    assert.ok(!r.stdout.includes('写入流程'), '±1 行内豁免');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── CR-2026-023 TASK-02：R9 规则（CR 上下文「下一步」提示收敛 crctl next，FR-12）──

test('R9：CR 上下文「下一步」手写 skill 副本 → CONTRADICTS；crctl next 形态不报', () => {
  const dir = makeFixture({
    'skills/requirement/x/SKILL.md': '# 输出\n\n下一步 : 执行 review-requirement 或 push-progress\n\n# 合规\n\n下一步 : 以 `crctl next {cr_id}` 为准\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(r.stdout.includes('R9') && r.stdout.includes('CONTRADICTS'), `应命中 R9: ${r.stdout}`);
    assert.ok(r.stdout.includes('skills/requirement/x/SKILL.md:3'), `违例行号应为 3: ${r.stdout}`);
    assert.ok(!r.stdout.includes('skills/requirement/x/SKILL.md:7'), 'crctl next 合规行不报');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R9：域外 SKILL.md 的「下一步」不受约束（含真实 skill id 也不报）', () => {
  const dir = makeFixture({
    'skills/planning/x/SKILL.md': '# 输出\n\n下一步 : 执行 review-requirement\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(!r.stdout.includes('R9'), `域外不报: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R9：pipeline 名副本（下一步指向 pipeline 而非 skill）→ CONTRADICTS', () => {
  const dir = makeFixture({
    'skills/develop/x/SKILL.md': '# 输出\n\n下一步：执行 writeback pipeline\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(r.stdout.includes('R9') && r.stdout.includes('CONTRADICTS'), `应命中 pipeline 名: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R9 记述性豁免：CR 上下文域内无 skill id 的「下一步」行（标题/描述性）→ 不报', () => {
  const dir = makeFixture({
    'skills/develop/x/SKILL.md': '# 测试报告输出\n\n- 下一步建议\n\n摘要完成。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(!r.stdout.includes('R9'), `记述性「下一步」行不报: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── CR-2026-030 TASK-01：R7 权威 trigger 字面量校验（FR-9/AC-27~AC-29）──

test('R7 权威字面量：完整 NORMAL pair 通过；短 trigger → CONTRADICTS（AC-27）', () => {
  const dir = makeFixture({
    'skills/develop/review-dev-plan/SKILL.md': '# 推进\n\n调用 `crctl advance --to tech-design-reviewed --trigger "review-dev-plan:block -> write-dev-plan" --expect task-breakdown --embedded` 推进。\n',
    'skills/develop/x/SKILL.md': '# 推进\n\n调用 `crctl advance --to tech-design-reviewed --trigger review-dev-plan:block --expect task-breakdown --embedded` 推进。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(r.stdout.includes('skills/develop/x/SKILL.md') && r.stdout.includes('CONTRADICTS'), `短 trigger 应命中 R7: ${r.stdout}`);
    assert.ok(!r.stdout.includes('review-dev-plan/SKILL.md'), '完整 pair 不报');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R7：trigger 存在但 to 不匹配 → CONTRADICTS（AC-27）', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 推进\n\n调用 `crctl advance --to developing --trigger "review-dev-plan:block -> write-dev-plan" --expect task-breakdown --embedded` 推进。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(r.stdout.includes('CONTRADICTS'), `to 错配应命中: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R7：to/trigger 含模板变量 → 跳过 literal 校验（AC-29）', () => {
  const dir = makeFixture({
    'skills/x/SKILL.md': '# 推进\n\n调用 `crctl advance --to {to_status} --trigger {trigger} --expect {current}` 推进。\n\n# 混合\n\n调用 `crctl advance --to tech-design-reviewed --trigger "{trigger}" --embedded` 推进。\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.ok(!r.stdout.includes('CONTRADICTS'), `模板变量应跳过: ${r.stdout}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R7：LF/CRLF 输入等价（AC-28）', () => {
  const skillBody = '# 推进\n\n调用 `crctl advance --to tech-design-reviewed --trigger review-dev-plan:block --embedded` 推进。\n';
  const lfDir = makeFixture({ 'skills/x/SKILL.md': skillBody });
  const crlfDir = makeFixture({});
  try {
    const p = path.join(crlfDir, 'skills', 'x', 'SKILL.md');
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, skillBody.replaceAll('\n', '\r\n'));
    writeFileSync(path.join(crlfDir, 'dir-graph.yaml'), MINI_DIR_GRAPH.replaceAll('\n', '\r\n'));
    const rl = runLint(['--mode', 'report', '--root', lfDir]);
    const rc = runLint(['--mode', 'report', '--root', crlfDir]);
    assert.ok(rl.stdout.includes('CONTRADICTS'), `LF 应命中: ${rl.stdout}`);
    assert.ok(rc.stdout.includes('CONTRADICTS'), `CRLF 应命中: ${rc.stdout}`);
    assert.equal(
      rc.stdout.split('\n').filter((l) => l.includes('CONTRADICTS')).length,
      rl.stdout.split('\n').filter((l) => l.includes('CONTRADICTS')).length,
      'LF/CRLF 命中数一致',
    );
  } finally { rmSync(lfDir, { recursive: true, force: true }); rmSync(crlfDir, { recursive: true, force: true }); }
});

// transitions 缺失/空/畸形/截断 → STATE_MACHINE_PARSE_FAILED（AC-28）
const BROKEN_DIR_GRAPHS = {
  missing: 'change-request-track:\n  state_machine:\n    field: "status"\n',
  empty: 'change-request-track:\n  state_machine:\n    transitions:\n',
  malformed: 'change-request-track:\n  state_machine:\n    transitions:\n      - { from: x }\n',
  truncated: 'change-request-track:\n  state_machine:\n    transitions:\n      - { from: task-breakdown, to: tech-design-reviewed, trigger: "review-dev-plan',
};

test('R7 transitions duplicate → STATE_MACHINE_PARSE_FAILED 非零退出（AC-28）', () => {
  const transition = '      - { from: task-breakdown, to: tech-design-reviewed, trigger: "review-dev-plan:block -> write-dev-plan" }';
  const dir = makeFixture({
    'dir-graph.yaml': `change-request-track:\n  state_machine:\n    transitions:\n${transition}\n    transitions:\n${transition}\n`,
    'skills/x/SKILL.md': '# t\n\ncrctl advance --to X --trigger Y\n',
  });
  try {
    const r = runLint(['--mode', 'report', '--root', dir]);
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.stderr.includes('STATE_MACHINE_PARSE_FAILED'), r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
for (const [name, dg] of Object.entries(BROKEN_DIR_GRAPHS)) {
  test(`R7 transitions ${name} → STATE_MACHINE_PARSE_FAILED 非零退出（AC-28）`, () => {
    const dir = makeFixture({
      'dir-graph.yaml': dg,
      'skills/x/SKILL.md': '# t\n\ncrctl advance --to X --trigger Y\n',
    });
    try {
      const r = runLint(['--mode', 'report', '--root', dir]);
      assert.equal(r.status, 1, `${name}: ${r.stdout}`);
      assert.ok(r.stderr.includes('STATE_MACHINE_PARSE_FAILED'), `${name}: ${r.stderr}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

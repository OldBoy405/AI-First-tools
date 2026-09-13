// CR-2026-039 TASK-05：review canonical 文本契约收敛扫描测试（node --test，零依赖）。
// AC-1：三个 CR Pipeline JSON 与清单内 11 个 SKILL.md 对 repair-instructions/fixed-blockers/
//       suggestion_policy/suggestion-policy 零命中；可执行回修说明并入 blocker 文本（SDD §4.5）。
// AC-2：三个 Pipeline 的 reviewLoop 结构（repairNodeId/repairRef/replayNodes/passCondition/maxAttempts）
//       与修订前逐字段一致（结构快照断言）。
// AC-3：canonical 落盘行为零变化——由 crctl.test.mjs 既有 review-record schema 用例覆盖，本文件不重复。
//
// 白名单（显式不在扫描断言范围，归实施 CR 5）：
//   - pipeline-templates/product-planning.pipeline.json 与 skills/planning/*（无 CR 上下文，独立合同）
//   - agents/*.md 与 README 中的残留引用
//   - skills/shared/crctl/scripts/test/*（测试文件本身含被扫描字符串作为模式）
//
// 运行：node --test skills/shared/crctl/scripts/test/contract-scan.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const FORBIDDEN = ['repair-instructions', 'fixed-blockers', 'suggestion_policy', 'suggestion-policy'];

const PIPELINES = [
  'pipeline-templates/requirement-authoring.pipeline.json',
  'pipeline-templates/architecture-design.pipeline.json',
  'pipeline-templates/code-implementation.pipeline.json',
];

const SKILLS = [
  'skills/requirement/write-requirement-prd/SKILL.md',
  'skills/requirement/review-requirement/SKILL.md',
  'skills/develop/write-tech-design/SKILL.md',
  'skills/develop/review-tech-design/SKILL.md',
  'skills/develop/write-dev-plan/SKILL.md',
  'skills/develop/write-dev-tasks/SKILL.md',
  'skills/develop/review-dev-plan/SKILL.md',
  'skills/develop/implement-code/SKILL.md',
  'skills/develop/review-code/SKILL.md',
  'skills/develop/write-test-report/SKILL.md',
  'skills/develop/coding-discipline/SKILL.md',
];

test('AC-1: 三个 CR Pipeline 与 11 个 SKILL.md 对废弃 canonical 字段零命中', () => {
  for (const rel of [...PIPELINES, ...SKILLS]) {
    const text = readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8').replaceAll('\r\n', '\n');
    for (const w of FORBIDDEN) {
      assert.ok(!text.includes(w), `${rel} 不得含 "${w}"`);
    }
  }
});

test('AC-2a: requirement-authoring reviewLoop 结构快照不变', () => {
  const p = JSON.parse(readFileSync(path.join(ROOT, 'pipeline-templates', 'requirement-authoring.pipeline.json'), 'utf8'));
  const n = p.nodes.find((x) => x.ref === 'review-requirement');
  assert.deepEqual(
    { repairNodeId: n.reviewLoop.repairNodeId, repairRef: n.reviewLoop.repairRef, maxAttempts: n.reviewLoop.maxAttempts, passCondition: n.reviewLoop.passCondition },
    {
      repairNodeId: '00000000-0000-0000-0011-000000000002', repairRef: 'write-requirement-prd', maxAttempts: 3,
      passCondition: { allOf: [{ path: 'verdict', equals: 'pass' }, { path: 'blockers', isEmpty: true }] },
    },
  );
});

test('AC-2b: architecture-design reviewLoop 结构快照不变', () => {
  const p = JSON.parse(readFileSync(path.join(ROOT, 'pipeline-templates', 'architecture-design.pipeline.json'), 'utf8'));
  const n = p.nodes.find((x) => x.ref === 'review-tech-design');
  assert.deepEqual(
    { repairNodeId: n.reviewLoop.repairNodeId, repairRef: n.reviewLoop.repairRef, maxAttempts: n.reviewLoop.maxAttempts, passCondition: n.reviewLoop.passCondition },
    {
      repairNodeId: '00000000-0000-0000-0016-000000000001', repairRef: 'write-tech-design', maxAttempts: 3,
      passCondition: { allOf: [{ path: 'verdict', equals: 'pass' }, { path: 'blockers', isEmpty: true }] },
    },
  );
});

test('AC-2c: code-implementation review-code reviewLoop 结构快照（CR-2026-043：replayNodes 插入 workspace-freshness 基线重核）', () => {
  const p = JSON.parse(readFileSync(path.join(ROOT, 'pipeline-templates', 'code-implementation.pipeline.json'), 'utf8'));
  const n = p.nodes.find((x) => x.ref === 'review-code');
  assert.equal(n.reviewLoop.repairNodeId, '00000000-0000-0000-0015-000000000006');
  assert.equal(n.reviewLoop.repairRef, 'implement-code');
  assert.equal(n.reviewLoop.replayPolicy, 'rerun-listed-nodes-in-order');
  assert.equal(n.reviewLoop.maxAttempts, 3);
  assert.deepEqual(n.reviewLoop.replayNodes.map((r) => r.ref), ['implement-code', 'write-test-report', 'push-progress', 'workspace-freshness', 'review-code']);
  assert.deepEqual(n.reviewLoop.passCondition, {
    allOf: [
      { path: 'verdict', equals: 'pass' },
      { path: 'blockers', isEmpty: true },
      { path: 'test-report.status', equals: 'pass' },
    ],
  });
});

test('AC-1 补充：三个 Pipeline JSON 可解析（prompt 修订未破坏 JSON 结构）', () => {
  for (const rel of PIPELINES) {
    const p = JSON.parse(readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8'));
    assert.ok(Array.isArray(p.nodes) && p.nodes.length > 0, `${rel} 节点非空`);
  }
});

/* ─────────── CR-2026-041 FR-06/FR-07：退役静态扫描 ─────────── */

const RETIRED = ['change-impact-analysis', 'feedback-writeback', 'feedback-writeback-done'];
const ACTIVE_PATHS = [
  'skills/_index.yml',
  'agent-skill-matrix.yml',
  'AGENT-SKILL-MATRIX.md',
  'agents/_index.yml',
  'agents/quality-reviewer-agent.md',
  'README.md',
  'docs/QODER-使用指南.md',
  'openwiki/architecture/agent-skill-matrix.md',
  'dir-graph.yaml',
  'skills/review/review-alignment/SKILL.md',
  'skills/cr/inbox-emit/SKILL.md',
];

test('CR-2026-041 FR-06/07：active 路径零退役 Skill 引用', () => {
  for (const rel of ACTIVE_PATHS) {
    const text = readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8').replaceAll('\r\n', '\n');
    for (const w of RETIRED) {
      assert.ok(!text.includes(w), `${rel} 不得含 "${w}"`);
    }
  }
});

test('CR-2026-041 FR-06/07：退役 Skill 目录已删除（历史快照除外）', () => {
  assert.ok(!existsSync(path.join(ROOT, 'skills', 'review', 'change-impact-analysis', 'SKILL.md')), 'change-impact-analysis SKILL 已删除');
  assert.ok(!existsSync(path.join(ROOT, 'skills', 'cr', 'feedback-writeback', 'SKILL.md')), 'feedback-writeback SKILL 已删除');
});

/* ═══════════ CR-2026-065 TASK-03（FR-11 / FR-12 / FR-14 / FR-17）：suite-gate 静态断言 + 解析自测 + 归属自测 ═══════════ */

const SUITE_GATE = path.join(ROOT, 'skills', 'shared', 'crctl', 'scripts', 'test', 'suite-gate.mjs');
const REGISTRY_REL = 'skills/shared/crctl/scripts/test/gate-registry.json';
const WRITE_APIS = ['writeFileSync', 'appendFileSync', 'rmSync', 'renameSync', 'truncateSync', 'unlinkSync'];

function walkByExt(dir, ext, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkByExt(p, ext, out);
    else if (entry.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** 自测用临时 tools-root（os.tmpdir()，测试结束即删；不入仓、不新增仓库 fixture 目录）。 */
function makeProbeRoot(files, cases) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cr-2026-065-suite-gate-'));
  const dir = path.join(root, 'skills', 'shared', 'crctl', 'scripts', 'test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'gate-registry.json'), JSON.stringify({
    schema: 'crctl-suite-gate/v1',
    manifest: { files: [...files].sort(), cases },
    stateMachine: { namedStates: ['a'], wildcards: {}, transitions: [{ from: 'a', to: 'a', trigger: 't' }] },
    exceptions: [],
  }, null, 2) + '\n', 'utf8');
  for (const f of files) writeFileSync(path.join(dir, f), '// CR-2026-065 自测占位（--report 形态不执行本文件）\n', 'utf8');
  return root;
}

/** stdout 报告 JSON：与人类摘要同流，按花括号配平（含字符串感知）截取第一段完整 JSON。 */
function parseGateReport(stdout) {
  const text = String(stdout).replaceAll('\r\n', '\n');
  const start = text.indexOf('{');
  assert.ok(start >= 0, 'suite-gate stdout 未输出报告 JSON');
  let depth = 0; let end = -1; let inStr = false; let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > start, 'suite-gate stdout 报告 JSON 不完整');
  return JSON.parse(text.slice(start, end + 1));
}

function runGateReport(records, root) {
  const ndjson = path.join(root, 'probe.ndjson');
  writeFileSync(ndjson, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const r = spawnSync(process.execPath, [SUITE_GATE, '--report', ndjson, '--cwd', root], { encoding: 'utf8', shell: false });
  return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr), report: parseGateReport(r.stdout) };
}

const tapOf = (verdict, name) => [
  'TAP version 13',
  `# Subtest: ${name}`,
  `${verdict} 1 - ${name}`,
  '  ---',
  '  duration_ms: 0.1',
  "  type: 'test'",
  '  ...',
  '1..1',
  '# tests 1',
  '# pass 1',
  '# fail 0',
  '',
].join('\n');

const checkOf = (report, code) => report.checks.find((c) => c.code === code);

// 四查之一（权限与写入边界）：登记面只读 + suite-gate 自身无受治理写路径。
test('CR-2026-065 静态断言：gate-registry.json 在仓库内零写路径（唯一写入口 = 人工编辑 + git commit）', () => {
  const scanned = walkByExt(path.join(ROOT, 'skills'), '.mjs');
  assert.ok(scanned.length > 20, `扫描面非空（实际 ${scanned.length} 个 .mjs）`);
  // 自排除：本文件按设计在 os.tmpdir() 写自测用登记面**副本**（非仓库登记面）；
  // 其自身的写路径由下方 suite-gate 断言与人工评审覆盖。
  const SELF = path.resolve(fileURLToPath(import.meta.url));
  let hits = 0;
  for (const abs of scanned) {
    if (path.resolve(abs) === SELF) continue;
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const lines = readFileSync(abs, 'utf8').replaceAll('\r\n', '\n').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('gate-registry.json')) return;
      hits += 1;
      // 同语句行 + 前后 2 行窗口：不得出现任何写 API（防跨行写入调用）。
      const window = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
      for (const api of WRITE_APIS) {
        assert.ok(!line.includes(api), `${rel}:${i + 1} 不得对登记面使用写 API ${api}`);
        assert.ok(!window.includes(api), `${rel}:${i + 1} 邻近行不得对登记面使用写 API ${api}`);
      }
    });
  }
  assert.ok(hits > 0, '登记面消费点必须存在（零命中 = 断言面失焦）');

  const gate = readFileSync(SUITE_GATE, 'utf8').replaceAll('\r\n', '\n');
  const writeCalls = gate.match(/writeFileSync\(/g) ?? [];
  assert.equal(writeCalls.length, 2, 'suite-gate.mjs 只允许两处写：--report-out（NDJSON）与 --json-out（报告）');
  for (const line of gate.split('\n')) {
    if (!WRITE_APIS.some((api) => line.includes(api))) continue;
    for (const forbidden of ['gate-registry', 'change-requests', '_backlog.yml', '_index.yml', 'approval.yml', 'task done']) {
      assert.ok(!line.includes(forbidden), `suite-gate.mjs 的写路径不得触碰 ${forbidden}：${line.trim()}`);
    }
  }
  // 门禁只做判定：台账名与治理写入口整体零命中（读面用不到它们）。
  for (const forbidden of ['_backlog.yml', 'approval.yml', 'change-requests']) {
    assert.ok(!gate.includes(forbidden), `suite-gate.mjs 不得引用受治理账本 ${forbidden}`);
  }
});

// 解析自测①：合法单文件片段判绿（--report 形态，判定函数与 --run 同源）。
test('CR-2026-065 解析自测：合法单文件 TAP 片段判绿且归属与用例数正确', () => {
  const root = makeProbeRoot(['probe.test.mjs'], { 'probe.test.mjs': 1 });
  try {
    const { status, report } = runGateReport([{ file: 'probe.test.mjs', exit_code: 0, converged: true, tap: tapOf('ok', 'alpha') }], root);
    assert.equal(status, 0, '合法片段必须退出 0');
    assert.equal(report.verdict, 'pass');
    assert.equal(report.files.length, 1);
    assert.equal(report.files[0].file, 'probe.test.mjs');
    assert.equal(report.files[0].cases, 1, '每文件用例数 = 该文件顶层 plan');
    assert.equal(report.files[0].state, 'ok');
    assert.deepEqual(report.failures, []);
    assert.equal(report.checks.filter((c) => !c.ok).length, 0, '合法片段不得有任何未通过 check');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 解析自测②③④：三类畸形片段各自落 SUITE_REPORT_UNPARSEABLE 且退出非零（硬失败，禁止降级为空结果）。
const MALFORMED = [
  ['无顶层 plan', ['TAP version 13', '# Subtest: alpha', 'ok 1 - alpha', ''].join('\n')],
  ['plan 与顶层结果行数矛盾', ['TAP version 13', '# Subtest: alpha', 'ok 1 - alpha', '1..2', ''].join('\n')],
  ['缩进栈不成对（Subtest 块未闭合）', ['TAP version 13', '# Subtest: alpha', 'ok 1 - alpha', '# Subtest: beta', '1..2', ''].join('\n')],
];
for (const [label, tap] of MALFORMED) {
  test(`CR-2026-065 解析自测：${label} → SUITE_REPORT_UNPARSEABLE 且退出非零`, () => {
    const root = makeProbeRoot(['probe.test.mjs'], { 'probe.test.mjs': 1 });
    try {
      const { status, report } = runGateReport([{ file: 'probe.test.mjs', exit_code: 0, converged: true, tap }], root);
      assert.notEqual(status, 0, '不可判输入必须硬失败（禁止静默降级为零失败）');
      assert.equal(report.verdict, 'block');
      const check = checkOf(report, 'SUITE_REPORT_UNPARSEABLE');
      assert.ok(check && check.ok === false, `必须落 SUITE_REPORT_UNPARSEABLE（${label}）`);
      assert.equal(report.files[0].cases, null, '不可判时不得给出用例数');
      assert.equal(report.cases_executed, null, '不可判时不得给出 cases_executed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// 解析自测⑤（实战回归，N-1 注入期发现）：诊断块内部缩进的 `...`（Node 对长输出打印的省略行）
// 不得被误判为「缩进栈不成对」；开启行的同缩进 `...` 才是结束标记。
test('CR-2026-065 解析自测：诊断块内缩进 ... 不得误判为缩进栈不成对（回归）', () => {
  const root = makeProbeRoot(['probe.test.mjs'], { 'probe.test.mjs': 1 });
  const tap = [
    'TAP version 13',
    '# Subtest: long-output case',
    'not ok 1 - long-output case',
    '  ---',
    '  duration_ms: 1.2',
    '  error: |-',
    '    Expected values to be strictly deep-equal:',
    '    ...',
    '    ... Skipped lines',
    '    ...',
    '  ...',
    '1..1',
    '',
  ].join('\n');
  try {
    const { status, report } = runGateReport([{ file: 'probe.test.mjs', exit_code: 1, converged: true, tap }], root);
    assert.notEqual(status, 0, '用例级失败必须红');
    assert.equal(checkOf(report, 'SUITE_REPORT_UNPARSEABLE').ok, true, '诊断块内缩进 ... 不得触发 SUITE_REPORT_UNPARSEABLE');
    assert.equal(checkOf(report, 'SUITE_FAILURES_UNREGISTERED').ok, false, '未登记失败必须落 SUITE_FAILURES_UNREGISTERED');
    assert.equal(report.files[0].cases, 1);
    assert.equal(report.files[0].state, 'failed');
    assert.deepEqual(report.failures, ['long-output case']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 归属自测（I1 机械证据）：同名用例、不同 file → 各自归属，且与 spawn 构造一致（不来自报告文本）。
test('CR-2026-065 归属自测：同一用例名在两个 file 上各自归属、失败集合不串台', () => {
  const files = ['a.test.mjs', 'b.test.mjs'];
  const root = makeProbeRoot(files, { 'a.test.mjs': 1, 'b.test.mjs': 1 });
  try {
    const same = 'CR-2026-065 shared-case';
    const { report } = runGateReport([
      { file: 'a.test.mjs', exit_code: 0, converged: true, tap: tapOf('ok', same) },
      { file: 'b.test.mjs', exit_code: 1, converged: true, tap: tapOf('not ok', same) },
    ], root);
    const byFile = new Map(report.files.map((f) => [f.file, f]));
    assert.deepEqual(byFile.get('a.test.mjs').failures, [], 'a.test.mjs 不得被 b.test.mjs 的失败污染');
    assert.deepEqual(byFile.get('b.test.mjs').failures, [same], '失败必须归属到 b.test.mjs');
    assert.equal(byFile.get('a.test.mjs').state, 'ok');
    assert.equal(byFile.get('b.test.mjs').state, 'failed');
    assert.deepEqual(report.failures, [same], '全局失败集合按名去重');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// cmd-01 stdout 禁词自测（J-8）：独立词 skipped / # skip / no tests to run 一律不得出现。
test('CR-2026-065 禁词自测：stdout 报告与人类摘要不含冻结 skip 模式', () => {
  const root = makeProbeRoot(['probe.test.mjs'], { 'probe.test.mjs': 1 });
  try {
    const { stdout } = runGateReport([{ file: 'probe.test.mjs', exit_code: 0, converged: true, tap: tapOf('ok', 'alpha') }], root);
    for (const re of [/(^|\n)# skip\b/i, /(^|\n)ok \d+ # skip\b/i, /\bskipped:\s*[1-9]\d*/i, /\bSKIPPED\b/i, /\bno tests to run\b/i]) {
      assert.ok(!re.test(stdout), `stdout 命中冻结 skip 模式 ${re}（会被 crctl 判成 skip 态）`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

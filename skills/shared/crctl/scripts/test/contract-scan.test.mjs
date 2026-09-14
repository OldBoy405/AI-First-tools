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
// CR-2026-064 TASK-04：索引一致性断言的 YAML 子集解析器（与 crctl 同源，禁止复刻解析器）
import { parseYaml } from '../lib/yaml-subset.mjs';

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

test('AC-2c: code-implementation review-code reviewLoop 结构快照（CR-2026-043 插入 workspace-freshness；CR-2026-066 收敛掉 push-progress 项）', () => {
  const p = JSON.parse(readFileSync(path.join(ROOT, 'pipeline-templates', 'code-implementation.pipeline.json'), 'utf8'));
  const n = p.nodes.find((x) => x.ref === 'review-code');
  assert.equal(n.reviewLoop.repairNodeId, '00000000-0000-0000-0015-000000000006');
  assert.equal(n.reviewLoop.repairRef, 'implement-code');
  assert.equal(n.reviewLoop.replayPolicy, 'rerun-listed-nodes-in-order');
  assert.equal(n.reviewLoop.maxAttempts, 3);
  assert.deepEqual(n.reviewLoop.replayNodes.map((r) => r.ref), ['implement-code', 'write-test-report', 'workspace-freshness', 'review-code']);
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

/** 自测用临时 tools-root（os.tmpdir()，测试结束即删；不入仓、不新增仓库 fixture 目录）。
 *  `exceptions` 为登记面条目（默认显式空数组）；非空用于 AC-12 / FR-14 的例外判定面自测。 */
function makeProbeRoot(files, cases, exceptions = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cr-2026-065-suite-gate-'));
  const dir = path.join(root, 'skills', 'shared', 'crctl', 'scripts', 'test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'gate-registry.json'), JSON.stringify({
    schema: 'crctl-suite-gate/v1',
    manifest: { files: [...files].sort(), cases },
    stateMachine: { namedStates: ['a'], wildcards: {}, transitions: [{ from: 'a', to: 'a', trigger: 't' }] },
    exceptions: [...exceptions],
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

/* ─────────── AC-12 / FR-14「错误闭包」：到期即红 + 不得自证绿 ───────────
   交付证据集（cmd-01）以 `exceptions=[]` 判绿，只证明「无例外时退出码 ≡ 失败集合为空」；
   FR-14.3「到期未清即红」与 FR-14.4「例外标识与实际失败集合不匹配即红」只有在登记面非空时才可观测。
   下列用例复用既有 probe-root + `--report` 机制：登记面副本写在 os.tmpdir()，不触碰仓库登记面
   （仓库登记面的零写路径由上方静态断言覆盖）。 */

// 错误闭包①（FR-14.3）：字段齐备、expires 已过（带时区偏移）→ EXCEPTION_EXPIRED + 非零退出；
// 不得因「已登记」而静默判绿或静默续期。
test('CR-2026-065 例外治理自测：到期未清的例外 → EXCEPTION_EXPIRED 且退出非零', () => {
  const expired = {
    id: 'CR-2026-065-SELFTEST-EXPIRED',
    kind: 'suite-failure',
    reason: '自测构造：到期例外',
    owner: 'Ray',
    expires: '2020-01-01T00:00:00+08:00',
    match: 'alpha',
  };
  const root = makeProbeRoot(['probe.test.mjs'], { 'probe.test.mjs': 1 }, [expired]);
  try {
    const { status, report } = runGateReport([{ file: 'probe.test.mjs', exit_code: 0, converged: true, tap: tapOf('ok', 'alpha') }], root);
    assert.notEqual(status, 0, '到期未清必须退出非零（到期即红）');
    assert.equal(report.verdict, 'block');
    assert.equal(checkOf(report, 'EXCEPTION_EXPIRED').ok, false, '必须落 EXCEPTION_EXPIRED');
    assert.equal(report.registry.exceptions_count, 1, '登记条数如实计入报告');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 错误闭包②（FR-14.4）：未到期例外登记的失败名在本次运行中未出现 → EXCEPTION_NOT_OBSERVED + 非零退出。
// 绿侧 check 不得被牵连（本用例同时钉住「未登记失败」与「陈旧例外」两个判定面互不串台）。
test('CR-2026-065 例外治理自测：例外标识未匹配本次失败集合 → EXCEPTION_NOT_OBSERVED 且退出非零', () => {
  const stale = {
    id: 'CR-2026-065-SELFTEST-STALE',
    kind: 'suite-failure',
    reason: '自测构造：未观测例外',
    owner: 'Ray',
    expires: '2999-12-31T23:59:59Z',
    match: 'CR-2026-065 never-observed case',
  };
  const root = makeProbeRoot(['probe.test.mjs'], { 'probe.test.mjs': 1 }, [stale]);
  try {
    const { status, report } = runGateReport([{ file: 'probe.test.mjs', exit_code: 0, converged: true, tap: tapOf('ok', 'alpha') }], root);
    assert.notEqual(status, 0, '未观测的例外必须退出非零（不得自证绿）');
    assert.equal(report.verdict, 'block');
    assert.equal(checkOf(report, 'EXCEPTION_NOT_OBSERVED').ok, false, '必须落 EXCEPTION_NOT_OBSERVED');
    assert.equal(checkOf(report, 'SUITE_FAILURES_UNREGISTERED').ok, true, '本次无未登记失败，该 check 应保持 ok');
    assert.equal(report.registry.exceptions_count, 1, '登记条数如实计入报告');
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

/* ═══════════ CR-2026-064 TASK-04（FR-11 / SDD §4.4）：恢复字段名退役的整树扫描 ═══════════
   分名分范围（§4.4-1）：上方 FORBIDDEN / RETIRED / ACTIVE_PATHS 三项（CR-2026-041 面）逐字不动；
   本段只覆盖两个恢复字段名（RETIRED_RECOVERY），扫描面 = 整树派生 + 两项精确路径排除。
   活跃性由「是否被显式排除」定义，不由目录 / 扩展名 / 文件名推断（D-5）。 */

const RETIRED_RECOVERY = ['recoverCommand', 'recover_command'];
const SKIP_DIRS = ['.git', 'node_modules'];
const SCANNER_REL = 'skills/shared/crctl/scripts/test/contract-scan.test.mjs';
const HISTORICAL_REL = 'skills/shared/crctl/scripts/test/fixtures/traceability-191k.yml';
const EXCLUDED = [SCANNER_REL, HISTORICAL_REL];
const FIXTURES_DIR = 'skills/shared/crctl/scripts/test/fixtures/';

/** 整树枚举（唯一枚举规则，§4.4-2）：只按**路径段**跳过 .git / node_modules；
 *  返回仓库根相对 POSIX 路径、升序（失败信息可复现）。目录枚举为空 → 硬失败（禁止静默降级）。 */
function enumerateWorktreeAt(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isDirectory()) continue;
    const abs = path.join(entry.parentPath ?? entry.path, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (rel.split('/').some((seg) => SKIP_DIRS.includes(seg))) continue;
    out.push(rel);
  }
  if (out.length === 0) throw new Error(`整树枚举为空（root=${root}）——扫描面不可判，硬失败`);
  return out.sort();
}

const ENUMERATED = enumerateWorktreeAt(ROOT);
const SCAN_SURFACE = ENUMERATED.filter((rel) => !EXCLUDED.includes(rel));

/** 纯谓词（§4.4-4）：先 CRLF→LF 规范化，再大小写敏感 includes。 */
function retiredHits(text, names) {
  return names.some((n) => String(text).replaceAll('\r\n', '\n').includes(n));
}

function readInRoot(root, rel) { return readFileSync(path.join(root, ...rel.split('/')), 'utf8'); }

function scanScopeWith(files, names, contentsOf) {
  return files.filter((rel) => retiredHits(contentsOf(rel), names)).sort();
}

function scanScope(files, names) { return scanScopeWith(files, names, (rel) => readInRoot(ROOT, rel)); }

/** 索引 active 条目（§4.4-2 硬失败面）：数组缺失 / 空 / 0 条 active 一律硬失败。
 *  路径归一：`./x` 相对索引所在目录；`tools/...` 相对 workspace 根（去前缀）。 */
function normIndexPath(rel, p) {
  const s = String(p).replace(/^\.\//, '');
  if (s.startsWith('tools/')) return path.posix.normalize(s.slice('tools/'.length));
  return path.posix.normalize(path.posix.join(path.posix.dirname(rel), s));
}

function activeIndexPathsAt(root, rel, key) {
  const doc = parseYaml(readInRoot(root, rel).replaceAll('\r\n', '\n'));
  const list = doc && doc[key];
  if (!Array.isArray(list)) throw new Error(`${rel} 缺 ${key} 数组（硬失败）`);
  if (list.length === 0) throw new Error(`${rel} 的 ${key} 为空（硬失败）`);
  const active = list.filter((e) => e && e.status === 'active').map((e) => String(e.path || ''));
  if (active.length === 0) throw new Error(`${rel} 解析出 0 条 active（硬失败，禁止静默降级）`);
  return active.map((p) => normIndexPath(rel, p));
}

const INDEX_KEYS = [['skills/_index.yml', 'skills'], ['agents/_index.yml', 'agents'], ['pipeline-templates/_index.yml', 'pipeline-templates']];

/** 八条派生根代表性路径（§4.4-4 表）——覆盖 crctl 源码/适配器 hook/requirement-register 生产与测试/
 *  writeback 生产与测试/pipeline-templates/活跃提示词/活跃测试向量，证明范围非恒真。 */
const REPRESENTATIVE_PATHS = [
  'skills/shared/crctl/scripts/lib/workspace-transactions.mjs',
  'skills/shared/crctl/adapters/claude-code/hooks/pretooluse-guard.mjs',
  'skills/requirement/requirement-register/scripts/promotion-bind.mjs',
  'skills/requirement/requirement-register/scripts/test/promotion-bind.test.mjs',
  'skills/writeback/scripts/writeback-prd-sdd.mjs',
  'skills/writeback/scripts/test/writeback.test.mjs',
  'pipeline-templates/emit-registry.mjs',
  'skills/cr/cr-archive/SKILL.md',
  'agents/delivery-agent.md',
  'skills/shared/crctl/scripts/test/fixtures/digest-vectors/expected.json',
  'skills/shared/crctl/scripts/test/fixtures/digest-vectors/review-annotations-code.yml',
  'skills/shared/crctl/scripts/test/fixtures/digest-vectors/test-report.md',
];

test('CR-2026-064 FR-11 结构断言①：三个 active 索引条目全部存在且在扫描面内；Pipeline 索引 ≡ 目录枚举', () => {
  const counts = [];
  for (const [rel, key] of INDEX_KEYS) {
    const active = activeIndexPathsAt(ROOT, rel, key);
    counts.push(`${key}=${active.length}`);
    for (const p of active) {
      assert.ok(p && !p.startsWith('..'), `${rel}: active path 归一化越界: ${p}`);
      assert.ok(ENUMERATED.includes(p), `${rel}: active 条目不在枚举面内（缺失或落在跳过边界内）: ${p}`);
      assert.ok(!EXCLUDED.includes(p), `${rel}: active 条目落在排除项内: ${p}`);
      assert.ok(SCAN_SURFACE.includes(p), `${rel}: active 条目不在扫描面内: ${p}`);
    }
  }
  const pipelineActive = activeIndexPathsAt(ROOT, 'pipeline-templates/_index.yml', 'pipeline-templates').sort();
  const diskPipelines = readdirSync(path.join(ROOT, 'pipeline-templates'))
    .filter((f) => f.endsWith('.pipeline.json'))
    .map((f) => `pipeline-templates/${f}`).sort();
  assert.deepEqual(pipelineActive, diskPipelines, 'Pipeline 索引 active 集合 ≠ 目录枚举集合（硬失败）');
  assert.ok(SCAN_SURFACE.length > 20, `扫描面规模（报告值）：枚举 ${ENUMERATED.length} / 面 ${SCAN_SURFACE.length} / ${counts.join(' ')}`);
});

test('CR-2026-064 FR-11 结构断言②：八条派生根代表性路径全部在扫描面内', () => {
  for (const rel of REPRESENTATIVE_PATHS) {
    assert.ok(ENUMERATED.includes(rel), `代表性路径不在枚举面内: ${rel}`);
    assert.ok(SCAN_SURFACE.includes(rel), `代表性路径不在扫描面内: ${rel}`);
  }
});

test('CR-2026-064 FR-11 结构断言③：排除面被冻结为两条精确路径（无通配）且枚举边界只含 .git/node_modules', () => {
  assert.deepEqual(EXCLUDED, [
    'skills/shared/crctl/scripts/test/contract-scan.test.mjs',
    'skills/shared/crctl/scripts/test/fixtures/traceability-191k.yml',
  ], '排除项必须恰为两条精确路径（新增排除必须改本断言并被评审看见）');
  assert.deepEqual(SKIP_DIRS, ['.git', 'node_modules'], '枚举边界必须恰为 .git 与 node_modules');
  for (const rel of EXCLUDED) {
    assert.ok(!rel.includes('*') && !rel.includes('?'), `排除项不得含通配: ${rel}`);
    assert.ok(ENUMERATED.includes(rel), `排除项必须存在于磁盘（否则排除无意义）: ${rel}`);
  }
  // fixtures/ 下未被排除的文件（本 HEAD 3 个 digest 向量）全部在面内 —— 新增 fixture 默认入面
  const fixtures = SCAN_SURFACE.filter((rel) => rel.startsWith(FIXTURES_DIR));
  assert.deepEqual(fixtures, [
    'skills/shared/crctl/scripts/test/fixtures/digest-vectors/expected.json',
    'skills/shared/crctl/scripts/test/fixtures/digest-vectors/review-annotations-code.yml',
    'skills/shared/crctl/scripts/test/fixtures/digest-vectors/test-report.md',
  ], 'fixtures/ 下除历史 traceability 精确路径外的文件必须全部在扫描面内');
});

test('CR-2026-064 FR-11 零命中断言：整树扫描面对两个恢复字段名零命中', () => {
  const hits = scanScope(SCAN_SURFACE, RETIRED_RECOVERY);
  assert.deepEqual(hits, [], `扫描面命中（任一未列目录/扩展名的活跃文件回流旧名即失败）：${hits.join(', ')}`);
});

test('CR-2026-064 FR-11 命中即失败：八条派生根代表路径对合成行判为命中（范围非恒真）', () => {
  const synthetic = `// ${RETIRED_RECOVERY[0]} legacy reference（自测合成行）\n`;
  for (const rel of REPRESENTATIVE_PATHS) {
    const withHole = scanScopeWith([rel], RETIRED_RECOVERY, (r) => readInRoot(ROOT, r) + synthetic);
    assert.deepEqual(withHole, [rel], `合成行未被判为命中（扫描面失焦）: ${rel}`);
    const clean = scanScopeWith([rel], RETIRED_RECOVERY, (r) => readInRoot(ROOT, r));
    assert.deepEqual(clean, [], `真实文本已含旧名（迁移未完成）: ${rel}`);
  }
  for (const name of RETIRED_RECOVERY) {
    assert.ok(retiredHits(`x ${name} y`, RETIRED_RECOVERY), `谓词必须对 ${name} 命中`);
    assert.ok(retiredHits(`x ${name.toUpperCase()} y`, RETIRED_RECOVERY) === false, '判定必须大小写敏感');
  }
});

test('CR-2026-064 FR-11 允许排除不误报：唯一被排除的夹具仍含旧名，同目录其余向量在面内且零命中', () => {
  assert.ok(retiredHits(readInRoot(ROOT, HISTORICAL_REL), RETIRED_RECOVERY), '被排除的历史 traceability 必须仍含旧名（排除依据）');
  assert.ok(!SCAN_SURFACE.includes(HISTORICAL_REL), '被排除的夹具不得出现在扫描面内');
  assert.ok(ENUMERATED.includes(HISTORICAL_REL), '被排除的夹具必须真实存在于磁盘');
  const digestVectors = REPRESENTATIVE_PATHS.filter((rel) => rel.includes('/fixtures/digest-vectors/'));
  assert.equal(digestVectors.length, 3, '活动测试向量恰 3 个');
  assert.deepEqual(scanScope(digestVectors, RETIRED_RECOVERY), [], '活动测试向量必须零命中且在面内');
  assert.ok(retiredHits(readInRoot(ROOT, SCANNER_REL), RETIRED_RECOVERY), '扫描器自身含退役名单（排除依据）');
  assert.ok(!SCAN_SURFACE.includes(SCANNER_REL), '扫描器自身不得出现在扫描面内');
});

test('CR-2026-064 FR-11 硬失败面：空枚举 / 全 deprecated 索引 / 缺索引数组一律抛错（禁止静默降级）', () => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'cr-2026-064-scan-probe-'));
  try {
    assert.throws(() => enumerateWorktreeAt(probe), /整树枚举为空/, '空目录枚举必须硬失败');
    mkdirSync(path.join(probe, 'skills'), { recursive: true });
    writeFileSync(path.join(probe, 'skills', '_index.yml'), 'skills:\n  - id: a\n    path: ./a/SKILL.md\n    status: deprecated\n', 'utf8');
    assert.throws(() => activeIndexPathsAt(probe, 'skills/_index.yml', 'skills'), /0 条 active/, '全 deprecated 索引必须硬失败');
    writeFileSync(path.join(probe, 'skills', '_index.yml'), 'skills:\n  - id: a\n    path: ./a/SKILL.md\n', 'utf8');
    assert.throws(() => activeIndexPathsAt(probe, 'skills/_index.yml', 'skills'), /0 条 active/, '缺 status 条目不计 active，仍须硬失败');
    writeFileSync(path.join(probe, 'skills', '_index.yml'), 'not-skills: []\n', 'utf8');
    assert.throws(() => activeIndexPathsAt(probe, 'skills/_index.yml', 'skills'), /缺 skills 数组/, '缺索引数组必须硬失败');
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

/* CR-2026-064 FR-12（AC-04，SDD §4.5-6）：shell 逃逸守卫 —— 代码消费者一律 argv 边界执行。 */
const SHELL_ESCAPE_TOKENS = ['shell: true', 'shell:true', 'Invoke-Expression'];
const LIB_DIR = 'skills/shared/crctl/scripts/lib/';

test('CR-2026-064 FR-12（AC-04）：crctl.mjs 与 lib/*.mjs 对 shell 逃逸零命中，且既有 argv 先例存在', () => {
  const guardFiles = ['skills/shared/crctl/scripts/crctl.mjs', ...SCAN_SURFACE.filter((rel) => rel.startsWith(LIB_DIR) && rel.endsWith('.mjs'))];
  assert.ok(guardFiles.length >= 5, `守卫面非空（实际 ${guardFiles.length}）`);
  let shellFalse = 0;
  for (const rel of guardFiles) {
    const text = readInRoot(ROOT, rel);
    for (const token of SHELL_ESCAPE_TOKENS) {
      assert.ok(!text.includes(token), `${rel} 不得含 shell 逃逸 ${token}（恢复动作不得降级为字符串执行）`);
    }
    shellFalse += (text.match(/shell: *false/g) ?? []).length;
  }
  assert.ok(shellFalse >= 1, `必须存在 argv 执行的既有先例（spawnSync(..., { shell: false })），实际 ${shellFalse}`);
});

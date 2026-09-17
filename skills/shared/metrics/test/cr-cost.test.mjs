// FR-8 回归面（CR-2026-069 TASK-01 / TASK-10，SDD §3.6 / §4.7 / §4.8）。
// 运行：node --test --test-reporter=dot skills/shared/metrics/test/cr-cost.test.mjs
//
// 覆盖：insufficient-sample 终态、14 天窗口判定、>=20% ∧ 三护栏判定、costSource=unavailable ⇒ k=null、
//       A8 贪心集合（正例/反例）、verify-selection 注册表相等/不等两向。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  bucketOf,
  canonicalCrctlCommand,
  deriveReport,
  deriveThresholds,
  emptyAccumulator,
  evaluateAfter,
  isProjectable,
  parseWindow,
} from '../scripts/lib/aggregate.mjs';
import { compareSelection, coverageShare, selectMinimalCommandSet } from '../scripts/lib/select.mjs';
import { renderAfter, renderSummary } from '../scripts/lib/render.mjs';
import { CR_ID_PATTERN, findCrId, normalizeText } from '../scripts/lib/sessions.mjs';

const HERE = import.meta.dirname;
const TOOLS_ROOT = path.resolve(HERE, '..', '..', '..', '..');

const report = (over) => ({
  window: 'all',
  sampleCRs: 4,
  coverage: { pi: 'full' },
  providerUsage: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
  toolResultTokens: 4000,
  k: 0.001,
  metrics: { tokensPerCR: 1000, sessionsPerCR: 1, searchTokenRatio: 0, fullReadRatio: 0, bootstrapTokensPerSession: 0 },
  guardrails: { firstPassGateRate: 0.5, reviewLoopsPerCR: 2, reviewDefectsPerCR: 1 },
  crctlCommands: [],
  tokenEstimator: 'chars-div-4-v1',
  costSource: 'pi-session-usage',
  observedAt: '2026-09-17T00:00:00Z',
  rule: 'r',
  ...over,
});

test('cc-01 窗口判定：14d 合法、其它 N d 与非法串各有确定语义（非法即抛错，不静默降级）', () => {
  assert.deepEqual(parseWindow('14d'), { kind: 'days', days: 14, label: '14d' });
  assert.equal(parseWindow('7d').days, 7);
  assert.deepEqual(parseWindow('all'), { kind: 'all', label: 'all' });
  const r = parseWindow('2026-09-01..2026-09-15');
  assert.equal(r.kind, 'range');
  assert.equal(r.from, '2026-09-01');
  assert.throws(() => parseWindow('14'), /非法 window/);
  assert.throws(() => parseWindow('d14'), /非法 window/);
});

test('cc-02 insufficient-sample：样本不足是终态，不产出成本结论', () => {
  const base = report();
  const empty = evaluateAfter(base, report({ sampleCRs: 0 }), { minCRs: 1 });
  assert.equal(empty.status, 'insufficient-sample');
  assert.deepEqual(empty.checks, []);
  const missing = evaluateAfter(null, report({ sampleCRs: 9 }), { minCRs: 1 });
  assert.equal(missing.status, 'insufficient-sample');
  const belowMin = evaluateAfter(base, report({ sampleCRs: 2 }), { minCRs: 5 });
  assert.equal(belowMin.status, 'insufficient-sample');
  assert.match(belowMin.reason, /最小样本/);
});

test('cc-03 扩项判定：>=20% 下降 ∧ 三护栏不恶化 才 target-met（四条判据逐条可见）', () => {
  const base = report();
  const good = evaluateAfter(base, report({ metrics: { ...base.metrics, tokensPerCR: 700 } }), { minCRs: 1 });
  assert.equal(good.status, 'target-met');
  assert.equal(good.checks.length, 4);
  assert.ok(good.checks.every((c) => c.ok));

  const shallow = evaluateAfter(base, report({ metrics: { ...base.metrics, tokensPerCR: 900 } }), { minCRs: 1 });
  assert.equal(shallow.status, 'no-improvement');
  assert.equal(shallow.checks.find((c) => c.id === 'tokens-drop-20pct').ok, false);

  const worseGate = evaluateAfter(base, report({
    metrics: { ...base.metrics, tokensPerCR: 500 },
    guardrails: { ...base.guardrails, firstPassGateRate: 0.1 },
  }), { minCRs: 1 });
  assert.equal(worseGate.status, 'no-improvement');
  assert.equal(worseGate.checks.find((c) => c.id === 'guardrail-firstPassGateRate').ok, false);

  const moreLoops = evaluateAfter(base, report({
    metrics: { ...base.metrics, tokensPerCR: 500 },
    guardrails: { ...base.guardrails, reviewLoopsPerCR: 9 },
  }), { minCRs: 1 });
  assert.equal(moreLoops.status, 'no-improvement');

  const moreDefects = evaluateAfter(base, report({
    metrics: { ...base.metrics, tokensPerCR: 500 },
    guardrails: { ...base.guardrails, reviewDefectsPerCR: 9 },
  }), { minCRs: 1 });
  assert.equal(moreDefects.status, 'no-improvement');
});

test('cc-04 costSource=unavailable ⇒ k=null（且报告不含任何金额宣称）', () => {
  const acc = emptyAccumulator();
  acc.sessions = 1;
  acc.crIds.add('CR-2026-901');
  acc.toolResultTokens = 1000;
  acc.resultCount = 3;
  acc.bootstrapSamples = 1;
  acc.bootstrapTokens = 100;
  const r = deriveReport(acc, { window: 'all', roots: ['x'], coverage: { pi: 'unavailable' }, observedAt: 't' });
  assert.equal(r.costSource, 'unavailable');
  assert.equal(r.k, null);
  assert.ok(!/amount|金额/.test(JSON.stringify(r)));
  acc.cost = { total: 2, observed: true };
  const r2 = deriveReport(acc, { window: 'all', roots: ['x'], coverage: { pi: 'full' }, observedAt: 't' });
  assert.equal(r2.costSource, 'pi-session-usage');
  assert.equal(r2.k, 0.002);
});

test('cc-05 A8 贪心集合：tokens 降序 + 字典序 tie-break + 累计 >= 80% 的最小基数前缀', () => {
  const rows = [
    { command: 'crctl status', tokens: 60, calls: 1 },
    { command: 'crctl advance', tokens: 20, calls: 1 },
    { command: 'crctl next', tokens: 20, calls: 1 },
    { command: 'crctl task done', tokens: 5, calls: 1 },
  ];
  assert.deepEqual(selectMinimalCommandSet(rows, 0.8), ['crctl advance', 'crctl next', 'crctl status']);
  const share = coverageShare(rows, ['crctl advance', 'crctl next', 'crctl status']);
  assert.ok(share >= 0.8 && share <= 1, '前三级必须达到 80% 份额');

  const tie = [
    { command: 'crctl b', tokens: 10, calls: 1 },
    { command: 'crctl a', tokens: 10, calls: 1 },
  ];
  assert.deepEqual(selectMinimalCommandSet(tie, 0.8), ['crctl a', 'crctl b']);
  assert.deepEqual(selectMinimalCommandSet([], 0.8), []);
  assert.deepEqual(selectMinimalCommandSet([{ command: 'x', tokens: 0, calls: 1 }], 0.8), []);
  // 反例：份额不足 80% 时必须多取一项
  const five = Array.from({ length: 5 }, (_, i) => ({ command: 'crctl c' + String(i), tokens: 10, calls: 1 }));
  assert.equal(selectMinimalCommandSet(five, 0.8).length, 4);
});

test('cc-06 verify-selection 判据：注册表与最小集合双向全等，不等即 fail', () => {
  const minimal = ['crctl advance', 'crctl status'];
  assert.deepEqual(compareSelection(['crctl status', 'crctl advance'], minimal), {
    registryKeys: minimal,
    minimalSet: minimal,
    equal: true,
  });
  const bad = compareSelection(['crctl status'], minimal);
  assert.equal(bad.equal, false);
  const extra = compareSelection(['crctl status', 'crctl advance', 'crctl next'], minimal);
  assert.equal(extra.equal, false);
  const missing = compareSelection([], minimal);
  assert.equal(missing.equal, false);
});

test('cc-07 thresholds 由实测分布产出五个正整数（代码内零样本常量）', () => {
  const samples = Array.from({ length: 10 }, (_, i) => ({ tokens: (i + 1) * 10, lines: (i + 1) * 2, hits: (i + 1) * 3, bucket: 'search' }));
  const th = deriveThresholds(samples);
  for (const k of ['resultTokensCap', 'lineWindow', 'maxHits', 'headLines', 'tailLines']) {
    assert.ok(Number.isInteger(th[k]) && th[k] > 0, k + ' 非正整数: ' + String(th[k]));
  }
  const empty = deriveThresholds([]);
  for (const k of Object.keys(empty)) assert.ok(Number.isInteger(empty[k]) && empty[k] > 0, '空样本也必须给正整数（硬失败替代静默 0）');
  const src = fs.readFileSync(path.join(TOOLS_ROOT, 'skills/shared/metrics/scripts/lib/aggregate.mjs'), 'utf8');
  assert.ok(!/\b672\b/.test(src) && !/\b585\b/.test(src), 'aggregate.mjs 出现硬编码样本常量');
});

test('cc-08 crctl 命令口径：只认行首调用、子命令规范化、不可投影命令不进候选集', () => {
  assert.equal(canonicalCrctlCommand('node "x/crctl.mjs" status CR-1 --workspace .'), 'crctl status');
  assert.equal(canonicalCrctlCommand('crctl workspace inspect CR-1'), 'crctl workspace inspect');
  assert.equal(canonicalCrctlCommand('crctl git diff --name-only abc'), 'crctl git diff');
  assert.equal(canonicalCrctlCommand('grep -c "crctl not" f'), null);
  assert.equal(canonicalCrctlCommand('echo hi'), null);
  assert.equal(isProjectable('crctl git diff'), false);
  assert.equal(isProjectable('crctl help'), false);
  assert.equal(isProjectable('crctl status'), true);
});

test('cc-09 CR-ID 识别与桶归类使用固定正则/固定命令族（随输出可复现）', () => {
  assert.equal(findCrId('see CR-2026-069 now'), 'CR-2026-069');
  assert.equal(findCrId('no id here'), null);
  assert.equal(new RegExp(CR_ID_PATTERN).test('CR-2026-012'), true);
  assert.equal(bucketOf('bash', 'grep -rn x .'), 'search');
  assert.equal(bucketOf('bash', 'find . -name x'), 'list');
  assert.equal(bucketOf('bash', 'cat f'), 'read');
  assert.equal(bucketOf('bash', 'crctl status CR-1'), 'crctl');
  assert.equal(bucketOf('read', ''), 'read');
});

test('cc-10 EOL 归一与渲染：报告与人读摘要是同一对象（不写第二份产物）', () => {
  assert.equal(normalizeText('a\r\nb'), 'a\nb');
  const r = report({ crctlCommands: [{ command: 'crctl status', tokens: 10, calls: 1 }] });
  const text = renderSummary(r);
  assert.ok(text.includes('crctl status'));
  assert.ok(text.includes('tokenEstimator=chars-div-4-v1'));
  assert.ok(renderAfter({ status: 'target-met', reason: 'x', checks: [{ id: 'i', ok: true, detail: 1 }] }).includes('target-met'));
});

test('cc-11 参数面：四个子命令的 CLI 契约字符串在 cr-cost.mjs 中齐备（逐字，不新增平行开关）', () => {
  const src = fs.readFileSync(path.join(TOOLS_ROOT, 'skills/shared/metrics/scripts/cr-cost.mjs'), 'utf8');
  for (const token of ['baseline', 'after', 'replay', 'verify-selection', '--out', '--window', '--policy', '--baseline', 'insufficient-sample', 'tokenEstimator']) {
    assert.ok(src.includes(token), 'cr-cost.mjs 缺 ' + token);
  }
  assert.ok(src.includes('--sessions-root'), 'cr-cost.mjs 缺 --sessions-root');
});

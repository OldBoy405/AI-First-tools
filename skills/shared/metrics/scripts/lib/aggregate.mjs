// FR-8 聚合与派生（CR-2026-069 TASK-01，SDD §4.7）。
//
// 口径义务（SDD-CLOSE-08）：每个计数字段都随输出携带 observedAt 与 rule；
// 样本数不硬编码（代码内零样本常量）；本文件只做纯计算，不做 IO（IO 在 sessions.mjs / cr-cost.mjs）。
//
// token 估算口径复用 output-guard/core.mjs 的唯一实现（AC-2：不复制算法）。
//
// 命令候选口径：FR-2 的杠杆点是单一成功出口 ok(obj)，因此 `crctl git *`（git 原始流透传）与
// `crctl help`（HELP 文本）不进候选集——它们不经 ok()，无法被投影。该口径随输出写入 rule 字段。
export const NON_PROJECTABLE_PREFIX = 'crctl git';
export const NON_PROJECTABLE = ['crctl help'];

export function isProjectable(command) {
  if (command === NON_PROJECTABLE_PREFIX) return false;
  if (command.indexOf(NON_PROJECTABLE_PREFIX + ' ') === 0) return false;
  return NON_PROJECTABLE.indexOf(command) < 0;
}

import {
  TOKEN_ESTIMATOR_ID,
  estimateTokens,
  parseEscapeHatch,
  normalizeText,
} from '../../../../../output-guard/core.mjs';
import { CR_ID_PATTERN, findCrId, toolResultText } from './sessions.mjs';

export const TOKEN_ESTIMATOR = TOKEN_ESTIMATOR_ID;
export const COST_SOURCES = ['pi-session-usage', 'external-invoice', 'unavailable'];
export const COVERAGE_LEVELS = ['full', 'partial', 'unavailable'];

const CRCTL_CMD_RE = /^(?:(?:node|node\.exe)\s+(?:"[^"]*crctl\.mjs"|'[^']*crctl\.mjs'|\S*crctl\.mjs)\s+|(?:\.\/)?crctl(?:\.mjs)?\s+)([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** 从一条已执行的 shell 命令中取出 crctl 调用行（只认行首，避免把散文当成命令）。 */
function crctlLine(commandText) {
  for (const rawLine of normalizeText(commandText).split('\n')) {
    let line = rawLine.trim().replace(/^[&;]+\s*/, '');
    while (ENV_ASSIGN_RE.test(line)) line = line.replace(ENV_ASSIGN_RE, '').trim();
    line = line.replace(/^sudo\s+/, '').replace(/^"([^"]*)"\s+/, '$1 ').replace(/^'([^']*)'\s+/, '$1 ');
    if (CRCTL_CMD_RE.test(line)) return line;
  }
  return null;
}

/** crctl 命令的规范形态：`crctl <sub> [<sub2>]`（参数与路径不进键）。 */
export function canonicalCrctlCommand(commandText) {
  const line = crctlLine(commandText);
  if (!line) return null;
  const m = CRCTL_CMD_RE.exec(line);
  const sub = m[1].toLowerCase();
  const sub2 = m[2] ? m[2].toLowerCase() : null;
  if (sub === 'git' && sub2) return 'crctl git ' + sub2;
  if (sub === 'task' && sub2) return 'crctl task ' + sub2;
  if (sub === 'workspace' && sub2) return 'crctl workspace ' + sub2;
  if (sub === 'merge' && sub2 === 'status') return 'crctl merge status';
  return 'crctl ' + sub;
}

/** 工具族分桶（搜索 / 列举 / 打印 / crctl 输出 / 其它）。 */
export function bucketOf(toolName, commandText) {
  const cmd = normalizeText(commandText);
  if (crctlLine(cmd)) return 'crctl';
  const shape = cmd.split('\n')[0].trim();
  for (const mark of SHELL_MARKERS) {
    if (shape.indexOf(mark) >= 0) return 'other';
  }
  const word = (shape.split(/\s+/).filter(Boolean)[0] || '').split(/[\\/]/).pop().toLowerCase();
  if (['grep', 'rg'].includes(word)) return 'search';
  if (['find', 'get-childitem', 'ls', 'dir', 'fd'].includes(word)) return 'list';
  if (['cat', 'get-content', 'type', 'head', 'tail'].includes(word)) return 'read';
  if (toolName === 'read' || toolName === 'Read') return 'read';
  return 'other';
}

/** 一次采样后的原始累计（只读、无状态）。 */
export function emptyAccumulator() {
  return {
    sessions: 0,
    malformedLines: 0,
    unreadableFiles: 0,
    crIds: new Set(),
    usage: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
    cost: { total: 0, observed: false },
    toolResultTokens: 0,
    resultCount: 0,
    buckets: { search: 0, list: 0, read: 0, crctl: 0, other: 0 },
    crctlCalls: new Map(),
    reviewRecordCalls: 0,
    attemptBumps: 0,
    approvals: 0,
    readTokens: 0,
    readTokensList: [],
    bootstrapTokens: 0,
    bootstrapSamples: 0,
    samples: [],
  };
}

/**
 * 把一批已读 session 记录并入累计器。
 * @param {ReturnType<typeof emptyAccumulator>} acc
 * @param {Array<{path: string, records: object[], malformedLines: number, unreadable: boolean}>} sessions
 */
export function accumulate(acc, sessions) {
  for (const s of sessions) {
    if (s.unreadable) { acc.unreadableFiles += 1; continue; }
    acc.sessions += 1;
    acc.malformedLines += s.malformedLines;
    const callArgs = new Map();
    const crIdsHere = new Set();
    let toolResultsHere = 0;
    let firstResults = 0;
    for (const rec of s.records) {
      if (!rec || rec.type !== 'message' || !rec.message) continue;
      const m = rec.message;
      if (m.role === 'assistant') {
        if (m.usage && typeof m.usage === 'object') {
          acc.usage.input += Number(m.usage.input) || 0;
          acc.usage.cachedInput += Number(m.usage.cacheRead) || 0;
          acc.usage.cacheWrite += Number(m.usage.cacheWrite) || 0;
          acc.usage.output += Number(m.usage.output) || 0;
        }
        if (m.usage && m.usage.cost && typeof m.usage.cost.total === 'number') {
          acc.cost.total += m.usage.cost.total;
          acc.cost.observed = true;
        }
        const parts = Array.isArray(m.content) ? m.content : [];
        for (const c of parts) {
          if (c && c.type === 'toolCall' && c.id) {
            const args = typeof c.arguments === 'object' && c.arguments !== null ? c.arguments : {};
            callArgs.set(c.id, args);
            const cmdText = args.command === undefined ? '' : String(args.command);
            const canonical = canonicalCrctlCommand(cmdText);
            const canon = canonical && isProjectable(canonical) ? canonical : null;
            if (canon) {
              const row = acc.crctlCalls.get(canon) || { command: canon, calls: 0, tokens: 0 };
              row.calls += 1;
              acc.crctlCalls.set(canon, row);
              acc.reviewRecordCalls += canon === 'crctl review-record' ? 1 : 0;
              acc.attemptBumps += /--bump-attempt/.test(cmdText) ? 1 : 0;
              acc.approvals += canon === 'crctl approve' ? 1 : 0;
            }
          }
        }
        continue;
      }
      if (m.role === 'toolResult') {
        const text = toolResultText(m);
        const tokens = estimateTokens(text);
        acc.toolResultTokens += tokens;
        acc.resultCount += 1;
        toolResultsHere += 1;
        if (firstResults < 5) { acc.bootstrapTokens += tokens; firstResults += 1; }
        const args = callArgs.get(m.toolCallId) || {};
        const bucket = bucketOf(m.toolName, args.command === undefined ? '' : args.command);
        acc.buckets[bucket] += tokens;
        if (bucket === 'read') {
          acc.readTokens += tokens;
          acc.readTokensList.push(tokens);
        }
        const lines = text.split('\n').length;
        const hits = text.split('\n').filter((l) => /^[^\s:]+:\d+:/.test(l)).length;
        acc.samples.push({ tokens, lines, hits, bucket });
        const canon = canonicalCrctlCommand(args.command === undefined ? '' : args.command);
        if (canon && acc.crctlCalls.has(canon)) acc.crctlCalls.get(canon).tokens += tokens;
        const withId = toolResultText(m) + ' ' + JSON.stringify(m.details === undefined ? {} : m.details);
        const id = findCrId(withId);
        if (id) crIdsHere.add(id);
      }
    }
    if (toolResultsHere > 0) acc.bootstrapSamples += 1;
    for (const id of crIdsHere) acc.crIds.add(id);
    const tail = s.records.map((r) => (r && r.type === 'message' ? JSON.stringify(r.message).slice(0, 400) : '')).join(' ');
    const head = findCrId(tail);
    if (head) acc.crIds.add(head);
  }
  return acc;
}

const SHELL_MARKERS = ['|', '>', '<', ';', '&&', '`', '$('];

const quantile = (values, q) => {
  const xs = values.filter((v) => Number.isFinite(v) && v > 0).slice().sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1));
  return xs[idx];
};

/** 由实测分布产出五个正整数阈值（TASK-01 的另一项下游产出，写入 policy.json 由 TASK-02 承担）。 */
export function deriveThresholds(samples) {
  const rows = Array.isArray(samples) ? samples : [];
  const resultTokens = rows.map((x) => x.tokens);
  const lines = rows.map((x) => x.lines);
  const hits = rows.filter((x) => x.hits > 0).map((x) => x.hits);
  const cap = Math.max(1, Math.round(quantile(resultTokens, 0.9)));
  const window = Math.max(1, Math.round(quantile(lines, 0.9)));
  const maxHits = Math.max(1, Math.round(quantile(hits, 0.9)));
  const head = Math.max(1, Math.round(quantile(lines, 0.5)));
  const tail = Math.max(1, Math.round(quantile(lines, 0.25)));
  return { resultTokensCap: cap, lineWindow: window, maxHits, headLines: head, tailLines: tail };
}

/**
 * fullReadRatio = 超过 resultTokensCap 的读取结果 token 占全部读取 token 的比例。
 * capTokens 由调用方从 policy.json#thresholds 传入（唯一数值源，本文件内零阈值常量）。
 */
export function fullReadRatio(acc, opts) {
  const cap = opts && Number.isInteger(opts.capTokens) ? opts.capTokens : 0;
  if (cap <= 0 || acc.readTokens <= 0) return 0;
  const over = acc.readTokensList.filter((t) => t > cap).reduce((s, t) => s + t, 0);
  return Number((over / acc.readTokens).toFixed(6));
}

/** 由累计器派生固定字段集（供 baseline / after 共用）。 */
export function deriveReport(acc, opts) {
  const observedAt = opts.observedAt;
  const sampleCRs = acc.crIds.size;
  const sessions = acc.sessions || 1;
  const crs = sampleCRs || 1;
  const totalResultTokens = acc.toolResultTokens;
  const costSource = acc.cost.observed ? 'pi-session-usage' : 'unavailable';
  const k = costSource === 'unavailable' || totalResultTokens <= 0
    ? null
    : Number((acc.cost.total / totalResultTokens).toFixed(12));
  const crctlCommands = [...acc.crctlCalls.values()]
    .map((x) => ({ command: x.command, tokens: x.tokens, calls: x.calls }))
    .filter((x) => x.tokens > 0)
    .sort((a, b) => (b.tokens - a.tokens !== 0 ? b.tokens - a.tokens : a.command < b.command ? -1 : 1));
  return {
    window: opts.window,
    sampleCRs,
    coverage: opts.coverage,
    providerUsage: {
      input: acc.usage.input,
      cachedInput: acc.usage.cachedInput,
      cacheWrite: acc.usage.cacheWrite,
      output: acc.usage.output,
    },
    toolResultTokens: totalResultTokens,
    k,
    metrics: {
      tokensPerCR: Number((totalResultTokens / crs).toFixed(2)),
      sessionsPerCR: Number((acc.sessions / crs).toFixed(4)),
      searchTokenRatio: totalResultTokens > 0 ? Number((acc.buckets.search / totalResultTokens).toFixed(6)) : 0,
      fullReadRatio: fullReadRatio(acc, opts),
      bootstrapTokensPerSession: acc.bootstrapSamples > 0
        ? Number((acc.bootstrapTokens / acc.bootstrapSamples).toFixed(2))
        : 0,
    },
    guardrails: {
      firstPassGateRate: crs > 0 ? Number((1 - Math.min(1, acc.attemptBumps / crs)).toFixed(6)) : 0,
      reviewLoopsPerCR: Number((acc.reviewRecordCalls / crs).toFixed(4)),
      reviewDefectsPerCR: Number((acc.attemptBumps / crs).toFixed(4)),
    },
    crctlCommands,
    tokenEstimator: TOKEN_ESTIMATOR,
    costSource,
    observedAt,
    rule:
      'roots=' + (opts.roots || []).join(',') + ' ; files=*.jsonl ; window=' + opts.window +
      ' ; crId=' + CR_ID_PATTERN + ' ; candidates=ok() 出口命令（排除 ' + NON_PROJECTABLE_PREFIX + '* 与 crctl help）' +
      ' ; costSource=' + costSource + ' ; estimator=' + TOKEN_ESTIMATOR,
    counters: {
      sessions: acc.sessions,
      results: acc.resultCount,
      malformedLines: acc.malformedLines,
      unreadableFiles: acc.unreadableFiles,
      buckets: acc.buckets,
    },
  };
}

/** 窗口判定：`14d` / `N d` / `<iso>..<iso>`。不合法即抛错（硬失败，不静默降级）。 */
export function parseWindow(spec) {
  const text = String(spec === undefined || spec === null ? '' : spec).trim();
  const dm = /^([1-9][0-9]*)d$/.exec(text);
  if (dm) return { kind: 'days', days: Number(dm[1]), label: text };
  const rm = /^(.+)\.\.(.+)$/.exec(text);
  if (rm) return { kind: 'range', from: rm[1].trim(), to: rm[2].trim(), label: text };
  if (text === 'all') return { kind: 'all', label: text };
  throw new Error('非法 window: ' + text + '（期望 <from>..<to> 或 <N>d）');
}

/**
 * `after` 的扩项判定（FR-8 第 5 项）——纯函数，样本不足是终态之一。
 * 判据：目标桶 tokens/CR 下降 >= 20% 且三项护栏均不恶化；样本不足 => insufficient-sample。
 */
export function evaluateAfter(baseline, observed, opts) {
  const minCRs = opts && Number.isInteger(opts.minCRs) ? opts.minCRs : 1;
  const before = baseline && baseline.metrics ? baseline.metrics : null;
  const after = observed && observed.metrics ? observed.metrics : null;
  if (!before || !after) return { status: 'insufficient-sample', reason: '缺少基线或观测指标', checks: [] };
  if (!observed || observed.sampleCRs < minCRs) {
    return {
      status: 'insufficient-sample',
      reason: '窗口内完整覆盖样本 ' + String(observed ? observed.sampleCRs : 0) + ' < 最小样本 ' + String(minCRs),
      checks: [],
    };
  }
  const drop = before.tokensPerCR > 0 ? 1 - after.tokensPerCR / before.tokensPerCR : 0;
  const g0 = baseline.guardrails || {};
  const g1 = observed.guardrails || {};
  const checks = [
    { id: 'tokens-drop-20pct', ok: drop >= 0.2, detail: Number(drop.toFixed(6)) },
    { id: 'guardrail-firstPassGateRate', ok: g1.firstPassGateRate >= g0.firstPassGateRate, detail: g1.firstPassGateRate },
    { id: 'guardrail-reviewLoopsPerCR', ok: g1.reviewLoopsPerCR <= g0.reviewLoopsPerCR, detail: g1.reviewLoopsPerCR },
    { id: 'guardrail-reviewDefectsPerCR', ok: g1.reviewDefectsPerCR <= g0.reviewDefectsPerCR, detail: g1.reviewDefectsPerCR },
  ];
  const ok = checks.every((c) => c.ok);
  return {
    status: ok ? 'target-met' : 'no-improvement',
    reason: ok ? '目标桶 tokens/CR 下降 >= 20% 且三项护栏均未恶化' : '未同时满足下降 20% 与三项护栏不恶化',
    checks,
  };
}

/** 逃生阀抽检（AC-9：合法调用零误伤）。 */
export function escapedCalls(sessionTexts, policy) {
  const out = { sampled: 0, escaped: 0, malformedMarkers: 0 };
  for (const text of sessionTexts) {
    const first = normalizeText(text).split('\n')[0];
    if (first.indexOf('output-guard') < 0) continue;
    out.sampled += 1;
    const res = parseEscapeHatch(first, policy);
    if (res.state === 'valid') out.escaped += 1;
    else out.malformedMarkers += 1;
  }
  return out;
}

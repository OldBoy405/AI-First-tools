#!/usr/bin/env node
// FR-8 离线度量 CLI（CR-2026-069 TASK-01 / TASK-10，SDD §3.6 / §4.7 / §4.8）。
//
// 子命令（契约逐字）：
//   baseline --out <path> [--sessions-root <dir>]... [--window <from>..<to>]
//   after    --out <path> --window 14d [--baseline <path>] [--min-crs <n>]
//   replay   --policy <path> [--sessions-root <dir>]...
//   verify-selection --baseline <path> [--out <path>]
//
// 纪律：只读三仓与 session 目录；唯一写面是调用方显式指定的 --out。
//       机器结果只有一份 JSON，人读摘要由同一对象渲染（不写第二份产物文件）。
//       本脚本不推进 CR、不参与门禁、不写状态与账本。
//       所有读入先 \r\n -> \n 归一；读空 / 过短 / 解析失败 / 比对不一致一律非零退出。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { estimateTokens, parsePolicy } from '../../../../output-guard/core.mjs';
import {
  accumulate,
  deriveReport,
  deriveThresholds,
  emptyAccumulator,
  evaluateAfter,
  parseWindow,
} from './lib/aggregate.mjs';
import { defaultSessionRoots, listSessionFiles, readSession } from './lib/sessions.mjs';
import { renderAfter, renderSummary } from './lib/render.mjs';
import { compareSelection, coverageShare, selectMinimalCommandSet } from './lib/select.mjs';

const HERE = import.meta.dirname;
const TOOLS_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const PROJECTORS_PATH = path.join(TOOLS_ROOT, 'skills', 'shared', 'crctl', 'scripts', 'lib', 'summary-projectors.mjs');
const CAPABILITIES_PATH = path.join(TOOLS_ROOT, 'output-guard', 'capabilities.json');
const POLICY_PATH = path.join(TOOLS_ROOT, 'output-guard', 'policy.json');
const UNAVAILABLE_CODE = 'OUTPUT_GUARD_UNAVAILABLE';

function die(message, extra) {
  const payload = { error: { code: extra && extra.code ? extra.code : 'CR_COST_FAILED', message } };
  if (extra && extra.detail !== undefined) payload.error.detail = extra.detail;
  process.stderr.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(1);
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
  } catch (e) {
    die('文件不可读: ' + p + ' — ' + e.message);
  }
  return '';
}

const sha256LF = (text) => crypto.createHash('sha256').update(text.split('\r\n').join('\n'), 'utf8').digest('hex');

function parseFlags(argv) {
  const flags = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = flags[key] === undefined ? next : [].concat(flags[key], next);
        i++;
      } else flags[key] = true;
    } else flags.positional.push(a);
  }
  return flags;
}

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const nowIso = () => new Date().toISOString();
const loadCapabilitiesText = () => (fs.existsSync(CAPABILITIES_PATH) ? readText(CAPABILITIES_PATH) : undefined);

function loadCapabilities() {
  const text = loadCapabilitiesText();
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    die('capabilities.json 不可解析: ' + e.message);
  }
  return null;
}

/**
 * coverage 是派生投影（永不作为声明源），且只从**结构化观测通道**取值：
 *   ① 启动记录：命令含 `check-install.mjs` 的工具调用，其输出行形如
 *      `output-guard runtime=<rt> coverage=<lvl> policy=<ver>`（安装期检查的既定输出面）；
 *   ② 降级记录：工具结果正文出现完整的 `OUTPUT_GUARD_UNAVAILABLE runtime=<rt> reason=<四值枚举>`。
 * 不做自由文本扫描：规划文档里写的是占位符，不是运行时事实。
 */
function deriveCoverage(caps, sessions) {
  const coverage = {};
  const runtimes = (caps && caps.enableOrder) || [];
  const startup = new Map();
  const degradedSet = new Set();
  const bodyText = watchText(sessions);
  for (const rt of runtimes) {
    startup.set(rt, null);
    const re = new RegExp('OUTPUT_GUARD_UNAVAILABLE runtime=' + rt + ' reason=(ADAPTER_MISSING|DISABLED|BUNDLE_INVALID|POLICY_INVALID)');
    if (re.test(bodyText)) degradedSet.add(rt);
  }
  for (const s of sessions) {
    if (s.unreadable) continue;
    const byCall = new Map();
    for (const rec of s.records) {
      if (!rec || rec.type !== 'message' || !rec.message) continue;
      const m = rec.message;
      if (m.role === 'assistant') {
        const parts = Array.isArray(m.content) ? m.content : [];
        for (const c of parts) {
          if (c && c.type === 'toolCall' && c.id) {
            byCall.set(c.id, c.arguments && c.arguments.command !== undefined ? String(c.arguments.command) : '');
          }
        }
        continue;
      }
      if (m.role !== 'toolResult') continue;
      const cmd = byCall.get(m.toolCallId) || '';
      if (cmd.indexOf('check-install.mjs') < 0) continue;
      const lines = toolResultLines(m);
      for (const rt of runtimes) {
        const hit = lines.find((l) => l.trim().indexOf('output-guard runtime=' + rt + ' ') === 0);
        if (hit) startup.set(rt, hit.trim().split(' '));
      }
    }
  }
  for (const rt of runtimes) {
    const tokens = startup.get(rt);
    if (degradedSet.has(rt) || !tokens) { coverage[rt] = 'unavailable'; continue; }
    const level = String(tokens[2] || '').replace('coverage=', '');
    coverage[rt] = level === 'partial' ? 'partial' : level === 'full' ? 'full' : 'unavailable';
  }
  return coverage;
}

function toolResultLines(message) {
  const parts = Array.isArray(message.content) ? message.content : [];
  return parts.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n').split('\n');
}

/** 降级记录的扫描面：仅工具结果正文（不使用助手文本与规划文档）。 */
function watchText(sessions) {
  const chunks = [];
  for (const s of sessions) {
    if (s.unreadable) continue;
    for (const rec of s.records) {
      if (!rec || rec.type !== 'message' || !rec.message || rec.message.role !== 'toolResult') continue;
      chunks.push(toolResultLines(rec.message).join('\n'));
    }
  }
  return chunks.join('\n');
}

/** 历史 session 的离线回放（纯函数重算，不执行任何命令）。 */
function replaySummary(policy, sessions) {
  let results = 0;
  let overCap = 0;
  let overCapTokens = 0;
  for (const s of sessions) {
    if (s.unreadable) continue;
    for (const rec of s.records) {
      if (!rec || rec.type !== 'message' || !rec.message || rec.message.role !== 'toolResult') continue;
      const parts = Array.isArray(rec.message.content) ? rec.message.content : [];
      const body = parts.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
      results += 1;
      const tokens = estimateTokens(body);
      if (tokens > policy.thresholds.resultTokensCap) { overCap += 1; overCapTokens += tokens; }
    }
  }
  return { results, overCap, overCapTokens };
}

/** 只读收集：--window 的 range 形态按文件 mtime 过滤（解析失败硬失败）。 */
function collect(roots, win) {
  let fromMs = null;
  let toMs = null;
  if (win && win.kind === 'range') {
    fromMs = Date.parse(win.from);
    toMs = Date.parse(win.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      die('window range 不可解析: ' + win.label + '（期望 ISO 时间）');
    }
  }
  const out = [];
  for (const f of listSessionFiles(roots)) {
    if (!f.path) { out.push({ unreadable: true, records: [], malformedLines: 0 }); continue; }
    if (fromMs !== null) {
      let stat;
      try {
        stat = fs.statSync(f.path);
      } catch (e) {
        die('session 文件不可 stat: ' + f.path + ' — ' + e.message);
      }
      if (stat.mtimeMs < fromMs || stat.mtimeMs >= toMs) continue;
    }
    out.push(readSession(f));
  }
  if (out.length === 0) die('窗口内未枚举到任何 session 文件（硬失败，禁止按空集继续）');
  return out;
}

function cmdBaseline(flags) {
  const out = flags.out;
  if (typeof out !== 'string') die('baseline 需要 --out <path>');
  const explicitRoots = asList(flags['sessions-root']);
  const roots = explicitRoots.length > 0 ? explicitRoots : defaultSessionRoots();
  if (roots.length === 0) die('取不到 session 根目录（--sessions-root 与默认面均为空）');
  const win = parseWindow(flags.window === undefined ? 'all' : flags.window);
  const sessions = collect(roots, win.kind === 'range' ? win : null);
  const acc = accumulate(emptyAccumulator(), sessions);
  const thresholds = deriveThresholds(acc.samples);
  const caps = loadCapabilities();
  const report = deriveReport(acc, {
    window: win.label,
    roots,
    coverage: deriveCoverage(caps, sessions),
    observedAt: nowIso(),
    capTokens: thresholds.resultTokensCap,
  });
  report.thresholds = thresholds;
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(renderSummary(report) + '\n');
  process.stdout.write('derived thresholds=' + JSON.stringify(thresholds) + '\n');
  process.stdout.write('tokenEstimator=' + report.tokenEstimator + ' costSource=' + report.costSource + ' k=' + String(report.k) + '\n');
}

function cmdAfter(flags) {
  const out = flags.out;
  if (typeof out !== 'string') die('after 需要 --out <path>');
  const win = parseWindow(flags.window);
  if (win.kind !== 'days' || win.days !== 14) die('after 的窗口必须是 14d（FR-8 第 5 项）');
  const explicitRoots = asList(flags['sessions-root']);
  const roots = explicitRoots.length > 0 ? explicitRoots : defaultSessionRoots();
  const baselinePath = typeof flags.baseline === 'string'
    ? flags.baseline
    : path.join(path.dirname(path.resolve(out)), 'fr8-baseline.json');
  if (!fs.existsSync(baselinePath)) die('after 需要可比基线：' + baselinePath + ' 不存在（可用 --baseline 指定）');
  const baseline = JSON.parse(readText(baselinePath));
  const capTokens = baseline.thresholds && Number.isInteger(baseline.thresholds.resultTokensCap)
    ? baseline.thresholds.resultTokensCap
    : undefined;
  const sessions = collect(roots, null);
  const acc = accumulate(emptyAccumulator(), sessions);
  const observed = deriveReport(acc, {
    window: win.label,
    roots,
    coverage: deriveCoverage(loadCapabilities(), sessions),
    observedAt: nowIso(),
    capTokens,
  });
  const requested = Number(flags['min-crs']);
  const minCRs = Number.isInteger(requested) && requested > 0 ? requested : 1;
  const verdict = evaluateAfter(baseline, observed, { minCRs });
  const payload = { window: win.label, observedAt: observed.observedAt, baselinePath, observed, verdict };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), JSON.stringify(payload, null, 2) + '\n');
  process.stdout.write(renderAfter(verdict) + '\n');
  if (verdict.status === 'insufficient-sample') {
    process.stdout.write('（样本不足是终态之一：不产出成本结论、不延长本 CR）\n');
  }
}

function cmdReplay(flags) {
  if (typeof flags.policy !== 'string') die('replay 需要 --policy <path>');
  const policy = parsePolicy(readText(flags.policy));
  const explicitRoots = asList(flags['sessions-root']);
  const roots = explicitRoots.length > 0 ? explicitRoots : defaultSessionRoots();
  const sessions = collect(roots, null);
  const stats = replaySummary(policy, sessions);
  const overCapRatio = stats.results > 0 ? stats.overCap / stats.results : 0;
  process.stdout.write(JSON.stringify({
    policyVersion: policy.policyVersion,
    roots,
    observedAt: nowIso(),
    rule: 'toolResult tokens re-estimated offline under policy thresholds; no command is executed',
    stats: { ...stats, overCapRatio: Number(overCapRatio.toFixed(6)) },
  }, null, 2) + '\n');
}

async function cmdVerifySelection(flags) {
  if (typeof flags.baseline !== 'string') die('verify-selection 需要 --baseline <path>');
  const baselineText = readText(flags.baseline);
  if (baselineText.length < 50) die('baseline 读空或过短: ' + flags.baseline);
  let baseline;
  try {
    baseline = JSON.parse(baselineText);
  } catch (e) {
    die('baseline 不可解析: ' + e.message);
  }
  const rows = Array.isArray(baseline.crctlCommands) ? baseline.crctlCommands : [];
  if (rows.length === 0) die('baseline.crctlCommands 缺失或空（AC-10 核对不可判）');
  const minimalSet = selectMinimalCommandSet(rows, 0.8);
  let mod;
  try {
    mod = await import(pathToFileURL(PROJECTORS_PATH).href);
  } catch (e) {
    die('summary-projectors.mjs 载入失败（AC-10 不可判）: ' + e.message);
  }
  if (!mod || !mod.SUMMARY_PROJECTORS) die('SUMMARY_PROJECTORS 未导出（AC-10 不可判）');
  const cmp = compareSelection(Object.keys(mod.SUMMARY_PROJECTORS), minimalSet);
  const payload = {
    baselineSha256: sha256LF(baselineText),
    registryKeys: cmp.registryKeys,
    minimalSet: cmp.minimalSet,
    share: Number(coverageShare(rows, cmp.minimalSet).toFixed(6)),
    verdict: cmp.equal ? 'pass' : 'fail',
    observedAt: nowIso(),
    rule: 'tokens desc, tie-break command asc; greedy prefix until cumulative share >= 0.8',
  };
  if (typeof flags.out === 'string') {
    fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
    fs.writeFileSync(path.resolve(flags.out), JSON.stringify(payload, null, 2) + '\n');
  }
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  if (!cmp.equal) {
    die('注册表键集 != 基线最小集合', { code: 'SELECTION_MISMATCH', detail: cmp });
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (cmd === 'baseline') return cmdBaseline(flags);
  if (cmd === 'after') return cmdAfter(flags);
  if (cmd === 'replay') return cmdReplay(flags);
  if (cmd === 'verify-selection') return await cmdVerifySelection(flags);
  die('未知子命令: ' + String(cmd) + '（期望 baseline / after / replay / verify-selection）');
}

await main();

// OutputGuard Core — 纯函数层（CR-2026-069 TASK-02）。
//
// 责任边界（SDD §3.2）：
//   1. 本文件内不得出现任何阈值字面量：五个阈值一律来自入参 policy（AC-3 机械判据）；
//   2. 同一 (policyVersion, ruleId, runtime, toolName, 归一化入参, 归一化正文) 必须产生
//      逐字相同的 body 与 trailer（幂等，§4.4）；
//   3. 不读文件、不读环境变量、不调用子进程 —— policy / capabilities 的读取是 Adapter 的职责。
//
// 零第三方依赖：只用 node: 内建。

import { createHash } from 'node:crypto';

/** 阈值键名（唯一数值面在 policy.json#thresholds，本文件内零字面量）。 */
export const THRESHOLD_KEYS = ['resultTokensCap', 'lineWindow', 'maxHits', 'headLines', 'tailLines'];

/** token 估算口径标识（唯一实现；FR-8 侧复用，避免第二套估算器）。 */
export const TOKEN_ESTIMATOR_ID = 'chars-div-4-v1';

/** 终态闭包（不新增第六个取值，SDD §1.4.1）。 */
export const ACTIONS = ['block', 'rewrite', 'truncate', 'passthrough', 'unavailable'];

/** 降级码与 reason 四值闭包（SDD §3.8）。 */
export const UNAVAILABLE_CODE = 'OUTPUT_GUARD_UNAVAILABLE';
export const UNAVAILABLE_REASONS = ['ADAPTER_MISSING', 'DISABLED', 'BUNDLE_INVALID', 'POLICY_INVALID'];

export class PolicyParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyParseError';
  }
}

/** I9 唯一归一化入口：\r\n → \n。 */
export function normalizeText(s) {
  return String(s === null || s === undefined ? '' : s).split('\r\n').join('\n');
}

/** token 估计：零依赖、带标识、可复算（D-8）。 */
export function estimateTokens(text) {
  return Math.ceil(normalizeText(text).length / 4);
}

const isPosInt = (v) => Number.isInteger(v) && v > 0;

/**
 * 解析 policy JSON 文本；可选第二参为 capabilities JSON 文本（Adapter 侧读取，Core 只做结构校验）。
 * 任何结构不合法一律抛 PolicyParseError（调用方转 POLICY_INVALID，禁止静默降级）。
 */
export function parsePolicy(text, capabilitiesText) {
  let raw;
  try {
    raw = JSON.parse(normalizeText(text));
  } catch (e) {
    throw new PolicyParseError('policy JSON 不可解析: ' + e.message);
  }
  if (!raw || typeof raw !== 'object') throw new PolicyParseError('policy 不是对象');
  if (typeof raw.policyVersion !== 'string' || !raw.policyVersion) throw new PolicyParseError('缺 policyVersion');
  if (!Array.isArray(raw.families) || raw.families.length === 0) throw new PolicyParseError('families 缺失或空');
  for (const f of raw.families) {
    if (!f || typeof f.id !== 'string' || typeof f.kind !== 'string' || !Array.isArray(f.match) || f.match.length === 0) {
      throw new PolicyParseError('families 行缺 id/kind/match');
    }
  }
  const th = raw.thresholds;
  if (!th || typeof th !== 'object') throw new PolicyParseError('阈值表缺失');
  for (const k of THRESHOLD_KEYS) {
    if (!isPosInt(th[k])) throw new PolicyParseError('非法阈值 ' + k);
  }
  const eh = raw.escapeHatch;
  if (!eh || typeof eh.marker !== 'string' || !isPosInt(eh.reasonMaxLength)) throw new PolicyParseError('escapeHatch 缺失或非法');
  if (!raw.hints || typeof raw.hints !== 'object') throw new PolicyParseError('hints 缺失');
  for (const k of ['narrow', 'nextOffset', 'omitted']) {
    if (typeof raw.hints[k] !== 'string' || raw.hints[k].length < 2) throw new PolicyParseError('hints.' + k + ' 缺失或过短');
  }
  const policy = { ...raw };
  if (capabilitiesText !== undefined && capabilitiesText !== null) {
    try {
      policy.capabilities = JSON.parse(normalizeText(capabilitiesText));
    } catch (e) {
      throw new PolicyParseError('capabilities JSON 不可解析: ' + e.message);
    }
  }
  return policy;
}

/* ────────────────────────── A1 逃生阀（§4.1） ────────────────────────── */

const escapeRe = (policy) => {
  const marker = String(policy.escapeHatch.marker || '');
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+').replace(/^#/, '^#\\s*');
  return new RegExp(esc + '\\s+reason=(?<r>.*)$');
};

export function parseEscapeHatch(firstLine, policy) {
  const line = normalizeText(firstLine).split('\n')[0];
  const m = escapeRe(policy).exec(line);
  if (!m) return { state: 'absent' };
  const reason = String(m.groups.r === undefined ? '' : m.groups.r).trim();
  const max = policy.escapeHatch.reasonMaxLength;
  if (!reason || reason.length > max) return { state: 'absent' };
  if (policy.escapeHatch.singleLine !== true && reason.indexOf('\n') >= 0) return { state: 'absent' };
  return { state: 'valid', reason };
}

/* ────────────────────────── 命令族分类（§4.2 步骤③） ────────────────────────── */

const SHELL_TOOLS = ['bash', 'Bash', 'Shell', 'run_in_terminal', 'shell'];
const NON_DETERMINISTIC = ['|', '>', '<', ';', '&&', '||', '`', '$(', '&'];

function firstCommandWord(line) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    if (t === 'sudo' || t === 'command') continue;
    return t;
  }
  return '';
}

const baseName = (p) => String(p).split(/[\\/]/).pop();

export function classifyFamily(cmdline, policy) {
  const cmd = normalizeText(cmdline);
  const firstLine = cmd.split('\n')[0];
  let determinate = cmd.split('\n').length === 1;
  for (const mark of NON_DETERMINISTIC) {
    if (firstLine.indexOf(mark) >= 0) { determinate = false; break; }
  }
  const word = baseName(firstCommandWord(firstLine));
  let family = null;
  for (const f of policy.families) {
    if (f.match.some((m) => m.toLowerCase() === word.toLowerCase())) { family = f; break; }
  }
  return { family: family ? family.id : null, kind: family ? family.kind : null, determinate, word };
}

/* ────────────────────────── A2 Pre 面决策（§4.2） ────────────────────────── */

function hintText(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k])));
}

const hintVars = (policy, extra) => ({ marker: policy.escapeHatch.marker, ...extra });

export function parseCall(input, policy) {
  const runtime = String(input.runtime || '');
  const toolName = String(input.toolName || '');
  const toolInput = input.toolInput && typeof input.toolInput === 'object' ? input.toolInput : {};
  if (!SHELL_TOOLS.includes(toolName)) {
    return { action: 'passthrough', ruleId: 'non-shell-tool', runtime, toolName };
  }
  const command = normalizeText(toolInput.command === undefined ? '' : toolInput.command);
  if (!command.trim()) return { action: 'passthrough', ruleId: 'empty-command', runtime, toolName };

  const esc = parseEscapeHatch(command.split('\n')[0], policy);
  if (esc.state === 'valid') {
    return { action: 'passthrough', ruleId: 'escape-hatch', runtime, toolName, reason: esc.reason };
  }
  const fam = classifyFamily(command, policy);
  if (!fam.family || !fam.determinate) {
    return { action: 'passthrough', ruleId: 'not-a-family-or-indeterminate', runtime, toolName, family: fam.family };
  }
  const th = policy.thresholds;
  if (fam.kind === 'read') {
    const rewritten = { ...toolInput };
    if (rewritten.offset === undefined) rewritten.offset = 1;
    if (rewritten.limit === undefined) rewritten.limit = th.lineWindow;
    return {
      action: 'rewrite',
      ruleId: 'family-' + fam.family + '-window',
      runtime,
      toolName,
      family: fam.family,
      rewrittenInput: rewritten,
      hint: hintText(policy.hints.nextOffset, hintVars(policy, { nextOffset: rewritten.offset, window: rewritten.limit })),
    };
  }
  const cap = fam.kind === 'search' ? th.maxHits : th.lineWindow;
  return {
    action: 'block',
    ruleId: 'family-' + fam.family + '-unbounded',
    runtime,
    toolName,
    family: fam.family,
    limits: { cap },
    hint: hintText(policy.hints.narrow, hintVars(policy, { family: fam.family, cap })),
  };
}

/* ────────────────────────── A3 三类确定性裁剪（§4.3） ────────────────────────── */

const PATH_RE = /^(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|[^\s:]+[\\/])/;

export function inferKind(body, toolName) {
  const lines = normalizeText(body).split('\n').filter((l) => l.trim());
  if (lines.length === 0) return 'generic';
  if (toolName === 'read' || toolName === 'Read') return 'read';
  const searchHits = lines.filter((l) => /^[^\s:]+:\d+:/.test(l)).length;
  if (searchHits >= 2 && searchHits * 2 >= lines.length) return 'search';
  const pathy = lines.filter((l) => PATH_RE.test(l.trim()) && l.trim().indexOf(' ') < 0).length;
  if (pathy >= 2 && pathy * 2 >= lines.length) return 'list';
  return 'generic';
}

function truncateSearch(lines, policy) {
  const files = [];
  const seen = new Set();
  let hits = 0;
  for (const l of lines) {
    const m = /^([^\s:]+):(\d+):/.exec(l);
    if (m) {
      hits += 1;
      if (!seen.has(m[1])) { seen.add(m[1]); files.push(m[1]); }
    } else {
      hits += 1;
    }
  }
  files.sort();
  const cap = policy.thresholds.lineWindow;
  const shown = files.slice(0, cap);
  const head = String(hits) + ' hits in ' + String(files.length) + ' files';
  const body = [head].concat(shown).join('\n');
  return { body, kept: shown.length, dropped: Math.max(0, files.length - shown.length), hint: policy.hints.narrow };
}

function truncateList(lines, policy) {
  const uniq = [...new Set(lines.map((l) => l.trim()))].sort();
  const cap = policy.thresholds.lineWindow;
  const shown = uniq.slice(0, cap);
  const body = [String(uniq.length) + ' entries'].concat(shown).join('\n');
  return { body, kept: shown.length, dropped: Math.max(0, uniq.length - shown.length), hint: policy.hints.narrow };
}

// windowStart = 本调用读取窗口的起始文件行号（§4.3 读取行不变量：行号必须是原始文件行号，不得重编号）。
// 无窗口起点信息时缺省 1（普通 `cat`/`Get-Content` 从第 1 行开始输出）；续读锚点 = windowStart + kept。
function truncateRead(lines, policy, windowStart) {
  const window = policy.thresholds.lineWindow;
  const shown = lines.slice(0, window);
  const numbered = shown.map((l, i) => String(windowStart + i) + '\t' + l);
  const next = windowStart + shown.length;
  const body = numbered.join('\n') + '\n' + hintText(policy.hints.nextOffset, hintVars(policy, { nextOffset: next, window }));
  return { body, kept: shown.length, dropped: Math.max(0, lines.length - shown.length), hint: policy.hints.nextOffset };
}

function truncateGeneric(lines, policy) {
  const head = policy.thresholds.headLines;
  const tail = policy.thresholds.tailLines;
  const kept = lines.slice(0, head).concat(lines.slice(Math.max(head, lines.length - tail)));
  const omitted = Math.max(0, lines.length - kept.length);
  const body = kept
    .slice(0, head)
    .concat(hintText(policy.hints.omitted, hintVars(policy, { omitted })), kept.slice(head))
    .join('\n');
  return { body, kept: kept.length, dropped: omitted, hint: policy.hints.omitted };
}

/* ────────────────────────── A2 Post 面裁决（§4.2 步骤④） ────────────────────────── */

function unavailableDecision(input, reason) {
  const path = String(input.runtime || '?') + '/' + String(input.toolName || '?');
  return {
    action: 'unavailable',
    reason,
    ruleId: 'unavailable-' + reason,
    complete: true,
    coverage: 'unavailable',
    body: normalizeText(input.body),
    trailer: '[output-guard action=unavailable complete=true coverage=unavailable path=' + path + ']',
    keptTokens: estimateTokens(input.body),
    droppedTokens: 0,
  };
}

/**
 * 调用级终态回放（§4.2 步骤②）：同一 payload 内本调用的原始命令首行为合法逃生阀 ⇒ 跳过全部封顶。
 * Post 面与 Pre 面共用同一判定函数与同一「无跨调用状态」约束（AC-6）：命令文本只来自本调用自身入参。
 * 非 shell 工具（如 read 工具）不存在逃生阀（§4.1 步骤 3）。
 */
function callEscapeHatch(input, policy) {
  if (!SHELL_TOOLS.includes(String(input.toolName || ''))) return { state: 'absent' };
  const command = normalizeText(input.callCommand);
  if (!command.trim()) return { state: 'absent' };
  return parseEscapeHatch(command.split('\n')[0], policy);
}

/**
 * 结果类型判定（§4.3 映射）：调用级命令族优先（与 Pre 面同一 classifyFamily，只取已判定族），
 * 其次结果工具名与正文形态推断（inferKind）。族判定不可得时行为与改造前逐字相同。
 */
function resultKind(input, body, policy) {
  if (input.kind && typeof input.kind === 'string') return input.kind;
  const fam = classifyFamily(normalizeText(input.callCommand), policy);
  if (fam.family && fam.kind && fam.determinate) return fam.kind;
  return inferKind(body, input.toolName);
}

/**
 * A2 Post 面裁决（§4.2 步骤④）。`ResultInput` 的实例契约以本 JSDoc 为落点（SDD §3.2 的类型块是结构化草图，原话「实施时以 JSDoc 承载」）：
 *   { runtime, toolName, toolCallId, isError, exitCode?, body, structure }  ← SDD §3.2 已宣告字段（名字与语义未变）
 *   kind?        本调用已判定的结果类型（显式传入时优先于任何推断，§4.3）
 *   callCommand? 本调用原始命令文本（仅 shell 工具传入）：§4.2 步骤② 在 Post 面的回放依据（逃生阀）
 *   offset?      本调用读取窗口的起始文件行号（正整数，缺省 1）：§4.3 读取行的行号锚点
 * 三个可选字段均为**同一次调用、同一个 payload** 的映射结果，不引入任何跨调用状态（AC-6）。
 */
export function evaluateResult(input, policy) {
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined && input[k] !== null;
  const body = normalizeText(input.body);
  // 步骤② 的 Post 面回放（§4.2「命中即终态」）：逃生阀 ⇒ action=passthrough，跳过全部封顶。
  // 不写 trailer、不改正文（判断先于可保持性检查：不裁剪即无需回填）。
  if (callEscapeHatch(input, policy).state === 'valid') {
    return {
      action: 'passthrough',
      ruleId: 'escape-hatch',
      complete: true,
      coverage: 'full',
      body,
      trailer: '',
      keptTokens: estimateTokens(body),
      droppedTokens: 0,
    };
  }
  const caps = policy.capabilities || null;
  const preserve = caps && caps.runtimes && caps.runtimes[input.runtime] ? caps.runtimes[input.runtime].preserve : null;
  // 可保持性检查（AC-15 唯一判据）：present 必保留；absent-by-runtime 不作要求（D-6）。
  for (const field of ['toolName', 'toolCallId', 'isError']) {
    if (preserve && preserve[field] === 'absent-by-runtime') continue;
    if (!has(field)) return unavailableDecision(input, 'structure-not-preserved');
  }
  const structure = input.structure === undefined ? 'text' : input.structure;
  if (structure !== 'text' && structure !== 'content-parts') {
    return unavailableDecision(input, 'structure-not-preserved');
  }
  if (preserve && preserve.exitCode === 'present' && !has('exitCode')) {
    return unavailableDecision(input, 'structure-not-preserved');
  }
  if (estimateTokens(body) <= policy.thresholds.resultTokensCap) {
    return {
      action: 'passthrough',
      ruleId: 'under-cap',
      complete: true,
      coverage: 'full',
      body,
      trailer: '',
      keptTokens: estimateTokens(body),
      droppedTokens: 0,
    };
  }
  const lines = body.split('\n');
  const kind = resultKind(input, body, policy);
  const windowStart = Number.isInteger(input.offset) && input.offset > 0 ? input.offset : 1;
  const picked =
    kind === 'search' ? truncateSearch(lines, policy)
      : kind === 'list' ? truncateList(lines, policy)
        : kind === 'read' ? truncateRead(lines, policy, windowStart)
          : truncateGeneric(lines, policy);
  const out = picked.body + '\n' + hintText(policy.hints.narrow, hintVars(policy, { family: kind, cap: policy.thresholds.maxHits }));
  const original = estimateTokens(body);
  const kept = estimateTokens(out);
  return {
    action: 'truncate',
    ruleId: 'truncate-' + kind,
    kind,
    complete: false,
    coverage: 'full',
    body: out,
    trailer:
      '[output-guard action=truncate complete=false original≈' + String(original) +
      'k kept≈' + String(kept) + 'k reason=output-cap]',
    keptTokens: kept,
    droppedTokens: Math.max(0, original - kept),
    hint: picked.hint,
  };
}

/* ────────────────────────── A4 决策指纹（§4.4） ────────────────────────── */

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function fingerprint(input) {
  const parts = [
    String(input.policyVersion || ''),
    String(input.ruleId || ''),
    String(input.runtime || ''),
    String(input.toolName || ''),
    canonicalJson(input.normalizedInput === undefined ? {} : input.normalizedInput),
    normalizeText(input.body),
  ];
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

/* ────────────────────────── trailer 渲染（§2.2.4 字段闭包） ────────────────────────── */

export function renderTrailer(decision) {
  if (!decision || !decision.trailer) return '';
  return normalizeText(decision.trailer).split('\n').join(' ');
}

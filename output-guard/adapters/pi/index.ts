#!/usr/bin/env node
// Pi 扩展：tool_call / tool_result → OutputGuard Core 映射（CR-2026-069 TASK-03，SDD §3.3）。
//
// Pi 是启用顺序的第一位（FR-1 第 11 项）。挂载面是**宿主级**显式安装一次
// （`~/.pi/agent/settings.json#extensions` 或 `~/.pi/agent/extensions/`）——`pkg/agent/pi.go` 的
// argv 面被封闭，不做 argv 注入，也不新增 daemon 写点。
//
// 只做映射：阈值与裁剪算法全在 ../../core.mjs（本文件内零阈值字面量）。
// tool_call 面：逃生阀/命令族 → block（拒绝 + 可执行替代写法）或原地改写 event.input（施加上限）。
// tool_result 面：返回 { content, details?, isError? } **局部 patch**（省略字段保持原值），
// 不把被丢弃正文写进 details；未命中任何规则时不追加任何文本。
// fail-open：payload 不可解析 / policy 不可读或不可解析 / 结构不可安全保持 / 内部异常
// ⇒ 不写任何替换字段、不禁用调用，stderr 一行 OUTPUT_GUARD_UNAVAILABLE。
//
// 零依赖、零构建步骤：只用 node: 内建与同一 Release 的相对说明符 ../../core.mjs。

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUNTIME = 'pi';
// 读取面：默认同一 Release 的相对说明符；环境变量覆盖仅供安装期检查与合同测试使用。
const POLICY_URL = process.env.OUTPUT_GUARD_POLICY_PATH
  ? pathToFileURL(String(process.env.OUTPUT_GUARD_POLICY_PATH))
  : new URL('../../policy.json', import.meta.url);
const CAPABILITIES_URL = process.env.OUTPUT_GUARD_CAPABILITIES_PATH
  ? pathToFileURL(String(process.env.OUTPUT_GUARD_CAPABILITIES_PATH))
  : new URL('../../capabilities.json', import.meta.url);
const CORE_URL = new URL('../../core.mjs', import.meta.url);
const UNAVAILABLE = 'OUTPUT_GUARD_UNAVAILABLE';

function reportUnavailable(reason) {
  process.stderr.write(UNAVAILABLE + ' runtime=' + RUNTIME + ' reason=' + reason + '\n');
}

export async function loadContext() {
  const core = await import(CORE_URL.href);
  const policyText = fs.readFileSync(fileURLToPath(POLICY_URL), 'utf8');
  let capabilitiesText;
  try {
    capabilitiesText = fs.readFileSync(fileURLToPath(CAPABILITIES_URL), 'utf8');
  } catch {
    capabilitiesText = undefined;
  }
  return { core, policy: core.parsePolicy(policyText, capabilitiesText) };
}

/** 正文取值：Pi 的 tool_result.content 为 content-parts 数组。 */
export function bodyOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/** tool_call 面：返回 null 表示“无决策”（放行原样）。 */
export async function handleToolCall(event) {
  let ctx;
  try {
    ctx = await loadContext();
  } catch (e) {
    reportUnavailable(e && e.name === 'PolicyParseError' ? 'POLICY_INVALID' : 'BUNDLE_INVALID');
    return null;
  }
  const { core, policy } = ctx;
  const decision = core.parseCall({ runtime: RUNTIME, toolName: String(event.toolName || ''), toolInput: event.input || {} }, policy);
  if (decision.action === 'block') return { block: true, reason: decision.hint };
  if (decision.action === 'rewrite') return { input: decision.rewrittenInput };
  return null;
}

/** tool_result 面：返回局部 patch 或 null（不追加任何文本）。 */
export async function handleToolResult(event) {
  let ctx;
  try {
    ctx = await loadContext();
  } catch (e) {
    reportUnavailable(e && e.name === 'PolicyParseError' ? 'POLICY_INVALID' : 'BUNDLE_INVALID');
    return null;
  }
  const { core, policy } = ctx;
  const body = bodyOf(event.content);
  // 不伪造 Runtime 未提供的字段：缺失即不传出（由 Core 的可保持性检查裁定）。
  const input = { runtime: RUNTIME, toolName: event.toolName, structure: 'content-parts', body };
  // 本调用自身的入参（core.mjs 的 ResultInput JSDoc：callCommand / offset）：逃生阀首行判定与读取窗口起点由 Core 消费。
  // `tool_result` 事件带本调用 input（V-1，docs/extensions.md L842-855）；只读该事件字段，无跨调用状态（AC-6）。
  const callInput = event.input && typeof event.input === 'object' ? event.input : {};
  if (typeof callInput.command === 'string' && callInput.command) input.callCommand = callInput.command;
  if (Number.isInteger(callInput.offset) && callInput.offset > 0) input.offset = callInput.offset;
  if (event.toolCallId !== undefined) input.toolCallId = String(event.toolCallId);
  if (event.isError !== undefined) input.isError = Boolean(event.isError);
  if (event.exitCode !== undefined) input.exitCode = event.exitCode;
  const result = core.evaluateResult(input, policy);
  if (result.action === 'passthrough') return null;
  if (result.action === 'unavailable') {
    if (result.reason !== 'structure-not-preserved') reportUnavailable('BUNDLE_INVALID');
    return { content: [{ type: 'text', text: body + '\n' + result.trailer }] };
  }
  return { content: [{ type: 'text', text: result.body + '\n' + result.trailer }] };
}

/** Pi 扩展入口（`~/.pi/agent/settings.json#extensions` 指向本文件或本目录）。 */
export default function outputGuardExtension(pi) {
  pi.on('tool_call', async (event) => {
    try {
      const patch = await handleToolCall(event);
      if (patch === null) return;
      if (patch.block) return { block: true, reason: patch.reason };
      if (patch.input && event.input && typeof event.input === 'object') Object.assign(event.input, patch.input);
      return;
    } catch {
      reportUnavailable('BUNDLE_INVALID');
      return;
    }
  });
  pi.on('tool_result', async (event) => {
    try {
      return await handleToolResult(event);
    } catch {
      reportUnavailable('BUNDLE_INVALID');
      return;
    }
  });
}

/* ── 契约测试驱动面：直接以 `node index.ts` 运行且 stdin 为 hook payload 时，走同一映射实现 ── */
if (import.meta.main) {
  const raw = fs.readFileSync(0, 'utf8');
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    reportUnavailable('BUNDLE_INVALID');
    process.exit(0);
  }
  try {
    const out = payload && payload.type === 'tool_result'
      ? await handleToolResult(payload)
      : await handleToolCall(payload || {});
    if (out !== null) process.stdout.write(JSON.stringify(out));
  } catch {
    reportUnavailable('BUNDLE_INVALID');
  }
  process.exit(0);
}

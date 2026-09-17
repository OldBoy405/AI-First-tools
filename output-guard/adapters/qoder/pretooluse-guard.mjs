#!/usr/bin/env node
// Qoder PreToolUse hook → OutputGuard Core 映射（CR-2026-069 TASK-04，SDD §3.3）。
//
// 只做映射：阈值与裁剪算法全在 ../../core.mjs（本文件内零阈值字面量）；
// policy / capabilities 的读取是本文件的职责（Core 不读文件）。
// fail-open 契约：payload 不可解析 / policy 不可读或不可解析 / 结构不可安全保持 / 内部异常
// ⇒ 输出“无决策”（不写替换字段、不禁用调用），stderr 一行 OUTPUT_GUARD_UNAVAILABLE；不输出误伤调用的 deny。
// 同一 Release：只用相对说明符读取 ../../core.mjs 与 ../../policy.json。

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUNTIME = 'qoder';
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

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

export async function loadContext() {
  const core = await import(CORE_URL.href);
  const policyText = fs.readFileSync(fileURLToPath(POLICY_URL), 'utf8');
  let capabilitiesText;
  try { capabilitiesText = fs.readFileSync(fileURLToPath(CAPABILITIES_URL), 'utf8'); } catch { capabilitiesText = undefined; }
  return { core, policy: core.parsePolicy(policyText, capabilitiesText) };
}

/** 读取 Runtime 结果的正文（text / content-parts / {stdout,stderr} 三种形态）。 */
export function bodyOf(response) {
  if (response === null || response === undefined) return null;
  if (typeof response === 'string') return { structure: 'text', text: response };
  if (Array.isArray(response.content)) {
    return { structure: 'content-parts', text: response.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n') };
  }
  if (typeof response.stdout === 'string' || typeof response.stderr === 'string') {
    return { structure: 'text', text: String(response.stdout || '') + String(response.stderr || '') };
  }
  if (typeof response.output === 'string') return { structure: 'text', text: response.output };
  return null;
}

/** 以裁剪后的正文回填原结果，键集不变。 */
export function replaceBody(response, text) {
  if (typeof response === 'string') return text;
  if (Array.isArray(response.content)) return { ...response, content: [{ type: 'text', text }] };
  if (typeof response.stdout === 'string' || typeof response.stderr === 'string') return { ...response, stdout: text, stderr: '' };
  if (typeof response.output === 'string') return { ...response, output: text };
  return null;
}

export async function handle(payload) {
  let ctx;
  try {
    ctx = await loadContext();
  } catch (e) {
    return { ok: false, reason: e && e.name === 'PolicyParseError' ? 'POLICY_INVALID' : 'BUNDLE_INVALID', detail: e.message };
  }
  const { core, policy } = ctx;
  try {
    if (payload.hook_event_name !== 'PreToolUse') return { ok: true, out: null };
    const decision = core.parseCall({ runtime: RUNTIME, toolName: String(payload.tool_name || ''), toolInput: payload.tool_input || {} }, policy);
    if (decision.action === 'block') {
      return { ok: true, out: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.hint } } };
    }
    if (decision.action === 'rewrite') {
      return { ok: true, out: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: decision.rewrittenInput } } };
    }
    return { ok: true, out: null };
  } catch {
    return { ok: false, reason: 'BUNDLE_INVALID', detail: 'internal error' };
  }
}

if (import.meta.main) {
  const raw = readStdin();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    reportUnavailable('BUNDLE_INVALID');
    process.exit(0);
  }
  const res = await handle(payload || {});
  if (!res.ok) {
    reportUnavailable(res.reason);
    process.exit(0);
  }
  if (res.out !== null) emit(res.out);
}

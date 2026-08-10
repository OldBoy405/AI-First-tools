#!/usr/bin/env node
/**
 * PreToolUse 守卫（漂移治理 v2 组件 B）——多 IDE 共享实现
 *
 * 同一脚本被四个 IDE 的适配器引用（Claude Code / Qoder / Cursor / Codex），
 * 工具名做了归一化，无需为每个 IDE 复制脚本：
 *   shell 类：Bash（Claude/Codex）、Shell（Cursor）、run_in_terminal（Qoder 原生名）
 *   edit 类：Write/Edit/NotebookEdit（Claude/Cursor/Qoder 兼容名）、
 *            create_file/search_replace（Qoder 原生名）、apply_patch（Codex，从 patch 文本解析路径）
 *
 * 拦截三类逃生口（治理③⑥⑦）：
 *  1. shell 里的裸 git —— 只放行经 crctl git 的调用；
 *  2. shell 对受控路径的重定向/原地写入（>、>>、tee、sed -i、mv、cp）；
 *  3. edit 类工具直接改受控文件（Write/Edit/apply_patch）。
 *
 * 决策分两档：
 *  - deny：crctl 独占写入的权威状态文件（_backlog.yml、cr.md、approval.yml、
 *    review-annotations/*.yml、review-loop.yml、_history.yml）；
 *  - ask：需要人类点头才能写的门禁路径（specs/**、delivery/**、test-report.md），
 *    让合法的 writeback / 测试分析补写由人在权限提示里放行（第二道人类在环）。
 *
 * 输入：stdin JSON（tool_name / tool_input）；输出：hookSpecificOutput JSON
 * （Claude Code / Qoder / Codex 原生协议；Cursor 官方兼容嵌套格式，见
 * cursor.com/docs/reference/third-party-hooks）。
 * 额外受保护路径可在目标 workspace 的 .crctl/hooks.json 中以
 * {"extraDeny": ["regex"], "extraAsk": ["regex"]} 追加（用于主工作区代码目录围栏）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function out(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// 受控路径单一事实源：skills/shared/controlled-shell/rules.json#protectedPaths（CR-2026-002 TASK-01）。
// 加载失败时 PATTERNS=null，写类操作一律降级为 ask（既不静默放开、也不误伤只读操作）。
const RULES_PATH = process.env.CRCTL_RULES_PATH
  || path.resolve(__dirname, '..', '..', '..', '..', 'controlled-shell', 'rules.json');

const PATTERNS = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
    return {
      deny: j.protectedPaths.deny.map((s) => new RegExp(s, 'i')),
      ask: j.protectedPaths.ask.map((s) => new RegExp(s, 'i')),
    };
  } catch { return null; }
})();

function loadExtra(cwd) {
  try {
    const p = path.join(cwd || process.cwd(), '.crctl', 'hooks.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      deny: (j.extraDeny || []).map((s) => new RegExp(s, 'i')),
      ask: (j.extraAsk || []).map((s) => new RegExp(s, 'i')),
    };
  } catch { return { deny: [], ask: [] }; }
}

function classifyPath(p, extra) {
  if (!PATTERNS) return 'ask'; // rules.json 不可用：写类操作交人工确认
  const norm = String(p).replaceAll('\\', '/');
  if (PATTERNS.deny.some((re) => re.test(norm)) || extra.deny.some((re) => re.test(norm))) return 'deny';
  if (PATTERNS.ask.some((re) => re.test(norm)) || extra.ask.some((re) => re.test(norm))) return 'ask';
  return null;
}

const input = (() => { try { return JSON.parse(readStdin()); } catch { return {}; } })();
const tool = String(input.tool_name || '');
const ti = input.tool_input || {};
const extra = loadExtra(input.cwd);

// ── 工具名归一化（多 IDE 共享） ──
const SHELL_TOOLS = new Set(['Bash', 'Shell', 'run_in_terminal']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'create_file', 'search_replace', 'apply_patch']);
const isShellTool = SHELL_TOOLS.has(tool);
const isEditTool = EDIT_TOOLS.has(tool);

// Codex apply_patch：tool_input.command 是 patch 文本，从中解析目标文件路径
// 格式：*** Begin Patch ... *** (Add|Update|Delete) File: <path> ... *** End Patch
function pathsFromPatch(patchText) {
  const paths = [];
  const re = /^\*{3}\s+(?:Add|Update|Delete)\s+File:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(patchText)) !== null) paths.push(m[1].trim());
  return paths;
}

if (isEditTool) {
  const targets = tool === 'apply_patch'
    ? pathsFromPatch(String(ti.command || ''))
    : [String(ti.file_path || ti.notebook_path || '')];
  for (const target of targets) {
    if (!target) continue;
    const cls = classifyPath(target, extra);
    if (cls === 'deny') {
      out('deny', `受控状态文件只能由 crctl 写入（advance/approve/attempt）。请改用经 Tools Root 解析的 crctl（{TOOLS_ROOT}/skills/shared/crctl/scripts/crctl.mjs），禁止直接编辑 ${target}`);
    }
    if (cls === 'ask') {
      out('ask', `${target} 属于门禁路径（specs/delivery 只归 writeback Skill，test-report 骨架只归 crctl test）。若这是合法的回写/分析补写，请人工确认放行。`);
    }
  }
  out('allow', 'path not protected');
}

if (isShellTool) {
  const cmd = String(ti.command || '');
  const isCrctlGit = /crctl(\.mjs)?["']?\s+git\b/.test(cmd);
  const mentionsGit = /(^|[\s;&|(`])(command\s+)?(\S*[\\/])?git(\.exe)?\s/.test(cmd) || /(^|[\s;&|(`])git$/.test(cmd);
  if (mentionsGit && !isCrctlGit) {
    out('deny', '裸 git 被禁止（漂移治理 v2 ③）。所有 git 操作必须经 controlled-shell 白名单执行：经 Tools Root 解析的 crctl（{TOOLS_ROOT}/skills/shared/crctl/scripts/crctl.mjs）git <sub> [args] --cwd <path>');
  }
  const writeOps = /(>>?|\btee\b|\bsed\s+(-[a-z]*\s+)*-i\b|\bmv\b|\bcp\b|\brm\b|\btruncate\b)/.test(cmd);
  if (writeOps) {
    const protectedMention = [
      /change-requests\/(\S*\/)?(_backlog\.ya?ml|_history\.ya?ml|cr\.md|approval\.ya?ml|review-loop\.ya?ml)/i,
      /review-annotations\//i,
      /(^|[\s"'=/])specs\//i,
      /(^|[\s"'=/])delivery\//i,
      /test-report\.md/i,
    ].some((re) => re.test(cmd));
    if (protectedMention) {
      out('deny', 'Bash 重定向/原地写入命中受控路径（漂移治理 v2 ⑥⑦）。状态文件请走 crctl；specs/delivery 请走 writeback Skill；test-report 请走 crctl test。');
    }
  }
  out('allow', 'command not restricted');
}

out('allow', 'tool not in guard scope');

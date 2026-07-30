#!/usr/bin/env node
/**
 * Claude Code PreToolUse 守卫（漂移治理 v2 组件 B）
 *
 * 拦截三类逃生口（治理③⑥⑦）：
 *  1. Bash 里的裸 git —— 只放行经 crctl git 的调用；
 *  2. Bash 对受控路径的重定向/原地写入（>、>>、tee、sed -i、mv、cp）；
 *  3. Write/Edit/NotebookEdit 直接改受控文件。
 *
 * 决策分两档：
 *  - deny：crctl 独占写入的权威状态文件（_backlog.yml、cr.md、approval.yml、
 *    review-annotations/*.yml、review-loop.yml、_history.yml）；
 *  - ask：需要人类点头才能写的门禁路径（specs/**、delivery/**、test-report.md），
 *    让合法的 writeback / 测试分析补写由人在权限提示里放行（第二道人类在环）。
 *
 * 输入：stdin JSON（tool_name / tool_input）；输出：hookSpecificOutput JSON。
 * 额外受保护路径可在目标 workspace 的 .crctl/hooks.json 中以
 * {"extraDeny": ["regex"], "extraAsk": ["regex"]} 追加（用于主工作区代码目录围栏）。
 */

import fs from 'node:fs';
import path from 'node:path';

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

const DENY_PATTERNS = [
  /change-requests\/_backlog\.ya?ml$/i,
  /change-requests\/_history\.ya?ml$/i,
  /change-requests\/[^/]+\/cr\.md$/i,
  /change-requests\/[^/]+\/approval\.ya?ml$/i,
  /change-requests\/[^/]+\/review-loop\.ya?ml$/i,
  /review-annotations\/[^/]+\.ya?ml$/i,
];

const ASK_PATTERNS = [
  /(^|\/)specs\/[^/]+\/(PRD|SDD|traceability)\.(md|ya?ml)$/i,
  /(^|\/)delivery\//i,
  /change-requests\/[^/]+\/test-report\.md$/i,
];

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
  const norm = String(p).replaceAll('\\', '/');
  if (DENY_PATTERNS.some((re) => re.test(norm)) || extra.deny.some((re) => re.test(norm))) return 'deny';
  if (ASK_PATTERNS.some((re) => re.test(norm)) || extra.ask.some((re) => re.test(norm))) return 'ask';
  return null;
}

const input = (() => { try { return JSON.parse(readStdin()); } catch { return {}; } })();
const tool = input.tool_name || '';
const ti = input.tool_input || {};
const extra = loadExtra(input.cwd);

if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
  const target = ti.file_path || ti.notebook_path || '';
  const cls = classifyPath(target, extra);
  if (cls === 'deny') {
    out('deny', `受控状态文件只能由 crctl 写入（advance/approve/attempt）。请改用 tools/skills/shared/crctl/scripts/crctl.mjs，禁止直接编辑 ${target}`);
  }
  if (cls === 'ask') {
    out('ask', `${target} 属于门禁路径（specs/delivery 只归 writeback Skill，test-report 骨架只归 crctl test）。若这是合法的回写/分析补写，请人工确认放行。`);
  }
  out('allow', 'path not protected');
}

if (tool === 'Bash') {
  const cmd = String(ti.command || '');
  const isCrctlGit = /crctl(\.mjs)?["']?\s+git\b/.test(cmd);
  const mentionsGit = /(^|[\s;&|(`])(command\s+)?(\S*[\\/])?git(\.exe)?\s/.test(cmd) || /(^|[\s;&|(`])git$/.test(cmd);
  if (mentionsGit && !isCrctlGit) {
    out('deny', '裸 git 被禁止（漂移治理 v2 ③）。所有 git 操作必须经 controlled-shell 白名单执行：node tools/skills/shared/crctl/scripts/crctl.mjs git <sub> [args] --cwd <path>');
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

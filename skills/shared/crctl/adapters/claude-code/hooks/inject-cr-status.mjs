#!/usr/bin/env node
/**
 * Claude Code 上下文自动重注入（漂移治理 v2 §5.4，平台「渐进加载」的 IDE 等价物）
 *
 * 挂在 SessionStart / UserPromptSubmit / PreCompact 上：把 change-requests/ 下
 * 所有非终态 CR 的权威指针（id / status / updated-at）注入模型上下文，
 * 让模型每轮都看到真实状态，不再凭对话记忆猜（治理①的最大残留）。
 *
 * 轻量实现：行级扫描 _backlog.yml 取 id 清单，逐 id 读 cr.md frontmatter status
 * （cr.md 为权威状态源，CR-2026-018）；cr.md 读不到时回退 backlog 行值（旧布局兼容）。
 * 不依赖 crctl 主程序，失败时静默放行（注入是增强，不是门禁）。
 */

import fs from 'node:fs';
import path from 'node:path';

const TERMINAL = new Set(['archived', 'rejected', 'withdrawn']);

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

const input = (() => { try { return JSON.parse(readStdin()); } catch { return {}; } })();
const event = input.hook_event_name || 'SessionStart';
const cwd = input.cwd || process.cwd();

function findBacklog(start) {
  let dir = start;
  for (;;) {
    const p = path.join(dir, 'change-requests', '_backlog.yml');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const backlog = findBacklog(cwd);
if (!backlog) process.exit(0);

const wsRoot = path.dirname(path.dirname(backlog)); // change-requests/ 的父目录
const lines = fs.readFileSync(backlog, 'utf8').split(/\r?\n/);
const crs = [];
let cur = null;
for (const line of lines) {
  const idm = line.match(/^\s*-\s+id:\s*["']?([^"'\s]+)["']?\s*$/);
  if (idm) { cur = { id: idm[1], status: '?', updated: '' }; crs.push(cur); continue; }
  if (!cur) continue;
  const sm = line.match(/^\s+status:\s*["']?([^"'\s]+)["']?/);
  if (sm && cur.status === '?') cur.status = sm[1];
  const um = line.match(/^\s+updated-at:\s*["']?([^"']+?)["']?\s*$/);
  if (um && !cur.updated) cur.updated = um[1];
}

// 权威状态源 = cr.md frontmatter（CR-2026-018）；逐 id 读 cr.md 覆盖 backlog 行值
for (const c of crs) {
  try {
    const crmdPath = path.join(wsRoot, 'change-requests', c.id, 'cr.md');
    const text = fs.readFileSync(crmdPath, 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) continue;
    const sm = fm[1].match(/^status:\s*["']?([^"'\s]+)["']?/m);
    if (sm) c.status = sm[1];
    const um = fm[1].match(/^updated-at:\s*["']?([^"']+?)["']?\s*$/m);
    if (um) c.updated = um[1];
  } catch { /* cr.md 读不到时回退 backlog 行值（旧布局兼容），静默放行 */ }
}

const active = crs.filter((c) => !TERMINAL.has(c.status));
if (active.length === 0) process.exit(0);

const ctx = [
  '[crctl 权威指针注入] 以下为 change-requests/{CR-ID}/cr.md 的实时状态（勿凭记忆自报 status）：',
  ...active.map((c) => `- ${c.id}: status=${c.status}${c.updated ? ` (updated-at ${c.updated})` : ''}`),
  '状态推进/审批/git 必须经 crctl：crctl（经 Tools Root 解析：{TOOLS_ROOT}/skills/shared/crctl/scripts/crctl.mjs，status|advance|gate|approve|validate|attempt|test|next|git）。',
  '完整指针与门禁缺口请运行：crctl status <CR-ID>。',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: event, additionalContext: ctx },
}));

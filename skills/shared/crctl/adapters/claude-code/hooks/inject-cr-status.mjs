#!/usr/bin/env node
/**
 * Claude Code 上下文自动重注入（漂移治理 v2 §5.4，平台「渐进加载」的 IDE 等价物）
 *
 * 挂在 SessionStart / UserPromptSubmit / PreCompact 上：把 change-requests/_backlog.yml
 * 中所有非终态 CR 的权威指针（id / status / updated-at）注入模型上下文，
 * 让模型每轮都看到真实状态，不再凭对话记忆猜（治理①的最大残留）。
 *
 * 轻量实现：行级扫描 _backlog.yml，不依赖 crctl 主程序，失败时静默放行（注入是增强，不是门禁）。
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

const active = crs.filter((c) => !TERMINAL.has(c.status));
if (active.length === 0) process.exit(0);

const ctx = [
  '[crctl 权威指针注入] 以下为 change-requests/_backlog.yml 的实时状态（勿凭记忆自报 status）：',
  ...active.map((c) => `- ${c.id}: status=${c.status}${c.updated ? ` (updated-at ${c.updated})` : ''}`),
  '状态推进/审批/git 必须经 crctl：node tools/skills/shared/crctl/scripts/crctl.mjs（status|advance|gate|approve|validate|attempt|test|next|git）。',
  '完整指针与门禁缺口请运行：crctl status <CR-ID>。',
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: event, additionalContext: ctx },
}));

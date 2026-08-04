#!/usr/bin/env node
/**
 * Cursor sessionStart 薄包装：把共享 inject-cr-status.mjs 的 Claude Code 嵌套输出
 * （hookSpecificOutput.additionalContext）转换为 Cursor 原生扁平输出（additional_context）。
 *
 * Cursor 的 sessionStart 是 fire-and-forget（不等待阻断响应），输出 additional_context
 * 会追加进会话初始上下文。本脚本保持共享脚本单一实现，只做格式转换：
 *   读 stdin（原样转发给共享脚本）→ 解析其 stdout JSON → 输出 { additional_context }。
 *
 * 失败时静默放行（注入是增强，不是门禁），与共享脚本的定位一致。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED = path.resolve(__dirname, '..', '..', 'claude-code', 'hooks', 'inject-cr-status.mjs');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

const input = readStdin();
const r = spawnSync(process.execPath, [SHARED], { input, encoding: 'utf8' });
if (r.status !== 0) process.exit(0);

try {
  const out = JSON.parse(r.stdout);
  const ctx = out?.hookSpecificOutput?.additionalContext;
  if (!ctx) process.exit(0);
  process.stdout.write(JSON.stringify({ additional_context: ctx }));
} catch { process.exit(0); }
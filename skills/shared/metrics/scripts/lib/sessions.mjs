// FR-8 只读 session 遍历（CR-2026-069 TASK-01，SDD §4.7 / §7.1 第 2 条）。
//
// 只读、EOL 归一、硬失败可数：单行 JSON.parse 失败计入 malformedLines（可见计数，不静默跳过），
// 文件级读失败计入 unreadableFiles（同样可见）。零依赖：只用 node: 内建。

import fs from 'node:fs';
import path from 'node:path';

/** I9 唯一归一化入口（与 output-guard/core.mjs 同义；本文件不 import 它以避免循环加载面）。 */
export function normalizeText(s) {
  return String(s === null || s === undefined ? '' : s).split('\r\n').join('\n');
}

/** CR-ID 识别正则（固定，随输出：见 aggregate 的 rule 字段）。 */
export const CR_ID_PATTERN = 'CR-[0-9]{4}-[0-9]{3}';

export function findCrId(text) {
  const m = new RegExp(CR_ID_PATTERN).exec(text);
  return m ? m[0] : null;
}

/** 默认 sample roots（可被 --sessions-root 覆盖）。 */
export function defaultSessionRoots() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return [];
  return [path.join(home, '.multica', 'pi-sessions'), path.join(home, '.pi', 'agent', 'sessions')];
}

/** 只读枚举：roots 下递归找 *.jsonl（深度上限防失控）。 */
export function listSessionFiles(roots) {
  const out = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const stack = [[path.resolve(root), 0]];
    while (stack.length > 0) {
      const [dir, depth] = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        out.push({ path: null, root: path.resolve(root), unreadable: true });
        continue;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 4) stack.push([p, depth + 1]);
        } else if (e.name.endsWith('.jsonl')) {
          out.push({ path: p, root: path.resolve(root), unreadable: false });
        }
      }
    }
  }
  return out;
}

/** 读一个 session 文件：返回 { records, malformedLines, unreadable, bytes }。 */
export function readSession(file) {
  const res = { path: file.path, records: [], malformedLines: 0, unreadable: false, bytes: 0 };
  let raw;
  try {
    raw = normalizeText(fs.readFileSync(file.path, 'utf8'));
  } catch {
    res.unreadable = true;
    return res;
  }
  res.bytes = Buffer.byteLength(raw, 'utf8');
  const lines = raw.split('\n');
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      res.records.push(JSON.parse(line));
    } catch {
      res.malformedLines += 1;
    }
  }
  return res;
}

/** 单条 toolResult 记录的正文文本（Pi 形状：content[] = [{type:'text', text}]）。 */
export function toolResultText(message) {
  const parts = Array.isArray(message.content) ? message.content : [];
  return parts.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
}

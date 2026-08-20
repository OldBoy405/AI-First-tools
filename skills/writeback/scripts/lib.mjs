// lib.mjs — writeback 回写脚本公共库（CR-2026-020）
// 职责：CRLF 归一 / frontmatter 行级读改 / 缩进敏感 YAML 块提取 / dry-run diff / JSON 输出
// 硬边界（SDD §2.1 / NFR-5）：本文件不提供任何写 _backlog.yml / _history.yml / cr.md /
//   CR 内 tasks/_index.yml 的函数——账本写入仍唯一经 crctl，回写脚本只读账本、只写 specs/ 与 delivery/。
// 依赖：仅 Node 标准库（零第三方依赖，NFR-3）。风格对齐 crctl.mjs 的 ok()/fail()（不 import，SDD §8 D2）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseYaml } from '../../shared/crctl/scripts/lib/yaml-subset.mjs';

/* ────────────────────────── 输出 / 错误（风格对齐 crctl.mjs）────────────────────────── */

export function fail(code, message, extra = {}) {
  const err = { error: { code, message, ...extra } };
  process.stderr.write(JSON.stringify(err, null, 2) + '\n');
  process.exit(1);
}

export function ok(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

export function nowIso() {
  // 本地时区 ISO 8601（含偏移），由代码生成，不接受外部传入
  const d = new Date();
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`
  );
}

/* ────────────────────────── CRLF 归一（纪律 #1）────────────────────────── */

export function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

/* ────────────────────────── 文件读写（读入归一、写出 LF）────────────────────────── */

export function readFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return normalize(fs.readFileSync(filePath, 'utf8'));
}

// 计划写：dryRun 时只打印 diff 不落盘；实跑时内容有变化才写（先验证后写，天然幂等）
export function planWrite(filePath, newText, { dryRun = false, label } = {}) {
  const oldText = readFile(filePath) ?? '';
  const changed = oldText !== newText;
  if (changed && dryRun) {
    process.stdout.write(unifiedDiff(oldText, newText, label ?? filePath) + '\n');
    return { changed, written: false };
  }
  if (changed) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, newText, 'utf8'); // newText 由 normalize 保证无 \r
  }
  return { changed, written: changed };
}

/* ────────────────────────── frontmatter（首个 --- 块，行级读改）────────────────────────── */

export function splitFrontmatter(text) {
  // 文件以 `---\n` 开头，块结束于行首 `---`；无 frontmatter 时返回 null 块
  // 读入先 CRLF→LF 归一（纪律 #1）：本函数是 frontmatter 读改的唯一入口，调用方不负责归一
  text = normalize(text);
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { block: null, body: text, endIndex: 0 };
  return { block: m[1], body: text.slice(m[0].length), endIndex: m[0].length };
}

export function readFrontmatter(text) {
  const { block } = splitFrontmatter(text);
  if (block === null) return {};
  const fields = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}

// 行首锚定更新 frontmatter 字段：命中 1 次替换（保留原行引号风格）、0 次在块末插入、
// ≥2 次硬失败 ANCHOR_NOT_UNIQUE（纪律 #1，不静默取第一个）
export function patchFrontmatterField(text, field, value) {
  const fm = splitFrontmatter(text);
  if (fm.block === null) {
    fail('STRUCTURE_MISMATCH', `文件缺少 frontmatter 块，无法更新字段 ${field}`);
  }
  const lines = fm.block.split('\n');
  const hits = [];
  const re = new RegExp(`^${field}:`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) hits.push(i);
  }
  if (hits.length > 1) {
    fail('ANCHOR_NOT_UNIQUE', `frontmatter 字段 ${field} 命中 ${hits.length} 次（期望 ≤1）`, { field, hits });
  }
  const serialized = serializeFieldValue(lines[hits[0]], value);
  if (hits.length === 1) {
    lines[hits[0]] = `${field}: ${serialized}`;
  } else {
    lines.push(`${field}: ${serialized}`); // 块末（闭合 --- 前）插入
  }
  return `---\n${lines.join('\n')}\n---\n` + fm.body;
}

function serializeFieldValue(originalLine, value) {
  const str = String(value);
  // 原行值带引号则保留引号风格；新增行：纯标识符（spec-id/cr-ref/version/status 类）裸值，
  //   含时间戳/冒号/空格等则带引号（与真实 frontmatter 风格一致）
  const quoted = originalLine !== undefined
    ? /:\s*"/.test(originalLine)
    : !/^[A-Za-z0-9_.\-]+$/.test(str);
  return quoted ? JSON.stringify(str) : str;
}

/* ────────────────────────── 缩进敏感 YAML 块提取（只读解析）────────────────────────── */

export function findLine(lines, pattern, from = 0) {
  // 对 trimStart 后的行测试：调用方 pattern 不含前导空白（匹配行本身的缩进由 extractBlock 边界处理）
  for (let i = from; i < lines.length; i++) {
    if (pattern.test(lines[i].trimStart())) return i;
  }
  return -1;
}

// 提取从匹配行开始的块：包含该行与后续缩进更深的行（空行/纯注释行并入块内）
// 返回 { start, end, text }；未命中返回 null
export function extractBlock(text, startPattern) {
  const lines = text.split('\n');
  const start = findLine(lines, startPattern);
  if (start === -1) return null;
  const indent = (lines[start].match(/^ */) || [''])[0].length;
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() === '' || /^\s*#/.test(l)) { end++; continue; }
    const li = (l.match(/^ */) || [''])[0].length;
    if (li <= indent) break;
    end++;
  }
  return { start, end, text: lines.slice(start, end).join('\n') };
}

/* ────────────────────────── dry-run 行 diff（不引入第三方库）────────────────────────── */

export function unifiedDiff(oldText, newText, label) {
  const a = (oldText ?? '').split('\n');
  const b = (newText ?? '').split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const out = [];
  if (label) out.push(`--- ${label}`);
  for (const l of a.slice(pre, a.length - suf)) out.push(`- ${l}`);
  for (const l of b.slice(pre, b.length - suf)) out.push(`+ ${l}`);
  return out.join('\n');
}

/* ────────────────────────── CLI 参数（--key value / --flag）────────────────────────── */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else args[key] = true;
  }
  return args;
}

/* ── CR-2026-049 TASK-01：加固 parser 完整解析 + 结构化语义校验（SDD §2.6）──
 * 顶层映射、spec-id===specId、cr-ref===cr、milestones 数组、YAML 文本 `- cr:` 数与对象数组长度相等、
 * 当前 CR 恰一段、该段含 frs|fr-chain 与 evidence。任一不满足非零退出（TRACE_SEMANTIC_INVALID），不静默降级。
 * 放 lib.mjs（无副作用模块）供 generator 与测试共同 import；generator 是 CLI 脚本，不可被 import。 */
export function parseGeneratedTraceability(text, { cr, specId }) {
  let doc;
  try {
    doc = parseYaml(normalize(text));
  } catch (e) {
    fail('YAML_SUBSET_PARSE_FAILED', `traceability 解析失败：${e.message}`, { cr, specId });
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    fail('TRACE_SEMANTIC_INVALID', 'traceability 顶层不是映射', { cr, specId });
  }
  if (doc['spec-id'] !== specId) {
    fail('TRACE_SEMANTIC_INVALID', `traceability spec-id=${JSON.stringify(doc['spec-id'])} 与 ${specId} 不一致`, { cr, specId });
  }
  if (doc['cr-ref'] !== cr) {
    fail('TRACE_SEMANTIC_INVALID', `traceability cr-ref=${JSON.stringify(doc['cr-ref'])} 与 ${cr} 不一致`, { cr, specId });
  }
  if (!Array.isArray(doc.milestones)) {
    fail('TRACE_SEMANTIC_INVALID', 'traceability milestones 不是数组', { cr, specId });
  }
  // YAML 文本中 `- cr:` 数量必须等于对象数组长度（防 parser 与文本不一致）
  const rawLines = normalize(text).split('\n').filter((l) => !/^\s*#/.test(l));
  const textCount = rawLines.filter((l) => /^\s*- cr:\s+\S/.test(l)).length;
  if (textCount !== doc.milestones.length) {
    fail('TRACE_SEMANTIC_INVALID', `YAML 文本 - cr: 段数 ${textCount} != 解析对象数组长度 ${doc.milestones.length}`, { cr, specId, textCount, objectCount: doc.milestones.length });
  }
  const mine = doc.milestones.filter((m) => m && typeof m === 'object' && m.cr === cr);
  if (mine.length !== 1) {
    fail('TRACE_SEMANTIC_INVALID', `当前 CR ${cr} 段数=${mine.length}（期望恰 1）`, { cr, specId });
  }
  const seg = mine[0];
  const hasFrs = Array.isArray(seg.frs) || Array.isArray(seg['fr-chain']);
  if (!hasFrs || seg.evidence == null) {
    fail('TRACE_SEMANTIC_INVALID', `当前 CR ${cr} 段缺少 frs|fr-chain 或 evidence`, { cr, specId, hasFrs, hasEvidence: seg.evidence != null });
  }
  return doc;
}

/* ────────────────────────── 账本路径防护（自检/断言用，静态可核查）────────────────────────── */

export const LEDGER_PATTERNS = [
  /change-requests[\\/]_backlog\.yml/,
  /change-requests[\\/]_history\.yml/,
  /change-requests[\\/][^\\/]+[\\/]cr\.md$/,
  /change-requests[\\/][^\\/]+[\\/]tasks[\\/]_index\.yml/,
];

export function isLedgerPath(p) {
  const norm = p.replace(/\\/g, '/');
  return LEDGER_PATTERNS.some((re) => re.test(norm));
}

/* ────────────────────────── candidate-only 输出（CR-2026-031 TASK-08）──────────────────────────
 * 三个 writeback generator 不再直接写 baseline：只输出 candidate 目录
 * （<candidate-out>/<path> 文件 + <candidate-out>/blobs/<sha> + <candidate-out>/manifest.json），
 * 由 crctl writeback-apply 校验、应用、stage、commit、lease push（SDD §3.5/§5.3）。
 */

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 磁盘字节 sha256（不做 CRLF 归一）：before/after 的 CAS 锚点语义 = 工作区现状字节，
 * 与 crctl applyWriteSet 的 readHash 一致（Windows autocrlf 检出 CRLF 不影响锚点一致性）。 */
export function readHashRaw(p) {
  let buf;
  try { buf = fs.readFileSync(p); } catch { return null; }
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** manifest v1/v2 canonical 序列化（SDD §3.5；CR-2026-049 TASK-01 新增 v2）：字段固定顺序、files 按 path
 * 排序后取 path/beforeSha256/afterSha256；v2（traceability）额外覆盖 event.kind/event.payload/event.payloadSha256——
 * inputDigest 即其 sha256。apply 侧（workspace-transactions.mjs）用同一公式重算比对，防 manifest 篡改/重放。 */
export function computeInputDigest({ v, stage, cr, specId, targetVersion, generator, files, event }) {
  const canon = JSON.stringify({
    v, stage, cr, specId, targetVersion,
    generator: { id: generator.id, sha256: generator.sha256 },
    files: files.map((f) => ({ path: f.path, beforeSha256: f.beforeSha256 == null ? null : f.beforeSha256, afterSha256: f.afterSha256 })),
    ...(event ? { event: { kind: event.kind, payload: event.payload, payloadSha256: event.payloadSha256 } } : {}),
  });
  return sha256(canon);
}

/** candidate 写盘：blob 落盘 → manifest 落盘（inputDigest 自校验锚点）。返回 manifest 对象。
 * event 提供时 manifest v=2（CR-2026-049 TASK-01：traceability 阶段携带 {kind,payload,payloadSha256}）。
 * 幂等：相同内容重跑生成相同 sha/blob，candidate 目录整体可删除重生成。 */
export function writeCandidate({ candidateOut, stage, cr, specId, targetVersion, generator, files, contentOf, event }) {
  fs.mkdirSync(candidateOut, { recursive: true });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); // manifest 要求 POSIX 字典序（SDD §3.5）
  for (const f of files) {
    const content = contentOf(f.path);
    if (typeof content !== 'string') fail('CANDIDATE_CONTENT_MISSING', `candidate 文件无内容: ${f.path}`);
    const after = sha256(content);
    if (f.afterSha256 != null && f.afterSha256 !== after) {
      fail('CANDIDATE_HASH_MISMATCH', `candidate ${f.path} 内容哈希 ${after} != 声明 ${f.afterSha256}`);
    }
    f.afterSha256 = after;
    f.blob = `blobs/${after}`;
    const blobP = path.join(candidateOut, 'blobs', after);
    if (!fs.existsSync(blobP)) {
      fs.mkdirSync(path.dirname(blobP), { recursive: true });
      fs.writeFileSync(blobP, content, 'utf8');
    }
    fs.mkdirSync(path.dirname(path.join(candidateOut, f.path)), { recursive: true });
    fs.writeFileSync(path.join(candidateOut, f.path), content, 'utf8');
  }
  const manifest = {
    v: event ? 2 : 1, stage, cr, specId, targetVersion,
    inputDigest: '', generator,
    files: files.map((f) => ({ path: f.path, beforeSha256: f.beforeSha256 == null ? null : f.beforeSha256, afterSha256: f.afterSha256, blob: f.blob })),
    ...(event ? { event: { kind: event.kind, payload: event.payload, payloadSha256: event.payloadSha256 } } : {}),
  };
  manifest.inputDigest = computeInputDigest(manifest);
  const manifestPath = path.join(candidateOut, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { manifest, manifestPath };
}

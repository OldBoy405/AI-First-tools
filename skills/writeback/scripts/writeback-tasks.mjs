// writeback-tasks.mjs — TASK 回写脚本（CR-2026-020，SDD §4.2 / FR-2）
// 职责：done 任务拷贝到 delivery/task/（命名 TASK-{version}-{cr}-{NN}-{slug}）+ frontmatter 注入
//       spec-id/version + delivery/task/_index.yaml 维护（既有条目逐字保留 + 新增从源数据构造追加，
//       不做扫描重投影——真实交付文件 frontmatter 不含可信 status/target-version，投影必然失真）。
// 幂等判据（SDD-BLOCK-001 修复版）：扫描 delivery/task/*.md frontmatter 的 id 集合，不看目标文件名。
// 边界：change-requests/{cr}/tasks/_index.yml 只读（账本）；只写 delivery/ 内容文件（NFR-5）。
// 用法：node writeback-tasks.mjs --workspace <ws> --cr <CR-ID> --spec <spec_id> --version <ver> [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs, fail, ok, readFile, planWrite,
  splitFrontmatter, readFrontmatter,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const { workspace: ws, cr, spec, version } = args;
if (!ws || !cr || !spec || !version) {
  fail('BAD_ARGS', '缺少必填参数 --workspace / --cr / --spec / --version');
}
const dryRun = !!args['dry-run'];
const verNoV = version.startsWith('v') ? version.slice(1) : version;
const crDir = path.join(ws, 'change-requests', cr);
const deliveryDir = path.join(ws, 'delivery', 'task');

/* ── 前置：cr.md 状态校验（只读）── */
const crMd = readFile(path.join(crDir, 'cr.md'));
if (crMd === null) fail('CR_NOT_FOUND', `cr.md 不存在：${path.join(crDir, 'cr.md')}`);
const fm = readFrontmatter(crMd);
if (fm.status !== 'writing-back') {
  fail('CR_STATUS_MISMATCH', `writeback-tasks 要求 CR status=writing-back，当前=${fm.status}`, { cr });
}

/* ── 读 CR tasks/_index.yml（账本，只读）筛 status=done ── */
const crTasksIdx = readFile(path.join(crDir, 'tasks', '_index.yml'));
if (crTasksIdx === null) fail('STRUCTURE_MISMATCH', `change-requests/${cr}/tasks/_index.yml 不存在`);
const doneIds = [];
{
  let cur = null;
  for (const line of crTasksIdx.split('\n')) {
    const t = line.trimStart();
    if (/^- id: /.test(t)) { cur = { id: t.slice(6).trim(), status: '' }; doneIds.push(cur); }
    else if (cur && /^status: /.test(t)) cur.status = t.slice(8).trim();
  }
}
const todo = doneIds.filter((t) => t.status === 'done').map((t) => t.id);
if (todo.length === 0) {
  ok({ op: 'writeback-tasks', cr, spec, version, noop: true, reason: 'tasks/_index.yml 无 status=done 任务' });
  process.exit(0);
}

/* ── 源文件映射：tasks/TASK-{NN}.md 的 frontmatter id → 文件 ── */
const srcById = new Map();
for (const f of fs.readdirSync(path.join(crDir, 'tasks'))) {
  if (!/^TASK-\d+\.md$/.test(f)) continue;
  const doc = readFile(path.join(crDir, 'tasks', f));
  const id = readFrontmatter(doc).id;
  if (id) srcById.set(id, { file: f, doc });
}

/* ── 已交付 id 集合（幂等唯一判据，SDD-BLOCK-001 修复版）── */
const delivered = new Set();
const existingFiles = fs.existsSync(deliveryDir) ? fs.readdirSync(deliveryDir).filter((f) => f.endsWith('.md')) : [];
for (const f of existingFiles) {
  const doc = readFile(path.join(deliveryDir, f));
  const id = readFrontmatter(doc).id;
  if (id) delivered.add(id);
}

/* ── 目标文件构造：拷贝 + frontmatter 注入 spec-id/version（置于 id 前，与既有回写产物一致）── */
function buildTarget(src) {
  const srcFm = splitFrontmatter(src.doc);
  const srcFields = readFrontmatter(src.doc);
  const nn = /TASK-(\d+)\.md$/.exec(src.file)[1];
  const slug = srcFields.slug || `task-${nn}`;
  const fileName = `TASK-${verNoV}-${cr}-${nn}-${slug}.md`;
  const injected = `spec-id: ${spec}\nversion: ${JSON.stringify(verNoV)}\n${srcFm.block}`;
  return { fileName, text: `---\n${injected}\n---\n` + srcFm.body };
}

const toWrite = [];
for (const id of todo) {
  const src = srcById.get(id);
  if (!src) fail('STRUCTURE_MISMATCH', `tasks/_index.yml 标记 done 的任务 ${id} 无对应 tasks/TASK-*.md`);
  if (delivered.has(id)) continue; // 幂等：id 已交付即跳过（不看文件名）
  const target = buildTarget(src);
  if (dryRun) {
    process.stdout.write(`+ ${target.fileName}（${id}）\n`);
  } else {
    planWrite(path.join(deliveryDir, target.fileName), target.text, { dryRun: false });
  }
  toWrite.push({ id, fileName: target.fileName });
}
if (toWrite.length === 0) {
  ok({ op: 'writeback-tasks', cr, spec, version, noop: true, reason: '全部 done 任务 id 已在交付集合' });
  process.exit(0);
}

/* ── delivery/task/_index.yaml 维护：既有条目逐字保留 + 新增条目从源数据构造追加 ──
   不做"扫描文件重投影"式全量重建（CODE-BLOCK-001 修复版）：真实交付文件 frontmatter 是
   status: pending 且无 target-version 字段（实测 TASK-0.20.1-CR-2026-019-01），投影必然失真
   （done 翻 pending、target-version 清空）。既有条目原文保留天然保真，新增条目全部字段在
   写入时刻已知（源 frontmatter + 入参），无需回读投影。幂等仍由 id 集合保证。 */
function buildIndex() {
  const oldIdxPath = path.join(deliveryDir, '_index.yaml');
  const oldText = readFile(oldIdxPath);
  const lines = oldText !== null ? oldText.replace(/\n+$/, '').split('\n') : ['tasks:'];
  const oldIds = new Set([...(oldText ?? '').matchAll(/^\s*- id: (\S+)/gm)].map((m) => m[1]));
  for (const t of toWrite) {
    if (oldIds.has(t.id)) continue; // 幂等：索引已登记则不重复追加
    const srcFields = readFrontmatter(srcById.get(t.id).doc);
    lines.push(
      `  - id: ${t.id}`,
      `    file: ${t.fileName}`,
      `    title: ${(srcFields.title ?? '').replace(/^"|"$/g, '')}`,
      `    status: done`,
      `    cr-ref: ${cr}`,
      `    target-version: ${JSON.stringify(verNoV)}`,
      `    estimate: ${(srcFields.estimate ?? '').replace(/^"|"$/g, '')}`,
    );
  }
  return lines.join('\n') + '\n';
}

const oldIdxPath = path.join(deliveryDir, '_index.yaml');
const newIndex = buildIndex();
const oldIdx = readFile(oldIdxPath) ?? '';
if (oldIdx !== newIndex) {
  if (dryRun) {
    process.stdout.write(`~ delivery/task/_index.yaml（既有条目保留，追加 ${toWrite.length} 条）\n`);
  } else {
    planWrite(oldIdxPath, newIndex, { dryRun: false });
  }
}

if (dryRun) {
  ok({ op: 'writeback-tasks', cr, spec, version, dryRun: true, toWrite: toWrite.map((t) => t.fileName) });
  process.exit(0);
}

/* ── 末尾自检：新增 id 恰 1 条、字段齐全、无 \r ── */
const errors = [];
for (const t of toWrite) {
  const targetPath = path.join(deliveryDir, t.fileName);
  const doc = readFile(targetPath);
  if (doc === null) { errors.push(`${t.fileName} 未落盘`); continue; }
  if (doc.includes('\r')) errors.push(`${t.fileName} 含 CRLF`);
  const fld = readFrontmatter(doc);
  if (fld['spec-id'] !== spec || !fld.version) errors.push(`${t.fileName} frontmatter 注入缺失`);
}
{
  const idx = readFile(oldIdxPath) ?? '';
  for (const t of toWrite) {
    const n = (idx.match(new RegExp(`- id: ${t.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gm')) || []).length;
    if (n !== 1) errors.push(`_index.yaml 中 ${t.id} 条目数=${n}`);
  }
  if (idx.includes('\r')) errors.push('_index.yaml 含 CRLF');
}
if (errors.length) fail('SELF_CHECK_FAILED', '自检断言失败：' + errors.join('；'), { errors });

ok({ op: 'writeback-tasks', cr, spec, version, noop: false, written: toWrite.map((t) => t.fileName) });

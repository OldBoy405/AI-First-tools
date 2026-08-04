// writeback-traceability.mjs — traceability 回写脚本（CR-2026-020，SDD §4.3 / FR-3、FR-7）
// 职责：specs/{spec}/traceability.yml 头部结构化字段更新 + 本 CR milestone 段末尾追加。
//       不是全量重建（SDD §8 D3）：头部手工注释与既有 milestones 段逐字节保留。
// merge-commits：从 change-requests/_backlog.yml 定向提取（六字段齐全性断言，缺失 MERGE_COMMITS_MISSING）；
//       写入 specs 侧时输出与既有段一致的 4 字段（repo/trunk/sha/branch，见 CR-2026-018/019 段先例）。
// 边界：_backlog.yml 只读（账本）；只写 specs/ 内容文件（NFR-5）。
// 用法：node writeback-traceability.mjs --workspace <ws> --cr <CR-ID> --spec <spec_id> --version <ver>
//       --milestone-file <path> [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs, fail, ok, nowIso, readFile, planWrite,
  readFrontmatter, extractBlock,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const { workspace: ws, cr, spec, version } = args;
const milestoneFile = args['milestone-file'];
if (!ws || !cr || !spec || !version || !milestoneFile) {
  fail('BAD_ARGS', '缺少必填参数 --workspace / --cr / --spec / --version / --milestone-file');
}
const dryRun = !!args['dry-run'];
const crDir = path.join(ws, 'change-requests', cr);
const tracePath = path.join(ws, 'specs', spec, 'traceability.yml');

/* ── 前置：cr.md 状态校验（只读）── */
const crMd = readFile(path.join(crDir, 'cr.md'));
if (crMd === null) fail('CR_NOT_FOUND', `cr.md 不存在：${path.join(crDir, 'cr.md')}`);
const crFm = readFrontmatter(crMd);
if (crFm.status !== 'writing-back') {
  fail('CR_STATUS_MISMATCH', `writeback-traceability 要求 CR status=writing-back，当前=${crFm.status}`, { cr });
}

/* ── merge-commits 提取：_backlog.yml 定向提取（只读，六字段齐全性断言）── */
const backlog = readFile(path.join(ws, 'change-requests', '_backlog.yml'));
if (backlog === null) fail('STRUCTURE_MISMATCH', 'change-requests/_backlog.yml 不存在');
const entry = extractBlock(backlog, new RegExp(`^- id: ${escapeRe(cr)}$`));
if (entry === null) fail('MERGE_COMMITS_MISSING', `_backlog.yml 中无 ${cr} 条目`);
const mcBlock = extractBlock(entry.text, /^merge-commits:$/);
if (mcBlock === null) fail('MERGE_COMMITS_MISSING', `${cr} 条目无 merge-commits[]（未合并或未记录）`);
const mergeCommits = [];
{
  let cur = null;
  for (const line of mcBlock.text.split('\n')) {
    const t = line.trimStart();
    if (/^- repo:/.test(t)) { cur = { repo: t.slice(7).trim() }; mergeCommits.push(cur); }
    else if (cur) {
      const m = /^([a-z-]+):\s*(.*)$/.exec(t);
      if (m && m[1] !== 'repo') cur[m[1]] = m[2].replace(/^"|"$/g, '');
    }
  }
}
const REQUIRED = ['repo', 'trunk', 'sha', 'branch', 'source-sha', 'merged-at'];
const missing = mergeCommits.flatMap((mc) => REQUIRED.filter((f) => !mc[f]).map((f) => `${mc.repo}.${f}`));
if (missing.length) {
  fail('MERGE_COMMITS_MISSING', `merge-commits[] 字段不齐全：${missing.join(', ')}（不猜测、不取 trunk 最新提交）`, { cr });
}

/* ── milestone-file：结构校验（cr/milestone/target-version/fr-chain[].fr 必填）── */
const msText = readFile(milestoneFile);
if (msText === null) fail('BAD_ARGS', `--milestone-file 不存在：${milestoneFile}`);
const ms = parseMilestoneFile(msText);
if (!ms.cr || !ms.milestone || !ms['target-version'] || !Array.isArray(ms['fr-chain']) || ms['fr-chain'].length === 0) {
  fail('STRUCTURE_MISMATCH', 'milestone-file 结构缺失：cr/milestone/target-version/fr-chain[].fr 必填', { got: { cr: ms.cr, milestone: ms.milestone, tv: ms['target-version'], frs: ms['fr-chain']?.length } });
}
if (ms.cr !== cr) fail('STRUCTURE_MISMATCH', `milestone-file 的 cr=${ms.cr} 与入参 ${cr} 不一致`);
for (const f of ms['fr-chain']) {
  if (!f.fr) fail('STRUCTURE_MISMATCH', 'fr-chain 条目缺少 fr 字段');
}
// 若 milestone-file 自带 merge-commits，与账本提取结果一致性校验（防人工誊抄分叉）
if (ms['merge-commits']) {
  const inFile = new Set(ms['merge-commits'].split('\n').filter((l) => l.trimStart().startsWith('- repo:')).map((l) => l.trimStart().slice(7).trim()));
  const fromBacklog = new Set(mergeCommits.map((m) => m.repo));
  if (inFile.size !== fromBacklog.size || [...inFile].some((r) => !fromBacklog.has(r))) {
    fail('STRUCTURE_MISMATCH', 'milestone-file 内 merge-commits 与 _backlog.yml 提取结果不一致', { inFile: [...inFile], fromBacklog: [...fromBacklog] });
  }
}

/* ── 幂等判据：specs 侧已含 - cr: {cr} 段 ── */
const old = readFile(tracePath);
if (old !== null && new RegExp(`- cr: ${escapeRe(cr)}$`, 'm').test(old)) {
  ok({ op: 'writeback-traceability', cr, spec, version, noop: true, reason: 'milestone 段已存在' });
  process.exit(0);
}

/* ── 头部字段更新（仅 milestones: 之前的头部区域，里程碑段逐字节保留）── */
function patchHeader(text) {
  if (text === null) return null; // 首次：构造最小头部
  const now = nowIso();
  const mIdx = text.indexOf('\nmilestones:');
  const head = mIdx === -1 ? text : text.slice(0, mIdx);
  const tail = mIdx === -1 ? '' : text.slice(mIdx);
  const lines = head.split('\n');
  const out = [];
  let crHistoryDone = false;
  for (const line of lines) {
    const t = line.trimStart();
    if (/^cr-ref:/.test(t)) { out.push(`cr-ref: ${cr}`); continue; }
    if (/^target-version:/.test(t)) { out.push(`target-version: ${JSON.stringify(version)}`); continue; }
    if (/^generated-at:/.test(t)) { out.push(`generated-at: ${JSON.stringify(now)}`); continue; }
    if (/^cr-history:/.test(t)) {
      const m = /\[([^\]]*)\]/.exec(line);
      const list = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (!list.includes(cr)) list.push(cr);
      out.push(`cr-history: [${list.join(', ')}]`);
      crHistoryDone = true;
      continue;
    }
    out.push(line);
  }
  if (!crHistoryDone) fail('STRUCTURE_MISMATCH', 'traceability.yml 头部缺少 cr-history 字段');
  return out.join('\n') + tail;
}

function buildFirstHeader() {
  return [
    '# specs/' + spec + '/traceability.yml — 累积追溯基线（每个 CR 一段）',
    'spec-id: ' + spec,
    `cr-ref: ${cr}`,
    `cr-history: [${cr}]`,
    `target-version: ${JSON.stringify(version)}`,
    'baseline-since: "' + version + '"',
    `generated-at: ${JSON.stringify(nowIso())}`,
    '',
    'milestones:',
  ].join('\n') + '\n';
}

/* ── milestone 段构造（对齐既有段格式：4 字段 merge-commits + frs）── */
function buildSegment() {
  const lines = [
    `  - cr: ${ms.cr}`,
    `    milestone: ${ms.milestone}`,
    `    target-version: ${JSON.stringify(ms['target-version'])}`,
  ];
  if (ms.status) lines.push(`    status: ${ms.status}`);
  lines.push('    merge-commits:');
  for (const mc of mergeCommits) {
    lines.push(`      - repo: ${mc.repo}`);
    lines.push(`        trunk: ${mc.trunk}`);
    lines.push(`        sha: ${mc.sha}`);
    lines.push(`        branch: ${mc.branch}`);
  }
  lines.push('    frs:');
  for (const f of ms['fr-chain']) {
    lines.push(`      - fr: ${f.fr}`);
    if (f.title !== undefined) lines.push(`        title: ${f.title}`);
    if (f.sdd !== undefined) lines.push(`        sdd: ${f.sdd}`);
    if (f.tasks !== undefined) lines.push(`        tasks: ${f.tasks}`);
    if (f.code !== undefined) lines.push(`        code: ${f.code}`);
    if (f.evidence !== undefined) lines.push(`        evidence: ${f.evidence}`);
  }
  return lines.join('\n');
}

/* ── 主流程 ── */
const now = nowIso();
let newText;
if (old === null) {
  newText = buildFirstHeader() + buildSegment() + '\n';
} else {
  const patched = patchHeader(old);
  newText = patched.replace(/\n*$/, '\n') + buildSegment() + '\n';
}
const res = planWrite(tracePath, newText, { dryRun, label: 'traceability.yml' });

if (dryRun) {
  ok({ op: 'writeback-traceability', cr, spec, version, dryRun: true, mergeCommits: mergeCommits.map((m) => `${m.repo}@${m.sha}`) });
  process.exit(0);
}

/* ── 末尾自检 ── */
const errors = [];
const after = readFile(tracePath) ?? '';
if (!after.includes(`- cr: ${cr}`)) errors.push('milestone 段缺失');
const cnt = (after.match(new RegExp(`- cr: ${escapeRe(cr)}$`, 'gm')) || []).length;
if (cnt !== 1) errors.push(`- cr: ${cr} 段出现 ${cnt} 次`);
const segCount = (after.match(/^\s*- cr: /gm) || []).length;
const segOld = (old ?? '').match(/^\s*- cr: /gm)?.length ?? 0;
if (segCount !== segOld + 1) errors.push(`milestones 段数 ${segCount} != 既有 ${segOld} + 1`);
// 既有 milestones 段（头部之后的正文）逐字节保留：头部字段更新是预期行为，段内容不可改
const oldSeg = old !== null ? old.slice(old.indexOf('milestones:')) : '';
if (oldSeg && !after.includes(oldSeg)) errors.push('既有 milestones 段被改写（应逐字节保留）');
if (after.includes('\r')) errors.push('traceability.yml 含 CRLF');
if (errors.length) fail('SELF_CHECK_FAILED', '自检断言失败：' + errors.join('；'), { errors });

ok({ op: 'writeback-traceability', cr, spec, version, noop: false, mergeCommits: mergeCommits.map((m) => `${m.repo}@${m.sha}`), milestone: ms.milestone });

/* ── 轻量 YAML 解析（milestone-file，结构固定）── */
function parseMilestoneFile(text) {
  const data = { 'fr-chain': [] };
  let cur = null;
  for (const line of text.split('\n')) {
    const t = line.trimStart();
    if (/^- fr:/.test(t)) { cur = { fr: t.slice(5).trim() }; data['fr-chain'].push(cur); continue; }
    const m = /^([a-z-]+):\s*(.*)$/.exec(t);
    if (!m) continue;
    if (m[1] === 'fr-chain') { cur = null; continue; }
    if (cur) cur[m[1]] = stripQ(m[2]);
    else data[m[1]] = stripQ(m[2]);
  }
  return data;
}

function stripQ(v) {
  const s = v.trim();
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

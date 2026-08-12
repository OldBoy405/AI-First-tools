// writeback-traceability.mjs — traceability 回写脚本（CR-2026-020，SDD §4.3 / FR-3、FR-7；CR-2026-031 TASK-08 candidate-only）
// 职责：specs/{spec}/traceability.yml 头部结构化字段更新 + 本 CR milestone 段末尾追加。
//       不是全量重建（SDD §8 D3）：头部手工注释与既有 milestones 段逐字节保留。
// merge-commits：从 change-requests/_backlog.yml 定向提取（六字段齐全性断言，缺失 MERGE_COMMITS_MISSING）；
//       写入 specs 侧时输出与既有段一致的 4 字段（repo/trunk/sha/branch，见 CR-2026-018/019 段先例）。
// 边界（TASK-08 起）：_backlog.yml 只读（账本）；只输出 candidate 目录，由 crctl writeback-apply 应用。
// 用法：node writeback-traceability.mjs --workspace <ws> --cr <CR-ID> --spec <spec_id> --version <ver>
//       --milestone-file <path> --candidate-out <dir>

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  parseArgs, fail, ok, nowIso, readFile, normalize,
  readFrontmatter,
  sha256, readHashRaw, writeCandidate,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const { workspace: ws, cr, spec, version, 'candidate-out': candidateOut } = args;
const milestoneFile = args['milestone-file'];
if (!ws || !cr || !spec || !version || !milestoneFile || !candidateOut) {
  fail('BAD_ARGS', '缺少必填参数 --workspace / --cr / --spec / --version / --milestone-file / --candidate-out');
}
const generatorSha = sha256(fs.readFileSync(new URL(import.meta.url), 'utf8'));
// 版本入参归一（CODE-BLOCK-002）：对齐既有基线 target-version: "0.20.1" 裸值惯例
const verNoV = version.startsWith('v') ? version.slice(1) : version;
const crDir = path.join(ws, 'change-requests', cr);
const tracePath = path.join(ws, 'specs', spec, 'traceability.yml');

/* ── 前置：cr.md 状态校验（只读）── */
const crMd = readFile(path.join(crDir, 'cr.md'));
if (crMd === null) fail('CR_NOT_FOUND', `cr.md 不存在：${path.join(crDir, 'cr.md')}`);
const crFm = readFrontmatter(crMd);
if (crFm.status !== 'writing-back') {
  fail('CR_STATUS_MISMATCH', `writeback-traceability 要求 CR status=writing-back，当前=${crFm.status}`, { cr });
}

/* ── merge-commits 提取（TASK-08 起）：change-requests/{cr}/merge-commits.yml（TASK-07 finalize 产物，
   新协议事实源）——schema merge-commits/v1，repositories[] 含 repo/base-sha/source-sha/merge-sha；
   trunk 从 dir-graph.yaml#repositories 提取；branch 恒为 requirement/{cr}。
   （旧 _backlog.yml 提取路径随 TASK-10 收敛删除，不留永久迁移兼容。）── */
const mcPath = path.join(crDir, 'merge-commits.yml');
const mcText = readFile(mcPath);
if (mcText === null) fail('MERGE_COMMITS_MISSING', `change-requests/${cr}/merge-commits.yml 不存在（未 merge 或 finalize 缺失）`, { cr });
const graphText = readFile(path.join(ws, 'dir-graph.yaml')) ?? '';
const trunkOf = (repoId) => {
  // 轻量提取：repositories 列表中 id 条目后最近的 trunk 行
  const lines = graphText.split('\n');
  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    const mId = /^- id: (\S+)/.exec(t);
    if (mId) { cur = mId[1]; continue; }
    const mTr = /^trunk: (\S+)/.exec(t);
    if (mTr && cur === repoId) return mTr[1];
  }
  return null;
};
const mergeCommits = [];
{
  let cur = null;
  for (const line of mcText.split('\n')) {
    const t = line.trim();
    if (/^- repo:/.test(t)) { cur = { repo: t.slice(7).trim() }; mergeCommits.push(cur); continue; }
    const m = /^([a-z-]+):\s*(\S+)$/.exec(t);
    if (!m || !cur) continue;
    if (m[1] === 'base-sha') cur.baseSha = m[2];
    else if (m[1] === 'source-sha') cur.sourceSha = m[2];
    else if (m[1] === 'merge-sha') cur.mergeSha = m[2];
  }
}
const REQUIRED = ['repo', 'mergeSha'];
const missing = mergeCommits.flatMap((mc) => REQUIRED.filter((f) => !mc[f]).map((f) => `${mc.repo}.${f}`));
if (missing.length) {
  fail('MERGE_COMMITS_MISSING', `merge-commits.yml 字段不齐全：${missing.join(', ')}（不猜测、不取 trunk 最新提交）`, { cr });
}
for (const mc of mergeCommits) {
  mc.trunk = trunkOf(mc.repo) || 'master';
  mc.sha = mc.mergeSha;
  mc.branch = `requirement/${cr}`;
  delete mc.baseSha; delete mc.sourceSha; delete mc.mergeSha;
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
    if (/^target-version:/.test(t)) { out.push(`target-version: ${JSON.stringify(verNoV)}`); continue; }
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
    `target-version: ${JSON.stringify(verNoV)}`,
    'baseline-since: "' + verNoV + '"',
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
    if (mc.branch) lines.push(`        branch: ${mc.branch}`); // 可选字段：有则写，无则省略（对齐既有段格式）
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
let newText;
if (old === null) {
  newText = buildFirstHeader() + buildSegment() + '\n';
} else {
  const patched = patchHeader(old);
  newText = patched.replace(/\n*$/, '\n') + buildSegment() + '\n';
}
const relPath = `specs/${spec}/traceability.yml`;
const { manifest, manifestPath } = writeCandidate({
  candidateOut, stage: 'traceability', cr, specId: spec, targetVersion: verNoV,
  generator: { id: 'writeback-traceability', sha256: generatorSha },
  files: [{ path: relPath, beforeSha256: old == null ? null : readHashRaw(tracePath), afterSha256: null, content: newText }],
  contentOf: () => newText,
});

/* ── 末尾自检（candidate 目录内）── */
const errors = [];
const after = readFile(path.join(candidateOut, relPath)) ?? '';
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

ok({
  op: 'writeback-traceability', cr, spec, version, noop: false,
  candidateDir: candidateOut, manifestPath, inputDigest: manifest.inputDigest,
  files: manifest.files.map((f) => f.path),
  mergeCommits: mergeCommits.map((m) => `${m.repo}@${m.sha}`), milestone: ms.milestone,
});

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

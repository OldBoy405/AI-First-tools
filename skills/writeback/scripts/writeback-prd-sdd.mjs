// writeback-prd-sdd.mjs — PRD/SDD 增量回写脚本（CR-2026-020，SDD §4.1 / FR-1）
// 职责：首次回写整份落地 + frontmatter 补齐；增量回写按里程碑分节追加（原文 H 级 +1）；
//       specs/_index.yml 结构化字段更新（current/cr-ref/updated/cr-history 追加去重，brief 仅显式传入时替换）。
// 边界：change-requests/ 下文件只读（cr.md 仅做状态前置校验）；只写 specs/ 内容文件（NFR-5）。
// 用法：node writeback-prd-sdd.mjs --workspace <ws> --cr <CR-ID> --spec <spec_id> --version <ver>
//       [--milestone-name <名>] [--brief "<text>"] [--dry-run]

import path from 'node:path';
import {
  parseArgs, fail, ok, nowIso, readFile, planWrite,
  splitFrontmatter, readFrontmatter, patchFrontmatterField,
  extractBlock,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const { workspace: ws, cr, spec, version } = args;
if (!ws || !cr || !spec || !version) {
  fail('BAD_ARGS', '缺少必填参数 --workspace / --cr / --spec / --version');
}
const dryRun = !!args['dry-run'];
const milestoneName = args['milestone-name'] || null;
const brief = args.brief !== undefined ? args.brief : null;

const crDir = path.join(ws, 'change-requests', cr);
const specsDir = path.join(ws, 'specs', spec);

/* ── 前置：读 cr.md 校验 status（只读，账本文件不写）── */
const crMd = readFile(path.join(crDir, 'cr.md'));
if (crMd === null) fail('CR_NOT_FOUND', `cr.md 不存在：${path.join(crDir, 'cr.md')}`);
const fm = readFrontmatter(crMd);
if (fm.status !== 'merging') {
  fail('CR_STATUS_MISMATCH', `writeback-prd-sdd 要求 CR status=merging，当前=${fm.status}`, { cr });
}

const prdSrc = readFile(path.join(crDir, 'prd.md'));
const sddSrc = readFile(path.join(crDir, 'sdd.md'));
if (prdSrc === null || sddSrc === null) {
  fail('BAD_ARGS', `change-requests/${cr}/prd.md 或 sdd.md 不存在`, { prd: prdSrc !== null, sdd: sddSrc !== null });
}

const srcTitle = readFrontmatter(prdSrc).title || cr;
const heading = `## ${milestoneName ?? srcTitle}（v${version} · ${cr}）`; // cr 为完整 ID（如 CR-2026-020），不加前缀
const versionLabel = version.startsWith('v') ? version : `v${version}`;

/* ── 里程碑节构造：去 frontmatter、正文 H 级 +1、冠以标题行 ── */
function buildMilestoneSection(srcDoc) {
  const body = splitFrontmatter(srcDoc).body.replace(/^\n+/, '').replace(/\n+$/, '');
  const shifted = body
    .split('\n')
    .map((l) => (l.startsWith('#') ? `#${l}` : l))
    .join('\n');
  return `\n${heading}\n\n${shifted}\n`;
}

/* ── 首次回写：frontmatter 补齐 + 正文以里程碑节形态落地（与真实基线 M0 节先例一致）── */
function buildFirstWrite(srcDoc) {
  const srcFm = splitFrontmatter(srcDoc);
  let fmText = `---\n${srcFm.block}\n---\n`;
  // 字段补齐/更新（spec-id/version/status/cr-ref/cr-history/target-version），其余保留
  const patches = [
    ['spec-id', spec],
    ['version', versionLabel],
    ['status', 'ga'],
    ['cr-ref', cr],
    ['cr-history', `[${cr}]`],
    ['target-version', version],
  ];
  for (const [f, v] of patches) fmText = patchFrontmatterField(fmText, f, v);
  return `${fmText}${buildMilestoneSection(srcDoc)}\n`;
}

/* ── 幂等判据：里程碑标题行已存在（（v{version} · CR-{cr} 唯一标识）── */
function hasMilestone(doc) {
  const probe = `（v${version} · ${cr}`;
  return doc.includes(probe);
}

/* ── specs/_index.yml：结构化字段更新 ── */
function buildIndex(indexPath, now) {
  const text = readFile(indexPath) ?? null;
  if (text === null) fail('STRUCTURE_MISMATCH', `specs/_index.yml 不存在：${indexPath}`);
  const lines = text.split('\n');
  const blk = extractBlock(text, new RegExp(`^- id: ${escapeRe(spec)}$`));
  if (blk === null) {
    // 新 spec：在 features: 行后插入条目
    const featLine = lines.findIndex((l) => l.trimStart() === 'features:');
    if (featLine === -1) fail('STRUCTURE_MISMATCH', 'specs/_index.yml 缺少 features: 列表');
    const title = readFrontmatter(prdSrc).title || spec;
    const entry = [
      `  - id: ${spec}`,
      `    name: ${title}`,
      '    scope: product',
      '    status: ga',
      `    since: ${version}`,
      `    current: ${version}`,
      '    brief: ""',
      `    cr-ref: ${cr}`,
      `    cr-history: [${cr}]`,
      `    updated: ${JSON.stringify(now)}`,
    ];
    lines.splice(featLine + 1, 0, ...entry);
    return lines.join('\n');
  }
  const blkLines = blk.text.split('\n');
  const out = [];
  let crHistoryDone = false;
  for (const line of blkLines) {
    const indent = (line.match(/^ */) || [''])[0]; // 保留条目缩进
    const t = line.trimStart();
    if (/^current:/.test(t)) { out.push(`${indent}current: ${JSON.stringify(version)}`); continue; }
    if (/^cr-ref:/.test(t)) { out.push(`${indent}cr-ref: ${cr}`); continue; }
    if (/^updated:/.test(t)) { out.push(`${indent}updated: ${JSON.stringify(now)}`); continue; }
    if (/^cr-history:/.test(t)) {
      const list = parseList(line);
      if (!list.includes(cr)) list.push(cr);
      out.push(`${indent}cr-history: [${list.join(', ')}]`);
      crHistoryDone = true;
      continue;
    }
    if (brief !== null && /^brief:/.test(t)) {
      out.push(`${indent}brief: ${JSON.stringify(brief)}`); // 整行替换（含后续折叠行由外层裁剪）
      continue;
    }
    out.push(line);
  }
  if (!crHistoryDone) fail('STRUCTURE_MISMATCH', `specs/_index.yml 条目 ${spec} 缺少 cr-history 字段`);
  // 替换块（含 brief 折叠行的后续行：块内非字段行已在 blkLines，替换后重新拼接）
  const newBlk = out.join('\n');
  lines.splice(blk.start, blk.end - blk.start, ...newBlk.split('\n'));
  return lines.join('\n');
}

function parseList(line) {
  const m = /\[([^\]]*)\]/.exec(line);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter((s) => s !== '');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ── 主流程 ── */
function run() {
  const now = nowIso();
  const targets = [];
  let allNoop = true;

  for (const [kind, src] of [['PRD', prdSrc], ['SDD', sddSrc]]) {
    const target = path.join(specsDir, `${kind}.md`);
    const old = readFile(target);
    let newText;
    let noop = false;
    if (old === null) {
      newText = buildFirstWrite(src);
    } else if (hasMilestone(old)) {
      noop = true;
      newText = old;
    } else {
      newText = old.replace(/\n*$/, '\n') + buildMilestoneSection(src);
    }
    if (!noop) allNoop = false;
    const res = planWrite(target, newText, { dryRun, label: `${kind}.md` });
    targets.push({ kind, changed: res.changed || !noop, noop, written: res.written });
  }

  const indexPath = path.join(ws, 'specs', '_index.yml');
  const indexNew = buildIndex(indexPath, now);
  const indexOld = readFile(indexPath) ?? '';
  if (indexOld !== indexNew) allNoop = false;
  if (dryRun) {
    if (indexOld !== indexNew) process.stdout.write('--- specs/_index.yml\n' + diffOnly(indexOld, indexNew) + '\n');
  } else if (indexOld !== indexNew) {
    planWrite(indexPath, indexNew, { dryRun: false });
  }

  if (allNoop) {
    ok({ op: 'writeback-prd-sdd', cr, spec, version, noop: true, reason: '里程碑标题已存在，无需回写' });
    return;
  }
  if (dryRun) {
    ok({ op: 'writeback-prd-sdd', cr, spec, version, dryRun: true, targets });
    return;
  }

  // 末尾自检（SELF_CHECK_FAILED）
  selfCheck();
  ok({ op: 'writeback-prd-sdd', cr, spec, version, noop: false, targets });
}

function diffOnly(a, b) {
  const al = a.split('\n'); const bl = b.split('\n');
  let pre = 0;
  while (pre < al.length && pre < bl.length && al[pre] === bl[pre]) pre++;
  let suf = 0;
  while (suf < al.length - pre && suf < bl.length - pre && al[al.length - 1 - suf] === bl[bl.length - 1 - suf]) suf++;
  const out = [];
  for (const l of al.slice(pre, al.length - suf)) out.push(`- ${l}`);
  for (const l of bl.slice(pre, bl.length - suf)) out.push(`+ ${l}`);
  return out.join('\n');
}

function selfCheck() {
  const errors = [];
  for (const kind of ['PRD', 'SDD']) {
    const t = readFile(path.join(specsDir, `${kind}.md`));
    if (t === null) { errors.push(`${kind}.md 不存在`); continue; }
    const first = t.indexOf(heading);
    const last = t.lastIndexOf(heading);
    if (first === -1 || first !== last) errors.push(`${kind}.md 里程碑标题 ${heading} 出现 ${first === -1 ? 0 : '多次'} 次`);
    if (t.includes('\r')) errors.push(`${kind}.md 含 CRLF`);
  }
  const idx = readFile(path.join(ws, 'specs', '_index.yml')) ?? '';
  if ((idx.match(new RegExp(`- id: ${escapeRe(spec)}$`, 'gm')) || []).length !== 1) {
    errors.push(`specs/_index.yml 中 ${spec} 条目数 != 1`);
  }
  if (errors.length) fail('SELF_CHECK_FAILED', '自检断言失败：' + errors.join('；'), { errors });
}

run();

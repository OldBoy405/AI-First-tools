// writeback-traceability.mjs — traceability 回写脚本（CR-2026-020，SDD §4.3 / FR-3、FR-7；
//   CR-2026-031 TASK-08 candidate-only；CR-2026-041 归档可信化）
// 职责：specs/{spec}/traceability.yml 头部结构化字段更新 + 本 CR milestone 段末尾追加（含最小证据摘要 evidence）。
//       不是全量重建（SDD §8 D3）：头部手工注释与既有 milestones 段逐字节保留。
// merge-commits：从 change-requests/{cr}/merge-commits.yml 定向提取（repo/merge-sha 齐全性断言，缺失 MERGE_COMMITS_MISSING）；
//       写入 specs 侧时输出与既有段一致的 4 字段（repo/trunk/sha/branch，见 CR-2026-018/019 段先例）。
// evidence：从 7 份 canonical 证据文件（test/reviews×4/approval/merge）读取并注入最小证据摘要（FR-11/CR-2026-041）；
//       唯一校验函数 validateMilestoneEvidence 供正常生成自检与 crctl archive 内部 --validate-evidence 模式复用。
// 边界（TASK-08 起）：_backlog.yml 只读（账本）；只输出 candidate 目录，由 crctl writeback-apply 应用。
// 用法：node writeback-traceability.mjs --workspace <ws> --cr <CR-ID> --spec <spec_id> --version <ver>
//       --milestone-file <path> --candidate-out <dir>
//       # archive 内部校验模式（只读 specs/{spec}/traceability.yml，零 candidate/状态/文件写入）：
//       node writeback-traceability.mjs --validate-evidence --workspace <ws> --cr <CR-ID> --spec <spec_id>

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  parseArgs, fail, ok, nowIso, readFile, normalize,
  readFrontmatter, extractBlock,
  sha256, readHashRaw, writeCandidate,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const { workspace: ws, cr, spec, version, 'candidate-out': candidateOut } = args;
const milestoneFile = args['milestone-file'];

const generatorSha = sha256(fs.readFileSync(new URL(import.meta.url), 'utf8'));

/* ── 确定性证据契约常量（CR-2026-041，FR-11/FR-12；须在顶部定义，供主流程与 validator 共用）── */
// 固定 evidence key → path map（SDD §2.2）：evidence 中的 path 必须与此精确相等，containment 只是额外防护
const EVIDENCE_PATHS = {
  test: (cr) => `change-requests/${cr}/test-report.md`,
  'reviews.requirement': (cr) => `change-requests/${cr}/review-annotations/requirement.yml`,
  'reviews.tech-design': (cr) => `change-requests/${cr}/review-annotations/sdd.yml`,
  'reviews.dev-plan': (cr) => `change-requests/${cr}/review-annotations/dev-plan.yml`,
  'reviews.code': (cr) => `change-requests/${cr}/review-annotations/code.yml`,
  approval: (cr) => `change-requests/${cr}/approval.yml`,
  merge: (cr) => `change-requests/${cr}/merge-commits.yml`,
};
const REVIEW_STAGES = ['requirement', 'tech-design', 'dev-plan', 'code'];
const REVIEW_FILES = { requirement: 'requirement.yml', 'tech-design': 'sdd.yml', 'dev-plan': 'dev-plan.yml', code: 'code.yml' };
const APPROVAL_GRANTS = ['requirement', 'tech-design', 'development-start', 'code'];
const APPROVAL_VIA = ['crctl-approve', 'server-approve'];

/* ── archive 内部校验模式（CR-2026-041 FR-04）：只读 specs traceability，零 candidate/状态/文件写入 ── */
if (args['validate-evidence'] === true) {
  if (!ws || !cr || !spec) {
    fail('BAD_ARGS', '--validate-evidence 需要 --workspace / --cr / --spec');
  }
  const traceText = readFile(path.join(ws, 'specs', spec, 'traceability.yml'));
  if (traceText === null) {
    fail('EVIDENCE_MISSING', `specs/${spec}/traceability.yml 不存在（traceability 回写未完成）`, { cr, specId: spec });
  }
  validateMilestoneEvidence({ traceText, cr, specId: spec, editRoot: ws });
  ok({ op: 'validate-evidence', cr, spec, ok: true });
  process.exit(0);
}

if (!ws || !cr || !spec || !version || !milestoneFile || !candidateOut) {
  fail('BAD_ARGS', '缺少必填参数 --workspace / --cr / --spec / --version / --milestone-file / --candidate-out');
}
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

/* ── merge-commits 提取：change-requests/{cr}/merge-commits.yml（merge 事实源）
   trunk 从 dir-graph.yaml#repositories 提取，缺失硬失败 TRUNK_UNKNOWN（FR-12，无 master 回退）；
   branch 恒为 requirement/{cr}。 ── */
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
const mergeCommits = parseMergeCommits(mcText);
const REQUIRED = ['repo', 'mergeSha'];
const missing = mergeCommits.flatMap((mc) => REQUIRED.filter((f) => !mc[f]).map((f) => `${mc.repo}.${f}`));
if (missing.length) {
  fail('MERGE_COMMITS_MISSING', `merge-commits.yml 字段不齐全：${missing.join(', ')}（不猜测、不取 trunk 最新提交）`, { cr });
}
for (const mc of mergeCommits) {
  const trunk = trunkOf(mc.repo);
  if (trunk === null) fail('TRUNK_UNKNOWN', `dir-graph.yaml#repositories 缺少 ${mc.repo} 的 trunk 条目（禁止回退 master）`, { cr, repo: mc.repo });
  mc.trunk = trunk;
  mc.sha = mc.mergeSha;
  mc.branch = `requirement/${cr}`;
  delete mc.baseSha; delete mc.sourceSha; delete mc.mergeSha;
}

/* ── milestone-file：结构校验（cr/milestone/target-version/fr-chain[].fr 必填；无 status）── */
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
  const fromMergeCommits = new Set(mergeCommits.map((m) => m.repo));
  if (inFile.size !== fromMergeCommits.size || [...inFile].some((r) => !fromMergeCommits.has(r))) {
    fail('STRUCTURE_MISMATCH', 'milestone-file 内 merge-commits 与 merge-commits.yml 提取结果不一致', { inFile: [...inFile], fromMergeCommits: [...fromMergeCommits] });
  }
}

/* ── 幂等判据：specs 侧已含 - cr: {cr} 段 ── */
const old = readFile(tracePath);
if (old !== null && new RegExp(`- cr: ${escapeRe(cr)}$`, 'm').test(old)) {
  ok({ op: 'writeback-traceability', cr, spec, version, noop: true, reason: 'milestone 段已存在' });
  process.exit(0);
}

/* ── evidence 输入（FR-11：test/reviews×4/approval/merge 七项最小证据摘要）── */
const evidence = readEvidenceInputs(crDir, cr);

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

/* ── milestone 段构造（对齐既有段格式：4 字段 merge-commits + frs + evidence；无 status）── */
function buildSegment(evidence) {
  const lines = [
    `  - cr: ${ms.cr}`,
    `    milestone: ${ms.milestone}`,
    `    target-version: ${JSON.stringify(ms['target-version'])}`,
  ];
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
  lines.push('    evidence:');
  lines.push(`      test: { status: ${evidence.test.status}, path: ${evidence.test.path}, sha256: ${evidence.test.sha256} }`);
  lines.push('      reviews:');
  for (const [stage, r] of Object.entries(evidence.reviews)) {
    lines.push(`        ${stage}: { verdict: ${r.verdict}, path: ${r.path}, sha256: ${r.sha256} }`);
  }
  lines.push(`      approval: { status: ${evidence.approval.status}, path: ${evidence.approval.path}, sha256: ${evidence.approval.sha256} }`);
  lines.push(`      merge: { status: ${evidence.merge.status}, path: ${evidence.merge.path}, sha256: ${evidence.merge.sha256} }`);
  return lines.join('\n');
}

/* ── 主流程 ── */
let newText;
if (old === null) {
  newText = buildFirstHeader() + buildSegment(evidence) + '\n';
} else {
  const patched = patchHeader(old);
  newText = patched.replace(/\n*$/, '\n') + buildSegment(evidence) + '\n';
}
// 生成后自检：用与 archive gate 同一 validator 校验 candidate 文本（FR-04 唯一函数）
validateMilestoneEvidence({ traceText: newText, cr, specId: spec, editRoot: ws });

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
// evidence 块：仅新 milestone 段恰好一次（FR-01）
const newSeg = extractBlock(after, new RegExp(`^- cr: ${escapeRe(cr)}$`));
if (!newSeg || !/^\s*evidence:\s*$/m.test(newSeg.text)) errors.push('新 milestone 段缺少 evidence 块');
if (errors.length) fail('SELF_CHECK_FAILED', '自检断言失败：' + errors.join('；'), { errors });

ok({
  op: 'writeback-traceability', cr, spec, version, noop: false,
  candidateDir: candidateOut, manifestPath, inputDigest: manifest.inputDigest,
  files: manifest.files.map((f) => f.path),
  mergeCommits: mergeCommits.map((m) => `${m.repo}@${m.sha}`), milestone: ms.milestone,
  evidence: evidenceKeys(evidence),
});

/* ════════════════ 确定性证据契约（CR-2026-041，FR-11/FR-12）════════════════ */

function evidenceKeys(ev) {
  return {
    test: ev.test?.status, reviews: Object.fromEntries(Object.entries(ev.reviews || {}).map(([k, v]) => [k, v.verdict])),
    approval: ev.approval?.status, merge: ev.merge?.status,
  };
}

// 读取 7 份 canonical 证据文件并生成 evidence 对象（含 LF digest）。任一缺失/状态不通过/结构非法 → fail('EVIDENCE_INVALID')。
function readEvidenceInputs(crDir, cr) {
  // test：test-report.md frontmatter status 必须 'pass'
  const testRel = EVIDENCE_PATHS.test(cr);
  const testText = readFile(path.join(crDir, 'test-report.md'));
  if (testText === null) fail('EVIDENCE_INVALID', `证据缺失：${testRel}`, { cr, key: 'test' });
  const testFm = readFrontmatter(testText);
  if (testFm.status !== 'pass') fail('EVIDENCE_INVALID', `test-report.md status=${testFm.status ?? '(缺失)'}，必须 pass`, { cr, key: 'test' });

  // reviews：四份 review-annotations verdict 必须 'pass'
  const reviews = {};
  for (const stage of REVIEW_STAGES) {
    const rel = EVIDENCE_PATHS[`reviews.${stage}`](cr);
    const text = readFile(path.join(crDir, 'review-annotations', REVIEW_FILES[stage]));
    if (text === null) fail('EVIDENCE_INVALID', `证据缺失：${rel}`, { cr, key: `reviews.${stage}` });
    const verdict = topField(text, 'verdict');
    if (verdict !== 'pass') fail('EVIDENCE_INVALID', `reviews.${stage} verdict=${verdict ?? '(缺失)'}，必须 pass`, { cr, key: `reviews.${stage}` });
    reviews[stage] = { verdict: 'pass', path: rel, sha256: sha256(text) };
  }

  // approval：四段 grant 齐全且 via ∈ {crctl-approve, server-approve} → 'approved'
  const approvalRel = EVIDENCE_PATHS.approval(cr);
  const approvalText = readFile(path.join(crDir, 'approval.yml'));
  if (approvalText === null) fail('EVIDENCE_INVALID', `证据缺失：${approvalRel}`, { cr, key: 'approval' });
  const grants = approvalGrants(approvalText);
  const missingGrant = APPROVAL_GRANTS.filter((g) => !(grants[g] && APPROVAL_VIA.includes(grants[g].via)));
  if (missingGrant.length) fail('EVIDENCE_INVALID', `approval.yml 缺少 grant（${missingGrant.join(', ')}）或 via 非法`, { cr, key: 'approval', missingGrant });

  // merge：repositories[] 非空且每项含 repo+merge-sha → 'merged'
  const mergeRel = EVIDENCE_PATHS.merge(cr);
  const mergeText = readFile(path.join(crDir, 'merge-commits.yml'));
  if (mergeText === null) fail('EVIDENCE_INVALID', `证据缺失：${mergeRel}`, { cr, key: 'merge' });
  const mcs = parseMergeCommits(mergeText);
  if (mcs.length === 0 || mcs.some((m) => !m.repo || !m.mergeSha)) fail('EVIDENCE_INVALID', 'merge-commits.yml repositories 为空或缺 repo/merge-sha', { cr, key: 'merge' });

  return {
    test: { status: 'pass', path: testRel, sha256: sha256(testText) },
    reviews,
    approval: { status: 'approved', path: approvalRel, sha256: sha256(approvalText) },
    merge: { status: 'merged', path: mergeRel, sha256: sha256(mergeText) },
  };
}

// 唯一证据校验函数（正常生成自检 + crctl archive --validate-evidence 共用）。
// 从 traceText 定位当前 CR 的 milestone 段 → 解析 evidence 块 → 按固定 path map 重读源文件重算 digest 与状态/事实。
function validateMilestoneEvidence({ traceText, cr, specId, editRoot }) {
  const crRe = new RegExp(`^- cr: ${escapeRe(cr)}$`);
  const seg = extractBlock(traceText, crRe);
  if (!seg) fail('EVIDENCE_MISSING', `traceability.yml 缺少 - cr: ${cr} milestone 段`, { cr, specId });
  const cnt = (traceText.match(new RegExp(`^\\s*- cr: ${escapeRe(cr)}$`, 'gm')) || []).length;
  if (cnt !== 1) fail('EVIDENCE_DUPLICATE', `- cr: ${cr} 段出现 ${cnt} 次（期望 1）`, { cr, specId, cnt });

  const ev = parseEvidence(seg.text);
  if (!ev || !ev.test || !ev.approval || !ev.merge || !ev.reviews) fail('EVIDENCE_MISSING', `milestone 段缺少 evidence 块或七项不齐`, { cr, specId });
  for (const stage of REVIEW_STAGES) {
    if (!ev.reviews[stage]) fail('EVIDENCE_MISSING', `evidence 缺 reviews.${stage}`, { cr, specId });
  }

  // 逐项：path 精确匹配固定 map + 重读源文件重算 digest + status/verdict 派生值
  const r1 = verifyItem('test', ev.test, 'status', 'pass', cr, editRoot);
  if (r1) fail(r1.code, r1.message, { cr, specId, key: 'test' });
  for (const stage of REVIEW_STAGES) {
    const r = verifyItem(`reviews.${stage}`, ev.reviews[stage], 'verdict', 'pass', cr, editRoot);
    if (r) fail(r.code, r.message, { cr, specId, key: `reviews.${stage}` });
  }
  const r2 = verifyItem('approval', ev.approval, 'status', 'approved', cr, editRoot);
  if (r2) fail(r2.code, r2.message, { cr, specId, key: 'approval' });
  const r3 = verifyItem('merge', ev.merge, 'status', 'merged', cr, editRoot);
  if (r3) fail(r3.code, r3.message, { cr, specId, key: 'merge' });

  // 事实校验（不信任 evidence 自报派生值，重读源文件核对）
  const approvalText = readFile(path.join(editRoot, ...EVIDENCE_PATHS.approval(cr).split('/')));
  const grants = approvalGrants(approvalText ?? '');
  const missingGrant = APPROVAL_GRANTS.filter((g) => !(grants[g] && APPROVAL_VIA.includes(grants[g].via)));
  if (missingGrant.length) fail('EVIDENCE_STATE', `approval.yml 缺少 grant（${missingGrant.join(', ')}）或 via 非法`, { cr, specId, missingGrant });

  const mergeText = readFile(path.join(editRoot, ...EVIDENCE_PATHS.merge(cr).split('/')));
  const mcs = parseMergeCommits(mergeText ?? '');
  if (mcs.length === 0 || mcs.some((m) => !m.repo || !m.mergeSha)) fail('EVIDENCE_STATE', 'merge-commits.yml repositories 为空或缺 repo/merge-sha', { cr, specId });

  return { ok: true, cr, specId };
}

// 校验单条证据：path 与固定 map 精确相等 → 重读源文件重算 LF digest → 派生字段匹配。
// 返回 { code, message } 或 null（通过）。
function verifyItem(key, item, field, expectVal, cr, editRoot) {
  const wantPath = EVIDENCE_PATHS[key](cr);
  if (item.path !== wantPath) return { code: 'EVIDENCE_PATH_INVALID', message: `evidence.${key}.path=${item.path} 与固定 map ${wantPath} 不符` };
  const abs = path.join(editRoot, ...wantPath.split('/'));
  const text = readFile(abs);
  if (text === null) return { code: 'EVIDENCE_MISSING', message: `evidence.${key} 源文件不存在：${wantPath}` };
  const digest = sha256(text);
  if (digest !== item.sha256) return { code: 'EVIDENCE_DRIFT', message: `evidence.${key} digest 漂移：${item.sha256} != ${digest}` };
  if (item[field] !== expectVal) return { code: 'EVIDENCE_STATE', message: `evidence.${key}.${field}=${item[field]} != ${expectVal}` };
  return null;
}

// 从 milestone 段文本解析 evidence 块（flow map 行级解析，仅结构固定字段，零依赖）。
function parseEvidence(segText) {
  const lines = segText.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*evidence:\s*$/.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  const evIndent = (lines[start].match(/^ */) || [''])[0].length;
  const out = { reviews: {} };
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    const li = (l.match(/^ */) || [''])[0].length;
    if (li <= evIndent) break;
    const t = l.trim();
    let m = t.match(/^test:\s*(\{.*\})$/);
    if (m) { out.test = parseFlowMap(m[1]); continue; }
    m = t.match(/^(requirement|tech-design|dev-plan|code):\s*(\{.*\})$/);
    if (m) { out.reviews[m[1]] = parseFlowMap(m[2]); continue; }
    m = t.match(/^approval:\s*(\{.*\})$/);
    if (m) { out.approval = parseFlowMap(m[1]); continue; }
    m = t.match(/^merge:\s*(\{.*\})$/);
    if (m) { out.merge = parseFlowMap(m[1]); continue; }
  }
  if (!out.test || !out.approval || !out.merge || REVIEW_STAGES.some((s) => !out.reviews[s])) return null;
  return out;
}

// flow map `{ k: v, k2: v2 }` 行级解析（值不引号，仅 status/verdict/path/sha256 四类字段）。
function parseFlowMap(s) {
  const m = /\{(.*)\}/.exec(s.trim());
  if (!m) return null;
  const fields = {};
  for (const part of m[1].split(',')) {
    const kv = part.trim().match(/^([a-z0-9-]+):\s*(.+)$/);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return fields;
}

// merge-commits.yml 行级解析：顶层/嵌套 `- repo:` 序列项（repo/base-sha/source-sha/merge-sha）。
function parseMergeCommits(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^- repo:/.test(t)) { cur = { repo: t.slice(7).trim() }; out.push(cur); continue; }
    const m = /^([a-z-]+):\s*(\S+)$/.exec(t);
    if (!m || !cur) continue;
    if (m[1] === 'base-sha') cur.baseSha = m[2];
    else if (m[1] === 'source-sha') cur.sourceSha = m[2];
    else if (m[1] === 'merge-sha') cur.mergeSha = m[2];
  }
  return out;
}

// approval.yml 四段 grant 行级解析：顶层 `stage:` 段 + 段内 `via:`。
function approvalGrants(text) {
  const result = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const seg = line.match(/^([a-z-]+):\s*$/);
    if (seg && APPROVAL_GRANTS.includes(seg[1])) { cur = seg[1]; result[cur] = { via: null }; continue; }
    if (cur) {
      const via = line.match(/^\s+via:\s*(\S+)/);
      if (via) result[cur].via = via[1];
    }
  }
  return result;
}

// 顶层 `key: value` 行读取（review-annotations 的 verdict）。
function topField(text, field) {
  for (const line of text.split('\n')) {
    const m = new RegExp(`^${field}:\\s*(.+)$`).exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

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

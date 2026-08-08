#!/usr/bin/env node
/**
 * check-skill-matrix.mjs — 校验 skills/_index.yml、agent-skill-matrix.yml、
 * AGENT-SKILL-MATRIX.md 三份归属声明的一致性（架构评审 §5.2：双源漂移风险）。
 *
 * 检查项：
 *   1. 每个 active skill 在 agent-skill-matrix.yml 中恰有一个 owns 归属（非 0、非多个）
 *   2. agent-skill-matrix.yml 里的 owns 目标要么在 _index.yml 注册，要么在某 actor 的 external 里声明
 *   3. AGENT-SKILL-MATRIX.md 的"主责矩阵"表格与 agent-skill-matrix.yml 的 owns 完全一致（md 应由 yml 派生，不应手改漂移）
 *   4. 每个 actor 级 external 声明必须在扫描范围内（skills/ + pipeline-templates/ 的 .md/.json，
 *      排除 openwiki/old/node_modules/.git）有至少一处引用点，零引用即报错（CR-2026-025 FR-1/FR-2；
 *      D-2：actor 级 external 是唯一被解析的声明位置，顶层 external-skills 纯文档块不参与）
 *
 * 零依赖（仅 node: 内置模块），退出码非 0 = 发现不一致，可接入 CI / pre-commit。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const errors = [];

/** 纪律 #1（CR-2026-025 FR-3）：所有文本读入点统一先 \r\n → \n 规范化，逐行解析用 split(/\r?\n/)。 */
function readNorm(p) {
  return fs.readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
}

// ── 1. 解析 skills/_index.yml：active skill id 集合 ──────────────────────
const indexText = readNorm(path.join(root, 'skills/_index.yml'));
const activeSkills = new Set();
{
  let curId = null;
  for (const line of indexText.split(/\r?\n/)) {
    const idM = line.match(/^\s*-\s*id:\s*(\S+)/);
    if (idM) { curId = idM[1]; continue; }
    const statusM = line.match(/^\s*status:\s*(\w+)/);
    if (statusM && curId) { if (statusM[1] === 'active') activeSkills.add(curId); curId = null; }
  }
}
// 解析 shape 硬失败（TD-BL-2/不变量 4）：仓库不可能无 active skill，必是解析失效，禁止静默降级为空集合
if (activeSkills.size === 0) {
  console.error('解析失效：skills/_index.yml 未解析出任何 active skill（空结构守卫），退出');
  process.exit(1);
}

// ── 2. 解析 agent-skill-matrix.yml：actor -> owns[] / external[] ─────────
const matrixText = readNorm(path.join(root, 'agent-skill-matrix.yml'));
const ownsByActor = {};
const externalSkills = new Set();
const externalByActor = {}; // CR-2026-025 FR-3：记录声明 actor，供检查 4 错误文案（检查 2 继续用全局集合）
{
  let actor = null, section = null;
  for (const line of matrixText.split(/\r?\n/)) {
    const actorM = line.match(/^  (\S[\w-]*):\s*$/);
    if (actorM && !/^\s*(owns|can-call|external|forbidden):/.test(line)) { actor = actorM[1]; section = null; continue; }
    const sectionM = line.match(/^    (owns|can-call|external|forbidden):/);
    if (sectionM) { section = sectionM[1]; continue; }
    const itemM = line.match(/^      -\s*(\S+)\s*$/);
    if (itemM && actor && section === 'owns') (ownsByActor[actor] ??= []).push(itemM[1]);
    if (itemM && actor && section === 'external') {
      externalSkills.add(itemM[1]);
      (externalByActor[itemM[1]] ??= []).push(actor);
    }
  }
}
if (Object.keys(ownsByActor).length === 0) {
  console.error('解析失效：agent-skill-matrix.yml 未解析出任何 actor 的 owns（空结构守卫），退出');
  process.exit(1);
}
const ownerOfSkill = {};
for (const [actor, skills] of Object.entries(ownsByActor)) {
  for (const s of skills) (ownerOfSkill[s] ??= []).push(actor);
}

// ── 3. 解析 AGENT-SKILL-MATRIX.md 的"主责矩阵"表格 ───────────────────────
const mdText = readNorm(path.join(root, 'AGENT-SKILL-MATRIX.md'));
const mdOwnsByActor = {};
{
  const section = mdText.split('## 主责矩阵')[1]?.split(/^## /m)[0] ?? '';
  const rowRe = /^\|\s*`([\w-]+)`\s*\|\s*(.+?)\s*\|$/gm;
  let m;
  let rowCount = 0;
  while ((m = rowRe.exec(section))) {
    rowCount += 1;
    mdOwnsByActor[m[1]] = m[2].split(',').map((s) => s.trim().replace(/^`|`$/g, '')).filter(Boolean);
  }
  if (rowCount === 0) {
    console.error('解析失效：AGENT-SKILL-MATRIX.md 未解析到主责矩阵表格行（空结构守卫），退出');
    process.exit(1);
  }
}

// ── 检查 1：每个 active skill 恰有一个 owns 归属 ─────────────────────────
for (const skill of activeSkills) {
  const owners = ownerOfSkill[skill] || [];
  if (owners.length === 0) errors.push(`[缺归属] active skill "${skill}" 在 agent-skill-matrix.yml 中没有任何 owns 归属`);
  if (owners.length > 1) errors.push(`[多重归属] skill "${skill}" 被 ${owners.join(' 与 ')} 同时 owns（应唯一）`);
}

// ── 检查 2：owns 目标要么已注册，要么声明为 external ─────────────────────
for (const [skill, owners] of Object.entries(ownerOfSkill)) {
  if (!activeSkills.has(skill) && !externalSkills.has(skill)) {
    errors.push(`[目标缺失] ${owners.join('/')} owns 的 "${skill}" 既不在 skills/_index.yml（active）中，也未在任何 actor 的 external 列表声明`);
  }
}

// ── 检查 3：md 表格与 yml 的 owns 完全一致 ───────────────────────────────
const allActors = new Set([...Object.keys(ownsByActor), ...Object.keys(mdOwnsByActor)]);
for (const actor of allActors) {
  const ymlSet = new Set(ownsByActor[actor] || []);
  const mdSet = new Set(mdOwnsByActor[actor] || []);
  const onlyInYml = [...ymlSet].filter((s) => !mdSet.has(s));
  const onlyInMd = [...mdSet].filter((s) => !ymlSet.has(s));
  if (onlyInYml.length) errors.push(`[md 漂移] actor "${actor}" 的 owns 在 yml 里有但 md 表格缺：${onlyInYml.join(', ')}`);
  if (onlyInMd.length) errors.push(`[md 漂移] actor "${actor}" 的 owns 在 md 表格里有但 yml 缺：${onlyInMd.join(', ')}`);
}

// ── 检查 4：external 引用点校验（CR-2026-025 FR-1/FR-2，D-1 全局名级：同一名称有 ≥1 引用点即通过）──
const scanRoots = ['skills', 'pipeline-templates'];
const excludeDirs = new Set(['openwiki', 'old', 'node_modules', '.git']); // FR-2 目录级排除
const selfFiles = new Set(['agent-skill-matrix.yml', 'AGENT-SKILL-MATRIX.md']); // 声明面不自证（FR-2）
function walkFiles(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excludeDirs.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkFiles(p));
    else if (e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.json')) && !selfFiles.has(e.name)) out.push(p);
  }
  return out;
}
const scanFiles = scanRoots.flatMap((r) => {
  const p = path.join(root, r);
  return fs.existsSync(p) ? walkFiles(p) : [];
});
const referenceCount = {};
for (const f of scanFiles) {
  const text = readNorm(f); // 子串匹配，与 CR-2026-024 认定死声明时所用口径一致（I-3）
  for (const name of Object.keys(externalByActor)) {
    if (text.includes(name)) referenceCount[name] = (referenceCount[name] || 0) + 1;
  }
}
for (const [name, actors] of Object.entries(externalByActor)) {
  if (!referenceCount[name]) {
    errors.push(`[零引用点] external "${name}" 由 ${actors.join('、')} 声明，但扫描范围内（skills/ + pipeline-templates/，排除 openwiki/old）无任何引用点`);
  }
}

// ── 输出 ──────────────────────────────────────────────────────────────
if (errors.length) {
  console.error(`skill matrix 一致性校验失败（${errors.length} 项）：\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
} else {
  console.log(`skill matrix 一致性校验通过：${activeSkills.size} 个 active skill，${Object.keys(ownsByActor).length} 个 actor，owns 归属与 md 表格均一致，external 引用点齐全。`);
}

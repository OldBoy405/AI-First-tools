#!/usr/bin/env node
/**
 * check-skill-matrix.mjs — 校验 skills/_index.yml、agent-skill-matrix.yml、
 * AGENT-SKILL-MATRIX.md 三份归属声明的一致性（架构评审 §5.2：双源漂移风险）。
 *
 * 检查项：
 *   1. 每个 active skill 在 agent-skill-matrix.yml 中恰有一个 owns 归属（非 0、非多个）
 *   2. agent-skill-matrix.yml 里的 owns 目标要么在 _index.yml 注册，要么在某 actor 的 external 里声明
 *   3. AGENT-SKILL-MATRIX.md 的"主责矩阵"表格与 agent-skill-matrix.yml 的 owns 完全一致（md 应由 yml 派生，不应手改漂移）
 *
 * 零依赖（仅 node: 内置模块），退出码非 0 = 发现不一致，可接入 CI / pre-commit。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const errors = [];

// ── 1. 解析 skills/_index.yml：active skill id 集合 ──────────────────────
const indexText = fs.readFileSync(path.join(root, 'skills/_index.yml'), 'utf8');
const activeSkills = new Set();
{
  let curId = null;
  for (const line of indexText.split('\n')) {
    const idM = line.match(/^\s*-\s*id:\s*(\S+)/);
    if (idM) { curId = idM[1]; continue; }
    const statusM = line.match(/^\s*status:\s*(\w+)/);
    if (statusM && curId) { if (statusM[1] === 'active') activeSkills.add(curId); curId = null; }
  }
}

// ── 2. 解析 agent-skill-matrix.yml：actor -> owns[] / external[] ─────────
const matrixText = fs.readFileSync(path.join(root, 'agent-skill-matrix.yml'), 'utf8');
const ownsByActor = {};
const externalSkills = new Set();
{
  let actor = null, section = null;
  for (const line of matrixText.split('\n')) {
    const actorM = line.match(/^  (\S[\w-]*):\s*$/);
    if (actorM && !/^\s*(owns|can-call|external|forbidden):/.test(line)) { actor = actorM[1]; section = null; continue; }
    const sectionM = line.match(/^    (owns|can-call|external|forbidden):/);
    if (sectionM) { section = sectionM[1]; continue; }
    const itemM = line.match(/^      -\s*(\S+)\s*$/);
    if (itemM && actor && section === 'owns') (ownsByActor[actor] ??= []).push(itemM[1]);
    if (itemM && section === 'external') externalSkills.add(itemM[1]);
  }
}
const ownerOfSkill = {};
for (const [actor, skills] of Object.entries(ownsByActor)) {
  for (const s of skills) (ownerOfSkill[s] ??= []).push(actor);
}

// ── 3. 解析 AGENT-SKILL-MATRIX.md 的"主责矩阵"表格 ───────────────────────
const mdText = fs.readFileSync(path.join(root, 'AGENT-SKILL-MATRIX.md'), 'utf8');
const mdOwnsByActor = {};
{
  const section = mdText.split('## 主责矩阵')[1]?.split(/^## /m)[0] ?? '';
  const rowRe = /^\|\s*`([\w-]+)`\s*\|\s*(.+?)\s*\|$/gm;
  let m;
  while ((m = rowRe.exec(section))) {
    mdOwnsByActor[m[1]] = m[2].split(',').map((s) => s.trim().replace(/^`|`$/g, '')).filter(Boolean);
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

// ── 输出 ──────────────────────────────────────────────────────────────
if (errors.length) {
  console.error(`skill matrix 一致性校验失败（${errors.length} 项）：\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
} else {
  console.log(`skill matrix 一致性校验通过：${activeSkills.size} 个 active skill，${Object.keys(ownsByActor).length} 个 actor，owns 归属与 md 表格均一致。`);
}

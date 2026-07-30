#!/usr/bin/env node
/**
 * check-agents-contract.mjs — 校验 dir-graph.yaml#agents.contract 的四条不变式
 * （CR-2026-001 TASK-05 / FR-4，与 check-skill-matrix.mjs 互补：那边管 skill
 * 归属三角一致，这边管 agent 登记与引用一致）。
 *
 * 四条不变式与本脚本的覆盖方式：
 *   1. "新增 Agent 必须先创建 agents/{agent-id}.md，再登记 agents/_index.yml"
 *      → 双向存在性：_index.yml 每条 path 指向的 .md 必须存在；
 *        agents/*.md 每个文件必须已在 _index.yml 登记。
 *   2. "Agent references 中引用的 Skill 必须已在 skills/_index.yml 中登记为 active"
 *      → _index.yml 各 agent 的 references[] 中形如 skills/{domain}/{id}/SKILL.md
 *        的路径，其 {id} 必须是 active skill（或 external 声明的外部 skill）。
 *   3. "references 中的可调用 Skill 必须同步登记到 agent-skill-matrix.yml 的
 *      owns 或 can-call"
 *      → 各 agent references 出现的 active skill 必须落在该 actor 的
 *        owns ∪ can-call ∪ external 中。
 *   4. "Agent 不直接绕过 Skill 写入受控账本或状态文件"
 *      → 行为约束，静态无法校验：由 crctl 门禁（advance/approve 唯一写入路径 +
 *        CAS）与 adapters/claude-code 的 PreToolUse hook 在运行时承担，此处仅声明。
 *
 * 零依赖（仅 node: 内置模块），退出码非 0 = 发现不一致，可接入 CI / pre-commit。
 * 解析一律逐行 split('\n') 状态机，不做 indexOf 块切分（CRLF 教训）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const errors = [];

// ── skills/_index.yml：active skill id 集合（与 check-skill-matrix.mjs 同款解析）──
const activeSkills = new Set();
{
  let curId = null;
  for (const line of fs.readFileSync(path.join(root, 'skills/_index.yml'), 'utf8').split('\n')) {
    const idM = line.match(/^\s*-\s*id:\s*(\S+)/);
    if (idM) { curId = idM[1]; continue; }
    const statusM = line.match(/^\s*status:\s*(\w+)/);
    if (statusM && curId) { if (statusM[1] === 'active') activeSkills.add(curId); curId = null; }
  }
}

// ── agent-skill-matrix.yml：actor -> owns/can-call/external 合并集合 ──────
const callableByActor = {};
const externalSkills = new Set();
{
  let actor = null, section = null;
  for (const line of fs.readFileSync(path.join(root, 'agent-skill-matrix.yml'), 'utf8').split('\n')) {
    const actorM = line.match(/^  (\S[\w-]*):\s*$/);
    if (actorM && !/^\s*(owns|can-call|external|forbidden):/.test(line)) { actor = actorM[1]; section = null; continue; }
    const sectionM = line.match(/^    (owns|can-call|external|forbidden):/);
    if (sectionM) { section = sectionM[1]; continue; }
    const itemM = line.match(/^      -\s*(\S+)\s*$/);
    if (!itemM || !actor) continue;
    if (section === 'owns' || section === 'can-call' || section === 'external') {
      (callableByActor[actor] ??= new Set()).add(itemM[1]);
    }
    if (section === 'external') externalSkills.add(itemM[1]);
  }
}

// ── agents/_index.yml：id / path / status / references[] ─────────────────
const agents = [];
{
  let cur = null, inRefs = false;
  for (const line of fs.readFileSync(path.join(root, 'agents/_index.yml'), 'utf8').split('\n')) {
    const idM = line.match(/^\s{2}-\s*id:\s*(\S+)/);
    if (idM) { cur = { id: idM[1], path: null, status: null, references: [] }; agents.push(cur); inRefs = false; continue; }
    if (!cur) continue;
    const pathM = line.match(/^\s{4}path:\s*(\S+)/);
    if (pathM) { cur.path = pathM[1]; inRefs = false; continue; }
    const statusM = line.match(/^\s{4}status:\s*(\S+)/);
    if (statusM) { cur.status = statusM[1]; inRefs = false; continue; }
    if (/^\s{4}references:\s*$/.test(line)) { inRefs = true; continue; }
    if (/^\s{4}\S/.test(line)) { inRefs = false; continue; } // 其他四空格键结束 references 块
    const refM = line.match(/^\s{6}-\s*(\S+)\s*$/);
    if (inRefs && refM) cur.references.push(refM[1]);
  }
}

// ── 不变式 1：双向存在性 ─────────────────────────────────────────────────
const registeredMd = new Set();
for (const a of agents) {
  if (!a.path) { errors.push(`[缺 path] _index.yml 中 agent "${a.id}" 没有 path 字段`); continue; }
  const abs = path.join(root, 'agents', a.path.replace(/^\.\//, ''));
  registeredMd.add(path.basename(abs));
  if (!fs.existsSync(abs)) errors.push(`[文件缺失] agent "${a.id}" 登记的 ${a.path} 不存在`);
}
for (const f of fs.readdirSync(path.join(root, 'agents'))) {
  if (!f.endsWith('.md')) continue;
  if (!registeredMd.has(f)) errors.push(`[未登记] agents/${f} 存在但未在 agents/_index.yml 登记`);
}

// ── 不变式 2 + 3：references 的 skill 必须 active，且落在 actor 可调用集合 ──
const skillRefRe = /skills\/[\w-]+\/([\w-]+)\/SKILL\.md$/;
for (const a of agents) {
  if (a.status !== 'active') continue;
  const callable = callableByActor[a.id] ?? new Set();
  for (const ref of a.references) {
    const m = ref.match(skillRefRe);
    if (!m) continue; // 非 skill 引用（agent 文档、workspace 资料入口）不在本检查范围
    const skillId = m[1];
    if (!activeSkills.has(skillId) && !externalSkills.has(skillId)) {
      errors.push(`[引用失效] agent "${a.id}" references 引用的 skill "${skillId}" 不是 active，也未声明 external`);
      continue;
    }
    if (!callable.has(skillId)) {
      errors.push(`[矩阵缺口] agent "${a.id}" references 引用 "${skillId}"，但 agent-skill-matrix.yml 中该 actor 的 owns/can-call/external 均未登记`);
    }
  }
}

// ── 输出 ──────────────────────────────────────────────────────────────
if (errors.length) {
  console.error(`agents.contract 校验失败（${errors.length} 项）：\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
} else {
  console.log(
    `agents.contract 校验通过：${agents.length} 个 agent（不变式 1-3 覆盖）；` +
    `不变式 4（不绕过 Skill 写受控文件）为行为约束，由 crctl 门禁与 PreToolUse hook 在运行时承担。`,
  );
}

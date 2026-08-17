#!/usr/bin/env node
// emit-registry.mjs — 从 tools 权威合同生成 architecture-design Core registry（CR-2026-045）。
// 只做确定性转换与硬校验；失败非零退出且不输出空 registry；不实现表达式解释器。
// 用法：node emit-registry.mjs --pipeline architecture-design
import { parseYaml } from '../skills/shared/crctl/scripts/lib/yaml-subset.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TOOLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'ai-first.pipeline-registry/architecture-core-v1';

function fail(code, message, extra = {}) {
  process.stderr.write(JSON.stringify({ error: { code, message, ...extra } }) + '\n');
  process.exit(1);
}

const norm = (s) => s.replaceAll('\r\n', '\n');

// ── 参数解析 ──
const args = process.argv.slice(2);
let pipelineId = 'architecture-design';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pipeline') pipelineId = args[++i];
  else if (args[i] === '--check') { /* 由 generate-gate-nodes 消费的语义；本脚本只负责输出 */ }
}
if (pipelineId !== 'architecture-design') {
  fail('RUNNER_UNSUPPORTED_PIPELINE', `仅支持 architecture-design，收到 ${pipelineId}`, { pipelineId });
}

// ── 读取权威合同 ──
const matrix = parseYaml(norm(readFileSync(path.join(TOOLS_ROOT, 'agent-skill-matrix.yml'), 'utf8')));
const skillsIndex = parseYaml(norm(readFileSync(path.join(TOOLS_ROOT, 'skills', '_index.yml'), 'utf8')));
const pipelinesIndex = parseYaml(norm(readFileSync(path.join(TOOLS_ROOT, 'pipeline-templates', '_index.yml'), 'utf8')));
const pipelineText = norm(readFileSync(path.join(TOOLS_ROOT, 'pipeline-templates', 'architecture-design.pipeline.json'), 'utf8'));
let pipeline;
try {
  pipeline = JSON.parse(pipelineText);
} catch (e) {
  fail('PIPELINE_JSON_INVALID', `architecture-design.pipeline.json 无法解析：${e.message}`);
}

// ── 1. Pipeline active 校验 ──
const pipelineEntry = (pipelinesIndex['pipeline-templates'] || []).find((p) => p.id === pipelineId || p.id === `${pipelineId}-v1`);
if (!pipelineEntry) fail('PIPELINE_NOT_INDEXED', `pipeline-templates/_index.yml 缺 ${pipelineId}`);
if (pipelineEntry.status && pipelineEntry.status !== 'active') fail('PIPELINE_INACTIVE', `pipeline ${pipelineId} status=${pipelineEntry.status}`);

// ── 2. 索引与 owner 解析 ──
const skillById = new Map((skillsIndex.skills || []).map((s) => [s.id, s]));
const actors = matrix.actors || {};
const ownsBy = new Map(); // skill -> [actorIds]
for (const [actorId, actor] of Object.entries(actors)) {
  for (const skill of actor.owns || []) {
    if (!ownsBy.has(skill)) ownsBy.set(skill, []);
    ownsBy.get(skill).push(actorId);
  }
}
const canCallBy = new Map(); // actor -> Set(skill)
for (const [actorId, actor] of Object.entries(actors)) {
  canCallBy.set(actorId, new Set([...(actor.owns || []), ...(actor['can-call'] || [])]));
}

const pipelineOwner = matrix['pipeline-owners']?.[pipelineId];
if (!pipelineOwner) fail('PIPELINE_OWNER_MISSING', `matrix pipeline-owners 缺 ${pipelineId}`);

// ── 3. 逐节点校验 ──
const nodePermissions = [];
for (const node of pipeline.nodes || []) {
  if (node.kind === 'human_approval') continue;
  if (!node.ref) fail('NODE_REF_MISSING', 'skill 节点缺 ref');
  const skill = skillById.get(node.ref);
  if (!skill) fail('SKILL_NOT_INDEXED', `skill ${node.ref} 不在 skills/_index.yml`);
  if (skill.status !== 'active') fail('SKILL_INACTIVE', `skill ${node.ref} status=${skill.status}`);
  const owners = ownsBy.get(node.ref) || [];
  if (owners.length !== 1) fail('SKILL_OWNER_NOT_UNIQUE', `skill ${node.ref} 的 owns owner 数量=${owners.length}`, { owners });
  const owner = owners[0];
  const canCall = canCallBy.get(pipelineOwner);
  if (!canCall || !canCall.has(node.ref)) {
    fail('PIPELINE_OWNER_CANNOT_CALL', `pipeline owner ${pipelineOwner} 对 skill ${node.ref} 无 owns|can-call`);
  }
  nodePermissions.push({ ref: node.ref, owner, pipelineOwnerCanCall: true });
}

// ── 4. prompt 双花括号 token 校验（只允许 cr_id / tech_context）──
const ALLOWED = new Set(['{{inputs.cr_id}}', '{{inputs.tech_context}}']);
for (const node of pipeline.nodes || []) {
  const texts = [node.prompt || '', node.approvalPrompt || ''];
  for (const text of texts) {
    for (const m of text.matchAll(/\{\{([^{}]+)\}\}/g)) {
      const token = m[0];
      if (!ALLOWED.has(token)) fail('REGISTRY_PROMPT_TOKEN_INVALID', `节点 ${node.ref || node.id} 含未声明 token ${token}`, { token });
    }
  }
}

// ── 5. 输出 canonical registry + digest ──
const corePipeline = {
  id: pipeline.id,
  name: pipeline.name,
  nodes: (pipeline.nodes || []).map((n) => ({
    id: n.id, kind: n.kind, label: n.label, ref: n.ref,
    prompt: n.prompt, approvalPrompt: n.approvalPrompt, onFail: n.onFail,
    reviewLoop: n.reviewLoop,
  })),
};
const body = { pipeline: corePipeline, pipelineOwner, nodePermissions };
const canonical = JSON.stringify(body);
const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
const registry = { schema: SCHEMA, ...body, digest: `sha256:${digest}` };
process.stdout.write(JSON.stringify(registry, null, 2) + '\n');

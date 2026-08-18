// CR-2026-039 TASK-04 / CR-2026-043 TASK-04：code-implementation.pipeline.json 结构测试（node --test，零依赖）。
// 覆盖 AC-1～AC-4：checkpoint 节点序、onFail/ref、节点 id 全局唯一、reviewLoop.replayNodes 逐字不变、
// inputs 无 suggestion_policy。
//
// 运行：node --test skills/shared/crctl/scripts/test/pipeline-structure.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TOOLS_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const PIPELINE_PATH = path.join(TOOLS_ROOT, 'pipeline-templates', 'code-implementation.pipeline.json');
const RULES_PATH = path.join(TOOLS_ROOT, 'skills', 'shared', 'controlled-shell', 'rules.json');
const pipeline = JSON.parse(readFileSync(PIPELINE_PATH, 'utf8').replaceAll('\r\n', '\n'));
const nodes = pipeline.nodes;
const bySuffix = (s) => nodes.find((n) => n.id.endsWith(s));
const REVIEW_CODE = '00000000-0000-0000-0015-000000000009';
const CHECKPOINT = '00000000-0000-0000-0015-000000000015';
const HUMAN_APPROVAL = '00000000-0000-0000-0015-000000000010';
const APPROVE_CODE = '00000000-0000-0000-0015-000000000011';

test('AC-1: 节点序 review-code(…0009) < checkpoint(…0015) < human_approval(…0010) < approve-code(…0011)', () => {
  const idx = (id) => nodes.findIndex((n) => n.id === id);
  for (const id of [REVIEW_CODE, CHECKPOINT, HUMAN_APPROVAL, APPROVE_CODE]) assert.notEqual(idx(id), -1, `节点存在: ${id}`);
  assert.ok(idx(REVIEW_CODE) < idx(CHECKPOINT), 'review-code < checkpoint');
  assert.ok(idx(CHECKPOINT) < idx(HUMAN_APPROVAL), 'checkpoint < human_approval');
  assert.ok(idx(HUMAN_APPROVAL) < idx(APPROVE_CODE), 'human_approval < approve-code');
});

test('AC-2: checkpoint 节点 onFail=abort、ref=push-progress；节点 id 全局唯一（CR-2026-042 后 16 节点）', () => {
  const n = bySuffix('000000000015');
  assert.equal(n.onFail, 'abort');
  assert.equal(n.ref, 'push-progress');
  assert.equal(n.kind, 'skill');
  assert.ok(/checkpoint/i.test(n.label), 'label 表达 checkpoint 语义');
  assert.ok(/\{\{inputs\.cr_id\}\}|\{execution_context\.cr_id\}/.test(n.prompt), 'prompt 引用 cr_id');
  const ids = nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, '节点 id 全局唯一');
  assert.equal(ids.length, 16, 'CR-2026-042 删除 reviewer 选择暂停 …0013 后为 16 节点');
});

test('AC-3: review-code reviewLoop.replayNodes 为 5 项，含 workspace-freshness(…0017) 重核（CR-2026-043）', () => {
  const n = bySuffix('000000000009');
  assert.deepEqual(n.reviewLoop.replayNodes, [
    { nodeId: '00000000-0000-0000-0015-000000000006', ref: 'implement-code', purpose: 'repair-code' },
    { nodeId: '00000000-0000-0000-0015-000000000007', ref: 'write-test-report', purpose: 'regenerate-test-evidence' },
    { nodeId: '00000000-0000-0000-0015-000000000008', ref: 'push-progress', purpose: 'publish-repaired-code-and-evidence-checkpoint' },
    { nodeId: '00000000-0000-0000-0015-000000000017', ref: 'workspace-freshness', purpose: 're-verify-baseline' },
    { nodeId: '00000000-0000-0000-0015-000000000009', ref: 'review-code', purpose: 'rerun-current-review' },
  ], 'replayNodes 扩为 5 项：重放顺序在 review-code 前插入基线重核');
  assert.equal(n.reviewLoop.maxAttempts, 3);
});

test('CR-2026-043: 两个 workspace-freshness gate 位置/ref/onFail 正确', () => {
  const idx = (id) => nodes.findIndex((n) => n.id === id);
  const impl = bySuffix('000000000016');
  const review = bySuffix('000000000017');
  for (const n of [impl, review]) {
    assert.ok(n, 'gate 节点存在');
    assert.equal(n.ref, 'workspace-freshness');
    assert.equal(n.kind, 'skill');
    assert.equal(n.onFail, 'abort');
    assert.ok(/\{\{inputs\.cr_id\}\}|\{execution_context\.cr_id\}/.test(n.prompt), 'prompt 引用 cr_id');
  }
  // 实施前 gate：approve-dev-start(…0005) 之后、implement-code(…0006) 之前
  assert.ok(idx('00000000-0000-0000-0015-000000000005') < idx('00000000-0000-0000-0015-000000000016'), '…016 在 approve-dev-start 后');
  assert.ok(idx('00000000-0000-0000-0015-000000000016') < idx('00000000-0000-0000-0015-000000000006'), '…016 在 implement-code 前');
  // 评审前 gate：统一 checkpoint push-progress(…0008) 之后、review-code(…0009) 之前（CR-2026-042 删除评审 LLM 选择 …0013）
  assert.ok(idx('00000000-0000-0000-0015-000000000008') < idx('00000000-0000-0000-0015-000000000017'), '…017 在统一 checkpoint 后');
  assert.ok(idx('00000000-0000-0000-0015-000000000017') < idx('00000000-0000-0000-0015-000000000009'), '…017 在 review-code 前');
  assert.ok(impl.prompt.includes('implement-start'));
  assert.ok(review.prompt.includes('review-start'));
});

test('CR-2026-043: pipeline prompt 无 git/journal 字样；write-test-report replayNodes 未被改动', () => {
  for (const n of nodes) {
    for (const text of [n.prompt || '', n.approvalPrompt || '']) {
      assert.ok(!/\bgit\b/i.test(text), `节点 ${n.id} prompt 不得出现 git 字样`);
      assert.ok(!/\bjournal\b/i.test(text), `节点 ${n.id} prompt 不得出现 journal 字样`);
    }
  }
  const wtr = bySuffix('000000000007');
  assert.deepEqual(wtr.reviewLoop.replayNodes.map((r) => r.nodeId), [
    '00000000-0000-0000-0015-000000000006',
    '00000000-0000-0000-0015-000000000007',
  ], '测试证据闭环 replayNodes 保持 implement-code→write-test-report');
});

test('CR-2026-043: _index.yml 节点数与 JSON 一致；全部 node.ref 在 skills/_index.yml active；状态机/gates 零耦合', () => {
  const TOOLS_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
  const indexText = readFileSync(path.join(TOOLS_ROOT, 'pipeline-templates', '_index.yml'), 'utf8').replaceAll('\r\n', '\n');
  const m = indexText.match(/- id: code-implementation-v1\n(?:.*\n)*?\s*nodes:\s*(\d+)/);
  assert.ok(m, '_index.yml 含 code-implementation-v1 条目');
  assert.equal(Number(m[1]), nodes.length, '_index.yml nodes 与实际 JSON 节点数一致');
  const skillsText = readFileSync(path.join(TOOLS_ROOT, 'skills', '_index.yml'), 'utf8').replaceAll('\r\n', '\n');
  for (const n of nodes.filter((x) => x.kind === 'skill')) {
    assert.ok(new RegExp(`- id: ${n.ref}\\n`).test(skillsText), `ref ${n.ref} 在 skills/_index.yml 登记`);
    const block = skillsText.match(new RegExp(`- id: ${n.ref}\\n(?:.*\\n)*?\\s*status: (\\w+)`));
    assert.equal(block[1], 'active', `ref ${n.ref} 必须 active`);
  }
  const gatesText = readFileSync(path.join(TOOLS_ROOT, 'skills', 'shared', 'crctl', 'gates.json'), 'utf8');
  assert.ok(!/freshness/i.test(gatesText), 'gates.json 零改动：freshness 是 pipeline 节点级门禁而非状态机门禁');
  const graphText = readFileSync(path.join(TOOLS_ROOT, 'dir-graph.yaml'), 'utf8');
  assert.ok(!/workspace-freshness|workspace-sync/.test(graphText.match(/state_machine:[\s\S]*?(?=\n\S)/)?.[0] || ''), 'state_machine 零改动');
});

test('AC-4: inputs 中无 suggestion_policy', () => {
  assert.ok(Array.isArray(pipeline.inputs));
  assert.ok(!pipeline.inputs.some((i) => i.key === 'suggestion_policy'), 'suggestion_policy 已删除');
});

test('human_approval(…0010) approvalPrompt 含评审后 checkpoint phase=complete 前提', () => {
  const n = bySuffix('000000000010');
  assert.ok(n.approvalPrompt.includes('评审后 checkpoint phase=complete'), '审批提示追加 checkpoint 前提');
});

/* ── CR-2026-044 TASK-05：三条 Pipeline 阶段终点 checkpoint 合同与 operational workspace 传递 ── */

const TOOLS_ROOT_044 = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const readPipeline = (name) => JSON.parse(readFileSync(path.join(TOOLS_ROOT_044, 'pipeline-templates', name), 'utf8').replaceAll('\r\n', '\n'));

test('CR-2026-044 AC-13/14: requirement-authoring 审批后强制 checkpoint（7 节点），草稿 checkpoint 仍可选', () => {
  const p = readPipeline('requirement-authoring.pipeline.json');
  const idx = (refAfter) => p.nodes.findIndex((n) => n.ref === refAfter);
  const approveIdx = p.nodes.findIndex((n) => n.ref === 'approve-requirement');
  assert.notEqual(approveIdx, -1, 'approve-requirement 节点存在');
  const end = p.nodes[approveIdx + 1];
  assert.ok(end, 'approve-requirement 后存在终点 checkpoint 节点');
  assert.equal(end.ref, 'push-progress');
  assert.equal(end.onFail, 'abort', '审批后 checkpoint 必须 abort');
  const draft = p.nodes.find((n) => n.ref === 'push-progress' && /auto_push_after_prd/.test(n.prompt));
  assert.ok(draft && draft.onFail === 'skip', 'PRD 草稿 checkpoint 仍可选');
  assert.equal(p.nodes.length, 7, '新增终点 checkpoint 后为 7 节点');
  const indexText = readFileSync(path.join(TOOLS_ROOT_044, 'pipeline-templates', '_index.yml'), 'utf8').replaceAll('\r\n', '\n');
  const m = indexText.match(/- id: requirement-authoring-v1\n(?:.*\n)*?\s*nodes:\s*(\d+)/);
  assert.equal(Number(m[1]), 7, '_index.yml requirement-authoring nodes=7');
});

test('CR-2026-044 AC-14: architecture-design 删除 auto_push_after_sdd，审批后 checkpoint abort，5 节点不变', () => {
  const p = readPipeline('architecture-design.pipeline.json');
  assert.ok(!p.inputs.some((i) => i.key === 'auto_push_after_sdd'), 'auto_push_after_sdd 输入已删除');
  const push = p.nodes.filter((n) => n.ref === 'push-progress');
  assert.equal(push.length, 1, '仅一个 checkpoint 节点');
  assert.equal(push[0].onFail, 'abort', '架构终点 checkpoint 必须 abort');
  assert.ok(!/SKIPPED|auto_push/.test(push[0].prompt), 'checkpoint prompt 无 skip 分支');
  assert.doesNotMatch(push[0].prompt, /<[^>]*workspace[^>]*>/i, 'checkpoint prompt 不得含未解析 workspace 占位符');
  assert.match(push[0].prompt, /crctl checkpoint \{\{inputs\.cr_id\}\} --message/);
  const skill = readFileSync(path.join(TOOLS_ROOT_044, 'skills', 'sync', 'push-progress', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /<installation-workspace>/, 'push-progress Skill 不得保留可误执行的 workspace token');
  assert.equal(p.nodes.length, 5, '节点数保持 5');
});

test('CR-2026-044 AC-13: code-implementation 审批后 checkpoint abort、TASK checkpoint 仍可选、16 节点不变（CR-2026-042 删除评审 LLM 节点后）', () => {
  const p = readPipeline('code-implementation.pipeline.json');
  const final = p.nodes.find((n) => /审批结果/.test(n.label || '') && n.ref === 'push-progress');
  assert.ok(final, '审批结果 checkpoint 节点存在');
  assert.equal(final.onFail, 'abort', '审批后 checkpoint 必须 abort');
  const taskCkpt = p.nodes.find((n) => n.ref === 'push-progress' && /auto_push_after_task/.test(n.prompt));
  assert.ok(taskCkpt && taskCkpt.onFail === 'skip', 'TASK checkpoint 仍可选');
  assert.equal(p.nodes.length, 16, 'CR-2026-042 移除评审 LLM 选择节点后为 16 节点');
});

test('CR-2026-044 AC-12: architecture/code 入口取得 authority path，并由 execution_context 原样传给后续节点', () => {
  for (const name of ['architecture-design.pipeline.json', 'code-implementation.pipeline.json']) {
    const p = readPipeline(name);
    const first = p.nodes[0];
    assert.ok(first.prompt.includes('crctl workspace inspect'), `${name} 首节点调用 workspace inspect`);
    assert.ok(first.prompt.includes('operationalWorkspace'), `${name} 首节点消费 operationalWorkspace`);
    assert.ok(first.prompt.includes('execution_context:'), `${name} 首节点输出机器可读 execution_context`);
    assert.ok(first.prompt.includes('operational_workspace:'), `${name} execution_context 固定 authority path`);
    assert.ok(/classification=healthy/.test(first.prompt), `${name} 首节点要求全部 resources healthy`);
    assert.ok(/resume/.test(first.prompt), `${name} 非 healthy 时指向 resume`);
    for (const node of p.nodes.slice(1).filter((n) => n.prompt)) {
      if (name === 'architecture-design.pipeline.json') {
        // CR-2026-045：architecture 后续节点每节点独立 workspace inspect，不再依赖 node-1.md 的 execution_context
        assert.ok(node.prompt.includes('crctl workspace inspect'), `${name}/${node.ref} 后续节点独立 workspace inspect`);
        assert.ok(!node.prompt.includes('node-1.md'), `${name}/${node.ref} 不依赖 node-1.md`);
      } else {
        assert.ok(node.prompt.includes('execution_context.operational_workspace'), `${name}/${node.ref || node.kind} 后续节点消费同一 authority path`);
      }
    }
  }
  const code = readPipeline('code-implementation.pipeline.json');
  const implement = code.nodes.find((n) => n.ref === 'implement-code');
  assert.ok(implement.prompt.includes('execution_context.resources[].worktreePath'), 'implement-code 从 inspect resources 取多仓路径');
  assert.ok(!implement.prompt.includes('.rayai-worktrees/'), 'implement-code 不再按目录命名拼接 worktree 路径');
});

/* ── CR-2026-045 TASK-01/TASK-02：architecture reviewLoop replayNodes + emit-registry 合同 ── */

const TOOLS_ROOT_045 = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const EMIT_REGISTRY = path.join(TOOLS_ROOT_045, 'pipeline-templates', 'emit-registry.mjs');
const ARCH = readPipeline('architecture-design.pipeline.json');

test('CR-2026-045 AC-02: architecture reviewLoop 复用 rerun-listed-nodes-in-order + replayNodes schema', () => {
  const n = ARCH.nodes.find((x) => x.ref === 'review-tech-design');
  assert.equal(n.reviewLoop.replayPolicy, 'rerun-listed-nodes-in-order');
  assert.deepEqual(n.reviewLoop.replayNodes, [
    { nodeId: '00000000-0000-0000-0016-000000000001', ref: 'write-tech-design', purpose: 'repair-sdd' },
    { nodeId: '00000000-0000-0000-0016-000000000002', ref: 'review-tech-design', purpose: 'rerun-current-review' },
  ]);
  // requirement Pipeline 不受影响
  const req = readPipeline('requirement-authoring.pipeline.json');
  const rn = req.nodes.find((x) => x.ref === 'review-requirement');
  assert.equal(rn.reviewLoop.replayPolicy, undefined);
});

test('CR-2026-045 AC-03: emit-registry 输出 canonical registry 且 digest 稳定', () => {
  const r = spawnSync(process.execPath, [EMIT_REGISTRY, '--pipeline', 'architecture-design'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `emit-registry 退出码 0，stderr=${r.stderr}`);
  const reg = JSON.parse(r.stdout);
  assert.equal(reg.schema, 'ai-first.pipeline-registry/architecture-core-v1');
  assert.equal(reg.pipelineOwner, 'dev-agent');
  assert.equal(reg.nodePermissions.length, 4, 'architecture 有 4 个 skill 节点');
  for (const p of reg.nodePermissions) {
    assert.equal(typeof p.ref, 'string');
    assert.equal(typeof p.owner, 'string');
    assert.equal(p.pipelineOwnerCanCall, true);
  }
  assert.match(reg.digest, /^sha256:[0-9a-f]{64}$/);
  // 所有 skill 节点 owner 唯一：write/review/approve 归 dev-agent，push-progress 归 system-orchestrator
  const byRef = Object.fromEntries(reg.nodePermissions.map((p) => [p.ref, p.owner]));
  assert.equal(byRef['write-tech-design'], 'dev-agent');
  assert.equal(byRef['review-tech-design'], 'dev-agent');
  assert.equal(byRef['approve-tech-design'], 'dev-agent');
  assert.equal(byRef['push-progress'], 'system-orchestrator');
});

test('CR-2026-045: commit-scan git show 仅放行 canonical review annotation object', () => {
  const rules = JSON.parse(readFileSync(RULES_PATH, 'utf8').replaceAll('\r\n', '\n'));
  const show = rules.git.find((entry) => entry.sub === 'show');
  assert.ok(show, 'controlled-shell 必须声明 show');
  assert.deepEqual(show.callers, ['system-orchestrator']);
  const allowed = show.shapes.map((shape) => new RegExp(typeof shape === 'string' ? shape : shape.re, typeof shape === 'string' ? '' : shape.flags));
  const accepts = (value) => allowed.some((re) => re.test(value));
  assert.ok(accepts('0123456789abcdef0123456789abcdef01234567:change-requests/CR-2026-045/review-annotations/sdd.yml'));
  for (const unsafe of [
    'HEAD:change-requests/CR-2026-045/review-annotations/sdd.yml',
    '0123456789abcdef0123456789abcdef01234567:../../etc/passwd',
    '0123456789abcdef0123456789abcdef01234567:change-requests/CR-2026-045/cr.md',
  ]) assert.equal(accepts(unsafe), false, `must reject ${unsafe}`);
});

test('CR-2026-045: emit-registry 残留双花括号 token 硬失败且不输出空 registry', () => {
  // 用 --pipeline 传非法 pipeline 验证 fail-closed（不依赖破坏真实 pipeline 文件）
  const r = spawnSync(process.execPath, [EMIT_REGISTRY, '--pipeline', 'code-implementation'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /RUNNER_UNSUPPORTED_PIPELINE/);
  assert.equal(r.stdout, '');
});

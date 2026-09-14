// CR-2026-039 TASK-04 / CR-2026-043 TASK-04 / CR-2026-066 TASK-01：pipeline 结构测试（node --test，零依赖）。
// 覆盖 AC-1～AC-4：阶段终点发布点唯一性（节点数 5/4/12、push-progress 节点计数 0、被删 7 个完整 id 零出现）、
// 节点 id 全局唯一、reviewLoop.replayNodes 按事实源推导、inputs 无 suggestion_policy。
//
// 运行：node --test skills/shared/crctl/scripts/test/pipeline-structure.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TOOLS_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const PIPELINE_PATH = path.join(TOOLS_ROOT, 'pipeline-templates', 'code-implementation.pipeline.json');
const RULES_PATH = path.join(TOOLS_ROOT, 'skills', 'shared', 'controlled-shell', 'rules.json');
const pipeline = JSON.parse(readFileSync(PIPELINE_PATH, 'utf8').replaceAll('\r\n', '\n'));
const nodes = pipeline.nodes;
const bySuffix = (s) => nodes.find((n) => n.id.endsWith(s));
const REVIEW_CODE = '00000000-0000-0000-0015-000000000009';
const HUMAN_APPROVAL = '00000000-0000-0000-0015-000000000010';
const APPROVE_CODE = '00000000-0000-0000-0015-000000000011';

/* 事实源读取器（CR-2026-066 AC-1/AC-2）：断言一律从 pipeline JSON 与 pipeline-templates/_index.yml 推导，不钉死行数。 */
const readPipelineOf = (name) => JSON.parse(readFileSync(path.join(TOOLS_ROOT, 'pipeline-templates', name), 'utf8').replaceAll('\r\n', '\n'));
const INDEX_NODES = (() => {
  const text = readFileSync(path.join(TOOLS_ROOT, 'pipeline-templates', '_index.yml'), 'utf8').replaceAll('\r\n', '\n');
  const table = {};
  for (const m of text.matchAll(/- id: ([\w-]+)\n(?:.*\n)*?\s*nodes:\s*(\d+)/g)) table[m[1]] = Number(m[2]);
  if (Object.keys(table).length === 0) throw new Error('pipeline-templates/_index.yml 未解析到任何 nodes 计数（硬失败，不得静默通过）');
  return table;
})();

/* CR-2026-066 AC-1：阶段终点发布点唯一性（对象级删除的直接判据；删除了 …0015 的旧节点序断言）。 */

test('AC-1: 阶段终点发布点唯一性——节点数 5/4/12 ≡ _index.yml；push-progress 节点计数 0；被删 7 个完整 id 零出现', () => {
  const cases = [
    ['requirement-authoring.pipeline.json', 'requirement-authoring-v1', 5],
    ['architecture-design.pipeline.json', 'architecture-design-v1', 4],
    ['code-implementation.pipeline.json', 'code-implementation-v1', 12],
  ];
  const deletedIds = [
    '00000000-0000-0000-0011-000000000003',
    '00000000-0000-0000-0011-000000000007',
    '00000000-0000-0000-0016-000000000005',
    '00000000-0000-0000-0015-000000000003',
    '00000000-0000-0000-0015-000000000008',
    '00000000-0000-0000-0015-000000000012',
    '00000000-0000-0000-0015-000000000015',
  ];
  const allIds = [];
  for (const [file, indexId, count] of cases) {
    const p = readPipelineOf(file);
    assert.ok(Array.isArray(p.nodes) && p.nodes.length > 0, `${file} 节点集非空（解析失败必须硬失败，不得静默通过）`);
    assert.equal(p.nodes.length, count, `${file} 节点数为 ${count}（对象级删除后）`);
    assert.equal(INDEX_NODES[indexId], count, `_index.yml ${indexId} nodes 计数与 JSON 一致`);
    assert.equal(p.nodes.filter((n) => n.ref === 'push-progress').length, 0, `${file} push-progress 节点计数 = 0`);
    const approvalIdx = p.nodes.findIndex((n) => n.kind === 'human_approval');
    assert.notEqual(approvalIdx, -1, `${file} 有 human_approval 节点`);
    assert.equal(p.nodes.slice(approvalIdx + 1).filter((n) => n.ref === 'push-progress').length, 0, `${file} human_approval 之后不得有 push-progress 节点`);
    allIds.push(...p.nodes.map((n) => n.id));
  }
  assert.equal(new Set(allIds).size, allIds.length, '三份 pipeline 节点 id 全局唯一');
  const raw = cases.map(([file]) => readFileSync(path.join(TOOLS_ROOT, 'pipeline-templates', file), 'utf8')).join('\n');
  for (const id of deletedIds) assert.equal(raw.includes(id), false, `被删节点完整 id 零出现：${id}`);
});

test('AC-2: code pipeline 节点数按事实源推导（12）与节点 id 全局唯一（CR-2026-066 删除 4 个 checkpoint 节点后）', () => {
  assert.ok(nodes.length > 0, '节点集非空（解析失败必须硬失败）');
  const ids = nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, '节点 id 全局唯一');
  assert.equal(nodes.length, INDEX_NODES['code-implementation-v1'], '节点数与 pipeline-templates/_index.yml 计数一致（事实源推导）');
  assert.equal(nodes.length, 12, 'CR-2026-066 删除 …0003/…0008/…0012/…0015 后为 12 节点');
  assert.equal(nodes.filter((n) => n.kind === 'code_generation').length, 1, 'code_generation 节点保留');
  for (const suffix of ['000000000016', '000000000017']) assert.ok(bySuffix(suffix), `workspace-freshness gate 节点保留 ${suffix}`);
});

test('AC-3: review-code reviewLoop.replayNodes 为 4 项，含 workspace-freshness(…0017) 重核（CR-2026-043 / CR-2026-066）', () => {
  const n = bySuffix('000000000009');
  assert.ok(n && n.reviewLoop, 'review-code 节点含 reviewLoop');
  const replay = n.reviewLoop.replayNodes;
  assert.ok(Array.isArray(replay) && replay.length > 0, 'replayNodes 非空（解析失败必须硬失败）');
  assert.deepEqual(replay, [
    { nodeId: '00000000-0000-0000-0015-000000000006', ref: 'implement-code', purpose: 'repair-code' },
    { nodeId: '00000000-0000-0000-0015-000000000007', ref: 'write-test-report', purpose: 'regenerate-test-evidence' },
    { nodeId: '00000000-0000-0000-0015-000000000017', ref: 'workspace-freshness', purpose: 're-verify-baseline' },
    { nodeId: '00000000-0000-0000-0015-000000000009', ref: 'review-code', purpose: 'rerun-current-review' },
  ], 'replayNodes 收敛为 4 项：删除已退役的 …0008（统一 checkpoint）项');
  assert.equal(n.reviewLoop.maxAttempts, 3);
  for (const x of replay) assert.ok(nodes.some((m) => m.id === x.nodeId), `replayNodes 目标存在：${x.nodeId}`);
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
  // 评审前 gate：测试报告(…0007) 之后、review-code(…0009) 之前（CR-2026-066 删除统一 checkpoint …0008）
  assert.ok(idx('00000000-0000-0000-0015-000000000007') < idx('00000000-0000-0000-0015-000000000017'), '…017 在测试报告之后');
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

test('human_approval(…0010) approvalPrompt 不含已退役的 checkpoint phase=complete 前提句（CR-2026-066 反向断言）', () => {
  const n = bySuffix('000000000010');
  assert.ok(n && typeof n.approvalPrompt === 'string' && n.approvalPrompt.length > 0, 'approvalPrompt 非空（读不到即硬失败）');
  assert.equal(n.approvalPrompt.includes('评审后 checkpoint phase=complete'), false, '审批提示不得保留 checkpoint 前提句');
});

/* ── CR-2026-050 FR-01：human approval 不再引导直接编辑受保护账本（review-annotations 指引删除） ── */

test('FR-01: 三条 CR Pipeline human approval prompt 删除 review-annotations 编辑指引', () => {
  for (const [name, suffix] of [
    ['requirement-authoring.pipeline.json', '000000000005'],
    ['architecture-design.pipeline.json', '000000000003'],
    ['code-implementation.pipeline.json', '000000000010'],
  ]) {
    const p = readPipeline(name);
    const n = p.nodes.find((x) => x.id.endsWith(suffix));
    assert.ok(n, `${name} human_approval 节点存在`);
    assert.equal(n.kind, 'human_approval');
    const text = n.approvalPrompt || '';
    assert.ok(!/review-annotations/.test(text), `${name} approvalPrompt 不得残留 review-annotations 路径`);
    assert.ok(!/补充 reject_reason|reject_reason/.test(text), `${name} approvalPrompt 不得引导直接补 reject_reason`);
    assert.ok(/approve|reject/i.test(text), `${name} approvalPrompt 保留 approve/reject 结构化决定`);
    // CR-2026-066 反向判据：code 代码审批节点 …0010 的 checkpoint phase=complete 前提句随节点对象一并删除
    if (suffix === '000000000010') {
      assert.equal(text.includes('评审后 checkpoint phase=complete'), false, '…0010 不得保留 checkpoint phase=complete 前提');
    }
  }
});

/* ── CR-2026-050 FR-05：四个 approve 节点收敛（传 cr_id、不拼 approver、无命令细节） ── */

test('FR-05: 四个 approve 节点只传 cr_id，无 crctl approve 命令细节/TTY/grant/CAS/owners 拼接', () => {
  const cases = [
    ['requirement-authoring.pipeline.json', 'approve-requirement'],
    ['architecture-design.pipeline.json', 'approve-tech-design'],
    ['code-implementation.pipeline.json', 'approve-dev-start'],
    ['code-implementation.pipeline.json', 'approve-code'],
  ];
  for (const [name, ref] of cases) {
    const p = readPipeline(name);
    const n = p.nodes.find((x) => x.ref === ref);
    assert.ok(n, `${name}/${ref} 节点存在`);
    const text = n.prompt || '';
    assert.ok(/(\(execution_context\.\))?cr_id|\{\{inputs\.cr_id\}\}/.test(text), `${ref} 传完整 cr_id`);
    assert.ok(!/crctl approve/.test(text), `${ref} 不得含 crctl approve 命令细节`);
    assert.ok(!/TTY|grant|CAS|approval\.ya?ml|--grant|--stage/.test(text), `${ref} 不得含 TTY/grant/CAS/approval.yml 文本`);
    assert.ok(!/owners/.test(text), `${ref} 不得在 prompt 解析/拼接 owners`);
    assert.ok(!/pipeline\s+(指令|流程|阶段)|writeback pipeline|architecture pipeline|coding pipeline/.test(text), `${ref} 不得写死下一 pipeline 名`);
  }
});

/* ── CR-2026-044 TASK-05：三条 Pipeline 阶段终点 checkpoint 合同与 operational workspace 传递 ── */

const TOOLS_ROOT_044 = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const readPipeline = (name) => JSON.parse(readFileSync(path.join(TOOLS_ROOT_044, 'pipeline-templates', name), 'utf8').replaceAll('\r\n', '\n'));

test('CR-2026-044 AC-13: requirement-authoring 审批后不得有 push-progress、5 节点（CR-2026-066 节点退役后）', () => {
  const p = readPipeline('requirement-authoring.pipeline.json');
  assert.ok(Array.isArray(p.nodes) && p.nodes.length > 0, '节点集非空（解析失败必须硬失败）');
  const approveIdx = p.nodes.findIndex((n) => n.ref === 'approve-requirement');
  assert.notEqual(approveIdx, -1, 'approve-requirement 节点存在');
  assert.equal(p.nodes.slice(approveIdx + 1).filter((n) => n.ref === 'push-progress').length, 0, 'approve-requirement 之后不得有 push-progress');
  assert.equal(p.nodes.filter((n) => n.ref === 'push-progress').length, 0, 'requirement 阶段 push-progress 节点计数 = 0');
  assert.equal(p.inputs.some((i) => i.key === 'auto_push_after_prd'), false, 'auto_push_after_prd 输入已删除');
  assert.equal(p.nodes.length, 5, 'CR-2026-066 删除草稿/终点 checkpoint 后为 5 节点');
  const indexText = readFileSync(path.join(TOOLS_ROOT_044, 'pipeline-templates', '_index.yml'), 'utf8').replaceAll('\r\n', '\n');
  const m = indexText.match(/- id: requirement-authoring-v1\n(?:.*\n)*?\s*nodes:\s*(\d+)/);
  assert.ok(m, '_index.yml 含 requirement-authoring-v1 条目');
  assert.equal(Number(m[1]), 5, '_index.yml requirement-authoring nodes=5');
});

test('CR-2026-044 AC-14: architecture-design push-progress 节点计数 0、4 节点（CR-2026-066 节点退役后）', () => {
  const p = readPipeline('architecture-design.pipeline.json');
  assert.ok(Array.isArray(p.nodes) && p.nodes.length > 0, '节点集非空（解析失败必须硬失败）');
  assert.ok(!p.inputs.some((i) => i.key === 'auto_push_after_sdd'), 'auto_push_after_sdd 输入已删除');
  assert.equal(p.nodes.filter((n) => n.ref === 'push-progress').length, 0, '架构阶段 push-progress 节点计数 = 0（对象级删除）');
  // 阶段终点发布改由评审 PASS 的 review SKILL 承担，节点侧不得保留任何 checkpoint 命令面。
  for (const n of p.nodes) {
    if (!n.prompt) continue;
    assert.ok(!/crctl checkpoint/.test(n.prompt), `${n.ref || n.kind} prompt 不含 crctl checkpoint 命令字面量`);
    assert.ok(!/\{\{inputs\.auto_push/.test(n.prompt), `${n.ref || n.kind} prompt 无 auto_push 输入面`);
  }
  const skill = readFileSync(path.join(TOOLS_ROOT_044, 'skills', 'sync', 'push-progress', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /<installation-workspace>/, 'push-progress Skill 不得保留可误执行的 workspace token');
  assert.equal(p.nodes.length, 4, 'CR-2026-066 删除终点 checkpoint 后为 4 节点');
});

test('CR-2026-044 AC-13: code-implementation push-progress 节点计数 0、inputs 无 auto_push_after_task、12 节点（CR-2026-066）', () => {
  const p = readPipeline('code-implementation.pipeline.json');
  assert.ok(Array.isArray(p.nodes) && p.nodes.length > 0, '节点集非空（解析失败必须硬失败）');
  assert.equal(p.nodes.filter((n) => n.ref === 'push-progress').length, 0, 'code 阶段 push-progress 节点计数 = 0');
  assert.equal(p.inputs.some((i) => i.key === 'auto_push_after_task'), false, 'auto_push_after_task 输入已删除');
  const raw = readFileSync(path.join(TOOLS_ROOT_044, 'pipeline-templates', 'code-implementation.pipeline.json'), 'utf8');
  assert.equal(/auto_push_after_task/.test(raw), false, 'auto_push_after_task 在文件中零残留');
  assert.equal(/SKIPPED/.test(raw), false, 'SKIPPED 字面量零残留');
  assert.equal(p.nodes.length, 12, 'CR-2026-066 删除 4 个 checkpoint 节点后为 12 节点');
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

test('CR-2026-045 AC-03: emit-registry 输出 canonical registry 且 digest 格式稳定（CR-2026-066 节点退役后）', () => {
  const r = spawnSync(process.execPath, [EMIT_REGISTRY, '--pipeline', 'architecture-design'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `emit-registry 退出码 0，stderr=${r.stderr}`);
  const reg = JSON.parse(r.stdout);
  assert.equal(reg.schema, 'ai-first.pipeline-registry/architecture-core-v1');
  assert.equal(reg.pipelineOwner, 'dev-agent');
  const skillNodes = ARCH.nodes.filter((n) => n.kind === 'skill');
  assert.ok(skillNodes.length > 0, 'architecture skill 节点集非空（解析失败必须硬失败）');
  assert.equal(reg.nodePermissions.length, skillNodes.length, 'registry 逐节点覆盖 architecture 的全部 skill 节点');
  assert.equal(reg.nodePermissions.length, 3, '架构 3 个 skill 节点（CR-2026-066 删除 push-progress 后）');
  for (const p of reg.nodePermissions) {
    assert.equal(typeof p.ref, 'string');
    assert.equal(typeof p.owner, 'string');
    assert.equal(p.pipelineOwnerCanCall, true);
  }
  // CR-2026-066：删除必然改变 digest，故只断格式，不钉死旧 digest（FR-11 只登记不重生成）。
  assert.match(reg.digest, /^sha256:[0-9a-f]{64}$/);
  const byRef = Object.fromEntries(reg.nodePermissions.map((p) => [p.ref, p.owner]));
  assert.equal(byRef['write-tech-design'], 'dev-agent');
  assert.equal(byRef['review-tech-design'], 'quality-reviewer-agent');
  assert.equal(byRef['approve-tech-design'], 'dev-agent');
  assert.equal(Object.prototype.hasOwnProperty.call(byRef, 'push-progress'), false, 'push-progress 不再出现在 registry');
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

/* ── CR-2026-050 FR-12.2：requirement-authoring 关键顺序、execution_context 输出、reviewLoop 字段集（CR-2026-066 节点退役后） ── */

test('FR-12.2: requirement-authoring 5 节点顺序、execution_context/owners 输出与 reviewLoop 字段集（CR-2026-066）', () => {
  const p = readPipeline('requirement-authoring.pipeline.json');
  const order = p.nodes.map((n) => n.ref || n.kind);
  assert.deepEqual(order, ['requirement-register', 'write-requirement-prd', 'review-requirement', 'human_approval', 'approve-requirement'], 'register → PRD → review → 审批 → approve（阶段终点发布由评审 PASS 承担）');
  assert.equal(p.nodes.length, 5, 'CR-2026-066 删除草稿/终点 checkpoint 后为 5 节点');
  const first = p.nodes[0];
  assert.ok(first.prompt.includes('execution_context:'), 'register 输出机器可读 execution_context');
  assert.ok(first.prompt.includes('operational_workspace:'), 'execution_context 含 operational_workspace（snake_case，逐字透传）');
  assert.ok(!first.prompt.includes('owners:'), 'execution_context 不再持有 owners 快照（CR-2026-060 SDD §8）');
  assert.ok(!first.prompt.includes('knowledge_base_worktree:'), 'execution_context 不再持有 knowledge_base_worktree 快照');
  assert.ok(!/crctl register/.test(first.prompt), 'register 节点无 crctl register 命令参数序列');
  assert.ok(!/\/abs\/path/.test(first.prompt), 'register 节点无绝对路径示例');
  assert.equal(p.inputs.some((i) => i.key === 'auto_push_after_prd'), false, 'auto_push_after_prd 输入已删除（CR-2026-066）');
  assert.equal(p.nodes.filter((n) => n.ref === 'push-progress').length, 0, 'requirement 阶段 checkpoint 节点计数 = 0');
  const review = p.nodes.find((n) => n.ref === 'review-requirement');
  assert.ok(review.reviewLoop && review.reviewLoop.repairRef === 'write-requirement-prd', 'reviewLoop 机器字段不变');
  assert.deepEqual(
    Object.keys(review.reviewLoop).sort(),
    ['attemptInput', 'feedbackInput', 'maxAttempts', 'onBlock', 'passCondition', 'repairNodeId', 'repairRef'],
    'requirement-authoring reviewLoop 字段集不变（无 replayNodes，与 architecture 不同）'
  );
});

test('FR-06.1/07.4/07.5: requirement-authoring review/register/PRD 节点收敛负向断言', () => {
  const p = readPipeline('requirement-authoring.pipeline.json');
  const review = p.nodes.find((n) => n.ref === 'review-requirement');
  assert.ok(!/review-annotations/.test(review.prompt), 'review-requirement 不残留 deny 路径字面量（lint R1）');
  assert.ok(!/crctl review-record/.test(review.prompt), 'review-requirement 无 review-record 命令细节');
  assert.ok(!/① 完整性|② 可测试性|③ 一致性|④ 边界/.test(review.prompt), 'review-requirement 无评审维度正文');
  const prd = p.nodes.find((n) => n.ref === 'write-requirement-prd');
  assert.ok(!/背景与目标|用户故事|功能需求|验收标准/.test(prd.prompt), 'PRD 节点无章节清单副本');
});

/* ── CR-2026-050 FR-12.3：code-implementation 两条关键顺序、replayNodes、保留字面量与收敛负向断言 ── */

test('FR-12.3: code-implementation 12 节点关键顺序与 reviewLoop replayNodes（CR-2026-066 节点退役后）', () => {
  const p = readPipeline('code-implementation.pipeline.json');
  assert.ok(Array.isArray(p.nodes) && p.nodes.length > 0, '节点集非空（解析失败必须硬失败）');
  assert.equal(p.nodes.length, 12, 'CR-2026-066 删除 4 个 checkpoint 节点后为 12 节点');
  const idx = (s) => p.nodes.findIndex((n) => n.id.endsWith(s));
  // plan → TASK → review-dev-plan → 审批 → developing
  assert.ok(idx('000000000001') < idx('000000000002'), 'write-dev-plan < write-dev-tasks');
  assert.ok(idx('000000000002') < idx('000000000014'), 'write-dev-tasks < review-dev-plan');
  assert.ok(idx('000000000014') < idx('000000000004'), 'review-dev-plan < human_approval');
  assert.ok(idx('000000000004') < idx('000000000005'), 'human_approval < approve-dev-start');
  // implement → test-report → freshness → review-code（统一 checkpoint 节点已退役）
  assert.ok(idx('000000000006') < idx('000000000007'), 'implement < test-report');
  assert.ok(idx('000000000007') < idx('000000000017'), 'test-report < review-start freshness');
  assert.ok(idx('000000000017') < idx('000000000009'), 'review-start freshness < review-code');
  const reviewCode = p.nodes.find((n) => n.id.endsWith('000000000009'));
  assert.deepEqual(reviewCode.reviewLoop.replayNodes, [
    { nodeId: '00000000-0000-0000-0015-000000000006', ref: 'implement-code', purpose: 'repair-code' },
    { nodeId: '00000000-0000-0000-0015-000000000007', ref: 'write-test-report', purpose: 'regenerate-test-evidence' },
    { nodeId: '00000000-0000-0000-0015-000000000017', ref: 'workspace-freshness', purpose: 're-verify-baseline' },
    { nodeId: '00000000-0000-0000-0015-000000000009', ref: 'review-code', purpose: 'rerun-current-review' },
  ], 'review-code replayNodes 收敛为 4 项（CR-2026-066 删除 …0008）');
});

test('FR-12.3b: code-implementation 保留 gate 名与收敛负向断言（CR-2026-066 退役 checkpoint label/auto_push 断言）', () => {
  const p = readPipeline('code-implementation.pipeline.json');
  const implGate = p.nodes.find((n) => n.id.endsWith('000000000016'));
  const revGate = p.nodes.find((n) => n.id.endsWith('000000000017'));
  assert.ok(implGate.prompt.includes('implement-start'), '实施前 gate 名 implement-start 保留');
  assert.ok(revGate.prompt.includes('review-start'), '评审前 gate 名 review-start 保留');
  // CR-2026-066：审批结果 checkpoint 与 TASK checkpoint（auto_push_after_task）已对象级删除，不得再以任何形态复活。
  assert.equal(p.nodes.filter((n) => n.ref === 'push-progress').length, 0, 'push-progress 节点计数 = 0');
  assert.equal(p.nodes.some((n) => /auto_push/.test(n.prompt || '')), false, '无 auto_push_* 输入面残留');
  // 收敛负向断言：无 deny 路径字面量残留（lint R1）、无命令细节
  for (const [ref, bad] of [
    ['review-dev-plan', /review-annotations|crctl review-record|--embedded|八类维度合并评审/],
    ['review-code', /review-annotations|crctl review-record|WCAG/],
    ['write-test-report', /traceability|crctl test --plan|cr-test-plan/],
    ['implement-code', /defaultRuntimeId|fallback 到第一个/],
  ]) {
    const n = p.nodes.find((x) => x.ref === ref);
    assert.ok(!bad.test(n.prompt), `${ref} 无残留 ${bad}`);
  }
});

/* ── CR-2026-050 DD-7：SKILL.md Commit：指引前缀必须命中 rules.json commit 白名单 ── */

test('DD-7: 全部 SKILL.md Commit 指引前缀命中 controlled-shell commit 白名单（wip:/[cr]/merge(）', () => {
  const rules = JSON.parse(readFileSync(RULES_PATH, 'utf8').replace(/\r\n/g, '\n'));
  const commitShape = rules.git.find((g) => g.sub === 'commit').shapes[0];
  const commitRe = new RegExp(commitShape.re, commitShape.flags || '');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === 'SKILL.md' ? [path.join(dir, e.name)] : []);
  const skillFiles = walk(path.join(TOOLS_ROOT, 'skills'));
  assert.ok(skillFiles.length > 0, '扫描到 SKILL.md 文件');
  const bad = [];
  for (const f of skillFiles) {
    const text = readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); // 纪律 #1：读入先 CRLF 归一
    for (const m of text.matchAll(/Commit：`([^`]+)`/g)) {
      const normalized = m[1].replace(/\{[^}]+\}/g, 'X').replace(/\$\{[^}]+\}/g, 'X');
      if (!commitRe.test('-m ' + normalized)) bad.push(`${path.relative(TOOLS_ROOT, f)}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], 'Commit 指引前缀必须命中白名单（wip: / [cr] / merge(）——匹配失败即硬失败，不静默跳过');
  assert.equal(commitRe.test('-m feat(CR-X): invalid'), false, '故意构造 feat( 反例必须失败');
  assert.equal(commitRe.test('-m [planning] invalid'), false, '故意构造 [planning] 反例必须失败');
});


/* ── CR-2026-050 code-review attempt 1：补 AC-02～04 / 收敛禁项 / approve 双路径 / 事实源断言 ── */

test('CR-2026-050 AC-02: product-planning 必填输入与草稿链可执行', () => {
  const p = readPipeline('product-planning.pipeline.json');
  for (const [ref, skip] of [
    ['analyze-user-feedback', 'skip_feedback'],
    ['conduct-market-research', 'skip_market'],
    ['analyze-current-product', 'skip_product'],
  ]) {
    const n = p.nodes.find((x) => x.ref === ref);
    assert.ok(n.prompt.includes('{{inputs.topic}}'), `${ref} 传 topic`);
    assert.ok(n.prompt.includes(`{{inputs.${skip}}}`), `${ref} 保留 ${skip}`);
  }
  const comp = p.nodes.find((x) => x.ref === 'write-competitive-report');
  for (const term of ['skip_competitive', 'fetch-competitor-updates', '全部已注册竞品', 'lookback-days=30', 'gather-product-context', 'updates-block', 'product-snapshot', 'confirmed=false', 'reportDraft']) {
    assert.ok(comp.prompt.includes(term), `竞品草稿链含 ${term}`);
  }
  const write = p.nodes.find((x) => x.ref === 'write-planning-report');
  for (const term of ['prev_outputs', 'review_feedback', 'self_repair_attempt', '{{inputs.topic}}', '{{inputs.target_version}}']) assert.ok(write.prompt.includes(term), `write-planning-report 传 ${term}`);
  const review = p.nodes.find((x) => x.ref === 'review-planning-report');
  for (const term of ['reviewer: ai-reviewer', 'planning_report_path', 'repair-target', 'current-attempt']) assert.ok(review.prompt.includes(term), `review-planning-report 含 ${term}`);
  const roadmap = p.nodes.find((x) => x.ref === 'write-roadmap');
  assert.ok(!/_index\.yml/.test(roadmap.prompt), 'write-roadmap 不跨文档更新规划索引');
});

test('CR-2026-050 AC-03: market-to-plan 简报与 context/intent 契约闭合', () => {
  const p = readPipeline('market-to-plan.pipeline.json');
  const brief = p.nodes.find((x) => x.id.endsWith('000000000002'));
  for (const term of ['mode: brief', 'raw_insight_path', '{{inputs.target_version}}']) assert.ok(brief.prompt.includes(term), `简报调用含 ${term}`);
  assert.ok(!/_index\.yml|source:/.test(brief.prompt), '简报节点不复制索引算法或伪造 source 参数');
  const draft = p.nodes.find((x) => x.ref === 'planning-draft');
  assert.ok(draft.prompt.indexOf('gather-product-context') < draft.prompt.indexOf('planning-draft('), '先取得 context 再 planning-draft');
  for (const term of ['context=', 'intent=', '{{inputs.target_version}}']) assert.ok(draft.prompt.includes(term), `planning-draft 含 ${term}`);
  const entry = p.nodes.find((x) => x.ref === 'write-planning-entry');
  assert.ok(!/market-insights\/_index\.yml|published/.test(entry.prompt), 'write-planning-entry 不跨写 market-insights 生命周期');
  const approval = p.nodes.find((x) => x.kind === 'human_approval');
  assert.ok(!/_index\.yml/.test(approval.approvalPrompt), '人工节点不复制索引写入');
});

test('CR-2026-050 AC-04: competitive-radar slug 解析与 reportDraft→正式落盘顺序闭合', () => {
  const p = readPipeline('competitive-radar.pipeline.json');
  const fetch = p.nodes.find((x) => x.ref === 'fetch-competitor-updates');
  assert.ok(fetch.prompt.includes('competitor-slug: {{inputs.competitor_slug}}'));
  assert.ok(fetch.prompt.includes('lookback-days: {{inputs.since_days}}'));
  assert.ok(!/competitor-id \/ competitor-ids\[\]/.test(fetch.prompt), '不使用模糊参数键');
  const skill = readFileSync(path.join(TOOLS_ROOT, 'skills', 'competitive', 'fetch-competitor-updates', 'SKILL.md'), 'utf8').replaceAll('\r\n', '\n');
  for (const term of ['`competitor-slug`', '唯一精确命中', '不得猜测']) assert.ok(skill.includes(term), `fetch Skill slug 契约含 ${term}`);
  const draft = p.nodes.find((x) => x.ref === 'write-competitive-report');
  for (const term of ['updates-block=node-1', 'product-snapshot', 'confirmed=false', 'reportDraft', 'sourceNodeId', 'sourceRef']) assert.ok(draft.prompt.includes(term), `草稿节点含 ${term}`);
  const suggestion = p.nodes.find((x) => x.ref === 'report-to-planning-suggestion');
  assert.ok(suggestion.prompt.includes('reportDraft'));
  assert.ok(!/reportPath\s*[:=]/.test(suggestion.prompt), '草稿模式不把草稿赋给 reportPath');
  const publish = p.nodes.find((x) => x.ref === 'write-planning-entry');
  assert.ok(publish.prompt.indexOf('write-competitive-report') < publish.prompt.indexOf('write-planning-entry'), '正式报告先于规划条目');
  for (const term of ['updates-block=node-1', 'product-snapshot=node-2', 'confirmed=true']) assert.ok(publish.prompt.includes(term), `正式落盘含 ${term}`);
});

test('CR-2026-050 AC-06/07/11/12: Pipeline 禁止算法文本已彻底下沉', () => {
  const cases = [
    ['architecture-design.pipeline.json', 'write-tech-design', /crctl advance|status=requirement-approved|change-requests\/.*prd\.md|逐条消费|git add|git commit/],
    ['architecture-design.pipeline.json', 'review-tech-design', /crctl review-record|重新执行本评审|maxAttempts/],
    ['requirement-authoring.pipeline.json', 'write-requirement-prd', /change-requests\/|逐条消费|章节结构|knowledge_base_worktree 中写/],
    ['requirement-authoring.pipeline.json', 'review-requirement', /crctl review-record|自动修订|重新执行本评审|maxAttempts/],
    ['code-implementation.pipeline.json', 'write-dev-plan', /status=|sdd\.md|计划章节/],
    ['code-implementation.pipeline.json', 'write-dev-tasks', /crctl task init|plan\.md|sdd\.md|索引失败|接口签名/],
    ['code-implementation.pipeline.json', 'review-dev-plan', /review-record|replayNodes 重放|write-dev-plan →|maxAttempts=3|状态回退由/],
    ['code-implementation.pipeline.json', 'implement-code', /status=developing|按 TASK|依赖顺序|fallback|只修复被指出|重新运行受影响/],
    ['code-implementation.pipeline.json', 'write-test-report', /crctl test|analysis-below|机器区|traceability|重新生成测试报告|验证证据缺失/],
    ['code-implementation.pipeline.json', 'review-code', /runner|评审维度|suggestions|语义：|重新执行 write-test-report|diff range|取证命令/],
    ['feature-writeback.pipeline.json', 'merge-feature-branch', /status=code-approved|code-approved|状态校验/],
  ];
  for (const [name, ref, bad] of cases) {
    const n = readPipeline(name).nodes.find((x) => x.ref === ref);
    assert.ok(n, `${name}/${ref} 存在`);
    assert.doesNotMatch(n.prompt, bad, `${name}/${ref} 无禁项 ${bad}`);
  }
});

test('CR-2026-050 AC-05: 四个 approve Skill 的 grant/TTY 双路径均显式传角色 owner --approver', () => {
  const cases = [
    ['skills/requirement/approve-requirement/SKILL.md', 'requirement', 'requirement'],
    ['skills/develop/approve-tech-design/SKILL.md', 'tech-design', 'development'],
    ['skills/develop/approve-dev-start/SKILL.md', 'dev-start', 'development'],
    ['skills/develop/approve-code/SKILL.md', 'code', 'development'],
  ];
  for (const [rel, stage, role] of cases) {
    const text = readFileSync(path.join(TOOLS_ROOT, rel), 'utf8').replaceAll('\r\n', '\n');
    const owner = `\\{cr\\.md owners\\.${role}\\.id\\}`;
    assert.match(text, new RegExp(`crctl approve \\{cr_id\\} --stage ${stage} --grant --approver ${owner}`), `${stage} grant 路径显式 owner`);
    assert.match(text, new RegExp(`crctl approve \\{cr_id\\} --stage ${stage} --approver ${owner}`), `${stage} TTY 路径显式 owner`);
  }
});

test('CR-2026-050 AC-10: cr-show 最近三次 checkpoint 使用持久化 metadata commit，不引用不存在账本', () => {
  const text = readFileSync(path.join(TOOLS_ROOT, 'skills', 'cr', 'cr-show', 'SKILL.md'), 'utf8').replaceAll('\r\n', '\n');
  assert.ok(text.includes('[cr] checkpoint {cr_id} batch <batchId>'));
  assert.ok(text.includes('latest-checkpoint'));
  assert.ok(!/change-requests\/\{cr-id\}\/checkpoints\.yml|_backlog\.yml#checkpoints/.test(text), '不引用不存在的 checkpoint 历史结构');
});

test('CR-2026-050 AC-12: 8 条 Pipeline 节点数（5/4/12）与 UUID 全局唯一保持不变', () => {
  const expected = {
    'product-planning.pipeline.json': 8,
    'requirement-authoring.pipeline.json': 5,
    'architecture-design.pipeline.json': 4,
    'code-implementation.pipeline.json': 12,
    'feature-writeback.pipeline.json': 5,
    'resume-cr.pipeline.json': 3,
    'competitive-radar.pipeline.json': 5,
    'market-to-plan.pipeline.json': 5,
  };
  const ids = [];
  for (const [name, count] of Object.entries(expected)) {
    const p = readPipeline(name);
    assert.ok(Array.isArray(p.nodes) && p.nodes.length > 0, `${name} 节点集非空（解析失败必须硬失败）`);
    assert.equal(p.nodes.length, count, `${name} 节点数（CR-2026-066 退役后口径）`);
    ids.push(...p.nodes.map((n) => n.id));
  }
  assert.equal(new Set(ids).size, ids.length, '8 条 Pipeline UUID 全局唯一');
});

/* ── CR-2026-055：评审分层最小改造——reviewer 输入/资源/权限/负向断言 ── */

test('CR-2026-055 AC-1/AC-7: 两个 reviewer 节点原样传递 workspace/resources/feedback/attempt', () => {
  const arch = readPipeline('architecture-design.pipeline.json');
  const rtd = arch.nodes.find((n) => n.ref === 'review-tech-design');
  for (const term of ['cr_id', 'workspace', 'resources', 'review_feedback', 'self_repair_attempt']) {
    assert.ok(rtd.prompt.includes(term), `architecture review-tech-design 传 ${term}`);
  }
  assert.ok(/resources: \{workspace inspect\.resources/.test(rtd.prompt), 'architecture resources 来自同次 workspace inspect');

  const code = readPipeline('code-implementation.pipeline.json');
  const rdp = code.nodes.find((n) => n.ref === 'review-dev-plan');
  for (const term of ['cr_id', 'workspace', 'resources', 'review_feedback', 'self_repair_attempt']) {
    assert.ok(rdp.prompt.includes(term), `code review-dev-plan 传 ${term}`);
  }
  assert.ok(/resources: \{execution_context\.resources/.test(rdp.prompt), 'code resources 来自 node-1 execution_context');
  assert.ok(!/resources: \{workspace inspect\.resources/.test(rdp.prompt), 'code review-dev-plan 不重新 inspect');
});

test('CR-2026-055 AC-1/AC-8: reviewer Skill 输入合同与 controlled-shell 只读权限', () => {
  for (const rel of ['skills/develop/review-tech-design/SKILL.md', 'skills/develop/review-dev-plan/SKILL.md']) {
    const text = readFileSync(path.join(TOOLS_ROOT, rel), 'utf8').replaceAll('\r\n', '\n');
    for (const term of ['`cr_id`', '`workspace`', '`resources`', '`review_feedback`', '`self_repair_attempt`', 'worktreePath']) {
      assert.ok(text.includes(term), `${rel} 含 ${term}`);
    }
  }
  const matrix = readFileSync(path.join(TOOLS_ROOT, 'agent-skill-matrix.yml'), 'utf8').replaceAll('\r\n', '\n');
  const qr = matrix.match(/  quality-reviewer-agent:\n(?:.*\n)*?\s*can-call:\n((?:\s+- \S+\n)*)/);
  assert.ok(qr, 'quality-reviewer-agent.can-call 存在');
  assert.match(qr[1], /- controlled-shell\n/, 'quality-reviewer-agent.can-call 含 controlled-shell');
  const cs = readFileSync(path.join(TOOLS_ROOT, 'skills/shared/controlled-shell/SKILL.md'), 'utf8').replaceAll('\r\n', '\n');
  for (const reviewer of ['review-tech-design', 'review-dev-plan']) {
    assert.ok(cs.includes(reviewer), `controlled-shell 说明含 ${reviewer}`);
  }
});

test('CR-2026-055 AC-8 负向: reviewer 节点 prompt 无 review-record/账本路径/取证命令/测试执行', () => {
  for (const [name, ref] of [
    ['architecture-design.pipeline.json', 'review-tech-design'],
    ['code-implementation.pipeline.json', 'review-dev-plan'],
  ]) {
    const n = readPipeline(name).nodes.find((x) => x.ref === ref);
    const t = n.prompt || '';
    assert.ok(!/crctl review-record/.test(t), `${ref} prompt 无 review-record 命令细节`);
    assert.ok(!/review-annotations|review-loop|traceability/.test(t), `${ref} prompt 无账本写入路径`);
    assert.ok(!/git (diff|log|merge-base|rev-parse)/.test(t), `${ref} prompt 无取证命令细节`);
    assert.ok(!/node --test|lint|npm test/.test(t), `${ref} prompt 无测试执行要求`);
  }
});

test('CR-2026-055 blocker 修复: SDD 依赖清单输出与 reviewer 消费规则明确', () => {
  const writer = readFileSync(path.join(TOOLS_ROOT, 'skills/develop/write-tech-design/SKILL.md'), 'utf8').replaceAll('\r\n', '\n');
  for (const term of ['### 既有实现依赖与事实', '正文首次出现顺序', 'repo:', 'relative path:', 'stable symbol/对象:', 'commit SHA:', '依赖结论:', 'sdd.explicit_existing_dependencies']) {
    assert.ok(writer.includes(term), `write-tech-design 合同含 ${term}`);
  }
  const reviewer = readFileSync(path.join(TOOLS_ROOT, 'skills/develop/review-tech-design/SKILL.md'), 'utf8').replaceAll('\r\n', '\n');
  for (const term of ['名为“既有实现依赖与事实”的显式小节', '有序清单', 'sdd.explicit_existing_dependencies', '正文同类事实是否漏列']) {
    assert.ok(reviewer.includes(term), `review-tech-design 规则含 ${term}`);
  }
});

test('CR-2026-055 blocker 修复: 权限解释文档同步新增 can-call 关系', () => {
  const matrixDoc = readFileSync(path.join(TOOLS_ROOT, 'AGENT-SKILL-MATRIX.md'), 'utf8').replaceAll('\r\n', '\n');
  assert.ok(matrixDoc.includes('本 CR 的权限变更补充如下'), '权限文档含 CR 变更说明');
  assert.match(matrixDoc, /quality-reviewer-agent.*controlled-shell/s, '权限文档记录 reviewer 的 controlled-shell can-call');
  assert.ok(matrixDoc.includes('仅用于 `review-tech-design` 与 `review-dev-plan`'), '权限文档记录只读约束');
});

/* ── CR-2026-066 TASK-02：评审 PASS 发布 / clean 前置 / 权限面（AC-3 / AC-4②③④ + S-13 负向面） ── */

const REVIEW_SKILLS = [
  ['skills/requirement/review-requirement/SKILL.md', '需求评审通过'],
  ['skills/develop/review-tech-design/SKILL.md', '技术设计评审通过'],
  ['skills/develop/review-dev-plan/SKILL.md', '开发计划评审通过'],
  ['skills/develop/review-code/SKILL.md', '代码评审通过'],
];
const readToolsFile = (rel) => readFileSync(path.join(TOOLS_ROOT, ...rel.split('/')), 'utf8').replaceAll('\r\n', '\n');
/** 取某个稳定节名起至下一个 `## ` 标题（含各级标题）之间的文本；节缺失返回 null。 */
const sectionOf = (text, heading) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return null;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && /^#{1,3} /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
};

test('CR-2026-066 AC-3/AC-4: 四 review SKILL 的 clean 前置 + PASS 发布 + 对账 + 权限面四处载体（断言 A/B/C/D）', () => {
  const matrix = readToolsFile('agent-skill-matrix.yml');
  const matrixDoc = readToolsFile('AGENT-SKILL-MATRIX.md');
  const qrDoc = readToolsFile('agents/quality-reviewer-agent.md');

  // A：四个 review SKILL 的四要素（clean 前置 / PASS 发布 / 对账 / BLOCK 不发布）
  for (const [rel, message] of REVIEW_SKILLS) {
    const text = readToolsFile(rel);
    assert.ok(text.length > 3000, `${rel} 文本读出且非空（读不到即硬失败）`);
    for (const token of ['crctl workspace inspect', 'healthy', '请作者先提交', 'classification']) {
      assert.ok(text.includes(token), `${rel} 缺 clean 前置 token ${token}`);
    }
    assert.ok(text.includes('push-progress'), `${rel} 缺发布步骤 push-progress`);
    assert.ok(text.includes(message), `${rel} 缺本阶段发布 message：${message}`);
    for (const token of ['phase', 'batchId', 'repositories', 'metadataCommit']) {
      assert.ok(text.includes(token), `${rel} 缺发布结果消费字段 ${token}`);
    }
    assert.ok(text.includes('CONTRACT_DRIFT'), `${rel} 缺对账失败语义 CONTRACT_DRIFT`);
    assert.ok(text.includes('不改 verdict'), `${rel} 缺「不改 verdict」对账失败语义`);
    assert.ok(text.includes('BLOCK 分支不含任何发布调用'), `${rel} 缺 BLOCK 分支不含发布的表述`);
  }

  // B：tools 三处载体（① 矩阵 + ② 派生表 + ③a 权限事实源）与 A 的前置同一条断言内校验
  const canCall = matrix.match(/  quality-reviewer-agent:\n(?:.*\n)*?\s*can-call:\n((?:\s+- \S+\n)*)/);
  assert.ok(canCall, '① agent-skill-matrix.yml 的 quality-reviewer-agent.can-call 存在');
  assert.ok(/- push-progress\n/.test(canCall[1]), '① can-call 含 push-progress');
  const forbidden = matrix.match(/  quality-reviewer-agent:\n(?:.*\n)*?\s*forbidden:\n((?:\s+- \S+\n)*)/);
  assert.ok(forbidden, '① agent-skill-matrix.yml 的 quality-reviewer-agent.forbidden 存在');
  assert.equal(/- push-progress\n/.test(forbidden[1]), false, '① forbidden 已移除 push-progress');
  assert.ok(/- checkpoint\n/.test(forbidden[1]), '① forbidden 仍含 checkpoint');
  assert.ok(/只读 workspace inspect/.test(matrix), '① 矩阵块注释声明只读 workspace inspect');
  const permSection = sectionOf(matrixDoc, '## 本 CR 权限变更');
  assert.ok(permSection, '② AGENT-SKILL-MATRIX.md 有「本 CR 权限变更」节');
  const crRow = permSection.split('\n').find((l) => l.includes('CR-2026-066'));
  assert.ok(crRow, '② 本 CR 权限变更节含 CR-2026-066 行');
  assert.ok(crRow.includes('workspace inspect'), '② 本 CR 行含只读 workspace inspect');
  assert.ok(crRow.includes('push-progress'), '② 本 CR 行含 push-progress');
  const factSection = sectionOf(qrDoc, '## 权限事实源');
  assert.ok(factSection && factSection.includes('workspace inspect'), '③a 权限事实源节含只读 workspace inspect');

  // C：反向断言——四个 review SKILL 不含 crctl checkpoint（发布只经 push-progress Skill）
  for (const [rel] of REVIEW_SKILLS) {
    const text = readToolsFile(rel);
    assert.ok(text.length > 3000, `${rel} 文本读出且非空（防空集合静默通过）`);
    assert.equal(text.includes('crctl checkpoint'), false, `${rel} 不得含 crctl checkpoint`);
  }

  // D：S-13 负向断言——旧 checkpoint 前提句三个 token 零命中
  for (const [rel] of REVIEW_SKILLS) {
    const text = readToolsFile(rel);
    assert.ok(text.length > 3000, `${rel} 文本读出且非空（防空集合静默通过）`);
    for (const token of ['push-progress 之后', 'push-progress 之前', '统一 checkpoint 后']) {
      assert.equal(text.includes(token), false, `${rel} 保留旧 checkpoint 前提句 ${token}`);
    }
  }
});

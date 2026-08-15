// CR-2026-039 TASK-04：code-implementation.pipeline.json 结构测试（node --test，零依赖）。
// 覆盖 AC-1～AC-4：checkpoint 节点序、onFail/ref、节点 id 全局唯一、reviewLoop.replayNodes 逐字不变、
// inputs 无 suggestion_policy。
//
// 运行：node --test skills/shared/crctl/scripts/test/pipeline-structure.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PIPELINE_PATH = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'pipeline-templates', 'code-implementation.pipeline.json');
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

test('AC-2: checkpoint 节点 onFail=abort、ref=push-progress；节点 id 全局唯一（含 …0015 与既有 14 节点）', () => {
  const n = bySuffix('000000000015');
  assert.equal(n.onFail, 'abort');
  assert.equal(n.ref, 'push-progress');
  assert.equal(n.kind, 'skill');
  assert.ok(/checkpoint/i.test(n.label), 'label 表达 checkpoint 语义');
  assert.ok(n.prompt.includes('{{inputs.cr_id}}'), 'prompt 引用 cr_id');
  const ids = nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, '节点 id 全局唯一');
  assert.equal(ids.length, 15, '既有 14 节点 + 新增 1 节点');
});

test('AC-3: review-code reviewLoop.replayNodes 与现状逐字一致（implement-code→write-test-report→push-progress→review-code）', () => {
  const n = bySuffix('000000000009');
  assert.deepEqual(n.reviewLoop.replayNodes, [
    { nodeId: '00000000-0000-0000-0015-000000000006', ref: 'implement-code', purpose: 'repair-code' },
    { nodeId: '00000000-0000-0000-0015-000000000007', ref: 'write-test-report', purpose: 'regenerate-test-evidence' },
    { nodeId: '00000000-0000-0000-0015-000000000008', ref: 'push-progress', purpose: 'publish-repaired-code-and-evidence-checkpoint' },
    { nodeId: '00000000-0000-0000-0015-000000000009', ref: 'review-code', purpose: 'rerun-current-review' },
  ], 'replayNodes 不被本 CR 改动');
  assert.equal(n.reviewLoop.maxAttempts, 3);
});

test('AC-4: inputs 中无 suggestion_policy', () => {
  assert.ok(Array.isArray(pipeline.inputs));
  assert.ok(!pipeline.inputs.some((i) => i.key === 'suggestion_policy'), 'suggestion_policy 已删除');
});

test('human_approval(…0010) approvalPrompt 含评审后 checkpoint phase=complete 前提', () => {
  const n = bySuffix('000000000010');
  assert.ok(n.approvalPrompt.includes('评审后 checkpoint phase=complete'), '审批提示追加 checkpoint 前提');
});

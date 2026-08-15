// CR-2026-039 TASK-05：review canonical 文本契约收敛扫描测试（node --test，零依赖）。
// AC-1：三个 CR Pipeline JSON 与清单内 11 个 SKILL.md 对 repair-instructions/fixed-blockers/
//       suggestion_policy/suggestion-policy 零命中；可执行回修说明并入 blocker 文本（SDD §4.5）。
// AC-2：三个 Pipeline 的 reviewLoop 结构（repairNodeId/repairRef/replayNodes/passCondition/maxAttempts）
//       与修订前逐字段一致（结构快照断言）。
// AC-3：canonical 落盘行为零变化——由 crctl.test.mjs 既有 review-record schema 用例覆盖，本文件不重复。
//
// 白名单（显式不在扫描断言范围，归实施 CR 5）：
//   - pipeline-templates/product-planning.pipeline.json 与 skills/planning/*（无 CR 上下文，独立合同）
//   - agents/*.md 与 README 中的残留引用
//   - skills/shared/crctl/scripts/test/*（测试文件本身含被扫描字符串作为模式）
//
// 运行：node --test skills/shared/crctl/scripts/test/contract-scan.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const FORBIDDEN = ['repair-instructions', 'fixed-blockers', 'suggestion_policy', 'suggestion-policy'];

const PIPELINES = [
  'pipeline-templates/requirement-authoring.pipeline.json',
  'pipeline-templates/architecture-design.pipeline.json',
  'pipeline-templates/code-implementation.pipeline.json',
];

const SKILLS = [
  'skills/requirement/write-requirement-prd/SKILL.md',
  'skills/requirement/review-requirement/SKILL.md',
  'skills/develop/write-tech-design/SKILL.md',
  'skills/develop/review-tech-design/SKILL.md',
  'skills/develop/write-dev-plan/SKILL.md',
  'skills/develop/write-dev-tasks/SKILL.md',
  'skills/develop/review-dev-plan/SKILL.md',
  'skills/develop/implement-code/SKILL.md',
  'skills/develop/review-code/SKILL.md',
  'skills/develop/write-test-report/SKILL.md',
  'skills/develop/coding-discipline/SKILL.md',
];

test('AC-1: 三个 CR Pipeline 与 11 个 SKILL.md 对废弃 canonical 字段零命中', () => {
  for (const rel of [...PIPELINES, ...SKILLS]) {
    const text = readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8').replaceAll('\r\n', '\n');
    for (const w of FORBIDDEN) {
      assert.ok(!text.includes(w), `${rel} 不得含 "${w}"`);
    }
  }
});

test('AC-2a: requirement-authoring reviewLoop 结构快照不变', () => {
  const p = JSON.parse(readFileSync(path.join(ROOT, 'pipeline-templates', 'requirement-authoring.pipeline.json'), 'utf8'));
  const n = p.nodes.find((x) => x.ref === 'review-requirement');
  assert.deepEqual(
    { repairNodeId: n.reviewLoop.repairNodeId, repairRef: n.reviewLoop.repairRef, maxAttempts: n.reviewLoop.maxAttempts, passCondition: n.reviewLoop.passCondition },
    {
      repairNodeId: '00000000-0000-0000-0011-000000000002', repairRef: 'write-requirement-prd', maxAttempts: 3,
      passCondition: { allOf: [{ path: 'verdict', equals: 'pass' }, { path: 'blockers', isEmpty: true }] },
    },
  );
});

test('AC-2b: architecture-design reviewLoop 结构快照不变', () => {
  const p = JSON.parse(readFileSync(path.join(ROOT, 'pipeline-templates', 'architecture-design.pipeline.json'), 'utf8'));
  const n = p.nodes.find((x) => x.ref === 'review-tech-design');
  assert.deepEqual(
    { repairNodeId: n.reviewLoop.repairNodeId, repairRef: n.reviewLoop.repairRef, maxAttempts: n.reviewLoop.maxAttempts, passCondition: n.reviewLoop.passCondition },
    {
      repairNodeId: '00000000-0000-0000-0016-000000000001', repairRef: 'write-tech-design', maxAttempts: 3,
      passCondition: { allOf: [{ path: 'verdict', equals: 'pass' }, { path: 'blockers', isEmpty: true }] },
    },
  );
});

test('AC-2c: code-implementation review-code reviewLoop 结构快照不变', () => {
  const p = JSON.parse(readFileSync(path.join(ROOT, 'pipeline-templates', 'code-implementation.pipeline.json'), 'utf8'));
  const n = p.nodes.find((x) => x.ref === 'review-code');
  assert.equal(n.reviewLoop.repairNodeId, '00000000-0000-0000-0015-000000000006');
  assert.equal(n.reviewLoop.repairRef, 'implement-code');
  assert.equal(n.reviewLoop.replayPolicy, 'rerun-listed-nodes-in-order');
  assert.equal(n.reviewLoop.maxAttempts, 3);
  assert.deepEqual(n.reviewLoop.replayNodes.map((r) => r.ref), ['implement-code', 'write-test-report', 'push-progress', 'review-code']);
  assert.deepEqual(n.reviewLoop.passCondition, {
    allOf: [
      { path: 'verdict', equals: 'pass' },
      { path: 'blockers', isEmpty: true },
      { path: 'test-report.status', equals: 'pass' },
    ],
  });
});

test('AC-1 补充：三个 Pipeline JSON 可解析（prompt 修订未破坏 JSON 结构）', () => {
  for (const rel of PIPELINES) {
    const p = JSON.parse(readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8'));
    assert.ok(Array.isArray(p.nodes) && p.nodes.length > 0, `${rel} 节点非空`);
  }
});

/* ─────────── CR-2026-041 FR-06/FR-07：退役静态扫描 ─────────── */

const RETIRED = ['change-impact-analysis', 'feedback-writeback', 'feedback-writeback-done'];
const ACTIVE_PATHS = [
  'skills/_index.yml',
  'agent-skill-matrix.yml',
  'AGENT-SKILL-MATRIX.md',
  'agents/_index.yml',
  'agents/quality-reviewer-agent.md',
  'README.md',
  'docs/QODER-使用指南.md',
  'openwiki/architecture/agent-skill-matrix.md',
  'dir-graph.yaml',
  'skills/review/review-alignment/SKILL.md',
  'skills/cr/inbox-emit/SKILL.md',
];

test('CR-2026-041 FR-06/07：active 路径零退役 Skill 引用', () => {
  for (const rel of ACTIVE_PATHS) {
    const text = readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8').replaceAll('\r\n', '\n');
    for (const w of RETIRED) {
      assert.ok(!text.includes(w), `${rel} 不得含 "${w}"`);
    }
  }
});

test('CR-2026-041 FR-06/07：退役 Skill 目录已删除（历史快照除外）', () => {
  assert.ok(!existsSync(path.join(ROOT, 'skills', 'review', 'change-impact-analysis', 'SKILL.md')), 'change-impact-analysis SKILL 已删除');
  assert.ok(!existsSync(path.join(ROOT, 'skills', 'cr', 'feedback-writeback', 'SKILL.md')), 'feedback-writeback SKILL 已删除');
});

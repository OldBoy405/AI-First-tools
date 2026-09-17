// FR-2 调用方合同测试（CR-2026-069 TASK-08，SDD §4.10 / §8 / AC-21①）。
// 运行：node --test --test-reporter=dot skills/shared/crctl/scripts/test/caller-contract.test.mjs
//
// 扫描面 = skills/**/SKILL.md、pipeline-templates/*.pipeline.json、agents/*.md、skills/**/*.mjs、README.md。
// 逐条判定：
//   a. 子命令 ∉ 投影集合            → 无需动作（输出未变）
//   b. 子命令 ∈ 投影集合 ∧ 消费字段 ⊆ summary 字段集 → 无需动作
//   c. 子命令 ∈ 投影集合 ∧ 需要 summary 之外的字段   → **必须显式补 --detail**
// 下表是人工审过的白名单；断言是机械的（任何调用点与表不符即红）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const TOOLS_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');

const PROJECTED = ['crctl advance', 'crctl review-record', 'crctl status', 'crctl workspace inspect'];
const TWO_WORD = new Set(['workspace', 'task', 'merge']);

/** 人工审过的调用方表（白名单）：投影命令 × 扫描面文件。verdict ∈ {no-action, detail-required, doc-only}。 */
export const REVIEWED_CALLS = [
  { file: 'skills/develop/review-tech-design/SKILL.md', command: 'crctl workspace inspect', verdict: 'detail-required', note: '需 resources[].head / localBranch / remoteBranch 断言实际检出分支' },
  { file: 'skills/develop/review-tech-design/SKILL.md', command: 'crctl review-record', verdict: 'no-action', note: '消费 file/verdict/route/attempt/files，全在 summary 内' },
  { file: 'skills/develop/review-tech-design/SKILL.md', command: 'crctl advance', verdict: 'no-action', note: '消费 to/from/trigger/committed，全在 summary 内' },
  { file: 'skills/develop/review-code/SKILL.md', command: 'crctl workspace inspect', verdict: 'detail-required', note: '同上' },
  { file: 'skills/develop/review-code/SKILL.md', command: 'crctl review-record', verdict: 'no-action', note: '同上' },
  { file: 'skills/develop/review-code/SKILL.md', command: 'crctl advance', verdict: 'no-action', note: '同上' },
  { file: 'skills/develop/review-dev-plan/SKILL.md', command: 'crctl workspace inspect', verdict: 'detail-required', note: '同上' },
  { file: 'skills/develop/review-dev-plan/SKILL.md', command: 'crctl review-record', verdict: 'no-action', note: '同上' },
  { file: 'skills/develop/review-dev-plan/SKILL.md', command: 'crctl advance', verdict: 'no-action', note: '同上' },
  { file: 'skills/requirement/review-requirement/SKILL.md', command: 'crctl workspace inspect', verdict: 'detail-required', note: '同上' },
  { file: 'skills/requirement/review-requirement/SKILL.md', command: 'crctl review-record', verdict: 'no-action', note: '同上' },
  { file: 'skills/requirement/review-requirement/SKILL.md', command: 'crctl advance', verdict: 'no-action', note: '同上' },
  { file: 'skills/shared/crctl/SKILL.md', command: 'crctl status', verdict: 'doc-only', note: '权威 Skill 文档：同时展示默认面与 --detail 面，不作为运行时调用点' },
  { file: 'skills/shared/crctl/SKILL.md', command: 'crctl advance', verdict: 'doc-only', note: '同上' },
  { file: 'agents/dev-agent.md', command: 'crctl status', verdict: 'no-action', note: '仅取状态与门禁叙述，不消费 source' },
  { file: 'agents/quality-reviewer-agent.md', command: 'crctl status', verdict: 'no-action', note: '同上' },
  { file: 'agents/requirement-writer.md', command: 'crctl status', verdict: 'no-action', note: '同上' },
  { file: 'agents/delivery-agent.md', command: 'crctl status', verdict: 'no-action', note: '同上' },
  { file: 'skills/cr/cr-archive/SKILL.md', command: 'crctl status', verdict: 'no-action', note: '只读 status 值做前置确认，不消费 source' },
  { file: 'skills/shared/crctl/scripts/crctl.mjs', command: 'crctl status', verdict: 'doc-only', note: 'HELP 文本：接口文档面，非运行时调用点' },
  { file: 'skills/shared/crctl/scripts/crctl.mjs', command: 'crctl advance', verdict: 'doc-only', note: '同上' },
  { file: 'skills/shared/crctl/scripts/crctl.mjs', command: 'crctl review-record', verdict: 'doc-only', note: '同上' },
  { file: 'skills/cr/cr-review-record/SKILL.md', command: 'crctl advance', verdict: 'no-action', note: '消费 to/from/committed，全在 summary 内' },
  { file: 'skills/develop/write-dev-tasks/SKILL.md', command: 'crctl advance', verdict: 'no-action', note: '同上' },
  { file: 'skills/develop/write-tech-design/SKILL.md', command: 'crctl workspace inspect', verdict: 'no-action', note: '只消费 resources[].worktreePath 与 operationalWorkspace' },
  { file: 'skills/develop/write-tech-design/SKILL.md', command: 'crctl advance', verdict: 'no-action', note: '消费 to/from/committed' },
  { file: 'skills/shared/crctl/adapters/claude-code/hooks/inject-cr-status.mjs', command: 'crctl status', verdict: 'no-action', note: 'Prompt 文案里的建议命令，不消费输出字段' },
  { file: 'skills/shared/crctl/scripts/lib/summary-projectors.mjs', command: 'crctl status', verdict: 'doc-only', note: '注册表键与 JSDoc：投影实现本体，非调用点' },
  { file: 'skills/shared/crctl/scripts/lib/summary-projectors.mjs', command: 'crctl advance', verdict: 'doc-only', note: '同上' },
  { file: 'skills/shared/crctl/scripts/lib/summary-projectors.mjs', command: 'crctl review-record', verdict: 'doc-only', note: '同上' },
  { file: 'skills/shared/crctl/scripts/lib/summary-projectors.mjs', command: 'crctl workspace inspect', verdict: 'doc-only', note: '同上' },
  { file: 'skills/shared/crctl/scripts/lint-prompts.mjs', command: 'crctl advance', verdict: 'no-action', note: '静态文本 lint 的规则正则，不运行 crctl' },
  { file: 'skills/shared/crctl/scripts/lint-prompts.mjs', command: 'crctl status', verdict: 'no-action', note: '同上' },
  { file: 'skills/shared/crctl/scripts/test/lint-prompts.test.mjs', command: 'crctl advance', verdict: 'no-action', note: '测试夹具字符串，不消费 crctl 输出' },
  { file: 'skills/shared/crctl/scripts/test/lint-prompts.test.mjs', command: 'crctl review-record', verdict: 'no-action', note: '同上' },
  { file: 'skills/shared/crctl/scripts/test/pipeline-structure.test.mjs', command: 'crctl advance', verdict: 'no-action', note: '测试夹具字符串，不消费 crctl 输出' },
  { file: 'skills/shared/crctl/scripts/test/pipeline-structure.test.mjs', command: 'crctl review-record', verdict: 'no-action', note: '同上' },
  { file: 'skills/sync/pull-progress/SKILL.md', command: 'crctl workspace inspect', verdict: 'no-action', note: '只消费 resources[].worktreePath' },
  { file: 'skills/writeback/merge-feature-branch/SKILL.md', command: 'crctl status', verdict: 'no-action', note: '只读 status 值做前置确认' },
  { file: 'agents/quality-reviewer-agent.md', command: 'crctl review-record', verdict: 'no-action', note: '只描述该子命令在允许面内，不消费输出字段' },
  { file: 'pipeline-templates/architecture-design.pipeline.json', command: 'crctl workspace inspect', verdict: 'no-action', note: 'prompt 内只消费 resources[].worktreePath' },
  { file: 'pipeline-templates/code-implementation.pipeline.json', command: 'crctl workspace inspect', verdict: 'no-action', note: '同上' },
  { file: 'skills/shared/metrics/test/cr-cost.test.mjs', command: 'crctl status', verdict: 'doc-only', note: '纯函数回归面的夹具数据字符串，非调用点' },
  { file: 'README.md', command: 'crctl status', verdict: 'doc-only', note: 'README 是接口文档面，非运行时调用点' },
  { file: 'README.md', command: 'crctl review-record', verdict: 'doc-only', note: '同上' },
  { file: 'skills/shared/crctl/scripts/crctl.mjs', command: 'crctl workspace inspect', verdict: 'doc-only', note: '同上' },
];

/** 扫描面之外的**真实**调用方（不因「在扫描面外」而豁免，逐条做同一字段消费检查）。 */
export const OUT_OF_SURFACE_CALLERS = [
  { repo: 'ai-first-platform-docs', file: '.github/workflows/cr-guard.yml', commands: ['crctl validate', 'crctl gate'], verdict: 'no-action', note: '只消费退出码与 crctl validate/gate 的输出，二者均不在投影集合内' },
];

function extractProjected(text) {
  const out = [];
  const RE = /crctl(?:\.mjs)?["']?\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/g;
  text.split('\n').forEach((raw, i) => {
    RE.lastIndex = 0;
    for (const m of raw.matchAll(RE)) {
      // 排除字符串字面量形式的注册表键（'crctl advance': fn）与 JS 内的命令行常量。
      const prev = m.index > 0 ? raw[m.index - 1] : '';
      if (prev === "'" || prev === '"') continue;
      const sub = m[1];
      const sub2 = m[2];
      const cmd = TWO_WORD.has(sub) && sub2 ? 'crctl ' + sub + ' ' + sub2 : 'crctl ' + sub;
      if (!PROJECTED.includes(cmd)) continue;
      out.push({ file: null, line: i + 1, command: cmd, hasDetail: /--detail\b/.test(raw) });
    }
  });
  return out;
}

function walk(dir, filter, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'golden') continue;
      walk(p, filter, acc);
      continue;
    }
    if (filter(p)) acc.push(p);
  }
  return acc;
}

function scanSurface() {
  const files = [];
  walk(path.join(TOOLS_ROOT, 'skills'), (p) => p.endsWith('SKILL.md') || p.endsWith('.mjs'), files);
  walk(path.join(TOOLS_ROOT, 'agents'), (p) => p.endsWith('.md'), files);
  for (const f of fs.readdirSync(path.join(TOOLS_ROOT, 'pipeline-templates'))) {
    if (f.endsWith('.pipeline.json')) files.push(path.join(TOOLS_ROOT, 'pipeline-templates', f));
  }
  const readme = path.join(TOOLS_ROOT, 'README.md');
  if (fs.existsSync(readme)) files.push(readme);
  const found = [];
  for (const abs of files) {
    const rel = path.relative(TOOLS_ROOT, abs).split(path.sep).join('/');
    const text = fs.readFileSync(abs, 'utf8').split('\r\n').join('\n');
    for (const hit of extractProjected(text)) found.push({ ...hit, file: rel });
  }
  return found;
}

const SURFACE = scanSurface();

test('caller-01 扫描面内每处投影命令调用都在已审表内（无未登记调用点）', () => {
  const table = new Set(REVIEWED_CALLS.map((r) => r.file + '|' + r.command));
  const missing = [...new Set(SURFACE.map((h) => h.file + '|' + h.command))].filter((k) => !table.has(k));
  assert.deepEqual(missing, [], '未登记的调用点: ' + missing.join(', '));
});

test('caller-02 已审表无陈旧行（每条都真的出现在扫描面内）', () => {
  const found = new Set(SURFACE.map((h) => h.file + '|' + h.command));
  const stale = REVIEWED_CALLS.filter((r) => r.verdict !== 'doc-only').map((r) => r.file + '|' + r.command).filter((k) => !found.has(k));
  assert.deepEqual(stale, [], '陈旧登记: ' + stale.join(', '));
});

test('caller-03 判为 detail-required 的调用点必须显式带 --detail', () => {
  for (const row of REVIEWED_CALLS.filter((r) => r.verdict === 'detail-required')) {
    const hits = SURFACE.filter((h) => h.file === row.file && h.command === row.command);
    assert.ok(hits.length > 0, row.file + ' 未找到 ' + row.command);
    for (const h of hits) {
      assert.ok(h.hasDetail, row.file + ':' + h.line + ' ' + row.command + ' 缺 --detail（需要 summary 之外的字段）');
    }
  }
});

test('caller-04 判为 no-action 的调用点不需要 --detail（summary 覆盖其消费字段）', () => {
  for (const row of REVIEWED_CALLS.filter((r) => r.verdict === 'no-action')) {
    const hits = SURFACE.filter((h) => h.file === row.file && h.command === row.command);
    for (const h of hits) {
      assert.ok(!h.hasDetail, row.file + ':' + h.line + ' 判为 no-action 却带上 --detail（表与实际不一致）');
    }
  }
});

test('caller-05 扫描面之外的真实调用方逐条登记并按字段消费判定', () => {
  assert.ok(OUT_OF_SURFACE_CALLERS.length >= 1, '扫描面外真实调用方未登记');
  for (const row of OUT_OF_SURFACE_CALLERS) {
    assert.ok(row.repo && row.file && Array.isArray(row.commands) && row.verdict, '登记行不完整');
    for (const c of row.commands) {
      assert.ok(!PROJECTED.includes(c), '扫描面外的调用点若命中投影集合必须补 --detail（当前登记为无需动作）: ' + c);
    }
  }
});

test('caller-06 投影注册表是投影实现本体：其命中一律登记为 doc-only（不构成运行时调用点）', () => {
  const registry = path.join(TOOLS_ROOT, 'skills/shared/crctl/scripts/lib/summary-projectors.mjs');
  assert.ok(fs.existsSync(registry), '缺 summary-projectors.mjs');
  const hits = SURFACE.filter((h) => h.file.endsWith('summary-projectors.mjs'));
  for (const h of hits) {
    const row = REVIEWED_CALLS.find((r) => r.file === h.file && r.command === h.command);
    assert.ok(row && row.verdict === 'doc-only', '注册表内的命中必须登记为 doc-only: ' + h.command);
  }
  const text = fs.readFileSync(registry, 'utf8');
  for (const cmd of PROJECTED) assert.ok(text.includes("'" + cmd + "'"), '注册表缺键 ' + cmd);
});

test('caller-07 四个 review Skill 已采纳 AC-16 取证完整性条款', () => {
  for (const rel of ['skills/develop/review-tech-design/SKILL.md', 'skills/develop/review-code/SKILL.md', 'skills/develop/review-dev-plan/SKILL.md', 'skills/requirement/review-requirement/SKILL.md']) {
    const t = fs.readFileSync(path.join(TOOLS_ROOT, rel), 'utf8').split('\r\n').join('\n');
    assert.ok(t.includes('complete=false'), rel + ' 缺 complete=false 条款');
    assert.ok(/offset\/limit|逃生阀/.test(t), rel + ' 缺继续取证或逃生阀的可执行路径');
  }
});

test('caller-08 权威 Skill 文档已记录 --detail 的默认面语义', () => {
  const t = fs.readFileSync(path.join(TOOLS_ROOT, 'skills/shared/crctl/SKILL.md'), 'utf8').split('\r\n').join('\n');
  assert.ok(t.includes('--detail'), 'crctl SKILL 缺 --detail');
  assert.ok(t.includes('summary'), 'crctl SKILL 缺默认输出为 compact summary 的说明');
  assert.ok(t.includes('summary-projectors.mjs'), 'crctl SKILL 必须只指向注册表、不复刻字段清单');
});

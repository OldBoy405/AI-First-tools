// writeback.test.mjs — writeback 回写脚本回归自检套件（CR-2026-020，TASK-05 / NFR-6 / AC-8）
// 覆盖：lib.mjs / writeback-prd-sdd.mjs / writeback-tasks.mjs / writeback-traceability.mjs
// 运行：node --test tools/skills/writeback/scripts/test/writeback.test.mjs
// 数据：临时目录（node:fs.mkdtempSync），不依赖外部固定状态；结束时清理。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lib from '../lib.mjs';

const SCRIPTS = path.join(import.meta.dirname, '..');
const PRD_SDD = path.join(SCRIPTS, 'writeback-prd-sdd.mjs');
const TASKS = path.join(SCRIPTS, 'writeback-tasks.mjs');
const TRACE = path.join(SCRIPTS, 'writeback-traceability.mjs');

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wbtest-'));
}

function run(script, ws, args) {
  const r = spawnSync(process.execPath, [script, ...args, '--workspace', ws], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/* ─────────── lib.mjs ─────────── */

test('lib: CRLF 归一 + frontmatter 读改（纪律 #1）', () => {
  const t = '---\nid: x\r\nversion: v1\r\n---\r\n# body\r\n';
  const out = lib.patchFrontmatterField(t, 'version', 'v2');
  assert.ok(!out.includes('\r'));
  assert.ok(out.includes('version: v2'));
  assert.ok(out.includes('# body'));
});

test('lib: 锚点唯一性断言（0 次插入 / 1 次替换 / ≥2 次硬失败）', () => {
  const add = lib.patchFrontmatterField('---\nid: x\n---\n', 'spec-id', 'sp');
  assert.ok(add.includes('spec-id: sp'));
  const q = lib.patchFrontmatterField('---\ntarget-version: "0.1"\n---\n', 'target-version', '0.2');
  assert.ok(q.includes('target-version: "0.2"'));
  // ≥2 次命中 → fail（进程非零退出 + ANCHOR_NOT_UNIQUE）
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import('file:///" + path.join(SCRIPTS, 'lib.mjs').replace(/\\/g, '/') + "').then(m => m.patchFrontmatterField('---\\nversion: a\\nversion: b\\n---\\n', 'version', 'x'))"],
    { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes('ANCHOR_NOT_UNIQUE'));
});

test('lib: extractBlock 缩进敏感提取', () => {
  const sample = ['change-requests:', '  - id: CR-2099-000', '    merge-commits:', '      - repo: docs', '    owners:', '      requirement:', '        id: Ray'].join('\n');
  const blk = lib.extractBlock(sample, /^- id: CR-2099-000$/);
  assert.ok(blk.text.includes('merge-commits:'));
  const mc = lib.extractBlock(blk.text, /^merge-commits:$/);
  assert.ok(mc.text.includes('- repo: docs'));
  assert.ok(!mc.text.includes('owners:'));
});

test('lib: 账本路径隔离（AC-4 静态判据）', () => {
  assert.ok(lib.isLedgerPath('change-requests/_backlog.yml'));
  assert.ok(lib.isLedgerPath('change-requests/CR-2026-020/cr.md'));
  assert.ok(lib.isLedgerPath('change-requests/CR-2026-020/tasks/_index.yml'));
  assert.ok(!lib.isLedgerPath('specs/ai-first-platform/PRD.md'));
  assert.ok(!lib.isLedgerPath('delivery/task/_index.yaml'));
});

/* ─────────── writeback-prd-sdd.mjs ─────────── */

function makePrdWs() {
  const ws = tmpWs();
  const crDir = path.join(ws, 'change-requests', 'CR-2099-001');
  fs.mkdirSync(path.join(ws, 'specs', 'test-spec'), { recursive: true });
  fs.mkdirSync(crDir, { recursive: true });
  fs.writeFileSync(path.join(crDir, 'cr.md'), '---\nid: CR-2099-001\nstatus: merging\n---\n');
  const doc = '---\nid: CR-2099-001-prd\ntype: PRD\ncr-ref: CR-2099-001\ntitle: 测试需求\ntarget-version: "0.1"\nstatus: draft\ncreated: "2026-08-04T00:00:00+08:00"\nupdated: "2026-08-04T00:00:00+08:00"\n---\n\n# PRD — 测试需求\n\n## 1. 概述\n\n内容正文 A\n';
  fs.writeFileSync(path.join(crDir, 'prd.md'), doc);
  fs.writeFileSync(path.join(crDir, 'sdd.md'), doc.replace('type: PRD', 'type: SDD').replace('# PRD — 测试需求', '# SDD — 测试需求'));
  fs.writeFileSync(path.join(ws, 'specs', '_index.yml'), 'schema: specs-index/v1\nupdated: "2026-08-04T00:00:00+08:00"\n\nfeatures:\n  - id: test-spec\n    name: 测试\n    scope: product\n    status: ga\n    since: "0.1"\n    current: "0.1"\n    brief: "旧"\n    cr-ref: CR-2000-001\n    cr-history: [CR-2000-001]\n    updated: "2026-08-04T00:00:00+08:00"\n');
  return ws;
}

test('prd-sdd: 首次回写 + frontmatter 补全 + v 前缀入参归一（CODE-BLOCK-002）', () => {
  const ws = makePrdWs();
  // 故意传 v 前缀（pipeline 输入占位符形态 "v0.16.0"），断言输出全部归一为裸值惯例
  const r = run(PRD_SDD, ws, ['--cr', 'CR-2099-001', '--spec', 'test-spec', '--version', 'v0.2']);
  assert.equal(r.code, 0, r.stderr);
  const prd = fs.readFileSync(path.join(ws, 'specs', 'test-spec', 'PRD.md'), 'utf8');
  assert.ok(prd.includes('spec-id: test-spec'));
  assert.ok(prd.includes('status: ga'));
  assert.ok(prd.includes('version: v0.2'));       // frontmatter 用 v 前缀（PRD.md 惯例 version: v0.10.0）
  assert.ok(!prd.includes('vv0.2'), 'v 前缀重复叠加');
  assert.ok(prd.includes('（v0.2 · CR-2099-001）'));
  const idx = fs.readFileSync(path.join(ws, 'specs', '_index.yml'), 'utf8');
  assert.ok(idx.includes('cr-history: [CR-2000-001, CR-2099-001]') || idx.includes('cr-history: [CR-2099-001, CR-2000-001]'));
  assert.ok(idx.includes('current: "0.2"'), '_index current 应为裸值（惯例 "0.20.1"）');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('prd-sdd: 增量追加（既有内容保留 + H 级 +1）+ 重跑 noop + dry-run 不落盘', () => {
  const ws = makePrdWs();
  run(PRD_SDD, ws, ['--cr', 'CR-2099-001', '--spec', 'test-spec', '--version', '0.2']);
  const base = fs.readFileSync(path.join(ws, 'specs', 'test-spec', 'PRD.md'), 'utf8');
  const r2 = run(PRD_SDD, ws, ['--cr', 'CR-2099-001', '--spec', 'test-spec', '--version', '0.3', '--milestone-name', '第二期']);
  assert.equal(r2.code, 0, r2.stderr);
  const inc = fs.readFileSync(path.join(ws, 'specs', 'test-spec', 'PRD.md'), 'utf8');
  assert.ok(inc.includes('## 第二期（v0.3 · CR-2099-001）'));
  assert.ok(inc.includes('### 1. 概述')); // 原文 ## 1. 概述 → ### 1. 概述（H+1）
  assert.ok(inc.startsWith(base.split('\n## ')[0]), '既有头部被改写'); // frontmatter 与文档首部保留
  const r3 = run(PRD_SDD, ws, ['--cr', 'CR-2099-001', '--spec', 'test-spec', '--version', '0.3', '--milestone-name', '第二期']);
  assert.ok(r3.stdout.includes('"noop": true'));
  const ws2 = makePrdWs();
  const rd = run(PRD_SDD, ws2, ['--cr', 'CR-2099-001', '--spec', 'test-spec', '--version', '0.2', '--dry-run']);
  assert.equal(rd.code, 0, rd.stderr);
  assert.ok(!fs.existsSync(path.join(ws2, 'specs', 'test-spec', 'PRD.md')));
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(ws2, { recursive: true, force: true });
});

/* ─────────── writeback-tasks.mjs ─────────── */

function makeTasksWs() {
  const ws = tmpWs();
  const crDir = path.join(ws, 'change-requests', 'CR-2099-002');
  fs.mkdirSync(path.join(crDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'delivery', 'task'), { recursive: true });
  fs.writeFileSync(path.join(crDir, 'cr.md'), '---\nid: CR-2099-002\nstatus: writing-back\n---\n');
  fs.writeFileSync(path.join(crDir, 'tasks', '_index.yml'), 'tasks:\n  - id: CR-2099-002-TASK-01\n    title: 有 slug\n    status: done\n    estimate: 4h\n  - id: CR-2099-002-TASK-02\n    title: 无 slug\n    status: done\n    estimate: 2h\n');
  // 真实形态（CODE-BLOCK-001 教训）：任务文件 frontmatter 是 status: pending（done 只记在
  // tasks/_index.yml 账本），交付文件 frontmatter 无 target-version 字段——索引不得从文件投影
  const mk = (nn, extra) => '---\nid: CR-2099-002-TASK-' + nn + '\ntype: TASK\ncr-ref: CR-2099-002\ntitle: t' + nn + extra + '\nstatus: pending\nestimate: 1h\n---\n# TASK-' + nn + '\n';
  fs.writeFileSync(path.join(crDir, 'tasks', 'TASK-01.md'), mk('01', '\nslug: with-slug'));
  fs.writeFileSync(path.join(crDir, 'tasks', 'TASK-02.md'), mk('02', ''));
  fs.writeFileSync(path.join(ws, 'delivery', 'task', 'TASK-0.1-CR-2000-001-01-old.md'), '---\nspec-id: test-spec\nversion: "0.1"\nid: CR-2000-001-TASK-01\ntype: TASK\ncr-ref: CR-2000-001\ntitle: old\nstatus: pending\nestimate: 3h\n---\n');
  fs.writeFileSync(path.join(ws, 'delivery', 'task', '_index.yaml'), 'tasks:\n  - id: CR-2000-001-TASK-01\n    file: TASK-0.1-CR-2000-001-01-old.md\n    title: old\n    status: done\n    cr-ref: CR-2000-001\n    target-version: "0.1"\n    estimate: 3h\n');
  return ws;
}

test('tasks: slug 命名 + 注入 + SDD-BLOCK-001 幂等 + 索引顺序 + noop', () => {
  const ws = makeTasksWs();
  const r = run(TASKS, ws, ['--cr', 'CR-2099-002', '--spec', 'test-spec', '--version', '0.2']);
  assert.equal(r.code, 0, r.stderr);
  const files = fs.readdirSync(path.join(ws, 'delivery', 'task'));
  assert.ok(files.includes('TASK-0.2-CR-2099-002-01-with-slug.md'));
  assert.ok(files.includes('TASK-0.2-CR-2099-002-02-task-02.md'));
  const doc = fs.readFileSync(path.join(ws, 'delivery', 'task', 'TASK-0.2-CR-2099-002-01-with-slug.md'), 'utf8');
  assert.ok(doc.includes('spec-id: test-spec'));
  assert.ok(doc.includes('version: "0.2"'));
  // SDD-BLOCK-001：源 slug 后补再跑 → 不产生第二份文件
  const p = path.join(ws, 'change-requests', 'CR-2099-002', 'tasks', 'TASK-01.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('slug: with-slug', 'slug: changed'));
  const r2 = run(TASKS, ws, ['--cr', 'CR-2099-002', '--spec', 'test-spec', '--version', '0.2']);
  assert.ok(r2.stdout.includes('"noop": true'));
  assert.equal(fs.readdirSync(path.join(ws, 'delivery', 'task')).filter((f) => f.includes('CR-2099-002')).length, 2);
  // 索引顺序：既有序 + 新增排后
  const idx = fs.readFileSync(path.join(ws, 'delivery', 'task', '_index.yaml'), 'utf8');
  assert.ok(idx.indexOf('CR-2000-001-TASK-01') < idx.indexOf('CR-2099-002-TASK-01'));
  // CODE-BLOCK-001：既有条目逐字保留（status: done 与 target-version 不被文件 frontmatter 的
  // pending/缺字段污染）；新增条目 status 固定 done、target-version 取入参
  assert.ok(idx.includes('  - id: CR-2000-001-TASK-01\n    file: TASK-0.1-CR-2000-001-01-old.md\n    title: old\n    status: done\n    cr-ref: CR-2000-001\n    target-version: "0.1"\n    estimate: 3h'), '既有条目被改写');
  assert.ok(!idx.includes('status: pending'), '索引出现 pending（文件 frontmatter 投影污染）');
  const newSeg = idx.slice(idx.indexOf('CR-2099-002-TASK-01'));
  assert.ok(newSeg.includes('status: done') && newSeg.includes('target-version: "0.2"'));
  fs.rmSync(ws, { recursive: true, force: true });
});

/* ─────────── writeback-traceability.mjs ─────────── */

function makeTraceWs(withMc) {
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, 'change-requests', 'CR-2099-003'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'specs', 'test-spec'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'change-requests', 'CR-2099-003', 'cr.md'), '---\nid: CR-2099-003\nstatus: writing-back\n---\n');
  const mc = withMc ? '    merge-commits:\n      - repo: docs\n        trunk: master\n        sha: aaa111\n        branch: requirement/CR-2099-003\n        source-sha: bbb222\n        merged-at: "2026-08-04T22:00:00+08:00"\n' : '';
  fs.writeFileSync(path.join(ws, 'change-requests', '_backlog.yml'), 'schema: cr-backlog/v2\nchange-requests:\n  - id: CR-2099-003\n    title: x\n' + mc);
  fs.writeFileSync(path.join(ws, 'specs', 'test-spec', 'traceability.yml'), '# 手工注释须保留\nspec-id: test-spec\ncr-ref: CR-2000-001\ncr-history: [CR-2000-001]\ntarget-version: "0.1"\nbaseline-since: "0.1"\ngenerated-at: "2026-08-04T00:00:00+08:00"\n\nmilestones:\n  - cr: CR-2000-001\n    milestone: M0\n    target-version: "0.1"\n    status: archived\n    merge-commits:\n      - repo: docs\n        trunk: master\n        sha: oldsha\n        branch: requirement/CR-2000-001\n    frs:\n      - fr: FR-1\n        title: 旧\n');
  const msFile = path.join(ws, 'milestone.yml');
  fs.writeFileSync(msFile, 'cr: CR-2099-003\nmilestone: T2\ntarget-version: "0.2"\nstatus: writing-back\nfr-chain:\n  - fr: FR-1\n    title: 新\n    sdd: "SDD §3"\n    tasks: [CR-2099-003-TASK-01]\n    code: "tools@aaa111"\n    evidence: "AC-1"\n');
  return { ws, msFile };
}

test('traceability: 追加保留 + 幂等 + 校验硬失败 + MERGE_COMMITS_MISSING', () => {
  const { ws, msFile } = makeTraceWs(true);
  const old = fs.readFileSync(path.join(ws, 'specs', 'test-spec', 'traceability.yml'), 'utf8');
  const oldSeg = old.slice(old.indexOf('milestones:'));
  // v 前缀入参（CODE-BLOCK-002）：头部 target-version 应归一为裸值
  const r = run(TRACE, ws, ['--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', 'v0.2', '--milestone-file', msFile]);
  assert.equal(r.code, 0, r.stderr);
  const after = fs.readFileSync(path.join(ws, 'specs', 'test-spec', 'traceability.yml'), 'utf8');
  assert.ok(after.includes(oldSeg), '既有段被改写');
  assert.ok(after.includes('- cr: CR-2099-003'));
  assert.ok(after.includes('sha: aaa111'));
  assert.ok(/^target-version: "0\.2"$/m.test(after), '头部 target-version 应为裸值 "0.2"');
  assert.ok(!after.includes('"v0.2"'), 'v 前缀泄漏进 traceability');
  // 重跑 noop
  const r2 = run(TRACE, ws, ['--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', '0.2', '--milestone-file', msFile]);
  assert.ok(r2.stdout.includes('"noop": true'));
  fs.rmSync(ws, { recursive: true, force: true });
  // milestone-file 缺 fr → 硬失败
  const { ws: ws2, msFile: ms2 } = makeTraceWs(true);
  fs.writeFileSync(ms2, 'cr: CR-2099-003\nmilestone: T2\ntarget-version: "0.2"\n');
  const r3 = run(TRACE, ws2, ['--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', '0.2', '--milestone-file', ms2]);
  assert.notEqual(r3.code, 0);
  assert.ok(r3.stderr.includes('STRUCTURE_MISMATCH'));
  fs.rmSync(ws2, { recursive: true, force: true });
  // _backlog 无 merge-commits → MERGE_COMMITS_MISSING
  const { ws: ws3, msFile: ms3 } = makeTraceWs(false);
  const r4 = run(TRACE, ws3, ['--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', '0.2', '--milestone-file', ms3]);
  assert.notEqual(r4.code, 0);
  assert.ok(r4.stderr.includes('MERGE_COMMITS_MISSING'));
  fs.rmSync(ws3, { recursive: true, force: true });
  // 三字段最小形态（crctl merge-metadata 实际输出，回写自举发现）：branch 可选、段内省略
  const { ws: ws4, msFile: ms4 } = makeTraceWs(true);
  const bp = path.join(ws4, 'change-requests', '_backlog.yml');
  const btxt = fs.readFileSync(bp, 'utf8').replace(/\n        branch: requirement\/CR-2099-003\n        source-sha: bbb222\n        merged-at: "2026-08-04T22:00:00\+08:00"/, '');
  fs.writeFileSync(bp, btxt);
  const r5 = run(TRACE, ws4, ['--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', '0.2', '--milestone-file', ms4]);
  assert.equal(r5.code, 0, 'MIN3 RUN FAIL: ' + r5.stderr);
  const after5 = fs.readFileSync(path.join(ws4, 'specs', 'test-spec', 'traceability.yml'), 'utf8');
  assert.ok(after5.includes('- cr: CR-2099-003'), 'MIN3 SEG MISS');
  assert.ok(after5.includes('sha: aaa111'), 'MIN3 SHA MISS');
  assert.ok(!after5.includes('branch: requirement/CR-2099-003'), 'MIN3 BRANCH SHOULD BE OMITTED');
  fs.rmSync(ws4, { recursive: true, force: true });
});

/* ─────────── AC-4：三脚本源码无账本写路径 ─────────── */

test('AC-4: 三脚本源码不包含账本文件写路径（静态扫描）', () => {
  const ledger = ['_backlog.yml', '_history.yml', '/cr.md', 'tasks/_index.yml'];
  for (const name of ['writeback-prd-sdd.mjs', 'writeback-tasks.mjs', 'writeback-traceability.mjs']) {
    const src = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
    // 写路径特征：fs.writeFileSync / planWrite 指向账本路径
    for (const l of src.split('\n')) {
      if (/writeFileSync|planWrite/.test(l) && ledger.some((k) => l.includes(k))) {
        assert.fail(`${name} 含账本写路径：${l.trim()}`);
      }
    }
  }
});

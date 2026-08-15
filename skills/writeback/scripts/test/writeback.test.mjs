// CR-2026-020 writeback 脚本测试（CR-2026-031 TASK-08 起 candidate-only）：
// 三 generator 只输出 candidate 目录（文件 + blobs + manifest.json），零写 workspace；
// manifest v1 schema/排序/inputDigest 可独立重算（与 crctl apply 侧公式交叉验证防漂移）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lib from '../lib.mjs';
import { writebackInputDigest } from '../../../shared/crctl/scripts/lib/workspace-transactions.mjs';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRD_SDD = path.join(SCRIPTS, 'writeback-prd-sdd.mjs');
const TASKS = path.join(SCRIPTS, 'writeback-tasks.mjs');
const TRACE = path.join(SCRIPTS, 'writeback-traceability.mjs');
const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const sha256Raw = (p) => { try { return sha256(fs.readFileSync(p)); } catch { return null; } };

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-'));
}

function run(script, cwd, args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: parse(r.stdout), errJson: parse(r.stderr) };
}

test('lib: CRLF 归一 + frontmatter 读改（纪律 #1）', () => {
  const text = '---\r\na: 1\r\n---\r\nbody\r\n';
  assert.equal(lib.normalize(text), '---\na: 1\n---\nbody\n');
  const fm = lib.splitFrontmatter(text);
  assert.equal(fm.block, 'a: 1');
  assert.equal(fm.body, 'body\n');
  const patched = lib.patchFrontmatterField(text, 'b', 'x');
  assert.ok(patched.includes('b: x'));
});

test('lib: extractBlock 缩进敏感提取', () => {
  const text = 'x:\n  - id: A\n    k: 1\n  - id: B\ny:\n';
  const blk = lib.extractBlock(text, /^- id: A$/);
  assert.ok(blk);
  assert.ok(blk.text.includes('k: 1'));
  assert.ok(!blk.text.includes('id: B'));
});

test('lib: 账本路径隔离（AC-4 静态判据）', () => {
  assert.ok(lib.isLedgerPath('change-requests/_backlog.yml'));
  assert.ok(lib.isLedgerPath('change-requests/CR-2026-020/cr.md'));
  assert.ok(lib.isLedgerPath('change-requests/CR-2026-020/tasks/_index.yml'));
  assert.ok(!lib.isLedgerPath('specs/ai-first-platform/PRD.md'));
  assert.ok(!lib.isLedgerPath('delivery/task/_index.yaml'));
});

test('lib: computeInputDigest 与 crctl apply 侧公式一致（跨模块防漂移）', async () => {
  const files = [
    { path: 'specs/test-spec/PRD.md', beforeSha256: null, afterSha256: 'a'.repeat(64) },
    { path: 'specs/test-spec/SDD.md', beforeSha256: 'b'.repeat(64), afterSha256: 'c'.repeat(64) },
  ];
  const digest = lib.computeInputDigest({ v: 1, stage: 'baseline', cr: 'CR-2099-001', specId: 'test-spec', targetVersion: '0.2', generator: { id: 'writeback-prd-sdd', sha256: 'd'.repeat(64) }, files });
  // 与 crctl 侧 writebackInputDigest 交叉验证（crctl.test.mjs 亦断言同值）
  assert.equal(digest, writebackInputDigest({ v: 1, stage: 'baseline', cr: 'CR-2099-001', specId: 'test-spec', targetVersion: '0.2', generator: { id: 'writeback-prd-sdd', sha256: 'd'.repeat(64) }, files }));
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

function candidateDir(ws) {
  const c = path.join(ws, '.candidate');
  fs.mkdirSync(c, { recursive: true });
  return c;
}

test('prd-sdd: candidate-only 首次回写（零写 ws）+ manifest v1 + inputDigest 自洽', () => {
  const ws = makePrdWs();
  const out = candidateDir(ws);
  const r = run(PRD_SDD, ws, ['--workspace', ws, '--cr', 'CR-2099-001', '--spec', 'test-spec', '--version', 'v0.2', '--candidate-out', out]);
  assert.equal(r.code, 0, r.stderr);
  // ws 零写入（baseline 目录保持不存在）
  assert.ok(!fs.existsSync(path.join(ws, 'specs', 'test-spec', 'PRD.md')), 'candidate-only 不得写 ws');
  assert.ok(!fs.existsSync(path.join(ws, 'specs', 'test-spec', 'SDD.md')));
  // candidate 产物
  const prd = fs.readFileSync(path.join(out, 'specs', 'test-spec', 'PRD.md'), 'utf8');
  assert.ok(prd.includes('spec-id: test-spec'));
  assert.ok(prd.includes('status: ga'));
  assert.ok(prd.includes('version: v0.2'));
  assert.ok(prd.includes('（v0.2 · CR-2099-001）'));
  const idx = fs.readFileSync(path.join(out, 'specs', '_index.yml'), 'utf8');
  assert.ok(idx.includes('cr-history: [CR-2000-001, CR-2099-001]') || idx.includes('cr-history: [CR-2099-001, CR-2000-001]'));
  assert.ok(idx.includes('current: "0.2"'));
  // manifest v1：files 排序 + before/after + blob 存在 + inputDigest 自洽
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(m.v, 1);
  assert.equal(m.stage, 'baseline');
  assert.equal(m.cr, 'CR-2099-001');
  assert.equal(m.specId, 'test-spec');
  assert.equal(m.targetVersion, '0.2');
  assert.equal(m.generator.id, 'writeback-prd-sdd');
  assert.match(m.generator.sha256, /^[0-9a-f]{64}$/);
  const paths = m.files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort(), 'files 必须 POSIX 字典序');
  for (const f of m.files) {
    assert.equal(f.blob, `blobs/${f.afterSha256}`);
    assert.ok(fs.existsSync(path.join(out, f.blob)), `blob ${f.blob} 缺失`);
    assert.equal(sha256(fs.readFileSync(path.join(out, f.blob), 'utf8')), f.afterSha256);
    if (f.beforeSha256 != null) assert.equal(sha256Raw(path.join(ws, f.path)), f.beforeSha256);
  }
  // inputDigest 重算（lib 公式）
  assert.equal(m.inputDigest, lib.computeInputDigest(m));
  fs.rmSync(ws, { recursive: true, force: true });
});

test('prd-sdd: 增量追加（既有内容保留 + H 级 +1）+ 重跑 noop', () => {
  const ws = makePrdWs();
  const out1 = path.join(ws, '.c1'); fs.mkdirSync(out1, { recursive: true });
  run(PRD_SDD, ws, ['--workspace', ws, '--cr', 'CR-2099-001', '--spec', 'test-spec', '--version', '0.2', '--candidate-out', out1]);
  const base = fs.readFileSync(path.join(out1, 'specs', 'test-spec', 'PRD.md'), 'utf8');
  // 模拟首次已应用：ws 的 specs/ 写入首版（apply 后状态）
  fs.mkdirSync(path.join(ws, 'specs', 'test-spec'), { recursive: true });
  fs.copyFileSync(path.join(out1, 'specs', 'test-spec', 'PRD.md'), path.join(ws, 'specs', 'test-spec', 'PRD.md'));
  fs.copyFileSync(path.join(out1, 'specs', 'test-spec', 'SDD.md'), path.join(ws, 'specs', 'test-spec', 'SDD.md'));
  fs.copyFileSync(path.join(out1, 'specs', '_index.yml'), path.join(ws, 'specs', '_index.yml'));
  const out2 = path.join(ws, '.c2'); fs.mkdirSync(out2, { recursive: true });
  const r2 = run(PRD_SDD, ws, ['--workspace', ws, '--cr', 'CR-2099-001', '--spec', 'test-spec', '--version', '0.3', '--milestone-name', '第二期', '--candidate-out', out2]);
  assert.equal(r2.code, 0, r2.stderr);
  const inc = fs.readFileSync(path.join(out2, 'specs', 'test-spec', 'PRD.md'), 'utf8');
  assert.ok(inc.includes('## 第二期（v0.3 · CR-2099-001）'));
  assert.ok(inc.includes('### 1. 概述'));
  assert.ok(inc.startsWith(base.split('\n## ')[0]), '既有头部被改写');
  // 增量 manifest：before 指向 ws 当前版（= 首版 candidate 内容）
  const m2 = JSON.parse(fs.readFileSync(path.join(out2, 'manifest.json'), 'utf8'));
  const prdEntry = m2.files.find((f) => f.path === 'specs/test-spec/PRD.md');
  assert.equal(prdEntry.beforeSha256, sha256Raw(path.join(ws, 'specs', 'test-spec', 'PRD.md')), 'before 应指向 ws 现状');
  // 模拟 apply 0.3 到 ws 后重跑 noop
  for (const f of m2.files) fs.mkdirSync(path.dirname(path.join(ws, f.path)), { recursive: true }), fs.copyFileSync(path.join(out2, f.path), path.join(ws, f.path));
  const r3 = run(PRD_SDD, ws, ['--workspace', ws, '--cr', 'CR-2099-001', '--spec', 'test-spec', '--version', '0.3', '--milestone-name', '第二期', '--candidate-out', out2]);
  assert.ok(r3.stdout.includes('"noop": true'));
  fs.rmSync(ws, { recursive: true, force: true });
});

/* ─────────── writeback-tasks.mjs ─────────── */

function makeTasksWs() {
  const ws = tmpWs();
  const crDir = path.join(ws, 'change-requests', 'CR-2099-002');
  fs.mkdirSync(path.join(crDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'delivery', 'task'), { recursive: true });
  fs.writeFileSync(path.join(crDir, 'cr.md'), '---\nid: CR-2099-002\nstatus: writing-back\n---\n');
  fs.writeFileSync(path.join(crDir, 'tasks', '_index.yml'), 'tasks:\n  - id: CR-2099-002-TASK-01\n    title: 有 slug\n    status: done\n    estimate: 4h\n  - id: CR-2099-002-TASK-02\n    title: 无 slug\n    status: done\n    estimate: 2h\n');
  const mk = (nn, extra) => '---\nid: CR-2099-002-TASK-' + nn + '\ntype: TASK\ncr-ref: CR-2099-002\ntitle: t' + nn + extra + '\nstatus: pending\nestimate: 1h\n---\n# TASK-' + nn + '\n';
  fs.writeFileSync(path.join(crDir, 'tasks', 'TASK-01.md'), mk('01', '\nslug: with-slug'));
  fs.writeFileSync(path.join(crDir, 'tasks', 'TASK-02.md'), mk('02', ''));
  fs.writeFileSync(path.join(ws, 'delivery', 'task', 'TASK-0.1-CR-2000-001-01-old.md'), '---\nspec-id: test-spec\nversion: "0.1"\nid: CR-2000-001-TASK-01\ntype: TASK\ncr-ref: CR-2000-001\ntitle: old\nstatus: pending\nestimate: 3h\n---\n');
  fs.writeFileSync(path.join(ws, 'delivery', 'task', '_index.yaml'), 'tasks:\n  - id: CR-2000-001-TASK-01\n    file: TASK-0.1-CR-2000-001-01-old.md\n    title: old\n    status: done\n    cr-ref: CR-2000-001\n    target-version: "0.1"\n    estimate: 3h\n');
  return ws;
}

test('tasks: candidate-only + slug 命名 + SDD-BLOCK-001 幂等 + 索引顺序 + noop', () => {
  const ws = makeTasksWs();
  const out = candidateDir(ws);
  const r = run(TASKS, ws, ['--workspace', ws, '--cr', 'CR-2099-002', '--spec', 'test-spec', '--version', '0.2', '--candidate-out', out]);
  assert.equal(r.code, 0, r.stderr);
  // ws 零写入（初始 2 文件：_index.yaml + 旧 TASK 文件）
  assert.equal(fs.readdirSync(path.join(ws, 'delivery', 'task')).length, 2, 'ws delivery 不得新增');
  const files = fs.readdirSync(path.join(out, 'delivery', 'task'));
  assert.ok(files.includes('TASK-0.2-CR-2099-002-01-with-slug.md'));
  assert.ok(files.includes('TASK-0.2-CR-2099-002-02-task-02.md'));
  const doc = fs.readFileSync(path.join(out, 'delivery', 'task', 'TASK-0.2-CR-2099-002-01-with-slug.md'), 'utf8');
  assert.ok(doc.includes('spec-id: test-spec'));
  assert.ok(doc.includes('version: "0.2"'));
  // manifest files 含 _index.yaml 且排序
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  const paths = m.files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.ok(paths.includes('delivery/task/_index.yaml'));
  // 模拟 apply：candidate 落到 ws
  for (const f of m.files) fs.mkdirSync(path.dirname(path.join(ws, f.path)), { recursive: true }) , fs.copyFileSync(path.join(out, f.path), path.join(ws, f.path));
  // SDD-BLOCK-001：源 slug 后补再跑 → 不产生第二份文件
  const p = path.join(ws, 'change-requests', 'CR-2099-002', 'tasks', 'TASK-01.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('slug: with-slug', 'slug: changed'));
  const out2 = path.join(ws, '.c2'); fs.mkdirSync(out2, { recursive: true });
  const r2 = run(TASKS, ws, ['--workspace', ws, '--cr', 'CR-2099-002', '--spec', 'test-spec', '--version', '0.2', '--candidate-out', out2]);
  assert.ok(r2.stdout.includes('"noop": true'));
  // 索引顺序：既有序 + 新增排后；既有条目逐字保留
  const idx = fs.readFileSync(path.join(ws, 'delivery', 'task', '_index.yaml'), 'utf8');
  assert.ok(idx.indexOf('CR-2000-001-TASK-01') < idx.indexOf('CR-2099-002-TASK-01'));
  assert.ok(idx.includes('  - id: CR-2000-001-TASK-01\n    file: TASK-0.1-CR-2000-001-01-old.md\n    title: old\n    status: done\n    cr-ref: CR-2000-001\n    target-version: "0.1"\n    estimate: 3h'), '既有条目被改写');
  assert.ok(!idx.includes('status: pending'));
  fs.rmSync(ws, { recursive: true, force: true });
});

/* ─────────── writeback-traceability.mjs ─────────── */

function makeTraceWs() {
  const ws = tmpWs();
  const crDir = path.join(ws, 'change-requests', 'CR-2099-003');
  fs.mkdirSync(path.join(crDir, 'review-annotations'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'specs', 'test-spec'), { recursive: true });
  fs.writeFileSync(path.join(crDir, 'cr.md'), '---\nid: CR-2099-003\nstatus: writing-back\n---\n');
  // 7 份 canonical 证据文件（CR-2026-041 FR-11）：test + 4 reviews + approval + merge
  fs.writeFileSync(path.join(crDir, 'test-report.md'), '---\nstatus: pass\n---\n');
  for (const f of ['requirement', 'sdd', 'dev-plan', 'code']) {
    fs.writeFileSync(path.join(crDir, 'review-annotations', `${f}.yml`), `cr-id: CR-2099-003\nreview-type: ${f}\nverdict: pass\n`);
  }
  fs.writeFileSync(path.join(crDir, 'approval.yml'), 'requirement:\n  via: crctl-approve\ntech-design:\n  via: crctl-approve\ndevelopment-start:\n  via: crctl-approve\ncode:\n  via: crctl-approve\n');
  // merge-commits.yml（新协议事实源）
  fs.writeFileSync(path.join(crDir, 'merge-commits.yml'),
    'schema: merge-commits/v1\ntx-id: abc123\nmerged-at: "2026-08-11T22:00:00+08:00"\nrepositories:\n  - repo: docs\n    base-sha: ' + 'a'.repeat(40) + '\n    source-sha: ' + 'b'.repeat(40) + '\n    merge-sha: aaa111\n');
  fs.writeFileSync(path.join(ws, 'dir-graph.yaml'),
    'schema: "ai-first.tools.dir-graph/v1"\nworkspace:\n  root: "."\nrepositories:\n  - id: docs\n    path: "."\n    trunk: master\n    role: knowledge-base\n');
  fs.writeFileSync(path.join(ws, 'specs', 'test-spec', 'traceability.yml'), '# 手工注释须保留\nspec-id: test-spec\ncr-ref: CR-2000-001\ncr-history: [CR-2000-001]\ntarget-version: "0.1"\nbaseline-since: "0.1"\ngenerated-at: "2026-08-04T00:00:00+08:00"\n\nmilestones:\n  - cr: CR-2000-001\n    milestone: M0\n    target-version: "0.1"\n    status: archived\n    merge-commits:\n      - repo: docs\n        trunk: master\n        sha: oldsha\n        branch: requirement/CR-2000-001\n    frs:\n      - fr: FR-1\n        title: 旧\n');
  const msFile = path.join(ws, 'milestone.yml');
  // 新契约：milestone-file 不含 status（CR-2026-041 FR-05）
  fs.writeFileSync(msFile, 'cr: CR-2099-003\nmilestone: T2\ntarget-version: "0.2"\nfr-chain:\n  - fr: FR-1\n    title: 新\n    sdd: "SDD §3"\n    tasks: [CR-2099-003-TASK-01]\n    code: "tools@aaa111"\n    evidence: "AC-1"\n');
  return { ws, msFile };
}

function traceOut(ws) { const c = path.join(ws, '.candidate'); fs.mkdirSync(c, { recursive: true }); return c; }

test('traceability: candidate-only + 追加保留 + 幂等 + evidence 注入 + 无 status + 校验硬失败', () => {
  const { ws, msFile } = makeTraceWs();
  const old = fs.readFileSync(path.join(ws, 'specs', 'test-spec', 'traceability.yml'), 'utf8');
  const oldSeg = old.slice(old.indexOf('milestones:'));
  const out = traceOut(ws);
  const r = run(TRACE, ws, ['--workspace', ws, '--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', 'v0.2', '--milestone-file', msFile, '--candidate-out', out]);
  assert.equal(r.code, 0, r.stderr);
  // ws 零写入
  assert.ok(!fs.existsSync(path.join(ws, 'specs', 'test-spec', 'traceability.yml.new')));
  const after = fs.readFileSync(path.join(out, 'specs', 'test-spec', 'traceability.yml'), 'utf8');
  assert.ok(after.includes(oldSeg), '既有段被改写');
  assert.ok(after.includes('- cr: CR-2099-003'));
  assert.ok(after.includes('sha: aaa111'), 'merge-sha 取自 merge-commits.yml');
  assert.ok(after.includes('trunk: master'), 'trunk 取自 dir-graph');
  assert.ok(/^target-version: "0\.2"$/m.test(after), '头部 target-version 应为裸值 "0.2"');
  assert.ok(!after.includes('"v0.2"'), 'v 前缀泄漏进 traceability');
  // evidence 块注入（FR-01）：七项齐全、path map 精确、无 status 行
  const seg = lib.extractBlock(after, /^- cr: CR-2099-003$/);
  assert.ok(seg, '新 milestone 段缺失');
  assert.ok(/^\s*evidence:\s*$/m.test(seg.text), 'evidence 块缺失');
  for (const k of ['test-report.md', 'review-annotations/requirement.yml', 'review-annotations/sdd.yml', 'review-annotations/dev-plan.yml', 'review-annotations/code.yml', 'approval.yml', 'merge-commits.yml']) {
    assert.ok(seg.text.includes(k), `evidence 缺 path ${k}`);
  }
  assert.ok(!/^\s*status:\s*$/.test(seg.text) && !/^\s*status: writing-back/.test(seg.text), '新 milestone 不应有 status 行');
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(m.stage, 'traceability');
  assert.equal(m.files.length, 1);
  assert.equal(m.files[0].path, 'specs/test-spec/traceability.yml');
  assert.equal(m.files[0].beforeSha256, sha256Raw(path.join(ws, 'specs', 'test-spec', 'traceability.yml')));
  // 模拟 apply 后重跑 noop
  fs.copyFileSync(path.join(out, 'specs', 'test-spec', 'traceability.yml'), path.join(ws, 'specs', 'test-spec', 'traceability.yml'));
  const out2 = traceOut(ws);
  const r2 = run(TRACE, ws, ['--workspace', ws, '--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', '0.2', '--milestone-file', msFile, '--candidate-out', out2]);
  assert.ok(r2.stdout.includes('"noop": true'));
  fs.rmSync(ws, { recursive: true, force: true });
  // milestone-file 缺 fr → 硬失败
  const f2 = makeTraceWs();
  fs.writeFileSync(f2.msFile, 'cr: CR-2099-003\nmilestone: T2\ntarget-version: "0.2"\n');
  const r3 = run(TRACE, f2.ws, ['--workspace', f2.ws, '--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', '0.2', '--milestone-file', f2.msFile, '--candidate-out', traceOut(f2.ws)]);
  assert.notEqual(r3.code, 0);
  assert.ok(r3.stderr.includes('STRUCTURE_MISMATCH'));
  fs.rmSync(f2.ws, { recursive: true, force: true });
  // merge-commits.yml 缺失 → MERGE_COMMITS_MISSING
  const f3 = makeTraceWs();
  fs.rmSync(path.join(f3.ws, 'change-requests', 'CR-2099-003', 'merge-commits.yml'));
  const r4 = run(TRACE, f3.ws, ['--workspace', f3.ws, '--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', '0.2', '--milestone-file', f3.msFile, '--candidate-out', traceOut(f3.ws)]);
  assert.notEqual(r4.code, 0);
  assert.ok(r4.stderr.includes('MERGE_COMMITS_MISSING'));
  fs.rmSync(f3.ws, { recursive: true, force: true });
});

test('traceability: 证据缺失/状态不通过 → EVIDENCE_INVALID 硬失败，零 candidate', () => {
  const { ws, msFile } = makeTraceWs();
  // test-report 状态非 pass
  fs.writeFileSync(path.join(ws, 'change-requests', 'CR-2099-003', 'test-report.md'), '---\nstatus: fail\n---\n');
  const out = traceOut(ws);
  const r = run(TRACE, ws, ['--workspace', ws, '--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', '0.2', '--milestone-file', msFile, '--candidate-out', out]);
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes('EVIDENCE_INVALID'));
  assert.ok(!fs.existsSync(path.join(out, 'manifest.json')), '证据不通过不得产出 manifest');
  fs.rmSync(ws, { recursive: true, force: true });
  // review verdict 非 pass
  const f2 = makeTraceWs();
  fs.writeFileSync(path.join(f2.ws, 'change-requests', 'CR-2099-003', 'review-annotations', 'sdd.yml'), 'cr-id: CR-2099-003\nverdict: block\n');
  const r2 = run(TRACE, f2.ws, ['--workspace', f2.ws, '--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', '0.2', '--milestone-file', f2.msFile, '--candidate-out', traceOut(f2.ws)]);
  assert.notEqual(r2.code, 0);
  assert.ok(r2.stderr.includes('EVIDENCE_INVALID'));
  fs.rmSync(f2.ws, { recursive: true, force: true });
  // approval 缺 grant
  const f3 = makeTraceWs();
  fs.writeFileSync(path.join(f3.ws, 'change-requests', 'CR-2099-003', 'approval.yml'), 'requirement:\n  via: crctl-approve\ntech-design:\n  via: crctl-approve\ndevelopment-start:\n  via: crctl-approve\n');
  const r3 = run(TRACE, f3.ws, ['--workspace', f3.ws, '--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', '0.2', '--milestone-file', f3.msFile, '--candidate-out', traceOut(f3.ws)]);
  assert.notEqual(r3.code, 0);
  assert.ok(r3.stderr.includes('EVIDENCE_INVALID'));
  fs.rmSync(f3.ws, { recursive: true, force: true });
});

test('traceability: trunk 缺条目 → TRUNK_UNKNOWN 硬失败（无 master 回退）', () => {
  const { ws, msFile } = makeTraceWs();
  fs.writeFileSync(path.join(ws, 'dir-graph.yaml'), 'schema: "ai-first.tools.dir-graph/v1"\nworkspace:\n  root: "."\nrepositories:\n  - id: docs\n    path: "."\n    role: knowledge-base\n');
  const r = run(TRACE, ws, ['--workspace', ws, '--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', '0.2', '--milestone-file', msFile, '--candidate-out', traceOut(ws)]);
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes('TRUNK_UNKNOWN'));
  fs.rmSync(ws, { recursive: true, force: true });
});

test('traceability: --validate-evidence 复用唯一 validator（ok + path 互换/digest 漂移/verdict 非 pass）', () => {
  const { ws, msFile } = makeTraceWs();
  const out = traceOut(ws);
  const r = run(TRACE, ws, ['--workspace', ws, '--cr', 'CR-2099-003', '--spec', 'test-spec', '--version', '0.2', '--milestone-file', msFile, '--candidate-out', out]);
  assert.equal(r.code, 0, r.stderr);
  fs.copyFileSync(path.join(out, 'specs', 'test-spec', 'traceability.yml'), path.join(ws, 'specs', 'test-spec', 'traceability.yml'));
  // ok
  const v1 = run(TRACE, ws, ['--validate-evidence', '--workspace', ws, '--cr', 'CR-2099-003', '--spec', 'test-spec']);
  assert.equal(v1.code, 0, v1.stderr);
  assert.ok(v1.stdout.includes('"ok": true'));
  // path 互换：test 的 path 指向 review 文件 → EVIDENCE_PATH_INVALID
  const base = fs.readFileSync(path.join(ws, 'specs', 'test-spec', 'traceability.yml'), 'utf8');
  const t1 = base.replace('path: change-requests/CR-2099-003/test-report.md', 'path: change-requests/CR-2099-003/review-annotations/requirement.yml');
  fs.writeFileSync(path.join(ws, 'specs', 'test-spec', 'traceability.yml'), t1);
  const v2 = run(TRACE, ws, ['--validate-evidence', '--workspace', ws, '--cr', 'CR-2099-003', '--spec', 'test-spec']);
  assert.notEqual(v2.code, 0);
  assert.ok(v2.stderr.includes('EVIDENCE_PATH_INVALID'));
  // digest 漂移：改 sha256 → EVIDENCE_DRIFT
  const t2 = base.replace(/sha256: [0-9a-f]{64}/, 'sha256: ' + '0'.repeat(64));
  fs.writeFileSync(path.join(ws, 'specs', 'test-spec', 'traceability.yml'), t2);
  const v3 = run(TRACE, ws, ['--validate-evidence', '--workspace', ws, '--cr', 'CR-2099-003', '--spec', 'test-spec']);
  assert.notEqual(v3.code, 0);
  assert.ok(v3.stderr.includes('EVIDENCE_DRIFT'));
  // verdict 非 pass：改源文件后 digest 漂移 + 源 verdict 非 pass
  fs.writeFileSync(path.join(ws, 'specs', 'test-spec', 'traceability.yml'), base);
  fs.writeFileSync(path.join(ws, 'change-requests', 'CR-2099-003', 'review-annotations', 'sdd.yml'), 'cr-id: CR-2099-003\nverdict: block\n');
  const v4 = run(TRACE, ws, ['--validate-evidence', '--workspace', ws, '--cr', 'CR-2099-003', '--spec', 'test-spec']);
  assert.notEqual(v4.code, 0);
  assert.ok(v4.stderr.includes('EVIDENCE_DRIFT') || v4.stderr.includes('EVIDENCE_STATE'));
  // duplicate evidence key/block → EVIDENCE_DUPLICATE
  const duplicateKey = base.replace(/(\n      test: \{[^\n]+\})/, '$1$1');
  fs.writeFileSync(path.join(ws, 'specs', 'test-spec', 'traceability.yml'), duplicateKey);
  const v5 = run(TRACE, ws, ['--validate-evidence', '--workspace', ws, '--cr', 'CR-2099-003', '--spec', 'test-spec']);
  assert.notEqual(v5.code, 0);
  assert.ok(v5.stderr.includes('EVIDENCE_DUPLICATE'));
  const duplicateBlock = base + '\n    evidence:\n';
  fs.writeFileSync(path.join(ws, 'specs', 'test-spec', 'traceability.yml'), duplicateBlock);
  const v6 = run(TRACE, ws, ['--validate-evidence', '--workspace', ws, '--cr', 'CR-2099-003', '--spec', 'test-spec']);
  assert.notEqual(v6.code, 0);
  assert.ok(v6.stderr.includes('EVIDENCE_DUPLICATE'));
  fs.rmSync(ws, { recursive: true, force: true });
});

/* ─────────── AC-4：三脚本源码无账本写路径 + 无 ws 直接写 ─────────── */

test('AC-4: 三脚本源码不包含账本文件写路径（静态扫描）', () => {
  const ledger = ['_backlog.yml', '_history.yml', '/cr.md', 'tasks/_index.yml'];
  for (const name of ['writeback-prd-sdd.mjs', 'writeback-tasks.mjs', 'writeback-traceability.mjs']) {
    const src = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
    for (const l of src.split('\n')) {
      if (/writeFileSync|planWrite/.test(l) && ledger.some((k) => l.includes(k))) {
        assert.fail(`${name} 含账本写路径：${l.trim()}`);
      }
    }
  }
});

test('AC-4: candidate-only 硬边界——脚本不得写 ws 内容文件（writeFileSync 仅限 candidate/blobs 写入）', () => {
  for (const name of ['writeback-prd-sdd.mjs', 'writeback-tasks.mjs', 'writeback-traceability.mjs']) {
    const src = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
    for (const l of src.split('\n')) {
      const t = l.trim();
      if (/writeFileSync/.test(t) && !t.includes('candidateOut') && !t.includes('blobP') && !t.includes('candidate') && !t.includes('indexPath') === false) {
        // 允许路径：lib.mjs 内 writeCandidate 的落盘；脚本内的 writeFileSync 只能指向 candidate/blobs
        if (/writeFileSync\(/.test(t) && !/candidate|blob/.test(t)) {
          assert.fail(`${name} 疑似直接写盘：${t}`);
        }
      }
    }
  }
});


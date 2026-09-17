// FR-2 summary / detail 合同测试（CR-2026-069 TASK-08，SDD §3.1 / §4.6 / SDD-CLOSE-02）。
// 运行：node --test --test-reporter=dot skills/shared/crctl/scripts/test/crctl-summary.test.mjs
//
// 三层等价性合同（禁止字节比对）：
//   ① 字段集合：fieldPaths(--detail 输出) ≡ 金样本 fieldPaths（双向全等）
//   ② 稳定值：金样本标 stable 的字段路径，其值逐字相等
//   ③ 易变字段形态：金样本标 volatile 的字段路径，其值类型与形态匹配
// 夹具构造方式消费式复用既有测试面（CR-2026-069 TASK-08 §3.1；不另造并行夹具体系）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HERE = import.meta.dirname;
const CRCTL = path.resolve(HERE, '..', 'crctl.mjs');
const TOOLS_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');
const GOLDEN_DIR = path.join(HERE, 'golden', 'crctl-detail');
const FIXED_TIME = '2026-08-04T12:00:00+08:00';
const sha16 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 16);

/** 与金样本采集时同构的最小夹具（含 git 仓库与三份账本/证据面）。 */
function makeFixture() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cr069-summary-'));
  fs.mkdirSync(path.join(ws, 'change-requests'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'dir-graph.yaml'), [
    'schema: "ai-first.tools.dir-graph/v1"',
    'workspace:',
    '  root: "."',
    '  timezone: "Asia/Shanghai"',
    '  edition: ai-first-platform-docs',
    '  path_basis: "workspace-root"',
    '  tools_package_path: ' + JSON.stringify(TOOLS_ROOT),
    'repositories:',
    '  - id: ai-first-platform-docs',
    '    path: "."',
    '    trunk: master',
    '    role: knowledge-base',
    '    description: "summary fixture"',
    'target_workspace_contract:',
    '  required_roots:',
    '    specs: "specs/"',
    '    change-requests: "change-requests/"',
    '    docs: "docs/"',
    '    delivery: "delivery/"',
    '',
  ].join('\n'), 'utf8');
  const owners = (pad) => [
    pad + 'owners:',
    pad + '  requirement:',
    pad + '    id: Ray',
    pad + '    assigned-at: ' + JSON.stringify(FIXED_TIME),
    pad + '  development:',
    pad + '    id: Ray',
    pad + '    assigned-at: ' + JSON.stringify(FIXED_TIME),
    pad + '  test:',
    pad + '    id: Ray',
    pad + '    assigned-at: ' + JSON.stringify(FIXED_TIME),
  ];
  fs.writeFileSync(path.join(ws, 'change-requests', '_backlog.yml'), [
    'schema: cr-backlog/v2',
    'change-requests:',
    '  - id: CR-2026-901',
    '    status: requirement-reviewing',
    ...owners('    '),
    '  - id: CR-2026-902',
    '    status: tech-design-review-pending',
    ...owners('    '),
    '',
  ].join('\n'), 'utf8');
  for (const [cr, status] of [['CR-2026-901', 'requirement-reviewing'], ['CR-2026-902', 'tech-design-review-pending']]) {
    const dir = path.join(ws, 'change-requests', cr);
    fs.mkdirSync(path.join(dir, 'review-annotations'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cr.md'), [
      '---',
      'id: ' + cr,
      'title: summary fixture ' + cr,
      'status: ' + status,
      'target-version: 0.42',
      'owners:',
      '  requirement: Ray',
      '  development: Ray',
      '  test: Ray',
      'updated: ' + FIXED_TIME,
      '---',
      '',
      '# ' + cr,
      '',
    ].join('\n'), 'utf8');
  }
  const evidence = 'verdict: pass\nblockers: []\n';
  fs.writeFileSync(path.join(ws, 'change-requests', 'CR-2026-901', 'review-annotations', 'requirement.yml'), evidence, 'utf8');
  fs.writeFileSync(path.join(ws, 'change-requests', 'CR-2026-901', 'approval.yml'), [
    'requirement:',
    '  approver: Ray',
    '  approved-at: ' + JSON.stringify(FIXED_TIME),
    '  via: crctl-approve',
    '  evidence-sha256-16: ' + sha16(evidence),
    '  target-status: requirement-approved',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(ws, 'change-requests', 'CR-2026-902', 'sdd.md'),
    '# golden sdd' + String.fromCharCode(10, 10) + 'fixture subject' + String.fromCharCode(10), 'utf8');
  fs.mkdirSync(path.join(ws, '.crctl', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.crctl', 'tmp', 'review-tech-design.yml'), [
    'verdict: pass',
    'blockers: []',
    'dimensions:',
    '  invariants: pass',
    '  interfaces: pass',
    '  data-model: pass',
    '',
  ].join('\n'), 'utf8');
  const g = (args) => {
    const r = spawnSync('git', ['-C', ws, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
  };
  g(['init', '-q', '-b', 'master']);
  g(['config', 'user.email', 'summary@fixture']);
  g(['config', 'user.name', 'summary']);
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'summary fixture']);
  return ws;
}

function runCli(args, ws) {
  const r = spawnSync(process.execPath, [CRCTL, ...args, '--workspace', ws], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function parseOut(r) {
  return JSON.parse(String(r.stdout).split('\r\n').join('\n'));
}

function fieldPaths(value, keyPath, acc) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) fieldPaths(item, keyPath ? keyPath + '[]' : '[]', acc);
    return;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) fieldPaths(value[k], keyPath ? keyPath + '.' + k : k, acc);
    return;
  }
  acc.push({ path: keyPath, type: typeof value, value });
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const HEX = /^[0-9a-f]{12,}$/;
const ABS = /(^[A-Za-z]:[\\/])|(^\/)/;
const EVENT = /^[0-9]{8}T[0-9]+Z-/;

/** 把金样本 argv 里的 <fixture> 前缀还原为当前夹具根。 */
const mapArgs = (g, ws) => g.argv.map((a) => (typeof a === 'string' && a.startsWith('<fixture>') ? ws + a.slice('<fixture>'.length) : a));

const goldens = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, f), 'utf8').split('\r\n').join('\n')));

test('summary-01 金样本存在且是改造前 CLI 采集的（含 fieldPaths / stable / volatile）', () => {
  assert.ok(goldens.length >= 1, '金样本目录为空（AC-10 不可判）');
  for (const g of goldens) {
    assert.equal(g.schema, 'crctl-detail-golden/v1');
    assert.equal(g.capturedFrom, 'unmodified crctl.mjs');
    assert.ok(Array.isArray(g.fieldPaths) && g.fieldPaths.length > 0, g.command + ' 缺 fieldPaths');
    assert.ok(Object.keys(g.stableValues).length >= 1, g.command + ' 无 stable 值');
  }
});

test('summary-02 注册表键集 = 金样本命令集（注册与金样本一一对应）', async () => {
  const mod = await import('../lib/summary-projectors.mjs');
  const keys = Object.keys(mod.SUMMARY_PROJECTORS).slice().sort();
  const commands = goldens.map((g) => g.command).slice().sort();
  assert.deepEqual(keys, commands);
});

test('summary-03 逐命令：--detail 输出与金样本三层等价（① 字段集合 ② 稳定值 ③ 易变形态）', () => {
  for (const g of goldens) {
    const ws = makeFixture();
    try {
      const args = mapArgs(g, ws);
      const r = runCli([...args, '--detail'], ws);
      assert.equal(r.status, 0, g.command + ' --detail 退出码非零: ' + r.stderr);
      const out = parseOut(r);
      const acc = [];
      fieldPaths(out, '', acc);
      const actualPaths = [...new Set(acc.map((x) => x.path))].sort();
      const goldenPaths = [...new Set(g.fieldPaths.map((x) => x.path))].sort();
      assert.deepEqual(actualPaths, goldenPaths, g.command + ' (1) 字段集合不等');
      const byPath = new Map();
      for (const x of acc) byPath.set(x.path, x);
      for (const [p, v] of Object.entries(g.stableValues)) {
        assert.ok(byPath.has(p), g.command + ' (2) 缺稳定字段 ' + p);
        assert.deepEqual(byPath.get(p).value, v, g.command + ' (2) 稳定值不等: ' + p);
      }
      for (const [p, t] of Object.entries(g.volatileTypes)) {
        const x = byPath.get(p);
        assert.ok(x, g.command + ' (3) 缺易变字段 ' + p);
        assert.equal(x.type, t, g.command + ' (3) 易变字段类型不等: ' + p);
        if (t === 'string') {
          assert.ok(ISO.test(x.value) || HEX.test(x.value) || ABS.test(x.value) || EVENT.test(x.value) || x.value.indexOf('/') >= 0 || x.value.includes(String.fromCharCode(92)),
            g.command + ' (3) 易变字符串形态不匹配: ' + p + ' = ' + String(x.value).slice(0, 60));
        }
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
});

test('summary-04 注册命令默认面 = compact summary（为 --detail 面的真子集且严格更少字段）', () => {
  for (const g of goldens) {
    const ws = makeFixture();
    try {
      const args = mapArgs(g, ws);
      const rr = runCli(args, ws);
      assert.equal(rr.status, 0, g.command + ' 默认面退出码非零: ' + rr.stderr);
      const summary = parseOut(rr);
      const ws2 = makeFixture();
      let full;
      try {
        full = parseOut(runCli([...mapArgs(g, ws2), '--detail'], ws2));
      } finally {
        fs.rmSync(ws2, { recursive: true, force: true });
      }
      const fullKeys = Object.keys(full);
      for (const k of Object.keys(summary)) assert.ok(fullKeys.includes(k), g.command + ' 投影引入了不存在的键 ' + k);
      assert.ok(Object.keys(summary).length < fullKeys.length, g.command + ' 投影面未减少字段');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
});

test('summary-05 未注册命令收到 --detail 与未收到 --detail 均与现状等价（D-9 代价项）', () => {
  const ws = makeFixture();
  try {
    for (const args of [['next', 'CR-2026-901'], ['next', 'CR-2026-901', '--detail']]) {
      const out = parseOut(runCli(args, ws));
      assert.deepEqual(Object.keys(out).sort(), ['cr', 'humanApproval', 'next', 'status', 'why']);
      assert.equal(typeof out.next, 'string');
      assert.ok(out.next.length > 0, 'next 必须给出非空下一步');
      assert.equal(out.status, 'requirement-reviewing');
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('summary-06 --detail 是布尔开关，不消费后随 token（位置参数不被吃掉）', () => {
  const ws = makeFixture();
  try {
    const out = parseOut(runCli(['status', '--detail', 'CR-2026-901'], ws));
    assert.equal(out.cr, 'CR-2026-901');
    assert.equal(out.status, 'requirement-reviewing');
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'source'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('summary-07 错误面零改动：退出码与错误码在 --detail 前后一致，且不进投影', () => {
  const ws = makeFixture();
  try {
    const a = runCli(['status', 'CR-9999-999'], ws);
    const b = runCli(['status', 'CR-9999-999', '--detail'], ws);
    assert.equal(a.status, 1);
    assert.equal(b.status, 1);
    const ea = JSON.parse(String(a.stderr).split('\r\n').join('\n'));
    const eb = JSON.parse(String(b.stderr).split('\r\n').join('\n'));
    assert.equal(ea.error.code, eb.error.code);
    assert.ok(ea.error.code, '错误体必须保留 error.code');
    assert.equal(String(a.stdout).trim(), '');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('summary-08 不新增平行开关（只允许 --detail）', () => {
  const src = fs.readFileSync(CRCTL, 'utf8').split('\r\n').join('\n');
  for (const flag of ['--verbose', '--pretty']) {
    assert.ok(!src.includes(flag), 'crctl.mjs 出现平行开关 ' + flag);
  }
  assert.ok(src.includes("a === '--detail'"), 'crctl.mjs 缺 --detail 布尔专用分支');
});

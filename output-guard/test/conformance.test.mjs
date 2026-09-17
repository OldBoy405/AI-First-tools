// conformance 向量面（CR-2026-069 TASK-02，SDD §2.2.3）。
// 运行：node --test --test-reporter=dot output-guard/test/conformance.test.mjs
//
// 自棘轮：declaredVectorCount 必须等于实际执行向量数；四个 kind 必须齐备。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parsePolicy } from '../core.mjs';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').split('\r\n').join('\n');

const CONF = JSON.parse(read('conformance.json'));
const POLICY_TEXT = read('policy.json');
const CAPS_TEXT = read('capabilities.json');
const KINDS = ['escape-hatch', 'decision', 'degradation', 'idempotence'];

function policyFor(vector) {
  if (!vector.policyPatch) return parsePolicy(POLICY_TEXT, CAPS_TEXT);
  const base = JSON.parse(POLICY_TEXT);
  const patch = vector.policyPatch;
  const merged = {
    ...base,
    ...patch,
    thresholds: { ...base.thresholds, ...(patch.thresholds || {}) },
    hints: { ...base.hints, ...(patch.hints || {}) },
    escapeHatch: { ...base.escapeHatch, ...(patch.escapeHatch || {}) },
  };
  return parsePolicy(JSON.stringify(merged), CAPS_TEXT);
}

async function runVector(core, vector) {
  const policy = policyFor(vector);
  const { op, args } = vector.input;
  if (op === 'parseEscapeHatch') return core.parseEscapeHatch(args.firstLine, policy);
  if (op === 'classifyFamily') return core.classifyFamily(args.cmdline, policy);
  if (op === 'parseCall') return core.parseCall(args, policy);
  if (op === 'evaluateResult') return core.evaluateResult(args, policy);
  if (op === 'fingerprint') return { fp: core.fingerprint(args), stable: core.fingerprint(args) === core.fingerprint(args) };
  if (op === 'idempotence') {
    const first = core.evaluateResult(args.result, policy);
    const second = core.evaluateResult(args.result, policy);
    const fp = (d) => core.fingerprint({
      policyVersion: args.policyVersion,
      ruleId: d.ruleId,
      runtime: args.runtime,
      toolName: args.toolName,
      normalizedInput: args.normalizedInput,
      body: args.result.body,
    });
    return { secondRunEqualsFirst: first.body === second.body && first.trailer === second.trailer && fp(first) === fp(second) };
  }
  throw new Error('未知 op: ' + String(op));
}

function assertSubset(expect, actual, id) {
  for (const [k, v] of Object.entries(expect)) {
    assert.deepEqual(actual[k], v, id + ' 期望 ' + k + '=' + JSON.stringify(v) + '，实际 ' + JSON.stringify(actual[k]));
  }
}

/**
 * probe：对裁剪后正文的机械断言（本轮回修新增的向量面，B-1/B-2/B-3）。
 * 只检查实际返回的 body 字符串，不新增 Core 导出面；Adapter 合同面复用同一断言。
 */
function assertProbe(actual, vector, label) {
  const probe = vector.probe;
  if (!probe) return;
  const body = typeof actual.body === 'string' ? actual.body : '';
  if (probe.bodyEquals !== undefined) assert.equal(body, probe.bodyEquals, label + ' probe.bodyEquals 不等');
  if (probe.bodyFirstLinePrefix !== undefined) {
    const first = body.split('\n')[0];
    assert.ok(first.startsWith(probe.bodyFirstLinePrefix), label + ' probe.bodyFirstLinePrefix：首行 ' + JSON.stringify(first));
  }
  for (const s of probe.bodyIncludes || []) assert.ok(body.includes(s), label + ' probe.bodyIncludes 缺 ' + s);
  for (const s of probe.bodyExcludes || []) assert.ok(!body.includes(s), label + ' probe.bodyExcludes 命中 ' + s);
}

test('conf-01 声明向量数 = 实际向量数（自棘轮）', () => {
  assert.equal(CONF.schema, 'output-guard/conformance/v1');
  assert.ok(Array.isArray(CONF.vectors));
  assert.equal(CONF.declaredVectorCount, CONF.vectors.length);
  assert.ok(CONF.vectors.length >= 4);
});

test('conf-02 四个 kind 齐备且 id 唯一', () => {
  const kinds = CONF.vectors.map((v) => v.kind);
  for (const k of KINDS) assert.ok(kinds.includes(k), '缺 kind ' + k);
  const ids = CONF.vectors.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('conf-03 每个向量至少声明 action / state / secondRunEqualsFirst 之一（期望非空）', () => {
  for (const v of CONF.vectors) {
    assert.ok(v.expect && Object.keys(v.expect).length > 0, v.id + ' 缺 expect');
    assert.ok(v.input && typeof v.input.op === 'string', v.id + ' 缺 input.op');
  }
});

test('conf-04 AC-6 四条负向边界（逃生阀不影响安全层）齐备', () => {
  const negs = CONF.vectors.filter((v) => /^neg-/.test(v.id));
  assert.equal(negs.length, 4);
  for (const v of negs) assert.equal(v.expect.ruleId, 'escape-hatch');
});

test('conf-05 全部向量逐条通过 Core', async () => {
  const core = await import('../core.mjs');
  let executed = 0;
  for (const v of CONF.vectors) {
    const actual = await runVector(core, v);
    assertSubset(v.expect, actual, v.id);
    assertProbe(actual, v, v.id);
    executed += 1;
  }
  assert.equal(executed, CONF.declaredVectorCount);
});

test('conf-06 本轮回修的三个 Post 面向量齐备且带机械断言（B-1/B-2/B-3）', () => {
  const byId = (id) => CONF.vectors.filter((v) => v.id === id)[0];
  const b1 = byId('dec-05');
  assert.ok(b1.adapterExpect && b1.adapterExpect.patch === false, 'dec-05 必须声明 Post 面无回填');
  assert.equal(b1.expect.trailer, '', 'dec-05：逃生阀不得追加 trailer');
  assert.equal(b1.expect.body, b1.input.args.body, 'dec-05：正文必须逐字');
  const b2 = byId('dec-06');
  assert.ok(b2.input.args.offset > 1, 'dec-06 必须是非 1 窗口起点');
  assert.ok(Array.isArray(b2.probe.bodyExcludes) && b2.probe.bodyExcludes.length >= 2, 'dec-06 必须同时钉住旧行为负向');
  const b3 = byId('dec-07');
  assert.ok(typeof b3.input.args.callCommand === 'string' && /^cat\s/.test(b3.input.args.callCommand), 'dec-07 必须是 shell 读取族命令词');
  assert.equal(b3.expect.kind, 'read', 'dec-07 必须走读取面算法');
});

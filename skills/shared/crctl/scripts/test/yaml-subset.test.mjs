// CR-2026-054 TASK-01：parseYaml 可选严格模式单元测试（SDD §2.1/§3.1/§7.3 tools）。
// 覆盖：block/flow 重复键、引号等价键、CRLF、tab、非法缩进/容器切换、未消费行、
// 孤立 '-'、合法空值、trailing flow 内容，以及默认模式兼容回归。
import test from 'node:test';
import assert from 'node:assert';
import { parseYaml } from '../lib/yaml-subset.mjs';

function strictErr(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

test('strict: block map 重复键（含 line/firstLine/key 字段）', () => {
  const e = strictErr(() => parseYaml('a: 1\na: 2', { strict: true }));
  assert.ok(e, '应抛出');
  assert.equal(e.category, 'duplicate-key');
  assert.equal(e.line, 2);
  assert.equal(e.firstLine, 1);
  assert.equal(e.key, 'a');
});

test('strict: 引号等价键冲突（id 与 \'id\'，unquote 后比较，大小写不折叠）', () => {
  const e = strictErr(() => parseYaml("id: x\n'id': y", { strict: true }));
  assert.equal(e.category, 'duplicate-key');
  // 大小写不折叠：ID 与 id 是不同键，不报重复
  const v = parseYaml('id: x\nID: y', { strict: true });
  assert.equal(v.id, 'x');
  assert.equal(v.ID, 'y');
});

test('strict: flow map 重复键', () => {
  const e = strictErr(() => parseYaml('a: {x: 1, "x": 2}', { strict: true }));
  assert.equal(e.category, 'duplicate-key');
  assert.equal(e.line, 1);
  assert.equal(e.firstLine, 1);
  assert.equal(e.key, 'x');
});

test('strict: tab 缩进 → invalid-indentation', () => {
  const e = strictErr(() => parseYaml('a:\n\tb: 1', { strict: true }));
  assert.equal(e.category, 'invalid-indentation');
  assert.equal(e.line, 2);
});

test('strict: 根节点必须自第 0 列开始', () => {
  const e = strictErr(() => parseYaml('  a: 1', { strict: true }));
  assert.equal(e.category, 'invalid-indentation');
  assert.equal(e.line, 1);
});

test('strict: 容器切换（映射中出现序列行）', () => {
  const e = strictErr(() => parseYaml('a: 1\n- b: 2', { strict: true }));
  assert.equal(e.category, 'invalid-indentation');
  assert.equal(e.line, 2);
});

test('strict: 容器切换（序列中出现映射行）', () => {
  const e = strictErr(() => parseYaml('- a\nb: 1', { strict: true }));
  assert.equal(e.category, 'invalid-indentation');
  assert.equal(e.line, 2);
});

test('strict: 非法深度（序列内联映射的孤儿行）', () => {
  const e = strictErr(() => parseYaml('cr-id: X\ntasks:\n  - id: A\n    status: pending\n      bad: z', { strict: true }));
  assert.equal(e.category, 'invalid-indentation');
  assert.equal(e.line, 5);
});

test('strict: 未消费行', () => {
  const e = strictErr(() => parseYaml('list:\n  - a\n  junk', { strict: true }));
  assert.equal(e.category, 'unconsumed-line');
  assert.equal(e.line, 3);
});

test('strict: 孤立 - 无子节点 → invalid-shape', () => {
  const e = strictErr(() => parseYaml('-', { strict: true }));
  assert.equal(e.category, 'invalid-shape');
  assert.equal(e.line, 1);
  const e2 = strictErr(() => parseYaml('a:\n  -', { strict: true }));
  assert.equal(e2.category, 'invalid-shape');
  assert.equal(e2.line, 2);
});

test('strict: 无法解释行 → invalid-shape', () => {
  const e = strictErr(() => parseYaml('a: 1\njust text', { strict: true }));
  assert.equal(e.category, 'invalid-shape');
  assert.equal(e.line, 2);
});

test('strict: trailing flow 内容 → invalid-shape', () => {
  const e = strictErr(() => parseYaml('a: [1, 2] junk', { strict: true }));
  assert.equal(e.category, 'invalid-shape');
  assert.equal(e.line, 1);
});

test('strict: CRLF 规范化后重复键仍被检出', () => {
  const e = strictErr(() => parseYaml('a: 1\r\na: 2', { strict: true }));
  assert.equal(e.category, 'duplicate-key');
  assert.equal(e.line, 2);
});

test('strict: 合法空值与 backlog 形状通过', () => {
  const v = parseYaml('change-requests:\nkey:', { strict: true });
  assert.equal(v.key, null);
  const b = parseYaml('change-requests:\n  - id: X\n    status: drafting\n', { strict: true });
  assert.equal(b['change-requests'][0].id, 'X');
});

test('strict: 合法 block 标量与嵌套序列通过', () => {
  const v = parseYaml('note: |\n  line one\n  line two\nlist:\n  - a\n  - b\n', { strict: true });
  assert.equal(v.note, 'line one\nline two');
  assert.deepEqual(v.list, ['a', 'b']);
});

test('默认模式兼容：重复键保留后值、宽松缩进与 CRLF 行为不变', () => {
  assert.equal(parseYaml('a: 1\na: 2').a, 2);
  assert.equal(parseYaml('a: 1\r\na: 2').a, 2);
  const v = parseYaml('change-requests:\n  - id: X\n    status: drafting\n');
  assert.equal(v['change-requests'][0].id, 'X');
});

test('默认模式兼容：选项缺失或 strict:false 与无参调用等价', () => {
  const a = parseYaml('a: 1\nb: {x: 1, x: 2}');
  const b = parseYaml('a: 1\nb: {x: 1, x: 2}', {});
  const c = parseYaml('a: 1\nb: {x: 1, x: 2}', { strict: false });
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

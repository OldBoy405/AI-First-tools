// CR-2026-065 TASK-01（FR-1/FR-3/FR-6）：断言事实源推导（只读、带缓存）。
//
// 本文件是测试辅助模块，**不**匹配 `*.test.mjs`，不会被 runner 采集为测试。
// 纪律（工程纪律 #1 / SDD §7.1）：所有读文本先做 `\r\n -> \n` 规范化；解析失败
// **硬失败报错**，禁止静默降级成空集合（T04 的教训正是「匹配不到 -> 空数组 ->
// 静默丢数据」）。
import fs from 'node:fs';
import path from 'node:path';

import { parseYaml } from '../lib/yaml-subset.mjs';

const textCache = new Map();
const stateMachineCache = new Map();
const testFileSetCache = new Map();

/** 读取 UTF-8 文本并做行尾规范化（`\r\n -> \n`）；同一路径在一次进程内只读一次。 */
export function readTextNormalized(absPath) {
  const key = path.resolve(absPath);
  if (textCache.has(key)) return textCache.get(key);
  const raw = fs.readFileSync(key, 'utf8');
  const normalized = raw.replaceAll('\r\n', '\n');
  textCache.set(key, normalized);
  return normalized;
}

function invalid(detail) {
  // 硬失败：调用方（断言）拿到异常即红，不做任何空集合降级。
  throw new Error(`deriveStateMachine: ${detail}`);
}

/**
 * 从 `dir-graph.yaml#change-request-track.state_machine` 推导状态机口径。
 * 返回 { namedStates, wildcards, transitions, identifiers, expandedCount, declaredCount }。
 * 推导失败（字段缺失 / 结构不符 / 自检不过）一律 throw。
 */
export function deriveStateMachine(toolsRoot) {
  const root = path.resolve(toolsRoot);
  if (stateMachineCache.has(root)) return stateMachineCache.get(root);
  const doc = parseYaml(readTextNormalized(path.join(root, 'dir-graph.yaml')), { strict: true });
  const track = doc ? doc['change-request-track'] : null;
  const sm = track ? track.state_machine : null;
  if (!sm || typeof sm !== 'object' || Array.isArray(sm)) invalid('change-request-track.state_machine 缺失或结构不符');
  const declarations = sm.transitions;
  if (!Array.isArray(declarations) || declarations.length === 0) invalid('state_machine.transitions 缺失或非非空数组');
  const wildcards = sm.wildcards || {};
  if (typeof wildcards !== 'object' || Array.isArray(wildcards)) invalid('state_machine.wildcards 结构不符');
  for (const t of declarations) {
    if (!t || typeof t !== 'object' || typeof t.from !== 'string' || typeof t.to !== 'string' || typeof t.trigger !== 'string') {
      invalid('transition 条目缺 from/to/trigger 字符串字段');
    }
  }
  for (const [name, targets] of Object.entries(wildcards)) {
    if (!Array.isArray(targets) || targets.some((x) => typeof x !== 'string')) invalid(`wildcard ${name} 目标非字符串数组`);
  }
  const wildcardNames = new Set(Object.keys(wildcards));
  const namedStates = [];
  const pushNamed = (state) => {
    if (state === '(new)' || wildcardNames.has(state)) return;
    if (!namedStates.includes(state)) namedStates.push(state);
  };
  for (const t of declarations) { pushNamed(t.from); pushNamed(t.to); }
  for (const name of Object.keys(wildcards)) for (const target of wildcards[name]) pushNamed(target);

  // 结构自检（步 9）：对同一批 declarations 恒真，只把「推导自身写错」暴露成异常，
  // 不作为断言/覆盖项（SDD-CLOSE-10）。
  const allowedSources = new Set([...namedStates, '(new)', ...wildcardNames]);
  for (const t of declarations) {
    if (!allowedSources.has(t.from)) invalid(`未声明来源状态 ${t.from}`);
    if (!allowedSources.has(t.to)) invalid(`未声明目标状态 ${t.to}`);
  }
  for (const name of wildcardNames) {
    for (const target of wildcards[name]) {
      if (!namedStates.includes(target)) invalid(`wildcard ${name} 目标 ${target} 不在具名状态集合`);
    }
  }
  for (const name of wildcardNames) {
    if (namedStates.includes(name)) invalid(`具名状态与 wildcard 名冲突：${name}`);
  }

  const transitions = declarations.map((t) => ({ from: t.from, to: t.to, trigger: t.trigger }));
  const identifiers = transitions.map((t) => `${t.from}|${t.to}|${t.trigger}`);
  let expandedCount = 0;
  for (const t of declarations) expandedCount += Array.isArray(wildcards[t.from]) ? wildcards[t.from].length : 1;
  const result = { namedStates, wildcards, transitions, identifiers, expandedCount, declaredCount: declarations.length };
  stateMachineCache.set(root, result);
  return result;
}

/** `skills/shared/crctl/scripts/test/*.test.mjs` 的升序文件名集合（空集合硬失败）。 */
export function readTestFileSet(toolsRoot) {
  const root = path.resolve(toolsRoot);
  if (testFileSetCache.has(root)) return testFileSetCache.get(root);
  const dir = path.join(root, 'skills', 'shared', 'crctl', 'scripts', 'test');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
  if (files.length === 0) throw new Error('readTestFileSet: 测试文件集合为空（硬失败，禁止按空集合继续）');
  testFileSetCache.set(root, files);
  return files;
}

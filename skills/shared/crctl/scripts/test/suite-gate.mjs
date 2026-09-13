#!/usr/bin/env node
// CR-2026-065 TASK-03（FR-11 / FR-12 / FR-14 / FR-17）：全量套件门禁包装器（B-4 修订版）。
//
// 调用形态（SDD §3.2，逐字；`--rc` 已取消）：
//   node suite-gate.mjs --run [--report-out <ndjson>] [--json-out <json>]
//                              [--max-runtime-ms <n>] [--cwd <tools-root>]
//   node suite-gate.mjs --report <ndjson> [--json-out <json>]
//
// 归属不变量 I1…I3（SDD §3.2）：
//   I1 每文件一个 `node --test --test-reporter=tap <abs file>` 子进程，归属在 spawn 时由
//      本包装器持有，**不读任何报告**；文件集合事实源 = 磁盘 `readTestFileSet`；
//   I2 每文件用例数 = 该文件自己 TAP 的「顶层 plan ≡ 顶层结果行数」，与
//      `gate-registry.json#manifest.cases` 逐项比较（`<` 即红）；证据面 = 报告 `files[]`；
//   I3 任何使 I1/I2 不可判的输入 → 硬失败红（`SUITE_REPORT_UNPARSEABLE` /
//      `SUITE_FILE_LOAD_FAILURE` / `SUITE_MANIFEST_FILE_DRIFT`），禁止降级为全局口径、
//      禁止跳过、禁止把「不可判」静默放过（工程纪律 #1）。
//
// 纪律：
//   - 唯一命令来源与唯一并发常量：池大小 = 本文件常量 `CONCURRENCY`（null = 候选①
//     `max(1, availableParallelism()-1)`；终值由 TASK-04 有界实测定，CI 不传参）；
//   - 门禁只读：不写登记面 `gate-registry.json`、不写 `.crctl/` 受治理账本、不写被测仓
//     （唯一写面 = 调用方显式指定的 `--report-out` / `--json-out` 路径）；
//   - 行尾纪律：所有读入文本先 `\r\n -> \n`；跨行解析失败硬失败，不静默降级；
//   - stdout 禁词（J-8 / `lib/workspace-transactions.mjs:3992-3998` 冻结模式表）：人类摘要与
//     JSON 不得出现独立词 `skipped`（含大小写）/ `# skip` / `no tests to run`。因此每文件
//     跳过计数在报告里序列化为 `skipped_cases`（`skipped_` 前缀不构成词边界；SDD §2.4
//     的 `files[].skipped` 与 J-8 冲突，见 TASK-03 节点输出 §偏差），顶层字段用
//     `skipped_file_level`。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

import { readTestFileSet } from './assertion-sources.mjs';

/* ─────────────────────────── 常量面（唯一命令来源） ─────────────────────────── */

// TDEC-4：池大小唯一常量（与 Node `--test-concurrency` 同语义：文件级并发）。
//   null      = 候选① 默认 `max(1, availableParallelism() - 1)`
//   2 / 1     = 候选②/③（TASK-04 有界实测时临时切换；选中者写回本常量）
const CONCURRENCY = null;
const DEFAULT_MAX_RUNTIME_MS = 1800000; // 30 min（SDD §7.3）
const OBSERVER_TAP_PER_FILE = 'tap-per-file';
const EXCEPTION_KINDS = ['suite-failure', 'suite-nonconvergence'];
const CODES = [
  'SUITE_REGISTRY_MISSING', 'SUITE_REGISTRY_SCHEMA_INVALID', 'SUITE_REPORT_UNPARSEABLE',
  'SUITE_FILE_LOAD_FAILURE', 'SUITE_MANIFEST_FILE_DRIFT', 'SUITE_MANIFEST_CASE_DROP',
  'EXCEPTION_FIELD_MISSING', 'EXCEPTION_SCHEMA_INVALID', 'EXCEPTION_DUPLICATE',
  'EXCEPTION_EXPIRED', 'EXCEPTION_NOT_OBSERVED', 'SUITE_FAILURES_UNREGISTERED',
  'SUITE_NONCONVERGENCE',
];
const ALLOWED_FLAGS = ['--run', '--report', '--report-out', '--json-out', '--max-runtime-ms', '--cwd'];

const poolSize = (value) => value ?? Math.max(1, os.availableParallelism() - 1);

/* ────────────────────────────── CLI ────────────────────────────── */

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
for (const token of argv) {
  if (!token.startsWith('--')) continue;
  if (!ALLOWED_FLAGS.includes(token)) {
    process.stderr.write(`suite-gate: 未知参数 ${token}（--rc 已取消：每文件退出码在记录内的 exit_code 字段）\n`);
    process.exit(2);
  }
}
const runMode = argv.includes('--run');
const reportPath = flagValue('--report');
const reportOut = flagValue('--report-out');
const jsonOut = flagValue('--json-out');
const maxRuntimeMs = Number(flagValue('--max-runtime-ms') ?? DEFAULT_MAX_RUNTIME_MS);
const toolsRoot = path.resolve(flagValue('--cwd') ?? path.resolve(import.meta.dirname, '..', '..', '..', '..', '..'));
const testRoot = path.join(toolsRoot, 'skills', 'shared', 'crctl', 'scripts', 'test');

if ((runMode ? 1 : 0) + (reportPath ? 1 : 0) !== 1) {
  process.stderr.write('suite-gate: 必须且只能指定一种形态：--run 或 --report <ndjson>\n');
  process.exit(2);
}
if (runMode && !Number.isFinite(maxRuntimeMs)) {
  process.stderr.write('suite-gate: --max-runtime-ms 必须为数字\n');
  process.exit(2);
}

/* ─────────────────────── 判定状态（check code 面） ─────────────────────── */

const triggers = [];
const marks = new Map();
function trigger(code, detail, extras = {}) {
  const existing = triggers.find((t) => t.code === code);
  if (existing) { existing.detail += '；' + detail; return; }
  triggers.push({ code, detail, ...extras });
}
function mark(code, detail) {
  if (!marks.has(code)) marks.set(code, detail);
}
const codeOf = (code) => triggers.find((t) => t.code === code);

/* ─────────────────────────── 登记面读取（只读） ─────────────────────────── */

function readRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) {
    trigger('SUITE_REGISTRY_MISSING', `登记文件缺失：${registryPath}`);
    return { registry: null, raw: null };
  }
  const raw = fs.readFileSync(registryPath, 'utf8').replaceAll('\r\n', '\n');
  let registry = null;
  try {
    registry = JSON.parse(raw);
  } catch (e) {
    trigger('SUITE_REGISTRY_SCHEMA_INVALID', `登记文件非法 JSON：${e.message}`);
    return { registry: null, raw };
  }
  const problems = [];
  if (registry.schema !== 'crctl-suite-gate/v1') problems.push(`schema 不符：${String(registry.schema)}`);
  const manifest = registry.manifest;
  if (!manifest || typeof manifest !== 'object') problems.push('manifest 段缺失');
  else {
    if (!Array.isArray(manifest.files) || manifest.files.some((f) => typeof f !== 'string')) problems.push('manifest.files 非字符串数组');
    if (!manifest.cases || typeof manifest.cases !== 'object' || Array.isArray(manifest.cases)) problems.push('manifest.cases 非对象');
    else {
      for (const [k, v] of Object.entries(manifest.cases)) {
        if (!(Number.isInteger(v) && v > 0)) problems.push(`manifest.cases.${k} 非正整数`);
      }
    }
  }
  const sm = registry.stateMachine;
  if (!sm || typeof sm !== 'object') problems.push('stateMachine 段缺失');
  else {
    if (!Array.isArray(sm.namedStates)) problems.push('stateMachine.namedStates 非数组');
    if (!sm.wildcards || typeof sm.wildcards !== 'object' || Array.isArray(sm.wildcards)) problems.push('stateMachine.wildcards 非对象');
    else for (const [k, v] of Object.entries(sm.wildcards)) if (!Array.isArray(v)) problems.push(`stateMachine.wildcards.${k} 非数组`);
    if (!Array.isArray(sm.transitions)) problems.push('stateMachine.transitions 非数组');
  }
  if (!Array.isArray(registry.exceptions)) problems.push('exceptions 非数组（交付态必须是显式空数组）');
  if (problems.length > 0) trigger('SUITE_REGISTRY_SCHEMA_INVALID', problems.join('；'));
  return { registry, raw };
}

/** 例外面自身错误（field/schema/duplicate/expired）+ 未到期条目（读登记值 + 运行时瞬时）。 */
function validateExceptions(list, nowMs) {
  const live = [];
  const seen = new Set();
  for (const [i, ex] of list.entries()) {
    if (!ex || typeof ex !== 'object' || Array.isArray(ex)) { trigger('EXCEPTION_SCHEMA_INVALID', `exceptions[${i}] 非对象`); continue; }
    const missing = ['id', 'kind', 'reason', 'owner', 'expires'].filter((f) => typeof ex[f] !== 'string' || ex[f].length === 0);
    if (missing.length > 0) { trigger('EXCEPTION_FIELD_MISSING', `exceptions[${i}] 缺字段 ${missing.join('/')}`); continue; }
    if (!EXCEPTION_KINDS.includes(ex.kind)) { trigger('EXCEPTION_SCHEMA_INVALID', `exceptions[${i}].kind 非枚举：${ex.kind}`); continue; }
    const hasOffset = /(Z|[+-]\d{2}:\d{2})$/.test(ex.expires);
    const expiresMs = Date.parse(ex.expires);
    if (!hasOffset || Number.isNaN(expiresMs)) { trigger('EXCEPTION_SCHEMA_INVALID', `exceptions[${i}].expires 无时区偏移或不可解析：${ex.expires}`); continue; }
    if (seen.has(ex.id)) { trigger('EXCEPTION_DUPLICATE', `重复例外 id：${ex.id}`); continue; }
    seen.add(ex.id);
    if (nowMs >= expiresMs) { trigger('EXCEPTION_EXPIRED', `例外已到期：${ex.id} expires=${ex.expires}`); continue; }
    live.push({ ...ex, expiresMs });
  }
  return live;
}

/* ─────────────────── 单文件 TAP 解析（顶层 plan ≡ 顶层结果行数） ─────────────────── */

/**
 * 解析**一个**文件的 TAP（归属已由 spawn 构造持有，本函数不做归属推断）。
 * 永不抛错：结构不符时返回 `error` 描述，由调用方按 I3 归类为固定 check code。
 * 判定面（SDD §4.2）：① 恰一条顶层 plan `1..N`；② 顶层结果行（缩进 0 的 ok/not ok）数 ≡ N；
 * ③ 缩进栈自洽（子块闭合、无孤立 `...`）。
 */
export function parseFileTap(text) {
  const lines = String(text ?? '').replaceAll('\r\n', '\n').split('\n');
  const stack = []; // 未闭合的 # Subtest 块：{ name, indent }
  const diag = []; // 未闭合的诊断块（--- / ...）：indent
  let plan = null;
  let topResults = 0;
  const failures = [];
  let skipCount = 0;
  let todoCount = 0;
  const fail = (detail) => ({ error: detail, plan, topResults, failures: [...failures], skipped: skipCount, todo: todoCount });
  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+$/, '');
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const indent = /^[ \t]*/.exec(line)[0].length;
    if (diag.length > 0) {
      // 诊断块（--- … ...）内：只有与开启行**同缩进**的 ... 才是结束标记；其余（含错缩进的
      // `---` / `...`，如 Node 对长输出打印的缩进 `...`/`... Skipped lines`）都是块内容。
      if (trimmed === '...' && indent === diag[diag.length - 1]) diag.pop();
      continue;
    }
    if (trimmed === '---') { diag.push(indent); continue; }
    if (trimmed === '...') return fail(`孤立 ...（缩进栈不成对，indent=${indent}）`);
    if (/^TAP version \d+$/.test(trimmed)) continue;
    let m;
    if ((m = /^# Subtest: (.*)$/.exec(trimmed))) {
      if (stack.length > 0 && indent <= stack[stack.length - 1].indent) return fail(`缩进栈不成对（Subtest「${m[1]}」缩进未递增：${indent} <= ${stack[stack.length - 1].indent}）`);
      stack.push({ name: m[1], indent });
      continue;
    }
    if ((m = /^(not ok|ok) (\d+) - (.*)$/.exec(trimmed))) {
      const status = m[1];
      const name = m[3];
      const suffix = /\s+#\s*(SKIP|TODO)\s*$/i.exec(name);
      const isSkip = Boolean(suffix) && suffix[1].toUpperCase() === 'SKIP';
      const isTodo = Boolean(suffix) && suffix[1].toUpperCase() === 'TODO';
      if (stack.length === 0) {
        if (indent !== 0) return fail(`结果行无对应 Subtest 块（缩进 ${indent}）：${name}`);
      } else {
        const top = stack[stack.length - 1];
        if (top.indent !== indent) return fail(`结果行缩进与块不匹配（块 ${top.name} @${top.indent} / 结果 @${indent}）`);
        stack.pop();
      }
      if (indent === 0) {
        topResults += 1;
        if (isSkip) skipCount += 1;
        if (isTodo) todoCount += 1;
        if (status === 'not ok') failures.push(name);
      }
      continue;
    }
    if ((m = /^1\.\.(\d+)$/.exec(trimmed))) {
      if (indent !== 0) continue; // 子块自身的 plan（本设计下不出现，容错忽略，不影响顶层 plan 判定）
      if (plan !== null) return fail(`出现多条顶层 plan：${plan} / ${m[1]}`);
      plan = Number(m[1]);
      continue;
    }
    // 其余行（# tests / # pass / # fail / # duration_ms / 自定义注释）不参与结构判定。
  }
  if (diag.length > 0) return fail(`诊断块未闭合（缩进栈不成对，残留 ${diag.length} 个 ---）`);
  if (stack.length > 0) return fail(`Subtest 块未闭合（缩进栈不成对）：${stack.map((b) => b.name).join(' / ')}`);
  if (plan === null) return fail('无顶层 plan');
  if (plan !== topResults) return fail(`plan 与顶层结果行数矛盾（plan=${plan} 实际顶层结果=${topResults}）`);
  return { error: null, plan, topResults, failures: [...failures], skipped: skipCount, todo: todoCount };
}

/** 文件级加载失败的形态判据（辅助，不作归属来源；两运行时形态见 SDD §7.4 P2）。 */
function isFileLevelName(name, relFile, absFile) {
  return name === relFile || name === absFile || name.endsWith(relFile) || name.endsWith(absFile) || name.endsWith('/' + relFile) || name.endsWith('\\' + relFile);
}

/* ─────────────────────────── --run：逐文件 spawn（池） ─────────────────────────── */

function killTree(child) {
  if (!child || child.pid === undefined) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false }); } catch { /* 已退出 */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
}

async function runPool(files, size, maxRuntimeMsArg) {
  const startedAt = Date.now();
  const records = new Map();
  const running = new Map();
  const killed = new Set();
  let aborted = false;
  let cursor = 0;
  const timer = setTimeout(() => {
    aborted = true;
    for (const [file, child] of running) { killed.add(file); killTree(child); }
  }, maxRuntimeMsArg);
  const spawnFile = (file) => new Promise((resolve) => {
    const abs = path.join(testRoot, file);
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', abs], {
      cwd: toolsRoot, shell: false, detached: process.platform !== 'win32',
    });
    running.set(file, child);
    const t0 = Date.now();
    let tap = '';
    child.stdout.on('data', (chunk) => { tap += String(chunk); });
    child.on('error', (e) => resolve({ code: null, tap, durationMs: Date.now() - t0, spawnError: String(e && e.message || e) }));
    child.on('close', (code) => resolve({ code, tap, durationMs: Date.now() - t0, spawnError: null }));
  });
  const worker = async () => {
    for (;;) {
      if (aborted) return;
      const i = cursor;
      cursor += 1;
      if (i >= files.length) return;
      const file = files[i];
      const outcome = await spawnFile(file);
      running.delete(file);
      records.set(file, {
        file,
        exit_code: outcome.code,
        converged: !killed.has(file),
        tap: outcome.tap,
        duration_ms: outcome.durationMs,
        spawn_error: outcome.spawnError,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, files.length)) }, () => worker()));
  clearTimeout(timer);
  for (const file of files) {
    if (!records.has(file)) {
      killed.add(file);
      records.set(file, { file, exit_code: null, converged: false, tap: '', duration_ms: null, spawn_error: null });
    }
  }
  return {
    records: files.map((f) => records.get(f)),
    converged: killed.size === 0 && !aborted,
    durationMs: Date.now() - startedAt,
    aborted,
  };
}

/* ─────────────────────────── NDJSON 记录（--report-out / --report） ─────────────────────────── */

function writeNdjson(p, records) {
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  const text = records.map((r) => JSON.stringify({ file: r.file, exit_code: r.exit_code, converged: r.converged, tap: r.tap })).join('\n') + '\n';
  fs.writeFileSync(path.resolve(p), text, 'utf8');
}

function readNdjson(p) {
  const raw = fs.readFileSync(path.resolve(p), 'utf8').replaceAll('\r\n', '\n');
  const records = [];
  for (const [i, line] of raw.split('\n').entries()) {
    if (line.trim() === '') continue;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      process.stderr.write(`suite-gate: --report 第 ${i + 1} 行非法 JSON：${e.message}\n`);
      process.exit(2);
    }
    if (!rec || typeof rec !== 'object' || typeof rec.file !== 'string' || !('exit_code' in rec) || typeof rec.converged !== 'boolean' || typeof rec.tap !== 'string') {
      process.stderr.write(`suite-gate: --report 第 ${i + 1} 行字段不符 {file,exit_code,converged,tap}\n`);
      process.exit(2);
    }
    records.push(rec);
  }
  if (records.length === 0) {
    process.stderr.write('suite-gate: --report 记录为空（硬失败，禁止按空集合继续）\n');
    process.exit(2);
  }
  return records;
}

/* ─────────────────────────── 判定（--run / --report 同一函数） ─────────────────────────── */

function judge(context) {
  const { registry, registryRaw, records, durationMs, command, nowMs } = context;
  const live = registry && Array.isArray(registry.exceptions) ? validateExceptions(registry.exceptions, nowMs) : [];
  const failureExceptions = live.filter((e) => e.kind === 'suite-failure');
  const nonconvergenceExceptions = live.filter((e) => e.kind === 'suite-nonconvergence');

  let converged = records.every((r) => r.converged === true);
  let exitCode = converged ? (records.every((r) => r.exit_code === 0) ? 0 : 1) : null;

  const files = [];
  const failures = [];
  const unparseable = [];
  let casesExecuted = null;
  let filesExecuted = null;
  let skippedFileLevel = null;

  if (!converged) {
    // 非收敛分支：不做清单核对与失败集合核对（not_evaluated），只判 SUITE_NONCONVERGENCE 与登记面自身错误。
    // 已自行结束的子进程仍按自己的 TAP 归类 state（ok|failed|file-load-failure，本分支不触发任何 check，
    // 也不上报用例级失败：cases_executed=null / failures=[]）；未结束者 = unfinished。
    for (const r of records) {
      if (r.converged !== true) {
        files.push({ file: r.file, state: 'unfinished', exit_code: r.exit_code, cases: null, failures: [], skipped_cases: null, todo: null, duration_ms: r.duration_ms ?? null });
        continue;
      }
      const abs = path.join(testRoot, r.file);
      const T = parseFileTap(r.tap);
      const loadFailure = r.exit_code !== 0 && (T.topResults === 0 || (T.topResults === 1 && T.failures.length === 1 && isFileLevelName(T.failures[0], r.file, abs)));
      const state = loadFailure ? 'file-load-failure' : (T.error === null && r.exit_code === 0 && T.failures.length === 0 ? 'ok' : 'failed');
      files.push({ file: r.file, state, exit_code: r.exit_code, cases: T.error === null ? T.plan : null, failures: [], skipped_cases: T.error === null ? T.skipped : null, todo: T.error === null ? T.todo : null, duration_ms: r.duration_ms ?? null });
    }
    mark('SUITE_MANIFEST_FILE_DRIFT', '非收敛分支未做清单核对');
    mark('SUITE_MANIFEST_CASE_DROP', '非收敛分支未做清单核对');
    mark('SUITE_FAILURES_UNREGISTERED', '非收敛分支未做失败集合核对');
    mark('EXCEPTION_NOT_OBSERVED', '非收敛分支禁用空观测集合判定（E-2 收口）');
    if (nonconvergenceExceptions.length > 0) {
      trigger('SUITE_NONCONVERGENCE', '全量命令超过 --max-runtime-ms 仍未结束（converged=false）', { suppressed_by: nonconvergenceExceptions.map((e) => e.id).join(',') });
    } else {
      trigger('SUITE_NONCONVERGENCE', '全量命令超过 --max-runtime-ms 仍未结束（converged=false），无匹配未到期例外');
    }
  } else {
    for (const r of records) {
      const abs = path.join(testRoot, r.file);
      const T = parseFileTap(r.tap);
      const loadFailure =
        r.exit_code !== 0 &&
        (T.topResults === 0 || (T.topResults === 1 && T.failures.length === 1 && [T.failures[0]].every((n) => isFileLevelName(n, r.file, abs))));
      let state = 'ok';
      let cases = T.plan;
      if (loadFailure) {
        state = 'file-load-failure';
        cases = T.topResults;
        trigger('SUITE_FILE_LOAD_FAILURE', `文件整体加载/执行失败：${r.file}（exit_code=${r.exit_code}，顶层结果 ${T.topResults} 条${T.error ? '，TAP ' + T.error : ''}）`);
      } else if (T.error !== null) {
        state = 'failed';
        cases = null;
        unparseable.push(r.file);
        trigger('SUITE_REPORT_UNPARSEABLE', `${r.file}：${T.error}`);
      } else if (r.exit_code !== 0 || T.failures.length > 0) {
        state = 'failed';
      }
      if (state !== 'file-load-failure') failures.push(...T.failures);
      files.push({
        file: r.file,
        state,
        exit_code: r.exit_code,
        cases,
        failures: [...T.failures],
        skipped_cases: T.skipped,
        todo: T.todo,
        duration_ms: r.duration_ms ?? null,
      });
    }

    const judged = unparseable.length === 0;
    const observed = files.filter((f) => f.state !== 'unfinished');
    filesExecuted = observed.filter((f) => f.cases !== null).length;
    casesExecuted = judged ? files.reduce((a, f) => a + (f.cases ?? 0), 0) : null;
    skippedFileLevel = files.filter((f) => f.cases === 0).length;

    if (!judged) {
      mark('SUITE_MANIFEST_FILE_DRIFT', '存在不可解析的 TAP，清单核对未执行');
      mark('SUITE_MANIFEST_CASE_DROP', '存在不可解析的 TAP，清单核对未执行');
      mark('SUITE_FAILURES_UNREGISTERED', '存在不可解析的 TAP，失败集合核对未执行');
      mark('EXCEPTION_NOT_OBSERVED', '存在不可解析的 TAP，陈旧例外核对未执行');
    } else {
      // 清单核对（I1/I2）：磁盘集合 ≡ manifest.files；每文件用例数 ≥ 基线。
      if (registry && Array.isArray(registry.manifest?.files)) {
        const declared = [...registry.manifest.files].sort();
        let disk = [];
        try {
          disk = [...readTestFileSet(toolsRoot)].sort();
        } catch (e) {
          trigger('SUITE_MANIFEST_FILE_DRIFT', `磁盘测试文件集合不可判：${e.message}`);
        }
        if (disk.length > 0 && JSON.stringify(declared) !== JSON.stringify(disk)) {
          trigger('SUITE_MANIFEST_FILE_DRIFT', `磁盘集合 ≠ manifest.files（磁盘 ${disk.length} / 登记 ${declared.length}）`);
        }
        const observedSet = files.map((f) => f.file).sort();
        if (JSON.stringify(declared) !== JSON.stringify(observedSet)) {
          trigger('SUITE_MANIFEST_FILE_DRIFT', `被真实 spawn 的文件集合 ≠ manifest.files（spawn ${observedSet.length} / 登记 ${declared.length}）`);
        }
        const baseline = registry.manifest.cases ?? {};
        for (const f of files) {
          if (f.state === 'file-load-failure' || f.cases === null) continue; // 加载失败另有 check code
          const base = baseline[f.file];
          if (!Number.isInteger(base)) trigger('SUITE_MANIFEST_CASE_DROP', `manifest.cases 缺 ${f.file} 的基线`);
          else if (f.cases < base) trigger('SUITE_MANIFEST_CASE_DROP', `${f.file} 实际顶层用例数 ${f.cases} < 基线 ${base}`);
        }
      } else {
        mark('SUITE_MANIFEST_FILE_DRIFT', '登记面不可用，清单核对未执行');
      }

      // 失败集合核对：未到期 suite-failure 例外覆盖的失败不计入本项（容忍在触发条件内）。
      const unique = [...new Set(failures)];
      const covered = new Set(failureExceptions.map((e) => e.match));
      const uncovered = unique.filter((name) => !covered.has(name));
      if (uncovered.length > 0) trigger('SUITE_FAILURES_UNREGISTERED', `未登记失败：${uncovered.join('、')}`);
      const stale = failureExceptions.filter((e) => !unique.includes(e.match));
      if (stale.length > 0) trigger('EXCEPTION_NOT_OBSERVED', `例外在本次运行中未出现（陈旧登记）：${stale.map((e) => e.id).join('、')}`);
    }

    // 安全网：子进程集合非零退出却没有任何失败可判 → 结构不完整，禁止静默判绿。
    if (records.some((r) => r.exit_code !== 0) && triggers.length === 0) {
      trigger('SUITE_REPORT_UNPARSEABLE', '存在非零退出码但 TAP 未暴露任何失败（结构不完整，禁止静默判绿）');
    }
  }

  const registrySha = registryRaw === null ? null : crypto.createHash('sha256').update(registryRaw, 'utf8').digest('hex');
  const checks = CODES.map((code) => {
    const hit = codeOf(code);
    if (hit) {
      return {
        code,
        ok: false,
        detail: hit.detail,
        ...(hit.suppressed_by ? { suppressed_by: hit.suppressed_by } : {}),
      };
    }
    if (marks.has(code)) return { code, ok: false, detail: marks.get(code), not_evaluated: true };
    return { code, ok: true, detail: 'ok' };
  });
  const unsuppressed = triggers.filter((t) => !t.suppressed_by);
  const verdict = unsuppressed.length === 0 ? 'pass' : 'block';
  return {
    schema: 'crctl-suite-gate-report/v1',
    command,
    observer: OBSERVER_TAP_PER_FILE,
    duration_ms: durationMs,
    converged,
    exit_code: exitCode,
    files_executed: filesExecuted,
    cases_executed: casesExecuted,
    skipped_file_level: skippedFileLevel,
    files,
    failures: [...new Set(failures)],
    checks,
    registry: { sha256: registrySha, exceptions_count: registry && Array.isArray(registry.exceptions) ? registry.exceptions.length : 0 },
    platform: { platform: process.platform, node: process.versions.node },
    verdict,
  };
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

async function main() {
  const registryPath = path.join(testRoot, 'gate-registry.json');
  const nowMs = Date.now();
  const { registry, raw } = readRegistry(registryPath);

  let context = null;
  if (runMode) {
    let files = [];
    try {
      files = [...readTestFileSet(toolsRoot)];
    } catch (e) {
      process.stderr.write(`suite-gate: 测试文件集合不可判：${e.message}\n`);
      process.exit(2);
    }
    const declared = Array.isArray(registry?.manifest?.files) ? registry.manifest.files : [];
    if (JSON.stringify([...declared].sort()) !== JSON.stringify(files)) {
      trigger('SUITE_MANIFEST_FILE_DRIFT', `磁盘集合 ≠ manifest.files（磁盘 ${files.length} / 登记 ${declared.length}）`);
    }
    const size = poolSize(CONCURRENCY);
    const command = `node --test --test-reporter=tap <${files.length} files> (pool=${size}, availableParallelism=${os.availableParallelism()})`;
    const run = await runPool(declared.length > 0 ? declared : files, size, maxRuntimeMs);
    if (reportOut) writeNdjson(reportOut, run.records);
    context = { registry, registryRaw: raw, records: run.records, durationMs: run.durationMs, command, nowMs };
  } else {
    const records = readNdjson(reportPath);
    context = {
      registry, registryRaw: raw, records,
      durationMs: records.reduce((a, r) => a + (Number.isFinite(r.duration_ms) ? r.duration_ms : 0), 0),
      command: 'report-replay',
      nowMs,
    };
  }

  const report = judge(context);

  if (jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
    fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  // 表注⑤（plan §6.2）：`--run` 不带 --json-out 时，15 字段报告以 JSON 打到 stdout
  // （test-evidence/cmd-01.log 逐字落该 JSON）；J-8 禁词约束对人类摘要同样成立。
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(`suite-gate: command=${report.command}\n`);
  process.stdout.write(`suite-gate: observer=${report.observer} duration_ms=${report.duration_ms} converged=${report.converged} exit_code=${report.exit_code}\n`);
  process.stdout.write(`suite-gate: files_executed=${report.files_executed} cases_executed=${report.cases_executed} skipped_file_level=${report.skipped_file_level}\n`);
  process.stdout.write(`suite-gate: failures=${report.failures.length}${report.failures.length > 0 ? ' [' + report.failures.join(' | ') + ']' : ''}\n`);
  process.stdout.write(`suite-gate: registry_sha256=${report.registry.sha256} exceptions_count=${report.registry.exceptions_count}\n`);
  for (const c of report.checks.filter((x) => !x.ok)) {
    process.stdout.write(`suite-gate: check_failed=${c.code} detail=${c.detail}${c.suppressed_by ? ' suppressed_by=' + c.suppressed_by : ''}${c.not_evaluated ? ' not_evaluated=true' : ''}\n`);
  }
  process.stdout.write(`suite-gate: verdict=${report.verdict}\n`);
  process.exit(report.verdict === 'pass' ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`suite-gate: 未捕获错误：${e && e.stack || e}\n`);
  process.exit(2);
});

#!/usr/bin/env node
// CR-2026-065 TASK-03（FR-11 / FR-12 / FR-14 / FR-17）：全量套件门禁包装器。
//
// 调用形态（SDD §3.2，逐字）：
//   node suite-gate.mjs --run [--report-out <tap>] [--json-out <json>]
//                              [--max-runtime-ms <n>] [--cwd <tools-root>]
//   node suite-gate.mjs --report <tap> --rc <exit-code> [--json-out <json>]
//
// 纪律：
//   - 唯一命令来源：`node --test --test-reporter=tap [--test-concurrency=<常量>] <21 个绝对路径>`
//     （glob 由本包装器展开；展开为空即硬失败）；
//   - TAP 解析硬失败，禁止降级为「零失败」；plan 与实际行数矛盾、块不成对、无 file 级 plan 一律抛错；
//   - 门禁只读：不写登记面、不写受治理账本、不写被测仓（唯一写面 = 本包装器自己 spawn 的 TAP/JSON 证据文件）；
//   - stdout 禁词（J-8）：不得出现独立单词 skipped（含大小写）/ `# skip` / `no tests to run`，
//     固定字段名用 skipped_file_level（依据 lib/workspace-transactions.mjs 的冻结 skip 模式表）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

import { readTestFileSet } from './assertion-sources.mjs';

// TDEC-4 设计默认 = 去参（runner 默认并发）；终值由 TASK-04 有界实测定。唯一常量。
const CONCURRENCY = null;
const DEFAULT_MAX_RUNTIME_MS = 1800000; // 30 min（SDD §7.3）
const EXCEPTION_KINDS = ['suite-failure', 'suite-nonconvergence'];
const CODES = [
  'SUITE_REGISTRY_MISSING', 'SUITE_REGISTRY_SCHEMA_INVALID', 'SUITE_REPORT_UNPARSEABLE',
  'SUITE_FILE_LOAD_FAILURE', 'SUITE_MANIFEST_FILE_DRIFT', 'SUITE_MANIFEST_CASE_DROP',
  'EXCEPTION_FIELD_MISSING', 'EXCEPTION_SCHEMA_INVALID', 'EXCEPTION_DUPLICATE',
  'EXCEPTION_EXPIRED', 'EXCEPTION_NOT_OBSERVED', 'SUITE_FAILURES_UNREGISTERED',
  'SUITE_NONCONVERGENCE',
];

/* ────────────────────────────── CLI ────────────────────────────── */

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const runMode = argv.includes('--run');
const reportOut = flagValue('--report-out');
const jsonOut = flagValue('--json-out');
const reportPath = flagValue('--report');
const rcArg = flagValue('--rc');
const maxRuntimeMs = Number(flagValue('--max-runtime-ms') ?? DEFAULT_MAX_RUNTIME_MS);
const toolsRoot = path.resolve(flagValue('--cwd') ?? path.resolve(import.meta.dirname, '..', '..', '..', '..', '..'));

if (runMode === Boolean(reportPath)) {
  process.stderr.write('suite-gate: 必须且只能指定一种形态：--run 或 --report <tap> --rc <exit-code>\n');
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
const blockedBy = (code) => {
  const t = codeOf(code);
  return Boolean(t) && !t.suppressed_by;
};

/* ─────────────────────────── 登记面读取 ─────────────────────────── */

function readRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) {
    trigger('SUITE_REGISTRY_MISSING', `登记文件缺失：${registryPath}`);
    return { registry: null, raw: null, problems: [] };
  }
  const raw = fs.readFileSync(registryPath, 'utf8').replaceAll('\r\n', '\n');
  let registry = null;
  try {
    registry = JSON.parse(raw);
  } catch (e) {
    trigger('SUITE_REGISTRY_SCHEMA_INVALID', `登记文件非法 JSON：${e.message}`);
    return { registry: null, raw, problems: [] };
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
  return { registry, raw, problems };
}

/** 例外面自身错误（field/schema/duplicate/expired）+ 未到期条目。 */
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

/* ─────────────────────────── TAP 解析（硬失败） ─────────────────────────── */

class TapError extends Error {}

function indentOf(line) {
  const m = /^ */.exec(line);
  return m[0].length;
}

function parseTap(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const stack = [];
  const files = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed === 'TAP version 13') continue;
    const indent = indentOf(line);
    let m;
    if ((m = /^# Subtest: (.*)$/.exec(trimmed))) {
      if (stack.length > 0 && indent <= stack[stack.length - 1].indent) throw new TapError(`块不成对：Subtest「${m[1]}」缩进未递增`);
      stack.push({ name: m[1], indent, plan: null, result: null, failNames: [], childResults: 0, fileLevelSkip: false });
      continue;
    }
    if ((m = /^(not ok|ok) (\d+) - (.*)$/.exec(trimmed))) {
      const ok = m[1] === 'ok';
      let name = m[3];
      const suffix = /\s+#\s*(SKIP|TODO)\s*$/i.exec(name);
      if (suffix) name = name.slice(0, suffix.index).replace(/\s+$/, '');
      if (stack.length === 0) {
        // 文件级加载失败：无 Subtest 块的结果行（Node 在整体加载失败时如此报告）
        if (name.endsWith('.test.mjs')) {
          files.push({ name, indent, plan: null, result: 'not ok', failNames: [], childResults: 0, fileLevelSkip: false, loadFailure: true });
          continue;
        }
        throw new TapError(`结果行无对应 Subtest 块：${name}`);
      }
      const top = stack[stack.length - 1];
      if (top.indent !== indent) throw new TapError(`结果行缩进与块不匹配：${name}`);
      if (top.name !== name) throw new TapError(`块与结果名不匹配：block=${top.name} result=${name}`);
      stack.pop();
      top.result = ok ? 'ok' : 'not ok';
      top.fileLevelSkip = Boolean(suffix && suffix[1].toUpperCase() === 'SKIP');
      const ownFailures = [...top.failNames];
      if (!ok && ownFailures.length === 0) ownFailures.push(name);
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        if (indent > parent.indent) {
          parent.childResults += 1;
          parent.failNames.push(...ownFailures);
        }
      } else if (!ok && !name.endsWith('.test.mjs')) {
        throw new TapError(`顶层失败结果不属于任何文件块：${name}`);
      }
      if (name.endsWith('.test.mjs')) files.push(top);
      continue;
    }
    if ((m = /^1\.\.(\d+)$/.exec(trimmed))) {
      if (stack.length === 0) continue; // 全局 plan（顶层）不出现在任何块内
      const top = stack[stack.length - 1];
      if (top.indent !== indent) throw new TapError('plan 行缩进与块不匹配');
      if (top.plan !== null) throw new TapError('同一块出现重复 plan');
      top.plan = Number(m[1]);
      continue;
    }
  }
  if (stack.length > 0) throw new TapError(`块不成对：未闭合的 Subtest 块 ${stack.map((b) => b.name).join(', ')}`);
  return files;
}

/* ─────────────────────── 逐文件解析结果核对（硬失败） ─────────────────────── */

function analyzeFiles(files) {
  const observed = new Map(); // file name -> cases
  const failures = [];
  for (const f of files) {
    if (f.loadFailure || f.plan === null) continue; // 加载失败单独走 SUITE_FILE_LOAD_FAILURE
    if (f.result !== 'ok' && f.result !== 'not ok') throw new TapError(`文件块无结果行：${f.name}`);
    if (f.plan !== f.childResults) throw new TapError(`plan 与实际行数矛盾：${f.name} plan=${f.plan} 实际=${f.childResults}`);
    observed.set(f.name, f.plan);
    failures.push(...f.failNames);
  }
  return { observed, failures };
}

/* ─────────────────────────── 判定（同一函数供两形态） ─────────────────────────── */

function judge(context) {
  const { registry, registryPath, raw, converged, exitCode, nowMs } = context;
  const liveExceptions = registry && Array.isArray(registry.exceptions) ? validateExceptions(registry.exceptions, nowMs) : [];
  const failureExceptions = liveExceptions.filter((e) => e.kind === 'suite-failure');
  const nonconvergenceExceptions = liveExceptions.filter((e) => e.kind === 'suite-nonconvergence');

  let filesExecuted = null;
  let casesExecuted = null;
  let fileLevelSkip = null;
  let failures = null;
  let parseError = null;
  let analysis = null;

  if (!converged) {
    // 非收敛分支：不做清单核对与失败集合核对（not_evaluated），只判 SUITE_NONCONVERGENCE 与登记面自身错误。
    mark('SUITE_MANIFEST_FILE_DRIFT', '非收敛分支未做清单核对');
    mark('SUITE_MANIFEST_CASE_DROP', '非收敛分支未做清单核对');
    mark('SUITE_FAILURES_UNREGISTERED', '非收敛分支未做失败集合核对');
    mark('EXCEPTION_NOT_OBSERVED', '非收敛分支禁用空观测集合判定（E-2 收口）');
    if (nonconvergenceExceptions.length > 0) {
      trigger('SUITE_NONCONVERGENCE', `全量命令超过 --max-runtime-ms 仍未结束（converged=false）`, { suppressed_by: nonconvergenceExceptions.map((e) => e.id).join(',') });
    } else {
      trigger('SUITE_NONCONVERGENCE', '全量命令超过 --max-runtime-ms 仍未结束（converged=false），无匹配未到期例外');
    }
  } else {
    try {
      const files = parseTap(context.tapText);
      analysis = analyzeFiles(files);
      fileLevelSkip = files.filter((f) => f.fileLevelSkip).length;
      failures = analysis.failures;
      filesExecuted = analysis.observed.size;
      casesExecuted = [...analysis.observed.values()].reduce((a, b) => a + b, 0);
      // 文件整体加载失败：文件级 not ok 且无 file 级 plan
      for (const f of files) {
        if (f.loadFailure || f.plan === null) trigger('SUITE_FILE_LOAD_FAILURE', `文件整体加载/执行失败：${f.name}（无 file 级 plan）`);
      }
      // 清单核对
      if (registry && Array.isArray(registry.manifest?.files) && registry.manifest?.cases) {
        const declared = [...registry.manifest.files].sort();
        const seen = [...analysis.observed.keys()].sort();
        if (JSON.stringify(declared) !== JSON.stringify(seen)) {
          trigger('SUITE_MANIFEST_FILE_DRIFT', `实际执行文件集合 ≠ manifest.files（实际 ${seen.length} / 登记 ${declared.length}）`);
        }
        for (const [file, cases] of analysis.observed.entries()) {
          const baseline = registry.manifest.cases[file];
          if (!Number.isInteger(baseline)) trigger('SUITE_MANIFEST_CASE_DROP', `manifest.cases 缺 ${file} 的基线`);
          else if (cases < baseline) trigger('SUITE_MANIFEST_CASE_DROP', `${file} 实际用例数 ${cases} < 基线 ${baseline}`);
        }
      }
      // 失败集合核对：未到期 suite-failure 例外覆盖的失败不计入本项（容忍在触发条件内）
      const covered = new Set(failureExceptions.map((e) => e.match));
      const uncovered = failures.filter((name) => !covered.has(name));
      if (uncovered.length > 0) trigger('SUITE_FAILURES_UNREGISTERED', `未登记失败：${uncovered.join('、')}`);
      // 陈旧登记（双向匹配）：登记的 suite-failure 例外必须在本次运行中出现
      const stale = failureExceptions.filter((e) => !failures.includes(e.match));
      if (stale.length > 0) trigger('EXCEPTION_NOT_OBSERVED', `例外在本次运行中未出现（陈旧登记）：${stale.map((e) => e.id).join('、')}`);
      // rc 与判定自洽（安全网：rc 非零却无任何触发即报告结构不完整）
      if (exitCode !== 0 && triggers.length === 0) {
        trigger('SUITE_REPORT_UNPARSEABLE', `被测命令退出码 ${exitCode} 但 TAP 未暴露任何失败（结构不完整，禁止静默判绿）`);
      }
    } catch (e) {
      parseError = e instanceof TapError ? e : new TapError(String(e && e.message || e));
      trigger('SUITE_REPORT_UNPARSEABLE', parseError.message);
      mark('SUITE_MANIFEST_FILE_DRIFT', 'TAP 不可解析，清单核对未执行');
      mark('SUITE_MANIFEST_CASE_DROP', 'TAP 不可解析，清单核对未执行');
      mark('SUITE_FAILURES_UNREGISTERED', 'TAP 不可解析，失败集合核对未执行');
      mark('EXCEPTION_NOT_OBSERVED', 'TAP 不可解析，陈旧例外核对未执行');
    }
  }

  const registrySha = raw === null ? null : crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
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
    command: context.command,
    duration_ms: context.durationMs,
    converged,
    exit_code: exitCode,
    files_executed: filesExecuted,
    cases_executed: casesExecuted,
    skipped_file_level: fileLevelSkip,
    failures: failures ?? [],
    checks,
    registry: { sha256: registrySha, exceptions_count: registry && Array.isArray(registry.exceptions) ? registry.exceptions.length : 0 },
    platform: { platform: process.platform, node: process.versions.node },
    verdict,
  };
}

/* ─────────────────────────── --run 执行面 ─────────────────────────── */

function renderCommand(args) {
  return ['node', '--test', '--test-reporter=tap', ...(CONCURRENCY === null ? [] : [`--test-concurrency=${CONCURRENCY}`]), ...args].join(' ');
}

function killTree(child) {
  if (!child || child.pid === undefined) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false }); } catch { /* 已退出 */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
}

async function runSuite() {
  const testRoot = path.join(toolsRoot, 'skills', 'shared', 'crctl', 'scripts', 'test');
  const files = readTestFileSet(toolsRoot); // 展开为空即硬失败
  const abs = files.map((f) => path.join(testRoot, f));
  const tapPath = reportOut ? path.resolve(reportOut) : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-suite-gate-')), 'report.tap');
  const spawnArgs = ['--test', '--test-reporter=tap', ...(CONCURRENCY === null ? [] : [`--test-concurrency=${CONCURRENCY}`]), ...abs];
  const command = renderCommand(abs);
  const started = Date.now();
  const fd = fs.openSync(tapPath, 'w');
  const child = spawn(process.execPath, spawnArgs, { cwd: toolsRoot, shell: false, detached: process.platform !== 'win32' });
  child.stdout.on('data', (chunk) => { fs.writeSync(fd, chunk); });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, maxRuntimeMs);
  const closed = await new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);
  fs.closeSync(fd);
  const durationMs = Date.now() - started;
  const exitCode = timedOut ? null : closed.code;
  const tapText = fs.existsSync(tapPath) ? fs.readFileSync(tapPath, 'utf8') : '';
  return {
    command: timedOut ? `${command} (terminated at max-runtime-ms=${maxRuntimeMs})` : command,
    durationMs,
    converged: !timedOut,
    exitCode,
    tapText,
    tapPath,
    stderr,
  };
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

async function main() {
  const registryPath = path.join(toolsRoot, 'skills', 'shared', 'crctl', 'scripts', 'test', 'gate-registry.json');
  const nowMs = Date.now();
  const { registry, raw } = readRegistry(registryPath);

  let context;
  if (runMode) {
    const r = await runSuite();
    context = { registry, raw, registryPath, command: r.command, durationMs: r.durationMs, converged: r.converged, exitCode: r.exitCode, tapText: r.tapText, nowMs };
  } else {
    const resolved = path.resolve(reportPath);
    if (!fs.existsSync(resolved)) {
      process.stderr.write(`suite-gate: --report 文件不存在：${resolved}\n`);
      process.exit(2);
    }
    const rc = Number(rcArg);
    if (!Number.isInteger(rc)) {
      process.stderr.write('suite-gate: --rc 必须为整数退出码\n');
      process.exit(2);
    }
    context = { registry, raw, registryPath, command: 'report-replay', durationMs: 0, converged: true, exitCode: rc, tapText: fs.readFileSync(resolved, 'utf8'), nowMs };
  }

  const report = judge(context);

  if (jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
    fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  const failedChecks = report.checks.filter((c) => !c.ok);
  // 表注⑦ / 建议④：cmd-01 的 args 不含 --json-out，故 `--run` 必须把报告全字段打到 stdout
  // （test-evidence/cmd-01.log 直接落该 JSON）；stdout 禁词约束（J-8）对 JSON 同样成立。
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(`suite-gate: command=${report.command}\n`);
  process.stdout.write(`suite-gate: duration_ms=${report.duration_ms} converged=${report.converged} exit_code=${report.exit_code}\n`);
  process.stdout.write(`suite-gate: files_executed=${report.files_executed} cases_executed=${report.cases_executed} skipped_file_level=${report.skipped_file_level}\n`);
  process.stdout.write(`suite-gate: failures=${report.failures.length}${report.failures.length > 0 ? ' [' + report.failures.join(' | ') + ']' : ''}\n`);
  process.stdout.write(`suite-gate: registry_sha256=${report.registry.sha256} exceptions_count=${report.registry.exceptions_count}\n`);
  for (const c of failedChecks) {
    process.stdout.write(`suite-gate: check_failed=${c.code} detail=${c.detail}${c.suppressed_by ? ' suppressed_by=' + c.suppressed_by : ''}${c.not_evaluated ? ' not_evaluated=true' : ''}\n`);
  }
  process.stdout.write(`suite-gate: verdict=${report.verdict}\n`);
  process.exit(report.verdict === 'pass' ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`suite-gate: 未捕获错误：${e && e.stack || e}\n`);
  process.exit(2);
});

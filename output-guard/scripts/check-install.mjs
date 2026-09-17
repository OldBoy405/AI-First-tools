#!/usr/bin/env node
// OutputGuard 启动检查（CR-2026-069 TASK-02，SDD §1.4.2 / AC-19③）。
//
// 用法（契约逐字）：
//   node output-guard/scripts/check-install.mjs --tools-root <path>
//
// 只读：只报告缺失 / 损坏与修复动作，**不**自动写入、不改写用户配置、不修复 Runtime。
// 输出（enableOrder 每 Runtime 恰一行）：
//   output-guard runtime=<rt> coverage=<full|partial|unavailable> policy=v1
// 缺失/损坏时另打一行：
//   OUTPUT_GUARD_UNAVAILABLE runtime=<rt> reason=<ADAPTER_MISSING|DISABLED|BUNDLE_INVALID|POLICY_INVALID>
// 退出码：0 = 检查完成（缺失按行报告，不算技术失败）；非零仅供不可判的读失败使用。

import fs from 'node:fs';
import path from 'node:path';

const REASONS = ['ADAPTER_MISSING', 'DISABLED', 'BUNDLE_INVALID', 'POLICY_INVALID'];
const ADAPTER_ENTRIES = {
  pi: ['index.ts'],
  claude: ['pretooluse-guard.mjs', 'posttooluse-guard.mjs'],
  codebuddy: ['pretooluse-guard.mjs', 'posttooluse-guard.mjs'],
  qoder: ['pretooluse-guard.mjs', 'posttooluse-guard.mjs'],
  codex: ['pretooluse-guard.mjs', 'posttooluse-guard.mjs'],
};
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse'];

function die(message) {
  process.stderr.write(JSON.stringify({ error: { code: 'CHECK_INSTALL_UNREADABLE', message } }, null, 2) + '\n');
  process.exit(1);
}

function parseArgv(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out.positional.push(a);
  }
  return out;
}

const flags = parseArgv(process.argv.slice(2));
const toolsRoot = path.resolve(typeof flags['tools-root'] === 'string' ? flags['tools-root'] : '.');
const guardRoot = path.join(toolsRoot, 'output-guard');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').split('\r\n').join('\n'));

let capabilities;
try {
  capabilities = readJson(path.join(guardRoot, 'capabilities.json'));
} catch (e) {
  die('capabilities.json 不可读: ' + e.message);
}
if (!capabilities || !Array.isArray(capabilities.enableOrder) || !capabilities.runtimes) {
  die('capabilities.json 结构不合法（缺 enableOrder / runtimes）');
}

let policyOk = true;
let policyVersion = 'v1';
try {
  const policy = readJson(path.join(guardRoot, 'policy.json'));
  if (typeof policy.policyVersion !== 'string' || !policy.policyVersion) policyOk = false;
  else policyVersion = policy.policyVersion;
} catch {
  policyOk = false;
}

const findings = [];
for (const rt of capabilities.enableOrder) {
  const decl = capabilities.runtimes[rt] || {};
  const adapterDir = path.join(guardRoot, 'adapters', rt);
  const missing = [];
  if (!fs.existsSync(adapterDir) || !fs.statSync(adapterDir).isDirectory()) {
    missing.push('adapter-dir');
  } else {
    for (const name of ADAPTER_ENTRIES[rt] || []) {
      if (!fs.existsSync(path.join(adapterDir, name))) missing.push(name);
    }
    const readme = path.join(adapterDir, 'README.md');
    if (!fs.existsSync(readme)) missing.push('README.md');
    // pi 的安装面是宿主级 extensions[]（由 README 描述），不提供 hook 模板文件。
    if (rt !== 'pi') {
      const template = HOOK_EVENTS.map((ev) => path.join(adapterDir, ev.toLowerCase() + '.json'));
      const hasTemplate = template.some((p) => fs.existsSync(p)) ||
        fs.existsSync(path.join(adapterDir, 'settings.template.json')) ||
        fs.existsSync(path.join(adapterDir, 'hooks.json.template'));
      if (!hasTemplate) missing.push('hook-template');
    }
  }
  let coverage;
  let reason = null;
  if (!policyOk) {
    coverage = 'unavailable';
    reason = 'POLICY_INVALID';
  } else if (missing.length > 0) {
    coverage = 'unavailable';
    reason = missing.indexOf('adapter-dir') >= 0 ? 'ADAPTER_MISSING' : 'BUNDLE_INVALID';
  } else {
    coverage = decl.level === 'partial' ? 'partial' : 'full';
  }
  process.stdout.write('output-guard runtime=' + rt + ' coverage=' + coverage + ' policy=' + policyVersion + '\n');
  if (reason && REASONS.indexOf(reason) >= 0) {
    findings.push('OUTPUT_GUARD_UNAVAILABLE runtime=' + rt + ' reason=' + reason);
  }
  if (missing.length > 0) {
    findings.push('repair: output-guard/adapters/' + rt + ' 缺 ' + missing.join(',') + ' —— 按该目录 README 的模板把 hook 条目并入该 Runtime 的原生配置');
  }
}
if (!policyOk) {
  findings.push('repair: output-guard/policy.json 不可解析或 policyVersion 非法 —— 按该文件重新物化完整 Release');
}
for (const line of findings) process.stdout.write(line + '\n');

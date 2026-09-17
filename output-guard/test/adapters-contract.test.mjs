// Adapter 合同面（CR-2026-069 TASK-02，SDD §3.3 / §6.4）。
// 运行：node --test --test-reporter=dot output-guard/test/adapters-contract.test.mjs
//
// 按目录发现五个 Adapter（capabilities.enableOrder），对每个 Runtime 执行同一组 conformance 向量。
// 未落地的 Adapter 记 ADAPTER_MISSING 并**非零退出**（不得用跳过代替）；本地已有降级时如实报降级。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const TOOLS_ROOT = path.resolve(ROOT, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').split('\r\n').join('\n');

const CAPS = JSON.parse(read('capabilities.json'));
const CONF = JSON.parse(read('conformance.json'));
const POLICY_TEXT = read('policy.json');
const ENTRIES = {
  pi: { pre: 'index.ts', post: 'index.ts' },
  claude: { pre: 'pretooluse-guard.mjs', post: 'posttooluse-guard.mjs' },
  codebuddy: { pre: 'pretooluse-guard.mjs', post: 'posttooluse-guard.mjs' },
  qoder: { pre: 'pretooluse-guard.mjs', post: 'posttooluse-guard.mjs' },
  codex: { pre: 'pretooluse-guard.mjs', post: 'posttooluse-guard.mjs' },
};
const RUNTIMES = CAPS.enableOrder;
const REVIEW_SKILLS = [
  'skills/develop/review-tech-design/SKILL.md',
  'skills/develop/review-code/SKILL.md',
  'skills/develop/review-dev-plan/SKILL.md',
  'skills/requirement/review-requirement/SKILL.md',
];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'og-contract-'));

function patchedPolicyFile(vector) {
  if (!vector.policyPatch) return null;
  const base = JSON.parse(POLICY_TEXT);
  const patch = vector.policyPatch;
  const merged = {
    ...base,
    ...patch,
    thresholds: { ...base.thresholds, ...(patch.thresholds || {}) },
    hints: { ...base.hints, ...(patch.hints || {}) },
    escapeHatch: { ...base.escapeHatch, ...(patch.escapeHatch || {}) },
  };
  const p = path.join(tmpRoot, 'policy-' + vector.id + '.json');
  fs.writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8');
  return p;
}

function entryPath(rt, phase) {
  const name = ENTRIES[rt][phase];
  const p = path.join(ROOT, 'adapters', rt, name);
  return fs.existsSync(p) ? p : null;
}

function prePayload(rt, args) {
  if (rt === 'pi') return { type: 'tool_call', toolName: args.toolName, input: args.toolInput };
  return { hook_event_name: 'PreToolUse', tool_name: args.toolName, tool_input: args.toolInput, tool_use_id: 'call-contract' };
}

function postPayload(rt, args) {
  // 本调用自身的入参（SDD §3.2 的 callCommand/offset）：逃生阀首行与读取窗口起点都在同一 payload 内。
  const toolInput = {};
  if (typeof args.callCommand === 'string') toolInput.command = args.callCommand;
  if (Number.isInteger(args.offset)) toolInput.offset = args.offset;
  // 不补造 Runtime 未提供的字段：向量缺 call-id 时必须原样缺（可保持性检查的可达面）。
  if (rt === 'pi') {
    const payload = {
      type: 'tool_result',
      toolName: args.toolName,
      isError: Boolean(args.isError),
      content: [{ type: 'text', text: args.body }],
      input: toolInput,
    };
    if (args.toolCallId !== undefined) payload.toolCallId = args.toolCallId;
    return payload;
  }
  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: args.toolName,
    tool_input: toolInput,
    tool_response: { content: [{ type: 'text', text: args.body }] },
  };
  if (args.toolCallId !== undefined) payload.tool_use_id = args.toolCallId;
  return payload;
}

/** probe：对回填/裁剪后正文的机械断言，与 conformance.test.mjs 同一口径（无跨文件依赖）。 */
function assertProbe(body, vector, label) {
  const probe = vector.probe;
  if (!probe) return;
  const text = typeof body === 'string' ? body : '';
  if (probe.bodyEquals !== undefined) assert.equal(text, probe.bodyEquals, label + ' probe.bodyEquals 不等');
  if (probe.bodyFirstLinePrefix !== undefined) {
    const first = text.split('\n')[0];
    assert.ok(first.startsWith(probe.bodyFirstLinePrefix), label + ' probe.bodyFirstLinePrefix：首行 ' + JSON.stringify(first));
  }
  for (const s of probe.bodyIncludes || []) assert.ok(text.includes(s), label + ' probe.bodyIncludes 缺 ' + s);
  for (const s of probe.bodyExcludes || []) assert.ok(!text.includes(s), label + ' probe.bodyExcludes 命中 ' + s);
}

function drive(rt, phase, payload, env) {
  const entry = entryPath(rt, phase);
  if (entry === null) return { missing: true };
  const r = spawnSync(process.execPath, [entry], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
  });
  let out = null;
  const stdout = String(r.stdout || '').trim();
  if (stdout) {
    try {
      out = JSON.parse(stdout);
    } catch {
      out = { __unparsable: stdout.slice(0, 200) };
    }
  }
  return { missing: false, status: r.status, out, stderr: String(r.stderr || '') };
}

function preAction(rt, out) {
  if (out === null) return 'passthrough';
  if (rt === 'pi') return out.block ? 'block' : out.input ? 'rewrite' : 'passthrough';
  const h = out.hookSpecificOutput || {};
  if (h.permissionDecision === 'deny') return 'block';
  if (h.permissionDecision === 'allow' && (h.updatedInput || h.modifiedInput)) return 'rewrite';
  return 'passthrough';
}

/** Post 面：返回被回填的正文（未回填则 null）。 */
function postText(rt, out) {
  if (out === null) return null;
  if (rt === 'pi') {
    if (!Array.isArray(out.content)) return null;
    return out.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  }
  if (typeof out.reason === 'string' && out.decision === 'block') return out.reason;
  const h = out.hookSpecificOutput || {};
  if (!h.updatedToolOutput) return null;
  const r = h.updatedToolOutput;
  if (Array.isArray(r.content)) return r.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  if (typeof r === 'string') return r;
  return String(r.stdout === undefined ? JSON.stringify(r) : r.stdout);
}

const preVectors = CONF.vectors.filter((v) => v.input.op === 'parseCall');
const postVectors = CONF.vectors.filter((v) => v.input.op === 'evaluateResult');

test('ac-01 五个 Runtime 的 Adapter 入口全部落地（缺失记 ADAPTER_MISSING 并非零退出）', () => {
  const missing = [];
  for (const rt of RUNTIMES) {
    for (const phase of ['pre', 'post']) if (entryPath(rt, phase) === null) missing.push(rt + '/' + phase);
    const dir = path.join(ROOT, 'adapters', rt);
    if (!fs.existsSync(path.join(dir, 'README.md'))) missing.push(rt + '/README.md');
  }
  assert.deepEqual(missing, [], 'ADAPTER_MISSING: ' + missing.join(', '));
});

test('ac-02 逐 Runtime 执行同一组 Pre 向量（逃生阀 / 命令族 / 不确定分支）', () => {
  for (const rt of RUNTIMES) {
    for (const v of preVectors) {
      const env = patchedPolicyFile(v) ? { OUTPUT_GUARD_POLICY_PATH: patchedPolicyFile(v) } : undefined;
      const res = drive(rt, 'pre', prePayload(rt, v.input.args), env);
      assert.ok(!res.missing, rt + ' Pre 入口缺失');
      assert.equal(res.status, 0, rt + ' ' + v.id + ' 退出码非零: ' + res.stderr);
      assert.equal(preAction(rt, res.out), v.expect.action, rt + ' ' + v.id + ' Pre 语义不等');
    }
  }
});

test('ac-03 逐 Runtime 执行同一组 Post 向量（裁剪、无回填与不可保持降级）', () => {
  for (const rt of RUNTIMES) {
    for (const v of postVectors) {
      const env = patchedPolicyFile(v) ? { OUTPUT_GUARD_POLICY_PATH: patchedPolicyFile(v) } : undefined;
      const res = drive(rt, 'post', postPayload(rt, v.input.args), env);
      assert.ok(!res.missing, rt + ' Post 入口缺失');
      assert.equal(res.status, 0, rt + ' ' + v.id + ' 退出码非零: ' + res.stderr);
      const text = postText(rt, res.out);
      if (v.adapterExpect && v.adapterExpect.patch === false) {
        // B-1：逃生阀在 Post 面 ⇒ 本调用既无 updatedToolOutput / patch，也无 trailer
        assert.equal(text, null, rt + ' ' + v.id + ' Post 面必须无回填，实际: ' + JSON.stringify(res.out));
        assert.ok(!String(res.stdout || '').includes('complete='), rt + ' ' + v.id + ' 无回填结果不得出现 trailer');
        continue;
      }
      assert.notEqual(text, null, rt + ' ' + v.id + ' 未回填结果');
      if (v.expect.action === 'truncate') {
        assert.ok(text.includes('complete=false'), rt + ' ' + v.id + ' 裁剪结果缺 complete=false trailer');
        assert.ok(text.includes('action=truncate'), rt + ' ' + v.id + ' 裁剪结果缺 action=truncate');
      } else {
        assert.ok(text.includes('coverage=unavailable'), rt + ' ' + v.id + ' 不可保持路径缺 coverage 标记');
        assert.ok(text.includes(v.input.args.body), rt + ' ' + v.id + ' 不可保持路径必须逐字保留原正文');
      }
      assertProbe(text, v, rt + ' ' + v.id);
    }
  }
});

test('ac-04 幂等：同一结果连续两次经 Adapter 得到逐字相同的回填', () => {
  const v = CONF.vectors.find((x) => x.kind === 'idempotence');
  for (const rt of RUNTIMES) {
    const env = { OUTPUT_GUARD_POLICY_PATH: patchedPolicyFile(v) };
    const a = postText(rt, drive(rt, 'post', postPayload(rt, v.input.args.result), env).out);
    const b = postText(rt, drive(rt, 'post', postPayload(rt, v.input.args.result), env).out);
    assert.equal(a, b, rt + ' 幂等面不等');
  }
});

test('ac-05 AC-6 四条负向：逃生阀不产生 deny，不影响既有安全控制面', () => {
  const negs = CONF.vectors.filter((v) => /^neg-/.test(v.id));
  assert.equal(negs.length, 4);
  for (const rt of RUNTIMES) {
    for (const v of negs) {
      const res = drive(rt, 'pre', prePayload(rt, v.input.args));
      assert.equal(res.status, 0, rt + ' ' + v.id + ' 退出码非零');
      assert.equal(preAction(rt, res.out), 'passthrough', rt + ' ' + v.id + ' 逃生阀不得产生 deny/rewrite');
      assert.ok(!JSON.stringify(res.out).includes('deny'), rt + ' ' + v.id + ' 输出出现 deny');
    }
    const src = ['pretooluse-guard.mjs', 'posttooluse-guard.mjs', 'index.ts']
      .map((f) => path.join(ROOT, 'adapters', rt, f))
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n'))
      .join('\n');
    for (const forbidden of ['rules.json', 'protectedPaths', 'approval.yml', '_backlog.yml', 'review-annotations', 'writeFileSync']) {
      assert.ok(!src.includes(forbidden), rt + ' Adapter 触达安全控制面/写路径: ' + forbidden);
    }
  }
});

test('ac-06 POLICY_INVALID：policy 不可解析 ⇒ 无决策 + stderr 一行，不误伤调用', () => {
  const broken = path.join(tmpRoot, 'policy-broken.json');
  fs.writeFileSync(broken, '{ this is not json', 'utf8');
  for (const rt of RUNTIMES) {
    const res = drive(rt, 'pre', prePayload(rt, { toolName: 'bash', toolInput: { command: 'grep -rn x .' } }), { OUTPUT_GUARD_POLICY_PATH: broken });
    assert.equal(res.status, 0, rt + ' 降级路径不得以非零退出中断调用');
    assert.equal(res.out, null, rt + ' 降级路径必须输出“无决策”');
    assert.ok(res.stderr.includes('OUTPUT_GUARD_UNAVAILABLE runtime=' + rt + ' reason=POLICY_INVALID'), rt + ' 降级行缺失: ' + res.stderr);
  }
});

test('ac-07 AC-16 端到端：complete=false 结果必须带可执行取样指令，且四个 review Skill 已采纳', () => {
  const v = postVectors.find((x) => x.expect.action === 'truncate');
  const env = { OUTPUT_GUARD_POLICY_PATH: patchedPolicyFile(v) };
  for (const rt of RUNTIMES) {
    const text = postText(rt, drive(rt, 'post', postPayload(rt, v.input.args), env).out);
    assert.ok(text.includes("output-guard: full reason="), rt + ' trailer 必须给出逃生阀指令（可执行取样路径）');
  }
  for (const rel of REVIEW_SKILLS) {
    const p = path.join(TOOLS_ROOT, rel);
    assert.ok(fs.existsSync(p), '缺 ' + rel);
    const t = fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
    assert.ok(t.includes('complete=false'), rel + ' 缺 complete=false 取证完整性条款');
    assert.ok(t.includes('--detail'), rel + ' 缺 --detail 采纳');
  }
});

test('ac-08 check-install 逐 Runtime 恰一行稳定读数，且与 capabilities 声明一致', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-install.mjs'), '--tools-root', TOOLS_ROOT], {
    encoding: 'utf8',
    cwd: TOOLS_ROOT,
  });
  assert.equal(r.status, 0, 'check-install 非零退出: ' + String(r.stderr || '').slice(0, 300));
  const lines = String(r.stdout || '').split('\r\n').join('\n').split('\n').filter(Boolean);
  for (const rt of RUNTIMES) {
    const hits = lines.filter((l) => {
      const tk = l.trim().split(' ');
      return tk.length === 4 && tk[1] === 'runtime=' + rt && tk[3] === 'policy=v1';
    });
    assert.equal(hits.length, 1, rt + ' 读数行数不为 1');
    const level = CAPS.runtimes[rt].level;
    const expect = level === 'partial' ? 'partial' : 'full';
    assert.equal(hits[0], 'output-guard runtime=' + rt + ' coverage=' + expect + ' policy=v1');
  }
});

test('ac-09 AC-4/B-4：capabilities.paths 与安装面 matcher 双向一致（full ⊆ matcher，matcher ⊆ 已声明路径）', () => {
  const TEMPLATE = {
    claude: 'settings.template.json',
    codebuddy: 'settings.template.json',
    qoder: 'settings.template.json',
    codex: 'hooks.json.template',
  };
  for (const rt of RUNTIMES) {
    const paths = Array.isArray(CAPS.runtimes[rt].paths) ? CAPS.runtimes[rt].paths : [];
    const full = paths.filter((p) => p.coverage === 'full').map((p) => p.id);
    const declared = paths.filter((p) => p.uncovered !== true).map((p) => p.id);
    if (rt === 'pi') {
      // Pi 的安装面是扩展入口（tool_call / tool_result 事件面，全工具可见），不受 matcher 约束；
      // 入口存在性由 ac-01 断言，此处只钉住其 full 路径非空（防静默清空声明）。
      assert.ok(full.length > 0, 'pi 声明了 0 条 full 路径');
      assert.ok(entryPath(rt, 'post') !== null, 'pi 缺 tool_result 入口（声明无从落地）');
      continue;
    }
    const file = path.join(ROOT, 'adapters', rt, TEMPLATE[rt]);
    assert.ok(fs.existsSync(file), rt + ' 缺安装模板 ' + TEMPLATE[rt]);
    const tpl = fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
    const matchers = [...tpl.matchAll(/"matcher":\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.equal(matchers.length, 2, rt + ' 模板 matcher 条目数 = ' + matchers.length + '（期望 Pre/Post 各一）');
    const tokens = new Set();
    for (const m of matchers) for (const tok of m.split('|')) if (tok.trim()) tokens.add(tok.trim());
    for (const id of full) {
      assert.ok(tokens.has(id), rt + ' 安装面 matcher 未覆盖 full 路径 ' + id + '（matcher=' + matchers.join(' ; ') + '）');
    }
    for (const id of declared) {
      assert.ok(tokens.has(id), rt + ' 安装面 matcher 未覆盖已声明（非 uncovered）路径 ' + id);
    }
    for (const tok of tokens) {
      assert.ok(paths.some((p) => p.id === tok), rt + ' matcher 覆盖了未在 capabilities.paths 声明的工具名 ' + tok);
    }
  }
});


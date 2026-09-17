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
  // 不补造 Runtime 未提供的字段：向量缺 call-id 时必须原样缺（可保持性检查的可达面）。
  if (rt === 'pi') {
    const payload = {
      type: 'tool_result',
      toolName: args.toolName,
      isError: Boolean(args.isError),
      content: [{ type: 'text', text: args.body }],
    };
    if (args.toolCallId !== undefined) payload.toolCallId = args.toolCallId;
    return payload;
  }
  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: args.toolName,
    tool_input: {},
    tool_response: { content: [{ type: 'text', text: args.body }] },
  };
  if (args.toolCallId !== undefined) payload.tool_use_id = args.toolCallId;
  return payload;
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

test('ac-03 逐 Runtime 执行同一组 Post 向量（裁剪与不可保持降级）', () => {
  for (const rt of RUNTIMES) {
    for (const v of postVectors) {
      const env = patchedPolicyFile(v) ? { OUTPUT_GUARD_POLICY_PATH: patchedPolicyFile(v) } : undefined;
      const res = drive(rt, 'post', postPayload(rt, v.input.args), env);
      assert.ok(!res.missing, rt + ' Post 入口缺失');
      assert.equal(res.status, 0, rt + ' ' + v.id + ' 退出码非零: ' + res.stderr);
      const text = postText(rt, res.out);
      assert.notEqual(text, null, rt + ' ' + v.id + ' 未回填结果');
      if (v.expect.action === 'truncate') {
        assert.ok(text.includes('complete=false'), rt + ' ' + v.id + ' 裁剪结果缺 complete=false trailer');
        assert.ok(text.includes('action=truncate'), rt + ' ' + v.id + ' 裁剪结果缺 action=truncate');
      } else {
        assert.ok(text.includes('coverage=unavailable'), rt + ' ' + v.id + ' 不可保持路径缺 coverage 标记');
        assert.ok(text.includes(v.input.args.body), rt + ' ' + v.id + ' 不可保持路径必须逐字保留原正文');
      }
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

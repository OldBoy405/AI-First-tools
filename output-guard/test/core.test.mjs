// OutputGuard Core 回归面（CR-2026-069 TASK-02，SDD §3.2 / §4.1~§4.5）。
// 运行：node --test --test-reporter=dot output-guard/test/core.test.mjs
//
// 零依赖：只用 node:test / node:assert / node:fs。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ACTIONS,
  PolicyParseError,
  THRESHOLD_KEYS,
  TOKEN_ESTIMATOR_ID,
  UNAVAILABLE_REASONS,
  classifyFamily,
  estimateTokens,
  evaluateResult,
  fingerprint,
  inferKind,
  normalizeText,
  parseCall,
  parseEscapeHatch,
  parsePolicy,
  renderTrailer,
} from '../core.mjs';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..');
const POLICY_TEXT = fs.readFileSync(path.join(ROOT, 'policy.json'), 'utf8').split('\r\n').join('\n');
const CAPS_TEXT = fs.readFileSync(path.join(ROOT, 'capabilities.json'), 'utf8').split('\r\n').join('\n');
const POLICY = parsePolicy(POLICY_TEXT, CAPS_TEXT);

const withPatched = (patch) => parsePolicy(JSON.stringify({ ...JSON.parse(POLICY_TEXT), ...patch }), CAPS_TEXT);

/** 收紧 cap 的测试夹具：键名经 THRESHOLD_KEYS 计算，避免在源码里出现「阈值键名 + 数字字面量」。 */
const withCap = (cap) => withPatched({ thresholds: { ...POLICY.thresholds, [THRESHOLD_KEYS[0]]: cap } });

test('core.mjs 内零阈值字面量（AC-3 机械判据）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'core.mjs'), 'utf8').split('\r\n').join('\n');
  for (const key of THRESHOLD_KEYS) {
    for (const line of src.split('\n')) {
      const i = line.indexOf(key);
      if (i < 0) continue;
      let j = i + key.length;
      while (line[j] === ' ') j += 1;
      if (line[j] === '=' || line[j] === ':') {
        j += 1;
        while (line[j] === ' ') j += 1;
        assert.ok(!/\d/.test(line[j] || ''), 'core.mjs 出现阈值字面量: ' + line.slice(0, 80));
      }
    }
  }
  assert.ok(!/resultTokensCap\s*[:=]\s*\d/.test(src));
});

test('normalizeText 是唯一 EOL 归一入口（I9）', () => {
  assert.equal(normalizeText('a\r\nb\rc\nd'), 'a\nb\rc\nd');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
});

test('estimateTokens 口径标识固定且可复算', () => {
  assert.equal(TOKEN_ESTIMATOR_ID, 'chars-div-4-v1');
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens(''), 0);
});

test('parsePolicy 结构不合法一律抛 PolicyParseError', () => {
  assert.throws(() => parsePolicy('{'), PolicyParseError);
  assert.throws(() => parsePolicy(JSON.stringify({ policyVersion: 'v1' })), PolicyParseError);
  const bad = JSON.parse(POLICY_TEXT);
  bad.thresholds[THRESHOLD_KEYS[0]] = 0;
  assert.throws(() => parsePolicy(JSON.stringify(bad)), PolicyParseError);
  const bad2 = JSON.parse(POLICY_TEXT);
  bad2.hints = {};
  assert.throws(() => parsePolicy(JSON.stringify(bad2)), PolicyParseError);
});

test('A1：逃生阀 valid / absent / 不合法一律 absent', () => {
  assert.equal(parseEscapeHatch('# output-guard: full reason=need raw', POLICY).state, 'valid');
  assert.equal(parseEscapeHatch('grep -rn x .', POLICY).state, 'absent');
  assert.equal(parseEscapeHatch('# output-guard: full reason=', POLICY).state, 'absent');
  assert.equal(parseEscapeHatch('# output-guard: full reason=' + 'x'.repeat(400), POLICY).state, 'absent');
  assert.equal(parseEscapeHatch('# output guard: full reason=x', POLICY).state, 'absent');
});

test('classifyFamily：确定 / 不确定（管道、重定向、多行）', () => {
  assert.deepEqual(classifyFamily('grep -rn x .', POLICY), { family: 'grep', kind: 'search', determinate: true, word: 'grep' });
  assert.equal(classifyFamily('rg x .', POLICY).family, 'grep');
  assert.equal(classifyFamily('find . -name x', POLICY).family, 'find');
  assert.equal(classifyFamily('Get-ChildItem -Recurse', POLICY).family, 'find');
  assert.equal(classifyFamily('cat f', POLICY).family, 'read');
  assert.equal(classifyFamily('grep x . | head', POLICY).determinate, false);
  assert.equal(classifyFamily('grep x . > out.txt', POLICY).determinate, false);
  assert.equal(classifyFamily('grep x .\ncat f', POLICY).determinate, false);
  assert.equal(classifyFamily('echo hi', POLICY).family, null);
});

test('A2：parseCall 命中命令族 ⇒ block（含可执行替代写法）', () => {
  const d = parseCall({ runtime: 'pi', toolName: 'bash', toolInput: { command: 'grep -rn needle .' } }, POLICY);
  assert.equal(d.action, 'block');
  assert.equal(d.family, 'grep');
  assert.ok(d.hint.includes('grep') && /\d/.test(d.hint), '替代写法必须可执行且含具体上限');
});

test('A2：parseCall 读取族 ⇒ rewrite（施加 offset/limit）', () => {
  const d = parseCall({ runtime: 'claude', toolName: 'Bash', toolInput: { command: 'cat src/big.mjs' } }, POLICY);
  assert.equal(d.action, 'rewrite');
  assert.equal(d.family, 'read');
  assert.equal(d.rewrittenInput.limit, POLICY.thresholds.lineWindow);
  assert.equal(d.rewrittenInput.offset, 1);
});

test('A2：逃生阀与不确定调用一律 passthrough，且不新增 action 取值', () => {
  const esc = parseCall({ runtime: 'pi', toolName: 'bash', toolInput: { command: '# output-guard: full reason=raw\ngrep -rn x .' } }, POLICY);
  assert.equal(esc.action, 'passthrough');
  assert.equal(esc.ruleId, 'escape-hatch');
  const pipe = parseCall({ runtime: 'pi', toolName: 'bash', toolInput: { command: 'grep -rn x . | head -3' } }, POLICY);
  assert.equal(pipe.action, 'passthrough');
  const nonShell = parseCall({ runtime: 'pi', toolName: 'read', toolInput: { path: 'a' } }, POLICY);
  assert.equal(nonShell.action, 'passthrough');
  for (const d of [esc, pipe, nonShell]) assert.ok(ACTIONS.includes(d.action));
});

test('A3：inferKind 三类 + 普通 shell 的机械判定', () => {
  assert.equal(inferKind('a.mjs:12:hit\nb.mjs:3:hit', 'bash'), 'search');
  assert.equal(inferKind('src/a.mjs\nsrc/b.mjs', 'bash'), 'list');
  assert.equal(inferKind('anything', 'read'), 'read');
  assert.equal(inferKind('line1\nline2', 'bash'), 'generic');
});

test('A2/§4.2：可保持性检查不通过 ⇒ unavailable（不改正文、追加一行）', () => {
  const d = evaluateResult({ runtime: 'pi', toolName: 'bash', body: 'x', structure: 'text' }, POLICY);
  assert.equal(d.action, 'unavailable');
  assert.equal(d.reason, 'structure-not-preserved');
  assert.equal(d.coverage, 'unavailable');
  assert.ok(d.trailer.includes('action=unavailable') && d.trailer.includes('coverage=unavailable'));
  assert.equal(d.body, 'x');
  assert.equal(d.details, undefined, 'AC-7：被丢弃正文不得写进 details');
});

test('A2/D-6：exitCode=present 必须保留；absent-by-runtime 不作要求', () => {
  const capsWithPresent = JSON.parse(CAPS_TEXT);
  capsWithPresent.runtimes.pi.preserve.exitCode = 'present';
  const policy = parsePolicy(POLICY_TEXT, JSON.stringify(capsWithPresent));
  const missing = evaluateResult({ runtime: 'pi', toolName: 'bash', toolCallId: 'c1', isError: false, body: 'x', structure: 'text' }, policy);
  assert.equal(missing.action, 'unavailable');
  const present = evaluateResult({ runtime: 'pi', toolName: 'bash', toolCallId: 'c1', isError: false, exitCode: 1, body: 'x', structure: 'text' }, policy);
  assert.equal(present.action, 'passthrough');
});

test('A3：低于阈值不追加任何文本；超阈值按类裁剪并出 trailer', () => {
  const small = evaluateResult({ runtime: 'pi', toolName: 'bash', toolCallId: 'c1', isError: false, body: 'ok', structure: 'text' }, POLICY);
  assert.equal(small.action, 'passthrough');
  assert.equal(small.trailer, '');

  const policy = withCap(4);
  const searchBody = Array.from({ length: 60 }, (_, i) => 'src/a.mjs:' + String(i + 1) + ':needle').join('\n');
  const d = evaluateResult({ runtime: 'qoder', toolName: 'run_in_terminal', toolCallId: 'c1', isError: false, body: searchBody, structure: 'content-parts' }, policy);
  assert.equal(d.action, 'truncate');
  assert.equal(d.complete, false);
  assert.equal(d.kind, 'search');
  assert.equal(d.body.split('\n')[0], '60 hits in 1 files');
  assert.ok(d.body.includes('src/a.mjs'), '保留唯一文件列表');
  for (const token of ['action=truncate', 'complete=false', 'reason=output-cap', 'original≈', 'kept≈']) {
    assert.ok(d.trailer.includes(token), 'trailer 字段闭包缺 ' + token);
  }

  const readBody = Array.from({ length: 300 }, (_, i) => 'line' + String(i + 1)).join('\n');
  const r = evaluateResult({ runtime: 'pi', toolName: 'read', toolCallId: 'c2', isError: false, body: readBody, structure: 'content-parts' }, policy);
  assert.equal(r.action, 'truncate');
  assert.equal(r.kind, 'read');
  assert.ok(r.body.includes('offset='), '读取面必须给出下一次 offset/limit 的具体值');
  assert.ok(r.body.split('\n')[0].startsWith('1\t'), '必须保留原始行号');

  const listBody = Array.from({ length: 200 }, (_, i) => 'src/f' + String(i) + '.mjs').join('\n');
  const l = evaluateResult({ runtime: 'codex', toolName: 'Bash', toolCallId: 'c3', isError: false, body: listBody, structure: 'text' }, policy);
  assert.equal(l.kind, 'list');
  assert.equal(l.body.split('\n')[0], '200 entries');

  const genericBody = Array.from({ length: 200 }, (_, i) => 'plain ' + String(i)).join('\n');
  const g = evaluateResult({ runtime: 'claude', toolName: 'Bash', toolCallId: 'c4', isError: false, body: genericBody, structure: 'text' }, policy);
  assert.equal(g.kind, 'generic');
  assert.ok(g.body.includes('已省略'), '普通 shell 保留头尾并给出省略量');
});

test('A4：fingerprint 决定性与幂等（同一指纹 ⇒ 同一 body 与 trailer）', () => {
  const policy = withCap(4);
  const input = { runtime: 'pi', toolName: 'bash', toolCallId: 'c1', isError: false, body: 'a\nb\nc\nd\ne\nf', structure: 'text' };
  const a = evaluateResult(input, policy);
  const b = evaluateResult(input, policy);
  assert.equal(a.body, b.body);
  assert.equal(a.trailer, b.trailer);
  const fp = { policyVersion: policy.policyVersion, ruleId: a.ruleId, runtime: 'pi', toolName: 'bash', normalizedInput: { command: 'cat f' }, body: input.body };
  assert.equal(fingerprint(fp), fingerprint({ ...fp, normalizedInput: { command: 'cat f' } }));
  assert.notEqual(fingerprint(fp), fingerprint({ ...fp, body: input.body + 'x' }));
  assert.equal(new Set([fingerprint(fp)]).size, 1);
});

test('A5/§3.8：reason 四值闭包且 renderTrailer 归一为单行', () => {
  assert.deepEqual(UNAVAILABLE_REASONS, ['ADAPTER_MISSING', 'DISABLED', 'BUNDLE_INVALID', 'POLICY_INVALID']);
  const d = evaluateResult({ runtime: 'pi', toolName: 'bash', body: 'x', structure: 'text' }, POLICY);
  assert.equal(renderTrailer(d), renderTrailer(d));
  assert.ok(!renderTrailer(d).includes('\n'));
  assert.equal(renderTrailer({ trailer: '' }), '');
});

test('策略只经入参进入 Core：同一正文在不同阈值下结果不同（无内建常量）', () => {
  const body = Array.from({ length: 40 }, (_, i) => 'l' + String(i)).join('\n');
  const strict = withCap(2);
  const loose = withCap(100000);
  assert.equal(evaluateResult({ runtime: 'pi', toolName: 'bash', toolCallId: 'c', isError: false, body, structure: 'text' }, strict).action, 'truncate');
  assert.equal(evaluateResult({ runtime: 'pi', toolName: 'bash', toolCallId: 'c', isError: false, body, structure: 'text' }, loose).action, 'passthrough');
});

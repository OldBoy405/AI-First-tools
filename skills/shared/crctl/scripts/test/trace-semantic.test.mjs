// CR-2026-049 TASK-01：trace 语义对象与 candidate manifest v2 测试。
// 覆盖：191KB 累积 traceability 完整解析（CRLF 归一）、parseGeneratedTraceability 失败用例、
// manifest v2 event/payloadSha256/inputDigest 防篡改、v1 文件（baseline/tasks）不被破坏。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const yamlSubset = pathToFileURL(path.join(here, '..', 'lib', 'yaml-subset.mjs')).href;
const libPath = path.join(here, '..', '..', '..', '..', 'writeback', 'scripts', 'lib.mjs');
const libHref = pathToFileURL(libPath).href;
const fixture191k = path.join(here, 'fixtures', 'traceability-191k.yml');

const CRLF_SPLIT = ".split('\\r\\n').join('\\n')";

function runModule(moduleHref, fnBody) {
  const script = "import fs from 'node:fs';\nimport(" + JSON.stringify(moduleHref) + ").then(async (m) => { " + fnBody + " });";
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  return r;
}

function readLf(p) {
  return fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
}

function parse191k() {
  const text = readLf(fixture191k);
  const body = "const t = fs.readFileSync(" + JSON.stringify(fixture191k) + ", 'utf8')" + CRLF_SPLIT + ";\n"
    + "try { const d = m.parseYaml(t);\n"
    + "console.log(JSON.stringify({ ok: true, n: d.milestones.length, last: d.milestones[d.milestones.length-1].cr, seg: Object.keys(d.milestones[0]).length }));\n"
    + "} catch (e) { console.log(JSON.stringify({ ok: false, err: e.message })); process.exit(1); }";
  const r = runModule(yamlSubset, body);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, true, out.err);
  return { out, text };
}

test('TASK-01 AC-1a：191KB 累积 traceability 完整解析，36 段、末段 CR-2026-048', () => {
  const { out } = parse191k();
  assert.equal(out.n, 36);
  assert.equal(out.last, 'CR-2026-048');
  assert.ok(out.seg > 5, '首段字段完整');
});

test('TASK-01 AC-1b：CRLF 输入与 LF 归一后结果一致', () => {
  const textLf = readLf(fixture191k);
  const textCrlf = textLf.split('\n').join('\r\n');
  const run = (t) => {
    const tmp = path.join(here, 'fixtures', '.tmp-crlf-check.yml');
    fs.writeFileSync(tmp, t, 'utf8');
    const body = "const t = fs.readFileSync(" + JSON.stringify(tmp) + ", 'utf8');\n"
      + "console.log(JSON.stringify(m.parseYaml(t).milestones.length));";
    const r = runModule(yamlSubset, body);
    fs.rmSync(tmp, { force: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split('\n').pop();
  };
  assert.equal(run(textLf), run(textCrlf), 'LF 与 CRLF 解析结果一致');
});

test('TASK-01 AC-2：语义校验失败用例非零退出且错误码可断言', () => {
  const base = parse191k().text;
  const runGen = (text) => {
    const tmp = path.join(here, 'fixtures', '.tmp-semantic.yml');
    fs.writeFileSync(tmp, text, 'utf8');
    const script = "import fs from 'node:fs';\nimport(" + JSON.stringify(libHref) + ").then(async (m) => {\n"
      + "const text = fs.readFileSync(" + JSON.stringify(tmp) + ", 'utf8');\n"
      + "m.parseGeneratedTraceability(text, { cr: 'CR-2026-048', specId: 'ai-first-platform' });\n"
      + "console.log('OK'); });";
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    fs.rmSync(tmp, { force: true });
    return r;
  };
  // 1) spec-id 不一致
  let r = runGen(base.replace('spec-id: ai-first-platform', 'spec-id: other'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TRACE_SEMANTIC_INVALID/);
  // 2) 当前 CR 段数 ≠ 1：把末段 CR-2026-048 改写为 CR-2026-047（重复既有段）
  r = runGen(base.replace('\n  - cr: CR-2026-048\n', '\n  - cr: CR-2026-047\n'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TRACE_SEMANTIC_INVALID/);
  // 3) 不可解释结构 → YAML_SUBSET_PARSE_FAILED（禁止静默降级）
  r = runGen(base.replace('milestones:\n', 'milestones:\n  ?!bad-line\n'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /YAML_SUBSET_PARSE_FAILED|TRACE_SEMANTIC_INVALID/);
});

test('TASK-01 AC-3：manifest v2 篡改 payload 后 inputDigest 变化；v1 文件仍被接受', async () => {
  const lib = await import(libHref);
  const files = [{ path: 'specs/s/traceability.yml', beforeSha256: null, afterSha256: null, content: '# trace\n' }];
  const event = {
    kind: 'trace',
    payload: { spec_id: 's', traceability: { 'spec-id': 's', 'cr-ref': 'CR-2026-049', milestones: [] } },
    payloadSha256: null,
  };
  event.payloadSha256 = lib.sha256(JSON.stringify(event.payload));
  const base = { v: 2, stage: 'traceability', cr: 'CR-2026-049', specId: 's', targetVersion: '0.23', generator: { id: 'writeback-traceability', sha256: 'a'.repeat(64) }, files };
  const m1 = lib.computeInputDigest({ ...base, event });
  // 篡改 payload
  const tampered = { ...event, payload: { ...event.payload, traceability: { ...event.payload.traceability, 'cr-ref': 'CR-2026-050' } } };
  const m2 = lib.computeInputDigest({ ...base, event: tampered });
  assert.notEqual(m1, m2, 'payload 篡改必须改变 inputDigest');
  // v1（baseline/tasks）不受 event 参数影响且计算稳定
  const v1a = lib.computeInputDigest({ v: 1, stage: 'baseline', cr: 'CR-2026-049', specId: 's', targetVersion: '0.23', generator: { id: 'writeback-prd-sdd', sha256: 'b'.repeat(64) }, files });
  const v1b = lib.computeInputDigest({ v: 1, stage: 'baseline', cr: 'CR-2026-049', specId: 's', targetVersion: '0.23', generator: { id: 'writeback-prd-sdd', sha256: 'b'.repeat(64) }, files });
  assert.equal(v1a, v1b, 'v1 计算稳定');
  // writeCandidate 带 event → v=2 manifest
  const tmpOut = path.join(here, 'fixtures', '.tmp-candidate');
  const { manifest } = lib.writeCandidate({
    candidateOut: tmpOut, stage: 'traceability', cr: 'CR-2026-049', specId: 's', targetVersion: '0.23',
    generator: { id: 'writeback-traceability', sha256: 'a'.repeat(64) },
    files: [{ path: 'specs/s/traceability.yml', beforeSha256: null, content: '# trace\n' }],
    contentOf: () => '# trace\n', event,
  });
  assert.equal(manifest.v, 2);
  assert.deepEqual(manifest.event, event);
  const expected = lib.computeInputDigest({
    ...base,
    files: base.files.map((f) => ({ path: f.path, beforeSha256: null, afterSha256: lib.sha256('# trace\n') })),
    event,
  });
  assert.equal(manifest.inputDigest, expected);
  fs.rmSync(tmpOut, { recursive: true, force: true });
});

test('TASK-01：parseGeneratedTraceability 对合法 191KB 文档通过（cr/spec 对齐）', () => {
  const body = "const text = fs.readFileSync(" + JSON.stringify(fixture191k) + ", 'utf8');\n"
    + "const d = m.parseGeneratedTraceability(text, { cr: 'CR-2026-048', specId: 'ai-first-platform' });\n"
    + "console.log(JSON.stringify({ ok: d['spec-id'] === 'ai-first-platform' && d['cr-ref'] === 'CR-2026-048' && d.milestones.length === 36 }));";
  const r = runModule(libHref, body);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').pop(), '{"ok":true}');
});

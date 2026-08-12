// CR-2026-031 TASK-08：candidate writeback 集成测试。
// merge 完成后在 detached Transaction Workspace 跑 generator（candidate-only）→ crctl writeback-apply：
// manifest 校验矩阵（AC-1 全 hard fail 零写入）、happy path（AC-2 精确 staged + trailer）、
// rebuild（AC-3 新 origin 基线重生成）、history rewrite 硬阻断、fault 续跑不重复 commit。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, runCrctl, sha256, makeCodeApprovedFixture, originMasterCount } from './merge-fixture.mjs';
import { writebackInputDigest } from '../lib/workspace-transactions.mjs';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WB_SCRIPTS = path.resolve(SCRIPTS, '..', '..', '..', '..', 'skills', 'writeback', 'scripts');
const PRD_SDD = path.join(WB_SCRIPTS, 'writeback-prd-sdd.mjs');
const TRACE = path.join(WB_SCRIPTS, 'writeback-traceability.mjs');

function runScript(script, cwd, args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: parse(r.stdout), errJson: parse(r.stderr) };
}

/** merge 完成 → 返回 {base, kb, cr, txws}。 */
function makeMergedFixture() {
  const f = makeCodeApprovedFixture();
  const { base, kb, cr } = f;
  const r = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.phase, 'complete', JSON.stringify(r.json || r.errJson));
  const txws = r.json.operationalWorkspace;
  assert.ok(fs.existsSync(txws));
  return { base, kb, cr, txws };
}

/** 在 txws 跑 prd-sdd generator 生成 baseline candidate；返回 manifest 路径与 candidate 目录。 */
function makeBaselineCandidate(txws, cr, tag) {
  const out = path.join(txws, `.cand-${tag}`);
  fs.mkdirSync(out, { recursive: true });
  const r = runScript(PRD_SDD, txws, ['--workspace', txws, '--cr', cr, '--spec', 'test-spec', '--version', '0.2', '--candidate-out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.noop, false, '不应 noop');
  return path.join(out, 'manifest.json');
}

test('TASK-08 AC-2：happy path — baseline candidate 应用 → 精确 staged + trailer + 幂等重放', () => {
  const { base, kb, cr, txws } = makeMergedFixture();
  try {
    const manifest = makeBaselineCandidate(txws, cr, 'h');
    const r = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--candidate', manifest, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.phase, 'complete');
    assert.match(r.json.txId, /^[0-9a-f]{32}$/);
    assert.equal(r.json.changed, true);
    assert.match(r.json.commit, /^[0-9a-f]{40}$/);
    // origin trunk 有 writeback commit + trailer
    const bare = path.join(base, 'origin-kb.git');
    const head = git(bare, ['rev-parse', 'master']);
    assert.equal(head, r.json.commit);
    const msg = git(bare, ['cat-file', '-p', head]);
    assert.ok(msg.includes('AI-First-Op: writeback'), 'trailer AI-First-Op');
    assert.ok(msg.includes('AI-First-Writeback-Stage: baseline'));
    assert.ok(msg.includes(`AI-First-CR: ${cr}`));
    // specs/ 落盘（origin tree 可见）
    const tree = git(bare, ['ls-tree', '-r', '--name-only', head]);
    assert.ok(tree.includes('specs/test-spec/PRD.md'));
    assert.ok(tree.includes('specs/test-spec/SDD.md'));
    assert.ok(tree.includes('specs/_index.yml'));
    const prd = git(bare, ['show', `${head}:specs/test-spec/PRD.md`]);
    assert.ok(prd.includes(`（v0.2 · ${cr}）`), '里程碑节已写');
    // 幂等重放：changed=false 零新 commit
    const n0 = originMasterCount(base, 'kb');
    const r2 = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--candidate', manifest, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.changed, false);
    assert.equal(originMasterCount(base, 'kb'), n0, '幂等重放不得新增 commit');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-08 AC-1：恶意 manifest 全矩阵 hard fail 且零写入（origin/staged 不变）', () => {
  const { base, kb, cr, txws } = makeMergedFixture();
  try {
    const manifest = makeBaselineCandidate(txws, cr, 'evil');
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const mk = (mutate) => {
      const m2 = JSON.parse(JSON.stringify(m));
      mutate(m2);
      m2.inputDigest = m2.inputDigest; // 保持自洽由 case 决定
      return m2;
    };
    const writeManifest = (m2) => {
      // 固定路径：journal inputDigest = sha256(candidate 路径)，重跑同一 candidate 才允许续跑；
      // manifest 必须在 candidate 目录内（blob 相对路径解析）
      const p = path.join(path.dirname(manifest), '.evil-manifest.json');
      fs.writeFileSync(p, JSON.stringify(m2, null, 2) + '\n', 'utf8');
      return p;
    };
    const cases = [];
    // 1) path traversal：../ 逃逸
    cases.push(['../escape.md', 'WRITEBACK_PATH_UNSAFE', (m2) => { m2.files[0].path = '../escape.md'; m2.files[0].blob = 'blobs/' + m2.files[0].afterSha256; }]);
    // 2) absolute path
    cases.push(['/abs.md', 'WRITEBACK_PATH_UNSAFE', (m2) => { m2.files[0].path = '/abs.md'; m2.files[0].blob = 'blobs/' + m2.files[0].afterSha256; }]);
    // 3) 反斜杠
    cases.push(['specs\\test-spec\\X.md', 'WRITEBACK_PATH_UNSAFE', (m2) => { m2.files[0].path = 'specs\\test-spec\\X.md'; m2.files[0].blob = 'blobs/' + m2.files[0].afterSha256; }]);
    // 4) allowlist 外路径
    cases.push(['change-requests/_backlog.yml', 'WRITEBACK_PATH_NOT_ALLOWED', (m2) => { m2.files[0].path = 'change-requests/_backlog.yml'; m2.files[0].blob = 'blobs/' + m2.files[0].afterSha256; }]);
    // 5) 未排序（合法路径但破坏字典序：SDD.md > 后面的 PRD.md）
    cases.push(['zzz-last.md', 'WRITEBACK_PATH_UNSORTED', (m2) => { m2.files[0].path = 'specs/test-spec/SDD.md'; m2.files[0].blob = 'blobs/' + m2.files[0].afterSha256; }]);
    // 6) 重复路径
    cases.push(['dup.md', 'WRITEBACK_PATH_DUPLICATE', (m2) => { m2.files[1].path = m2.files[0].path; m2.files[1].blob = 'blobs/' + m2.files[1].afterSha256; }]);
    // 7) blob 引用非法
    cases.push(['blobref.md', 'WRITEBACK_BLOB_REF_INVALID', (m2) => { m2.files[0].blob = 'blobs/00'.repeat(32); }]);
    // 8) blob 缺失（路径对但文件不存在）
    cases.push(['blobmiss.md', 'WRITEBACK_BLOB_MISSING', (m2) => { m2.files[0].afterSha256 = 'ff'.repeat(32); m2.files[0].blob = 'blobs/' + 'ff'.repeat(32); }]);
    // 9) blob 哈希不匹配（blob 文件内容与 afterSha256 不符）
    cases.push(['blobhash.md', 'WRITEBACK_BLOB_HASH_MISMATCH', (m2) => {
      fs.writeFileSync(path.join(path.dirname(manifest), 'blobs', 'ee'.repeat(32)), 'x', 'utf8');
      m2.files[0].afterSha256 = 'ee'.repeat(32); m2.files[0].blob = 'blobs/' + 'ee'.repeat(32);
    }]);
    // 10) inputDigest 篡改（自洽失败）
    cases.push(['tamper.md', 'WRITEBACK_MANIFEST_TAMPERED', (m2) => { m2.targetVersion = '9.9'; m2.inputDigest = '0'.repeat(64); }]);
    // 11) generator id 与 stage 不符
    cases.push(['gen.md', 'WRITEBACK_MANIFEST_MISMATCH', (m2) => { m2.generator.id = 'writeback-tasks'; }]);
    // 12) delete 语义：before=null 但目标文件已存在（txws 有 specs/_index.yml）
    cases.push(['delete.md', 'WRITEBACK_BEFORE_MISMATCH', (m2) => { m2.files = [{ path: 'specs/_index.yml', beforeSha256: null, afterSha256: m2.files[0].afterSha256, blob: m2.files[0].blob }]; }]);
    // 13) before 漂移：before 与实际不符
    cases.push(['before.md', 'WRITEBACK_BEFORE_MISMATCH', (m2) => { m2.files[0].beforeSha256 = 'ab'.repeat(32); }]);
    // 14) stage 与 CLI 不一致
    cases.push(['stage.md', 'WRITEBACK_MANIFEST_MISMATCH', (m2) => { m2.stage = 'tasks'; }]);
    // 15) v 不支持
    cases.push(['v2.md', 'WRITEBACK_MANIFEST_INVALID', (m2) => { m2.v = 2; }]);

    const originBefore = originMasterCount(base, 'kb');
    for (const [label, code, mutate] of cases) {
      const m2 = mk(mutate);
      // tamper case 故意保留伪造 digest；其余 case 重算保持自洽（隔离目标错误码）
      m2.inputDigest = label === 'tamper.md' ? '0'.repeat(64) : writebackInputDigest(m2);
      const p = writeManifest(m2);
      const r = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--candidate', p, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
      assert.notEqual(r.status, 0, `${label} 应 hard fail`);
      assert.equal(r.errJson.error.code, code, `${label}: 期望 ${code} 实得 ${r.errJson.error.code} ${r.errJson.error.message}`);
      // 零写入：origin 不变 + txws staged 空
      assert.equal(originMasterCount(base, 'kb'), originBefore, `${label}: origin 不得前进`);
      const staged = git(txws, ['diff', '--cached', '--name-only']).trim();
      assert.equal(staged, '', `${label}: txws staged set 必须为空`);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-08 AC-3：candidate 后 origin 前进 → WRITEBACK_REMOTE_STALE + txws 重置，重跑 generator 后成功', () => {
  const { base, kb, cr, txws } = makeMergedFixture();
  try {
    const manifest = makeBaselineCandidate(txws, cr, 'stale');
    // origin 前进（竞争者 push 空 commit）
    const rival = path.join(base, 'rival-kb');
    git(base, ['clone', '-q', path.join(base, 'origin-kb.git'), rival]);
    git(rival, ['config', 'user.email', 'r@a']);
    git(rival, ['config', 'user.name', 'r']);
    git(rival, ['commit', '-q', '--allow-empty', '-m', 'rival advance']);
    git(rival, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
    const r1 = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--candidate', manifest, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.notEqual(r1.status, 0);
    assert.equal(r1.errJson.error.code, 'WRITEBACK_REMOTE_STALE');
    // txws 已重置到新 origin 基线（candidate 的 before 不再匹配）
    const newOrigin = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
    assert.equal(git(txws, ['rev-parse', 'HEAD']), newOrigin, 'txws 必须重置到新基线');
    // 重跑 generator（读新基线）→ apply 成功
    const manifest2 = makeBaselineCandidate(txws, cr, 'stale2');
    const r2 = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--candidate', manifest2, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.phase, 'complete');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-08：已发布 commit 遇远端 history rewrite → WRITEBACK_REMOTE_HISTORY_REWRITTEN 硬阻断', () => {
  const { base, kb, cr, txws } = makeMergedFixture();
  try {
    const manifest = makeBaselineCandidate(txws, cr, 'rw');
    const r1 = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--candidate', manifest, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r1.status, 0, r1.stderr);
    const published = r1.json.commit;
    // 远端 history rewrite：回退 master 到 writeback 之前
    const bare = path.join(base, 'origin-kb.git');
    const before = git(bare, ['rev-parse', 'master~1']);
    git(bare, ['update-ref', 'refs/heads/master', before, published]);
    const r2 = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--candidate', manifest, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.notEqual(r2.status, 0);
    assert.equal(r2.errJson.error.code, 'WRITEBACK_REMOTE_HISTORY_REWRITTEN');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-08：writeback-after-commit fault 续跑——不重复 commit/push，一次落盘', () => {
  const { base, kb, cr, txws } = makeMergedFixture();
  try {
    const manifest = makeBaselineCandidate(txws, cr, 'f');
    const r1 = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--candidate', manifest, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb, env: { CRCTL_FAULT_POINT: 'writeback-after-commit' } });
    assert.notEqual(r1.status, 0);
    assert.equal(r1.errJson.error.code, 'FAULT_INJECTED');
    // 重跑：complete，commit 未重复（origin 只有 1 个 writeback commit）
    const r2 = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--candidate', manifest, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.phase, 'complete');
    assert.equal(r2.json.changed, true);
    const log = git(path.join(base, 'origin-kb.git'), ['log', '--format=%s']);
    assert.equal((log.match(/^writeback baseline/g) || []).length, 1, 'writeback commit 只出现一次');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-08：traceability stage 全链路（merge-commits.yml 事实源 + milestone-file）', () => {
  const { base, kb, cr, txws } = makeMergedFixture();
  try {
    // baseline 先落地（merging 阶段）
    const m0 = makeBaselineCandidate(txws, cr, 't0');
    const rb = runCrctl(['writeback-apply', cr, '--stage', 'baseline', '--candidate', m0, '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(rb.status, 0, rb.stderr);
    // 状态推进 merging -> writing-back（在 txws 执行，authority=Transaction Workspace）
    const ra = runCrctl(['advance', cr, '--to', 'writing-back', '--trigger', 'writeback-prd-sdd', '--expect', 'merging', '--embedded', '--spec-id', 'test-spec'], { cwd: txws });
    assert.equal(ra.status, 0, ra.stderr);
    // txws 应有 merge-commits.yml（merge finalize 产物）
    const mcP = path.join(txws, 'change-requests', cr, 'merge-commits.yml');
    assert.ok(fs.existsSync(mcP), 'merge finalize 必须写 merge-commits.yml');
    const msFile = path.join(txws, 'milestone.yml');
    fs.writeFileSync(msFile,
      `cr: ${cr}\nmilestone: M1\ntarget-version: "0.2"\nstatus: writing-back\nfr-chain:\n  - fr: FR-1\n    title: 漂移治理\n    tasks: [${cr}-TASK-01]\n`);
    const out = path.join(txws, '.cand-t');
    fs.mkdirSync(out, { recursive: true });
    const g = runScript(TRACE, txws, ['--workspace', txws, '--cr', cr, '--spec', 'test-spec', '--version', '0.2', '--milestone-file', msFile, '--candidate-out', out]);
    assert.equal(g.code, 0, g.stderr);
    const r = runCrctl(['writeback-apply', cr, '--stage', 'traceability', '--candidate', path.join(out, 'manifest.json'), '--spec-id', 'test-spec', '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.phase, 'complete');
    const bare = path.join(base, 'origin-kb.git');
    const head = git(bare, ['rev-parse', 'master']);
    const tr = git(bare, ['show', `${head}:specs/test-spec/traceability.yml`]);
    assert.ok(tr.includes(`- cr: ${cr}`), 'milestone 段已写');
    assert.ok(tr.includes('sha: '), 'merge-sha 取自 merge-commits.yml');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

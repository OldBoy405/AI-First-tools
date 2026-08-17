// CR-2026-031 TASK-11：upgrade-check（临时只读预检）测试。
// 覆盖：safe（developing/终态/零 publish code-approved，CR-2026-044 FR-11）、
// requiresReapproval（code-reviewing 重评）、
// blocksUpgrade（merging/writing-back/partial-publish/authority-unknown）、
// 执行前后工作区文件树与 origin refs 不变（零写入断言）、canActivate/exit 码。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { git, runCrctl, makeFixture } from './merge-fixture.mjs';

const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

/** 在 kb origin trunk 写入指定 status 的 CR 账本 + cr.md。 */
function addCrStatus(kb, bare, cr, status) {
  const crDir = path.join(kb, 'change-requests', cr);
  fs.mkdirSync(path.join(crDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(crDir, 'cr.md'), `---\nid: ${cr}\nstatus: ${status}\n---\n`);
  fs.writeFileSync(path.join(crDir, 'prd.md'), '# PRD\n');
  fs.writeFileSync(path.join(crDir, 'sdd.md'), '# SDD\n');
  const backlog = fs.readFileSync(path.join(kb, 'change-requests', '_backlog.yml'), 'utf8');
  fs.writeFileSync(path.join(kb, 'change-requests', '_backlog.yml'), backlog + `  - id: ${cr}\n    title: upgrade fixture\n`);
  fs.writeFileSync(path.join(kb, 'change-requests', '_index.yml'),
    fs.readFileSync(path.join(kb, 'change-requests', '_index.yml'), 'utf8') + `  - id: ${cr}\n    title: upgrade fixture\n`);
  git(kb, ['add', '-A']);
  git(kb, ['commit', '-q', '-m', `fixture ${cr}`]);
  git(kb, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
  git(kb, ['fetch', '-q', 'origin']);
}

function makeUpgradeFixture() {
  const f = makeFixture();
  const { base, kb } = f;
  const cr = (n) => `CR-${new Date().getFullYear()}-${String(n).padStart(3, '0')}`;
  return { ...f, cr };
}

function treeFingerprint(kb) {
  const out = git(kb, ['status', '--porcelain', '--untracked-files=all']).trim();
  return sha256(out + '|' + git(kb, ['rev-parse', 'HEAD']));
}

test('TASK-11：四类 legacy fixture 分类准确 + 执行前后零写入', () => {
  const f = makeUpgradeFixture();
  const { base, kb, cr } = f;
  try {
    const cSafe = cr(1), cReappr = cr(2), cBlock = cr(3), cPublish = cr(4), cUnknown = cr(5), cReview = cr(9);
    // safe：developing（未到审批终态）
    addCrStatus(kb, path.join(base, 'origin-kb.git'), cSafe, 'developing');
    // CR-2026-044：零 publish code-approved → safe（checkpoint 后 merge，无需重审批）
    addCrStatus(kb, path.join(base, 'origin-kb.git'), cReappr, 'code-approved');
    // CR-2026-044：code-reviewing → requiresReapproval（重跑 review-code）
    addCrStatus(kb, path.join(base, 'origin-kb.git'), cReview, 'code-reviewing');
    // blocksUpgrade：merging（回写期在途）
    addCrStatus(kb, path.join(base, 'origin-kb.git'), cBlock, 'merging');
    // blocksUpgrade：partial-publish（code-approved + merge journal 有 pushed 事实）
    addCrStatus(kb, path.join(base, 'origin-kb.git'), cPublish, 'code-approved');
    // 构造 merge journal 部分发布（pushed=true）
    const jDir = path.join(kb, '.crctl', 'transactions', 'merge', cPublish, 'a'.repeat(32));
    fs.mkdirSync(jDir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(jDir, 'journal.json'), JSON.stringify({
      v: 1, txId: 'a'.repeat(32), op: 'merge', cr: cPublish, phase: 'pushed-kb',
      graphDigest: '', inputDigest: '', sideEffects: [], commit: null, lastError: null,
      createdAt: now, updatedAt: now,
      register: null, workspace: null, merge: { cr: cPublish, phase: 'pushed-kb', repos: [{ repo: 'kb', pushed: true, confirmed: false }], finalizePushed: false }, writeback: null, archive: null,
    }, null, 2), 'utf8');
    // blocksUpgrade：authority-unknown（origin trunk 无该 CR 的 cr.md）
    addCrStatus(kb, path.join(base, 'origin-kb.git'), cUnknown, 'writing-back');
    // writing-back 覆盖 unknown-status；再构造一个真的无法读取的：把 cUnknown 的 cr.md 删除后 push
    fs.rmSync(path.join(kb, 'change-requests', cUnknown, 'cr.md'));
    git(kb, ['add', '-A']);
    git(kb, ['commit', '-q', '-m', 'drop cr.md']);
    git(kb, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);

    const before = treeFingerprint(kb);
    const originBefore = git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']);
    const r = runCrctl(['upgrade-check', '--workspace', kb], { cwd: kb });
    // blocksUpgrade 存在 → exit 1
    assert.equal(r.status, 1, r.stderr);
    const j = r.json;
    assert.equal(j.op, 'upgrade-check');
    assert.equal(j.temporary, true);
    assert.equal(j.canActivate, false);
    assert.ok(j.safe.some((x) => x.cr === cSafe), 'developing → safe');
    assert.ok(j.safe.some((x) => x.cr === cReappr), '零 publish code-approved → safe（CR-2026-044）');
    assert.ok(j.requiresReapproval.some((x) => x.cr === cReview && x.why === 'code-reviewing-rereview'), 'code-reviewing → requiresReapproval（CR-2026-044）');
    assert.ok(j.blocksUpgrade.some((x) => x.cr === cBlock && x.why === 'in-flight-writeback'), 'merging → blocksUpgrade');
    assert.ok(j.blocksUpgrade.some((x) => x.cr === cPublish && x.why === 'partial-publish'), 'partial-publish → blocksUpgrade');
    assert.ok(j.blocksUpgrade.some((x) => x.cr === cUnknown && x.why === 'authority-unknown'), 'authority-unknown → blocksUpgrade');
    // 零写入：工作区 + origin trunk ref 不变
    assert.equal(treeFingerprint(kb), before, '工作区零写入');
    assert.equal(git(path.join(base, 'origin-kb.git'), ['rev-parse', 'master']), originBefore, 'origin 零写入');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-11：全部 safe + requiresReapproval（无 blocker）→ canActivate=true exit 0', () => {
  const f = makeUpgradeFixture();
  const { base, kb, cr } = f;
  try {
    addCrStatus(kb, path.join(base, 'origin-kb.git'), cr(6), 'developing');
    addCrStatus(kb, path.join(base, 'origin-kb.git'), cr(7), 'archived');
    addCrStatus(kb, path.join(base, 'origin-kb.git'), cr(8), 'code-approved');
    addCrStatus(kb, path.join(base, 'origin-kb.git'), cr(9), 'code-reviewing');
    const before = treeFingerprint(kb);
    const r = runCrctl(['upgrade-check', '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.canActivate, true);
    assert.equal(r.json.blocksUpgrade.length, 0);
    assert.ok(r.json.safe.some((x) => x.cr === cr(8)), '零 publish code-approved 在 safe');
    assert.ok(r.json.requiresReapproval.some((x) => x.cr === cr(9)), 'code-reviewing 在 requiresReapproval');
    assert.equal(treeFingerprint(kb), before, '工作区零写入');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

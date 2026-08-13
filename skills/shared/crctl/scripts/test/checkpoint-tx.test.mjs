// CR-2026-033 TASK-04：checkpoint 深原语集成测试。
// 三 bare remote fixture（merge-fixture.mjs#makeFixture）+ 手工 developing CR worktree。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { git, runCrctl, makeFixture, sha256 } from './merge-fixture.mjs';
import { loadOrCreateJournal, saveJournal } from '../lib/durable-tx.mjs';
import { classifyCheckpointRemote, resolveRepositories } from '../lib/workspace-transactions.mjs';

const CR = 'CR-2026-033';
const TOOLS_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');

function wtPath(kb, repo, cr) {
  return path.join(kb, '.rayai-worktrees', repo === 'kb' ? 'knowledge-base' : repo, 'requirement', cr);
}

/** 三仓 requirement 分支 + worktree + developing CR + 推 origin。 */
function makeCheckpointFixture({ pushRemote = true } = {}) {
  const f = makeFixture();
  const { base, kb, others } = f;
  for (const [repo, wd] of Object.entries({ kb, ...others })) {
    git(wd, ['branch', `requirement/${CR}`, 'master']);
    const wt = wtPath(kb, repo, CR);
    git(wd, ['worktree', 'add', wt, `requirement/${CR}`]);
    if (repo === 'kb') {
      fs.mkdirSync(path.join(wt, 'change-requests', CR), { recursive: true });
      fs.writeFileSync(path.join(wt, 'change-requests', '_backlog.yml'),
        `schema: cr-backlog/v2\nchange-requests:\n  - id: ${CR}\n    title: Checkpoint Test\n    status: developing\n    owner: alice\n`);
      fs.writeFileSync(path.join(wt, 'change-requests', '_index.yml'), `change-requests:\n  - id: ${CR}\n    title: Checkpoint Test\n`);
      fs.writeFileSync(path.join(wt, 'change-requests', CR, 'cr.md'), `---\nid: ${CR}\nstatus: developing\nupdated-at: "2026-08-13T20:00:00+08:00"\n---\n`);
      fs.writeFileSync(path.join(wt, 'kb-doc.txt'), 'kb seed\n');
    } else {
      fs.writeFileSync(path.join(wt, 'feature.txt'), `${repo} seed\n`);
    }
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-q', '-m', `seed ${repo}`]);
    if (pushRemote) git(wt, ['push', '-q', 'origin', `HEAD:refs/heads/requirement/${CR}`]);
  }
  git(kb, ['fetch', '-q', 'origin']);
  return { ...f, kbWt: wtPath(kb, 'kb', CR) };
}

const remoteHead = (base, name, cr) => git(path.join(base, `origin-${name}.git`), ['rev-parse', `requirement/${cr}`]);

function externalCommit(base, name, cr, text) {
  const wd = path.join(base, `external-${name}-${Date.now()}`);
  git(base, ['clone', '-q', '--branch', `requirement/${cr}`, path.join(base, `origin-${name}.git`), wd]);
  git(wd, ['config', 'user.email', 'external@aifirst.dev']);
  git(wd, ['config', 'user.name', 'External']);
  fs.appendFileSync(path.join(wd, 'feature.txt'), text);
  git(wd, ['add', '-A']);
  git(wd, ['commit', '-q', '-m', 'external advance']);
  git(wd, ['push', '-q', 'origin', `HEAD:refs/heads/requirement/${cr}`]);
  return git(wd, ['rev-parse', 'HEAD']);
}

test('checkpoint happy path：三仓 source commit + KB metadata commit + latest-checkpoint + no-op', () => {
  const f = makeCheckpointFixture();
  try {
    // 三仓各制造 tracked 修改
    fs.appendFileSync(path.join(f.kbWt, 'kb-doc.txt'), 'kb change\n');
    fs.appendFileSync(path.join(wtPath(f.kb, 'multica', CR), 'feature.txt'), 'multica change\n');
    fs.appendFileSync(path.join(wtPath(f.kb, 'tools', CR), 'feature.txt'), 'tools change\n');
    const r = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.phase, 'complete', JSON.stringify(r.json || r.errJson));
    assert.equal(r.json.changed, true);
    assert.match(r.json.batchId, /^[0-9a-f]{16}$/);
    assert.equal(r.json.repositories.length, 3);
    for (const x of r.json.repositories) assert.equal(x.confirmed, true);
    // 三仓 remote requirement 分支均前进到 source SHA
    for (const n of ['kb', 'multica', 'tools']) {
      const head = remoteHead(f.base, n, CR);
      const rec = r.json.repositories.find((x) => x.repo === n);
      if (n === 'kb') {
        // KB remote 头是 metadata commit，其直接父 = kb source sha（rec.sourceSha）
        assert.equal(git(path.join(f.base, `origin-${n}.git`), ['rev-parse', `${head}^`]), rec.sourceSha, `kb direct-parent`);
      } else {
        assert.equal(head, rec.sourceSha, `${n} remote == source`);
      }
    }
    // latest-checkpoint 写入 KB worktree backlog，无旧字段
    const backlog = fs.readFileSync(path.join(f.kbWt, 'change-requests', '_backlog.yml'), 'utf8');
    assert.ok(backlog.includes('latest-checkpoint:'));
    assert.ok(backlog.includes(`batch-id: ${r.json.batchId}`));
    assert.ok(!backlog.includes('checkpoints:'));
    assert.ok(!backlog.includes('last-push-at:'));
    // 完整批次只发一次 checkpoint outbox（dedup 文件名）
    const outbox = fs.readdirSync(path.join(f.kb, '.crctl', 'outbox')).filter((n) => n.startsWith(`checkpoint-${CR}-`));
    assert.equal(outbox.length, 1, `outbox 恰一次: ${outbox.join(',')}`);
    // no-op：重跑 changed=false，无新 commit/push
    const beforeLog = git(path.join(f.base, 'origin-kb.git'), ['rev-list', '--count', `requirement/${CR}`]);
    const r2 = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.changed, false);
    assert.equal(r2.json.txId, null);
    assert.equal(r2.json.batchId, r.json.batchId);
    assert.equal(git(path.join(f.base, 'origin-kb.git'), ['rev-list', '--count', `requirement/${CR}`]), beforeLog);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint 敏感路径：.env 命中全仓零 add/commit/push', () => {
  const f = makeCheckpointFixture();
  try {
    const before = {};
    for (const n of ['kb', 'multica', 'tools']) before[n] = remoteHead(f.base, n, CR);
    fs.writeFileSync(path.join(wtPath(f.kb, 'tools', CR), '.env'), 'SECRET=1\n');
    fs.appendFileSync(path.join(f.kbWt, 'kb-doc.txt'), 'kb change\n');
    const r = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r.status, 1);
    assert.equal(r.errJson.error.code, 'CHECKPOINT_SENSITIVE_PATH');
    for (const n of ['kb', 'multica', 'tools']) {
      assert.equal(remoteHead(f.base, n, CR), before[n], `${n} 零副作用`);
    }
    // index 未被污染（敏感文件未 add）
    const st = git(wtPath(f.kb, 'tools', CR), ['status', '--porcelain']);
    assert.ok(st.includes('.env'), 'worktree 仍显示未跟踪 .env');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint tracked+untracked+ignored：source commit 含前两类、排除 ignored', () => {
  const f = makeCheckpointFixture();
  try {
    const toolsWt = wtPath(f.kb, 'tools', CR);
    fs.appendFileSync(path.join(toolsWt, 'feature.txt'), 'tracked change\n'); // tracked
    fs.writeFileSync(path.join(toolsWt, 'new-file.txt'), 'untracked\n');       // untracked
    fs.writeFileSync(path.join(toolsWt, 'ignored.log'), 'ignored\n');          // ignored（tools 无 .gitignore，临时加）
    git(toolsWt, ['config', 'core.excludesFile', '/dev/null']); // 占位
    fs.writeFileSync(path.join(toolsWt, '.gitignore'), '*.log\n');
    const r = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r.status, 0, r.stderr);
    const head = remoteHead(f.base, 'tools', CR);
    const tree = git(path.join(f.base, 'origin-tools.git'), ['ls-tree', '-r', '--name-only', head]);
    assert.ok(tree.includes('feature.txt') && tree.includes('new-file.txt'), 'tracked+untracked 入树');
    assert.ok(!tree.includes('ignored.log'), 'ignored 排除');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint source commit 后 fault + 新增变化：重跑更新 sourceSha 并完成', () => {
  const f = makeCheckpointFixture();
  try {
    fs.appendFileSync(path.join(f.kbWt, 'kb-doc.txt'), 'first change\n');
    const r1 = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb, env: { CRCTL_FAULT_POINT: 'checkpoint-after-source-commit' } });
    assert.equal(r1.status, 1);
    assert.equal(r1.errJson.error.code, 'FAULT_INJECTED');
    // fault 后 KB worktree 又有新增变化（模拟 hook/外部写入）
    fs.appendFileSync(path.join(f.kbWt, 'kb-doc.txt'), 'second change\n');
    const r2 = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.changed, true);
    const kbHead = remoteHead(f.base, 'kb', CR);
    // 两个 change 都在 source（恢复重扫合并）
    const content = git(path.join(f.base, 'origin-kb.git'), ['show', `${kbHead}^:kb-doc.txt`]);
    assert.ok(content.includes('first change') && content.includes('second change'), '恢复重扫含全部变化');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint 首次推送：remote requirement ref 不存在时创建三仓分支', () => {
  const f = makeCheckpointFixture({ pushRemote: false });
  try {
    const r = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.phase, 'complete');
    for (const n of ['kb', 'multica', 'tools']) assert.match(remoteHead(f.base, n, CR), /^[0-9a-f]{40}$/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint classifier：已发布 source 仍是 remote 祖先时为 advanced，不误报 history rewrite', () => {
  assert.equal(classifyCheckpointRemote({
    remoteSha: 'b'.repeat(40), sourceSha: 'a'.repeat(40),
    remoteIsSourceAncestor: false, sourceIsRemoteAncestor: true, journalSaysPublished: true,
  }), 'advanced');
  assert.equal(classifyCheckpointRemote({
    remoteSha: 'b'.repeat(40), sourceSha: 'a'.repeat(40),
    remoteIsSourceAncestor: false, sourceIsRemoteAncestor: false, journalSaysPublished: true,
  }), 'history-rewritten');
  assert.equal(classifyCheckpointRemote({
    remoteSha: 'b'.repeat(40), sourceSha: 'a'.repeat(40),
    remoteIsSourceAncestor: true, sourceIsRemoteAncestor: false, journalSaysPublished: true,
  }), 'history-rewritten');
});

test('checkpoint malformed latest-checkpoint：零 commit/push并返回 CHECKPOINT_SNAPSHOT_INVALID', () => {
  const f = makeCheckpointFixture();
  try {
    const first = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(first.status, 0, first.stderr);
    const beforeHeads = Object.fromEntries(['kb', 'multica', 'tools'].map((n) => [n, remoteHead(f.base, n, CR)]));
    const bp = path.join(f.kbWt, 'change-requests', '_backlog.yml');
    fs.writeFileSync(bp, fs.readFileSync(bp, 'utf8').replace(/source-sha: [0-9a-f]{40}/, 'source-sha: bad'));
    const r = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r.status, 1);
    assert.equal(r.errJson.error.code, 'CHECKPOINT_SNAPSHOT_INVALID');
    for (const n of ['kb', 'multica', 'tools']) assert.equal(remoteHead(f.base, n, CR), beforeHeads[n]);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint 敏感预检查询失败：损坏 index 后 TX_GIT_FAILED 且零 push', () => {
  const f = makeCheckpointFixture();
  try {
    const toolsWt = wtPath(f.kb, 'tools', CR);
    const before = remoteHead(f.base, 'tools', CR);
    const index = git(toolsWt, ['rev-parse', '--git-path', 'index']);
    fs.writeFileSync(index, 'broken-index');
    const r = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r.status, 1);
    assert.equal(r.errJson.error.code, 'TX_GIT_FAILED');
    assert.equal(remoteHead(f.base, 'tools', CR), before);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint journal 后错误：固定返回 txId/phase/sideEffects/recoverCommand', () => {
  const f = makeCheckpointFixture();
  try {
    fs.appendFileSync(path.join(f.kbWt, 'kb-doc.txt'), 'fault change\n');
    const r = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb, env: { CRCTL_FAULT_POINT: 'checkpoint-after-source-commit' } });
    assert.equal(r.status, 1);
    assert.equal(r.errJson.error.code, 'FAULT_INJECTED');
    assert.match(r.errJson.error.txId, /^[0-9a-f]{32}$/);
    assert.equal(typeof r.errJson.error.phase, 'string');
    assert.ok(Array.isArray(r.errJson.error.sideEffects));
    assert.match(r.errJson.error.recoverCommand, /^crctl checkpoint /);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint residual complete journal：authority 确认后清理并允许下一批', async () => {
  const f = makeCheckpointFixture();
  try {
    const first = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(first.status, 0, first.stderr);
    const ctx = resolveRepositories(f.kb);
    const inputDigest = sha256(JSON.stringify({ cr: CR, graphDigest: ctx.graphDigest }));
    const { journal, journalPath } = await loadOrCreateJournal({
      root: f.kb, op: 'checkpoint', cr: CR, key: CR, graphDigest: ctx.graphDigest, inputDigest,
    });
    journal.phase = 'complete';
    journal.checkpoint = {
      phase: 'complete', batchId: first.json.batchId,
      kbSourceSha: first.json.repositories.find((r) => r.repo === 'kb').sourceSha,
      metadataCommit: first.json.metadataCommit,
      repositories: first.json.repositories.map((r) => ({ repo: r.repo, remoteRef: r.remoteRef, baseSha: null, sourceSha: r.sourceSha, remoteBefore: null, phase: 'confirmed' })),
    };
    await saveJournal({ path: journalPath, journal });
    fs.appendFileSync(path.join(wtPath(f.kb, 'tools', CR), 'feature.txt'), 'next batch\n');
    const second = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.changed, true);
    assert.notEqual(second.json.batchId, first.json.batchId);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint metadata commit/save 窗口：由 trailer 恢复而非 TX_RECOVERY_CONFLICT', () => {
  const f = makeCheckpointFixture();
  try {
    fs.appendFileSync(path.join(f.kbWt, 'kb-doc.txt'), 'metadata recovery\n');
    const first = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb, env: { CRCTL_FAULT_POINT: 'checkpoint-after-metadata-commit' } });
    assert.equal(first.status, 1);
    const txDir = path.join(f.kb, '.crctl', 'transactions', 'checkpoint', CR);
    const txId = fs.readdirSync(txDir)[0];
    const jp = path.join(txDir, txId, 'journal.json');
    const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
    j.phase = 'repos-confirmed';
    j.checkpoint.phase = 'repos-confirmed';
    j.checkpoint.metadataCommit = null;
    fs.writeFileSync(jp, JSON.stringify(j, null, 2));
    const second = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.phase, 'complete');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint metadata write-set/commit 窗口：撤回账本候选后重扫，不把 snapshot 吞入 KB source', () => {
  const f = makeCheckpointFixture();
  try {
    const hooks = path.join(f.kb, '.git', 'hooks');
    const hook = path.join(hooks, 'pre-commit');
    git(f.kb, ['config', 'core.hooksPath', hooks]);
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    const first = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(first.status, 1);
    assert.equal(first.errJson.error.code, 'TX_GIT_FAILED');
    const jp = path.join(f.kb, '.crctl', 'transactions', 'checkpoint', CR, first.errJson.error.txId, 'journal.json');
    const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
    assert.ok(j.checkpoint.batchId);
    assert.equal(j.checkpoint.metadataCommit, null);
    fs.rmSync(hook);
    fs.appendFileSync(path.join(wtPath(f.kb, 'tools', CR), 'feature.txt'), 'after metadata candidate\n');
    const second = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(second.status, 0, second.stderr);
    const kbSource = second.json.repositories.find((r) => r.repo === 'kb').sourceSha;
    const sourceBacklog = git(path.join(f.base, 'origin-kb.git'), ['show', `${kbSource}:change-requests/_backlog.yml`]);
    const metadataBacklog = git(path.join(f.base, 'origin-kb.git'), ['show', `${second.json.metadataCommit}:change-requests/_backlog.yml`]);
    assert.doesNotMatch(sourceBacklog, /latest-checkpoint:/);
    assert.match(metadataBacklog, /latest-checkpoint:/);
    assert.match(git(path.join(f.base, 'origin-tools.git'), ['show', `requirement/${CR}:feature.txt`]), /after metadata candidate/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint confirmed 仓新增变化：source save 前先降 phase，重跑必须重新 publish', () => {
  const f = makeCheckpointFixture();
  try {
    const first = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb, env: { CRCTL_FAULT_POINT: 'checkpoint-after-confirm' } });
    assert.equal(first.status, 1);
    assert.equal(first.errJson.error.code, 'FAULT_INJECTED');
    const multicaWt = wtPath(f.kb, 'multica', CR);
    fs.appendFileSync(path.join(multicaWt, 'feature.txt'), 'after confirmed\n');
    const second = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb, env: { CRCTL_FAULT_POINT: 'checkpoint-after-source-commit' } });
    assert.equal(second.status, 1);
    const jp = path.join(f.kb, '.crctl', 'transactions', 'checkpoint', CR, second.errJson.error.txId, 'journal.json');
    const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
    assert.equal(j.checkpoint.repositories.find((r) => r.repo === 'multica').phase, 'committed-local');
    const third = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(third.status, 0, third.stderr);
    assert.match(git(path.join(f.base, 'origin-multica.git'), ['show', `requirement/${CR}:feature.txt`]), /after confirmed/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint push 响应丢失：after-push 重跑观察 exact head，不重复 source commit', () => {
  const f = makeCheckpointFixture();
  try {
    const toolsWt = wtPath(f.kb, 'tools', CR);
    fs.appendFileSync(path.join(toolsWt, 'feature.txt'), 'push once\n');
    const first = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb, env: { CRCTL_FAULT_POINT: 'checkpoint-after-push' } });
    assert.equal(first.status, 1);
    const pushed = remoteHead(f.base, 'tools', CR);
    const count = git(path.join(f.base, 'origin-tools.git'), ['rev-list', '--count', `requirement/${CR}`]);
    const second = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.repositories.find((r) => r.repo === 'tools').sourceSha, pushed);
    assert.equal(git(path.join(f.base, 'origin-tools.git'), ['rev-list', '--count', `requirement/${CR}`]), count);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint metadata push 后故障：重跑确认既有 metadata，不造第二提交', () => {
  const f = makeCheckpointFixture();
  try {
    fs.appendFileSync(path.join(f.kbWt, 'kb-doc.txt'), 'metadata push\n');
    const first = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb, env: { CRCTL_FAULT_POINT: 'checkpoint-after-metadata-push' } });
    assert.equal(first.status, 1);
    const remote = remoteHead(f.base, 'kb', CR);
    const count = git(path.join(f.base, 'origin-kb.git'), ['rev-list', '--count', `requirement/${CR}`]);
    const second = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.metadataCommit, remote);
    assert.equal(git(path.join(f.base, 'origin-kb.git'), ['rev-list', '--count', `requirement/${CR}`]), count);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint 仅非 KB 变化：KB source 沿用上一 metadata HEAD，只新增 metadata commit', () => {
  const f = makeCheckpointFixture();
  try {
    const first = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(first.status, 0, first.stderr);
    fs.appendFileSync(path.join(wtPath(f.kb, 'tools', CR), 'feature.txt'), 'tools only\n');
    const second = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(second.status, 0, second.stderr);
    const kbSource = second.json.repositories.find((r) => r.repo === 'kb').sourceSha;
    assert.equal(kbSource, first.json.metadataCommit);
    assert.equal(git(path.join(f.base, 'origin-kb.git'), ['rev-parse', `${second.json.metadataCommit}^`]), first.json.metadataCommit);
    assert.deepEqual(second.json.sideEffects.map((x) => `${x.kind}:${x.repo}`).sort(), [
      'commit:knowledge-base', 'commit:tools', 'push:knowledge-base', 'push:tools',
    ]);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint 敏感矩阵：例外/普通 pem/空格路径放行，私钥头硬阻断', () => {
  const f = makeCheckpointFixture();
  try {
    const toolsWt = wtPath(f.kb, 'tools', CR);
    fs.writeFileSync(path.join(toolsWt, '.env.example'), 'EXAMPLE=1\n');
    fs.writeFileSync(path.join(toolsWt, 'normal.pem'), 'certificate only\n');
    fs.writeFileSync(path.join(toolsWt, 'file with spaces.txt'), 'safe\n');
    const ok = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(ok.status, 0, ok.stderr);
    const before = remoteHead(f.base, 'tools', CR);
    fs.writeFileSync(path.join(toolsWt, 'innocent.txt'), '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n');
    const blocked = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(blocked.status, 1);
    assert.equal(blocked.errJson.error.code, 'CHECKPOINT_SENSITIVE_PATH');
    assert.equal(remoteHead(f.base, 'tools', CR), before);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint CRLF backlog 正常规范化并完成', () => {
  const f = makeCheckpointFixture();
  try {
    const bp = path.join(f.kbWt, 'change-requests', '_backlog.yml');
    fs.writeFileSync(bp, fs.readFileSync(bp, 'utf8').replaceAll('\n', '\r\n'));
    const r = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(bp, 'utf8'), /latest-checkpoint:/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('checkpoint worktree 前置：missing 与 wrong-branch 使用冻结错误码', () => {
  const missing = makeCheckpointFixture();
  try {
    const toolsWt = wtPath(missing.kb, 'tools', CR);
    git(missing.others.tools, ['worktree', 'remove', '--force', toolsWt]);
    const r = runCrctl(['checkpoint', CR, '--workspace', missing.kb], { cwd: missing.kb });
    assert.equal(r.status, 1);
    assert.equal(r.errJson.error.code, 'CHECKPOINT_WORKTREE_MISSING');
  } finally { fs.rmSync(missing.base, { recursive: true, force: true }); }

  const wrong = makeCheckpointFixture();
  try {
    const toolsWt = wtPath(wrong.kb, 'tools', CR);
    git(toolsWt, ['checkout', '-q', '-b', 'wrong-branch']);
    const r = runCrctl(['checkpoint', CR, '--workspace', wrong.kb], { cwd: wrong.kb });
    assert.equal(r.status, 1);
    assert.equal(r.errJson.error.code, 'CHECKPOINT_BRANCH_MISMATCH');
  } finally { fs.rmSync(wrong.base, { recursive: true, force: true }); }
});

test('checkpoint remote 关系矩阵：advanced/diverged/history-rewritten 精确分类', () => {
  const advanced = makeCheckpointFixture();
  try {
    externalCommit(advanced.base, 'tools', CR, 'remote ahead\n');
    const r = runCrctl(['checkpoint', CR, '--workspace', advanced.kb], { cwd: advanced.kb });
    assert.equal(r.status, 1);
    assert.equal(r.errJson.error.code, 'CHECKPOINT_REMOTE_ADVANCED');
  } finally { fs.rmSync(advanced.base, { recursive: true, force: true }); }

  const diverged = makeCheckpointFixture();
  try {
    const toolsWt = wtPath(diverged.kb, 'tools', CR);
    fs.appendFileSync(path.join(toolsWt, 'feature.txt'), 'local fork\n');
    git(toolsWt, ['add', '-A']);
    git(toolsWt, ['commit', '-q', '-m', 'local fork']);
    externalCommit(diverged.base, 'tools', CR, 'remote fork\n');
    const r = runCrctl(['checkpoint', CR, '--workspace', diverged.kb], { cwd: diverged.kb });
    assert.equal(r.status, 1);
    assert.equal(r.errJson.error.code, 'CHECKPOINT_REMOTE_DIVERGED');
  } finally { fs.rmSync(diverged.base, { recursive: true, force: true }); }

  const rewritten = makeCheckpointFixture();
  try {
    const before = remoteHead(rewritten.base, 'tools', CR);
    fs.appendFileSync(path.join(wtPath(rewritten.kb, 'tools', CR), 'feature.txt'), 'published then lost\n');
    const first = runCrctl(['checkpoint', CR, '--workspace', rewritten.kb], { cwd: rewritten.kb, env: { CRCTL_FAULT_POINT: 'checkpoint-after-push' } });
    assert.equal(first.status, 1);
    git(path.join(rewritten.base, 'origin-tools.git'), ['update-ref', `refs/heads/requirement/${CR}`, before]);
    const second = runCrctl(['checkpoint', CR, '--workspace', rewritten.kb], { cwd: rewritten.kb });
    assert.equal(second.status, 1);
    assert.equal(second.errJson.error.code, 'CHECKPOINT_REMOTE_HISTORY_REWRITTEN');
  } finally { fs.rmSync(rewritten.base, { recursive: true, force: true }); }
});

test('checkpoint T05 contract：Pipeline 只编排 Skill，active alignment reader 不读旧 checkpoints[]', () => {
  const pipelineFiles = ['requirement-authoring.pipeline.json', 'architecture-design.pipeline.json', 'code-implementation.pipeline.json', 'resume-cr.pipeline.json'];
  for (const name of pipelineFiles) {
    const doc = JSON.parse(fs.readFileSync(path.join(TOOLS_ROOT, 'pipeline-templates', name), 'utf8'));
    for (const node of doc.nodes.filter((n) => n.ref === 'push-progress' || n.ref === 'list-remote-checkpoints')) {
      assert.doesNotMatch(node.prompt, /crctl checkpoint|source commit|lease publish|latest-checkpoint|source-sha|checkpoint-add|git (add|commit|push)/i, `${name}:${node.label}`);
    }
  }
  const alignment = fs.readFileSync(path.join(TOOLS_ROOT, 'skills', 'review', 'review-alignment', 'SKILL.md'), 'utf8');
  assert.ok(alignment.includes('latest-checkpoint'));
  assert.ok(!alignment.includes('checkpoints[]'));
});

test('checkpoint 业务 payload 恢复冲突：损坏 journal（重复 repo）→ TX_RECOVERY_CONFLICT', () => {
  const f = makeCheckpointFixture();
  try {
    fs.appendFileSync(path.join(f.kbWt, 'kb-doc.txt'), 'change\n');
    const r1 = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb, env: { CRCTL_FAULT_POINT: 'checkpoint-after-metadata-commit' } });
    assert.equal(r1.status, 1);
    assert.equal(r1.errJson.error.code, 'FAULT_INJECTED');
    const txDir = path.join(f.kb, '.crctl', 'transactions', 'checkpoint', CR);
    const txId = fs.readdirSync(txDir)[0];
    const jp = path.join(txDir, txId, 'journal.json');
    const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
    j.checkpoint.repositories.push({ ...j.checkpoint.repositories[0] }); // 制造重复 repo
    fs.writeFileSync(jp, JSON.stringify(j, null, 2));
    const r2 = runCrctl(['checkpoint', CR, '--workspace', f.kb], { cwd: f.kb });
    assert.equal(r2.status, 1);
    assert.equal(r2.errJson.error.code, 'TX_RECOVERY_CONFLICT');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

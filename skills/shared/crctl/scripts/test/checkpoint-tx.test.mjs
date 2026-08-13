// CR-2026-033 TASK-04：checkpoint 深原语集成测试。
// 三 bare remote fixture（merge-fixture.mjs#makeFixture）+ 手工 developing CR worktree。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { git, runCrctl, makeFixture } from './merge-fixture.mjs';

const CR = 'CR-2026-033';

function wtPath(kb, repo, cr) {
  return path.join(kb, '.rayai-worktrees', repo === 'kb' ? 'knowledge-base' : repo, 'requirement', cr);
}

/** 三仓 requirement 分支 + worktree + developing CR + 推 origin。 */
function makeCheckpointFixture() {
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
    git(wt, ['push', '-q', 'origin', `HEAD:refs/heads/requirement/${CR}`]);
  }
  git(kb, ['fetch', '-q', 'origin']);
  return { ...f, kbWt: wtPath(kb, 'kb', CR) };
}

const remoteHead = (base, name, cr) => git(path.join(base, `origin-${name}.git`), ['rev-parse', `requirement/${cr}`]);

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

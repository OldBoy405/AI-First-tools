// CR-2026-031 TASK-07：可恢复跨仓 merge 与 finalize 集成测试。
// 三 bare remote fixture；CR 手工构造到 code-approved（评审产物在主 checkout master 提交，
// worktree 分支是只读被评审源 HEAD 恒定 = reviewed-source-sha）。覆盖：happy path 三仓 publish + finalize、
// prepare conflict 零远端副作用、第二仓失败续跑不重复 confirmed push、响应丢失重放、remote stale rebuild、
// finalize stale rebuild、history rewrite 硬阻断、release-drift 回退、PRD drift 硬阻断、merge status 只读快照。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { git, runCrctl, sha256, makeFixture, makeCodeApprovedFixture, originMasterCount } from './merge-fixture.mjs';
import { prepareMergeTree, replaceBacklogEntry } from '../lib/workspace-transactions.mjs';

test('CR-2026-038 TASK-03：backlog 只替换目标完整条目并逐字保留 trunk 其余内容', () => {
  const trunk = 'schema: cr-backlog/v2\r\nchange-requests:\r\n  - id: CR-2026-001\r\n    title: trunk-before\r\n\r\n  # keep target separator\r\n  - id: CR-2026-038\r\n    title: old\r\n    unknown: trunk-old\r\n\r\n  # keep after target\r\n  - id: CR-2026-099\r\n    title: trunk-after\r\n';
  const source = 'schema: cr-backlog/v2\nchange-requests:\n  - id: CR-2026-038\n    title: source\n    owners:\n      development:\n        id: Ray\n    latest-checkpoint:\n      tools: abc123\n    future-v2: keep\n';
  const expected = 'schema: cr-backlog/v2\r\nchange-requests:\r\n  - id: CR-2026-001\r\n    title: trunk-before\r\n\r\n  # keep target separator\r\n  - id: CR-2026-038\r\n    title: source\r\n    owners:\r\n      development:\r\n        id: Ray\r\n    latest-checkpoint:\r\n      tools: abc123\r\n    future-v2: keep\r\n\r\n  # keep after target\r\n  - id: CR-2026-099\r\n    title: trunk-after\r\n';
  assert.equal(replaceBacklogEntry(trunk, source, 'CR-2026-038'), expected);
  assert.throws(() => replaceBacklogEntry(trunk, source.replace('CR-2026-038', 'CR-2026-777'), 'CR-2026-038'), (e) => e.code === 'MERGE_BACKLOG_ENTRY_MISSING');
  assert.throws(() => replaceBacklogEntry(trunk + '  - id: CR-2026-038\r\n    title: duplicate\r\n', source, 'CR-2026-038'), (e) => e.code === 'MERGE_BACKLOG_ENTRY_DUPLICATE');
});

test('CR-2026-038 TASK-03：semantic tree 保留 trunk 并发条目且最终 parents 仍为 base + 原 source', () => {
  const { base, kb } = makeFixture();
  const cr = 'CR-2026-038';
  try {
    const backlog = path.join(kb, 'change-requests', '_backlog.yml');
    fs.writeFileSync(backlog, `schema: cr-backlog/v2\nchange-requests:\n  - id: ${cr}\n    title: registered\n    owner: old\n`);
    git(kb, ['add', 'change-requests/_backlog.yml']);
    git(kb, ['commit', '-q', '-m', 'register target']);
    git(kb, ['branch', 'source']);
    git(kb, ['checkout', '-q', 'source']);
    fs.writeFileSync(backlog, `schema: cr-backlog/v2\nchange-requests:\n  - id: ${cr}\n    title: source-updated\n    owners:\n      development:\n        id: Ray\n    future-v2: keep\n`);
    git(kb, ['add', 'change-requests/_backlog.yml']);
    git(kb, ['commit', '-q', '-m', 'source target update']);
    const sourceSha = git(kb, ['rev-parse', 'HEAD']);
    git(kb, ['checkout', '-q', 'master']);
    fs.writeFileSync(backlog, `schema: cr-backlog/v2\nchange-requests:\n  - id: CR-2026-001\n    title: concurrent-before\n\n  - id: ${cr}\n    title: registered\n    owner: old\n\n  - id: CR-2026-099\n    title: concurrent-after\n`);
    git(kb, ['add', 'change-requests/_backlog.yml']);
    git(kb, ['commit', '-q', '-m', 'concurrent registrations']);
    const baseSha = git(kb, ['rev-parse', 'HEAD']);
    const prepared = prepareMergeTree({ repo: { id: 'kb', rootPath: kb }, baseSha, sourceSha, cr, tmpRoot: path.join(base, 'tmp'), knowledgeBase: true });
    const final = git(kb, ['commit-tree', prepared.treeSha, '-p', baseSha, '-p', sourceSha, '-m', 'final semantic merge']);
    assert.deepEqual(git(kb, ['rev-list', '--parents', '-n', '1', final]).split(' ').slice(1), [baseSha, sourceSha]);
    const merged = git(kb, ['show', `${final}:change-requests/_backlog.yml`]);
    assert.ok(merged.includes('CR-2026-001'));
    assert.ok(merged.includes('CR-2026-099'));
    assert.ok(merged.includes('title: source-updated'));
    assert.ok(merged.includes('future-v2: keep'));
    assert.ok(!merged.includes('owner: old'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-07 AC-1/3：happy path 三仓 lease publish + detached txws 单 finalize commit，authority 切换', () => {
  const { base, kb, cr } = makeCodeApprovedFixture();
  try {
    const r = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
    if (r.json && r.json.phase === 'release-drift') console.error('DRIFT-DEBUG:', JSON.stringify(r.json.drift));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.phase, 'complete', JSON.stringify(r.json || r.errJson));
    assert.match(r.json.txId, /^[0-9a-f]{32}$/);
    assert.equal(r.json.changed, true);
    // 三仓 trunk 各多一个 merge commit（双亲 + trailer）；kb 头部是 finalize commit（单亲），merge commit 在其下
    for (const n of ['kb', 'multica', 'tools']) {
      const bare = path.join(base, `origin-${n}.git`);
      const head = git(bare, ['rev-parse', 'master']);
      if (n === 'kb') {
        const parents = git(bare, ['rev-list', '--parents', '-n', '1', 'master']).split(' ').length - 1;
        assert.equal(parents, 1, 'kb trunk 头部应为单亲 finalize commit');
        const mergeParents = git(bare, ['rev-list', '--parents', '-n', '1', 'master~1']).split(' ').length - 1;
        assert.equal(mergeParents, 2, 'kb merge commit 应为双亲');
        assert.equal(git(bare, ['cat-file', '-p', 'master~1']).includes('AI-First-Op: merge'), true, 'kb merge trailer');
      } else {
        const parents = git(bare, ['rev-list', '--parents', '-n', '1', 'master']).split(' ').length - 1;
        assert.equal(parents, 2, `${n} merge commit 应为双亲`);
        assert.equal(git(bare, ['cat-file', '-p', head]).includes('AI-First-Op: merge'), true, `${n} trailer`);
      }
    }
    // finalize：cr.md status=merging + merge-commits.yml + merge-verification.md 同 commit，lease push
    const bare = path.join(base, 'origin-kb.git');
    const kbLog = git(bare, ['log', '-3', '--format=%s']);
    assert.ok(kbLog.includes('merge finalize'));
    const finalizeCommit = git(bare, ['rev-parse', 'master']);
    const tree = git(bare, ['ls-tree', '-r', '--name-only', finalizeCommit]);
    assert.ok(tree.includes(`change-requests/${cr}/cr.md`));
    assert.ok(tree.includes(`change-requests/${cr}/merge-commits.yml`));
    assert.ok(tree.includes(`change-requests/${cr}/merge-verification.md`));
    const crMd = git(bare, ['show', `${finalizeCommit}:change-requests/${cr}/cr.md`]);
    assert.ok(crMd.includes('status: merging'), 'finalize commit 写 status=merging');
    const mc = git(bare, ['show', `${finalizeCommit}:change-requests/${cr}/merge-commits.yml`]);
    assert.ok(mc.includes('repositories:') && mc.includes('- repo: kb') && mc.includes('- repo: multica') && mc.includes('- repo: tools'), 'merge-commits.yml 完整');
    // operational_workspace 返回 detached txws
    assert.ok(fs.existsSync(r.json.operationalWorkspace));
    assert.equal(git(r.json.operationalWorkspace, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'txws 必须 detached');
    // AC-3：origin confirmed 后 txws cr.md = merging（authority 已切换到 Transaction Workspace）
    const txCrMd = fs.readFileSync(path.join(r.json.operationalWorkspace, 'change-requests', cr, 'cr.md'), 'utf8');
    assert.ok(txCrMd.includes('status: merging'), 'txws cr.md status=merging');
    // merge status 只读快照
    const st = runCrctl(['merge', 'status', cr, '--workspace', kb], { cwd: kb });
    assert.equal(st.status, 0, st.stderr);
    assert.equal(st.json.phase, 'complete');
    assert.equal(st.json.repos.length, 3);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-07 AC-1：prepare conflict 返回 MERGE_PREPARE_CONFLICT 且零远端副作用', () => {
  const f = makeCodeApprovedFixture();
  const { base, kb, others, cr } = f;
  try {
    // 竞争者在 multica trunk 上推进一个修改同文件的 commit
    const clone = path.join(base, 'rival-multica');
    git(base, ['clone', '-q', path.join(base, 'origin-multica.git'), clone]);
    git(clone, ['config', 'user.email', 'rival@aifirst.dev']);
    git(clone, ['config', 'user.name', 'Rival']);
    fs.writeFileSync(path.join(clone, 'feature.txt'), 'rival overwrite\n');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '-q', '-m', 'rival conflicting change']);
    git(clone, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
    const before = originMasterCount(base, 'kb');
    const r = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
    assert.notEqual(r.status, 0);
    assert.equal(r.errJson.error.code, 'MERGE_PREPARE_CONFLICT');
    assert.equal(originMasterCount(base, 'kb'), before, '冲突时零远端副作用');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-07 AC-1/2：第二仓 push 后 fault，重跑不重复已 confirmed push，部分发布保持 code-approved', () => {
  const { base, kb, cr } = makeCodeApprovedFixture();
  try {
    const r1 = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb, env: { CRCTL_FAULT_POINT: 'merge-after-push' } });
    assert.notEqual(r1.status, 0);
    assert.equal(r1.errJson.error.code, 'FAULT_INJECTED');
    // 第一仓（kb）已 push；其余未确认；CR status 仍 code-approved
    const st = runCrctl(['merge', 'status', cr, '--workspace', kb], { cwd: kb });
    assert.equal(st.status, 0, st.stderr);
    const kbRec = st.json.repos.find((x) => x.repo === 'kb');
    assert.equal(kbRec.pushed, true);
    const crMd = fs.readFileSync(path.join(kb, 'change-requests', cr, 'cr.md'), 'utf8');
    assert.ok(crMd.includes('status: code-approved'), '部分发布不推进 CR status');
    const r2 = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.phase, 'complete');
    // kb trunk 的 merge commit 只出现一次（重跑不重复已 confirmed push）
    const log = git(path.join(base, 'origin-kb.git'), ['log', '--format=%s', 'master']);
    assert.equal(log.split('\n').filter((l) => l.includes(`merge ${cr}: kb`)).length, 1);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-07 AC-1：push 成功响应丢失（observation 前 fault）→ 重放 classify confirmed 跳过', () => {
  const { base, kb, cr } = makeCodeApprovedFixture();
  try {
    const r1 = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb, env: { CRCTL_FAULT_POINT: 'merge-after-observation' } });
    assert.notEqual(r1.status, 0);
    assert.equal(r1.errJson.error.code, 'FAULT_INJECTED');
    // 第一仓 confirmed 已落盘；重跑从第二仓续
    const st = runCrctl(['merge', 'status', cr, '--workspace', kb], { cwd: kb });
    assert.equal(st.json.repos.find((x) => x.repo === 'kb').confirmed, true);
    const r2 = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    const log = git(path.join(base, 'origin-kb.git'), ['log', '--format=%s', 'master']);
    assert.equal(log.split('\n').filter((l) => l.includes(`merge ${cr}: kb`)).length, 1, 'confirmed 仓不得重复 push');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-07 AC-1：remote stale → rebuild 到新 origin base 续跑', () => {
  const f = makeCodeApprovedFixture();
  const { base, kb, cr } = f;
  try {
    const r1 = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb, env: { CRCTL_FAULT_POINT: 'merge-after-prepare' } });
    assert.notEqual(r1.status, 0);
    assert.equal(r1.errJson.error.code, 'FAULT_INJECTED');
    // 竞争者推进 kb trunk（非冲突文件）
    const clone = path.join(base, 'rival-kb');
    git(base, ['clone', '-q', path.join(base, 'origin-kb.git'), clone]);
    git(clone, ['config', 'user.email', 'rival@aifirst.dev']);
    git(clone, ['config', 'user.name', 'Rival']);
    fs.writeFileSync(path.join(clone, 'rival.txt'), 'rival');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '-q', '-m', 'rival trunk commit']);
    git(clone, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
    const r2 = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.phase, 'complete');
    const bare = path.join(base, 'origin-kb.git');
    const log = git(bare, ['log', '--format=%s', 'master']);
    assert.ok(log.includes('rival trunk commit'), '远端推进保留');
    assert.ok(log.includes(`merge ${cr}: kb`));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-07 AC-1：finalize stale → detached txws 从新 base 重建 finalize commit', () => {
  const f = makeCodeApprovedFixture();
  const { base, kb, cr } = f;
  try {
    const r1 = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb, env: { CRCTL_FAULT_POINT: 'merge-after-finalize-commit' } });
    assert.notEqual(r1.status, 0);
    assert.equal(r1.errJson.error.code, 'FAULT_INJECTED');
    const clone = path.join(base, 'rival-kb2');
    git(base, ['clone', '-q', path.join(base, 'origin-kb.git'), clone]);
    git(clone, ['config', 'user.email', 'rival@aifirst.dev']);
    git(clone, ['config', 'user.name', 'Rival']);
    fs.writeFileSync(path.join(clone, 'late.txt'), 'late');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '-q', '-m', 'late trunk commit']);
    git(clone, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
    const r2 = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.json.phase, 'complete');
    const bare = path.join(base, 'origin-kb.git');
    const finalizeCommit = git(bare, ['rev-parse', 'master']);
    assert.ok(git(bare, ['show', `${finalizeCommit}:change-requests/${cr}/cr.md`]).includes('status: merging'));
    assert.ok(git(bare, ['log', '--format=%s', 'master']).includes('late trunk commit'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-07 AC-1：history rewrite 硬阻断 MERGE_REMOTE_HISTORY_REWRITTEN', () => {
  const f = makeCodeApprovedFixture();
  const { base, kb, cr } = f;
  try {
    const r1 = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb, env: { CRCTL_FAULT_POINT: 'merge-after-push' } });
    assert.notEqual(r1.status, 0);
    // journal 已记录 kb pushed=true；竞争者 force push 重写 kb trunk 历史（不含我们的 merge commit）
    const clone = path.join(base, 'rival-kb3');
    git(base, ['clone', '-q', path.join(base, 'origin-kb.git'), clone]);
    git(clone, ['config', 'user.email', 'rival@aifirst.dev']);
    git(clone, ['config', 'user.name', 'Rival']);
    git(clone, ['reset', '-q', '--hard', 'HEAD~1']);
    fs.writeFileSync(path.join(clone, 'rewrite.txt'), 'rewrite');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '-q', '-m', 'rewrite history']);
    git(clone, ['push', '-q', '-f', 'origin', 'HEAD:refs/heads/master']);
    const r2 = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
    assert.notEqual(r2.status, 0);
    assert.equal(r2.errJson.error.code, 'MERGE_REMOTE_HISTORY_REWRITTEN');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-07 AC-2：零 publish 的 code drift → release-drift 回退 code-approved -> developing', () => {
  const f = makeCodeApprovedFixture();
  const { base, kb, cr } = f;
  try {
    // 被评审源 HEAD 前进（零 publish）：worktree 新增 commit
    const wt = path.join(kb, '.rayai-worktrees', 'knowledge-base', 'requirement', cr);
    fs.writeFileSync(path.join(wt, 'late.txt'), 'late change\n');
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-q', '-m', 'late change']);
    const r = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.phase, 'release-drift');
    assert.equal(r.json.advanced.to, 'developing');
    const crMd = fs.readFileSync(path.join(wt, 'change-requests', cr, 'cr.md'), 'utf8');
    assert.ok(crMd.includes('status: developing'), '回退转换写 developing');
    const log = git(path.join(base, 'origin-kb.git'), ['log', '--format=%s', 'master']);
    assert.ok(!log.includes('merge ' + cr + ':'), 'release-drift 零 merge publish');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-07 AC-1：PRD 漂移零 publish → APPROVED_ARTIFACT_DRIFT 硬阻断', () => {
  const f = makeCodeApprovedFixture();
  const { base, kb, kbWt, cr } = f;
  try {
    // PRD 漂移改 authoritative CR worktree 的受控 artifact。
    fs.writeFileSync(path.join(kbWt, 'change-requests', cr, 'prd.md'), '# PRD tampered\n');
    const r = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
    assert.notEqual(r.status, 0);
    assert.equal(r.errJson.error.code, 'APPROVED_ARTIFACT_DRIFT');
    const log = git(path.join(base, 'origin-kb.git'), ['log', '--format=%s', 'master']);
    assert.ok(!log.includes('merge ' + cr + ':'), '零远端副作用');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

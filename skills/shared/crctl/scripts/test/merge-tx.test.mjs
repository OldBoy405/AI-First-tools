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

const CRCTL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'crctl.mjs');
const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const YEAR = String(new Date().getFullYear());

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, input: opts.input });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return (r.stdout || '').trim();
}

function runCrctl(args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [CRCTL, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: parse(r.stdout), errJson: parse(r.stderr) };
}

/** 三仓 + 三 bare origin fixture；kb 为 knowledge-base role 且是 InstWS。 */
function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'crctl-merge-'));
  const kb = path.join(base, 'kb');
  const others = { multica: path.join(base, 'multica'), tools: path.join(base, 'tools') };
  for (const n of ['kb', 'multica', 'tools']) git(base, ['init', '-q', '--bare', '-b', 'master', `origin-${n}.git`]);
  const initRepo = (wd, originName) => {
    fs.mkdirSync(wd, { recursive: true });
    git(wd, ['init', '-q', '-b', 'master']);
    git(wd, ['config', 'user.email', 'test@aifirst.dev']);
    git(wd, ['config', 'user.name', 'Test']);
    git(wd, ['remote', 'add', 'origin', path.join(base, `origin-${originName}.git`)]);
  };
  initRepo(kb, 'kb');
  initRepo(others.multica, 'multica');
  initRepo(others.tools, 'tools');
  // 最小 tools 包：merge 消费真实 gates/pipeline/dir-graph（从真实 tools 包复制，不复制门禁语义）
  const pkg = path.join(base, 'tools-pkg');
  fs.mkdirSync(path.join(pkg, 'skills', 'shared', 'crctl', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'pipeline-templates'), { recursive: true });
  const realTools = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..'); // scripts/test -> tools 根
  fs.copyFileSync(path.join(realTools, 'skills', 'shared', 'crctl', 'gates.json'), path.join(pkg, 'skills', 'shared', 'crctl', 'gates.json'));
  fs.copyFileSync(path.join(realTools, 'pipeline-templates', 'code-implementation.pipeline.json'), path.join(pkg, 'pipeline-templates', 'code-implementation.pipeline.json'));
  fs.copyFileSync(path.join(realTools, 'dir-graph.yaml'), path.join(pkg, 'dir-graph.yaml'));
  fs.writeFileSync(path.join(pkg, 'AGENTS.md'), '');
  fs.writeFileSync(path.join(pkg, 'skills', '_index.yml'), '');
  fs.writeFileSync(path.join(pkg, 'skills', 'shared', 'crctl', 'scripts', 'crctl.mjs'), '');
  fs.mkdirSync(path.join(kb, 'change-requests'), { recursive: true });
  fs.writeFileSync(path.join(kb, '.gitignore'), '.rayai-worktrees/\n.crctl/\n');
  fs.writeFileSync(path.join(kb, 'change-requests', '_backlog.yml'), 'schema: cr-backlog/v2\nchange-requests:\n');
  fs.writeFileSync(path.join(kb, 'change-requests', '_index.yml'), 'change-requests:\n');
  fs.writeFileSync(path.join(kb, 'dir-graph.yaml'), [
    'schema: "ai-first.tools.dir-graph/v1"',
    'workspace:',
    '  root: "."',
    '  tools_package_path: "../tools-pkg"',
    'repositories:',
    '  - id: kb',
    '    path: "."',
    '    trunk: master',
    '    role: knowledge-base',
    '  - id: multica',
    '    path: "../multica"',
    '    trunk: master',
    '    role: code',
    '  - id: tools',
    '    path: "../tools"',
    '    trunk: master',
    '    role: code',
    '',
  ].join('\n'));
  for (const wd of [kb, others.multica, others.tools]) {
    git(wd, ['add', '-A']);
    git(wd, ['commit', '-q', '--allow-empty', '-m', 'init']);
    git(wd, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
  }
  return { base, kb, others };
}

/** 手工构造 code-approved 状态（TASK-06 模型）：评审产物在主 checkout（master）提交，
 * worktree 分支是只读被评审源（HEAD 恒定 = reviewed-source-sha）。 */
function makeCodeApprovedFixture() {
  const f = makeFixture();
  const { base, kb, others } = f;
  const cr = `CR-${YEAR}-042`;
  // 1) kb master：注册账本 + cr.md(code-approved) + plan/tasks/test-report
  fs.writeFileSync(path.join(kb, 'change-requests', '_backlog.yml'),
    `schema: cr-backlog/v2\nchange-requests:\n  - id: ${cr}\n    title: Merge Test\n    status: code-approved\n`);
  fs.writeFileSync(path.join(kb, 'change-requests', '_index.yml'), `change-requests:\n  - id: ${cr}\n    title: Merge Test\n`);
  const kbCr = path.join(kb, 'change-requests', cr);
  fs.mkdirSync(path.join(kbCr, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(kbCr, 'cr.md'),
    `---\nid: ${cr}\nstatus: code-approved\nupdated-at: "2026-08-11T21:00:00+08:00"\n---\n`);
  fs.writeFileSync(path.join(kbCr, 'prd.md'), '# PRD\n');
  fs.writeFileSync(path.join(kbCr, 'sdd.md'), '# SDD\n');
  fs.writeFileSync(path.join(kbCr, 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(kbCr, 'tasks', '_index.yml'), 'tasks:\n  - id: ' + cr + '-TASK-01\n');
  fs.writeFileSync(path.join(kbCr, 'tasks', 'TASK-01.md'), '# TASK-01\n');
  fs.writeFileSync(path.join(kbCr, 'test-report.md'), '---\nstatus: pass\n---\n');
  git(kb, ['add', '-A']);
  git(kb, ['commit', '-q', '-m', `register ${cr}`]);
  git(kb, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
  // 2) 各仓 requirement 分支 + feature 提交 + worktree + push（被评审源 HEAD 恒定）
  const headByRepo = {};
  for (const [repo, wd] of Object.entries({ kb, ...others })) {
    git(wd, ['branch', `requirement/${cr}`, 'master']);
    const wt = path.join(kb, '.rayai-worktrees', repo === 'kb' ? 'knowledge-base' : repo, 'requirement', cr);
    git(wd, ['worktree', 'add', wt, `requirement/${cr}`]);
    fs.writeFileSync(path.join(wt, repo === 'kb' ? 'kb-feature.txt' : 'feature.txt'), `feature ${repo}\n`);
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-q', '-m', `feature ${repo}`]);
    headByRepo[repo] = git(wt, ['rev-parse', 'HEAD']);
    git(wt, ['push', '-q', 'origin', 'HEAD:refs/heads/requirement/' + cr]);
  }
  // 3) kb master 补评审证据（release-subjects 引用各仓 feature HEAD）
  // collectControlledArtifacts 按 POSIX 字典序（plan.md < prd.md < sdd.md < tasks/TASK-01.md < tasks/_index.yml 注意 'T' < '_'）
  const files = [
    `change-requests/${cr}/plan.md`,
    `change-requests/${cr}/prd.md`,
    `change-requests/${cr}/sdd.md`,
    `change-requests/${cr}/tasks/TASK-01.md`,
    `change-requests/${cr}/tasks/_index.yml`,
  ];
  const shaOf = (rel) => sha256(fs.readFileSync(path.join(kb, ...rel.split('/')), 'utf8').replaceAll('\r\n', '\n'));
  const artifacts = {
    algorithm: 'sha256', canonicalization: 'crlf-to-lf+path-sort',
    files: files.map((x) => ({ path: x, sha256: shaOf(x) })),
  };
  artifacts.digest = sha256(artifacts.files.map((x) => `${x.path}:${x.sha256}`).join('\n'));
  const rs = {
    version: 1,
    repositories: [
      { repo: 'kb', remoteRef: `refs/heads/requirement/${cr}`, reviewedSourceSha: headByRepo.kb },
      { repo: 'multica', remoteRef: `refs/heads/requirement/${cr}`, reviewedSourceSha: headByRepo.multica },
      { repo: 'tools', remoteRef: `refs/heads/requirement/${cr}`, reviewedSourceSha: headByRepo.tools },
    ],
    artifacts,
  };
  const rsLines = ['release-subjects:', '  version: 1', '  repositories:'];
  for (const r of rs.repositories) rsLines.push(`    - repo: ${r.repo}`, `      remote-ref: ${r.remoteRef}`, `      reviewed-source-sha: ${r.reviewedSourceSha}`);
  rsLines.push('  artifacts:', '    algorithm: sha256', '    canonicalization: crlf-to-lf+path-sort', '    files:');
  for (const x of artifacts.files) rsLines.push(`      - { path: ${x.path}, sha256: ${x.sha256} }`);
  rsLines.push(`    digest: ${artifacts.digest}`);
  fs.mkdirSync(path.join(kbCr, 'review-annotations'), { recursive: true });
  fs.writeFileSync(path.join(kbCr, 'review-annotations', 'dev-plan.yml'),
    'cr-id: ' + cr + '\nreview-type: dev-plan\nverdict: pass\nblockers: []\ndimensions:\n  sdd-to-plan: ok\n');
  fs.writeFileSync(path.join(kbCr, 'review-annotations', 'code.yml'),
    'verdict: pass\nblockers: []\ndimensions:\n  spec-conformance: ok\nsuggestions: []\n' + rsLines.join('\n') + '\n');
  const digestOf = (texts) => sha256(texts.map((t) => sha256(t.replaceAll('\r\n', '\n'))).join(''));
  const devDigest = digestOf([
    fs.readFileSync(path.join(kbCr, 'plan.md'), 'utf8'),
    fs.readFileSync(path.join(kbCr, 'review-annotations', 'dev-plan.yml'), 'utf8'),
  ]);
  const codeDigest = digestOf([
    fs.readFileSync(path.join(kbCr, 'review-annotations', 'code.yml'), 'utf8'),
    fs.readFileSync(path.join(kbCr, 'test-report.md'), 'utf8'),
  ]);
  fs.writeFileSync(path.join(kbCr, 'approval.yml'),
    'development-start:\n  approver: "alice"\n  approved-at: "2026-08-11T21:00:00+08:00"\n  via: crctl-approve\n  evidence-digest: "' + devDigest + '"\n  target-status: "developing"\n' +
    'code:\n  approver: "alice"\n  approved-at: "2026-08-11T21:30:00+08:00"\n  via: crctl-approve\n  evidence-digest: "' + codeDigest + '"\n  target-status: "code-approved"\n' + rsLines.map((l) => `  ${l}`).join('\n') + '\n');
  git(kb, ['add', '-A']);
  git(kb, ['commit', '-q', '-m', 'review evidence']);
  git(kb, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
  // 主 checkout 的 remote-tracking ref 对齐（worktree push 不更新主 checkout 的 refs/remotes）
  git(kb, ['fetch', '-q', 'origin']);
  return { ...f, cr, kbWt: path.join(kb, '.rayai-worktrees', 'knowledge-base', 'requirement', cr), headByRepo };
}

const originMasterCount = (base, name) => Number(git(path.join(base, `origin-${name}.git`), ['rev-list', '--count', 'master']));

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
    const crMd = fs.readFileSync(path.join(kb, 'change-requests', cr, 'cr.md'), 'utf8');
    assert.ok(crMd.includes('status: developing'), '回退转换写 developing');
    const log = git(path.join(base, 'origin-kb.git'), ['log', '--format=%s', 'master']);
    assert.ok(!log.includes('merge ' + cr + ':'), 'release-drift 零 merge publish');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('TASK-07 AC-1：PRD 漂移零 publish → APPROVED_ARTIFACT_DRIFT 硬阻断', () => {
  const f = makeCodeApprovedFixture();
  const { base, kb, cr } = f;
  try {
    // PRD 漂移改主 checkout 的受控 artifact（verify 从 kb.rootPath 读）
    fs.writeFileSync(path.join(kb, 'change-requests', cr, 'prd.md'), '# PRD tampered\n');
    const r = runCrctl(['merge', cr, '--workspace', kb], { cwd: kb });
    assert.notEqual(r.status, 0);
    assert.equal(r.errJson.error.code, 'APPROVED_ARTIFACT_DRIFT');
    const log = git(path.join(base, 'origin-kb.git'), ['log', '--format=%s', 'master']);
    assert.ok(!log.includes('merge ' + cr + ':'), '零远端副作用');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

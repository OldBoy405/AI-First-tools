// CR-2026-031 TASK-07/08 共享 fixture：三 bare remote + 手工 code-approved 状态（TASK-06 模型）。
// 评审产物与审批事实写入 knowledge-base CR worktree；reviewed-source-sha 固定评审前 feature HEAD。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CRCTL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'crctl.mjs');
export const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const YEAR = String(new Date().getFullYear());

export function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, input: opts.input });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return (r.stdout || '').trim();
}

export function runCrctl(args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [CRCTL, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: parse(r.stdout), errJson: parse(r.stderr) };
}

/** 三仓 + 三 bare origin fixture；kb 为 knowledge-base role 且是 InstWS。 */
export function makeFixture() {
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
  // TASK-08：specs/ 与 done 任务随 init 进 trunk（merge 后 txws 才有回写基线）
  fs.mkdirSync(path.join(kb, 'specs', 'test-spec'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'specs', '_index.yml'), 'schema: specs-index/v1\nupdated: "2026-08-01T00:00:00+08:00"\n\nfeatures:\n  - id: test-spec\n    name: Test\n    scope: product\n    status: ga\n    since: "0.1"\n    current: "0.1"\n    brief: ""\n    cr-ref: CR-2000-001\n    cr-history: [CR-2000-001]\n    updated: "2026-08-01T00:00:00+08:00"\n');
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

/** 手工构造 code-approved 状态（TASK-06 模型）：评审/审批证据写入 CR worktree，
 * reviewed-source-sha 固定其写入前的 feature HEAD。 */
export function makeCodeApprovedFixture() {
  const f = makeFixture();
  const { base, kb, others } = f;
  const cr = `CR-${YEAR}-042`;
  // 1) kb master：注册账本 + cr.md(code-approved) + plan/tasks/test-report
  fs.writeFileSync(path.join(kb, 'change-requests', '_backlog.yml'),
    `schema: cr-backlog/v2\nchange-requests:\n  - id: ${cr}\n    title: Merge Test\n    status: code-approved\n    owner: alice\n`);
  fs.writeFileSync(path.join(kb, 'change-requests', '_index.yml'), `change-requests:\n  - id: ${cr}\n    title: Merge Test\n`);
  let kbCr = path.join(kb, 'change-requests', cr);
  fs.mkdirSync(path.join(kbCr, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(kbCr, 'cr.md'),
    `---\nid: ${cr}\nstatus: code-approved\nupdated-at: "2026-08-11T21:00:00+08:00"\n---\n`);
  fs.writeFileSync(path.join(kbCr, 'prd.md'), '# PRD\n');
  fs.writeFileSync(path.join(kbCr, 'sdd.md'), '# SDD\n');
  fs.writeFileSync(path.join(kbCr, 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(kbCr, 'tasks', '_index.yml'), 'tasks:\n  - id: ' + cr + '-TASK-01\n    title: t1\n    status: done\n    estimate: 1h\n');
  fs.writeFileSync(path.join(kbCr, 'tasks', 'TASK-01.md'), '---\nid: ' + cr + '-TASK-01\ntype: TASK\ncr-ref: ' + cr + '\ntitle: t1\nstatus: pending\nslug: task-01\nestimate: 1h\n---\n# TASK-01\n');
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
  // 3) knowledge-base CR worktree 补评审/审批证据；release-subjects 引用写入前的各仓 feature HEAD。
  const kbWt = path.join(kb, '.rayai-worktrees', 'knowledge-base', 'requirement', cr);
  kbCr = path.join(kbWt, 'change-requests', cr);
  // collectControlledArtifacts 按 POSIX 字典序（plan.md < prd.md < sdd.md < tasks/TASK-01.md < tasks/_index.yml 注意 'T' < '_'）
  const files = [
    `change-requests/${cr}/plan.md`,
    `change-requests/${cr}/prd.md`,
    `change-requests/${cr}/sdd.md`,
    `change-requests/${cr}/tasks/TASK-01.md`,
    `change-requests/${cr}/tasks/_index.yml`,
  ];
  const shaOf = (rel) => sha256(fs.readFileSync(path.join(kbWt, ...rel.split('/')), 'utf8').replaceAll('\r\n', '\n'));
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
  git(kbWt, ['add', '-A']);
  git(kbWt, ['commit', '-q', '-m', 'review evidence']);
  git(kbWt, ['push', '-q', 'origin', `HEAD:refs/heads/requirement/${cr}`]);
  git(kb, ['fetch', '-q', 'origin']);
  return { ...f, cr, kbWt, headByRepo };
}

export const originMasterCount = (base, name) => Number(git(path.join(base, `origin-${name}.git`), ['rev-list', '--count', 'master']));

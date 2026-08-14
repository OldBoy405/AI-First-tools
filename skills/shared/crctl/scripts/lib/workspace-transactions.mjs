/* ────────────────────────── workspace-transactions.mjs（CR-2026-031） ──────────────────────────
 * 执行层职责边界（ADR-0004）：Git/workspace 事务与 authority 判定只存在于本模块与 durable-tx.mjs。
 * TASK-03 落地：唯一 repository resolver、canonical workspace 路径、phase authority 判定。
 * 后续 TASK-05/07/08/09 在本文件追加五个业务处理器；crctl.mjs 通过 import 薄接线，
 * 本模块不得反向依赖 crctl.mjs，不得成为第二 CLI。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml-subset.mjs';
import {
  TxError, acquireLock, loadExistingJournal, loadOrCreateJournal, saveJournal, applyWriteSet, recoverWriteSet, faultPoint, nowIso,
} from './durable-tx.mjs';
export { TxError } from './durable-tx.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Installation Workspace（InstWS）：dir-graph.yaml、.rayai-worktrees/ 与 .crctl/ 的解析基准。
 * linked worktree 场景 git common-dir 指向主 checkout 的 .git，其 dirname 即主 checkout 根；
 * 非 git 目录（普通 checkout / 测试临时目录）回退 opWs。仅 spawn git 只读查询，无副作用。
 * （原 crctl.mjs 同名函数原样迁入；crctl.mjs 自 TASK-03 起 re-import，不得复刻。）
 */
export function deriveInstallRoot(opWs) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: opWs, encoding: 'utf8', shell: false });
  if (r.status === 0 && r.stdout && r.stdout.trim()) {
    const commonDir = path.resolve(opWs, r.stdout.trim());
    return path.dirname(commonDir);
  }
  return opWs;
}

const REPO_ROLES = ['knowledge-base', 'code'];
const CR_DIR_RE = /^CR-\d{4}-\d{3,}$/;
/** merge finalize 之后写 authority 切换到 detached Transaction Workspace（SDD §1.3）。 */
const POST_FINALIZE_STATUSES = new Set(['merging', 'writing-back', 'archived']);

/** detached knowledge-base Transaction Workspace 的唯一路径约定（.crctl 为运行时目录，不入 Git）。 */
export function txWorkspacePath(ctx, cr) {
  return path.join(ctx.installRoot, '.crctl', 'transaction-workspaces', cr);
}

export function crWorktreePath(ctx, cr) {
  const kb = getRepository(ctx, ctx.knowledgeBaseRepoId);
  return path.join(kb.worktreePath, cr);
}

/**
 * 唯一 repository resolver：只读 {InstWS}/dir-graph.yaml#repositories。
 * - active === false 的仓不进 repositories（仅登记 id 供 getRepository 报 REPO_INACTIVE）；
 * - bucket 由 role 派生（knowledge-base role → 'knowledge-base'，否则 = repo id），不写死任何 repo id；
 * - path 拒绝 absolute；解析后必须存在；realpath 只允许"父目录 realpath + 字面 basename"，
 *   即末段 symlink/junction 指向他处一律 REPO_PATH_ESCAPE；
 * - 输出按 id 排序；graphDigest = 声明字段 canonical JSON 的 sha256（机器无关，供 journal 漂移检测）。
 * 当 workspace 本身位于某仓 CR worktree（.rayai-worktrees/{bucket}/requirement/{CR-*}）内时，
 * 顶层附带 cr/branch（否则为 null）。
 */
export function resolveRepositories(workspace) {
  const installRoot = deriveInstallRoot(workspace);
  const cfgPath = path.join(installRoot, 'dir-graph.yaml');
  let text;
  try { text = fs.readFileSync(cfgPath, 'utf8'); }
  catch { throw new TxError('REPO_GRAPH_NOT_FOUND', `缺少 ${cfgPath}（repositories 声明是仓库解析的唯一事实源）`, { cfgPath }); }
  const doc = parseYaml(text.replaceAll('\r\n', '\n'));
  const list = doc && doc.repositories;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TxError('REPO_GRAPH_INVALID', 'dir-graph.yaml#repositories 缺失或为空', { cfgPath });
  }
  const repositories = [];
  const inactiveRepoIds = [];
  const seen = new Set();
  for (const r of list) {
    if (!r || typeof r !== 'object') throw new TxError('REPO_GRAPH_INVALID', 'repositories 条目不是映射');
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) throw new TxError('REPO_GRAPH_INVALID', 'repositories 条目缺少 id');
    if (seen.has(id)) throw new TxError('REPO_GRAPH_INVALID', `repositories id 重复: ${id}`);
    seen.add(id);
    if (r.active === false) { inactiveRepoIds.push(id); continue; }
    if (!REPO_ROLES.includes(r.role)) {
      throw new TxError('REPO_GRAPH_INVALID', `repo ${id}: role=${r.role} 非法（仅 ${REPO_ROLES.join('/')}`);
    }
    const declPath = typeof r.path === 'string' ? r.path.trim() : '';
    if (!declPath) throw new TxError('REPO_GRAPH_INVALID', `repo ${id}: 缺少 path`);
    if (path.isAbsolute(declPath)) throw new TxError('REPO_GRAPH_INVALID', `repo ${id}: path 必须是相对声明路径，收到 absolute: ${declPath}`);
    const trunk = typeof r.trunk === 'string' ? r.trunk.trim() : '';
    if (!trunk) throw new TxError('REPO_GRAPH_INVALID', `repo ${id}: 缺少 trunk`);
    const canonical = path.resolve(installRoot, declPath);
    let real;
    try { real = fs.realpathSync(canonical); }
    catch { throw new TxError('REPO_PATH_NOT_FOUND', `repo ${id}: path 不存在: ${canonical}`, { id, declared: declPath }); }
    let parentReal;
    try { parentReal = fs.realpathSync(path.dirname(canonical)); }
    catch { throw new TxError('REPO_PATH_NOT_FOUND', `repo ${id}: 父目录不存在: ${path.dirname(canonical)}`, { id, declared: declPath }); }
    if (real !== path.join(parentReal, path.basename(canonical))) {
      throw new TxError('REPO_PATH_ESCAPE', `repo ${id}: path 末段是 symlink/junction 且指向他处（realpath=${real}）`, { id, declared: declPath, realpath: real });
    }
    const bucket = r.role === 'knowledge-base' ? 'knowledge-base' : id;
    repositories.push({
      id, role: r.role, path: declPath, trunk, bucket,
      rootPath: real,
      worktreePath: path.join(installRoot, '.rayai-worktrees', bucket, 'requirement'),
    });
  }
  repositories.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kb = repositories.filter((r) => r.role === 'knowledge-base');
  if (kb.length !== 1) {
    throw new TxError('REPO_GRAPH_INVALID', `repositories 必须恰好含 1 个 active knowledge-base role 仓，实际 ${kb.length}`);
  }
  const graphDigest = sha256(JSON.stringify(repositories.map((r) => ({ id: r.id, role: r.role, path: r.path, trunk: r.trunk, bucket: r.bucket }))));
  // CR worktree 反解：workspace 位于 {InstWS}/.rayai-worktrees/{bucket}/requirement/{CR-*} 内时给出 cr/branch
  let cr = null;
  let branch = null;
  const wsReal = (() => { try { return fs.realpathSync(path.resolve(workspace)); } catch { return path.resolve(workspace); } })();
  for (const r of repositories) {
    const prefix = r.worktreePath + path.sep;
    if (!wsReal.startsWith(prefix)) continue;
    const seg = wsReal.slice(prefix.length).split(path.sep)[0];
    if (CR_DIR_RE.test(seg)) { cr = seg; branch = `requirement/${seg}`; break; }
  }
  return { installRoot, repositories, graphDigest, knowledgeBaseRepoId: kb[0].id, inactiveRepoIds, cr, branch };
}

/** 按 id 查 active repo；inactive 与未声明分别返回精确错误（repo rename 场景 = REPO_NOT_FOUND）。 */
export function getRepository(ctx, id) {
  const hit = ctx.repositories.find((r) => r.id === id);
  if (hit) return hit;
  if (ctx.inactiveRepoIds.includes(id)) {
    throw new TxError('REPO_INACTIVE', `repo ${id} 已声明 inactive，不参与 CR 事务`, { id });
  }
  throw new TxError('REPO_NOT_FOUND', `repo ${id} 未在 dir-graph.yaml#repositories 声明（rename 后必须更新声明）`, { id });
}

function readCrMdStatus(ws, cr) {
  const p = path.join(ws, 'change-requests', cr, 'cr.md');
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return null; }
  const norm = text.replaceAll('\r\n', '\n');
  const fm = norm.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const s = fm[1].match(/^status:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return s ? s[1] : null;
}

/**
 * phase authority resolver（SDD §1.3）：
 * - register～code-approved：authority = CR requirement worktree（source 'cr-worktree'）；
 * - merge finalize 之后（merging/writing-back/archived）：authority = detached Transaction Workspace
 *   （source 'transaction-workspace'）。判定依据（TASK-08 修正）：CR worktree 是被评审只读源，
 *   merge finalize 后其 cr.md 仍为 code-approved——post-finalize 事实来自 merge journal 的
 *   operationalWorkspace（merge origin confirmed 后唯一写入点），txws 缺失或状态不自洽一律硬失败。
 * 用户主 checkout 永远不是返回值。
 */
export function resolveOperationalWorkspace(ctx, cr) {
  const crWorktree = crWorktreePath(ctx, cr);
  const status = readCrMdStatus(crWorktree, cr);
  if (status == null) {
    throw new TxError('CR_WORKTREE_STATUS_MISSING', `${cr}: CR worktree 的 cr.md 缺少 status（${path.join(crWorktree, 'change-requests', cr, 'cr.md')}）`, { cr, crWorktree });
  }
  if (!POST_FINALIZE_STATUSES.has(status)) {
    // CR worktree 未进 finalize 态：查 merge journal 的 operationalWorkspace（origin confirmed 事实）
    const ms = mergeStatus(ctx, cr);
    if (ms.phase === 'complete' && ms.operationalWorkspace) {
      const txStatus = readCrMdStatus(ms.operationalWorkspace, cr);
      if (POST_FINALIZE_STATUSES.has(txStatus)) {
        return { phase: txStatus, path: ms.operationalWorkspace, source: 'transaction-workspace' };
      }
      throw new TxError('OPERATIONAL_WORKSPACE_INCONSISTENT', `${cr}: merge journal 指向 txws 但 cr.md status=${txStatus}，与 finalize 后阶段不符`, { cr, crWorktreeStatus: status, txStatus });
    }
    return { phase: status, path: crWorktree, source: 'cr-worktree' };
  }
  const txws = txWorkspacePath(ctx, cr);
  if (!fs.existsSync(txws)) {
    throw new TxError('OPERATIONAL_WORKSPACE_MISSING', `${cr}: status=${status} 属 finalize 后阶段，但 Transaction Workspace 不存在: ${txws}`, { cr, status, txws });
  }
  const txStatus = readCrMdStatus(txws, cr);
  if (!POST_FINALIZE_STATUSES.has(txStatus)) {
    throw new TxError('OPERATIONAL_WORKSPACE_INCONSISTENT', `${cr}: Transaction Workspace cr.md status=${txStatus}，与 finalize 后阶段不符`, { cr, crWorktreeStatus: status, txStatus });
  }
  return { phase: txStatus, path: txws, source: 'transaction-workspace' };
}

/* ────────────────────────── Git 受控执行（TASK-05 起） ──────────────────────────
 * 事务内全部 Git 副作用只经 gitMust 发生；refspec/lease 由各业务处理器显式给出，
 * 不接受调用方任意 refspec（SDD §8.1）。 */
export function gitRun(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, input: opts.input, env: opts.env ? { ...process.env, ...opts.env } : process.env });
  return { status: r.status == null ? -1 : r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

export function gitMust(cwd, args, opts = {}) {
  const r = gitRun(cwd, args, opts);
  if (r.status !== 0) {
    throw new TxError('TX_GIT_FAILED', `git ${args.join(' ')} 失败（exit=${r.status}）: ${r.stderr || r.stdout}`, { cwd, args, stderr: r.stderr });
  }
  return r.stdout;
}

/** frontmatter 匹配（自 crctl.mjs 原样提取，merge finalize 与 crctl 共用，禁止复刻）。 */
export function matchFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? { match: m[0], body: m[1] } : null;
}

/** cr.md 状态文本生成纯函数（status + updated-at 更新；自 crctl.mjs 原样提取）。 */
export function crMdStatusText(text, newStatus, opts = {}) {
  const m = matchFrontmatter(text);
  if (!m) return null;
  let fm = m.body;
  if (/^status:\s*.*$/m.test(fm)) fm = fm.replace(/^status:\s*.*$/m, `status: ${newStatus}`);
  else fm = fm + `\nstatus: ${newStatus}`;
  if (/^updated-at:\s*.*$/m.test(fm)) fm = fm.replace(/^updated-at:\s*.*$/m, `updated-at: "${opts.at || nowIso()}"`);
  return text.replace(m.match, `---\n${fm}\n---`);
}

/* ────────────────────────── CR-ID 分配（原 crctl.mjs 同名函数迁入，TASK-05） ────────────────────────── */

export function formatCrId(year, n) { return `CR-${year}-${String(n).padStart(3, '0')}`; }

export function scanMaxCrNumber(kbRoot, year) {
  const re = new RegExp('^CR-' + year + '-(\\d{3})$');
  let max = 0;
  for (const p of [path.join(kbRoot, 'change-requests', '_index.yml'), path.join(kbRoot, 'change-requests', '_backlog.yml')]) {
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const m of text.replaceAll('\r\n', '\n').matchAll(/^\s*- id:\s*["']?(CR-\d{4}-\d{3})["']?\s*$/gm)) {
      const mm = m[1].match(re);
      if (mm) max = Math.max(max, Number(mm[1]));
    }
  }
  return max;
}

/** TASK-02 schema 门禁的唯一实现（原 crctl.mjs assertSupportedBacklogSchema 下沉；crctl re-import 包 fail 语义）。 */
export function assertSupportedBacklogSchemaText(text) {
  const norm = String(text).replaceAll('\r\n', '\n');
  const m = norm.match(/^schema:\s*["']?([^\s"'#]+)["']?\s*$/m);
  if (!m || m[1] !== 'cr-backlog/v2') {
    throw new TxError('UNSUPPORTED_BACKLOG_SCHEMA', `_backlog.yml schema=${m ? m[1] : '(missing)'}：仅支持 cr-backlog/v2（v1 兼容与 migrate-backlog 已随 CR-2026-031 TASK-02 删除）`, { schema: m ? m[1] : null });
  }
}

const yamlScalarLib = (v) => (/^[\w./-]+$/.test(String(v)) ? String(v) : `"${String(v).replaceAll('"', '\\"')}"`);

/** 注册三账本条目的唯一模板（原 cmdCrInit 内联模板下沉；cr-init 与 register 共用）。 */
export function buildRegistrationTexts({ cr, title, summary, source, targetVersion, owners, now }) {
  const ownerSlot = (id, indent) => [`${' '.repeat(indent)}id: ${id}`, `${' '.repeat(indent)}assigned-at: "${now}"`];
  const { requirement: req, development: dev, test: tst } = owners;
  const crMdText = [
    '---',
    `id: ${cr}`,
    `title: ${String(title).replaceAll('"', '\\"')}`,
    `summary: ${yamlScalarLib(summary)}`,
    `owner: ${req}`,
    'owners:',
    '  requirement:',
    ...ownerSlot(req, 4),
    '  development:',
    ...ownerSlot(dev, 4),
    '  test:',
    ...ownerSlot(tst, 4),
    `target-version: ${yamlScalarLib(targetVersion)}`,
    `source: ${yamlScalarLib(source)}`,
    'status: drafting',
    `created: "${now}"`,
    `updated: "${now}"`,
    'remote-ref: ""',
    'last-push-at: ""',
    'last-push-by: ""',
    'owner-history:',
    `  - { role: requirement, from: "", to: ${req}, at: "${now}", reason: initial-assignment }`,
    `  - { role: development, from: "", to: ${dev}, at: "${now}", reason: initial-assignment }`,
    `  - { role: test, from: "", to: ${tst}, at: "${now}", reason: initial-assignment }`,
    'handover-history: []',
    '---',
    '',
  ].join('\n');
  const backlogEntry = [
    `  - id: ${cr}`,
    `    title: ${String(title).replaceAll('"', '\\"')}`,
    `    summary: ${yamlScalarLib(summary)}`,
    `    owner: ${req}`,
    '    owners:',
    '      requirement:',
    ...ownerSlot(req, 8),
    '      development:',
    ...ownerSlot(dev, 8),
    '      test:',
    ...ownerSlot(tst, 8),
    `    target-version: ${yamlScalarLib(targetVersion)}`,
    `    source: ${yamlScalarLib(source)}`,
    '    prd-path: ""',
    `    created: "${now}"`,
    `    updated: "${now}"`,
  ].join('\n');
  const indexEntry = [
    `  - id: ${cr}`,
    `    title: ${String(title).replaceAll('"', '\\"')}`,
    '    status: drafting',
    `    created: "${now}"`,
  ].join('\n');
  return { crMdText, backlogEntry, indexEntry };
}

/* ────────────────────────── 远端事实分类（SDD §5.1，原样实现） ────────────────────────── */

export function classifyRemoteCommit({ remoteSha, expectedBase, commitSha, commitIsRemoteAncestor, journalSaysPublished }) {
  if (commitIsRemoteAncestor) return 'confirmed';
  if (journalSaysPublished) return 'history-rewritten';
  if (remoteSha === expectedBase) return 'pushable';
  return 'rebuild';
}

/* ────────────────────────── workspace 分类与补齐（SDD §4.2，TASK-05） ────────────────────────── */

export const WORKSPACE_CLASSIFICATIONS = ['missing', 'healthy', 'branch-only', 'remote-only', 'dirty', 'wrong-branch', 'path-unregistered'];

export function branchForCr(cr) { return `requirement/${cr}`; }

/** 单仓 workspace 事实分类：只读，零写入。 */
export function classifyRepoWorkspace(ctx, repo, cr) {
  const branch = branchForCr(cr);
  const wtPath = path.join(repo.worktreePath, cr);
  const info = { repo: repo.id, branch, worktreePath: wtPath, classification: null, dirty: false, head: null, localBranch: false, remoteBranch: false };
  info.localBranch = gitRun(repo.rootPath, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).status === 0;
  info.remoteBranch = gitRun(repo.rootPath, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]).status === 0;
  if (!fs.existsSync(wtPath)) {
    info.classification = info.localBranch ? 'branch-only' : info.remoteBranch ? 'remote-only' : 'missing';
    return info;
  }
  const real = (() => { try { return fs.realpathSync(wtPath); } catch { return wtPath; } })();
  const list = gitRun(repo.rootPath, ['worktree', 'list', '--porcelain']);
  const registered = list.status === 0 && list.stdout.split(/\r?\n/).some((l) => {
    if (!l.startsWith('worktree ')) return false;
    const p = l.slice('worktree '.length);
    try { return fs.realpathSync(p) === real; } catch { return p === wtPath; }
  });
  if (!registered) { info.classification = 'path-unregistered'; return info; }
  info.dirty = gitRun(wtPath, ['status', '--porcelain']).stdout !== '';
  info.head = gitRun(wtPath, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout || null;
  if (info.dirty) { info.classification = 'dirty'; return info; }
  if (info.head !== branch) { info.classification = 'wrong-branch'; return info; }
  info.classification = 'healthy';
  return info;
}

/** 只补齐可由 Git + graph 证明归属的资源；dirty/wrong-branch/path-unregistered 一律硬阻断零写入。 */
export function ensureRepoWorkspace(ctx, repo, cr) {
  const info = classifyRepoWorkspace(ctx, repo, cr);
  const branch = info.branch;
  const wtPath = info.worktreePath;
  const create = (how) => {
    fs.mkdirSync(repo.worktreePath, { recursive: true });
    gitMust(repo.rootPath, ['worktree', 'add', wtPath, branch]);
    return { ...classifyRepoWorkspace(ctx, repo, cr), action: `created:${how}` };
  };
  switch (info.classification) {
    case 'healthy':
      return { ...info, action: 'none' };
    case 'missing':
      if (info.remoteBranch) gitMust(repo.rootPath, ['branch', '--track', branch, `origin/${branch}`]);
      else gitMust(repo.rootPath, ['branch', branch, repo.trunk]);
      return create(info.remoteBranch ? 'from-remote' : 'from-trunk');
    case 'remote-only':
      gitMust(repo.rootPath, ['branch', '--track', branch, `origin/${branch}`]);
      return create('from-remote');
    case 'branch-only':
      return create('from-local-branch');
    default:
      throw new TxError('WORKSPACE_ENSURE_BLOCKED', `${repo.id}: workspace 分类=${info.classification}，ensure 零写入硬阻断（需人工处理）`, { ...info });
  }
}

/* ────────────────────────── registerCr（SDD §4.1，TASK-05） ────────────────────────── */

function buildSideEffects(payload) {
  const se = [];
  if (payload.cr) se.push({ kind: 'cr-id', cr: payload.cr });
  if (payload.ledgersCommitted) se.push({ kind: 'ledgers', files: [`change-requests/${payload.cr}/cr.md`, 'change-requests/_backlog.yml', 'change-requests/_index.yml'] });
  if (payload.commit) se.push({ kind: 'commit', sha: payload.commit });
  if (payload.pushed) se.push({ kind: 'push', ref: 'origin/trunk' });
  for (const id of payload.worktrees || []) se.push({ kind: 'worktree', repo: id });
  return se;
}

/**
 * 幂等注册事务（默认 roll-forward）：
 * - registration key 仅以 SHA-256 落 journal/trailer，不落明文；
 * - 同 key+同 inputDigest 复用 CR-ID/txId 续跑；同 key+不同输入 REGISTRATION_INPUT_MISMATCH；
 * - 三账本走 recoverable write-set；registration commit 带固定 trailer 并 lease push；
 * - remote 被他人推进时 rebuild（从新 origin base 重做账本写与 commit）；远端 history rewrite 硬阻断；
 * - active repo 逐个 ensure worktree，每仓落盘，第 N 仓失败重跑只补第 N 仓之后。
 */
export async function registerCr(ctx, input) {
  for (const f of ['registrationKey', 'title']) {
    if (!input || typeof input[f] !== 'string' || !input[f]) throw new TxError('REGISTER_INPUT_MISSING', `register 缺少输入 ${f}`);
  }
  const owners = (input && input.owners) || {};
  for (const role of ['requirement', 'development', 'test']) {
    if (!owners[role]) throw new TxError('REGISTER_INPUT_MISSING', `register 缺少 owners.${role}`);
  }
  const year = input.year || String(new Date().getFullYear());
  const summary = input.summary ?? '';
  const source = input.source ?? 'manual';
  const targetVersion = input.targetVersion ?? 'tbd';
  const keyHash = sha256(String(input.registrationKey));
  const inputDigest = sha256(JSON.stringify({
    title: input.title, summary, source, targetVersion, year,
    owners: { requirement: owners.requirement, development: owners.development, test: owners.test },
  }));
  const kb = getRepository(ctx, ctx.knowledgeBaseRepoId);
  const recoverCommand = `crctl register --registration-key ${input.registrationKey} --title ${JSON.stringify(input.title)}` +
    ` --owner-requirement ${owners.requirement} --owner-development ${owners.development} --owner-test ${owners.test}` +
    (summary ? ` --summary ${JSON.stringify(summary)}` : '') +
    (input.source ? ` --source ${JSON.stringify(input.source)}` : '') +
    (input.targetVersion ? ` --target-version ${JSON.stringify(input.targetVersion)}` : '') +
    ` --workspace ${JSON.stringify(input.workspace || ctx.installRoot)}`;
  const lock = await acquireLock({ root: ctx.installRoot, scope: `register-${keyHash.slice(0, 16)}`, op: 'register' });
  try {
    let journal, journalPath;
    try {
      ({ journal, journalPath } = await loadOrCreateJournal({ root: ctx.installRoot, op: 'register', key: keyHash, graphDigest: ctx.graphDigest, inputDigest }));
    } catch (e) {
      if (e instanceof TxError && e.code === 'TX_INPUT_CONFLICT') {
        throw new TxError('REGISTRATION_INPUT_MISMATCH', `同一 registration key 的输入不一致（inputDigest 漂移），拒绝注册。既有事务: ${(e.extra || {}).txId}`, e.extra);
      }
      throw e;
    }
    const payload = journal.register || { keyHash, inputDigest, cr: null, baseSha: null, ledgersCommitted: false, commit: null, pushed: false, worktrees: [] };
    journal.register = payload;
    const wasComplete = payload.phase === 'complete';
    let did = false;
    const save = async (phase) => { payload.phase = phase; journal.phase = phase; await saveJournal({ path: journalPath, journal }); };
    const assertGraph = () => {
      if ((payload.ledgersCommitted || payload.commit || payload.pushed || (payload.worktrees || []).length) && journal.graphDigest !== ctx.graphDigest) {
        throw new TxError('GRAPH_CHANGED_DURING_TRANSACTION', '事务出现副作用后 dir-graph 声明发生变化，拒绝继续（请先完成或清理既有事务）', { journalDigest: journal.graphDigest, currentDigest: ctx.graphDigest });
      }
    };
    // roll-forward：只恢复当前 register 事务，target root 由 manifest 绑定。
    await recoverWriteSet({ txRoot: ctx.installRoot, txId: journal.txId });

    if (!payload.cr) {
      const st = gitRun(kb.rootPath, ['status', '--porcelain']);
      if (st.stdout !== '') {
        throw new TxError('REGISTRATION_TRUNK_DIRTY', 'knowledge-base trunk 工作区有未提交变更，注册无法开始（请先提交或清理）', { dirty: st.stdout.split('\n').slice(0, 5) });
      }
      gitMust(kb.rootPath, ['fetch', 'origin']);
      payload.baseSha = gitMust(kb.rootPath, ['rev-parse', `refs/remotes/origin/${kb.trunk}`]);
      payload.cr = formatCrId(year, scanMaxCrNumber(kb.rootPath, year) + 1);
      did = true;
      await save('allocated');
      faultPoint('register-after-allocate', { cr: payload.cr });
    }
    const cr = payload.cr;

    // 账本写 + commit + lease push（remote 推进时 rebuild，最多 3 轮）
    for (let attempt = 0; attempt < 3 && !payload.pushed; attempt++) {
      assertGraph();
      if (!payload.ledgersCommitted) {
        const st = gitRun(kb.rootPath, ['status', '--porcelain']);
        if (st.stdout !== '') throw new TxError('REGISTRATION_TRUNK_DIRTY', 'knowledge-base trunk 工作区有未提交变更，账本写无法开始', { dirty: st.stdout.split('\n').slice(0, 5) });
        const bp = path.join(kb.rootPath, 'change-requests', '_backlog.yml');
        const ip = path.join(kb.rootPath, 'change-requests', '_index.yml');
        const backlogText = fs.readFileSync(bp, 'utf8');
        assertSupportedBacklogSchemaText(backlogText);
        const indexText = fs.readFileSync(ip, 'utf8');
        const texts = buildRegistrationTexts({ cr, title: input.title, summary, source, targetVersion, owners, now: nowIso() });
        const newBacklog = backlogText.replaceAll('\r\n', '\n').trimEnd() + '\n' + texts.backlogEntry + '\n';
        const newIndex = indexText.replaceAll('\r\n', '\n').trimEnd() + '\n' + texts.indexEntry + '\n';
        const crMdText = texts.crMdText;
        await applyWriteSet({ root: kb.rootPath, txId: journal.txId, entries: [
          { path: `change-requests/${cr}/cr.md`, beforeSha256: null, afterSha256: sha256(crMdText), content: crMdText },
          { path: 'change-requests/_backlog.yml', beforeSha256: sha256(backlogText), afterSha256: sha256(newBacklog), content: newBacklog },
          { path: 'change-requests/_index.yml', beforeSha256: sha256(indexText), afterSha256: sha256(newIndex), content: newIndex },
        ] });
        payload.ledgersCommitted = true;
        did = true;
        await save('ledgers-written');
        faultPoint('register-after-ledgers', { cr });
      }
      if (!payload.commit) {
        const msg = `register ${cr}: ${input.title}\n\n` +
          `AI-First-Op: register\nAI-First-Tx: ${journal.txId}\nAI-First-CR: ${cr}\nAI-First-Registration-Key-SHA256: ${keyHash}\n`;
        gitMust(kb.rootPath, ['add', `change-requests/${cr}/cr.md`, 'change-requests/_backlog.yml', 'change-requests/_index.yml']);
        gitMust(kb.rootPath, ['commit', '--no-gpg-sign', '--file=-'], { input: msg });
        payload.commit = gitMust(kb.rootPath, ['rev-parse', 'HEAD']);
        did = true;
        await save('committed');
        faultPoint('register-after-commit', { cr });
      }
      gitMust(kb.rootPath, ['fetch', 'origin']);
      const remoteSha = gitMust(kb.rootPath, ['rev-parse', `refs/remotes/origin/${kb.trunk}`]);
      const isAncestor = gitRun(kb.rootPath, ['merge-base', '--is-ancestor', payload.commit, remoteSha]).status === 0;
      const cls = classifyRemoteCommit({ remoteSha, expectedBase: payload.baseSha, commitSha: payload.commit, commitIsRemoteAncestor: isAncestor, journalSaysPublished: false });
      if (cls === 'confirmed') {
        // 已在远端（此前 push 成功但 journal 未落盘等场景）
      } else if (cls === 'pushable') {
        gitMust(kb.rootPath, ['push', `--force-with-lease=${kb.trunk}:${payload.baseSha}`, 'origin', `HEAD:refs/heads/${kb.trunk}`]);
      } else if (cls === 'rebuild') {
        // remote 被他人推进：仅在 checkout 仍完全 clean 时重建；事务开始后的用户改动绝不 reset。
        const beforeReset = gitRun(kb.rootPath, ['status', '--porcelain']);
        if (beforeReset.status !== 0 || beforeReset.stdout !== '') {
          throw new TxError('REGISTRATION_TRUNK_DIRTY', 'remote stale 后主 checkout 出现用户改动，拒绝 reset/rebuild', { dirty: beforeReset.stdout.split('\n').slice(0, 5) });
        }
        gitMust(kb.rootPath, ['reset', '--hard', `refs/remotes/origin/${kb.trunk}`]);
        payload.baseSha = remoteSha;
        payload.ledgersCommitted = false;
        payload.commit = null;
        did = true;
        await save('rebuild-pending');
        continue;
      } else {
        throw new TxError('REGISTRATION_HISTORY_REWRITTEN', `远端 ${kb.trunk} 历史在事务中被重写，硬阻断（不猜测、不自动 force）`, { remoteSha, expectedBase: payload.baseSha });
      }
      payload.pushed = true;
      did = true;
      await save('pushed');
      faultPoint('register-after-push', { cr });
    }
    if (!payload.pushed) throw new TxError('TX_PHASE_STUCK', 'register push 阶段连续 rebuild 超过上限', { cr });

    payload.worktrees = payload.worktrees || [];
    for (const repo of ctx.repositories) {
      if (payload.worktrees.includes(repo.id)) continue;
      assertGraph();
      ensureRepoWorkspace(ctx, repo, cr);
      payload.worktrees.push(repo.id);
      did = true;
      await save(`workspace-${repo.id}`);
      faultPoint('register-between-worktrees', { repo: repo.id });
    }
    await save('complete');
    return { cr, txId: journal.txId, phase: 'complete', changed: did && !wasComplete, sideEffects: buildSideEffects(payload), recoverCommand };
  } finally {
    await lock.release();
  }
}

/* ────────────────────────── ensureWorkspace（SDD §4.2，TASK-05） ────────────────────────── */

/**
 * workspace 生命周期：inspect 只读分类；resume 只补齐可证明资源（先 roll-forward 中断 write-set）；
 * partial/archived cleanup 只删干净 worktree，dirty/unknown/未合并 ref 一律保留（TASK-09 archiveCr 扩展 archived 语义）。
 */
export async function ensureWorkspace(ctx, input) {
  const cr = input && input.cr;
  const mode = (input && input.mode) || 'inspect';
  if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) throw new TxError('WORKSPACE_CR_INVALID', `CR-ID 非法: ${cr}`);
  if (!['inspect', 'resume', 'partial', 'archived'].includes(mode)) throw new TxError('WORKSPACE_MODE_INVALID', `workspace mode 非法: ${mode}`);
  const resources = [];
  if (mode === 'inspect') {
    for (const repo of ctx.repositories) resources.push(classifyRepoWorkspace(ctx, repo, cr));
    return { txId: null, resources, changed: false };
  }
  if (mode === 'resume') {
    let changed = false;
    for (const repo of ctx.repositories) {
      const r = ensureRepoWorkspace(ctx, repo, cr);
      if (String(r.action).startsWith('created:')) changed = true;
      resources.push(r);
    }
    return { txId: null, resources, changed };
  }
  // cleanup：partial / archived（archived 语义由 TASK-09 archiveCr 扩展，本函数只做零风险清理）
  let changed = false;
  for (const repo of ctx.repositories) {
    const info = classifyRepoWorkspace(ctx, repo, cr);
    if (!fs.existsSync(info.worktreePath)) { resources.push({ ...info, action: 'absent' }); continue; }
    if (info.classification !== 'healthy') {
      // dirty/wrong-branch/path-unregistered：unknown 或带用户数据，零删除
      resources.push({ ...info, action: 'kept' });
      continue;
    }
    // healthy 且 clean：只删 worktree，保留本地/远端分支（未合并 ref 不删；TASK-09 决定 merged ref 清理）
    gitMust(repo.rootPath, ['worktree', 'remove', info.worktreePath]);
    changed = true;
    resources.push({ ...info, action: 'removed-worktree' });
  }
  return { txId: null, resources, changed };
}

/* ────────────────────────── Signed release snapshot（TASK-06，SDD §3.4） ──────────────────────────
 * 受控 artifact 集合 = PRD、SDD、dev plan、TASK 文件与 task index（knowledge-base 仓内）。
 * buildReleaseSubjects 由 review-record --stage code 机器注入 review-annotations/code.yml，
 * 模型 payload 不得提供或覆盖；approve-code 重核后原样复制到 approval.yml#code.release-subjects，
 * 并由既有 evidence/approval digest 签入（annotation 文件文本本身进入 canonical digest）。
 * verifyReleaseSubjects 返回 {ok:true} 或 {ok:false, kind:'code'|'task'|'prd'|'sdd', details}，
 * merge/writeback（TASK-07/08）精确消费 kind 做 release-drift/APPROVED_ARTIFACT_DRIFT 分流。 */

/** 受控 artifact 收集：路径 POSIX 字典序，内容 CRLF→LF 后 SHA-256；缺失文件不入选。 */
function collectControlledArtifacts(ctx, cr) {
  const crRoot = crWorktreePath(ctx, cr);
  const crBase = `change-requests/${cr}`;
  const files = [];
  const consider = (rel) => {
    const abs = path.join(crRoot, ...rel.split('/'));
    if (!fs.existsSync(abs)) return;
    files.push({ path: rel, sha256: sha256(fs.readFileSync(abs, 'utf8').replaceAll('\r\n', '\n')) });
  };
  for (const f of ['prd.md', 'sdd.md', 'plan.md']) consider(`${crBase}/${f}`);
  const tasksDir = path.join(crRoot, crBase, 'tasks');
  if (fs.existsSync(tasksDir)) {
    consider(`${crBase}/tasks/_index.yml`);
    for (const name of fs.readdirSync(tasksDir).filter((n) => /^TASK-\d+\.md$/.test(n)).sort()) {
      consider(`${crBase}/tasks/${name}`);
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/**
 * 构造 release subjects（当前事实快照）：
 * - repositories：每个 active 仓的 requirement 分支远端 ref 名 + 该仓 CR worktree HEAD（被评审源 SHA）；
 * - artifacts：受控文件集合 + 逐文件 SHA-256 + 集合 digest。
 * worktree 缺失或无任何受控 artifact 均硬失败（不得产出空快照）。
 */
export async function buildReleaseSubjects(ctx, cr) {
  const files = collectControlledArtifacts(ctx, cr);
  if (!files.length) {
    throw new TxError('RELEASE_SUBJECT_EMPTY', `${cr} 无受控 artifact（PRD/SDD/plan/tasks），不能构造 release-subjects`, { cr });
  }
  const repositories = [];
  for (const repo of ctx.repositories) {
    const wt = path.join(repo.worktreePath, cr);
    if (!fs.existsSync(wt)) {
      throw new TxError('RELEASE_WORKSPACE_MISSING', `${repo.id} 的 CR worktree 不存在: ${wt}（code 评审前必须先 ensure workspace）`, { repo: repo.id, worktree: wt });
    }
    const sha = gitMust(wt, ['rev-parse', 'HEAD']);
    // 真实仓存在 origin 时要求 reviewed HEAD 已推送；无 remote 的内存/单仓测试 fixture 保持可用。
    if (gitRun(repo.rootPath, ['remote', 'get-url', 'origin']).status === 0) {
      gitMust(repo.rootPath, ['fetch', 'origin']);
      const remote = gitRun(repo.rootPath, ['rev-parse', '--verify', `refs/remotes/origin/${branchForCr(cr)}`]);
      if (remote.status !== 0 || remote.stdout !== sha) {
        throw new TxError('RELEASE_REMOTE_NOT_PUSHED', `${repo.id} 的 requirement ref 未推送或不等于 worktree HEAD`, { repo: repo.id, head: sha, remote: remote.status === 0 ? remote.stdout : null });
      }
    }
    repositories.push({ repo: repo.id, remoteRef: `refs/heads/${branchForCr(cr)}`, reviewedSourceSha: sha });
  }
  return {
    version: 1,
    repositories,
    artifacts: {
      algorithm: 'sha256',
      canonicalization: 'crlf-to-lf+path-sort',
      files,
      digest: sha256(files.map((f) => `${f.path}:${f.sha256}`).join('\n')),
    },
  };
}

/** release-subjects 的 YAML 渲染（顶格 key），供 annotation/approval 两处复用，保证字节语义一致。
 * 同时容忍 build 产出的 camelCase 与 YAML 回读的 kebab-case（approve 复制路径消费解析后对象）。 */
const repoRemoteRef = (r) => r.remoteRef ?? r['remote-ref'];
const repoReviewedSha = (r) => r.reviewedSourceSha ?? r['reviewed-source-sha'];
export function renderReleaseSubjects(rs) {
  const lines = ['release-subjects:', `  version: ${rs.version}`, '  repositories:'];
  for (const r of rs.repositories) {
    lines.push(`    - repo: ${r.repo}`, `      remote-ref: ${repoRemoteRef(r)}`, `      reviewed-source-sha: ${repoReviewedSha(r)}`);
  }
  lines.push('  artifacts:', `    algorithm: ${rs.artifacts.algorithm}`, `    canonicalization: ${rs.artifacts.canonicalization}`, '    files:');
  for (const f of rs.artifacts.files) lines.push(`      - { path: ${f.path}, sha256: ${f.sha256} }`);
  lines.push(`    digest: ${rs.artifacts.digest}`);
  return lines;
}

/** artifact path → drift kind：prd.md→prd，sdd.md→sdd，其余（plan/tasks/index）→task。 */
const artifactKindOf = (p) => (p.endsWith('/prd.md') ? 'prd' : p.endsWith('/sdd.md') ? 'sdd' : 'task');

/**
 * 重核 release subjects 与当前事实：任一漂移返回 {ok:false, kind, details}，零写入。
 * code：任一仓 worktree HEAD 或被推送的远端 requirement 分支 ≠ reviewed-source-sha，或仓集合不一致；
 * prd/sdd/task：对应受控文件哈希漂移、缺失或文件集合/digest 不一致。
 */
export async function verifyReleaseSubjects(ctx, cr, snapshot) {
  const bad = (kind, details) => ({ ok: false, kind, details });
  if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== 1
    || !Array.isArray(snapshot.repositories) || !snapshot.artifacts || typeof snapshot.artifacts !== 'object'
    || !Array.isArray(snapshot.artifacts.files)) {
    return bad('code', { reason: 'shape', snapshot: JSON.stringify(snapshot).slice(0, 200) });
  }
  const crRoot = crWorktreePath(ctx, cr);
  const byId = new Map(ctx.repositories.map((r) => [r.id, r]));
  const snapRepos = new Set();
  for (const r of snapshot.repositories) {
    const repo = byId.get(r.repo);
    if (!repo) return bad('code', { reason: 'repo-not-active', repo: r.repo });
    if (snapRepos.has(r.repo)) return bad('code', { reason: 'repo-duplicate', repo: r.repo });
    snapRepos.add(r.repo);
    const wt = path.join(repo.worktreePath, cr);
    let head = null;
    if (fs.existsSync(wt)) {
      const rr = gitRun(wt, ['rev-parse', 'HEAD']);
      head = rr.status === 0 ? rr.stdout : null;
    }
    const hasOrigin = gitRun(repo.rootPath, ['remote', 'get-url', 'origin']).status === 0;
    const rem = gitRun(repo.rootPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branchForCr(cr)}`]);
    if ((hasOrigin || rem.status === 0) && (rem.status !== 0 || rem.stdout !== head)) {
      return bad('code', { reason: 'remote-ref-drift', repo: r.repo, expected: head, actual: rem.status === 0 ? rem.stdout : null });
    }
    if (r.repo === ctx.knowledgeBaseRepoId) {
      if (gitRun(wt, ['merge-base', '--is-ancestor', repoReviewedSha(r), head]).status !== 0) {
        return bad('code', { reason: 'head-drift', repo: r.repo, expectedAncestor: repoReviewedSha(r), actual: head });
      }
      const allowed = new Set([
        `change-requests/${cr}/approval.yml`,
        `change-requests/${cr}/cr.md`,
        `change-requests/${cr}/traceability.yml`,
        `change-requests/${cr}/review-loop.yml`,
        'change-requests/_backlog.yml',
      ]);
      const reviewPrefix = `change-requests/${cr}/review-annotations/`;
      const changed = gitMust(wt, ['diff', '--name-only', `${repoReviewedSha(r)}..${head}`]).split('\n').filter(Boolean);
      const unexpected = changed.filter((p) => !allowed.has(p) && !p.startsWith(reviewPrefix));
      if (unexpected.length) return bad('code', { reason: 'post-review-path-drift', repo: r.repo, unexpected });
    } else if (head !== repoReviewedSha(r)) {
      return bad('code', { reason: 'head-drift', repo: r.repo, expected: repoReviewedSha(r), actual: head });
    }
  }
  for (const repo of ctx.repositories) {
    if (!snapRepos.has(repo.id)) return bad('code', { reason: 'repo-missing', repo: repo.id });
  }
  // artifact 逐文件重核（按 snapshot 声明序）
  for (const f of snapshot.artifacts.files) {
    const abs = path.join(crRoot, ...String(f.path || '').split('/'));
    const raw = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    const actual = raw == null ? null : sha256(raw.replaceAll('\r\n', '\n'));
    if (actual !== f.sha256) {
      return bad(artifactKindOf(String(f.path)), { reason: raw == null ? 'missing' : 'hash-drift', path: f.path, expected: f.sha256, actual });
    }
  }
  // 文件集合与 digest 一致性（新增/删除受控文件也是漂移）
  const current = collectControlledArtifacts(ctx, cr);
  if (current.length !== snapshot.artifacts.files.length
    || current.some((f, i) => f.path !== snapshot.artifacts.files[i].path)) {
    const firstDiff = current.find((f, i) => !snapshot.artifacts.files[i] || snapshot.artifacts.files[i].path !== f.path)
      || snapshot.artifacts.files[current.length];
    return bad(artifactKindOf(String(firstDiff && firstDiff.path || 'tasks')), { reason: 'file-set-drift', current: current.map((f) => f.path), snapshot: snapshot.artifacts.files.map((f) => f.path) });
  }
  const digest = sha256(snapshot.artifacts.files.map((f) => `${f.path}:${f.sha256}`).join('\n'));
  if (digest !== snapshot.artifacts.digest) return bad('task', { reason: 'digest-drift', expected: snapshot.artifacts.digest, actual: digest });
  return { ok: true };
}
/* ────────────────────────── mergeCr（SDD §5.2，TASK-07） ──────────────────────────
 * 可恢复跨仓 merge saga：
 * - 只消费 approval.yml#code.release-subjects（TASK-06 签入的 approved source），不猜 branch；
 * - 零 publish 的 code/source/TASK drift → 返回 phase='release-drift'（由 crctl 层经
 *   code-approved -> developing 回退转换执行）；PRD/SDD drift → APPROVED_ARTIFACT_DRIFT；
 * - prepare 用 git merge-tree --write-tree + commit-tree，不 checkout/move 本地 trunk；
 * - publish 逐仓 lease push，journal 先记 intent 再记 observation；重入按 classifyRemoteCommit 分流；
 * - 全部 confirmed 后在 detached Transaction Workspace 单 finalize commit 写
 *   status=merging + merge-commits.yml + merge-verification.md，lease push 后 origin confirmed。
 */

function backlogLines(raw) {
  const out = [];
  const re = /([^\r\n]*)(\r\n|\n|$)/g;
  let m;
  while ((m = re.exec(raw)) && (m[0] || m.index < raw.length)) {
    out.push({ text: m[1], eol: m[2], start: m.index, end: m.index + m[0].length });
    if (!m[2]) break;
  }
  return out;
}

function locateBacklogEntry(raw, cr, side) {
  const lines = backlogLines(raw);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].text.match(/^([ \t]*)- id:\s*["']?([^\s"']+)["']?\s*$/);
    if (m && m[2] === cr) hits.push({ index: i, indent: m[1].length });
  }
  if (hits.length === 0) throw new TxError('MERGE_BACKLOG_ENTRY_MISSING', `${side} _backlog.yml 缺少目标条目 ${cr}`, { side, cr });
  if (hits.length > 1) throw new TxError('MERGE_BACKLOG_ENTRY_DUPLICATE', `${side} _backlog.yml 目标条目 ${cr} 重复`, { side, cr, count: hits.length });
  const hit = hits[0];
  let next = lines.length;
  for (let i = hit.index + 1; i < lines.length; i++) {
    const m = lines[i].text.match(/^([ \t]*)- id:\s*["']?([^\s"']+)["']?\s*$/);
    if (m && m[1].length <= hit.indent) { next = i; break; }
  }
  let end = next < lines.length ? lines[next].start : raw.length;
  for (let i = next - 1; i > hit.index; i--) {
    const t = lines[i].text;
    const indent = (t.match(/^[ \t]*/) || [''])[0].length;
    if (t.trim() === '' || (indent <= hit.indent && t.trimStart().startsWith('#'))) end = lines[i].start;
    else break;
  }
  if (end <= lines[hit.index].start) throw new TxError('MERGE_BACKLOG_STRUCTURE_INVALID', `${side} _backlog.yml 无法确定 ${cr} 条目边界`, { side, cr });
  return { start: lines[hit.index].start, end };
}

/** 以 trunk 原文为基底，只用 source 的目标 CR 完整块替换；非目标字节不变。 */
export function replaceBacklogEntry(trunkRaw, sourceRaw, cr) {
  const trunk = locateBacklogEntry(trunkRaw, cr, 'trunk');
  const source = locateBacklogEntry(sourceRaw, cr, 'source');
  const targetEol = trunkRaw.slice(trunk.start, trunk.end).includes('\r\n') ? '\r\n' : '\n';
  const sourceBlock = sourceRaw.slice(source.start, source.end).replaceAll('\r\n', '\n').replaceAll('\n', targetEol);
  return trunkRaw.slice(0, trunk.start) + sourceBlock + trunkRaw.slice(trunk.end);
}

function renderMergeCommits(repos, snapshot, txId, mergedAt) {
  const lines = ['schema: merge-commits/v1', `tx-id: ${txId}`, `merged-at: "${mergedAt}"`, 'repositories:'];
  for (const r of repos) {
    lines.push(`  - repo: ${r.repo}`, `    base-sha: ${r.baseSha}`, `    source-sha: ${r.sourceSha}`, `    merge-sha: ${r.mergeSha}`);
  }
  lines.push(`release-subjects-digest: ${snapshot.artifacts.digest}`);
  return lines.join('\n') + '\n';
}

function renderMergeVerification(repos, snapshot) {
  const lines = ['# Merge Verification', '', `- release-subjects version: ${snapshot.version}`, '- repositories:'];
  for (const r of repos) lines.push(`  - ${r.repo}: base=${r.baseSha.slice(0, 12)} source=${r.sourceSha.slice(0, 12)} merge=${r.mergeSha.slice(0, 12)}`);
  lines.push(`- artifacts-digest: ${snapshot.artifacts.digest}`);
  return lines.join('\n') + '\n';
}

export function gitReadBlobRaw(repoPath, treeish, relPath) {
  assertManifestPathSafe(relPath, 'MERGE_BACKLOG_STRUCTURE_INVALID');
  const r = spawnSync('git', ['cat-file', 'blob', `${treeish}:${relPath}`], { cwd: repoPath, encoding: null, shell: false });
  if (r.status !== 0) {
    throw new TxError('MERGE_BACKLOG_ENTRY_MISSING', `Git tree ${treeish.slice(0, 12)} 缺少 ${relPath}`, { treeish, path: relPath, stderr: String(r.stderr || '').trim() });
  }
  return r.stdout;
}

/** initial/rebuild 共用的无 ref 副作用 merge tree 计算。 */
export function prepareMergeTree({ repo, baseSha, sourceSha, cr, tmpRoot, knowledgeBase = false }) {
  if (!knowledgeBase) {
    const mt = gitRun(repo.rootPath, ['merge-tree', '--write-tree', baseSha, sourceSha]);
    if (mt.status !== 0) throw new TxError('MERGE_PREPARE_CONFLICT', `${repo.id} merge prepare 冲突`, { repo: repo.id, base: baseSha, source: sourceSha, detail: (mt.stdout || mt.stderr).slice(0, 300) });
    return { treeSha: mt.stdout.trim(), baseSha, sourceSha };
  }
  const backlog = 'change-requests/_backlog.yml';
  const trunkRaw = gitReadBlobRaw(repo.rootPath, baseSha, backlog).toString('utf8');
  const sourceRaw = gitReadBlobRaw(repo.rootPath, sourceSha, backlog).toString('utf8');
  const merged = replaceBacklogEntry(trunkRaw, sourceRaw, cr);
  const ls = gitMust(repo.rootPath, ['ls-tree', sourceSha, '--', backlog]);
  const mode = /^(\d+)\s+blob\s+[0-9a-f]+\t/.exec(ls)?.[1];
  if (!mode) throw new TxError('MERGE_BACKLOG_STRUCTURE_INVALID', `source ${backlog} 不是普通 blob`, { sourceSha });
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'merge-index-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    const trunkBlob = gitMust(repo.rootPath, ['hash-object', '-w', '--stdin'], { input: trunkRaw });
    const mergedBlob = gitMust(repo.rootPath, ['hash-object', '-w', '--stdin'], { input: merged });
    // 先把 synthetic source 的 backlog 中和为 trunk blob，让 Git 只处理其他文件的真实冲突。
    gitMust(repo.rootPath, ['read-tree', sourceSha], { env });
    gitMust(repo.rootPath, ['update-index', '--cacheinfo', mode, trunkBlob, backlog], { env });
    const syntheticTree = gitMust(repo.rootPath, ['write-tree'], { env });
    const synthetic = gitMust(repo.rootPath, ['commit-tree', syntheticTree, '-p', sourceSha, '-F', '-'], { input: `synthetic backlog ${cr}\n` });
    const mt = gitRun(repo.rootPath, ['merge-tree', '--write-tree', baseSha, synthetic]);
    if (mt.status !== 0) throw new TxError('MERGE_PREPARE_CONFLICT', `${repo.id} merge prepare 冲突`, { repo: repo.id, base: baseSha, source: sourceSha, detail: (mt.stdout || mt.stderr).slice(0, 300) });
    // 再把已成功合并的 tree 中 backlog 精确替换为语义合并结果。
    gitMust(repo.rootPath, ['read-tree', mt.stdout.trim()], { env });
    gitMust(repo.rootPath, ['update-index', '--cacheinfo', mode, mergedBlob, backlog], { env });
    return { treeSha: gitMust(repo.rootPath, ['write-tree'], { env }), baseSha, sourceSha };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function buildMergeSideEffects(payload) {
  const se = [];
  for (const r of payload.repos || []) {
    if (r.pushed) se.push({ kind: 'publish', repo: r.repo, mergeSha: r.mergeSha });
  }
  if (payload.finalizePushed) se.push({ kind: 'finalize-push', repo: 'knowledge-base', commit: payload.finalizeCommit });
  if (payload.operationalWorkspace) se.push({ kind: 'operational-workspace', path: payload.operationalWorkspace });
  return se;
}

export async function mergeCr(ctx, input) {
  const cr = input && input.cr;
  if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) throw new TxError('MERGE_CR_INVALID', `merge 需要合法 CR-ID，收到 ${cr}`, { cr });
  const kb = getRepository(ctx, ctx.knowledgeBaseRepoId);
  const opWs = resolveOperationalWorkspace(ctx, cr);
  if (opWs.source !== 'cr-worktree') {
    throw new TxError('MERGE_STATE_MISMATCH', `merge 只接受 code-approved（authority=CR worktree），当前 ${opWs.phase}`, { cr, phase: opWs.phase });
  }
  const recoverCommand = `crctl merge ${cr} --workspace ${JSON.stringify((input && input.workspace) || ctx.installRoot)}`;
  const lock = await acquireLock({ root: ctx.installRoot, scope: `merge-${cr}`, op: 'merge' });
  try {
    let journal, journalPath;
    ({ journal, journalPath } = await loadOrCreateJournal({ root: ctx.installRoot, op: 'merge', key: cr, graphDigest: ctx.graphDigest, inputDigest: sha256(cr) }));
    const payload = journal.merge || { cr, phase: 'start', repos: [], finalizeCommitted: false, finalizeCommit: null, finalizeBaseSha: null, finalizePushed: false, mergedStatus: null, operationalWorkspace: null };
    journal.merge = payload;
    const wasComplete = payload.phase === 'complete';
    let did = false;
    const save = async (phase) => { payload.phase = phase; journal.phase = phase; await saveJournal({ path: journalPath, journal }); };
    const assertGraph = () => {
      if ((payload.repos.length || payload.finalizeCommitted || payload.finalizePushed) && journal.graphDigest !== ctx.graphDigest) {
        throw new TxError('GRAPH_CHANGED_DURING_TRANSACTION', 'merge 事务出现副作用后 dir-graph 声明发生变化，拒绝继续（请先完成或清理既有事务）', { journalDigest: journal.graphDigest, currentDigest: ctx.graphDigest });
      }
    };
    // roll-forward：只恢复当前 merge 事务，target root 由 manifest 绑定。
    await recoverWriteSet({ txRoot: ctx.installRoot, txId: journal.txId });
    const txws = txWorkspacePath(ctx, cr);

    // status + approved snapshot（只从 approval.yml#code 读，TASK-06 签入）
    // authority：status 从 CR worktree 读（SDD §1.3）；approval.yml 是主 checkout 评审产物（TASK-06 模型，
    // review/approve 在 --workspace 主 checkout 跑），故从 kb.rootPath 读。
    const crStatus = readCrMdStatus(opWs.path, cr);
    if (crStatus !== 'code-approved') throw new TxError('MERGE_STATE_MISMATCH', `merge 需要 status=code-approved，实际 ${crStatus}`, { cr, status: crStatus });
    const approvalText = fs.readFileSync(path.join(opWs.path, 'change-requests', cr, 'approval.yml'), 'utf8');
    const doc = parseYaml(approvalText.replaceAll('\r\n', '\n')) || {};
    const snapshot = doc && doc.code && doc.code['release-subjects'];
    if (!snapshot) throw new TxError('RELEASE_SUBJECT_DRIFT', 'approval.yml#code.release-subjects 缺失，无法 merge（code 审批时未签入 snapshot）', { cr, kind: 'missing' });

    const v = await verifyReleaseSubjects(ctx, cr, snapshot);
    if (!v.ok) {
      const published = (payload.repos || []).some((r) => r.pushed);
      if (v.kind === 'prd' || v.kind === 'sdd') {
        throw new TxError('APPROVED_ARTIFACT_DRIFT', `受控 artifact 漂移（kind=${v.kind}），拒绝 merge：${v.details && v.details.reason}`, { cr, kind: v.kind, ...v.details });
      }
      if (published) {
        throw new TxError('RELEASE_SUBJECT_DRIFT', `已有 trunk publish 后 release-subjects 漂移（kind=${v.kind}），保持 blocked，恢复原 ref 后才能续跑`, { cr, kind: v.kind, ...v.details });
      }
      // 零 publish 的 code/source/TASK drift：原子标记审批 stale，回退转换由 crctl 层执行
      return { cr, txId: journal.txId, phase: 'release-drift', changed: false, drift: { kind: v.kind, ...v.details }, recoverCommand };
    }

    // per-repo prepare（无 ref/worktree/账本副作用）
    for (const repo of ctx.repositories) {
      assertGraph();
      const snapRepo = snapshot.repositories.find((r) => r.repo === repo.id);
      if (!snapRepo) throw new TxError('RELEASE_SUBJECT_DRIFT', `release-subjects 缺 ${repo.id} 仓声明`, { cr, repo: repo.id });
      gitMust(repo.rootPath, ['fetch', 'origin']);
      const baseSha = gitMust(repo.rootPath, ['rev-parse', `refs/remotes/origin/${repo.trunk}`]);
      const sourceRef = `refs/remotes/origin/${branchForCr(cr)}`;
      const src = gitRun(repo.rootPath, ['rev-parse', '--verify', '--quiet', sourceRef]);
      if (src.status !== 0) throw new TxError('MERGE_SOURCE_MISSING', `${repo.id} 缺少远端 source ref ${sourceRef}（被评审分支未 push）`, { repo: repo.id, ref: sourceRef });
      const sourceMatches = repo.id === ctx.knowledgeBaseRepoId
        ? gitRun(repo.rootPath, ['merge-base', '--is-ancestor', repoReviewedSha(snapRepo), src.stdout]).status === 0
        : src.stdout === repoReviewedSha(snapRepo);
      if (!sourceMatches) {
        throw new TxError('RELEASE_SUBJECT_DRIFT', `${repo.id} 远端 ${sourceRef} 与 approved source 不一致`, { repo: repo.id, expected: repoReviewedSha(snapRepo), actual: src.stdout });
      }
      const prev = (payload.repos || []).find((r) => r.repo === repo.id);
      // 已发布/已确认的仓不再重做 prepare：candidate 与 baseSha 保持（发布后 base 不得漂移）
      if (prev && (prev.pushed || prev.confirmed)) continue;
      if (prev && prev.baseSha === baseSha && prev.sourceSha === src.stdout && prev.mergeSha) continue;
      const prepared = prepareMergeTree({
        repo, baseSha, sourceSha: src.stdout, cr,
        tmpRoot: path.join(ctx.installRoot, '.crctl', 'tmp'),
        knowledgeBase: repo.id === ctx.knowledgeBaseRepoId,
      });
      const tree = prepared.treeSha;
      const msg = `merge ${cr}: ${repo.id}\n\nAI-First-Op: merge\nAI-First-Tx: ${journal.txId}\nAI-First-CR: ${cr}\nAI-First-Merge-Repo: ${repo.id}\nAI-First-Merge-Base: ${baseSha}\nAI-First-Merge-Source: ${src.stdout}\n`;
      const mergeSha = gitMust(repo.rootPath, ['commit-tree', tree, '-p', baseSha, '-p', src.stdout, '-F', '-'], { input: msg });
      const rec = prev || { repo: repo.id, baseSha, sourceSha: src.stdout, mergeSha, pushed: false, confirmed: false };
      Object.assign(rec, { baseSha, sourceSha: src.stdout, mergeSha });
      if (!prev) payload.repos.push(rec);
      did = true;
      await save(`prepared-${repo.id}`);
      faultPoint('merge-after-prepare', { repo: repo.id });
    }

    // publish：逐仓 lease push + observation（最多 3 轮 rebuild）
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = (payload.repos || []).filter((r) => !r.confirmed);
      if (!pending.length) break;
      for (const rec of pending) {
        assertGraph();
        const repo = getRepository(ctx, rec.repo);
        gitMust(repo.rootPath, ['fetch', 'origin']);
        const remoteSha = gitMust(repo.rootPath, ['rev-parse', `refs/remotes/origin/${repo.trunk}`]);
        const isAncestor = gitRun(repo.rootPath, ['merge-base', '--is-ancestor', rec.mergeSha, remoteSha]).status === 0;
        const cls = classifyRemoteCommit({ remoteSha, expectedBase: rec.baseSha, commitSha: rec.mergeSha, commitIsRemoteAncestor: isAncestor, journalSaysPublished: rec.pushed });
        if (cls === 'confirmed') {
          rec.confirmed = true;
          did = true;
          await save(`confirmed-${repo.id}`);
          faultPoint('merge-after-observation', { repo: repo.id });
          continue;
        }
        if (cls === 'history-rewritten') {
          throw new TxError('MERGE_REMOTE_HISTORY_REWRITTEN', `${repo.id} 远端 trunk 历史在事务中被重写，硬阻断（不猜测、不自动 force）`, { repo: repo.id, remoteSha, expectedBase: rec.baseSha });
        }
        if (cls === 'rebuild') {
          const sourceRef = `refs/remotes/origin/${branchForCr(cr)}`;
          const src = gitMust(repo.rootPath, ['rev-parse', '--verify', sourceRef]);
          const prepared = prepareMergeTree({
            repo, baseSha: remoteSha, sourceSha: src, cr,
            tmpRoot: path.join(ctx.installRoot, '.crctl', 'tmp'),
            knowledgeBase: repo.id === ctx.knowledgeBaseRepoId,
          });
          const msg = `merge ${cr}: ${repo.id} (rebuild)\n\nAI-First-Op: merge\nAI-First-Tx: ${journal.txId}\nAI-First-CR: ${cr}\nAI-First-Merge-Repo: ${repo.id}\nAI-First-Merge-Base: ${remoteSha}\nAI-First-Merge-Source: ${src}\n`;
          rec.baseSha = remoteSha;
          rec.mergeSha = gitMust(repo.rootPath, ['commit-tree', prepared.treeSha, '-p', remoteSha, '-p', src, '-F', '-'], { input: msg });
          rec.pushed = false;
          did = true;
          await save(`rebuild-${repo.id}`);
          continue;
        }
        // pushable：lease push（expectedBase = rec.baseSha）
        gitMust(repo.rootPath, ['push', `--force-with-lease=${repo.trunk}:${rec.baseSha}`, 'origin', `${rec.mergeSha}:refs/heads/${repo.trunk}`]);
        rec.pushed = true;
        did = true;
        await save(`pushed-${repo.id}`);
        faultPoint('merge-after-push', { repo: repo.id });
      }
    }
    if ((payload.repos || []).some((r) => !r.confirmed)) {
      throw new TxError('MERGE_REMOTE_STALE', 'merge publish 阶段连续 rebuild 超过上限，无法收敛', { cr });
    }

    // finalize：所有仓 confirmed → detached Transaction Workspace 单 commit
    const mergedAt = nowIso();
    if (!payload.finalizeCommitted) {
      assertGraph();
      gitMust(kb.rootPath, ['fetch', 'origin']);
      const trunkSha = gitMust(kb.rootPath, ['rev-parse', `refs/remotes/origin/${kb.trunk}`]);
      if (!fs.existsSync(txws)) {
        gitMust(kb.rootPath, ['worktree', 'add', '--detach', txws, trunkSha]);
      } else {
        gitMust(txws, ['fetch', 'origin']);
        gitMust(txws, ['reset', '--hard', trunkSha]);
        gitMust(txws, ['checkout', '--detach', trunkSha]);
      }
      faultPoint('merge-before-finalize', { cr });
      const txCrMdP = path.join(txws, 'change-requests', cr, 'cr.md');
      const txCrMdText = fs.readFileSync(txCrMdP, 'utf8');
      const nextCrMd = crMdStatusText(txCrMdText, 'merging');
      if (!nextCrMd) throw new TxError('MERGE_FINALIZE_FAILED', `finalize: ${txCrMdP} 无 frontmatter，无法写 merging`, { cr, txws });
      const mergeCommitsYml = renderMergeCommits(payload.repos, snapshot, journal.txId, mergedAt);
      const verificationMd = renderMergeVerification(payload.repos, snapshot);
      await applyWriteSet({ root: txws, txRoot: ctx.installRoot, txId: journal.txId, entries: [
        { path: `change-requests/${cr}/cr.md`, beforeSha256: sha256(txCrMdText), afterSha256: sha256(nextCrMd), content: nextCrMd },
        { path: `change-requests/${cr}/merge-commits.yml`, beforeSha256: null, afterSha256: sha256(mergeCommitsYml), content: mergeCommitsYml },
        { path: `change-requests/${cr}/merge-verification.md`, beforeSha256: null, afterSha256: sha256(verificationMd), content: verificationMd },
      ] });
      const msg = `merge finalize ${cr}\n\nAI-First-Op: merge\nAI-First-Tx: ${journal.txId}\nAI-First-CR: ${cr}\n`;
      gitMust(txws, ['add', `change-requests/${cr}/cr.md`, `change-requests/${cr}/merge-commits.yml`, `change-requests/${cr}/merge-verification.md`]);
      gitMust(txws, ['commit', '--no-gpg-sign', '--file=-'], { input: msg });
      payload.finalizeCommit = gitMust(txws, ['rev-parse', 'HEAD']);
      payload.finalizeBaseSha = trunkSha;
      payload.mergedStatus = 'merging';
      payload.finalizeCommitted = true;
      did = true;
      await save('finalize-committed');
      faultPoint('merge-after-finalize-commit', { cr });
    }
    for (let attempt = 0; attempt < 3 && !payload.finalizePushed; attempt++) {
      assertGraph();
      gitMust(kb.rootPath, ['fetch', 'origin']);
      const remoteSha = gitMust(kb.rootPath, ['rev-parse', `refs/remotes/origin/${kb.trunk}`]);
      const isAncestor = gitRun(kb.rootPath, ['merge-base', '--is-ancestor', payload.finalizeCommit, remoteSha]).status === 0;
      const cls = classifyRemoteCommit({ remoteSha, expectedBase: payload.finalizeBaseSha, commitSha: payload.finalizeCommit, commitIsRemoteAncestor: isAncestor, journalSaysPublished: payload.finalizePushed });
      if (cls === 'confirmed') { payload.finalizePushed = true; did = true; await save('finalize-confirmed'); faultPoint('merge-after-finalize-push', { cr }); break; }
      if (cls === 'history-rewritten') {
        throw new TxError('MERGE_REMOTE_HISTORY_REWRITTEN', 'finalize 提交遇远端 trunk history rewrite，硬阻断（不猜测、不自动 force）', { cr, remoteSha, expectedBase: payload.finalizeBaseSha });
      }
      if (cls === 'rebuild') {
        // 他人推进 trunk：detached txws 从新 base 重建 finalize commit
        gitMust(txws, ['fetch', 'origin']);
        gitMust(txws, ['reset', '--hard', remoteSha]);
        gitMust(txws, ['checkout', '--detach', remoteSha]);
        const txCrMdText = fs.readFileSync(path.join(txws, 'change-requests', cr, 'cr.md'), 'utf8');
        const nextCrMd = crMdStatusText(txCrMdText, 'merging');
        if (!nextCrMd) throw new TxError('MERGE_FINALIZE_FAILED', `finalize rebuild: ${txws} cr.md 无 frontmatter`, { cr, txws });
        const mergeCommitsYml = renderMergeCommits(payload.repos, snapshot, journal.txId, mergedAt);
        const verificationMd = renderMergeVerification(payload.repos, snapshot);
        await applyWriteSet({ root: txws, txRoot: ctx.installRoot, txId: journal.txId, entries: [
          { path: `change-requests/${cr}/cr.md`, beforeSha256: sha256(txCrMdText), afterSha256: sha256(nextCrMd), content: nextCrMd },
          { path: `change-requests/${cr}/merge-commits.yml`, beforeSha256: null, afterSha256: sha256(mergeCommitsYml), content: mergeCommitsYml },
          { path: `change-requests/${cr}/merge-verification.md`, beforeSha256: null, afterSha256: sha256(verificationMd), content: verificationMd },
        ] });
        const msg = `merge finalize ${cr} (rebuild)\n\nAI-First-Op: merge\nAI-First-Tx: ${journal.txId}\nAI-First-CR: ${cr}\n`;
        gitMust(txws, ['add', `change-requests/${cr}/cr.md`, `change-requests/${cr}/merge-commits.yml`, `change-requests/${cr}/merge-verification.md`]);
        gitMust(txws, ['commit', '--no-gpg-sign', '--file=-'], { input: msg });
        payload.finalizeCommit = gitMust(txws, ['rev-parse', 'HEAD']);
        payload.finalizeBaseSha = remoteSha;
        did = true;
        await save('finalize-rebuild');
        continue;
      }
      gitMust(txws, ['push', `--force-with-lease=${kb.trunk}:${payload.finalizeBaseSha}`, 'origin', `HEAD:refs/heads/${kb.trunk}`]);
      payload.finalizePushed = true;
      did = true;
      await save('finalize-pushed');
      faultPoint('merge-after-finalize-push', { cr });
    }
    if (!payload.finalizePushed) throw new TxError('MERGE_REMOTE_STALE', 'finalize push 连续 rebuild 超过上限，无法收敛', { cr });
    payload.operationalWorkspace = txws;
    await save('complete');
    return {
      cr, txId: journal.txId, phase: 'complete', changed: did && !wasComplete,
      sideEffects: buildMergeSideEffects(payload), recoverCommand,
      operationalWorkspace: txws, mergedStatus: payload.mergedStatus,
    };
  } finally {
    await lock.release();
  }
}

/** merge status 只读快照：journal phase + 每仓 intent/observation；零写入、零 fetch。 */
export function mergeStatus(ctx, cr) {
  const base = path.join(ctx.installRoot, '.crctl', 'transactions', 'merge', cr);
  if (!fs.existsSync(base)) return { cr, phase: 'none', repos: [] };
  let latest = null;
  for (const txId of fs.readdirSync(base).sort()) {
    const p = path.join(base, txId, 'journal.json');
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!latest || Date.parse(j.updatedAt) > Date.parse(latest.updatedAt)) latest = j;
  }
  if (!latest || !latest.merge) return { cr, phase: 'none', repos: [] };
  return {
    cr,
    phase: latest.merge.phase,
    txId: latest.txId,
    repos: (latest.merge.repos || []).map((r) => ({ repo: r.repo, baseSha: r.baseSha, mergeSha: r.mergeSha, pushed: r.pushed, confirmed: r.confirmed })),
    finalizePushed: !!latest.merge.finalizePushed,
    operationalWorkspace: latest.merge.operationalWorkspace || null,
  };
}
/* ────────────────────────── writeback-apply ──────────────────────────
 * crctl 内部固定 generator/candidate；journal 前完成 manifest/path/hash/before/snapshot/gate preflight。
 * baseline 文件与 writing-back 状态同 recoverable write-set/commit/lease push，origin confirmed 后补投影。
 * 未发布遇 origin 前进 → txws reset + WRITEBACK_REMOTE_STALE；同一业务命令重跑，不 rebase/cherry-pick。
 */

const WRITEBACK_STAGES = ['baseline', 'tasks', 'traceability'];
const WRITEBACK_GENERATORS = {
  baseline: 'writeback-prd-sdd.mjs',
  tasks: 'writeback-tasks.mjs',
  traceability: 'writeback-traceability.mjs',
};
const HEX64 = /^[0-9a-f]{64}$/;

/** 新 writeback 路径的固定业务输入摘要；键序是 journal 恢复协议的一部分。 */
export function canonicalWritebackBusinessInput(input) {
  const milestoneFile = input.milestoneFile == null ? null : String(input.milestoneFile).replaceAll('\\', '/');
  if (milestoneFile != null) assertManifestPathSafe(milestoneFile, 'WRITEBACK_MILESTONE_PATH_INVALID');
  const value = {
    cr: input.cr,
    stage: input.stage,
    specId: input.specId,
    targetVersion: typeof input.targetVersion === 'string' && input.targetVersion.startsWith('v')
      ? input.targetVersion.slice(1) : input.targetVersion,
    milestoneName: input.milestoneName ?? null,
    brief: input.brief ?? null,
    milestoneFile,
  };
  const canonicalJson = JSON.stringify(value);
  return { value, canonicalJson, digest: sha256(canonicalJson) };
}

/** candidate 是 operational workspace 内部派生物，不接受调用方路径。 */
export function resolveWritebackCandidate(txws, cr, stage) {
  if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) throw new TxError('WRITEBACK_CR_INVALID', `writeback 需要合法 CR-ID，收到 ${cr}`, { cr });
  if (!WRITEBACK_STAGES.includes(stage)) throw new TxError('WRITEBACK_STAGE_INVALID', `stage 非法: ${stage}`, { stage });
  const root = fs.realpathSync(txws);
  const dir = path.join(root, '.crctl', 'candidates', cr, stage);
  const rel = path.relative(root, dir);
  if (path.isAbsolute(rel) || rel.startsWith(`..${path.sep}`)) throw new TxError('WRITEBACK_CANDIDATE_OUTSIDE_TX', `candidate 目录越界: ${dir}`);
  assertNoSymlinkParents(root, `${rel.split(path.sep).join('/')}/manifest.json`);
  return { dir, manifest: path.join(dir, 'manifest.json') };
}

/** manifest path 安全（SDD §3.5）：非 absolute、无 ..、无反斜杠、无重复分隔符、POSIX 相对路径。 */
export function assertManifestPathSafe(relPath, code) {
  if (typeof relPath !== 'string' || !relPath) throw new TxError(code, `manifest path 非法（空）`);
  if (path.isAbsolute(relPath) || relPath.includes('\\') || relPath.includes('..') || relPath.includes('//') || relPath.startsWith('/')) {
    throw new TxError(code, `manifest path 非法（absolute/.. /反斜杠/重复分隔符）: ${relPath}`, { path: relPath });
  }
  const segs = relPath.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    throw new TxError(code, `manifest path 段非法: ${relPath}`, { path: relPath });
  }
}

/** txws 内现存路径前缀链不得含 symlink（FR-09：恶意 symlink parent 拒绝，防写逃逸）。 */
function assertNoSymlinkParents(root, relPath) {
  let cur = root;
  for (const seg of relPath.split('/').slice(0, -1)) {
    cur = path.join(cur, seg);
    if (!fs.existsSync(cur)) break;
    const st = fs.lstatSync(cur);
    if (st.isSymbolicLink()) {
      throw new TxError('WRITEBACK_SYMLINK_PARENT', `manifest 目标父目录含 symlink: ${relPath}`, { path: relPath });
    }
  }
}

/** 与 writeback/scripts/lib.mjs#computeInputDigest 同一 canonical 公式（两侧独立内联，
 * 由测试交叉验证防漂移）：inputDigest = sha256(JSON({v,stage,cr,specId,targetVersion,generator,files}))。 */
export function writebackInputDigest(m) {
  const canon = JSON.stringify({
    v: m.v, stage: m.stage, cr: m.cr, specId: m.specId, targetVersion: m.targetVersion,
    generator: { id: m.generator.id, sha256: m.generator.sha256 },
    files: m.files.map((f) => ({ path: f.path, beforeSha256: f.beforeSha256 == null ? null : f.beforeSha256, afterSha256: f.afterSha256 })),
  });
  return sha256(canon);
}

/** stage → 允许路径前缀（v1 allowlist，SDD §3.5：仅 create/replace，禁 delete/rename/chmod）。 */
export function writebackAllowlist(stage, specId) {
  if (stage === 'baseline') {
    return {
      specId,
      match: (p) => p === `specs/_index.yml` || p === `specs/${specId}/PRD.md` || p === `specs/${specId}/SDD.md`,
    };
  }
  if (stage === 'tasks') {
    return {
      specId: null,
      match: (p) => p === 'delivery/task/_index.yaml' || /^delivery\/task\/TASK-[\w.-]+\.md$/.test(p),
    };
  }
  if (stage === 'traceability') {
    return { specId, match: (p) => p === `specs/${specId}/traceability.yml` };
  }
  throw new TxError('WRITEBACK_STAGE_INVALID', `stage 非法: ${stage}`, { stage });
}

function validateWritebackManifest(m, { cr, stage, specId, targetVersion, candidate, txws }) {
  if (!m || typeof m !== 'object') throw new TxError('WRITEBACK_MANIFEST_INVALID', 'manifest 非对象');
  if (m.v !== 1) throw new TxError('WRITEBACK_MANIFEST_INVALID', `manifest v=${m.v}（仅支持 v1）`);
  if (!WRITEBACK_STAGES.includes(m.stage)) throw new TxError('WRITEBACK_STAGE_INVALID', `manifest stage=${m.stage} 非法`, { stage: m.stage });
  if (m.stage !== stage) throw new TxError('WRITEBACK_MANIFEST_MISMATCH', `manifest stage=${m.stage} 与 --stage ${stage} 不一致`);
  if (m.cr !== cr) throw new TxError('WRITEBACK_MANIFEST_MISMATCH', `manifest cr=${m.cr} 与 CR ${cr} 不一致`);
  if (m.specId !== specId) throw new TxError('WRITEBACK_MANIFEST_MISMATCH', `manifest specId=${m.specId} 与 --spec-id ${specId} 不一致`);
  if (typeof m.targetVersion !== 'string' || !m.targetVersion) throw new TxError('WRITEBACK_MANIFEST_INVALID', 'manifest 缺 targetVersion');
  if (targetVersion != null && m.targetVersion !== targetVersion) {
    throw new TxError('WRITEBACK_MANIFEST_MISMATCH', `manifest targetVersion=${m.targetVersion} 与业务输入 ${targetVersion} 不一致`);
  }
  if (!m.generator || typeof m.generator.id !== 'string' || !/^writeback-(prd-sdd|tasks|traceability)$/.test(m.generator.id) || !HEX64.test(m.generator.sha256 || '')) {
    throw new TxError('WRITEBACK_MANIFEST_INVALID', 'manifest generator 声明非法（id/sha256）', { generator: m.generator });
  }
  if (m.generator.id !== stageToGenerator(stage)) {
    throw new TxError('WRITEBACK_MANIFEST_MISMATCH', `manifest generator=${m.generator.id} 与 stage ${stage} 不符`);
  }
  const candidateReal = fs.realpathSync(candidate);
  const txwsReal = fs.realpathSync(txws);
  const candidateRel = path.relative(txwsReal, candidateReal);
  if (path.basename(candidateReal) !== 'manifest.json' || candidateRel.startsWith(`..${path.sep}`) || path.isAbsolute(candidateRel)) {
    throw new TxError('WRITEBACK_CANDIDATE_OUTSIDE_TX', `candidate 必须是 Transaction Workspace 内的 manifest.json: ${candidate}`, { candidate });
  }
  const generatorPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'writeback', 'scripts', `${m.generator.id}.mjs`);
  const actualGeneratorSha = sha256(fs.readFileSync(generatorPath, 'utf8'));
  if (m.generator.sha256 !== actualGeneratorSha) {
    throw new TxError('WRITEBACK_GENERATOR_MISMATCH', `generator SHA 与当前版本化脚本不一致: ${m.generator.id}`, { expected: actualGeneratorSha, actual: m.generator.sha256 });
  }
  if (!Array.isArray(m.files) || m.files.length === 0) throw new TxError('WRITEBACK_MANIFEST_EMPTY', 'manifest files 为空');
  const allow = writebackAllowlist(stage, specId);
  const seen = new Set();
  let prev = null;
  for (const f of m.files) {
    assertManifestPathSafe(f.path, 'WRITEBACK_PATH_UNSAFE');
    if (seen.has(f.path)) throw new TxError('WRITEBACK_PATH_DUPLICATE', `manifest files 路径重复: ${f.path}`, { path: f.path });
    seen.add(f.path);
    if (prev != null && f.path < prev) throw new TxError('WRITEBACK_PATH_UNSORTED', `manifest files 未按 POSIX 字典序: ${f.path} < ${prev}`);
    prev = f.path;
    if (!allow.match(f.path)) throw new TxError('WRITEBACK_PATH_NOT_ALLOWED', `manifest 路径不在 ${stage} allowlist: ${f.path}`, { path: f.path });
    if (f.beforeSha256 != null && !HEX64.test(f.beforeSha256)) throw new TxError('WRITEBACK_HASH_INVALID', `beforeSha256 非法: ${f.path}`);
    if (!HEX64.test(f.afterSha256 || '')) throw new TxError('WRITEBACK_HASH_INVALID', `afterSha256 非法: ${f.path}`);
    if (f.blob !== `blobs/${f.afterSha256}`) throw new TxError('WRITEBACK_BLOB_REF_INVALID', `blob 引用非法（必须 blobs/<afterSha256>）: ${f.path}`, { blob: f.blob });
    const blobPath = path.join(path.dirname(candidate), f.blob);
    let blobText;
    try { blobText = fs.readFileSync(blobPath, 'utf8'); }
    catch { throw new TxError('WRITEBACK_BLOB_MISSING', `blob 不存在: ${f.blob}`, { blob: f.blob }); }
    if (sha256(blobText) !== f.afterSha256) throw new TxError('WRITEBACK_BLOB_HASH_MISMATCH', `blob 哈希与 afterSha256 不符: ${f.blob}`, { blob: f.blob });
    if (!f._blobText) f._blobText = blobText; // 应用阶段复用，避免二次读
  }
  if (m.inputDigest !== writebackInputDigest(m)) {
    throw new TxError('WRITEBACK_MANIFEST_TAMPERED', 'manifest inputDigest 与 canonical 内容不符（篡改或重放）');
  }
  return {
    parsed: m,
    files: m.files.map((f) => ({
      path: f.path, beforeSha256: f.beforeSha256 == null ? null : f.beforeSha256,
      afterSha256: f.afterSha256, blobText: f._blobText,
    })),
    plannedExisting: new Set(m.files.map((f) => f.path)),
  };
}

function stageToGenerator(stage) {
  return stage === 'baseline' ? 'writeback-prd-sdd' : stage === 'tasks' ? 'writeback-tasks' : 'writeback-traceability';
}

function generatorError(result) {
  let parsed = null;
  try { parsed = JSON.parse(result.stderr || ''); } catch { /* generator 非结构化崩溃 */ }
  const e = parsed && parsed.error;
  return new TxError(e?.code || 'WRITEBACK_GENERATOR_FAILED', e?.message || `固定 generator 失败（exit=${result.status}）: ${(result.stderr || result.stdout || '').trim()}`, e || {});
}

function readPreparedCandidate({ txws, candidate, cr, stage, specId, targetVersion, checkBefore = true }) {
  let manifestText;
  try { manifestText = fs.readFileSync(candidate.manifest, 'utf8').replaceAll('\r\n', '\n'); }
  catch { throw new TxError('WRITEBACK_MANIFEST_MISSING', `固定 generator 未生成 manifest: ${candidate.manifest}`); }
  let manifest;
  try { manifest = JSON.parse(manifestText); }
  catch { throw new TxError('WRITEBACK_MANIFEST_INVALID', `manifest JSON 非法: ${candidate.manifest}`); }
  const validated = validateWritebackManifest(manifest, { cr, stage, specId, targetVersion, candidate: candidate.manifest, txws });
  if (checkBefore) {
    for (const f of validated.files) {
      assertNoSymlinkParents(txws, f.path);
      const current = readHashRaw(path.join(txws, ...f.path.split('/')));
      if (current !== f.beforeSha256) {
        throw new TxError('WRITEBACK_BEFORE_MISMATCH', `${f.path} 当前内容与 beforeSha256 不符`, { path: f.path, expected: f.beforeSha256, actual: current });
      }
    }
  }
  return { textLf: manifestText, digest: sha256(manifestText), ...validated };
}

/** 固定 generator → 单次 manifest/blob snapshot → before anchors；TASK-04 前不接公共 CLI。 */
export function prepareWritebackCandidate(input) {
  const business = canonicalWritebackBusinessInput(input);
  const { cr, stage, specId } = business.value;
  if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) throw new TxError('WRITEBACK_CR_INVALID', `writeback 需要合法 CR-ID，收到 ${cr}`, { cr });
  if (!WRITEBACK_STAGES.includes(stage)) throw new TxError('WRITEBACK_STAGE_INVALID', `stage 非法: ${stage}`, { stage });
  if (typeof specId !== 'string' || !specId) throw new TxError('WRITEBACK_SPEC_INVALID', 'writeback 需要 specId');
  if (typeof business.value.targetVersion !== 'string' || !business.value.targetVersion) throw new TxError('WRITEBACK_VERSION_INVALID', 'writeback 需要 targetVersion');
  if (stage === 'traceability' && !business.value.milestoneFile) throw new TxError('WRITEBACK_MILESTONE_PATH_INVALID', 'traceability 需要 milestoneFile');
  if (stage === 'tasks' && (business.value.milestoneName != null || business.value.brief != null || business.value.milestoneFile != null)) {
    throw new TxError('WRITEBACK_STAGE_ARGS_INVALID', 'tasks 不接受 milestone 参数');
  }

  const txws = fs.realpathSync(input.txws);
  const candidate = resolveWritebackCandidate(txws, cr, stage);
  fs.rmSync(candidate.dir, { recursive: true, force: true });
  fs.mkdirSync(candidate.dir, { recursive: true });
  if (gitRun(txws, ['check-ignore', '-q', candidate.dir]).status !== 0) {
    throw new TxError('WRITEBACK_CANDIDATE_NOT_IGNORED', `candidate 目录未被 Git ignore: ${candidate.dir}`);
  }
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'writeback', 'scripts', WRITEBACK_GENERATORS[stage]);
  const args = [script, '--workspace', txws, '--cr', cr, '--spec', specId, '--version', business.value.targetVersion, '--candidate-out', candidate.dir];
  if (business.value.milestoneName != null) args.push('--milestone-name', String(business.value.milestoneName));
  if (business.value.brief != null) args.push('--brief', String(business.value.brief));
  if (business.value.milestoneFile != null) args.push('--milestone-file', path.join(txws, ...business.value.milestoneFile.split('/')));
  const result = spawnSync(process.execPath, args, { cwd: txws, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw generatorError(result);
  let output = null;
  try { output = JSON.parse(result.stdout || '{}'); } catch { throw new TxError('WRITEBACK_GENERATOR_OUTPUT_INVALID', '固定 generator stdout 非 JSON'); }
  if (output.noop === true) return { noop: true, reason: output.reason || null, business, candidate };

  return {
    noop: false, business, candidate,
    snapshot: readPreparedCandidate({ txws, candidate, cr, stage, specId, targetVersion: business.value.targetVersion }),
  };
}

// before/after CAS 锚点 = 磁盘字节 sha256（与 durable-tx applyWriteSet 的 readHash 一致；
// 不做 CRLF 归一——Windows autocrlf 检出 CRLF 不影响锚点一致性，generator 侧 readHashRaw 同语义）
const readHashRaw = (p) => {
  let buf;
  try { buf = fs.readFileSync(p); } catch { return null; }
  return sha256(buf.toString('utf8'));
};

async function applyWritebackAtomic(ctx, input) {
  const { cr, stage, specId } = input;
  const opWs = resolveOperationalWorkspace(ctx, cr);
  if (opWs.source !== 'transaction-workspace') {
    throw new TxError('WRITEBACK_STATE_MISMATCH', `writeback-apply 需要 finalize 后 authority（Transaction Workspace），当前 phase=${opWs.phase}（source=${opWs.source}）`, { cr, phase: opWs.phase });
  }
  const txws = opWs.path;
  const kb = getRepository(ctx, ctx.knowledgeBaseRepoId);
  const key = `${cr}-${stage}`;
  const business = canonicalWritebackBusinessInput(input);
  const fixedCandidate = resolveWritebackCandidate(txws, cr, stage);
  const found = loadExistingJournal({ root: ctx.installRoot, op: 'writeback', key });
  let prepared;
  if (found) {
    if (found.journal.writeback?.businessInputDigest && found.journal.writeback.businessInputDigest !== business.digest) {
      throw new TxError('TX_INPUT_CONFLICT', `writeback/${key} 既有事务与当前业务输入不一致`, { txId: found.journal.txId });
    }
    if (!fs.existsSync(fixedCandidate.manifest)) {
      throw new TxError('WRITEBACK_CANDIDATE_RECOVERY_MISSING', `既有事务的固定 candidate 缺失: ${fixedCandidate.manifest}`, { cr, stage });
    }
    const snapshot = readPreparedCandidate({
      txws, candidate: fixedCandidate, cr, stage, specId,
      targetVersion: business.value.targetVersion, checkBefore: false,
    });
    const composite = sha256(JSON.stringify({ businessInputDigest: business.digest, manifestDigest: snapshot.digest }));
    if (found.journal.inputDigest !== composite) {
      throw new TxError('TX_INPUT_CONFLICT', `writeback/${key} 既有事务与当前业务输入/candidate 不一致`, { txId: found.journal.txId });
    }
    prepared = { noop: false, business, candidate: fixedCandidate, snapshot };
  } else {
    prepared = prepareWritebackCandidate({ ...input, txws });
    if (prepared.noop) {
      if (stage === 'baseline' && opWs.phase === 'merging') {
        throw new TxError('WRITEBACK_ATOMIC_FACT_MISSING', 'baseline 已 noop 但状态仍为 merging，且无复合事务 journal 可证明原子事实');
      }
      return { cr, phase: 'complete', changed: false, commit: null, status: opWs.phase, files: [], warnings: [], reason: prepared.reason };
    }
  }
  const { snapshot } = prepared;
  const manifestDigest = snapshot.digest;
  const inputDigest = sha256(JSON.stringify({ businessInputDigest: business.digest, manifestDigest }));
  const recoverCommand = `crctl writeback-apply ${cr} --stage ${stage} --spec-id ${JSON.stringify(specId)} --target-version ${JSON.stringify(business.value.targetVersion)}`
    + (business.value.milestoneName == null ? '' : ` --milestone-name ${JSON.stringify(business.value.milestoneName)}`)
    + (business.value.brief == null ? '' : ` --brief ${JSON.stringify(business.value.brief)}`)
    + (business.value.milestoneFile == null ? '' : ` --milestone-file ${JSON.stringify(business.value.milestoneFile)}`)
    + ` --workspace ${JSON.stringify(input.workspace || ctx.installRoot)}`;

  let advanceCandidate = null;
  if (!found) {
    const approvalText = fs.readFileSync(path.join(txws, 'change-requests', cr, 'approval.yml'), 'utf8');
    const approval = parseYaml(approvalText.replaceAll('\r\n', '\n')) || {};
    const releaseSubjects = approval?.code?.['release-subjects'];
    if (!releaseSubjects) throw new TxError('WRITEBACK_SNAPSHOT_MISSING', 'txws approval.yml#code.release-subjects 缺失', { cr });
    const snapshotCheck = await verifyReleaseSubjects(ctx, cr, releaseSubjects);
    if (!snapshotCheck.ok) throw new TxError('WRITEBACK_RELEASE_SUBJECT_DRIFT', `writeback 前 signed release-subjects 漂移（kind=${snapshotCheck.kind}）`, { cr, kind: snapshotCheck.kind, ...snapshotCheck.details });
    gitMust(kb.rootPath, ['fetch', 'origin']);
    const originSha = gitMust(kb.rootPath, ['rev-parse', `refs/remotes/origin/${kb.trunk}`]);
    const txHead = gitMust(txws, ['rev-parse', 'HEAD']);
    if (originSha !== txHead) {
      gitMust(txws, ['fetch', 'origin']);
      gitMust(txws, ['reset', '--hard', originSha]);
      gitMust(txws, ['checkout', '--detach', originSha]);
      throw new TxError('WRITEBACK_REMOTE_STALE', `origin trunk 在 candidate 生成后前进（${txHead.slice(0, 12)} -> ${originSha.slice(0, 12)}），txws 已重置，请重试`, { cr, originSha, txHead });
    }
    if (stage === 'baseline') {
      if (typeof input.validateBaselineAdvance !== 'function' || typeof input.emitStatusEvent !== 'function' || typeof input.emitAdvanceAudit !== 'function') {
        throw new TxError('WRITEBACK_CALLBACK_MISSING', 'baseline writeback 缺 validateBaselineAdvance/emitStatusEvent/emitAdvanceAudit callback');
      }
      advanceCandidate = await input.validateBaselineAdvance({ workspace: txws, plannedExisting: snapshot.plannedExisting });
    }
  }

  const lock = await acquireLock({ root: ctx.installRoot, scope: `writeback-${cr}-${stage}`, op: 'writeback', cr });
  try {
    let { journal, journalPath, created } = await loadOrCreateJournal({
      root: ctx.installRoot, op: 'writeback', key, graphDigest: ctx.graphDigest, inputDigest,
    });
    const payload = journal.writeback || {
      cr, stage, phase: 'start', specId, targetVersion: business.value.targetVersion,
      businessInputDigest: business.digest, manifestDigest,
      committed: false, commit: null, baseSha: null, pushed: false, files: null,
      statusTransition: null, outboxEmitted: false, auditEmitted: false,
    };
    journal.writeback = payload;
    const wasComplete = payload.phase === 'complete';
    let did = false;
    const warnings = [];
    const save = async (phase) => {
      payload.phase = phase; journal.phase = phase;
      journal = await saveJournal({ path: journalPath, journal });
    };
    if (created) {
      await save('start');
      faultPoint('writeback-after-journal-create', { cr, stage });
    }
    if (payload.businessInputDigest !== business.digest || payload.manifestDigest !== manifestDigest) {
      throw new TxError('TX_INPUT_CONFLICT', `writeback/${key} payload digest 漂移`, { txId: journal.txId });
    }
    await recoverWriteSet({ txRoot: ctx.installRoot, txId: journal.txId });

    if (stage === 'baseline' && !payload.statusTransition) {
      if (!advanceCandidate) {
        if (typeof input.validateBaselineAdvance !== 'function') throw new TxError('WRITEBACK_CALLBACK_MISSING', 'baseline 恢复缺 validateBaselineAdvance callback');
        advanceCandidate = await input.validateBaselineAdvance({ workspace: txws, plannedExisting: snapshot.plannedExisting });
      }
      const afterText = crMdStatusText(advanceCandidate.beforeText, 'writing-back', { at: journal.createdAt });
      if (!afterText) throw new TxError('WRITEBACK_STATUS_INVALID', 'baseline cr.md 无合法 frontmatter');
      payload.statusTransition = {
        from: 'merging', to: 'writing-back', trigger: 'writeback-prd-sdd', path: advanceCandidate.path,
        transitionAt: journal.createdAt, beforeSha256: advanceCandidate.beforeSha256,
        afterSha256: sha256(afterText), afterText,
      };
      await save('status-prepared');
    }

    gitMust(kb.rootPath, ['fetch', 'origin']);
    let originSha = gitMust(kb.rootPath, ['rev-parse', `refs/remotes/origin/${kb.trunk}`]);
    if (payload.pushed) {
      const confirmed = gitRun(kb.rootPath, ['merge-base', '--is-ancestor', payload.commit, originSha]).status === 0;
      if (!confirmed) throw new TxError('WRITEBACK_REMOTE_HISTORY_REWRITTEN', 'writeback 已发布 commit 从 origin 历史消失', { cr, originSha });
    }
    if (!payload.committed) {
      const txHead = gitMust(txws, ['rev-parse', 'HEAD']);
      if (originSha !== txHead) {
        gitMust(txws, ['reset', '--hard', originSha]);
        gitMust(txws, ['checkout', '--detach', originSha]);
        fs.rmSync(path.dirname(journalPath), { recursive: true, force: true });
        throw new TxError('WRITEBACK_REMOTE_STALE', 'origin 在 commit 前前进，txws 已重置，请重试', { cr, originSha, txHead });
      }
      const entries = snapshot.files.map((f) => ({
        path: f.path, beforeSha256: f.beforeSha256, afterSha256: f.afterSha256, content: f.blobText,
      }));
      if (payload.statusTransition) entries.push({
        path: payload.statusTransition.path,
        beforeSha256: payload.statusTransition.beforeSha256,
        afterSha256: payload.statusTransition.afterSha256,
        content: payload.statusTransition.afterText,
      });
      await applyWriteSet({ root: txws, txRoot: ctx.installRoot, txId: journal.txId, entries });
      faultPoint('writeback-after-apply', { cr, stage });
      gitMust(txws, ['add', '--', ...entries.map((e) => e.path)]);
      const staged = gitMust(txws, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n').filter(Boolean).sort();
      const expected = entries.map((e) => e.path).sort();
      if (staged.length !== expected.length || staged.some((p, i) => p !== expected[i])) {
        throw new TxError('WRITEBACK_STAGED_MISMATCH', 'staged set 与复合 write-set 不精确相等', { expected, staged });
      }
      const msg = `writeback ${stage} ${cr}\n\nAI-First-Op: writeback\nAI-First-Tx: ${journal.txId}\nAI-First-CR: ${cr}\nAI-First-Writeback-Stage: ${stage}\n`;
      gitMust(txws, ['commit', '--no-gpg-sign', '--file=-'], { input: msg });
      payload.commit = gitMust(txws, ['rev-parse', 'HEAD']);
      payload.baseSha = originSha;
      payload.files = entries.map(({ path: p, beforeSha256, afterSha256 }) => ({ path: p, beforeSha256, afterSha256 }));
      payload.committed = true; did = true;
      await save('committed');
      faultPoint('writeback-after-commit', { cr, stage });
    }
    if (!payload.pushed) {
      gitMust(kb.rootPath, ['fetch', 'origin']);
      originSha = gitMust(kb.rootPath, ['rev-parse', `refs/remotes/origin/${kb.trunk}`]);
      const confirmed = gitRun(kb.rootPath, ['merge-base', '--is-ancestor', payload.commit, originSha]).status === 0;
      if (!confirmed && originSha !== payload.baseSha) throw new TxError('WRITEBACK_REMOTE_STALE', 'origin 在 commit 后前进，拒绝覆盖', { cr, originSha });
      if (!confirmed) gitMust(txws, ['push', `--force-with-lease=${kb.trunk}:${payload.baseSha}`, 'origin', `HEAD:refs/heads/${kb.trunk}`]);
      gitMust(kb.rootPath, ['fetch', 'origin']);
      originSha = gitMust(kb.rootPath, ['rev-parse', `refs/remotes/origin/${kb.trunk}`]);
      if (gitRun(kb.rootPath, ['merge-base', '--is-ancestor', payload.commit, originSha]).status !== 0) {
        throw new TxError('WRITEBACK_REMOTE_STALE', 'push 后 origin 未确认 writeback commit', { cr, originSha });
      }
      payload.pushed = true; did = true;
      await save('pushed');
      faultPoint('writeback-after-push', { cr, stage });
    }

    if (stage === 'baseline') {
      const tr = payload.statusTransition;
      if (!payload.outboxEmitted) {
        try {
          if (typeof input.emitStatusEvent !== 'function') throw new Error('emitStatusEvent callback missing');
          await input.emitStatusEvent({ cr, from: tr.from, to: tr.to, trigger: tr.trigger, commit: payload.commit, dedupName: `status-${cr}-${payload.commit}.json` });
          faultPoint('writeback-after-status-outbox', { cr, stage });
          payload.outboxEmitted = true; await save('pushed');
        } catch (e) { if (e instanceof TxError && e.code === 'FAULT_INJECTED') throw e; warnings.push({ code: 'EMIT_FAILED', projection: 'status', message: e.message }); }
      }
      if (!payload.auditEmitted) {
        try {
          if (typeof input.emitAdvanceAudit !== 'function') throw new Error('emitAdvanceAudit callback missing');
          await input.emitAdvanceAudit({ cr, from: tr.from, to: tr.to, trigger: tr.trigger, commit: payload.commit, dedupKey: `advance:${cr}:${payload.commit}` });
          faultPoint('writeback-after-advance-audit', { cr, stage });
          payload.auditEmitted = true; await save('pushed');
        } catch (e) { if (e instanceof TxError && e.code === 'FAULT_INJECTED') throw e; warnings.push({ code: 'EMIT_FAILED', projection: 'audit', message: e.message }); }
      }
    }
    await save('complete');
    return {
      cr, txId: journal.txId, phase: 'complete', changed: did && !wasComplete,
      commit: payload.commit, status: payload.statusTransition?.to || opWs.phase,
      files: (payload.files || []).map((f) => f.path), warnings, recoverCommand,
    };
  } finally { await lock.release(); }
}

/** 公共 writeback 深原语：candidate/generator 路径全部内部化。 */
export async function applyWriteback(ctx, input) {
  return applyWritebackAtomic(ctx, input);
}
/* ────────────────────────── TASK-09：archive 与 cleanup-pending ──────────────────────────
 * 单一幂等归档入口（SDD §4.5/§5.4）：writing-back → detached txws 四账本（cr.md + _backlog.yml +
 * _history.yml + _index.yml）同批 recoverable write-set → archive commit + trailer → lease push；
 * origin confirmed 后 journal 转 cleanup-pending，仅清理由 graph+journal+ancestry 证明且 clean 的
 * 资源（txws、CR worktree、本地 requirement 分支）；rejected/withdrawn 的未合并远端 ref 保留并输出
 * preservedRefs；任一 cleanup 失败返回 phase=cleanup-pending（status 恒 archived，重跑只续清理）。
 */

/** 轻量条目块提取（与 crctl.mjs matchEntryBlock 同语义，TxError 风格；TASK-10 旧命令删除后收敛）。 */
function matchEntryBlockTx(text, id) {
  const lines = text.split('\n');
  let startLine = -1, indent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)- id:\s*["']?([^\s"']+)["']?\s*$/);
    if (m && m[2] === id) { startLine = i; indent = m[1].length; break; }
  }
  if (startLine === -1) return null;
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)- id:\s*["']?([^\s"']+)["']?\s*$/);
    if (m && m[1].length <= indent) { endLine = i; break; }
  }
  return { text: lines.slice(startLine, endLine).join('\n'), indent };
}

/** 归档收件人：owners 三角色去重 → legacy 顶层 owner → 空则 ARCHIVE_RECIPIENTS_MISSING。 */
function archiveRecipients(backlogText, cr) {
  const blk = matchEntryBlockTx(backlogText.replaceAll('\r\n', '\n'), cr);
  if (!blk) throw new TxError('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`);
  const o = {};
  let owner = null;
  for (const line of blk.text.split('\n')) {
    const t = line.trim();
    let m = /^owner:\s*(.+)$/.exec(t);
    if (m) owner = m[1].replace(/^"|"$/g, '');
    m = /^(\w+):\s*id:\s*(.+)$/.exec(t);
    if (m) o[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  const to = [...new Set([o.requirement, o.development, o.test].filter(Boolean))];
  if (to.length === 0 && owner) to.push(owner);
  if (to.length === 0) throw new TxError('ARCHIVE_RECIPIENTS_MISSING', `归档事件收件人为空：${cr} 缺少 owners 三角色且无顶层 owner，拒绝归档`);
  return to;
}

/** 四账本归档编辑（纯函数，TxError 风格）：backlog 移出 + history 追加（含 notify-log）+ index 终态。 */
export function archiveLedgerEdits({ backlogText, historyText, indexText, cr, finalStatus, specId, reason, now }) {
  const normB = backlogText.replaceAll('\r\n', '\n');
  const blk = matchEntryBlockTx(normB, cr);
  if (!blk) throw new TxError('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`);
  const lines = normB.split('\n');
  const start = lines.indexOf(blk.text.split('\n')[0]);
  const blockLines = blk.text.split('\n');
  // 定位块在 normB 中的偏移（缩进块 + 后续直到下一同缩进条目/结尾）
  let endLine = start + blockLines.length;
  while (endLine < lines.length) {
    const m = lines[endLine].match(/^([ \t]*)- id:/);
    if (m && m[1].length <= blk.indent) break;
    if (lines[endLine].trim() === '' && endLine + 1 < lines.length && /^[ \t]*- id:/.test(lines[endLine + 1])) break;
    endLine++;
  }
  const newBacklog = lines.slice(0, start).concat(lines.slice(endLine)).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  const normH = historyText == null || historyText.trim() === '' ? null : historyText.replaceAll('\r\n', '\n').trimEnd();
  if (normH && matchEntryBlockTx(normH, cr)) throw new TxError('ENTRY_ALREADY_IN_HISTORY', `${cr} 已在 _history.yml，禁止重复归档`);
  const minIndent = Math.min(...blk.text.split('\n').filter((l) => l.trim() !== '').map((l) => (l.match(/^[ \t]*/) || [''])[0].length));
  const entry = blk.text.split('\n').map((l) => '  ' + l.slice(minIndent)).join('\n');
  const reasonEsc = String(reason || '').replaceAll('"', '\\"');
  const to = archiveRecipients(normB, cr);
  const payload = { 'final-status': finalStatus, 'archive-reason': String(reason || ''), 'archived-at': now, ...(specId ? { 'writeback-spec-id': specId } : {}) };
  const notifyLog = [
    '    notify-log:',
    `      - at: "${now}"`,
    `        event: ${finalStatus}`,
    `        to: ${JSON.stringify(to)}`,
    `        payload: ${JSON.stringify(payload)}`,
  ];
  const enrich = [
    `    final-status: ${finalStatus}`,
    `    archive-reason: "${reasonEsc}"`,
    specId ? `    writeback-spec-id: ${specId}` : null,
    `    archived-at: "${now}"`,
  ].filter(Boolean).join('\n');
  const record = entry + '\n' + enrich + '\n' + notifyLog.join('\n') + '\n';
  const newHistory = (normH == null ? 'history:' : normH) + '\n' + record;
  const normI = indexText.replaceAll('\r\n', '\n');
  const iBlk = matchEntryBlockTx(normI, cr);
  if (!iBlk) throw new TxError('INDEX_ENTRY_NOT_FOUND', `${cr} 不在 _index.yml`);
  const fieldIndent = ' '.repeat(iBlk.indent + 2);
  let body = iBlk.text;
  const set = (key, val) => {
    const re = new RegExp(`^([ \\t]*)${key}:.*$`, 'm');
    return re.test(body) ? body.replace(re, `$1${key}: ${val}`) : body + `\n${fieldIndent}${key}: ${val}`;
  };
  body = set('status', finalStatus);
  body = set('archived-at', `"${now}"`);
  if (specId) body = set('writeback-spec-id', String(specId));
  const iLines = normI.split('\n');
  const iStart = iLines.indexOf(iBlk.text.split('\n')[0]);
  const newIndex = iLines.slice(0, iStart).concat(body.split('\n'), iLines.slice(iStart + iBlk.text.split('\n').length)).join('\n');
  return { newBacklog, newHistory, newIndex, recipients: to };
}

/** 归档清理：删除 txws 与各仓 CR worktree/本地分支；rejected/withdrawn 远端 ref 保留。
 * 只删 clean 资源；dirty/未知 workspace 零删除（保留在 remaining）。返回 {remaining, preservedRefs}。 */
function archiveCleanup(ctx, cr, status, journalTxId) {
  const remaining = [];
  const preservedRefs = [];
  const kb = getRepository(ctx, ctx.knowledgeBaseRepoId);
  // 1) txws（detached，archive commit 后应 clean；删除失败/非 clean → 保留）
  const txws = txWorkspacePath(ctx, cr);
  if (fs.existsSync(txws)) {
    const dirty = gitRun(txws, ['status', '--porcelain']).stdout.trim() !== '';
    if (dirty) {
      remaining.push({ kind: 'txws', path: txws, why: 'dirty' });
    } else {
      const rm = gitRun(kb.rootPath, ['worktree', 'remove', '--force', txws]);
      if (rm.status !== 0) remaining.push({ kind: 'txws', path: txws, why: 'remove-failed' });
    }
  }
  // 2) 各仓 CR worktree + 本地 requirement 分支；远端 ref：archived 删除，rejected/withdrawn 保留
  for (const repo of ctx.repositories) {
    const wt = path.join(repo.worktreePath, cr);
    if (fs.existsSync(wt)) {
      const dirty = gitRun(wt, ['status', '--porcelain']).stdout.trim() !== '';
      if (dirty) { remaining.push({ kind: 'cr-worktree', repo: repo.id, path: wt, why: 'dirty' }); continue; }
      const rm = gitRun(repo.rootPath, ['worktree', 'remove', '--force', wt]);
      if (rm.status !== 0) { remaining.push({ kind: 'cr-worktree', repo: repo.id, path: wt, why: 'remove-failed' }); continue; }
    }
    gitRun(repo.rootPath, ['fetch', 'origin']); // cleanup 容错：fetch 失败仅导致 ref 判定保守
    const remoteRef = `refs/remotes/origin/${branchForCr(cr)}`;
    const hasRemote = gitRun(repo.rootPath, ['rev-parse', '--verify', '--quiet', remoteRef]).status === 0;
    if (status === 'rejected' || status === 'withdrawn') {
      if (hasRemote) preservedRefs.push(`${repo.id}:refs/heads/${branchForCr(cr)}`);
      // 本地分支保留（未合并事实源）
    } else {
      const trunkRef = `refs/remotes/origin/${repo.trunk}`;
      if (hasRemote) {
        const merged = gitRun(repo.rootPath, ['merge-base', '--is-ancestor', remoteRef, trunkRef]).status === 0;
        if (!merged) {
          remaining.push({ kind: 'remote-ref', repo: repo.id, ref: `refs/heads/${branchForCr(cr)}`, why: 'not-merged' });
          continue;
        }
        const del = gitRun(repo.rootPath, ['push', 'origin', `:refs/heads/${branchForCr(cr)}`]);
        if (del.status !== 0) {
          remaining.push({ kind: 'remote-ref', repo: repo.id, ref: `refs/heads/${branchForCr(cr)}`, why: 'delete-failed' });
          continue;
        }
      }
      const localRef = `refs/heads/${branchForCr(cr)}`;
      const localExists = gitRun(repo.rootPath, ['rev-parse', '--verify', '--quiet', localRef]).status === 0;
      if (localExists && gitRun(repo.rootPath, ['merge-base', '--is-ancestor', localRef, trunkRef]).status !== 0) {
        remaining.push({ kind: 'local-ref', repo: repo.id, ref: localRef, why: 'not-merged' });
        continue;
      }
      const delLocal = gitRun(repo.rootPath, ['branch', '-D', branchForCr(cr)]);
      if (delLocal.status !== 0 && localExists) remaining.push({ kind: 'local-ref', repo: repo.id, ref: localRef, why: 'delete-failed' });
    }
  }
  return { remaining, preservedRefs };
}

/** archive 事务（TASK-09）。input: {cr, specId?, workspace}。 */
export async function archiveCr(ctx, input) {
  const { cr, specId } = input;
  if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) throw new TxError('ARCHIVE_CR_INVALID', `archive 需要合法 CR-ID，收到 ${cr}`, { cr });
  // FR-03/TD-BL-1：必需 emitter 在任何副作用（lock/journal/commit/push/outbox）前 fail-fast；
  // 当前生产调用点仅 cmdArchive，不保留无 adapter 兼容分支。
  if (typeof input.emitArchiveEvent !== 'function') {
    throw new TxError('ARCHIVE_EMITTER_REQUIRED', 'archive 需要 emitArchiveEvent adapter（cmdArchive 注入 emitOutboxEvent）', { cr });
  }
  const kb = getRepository(ctx, ctx.knowledgeBaseRepoId);
  const recoverCommand = `crctl archive ${cr}${specId ? ` --spec-id ${JSON.stringify(specId)}` : ''} --workspace ${JSON.stringify((input && input.workspace) || ctx.installRoot)}`;
  const lock = await acquireLock({ root: ctx.installRoot, scope: `archive-${cr}`, op: 'archive', cr });
  try {
    let journal, journalPath;
    ({ journal, journalPath } = await loadOrCreateJournal({ root: ctx.installRoot, op: 'archive', key: cr, graphDigest: ctx.graphDigest, inputDigest: sha256(cr + '|' + (specId || '')) }));
    const payload = journal.archive || { cr, phase: 'start', status: null, committed: false, commit: null, baseSha: null, pushed: false, cleanupDone: null, preservedRefs: [], remaining: [] };
    journal.archive = payload;
    const wasComplete = payload.phase === 'complete';
    let did = false;
    const save = async (phase) => { payload.phase = phase; journal.phase = phase; await saveJournal({ path: journalPath, journal }); };
    // FR-01：统一固定返回构造——所有成功/待清理/幂等重放路径复用，不导出、不新建模块。
    const result = (phase, changed, warnings = [], outbox) => {
      if ((payload.pushed || payload.phase === 'complete') && !payload.commit) {
        throw new TxError('TX_JOURNAL_INVALID', `archive journal 损坏：pushed/complete 但 commit 为空，不得返回占位 SHA`, { cr });
      }
      return {
        cr, txId: journal.txId, phase,
        status: payload.status === 'writing-back' ? 'archived' : payload.status,
        changed,
        commit: payload.commit,
        lastCleanupError: payload.lastCleanupError ?? null,
        remaining: payload.remaining ?? [],
        preservedRefs: payload.preservedRefs ?? [],
        recoverCommand,
        warnings,
        ...(outbox ? { outbox } : {}),
      };
    };
    // FR-03/FR-04/FR-05：首次发送与恢复补发（SDD §4.2）。仅 writing-back；journal outboxEmitted 阻断重复；
    // 失败只追加 warning 不改变 phase；成功先持久化发送事实再继续。回调抛错同失败处理。
    const emitArchiveIfNeeded = async () => {
      const warnings = [];
      let outbox;
      if (payload.status !== 'writing-back') return { warnings, outbox };
      if (payload.outboxEmitted === true) return { warnings, outbox };
      if (!payload.pushed || !payload.commit) {
        throw new TxError('TX_JOURNAL_INVALID', `archive journal 损坏：writing-back 事件未发送但 pushed=${payload.pushed} commit=${payload.commit}`, { cr });
      }
      try {
        outbox = input.emitArchiveEvent({ cr, commit: payload.commit });
      } catch {
        outbox = null;
      }
      if (outbox) {
        payload.outboxEmitted = true;
        await save(payload.phase); // 只持久化发送事实，不改变 authority phase
      } else {
        warnings.push({ code: 'EMIT_FAILED', event_kind: 'archive' });
      }
      return { warnings, outbox };
    };
    const assertGraph = () => {
      if ((payload.committed || payload.pushed) && journal.graphDigest !== ctx.graphDigest) {
        throw new TxError('GRAPH_CHANGED_DURING_TRANSACTION', 'archive 事务出现副作用后 dir-graph 声明发生变化，拒绝继续', { journalDigest: journal.graphDigest, currentDigest: ctx.graphDigest });
      }
    };
    await recoverWriteSet({ txRoot: ctx.installRoot, txId: journal.txId });

    // 幂等重放：complete 事务直接返回（cleanup 后 CR worktree 已删，authority 解析会失败）；
    // FR-04：历史/失败 journal（phase=complete 但 outboxEmitted 未标记）重放仍重试事件，不新增 commit。
    if (payload.phase === 'complete') {
      const { warnings, outbox } = await emitArchiveIfNeeded();
      return result('complete', false, warnings, outbox);
    }

    // authority 与终态判定（仅 publish 阶段需要；cleanup 续跑时 CR worktree 可能已被删，跳过解析）：
    // writing-back → txws；rejected/withdrawn → 主 checkout 账本（无 txws）
    let status = payload.status;
    let editRoot = null;
    if (!payload.committed) {
      const opWs = resolveOperationalWorkspace(ctx, cr);
      status = opWs.phase;
      if (opWs.source === 'transaction-workspace') {
        if (status !== 'writing-back') throw new TxError('ARCHIVE_STATE_MISMATCH', `archive 需要 writing-back（authority=txws），当前 ${status}`, { cr, status });
        if (!specId) throw new TxError('ARCHIVE_SPEC_REQUIRED', 'archive writing-back 路径需要 --spec-id（writeback-spec-id 入账）', { cr });
        editRoot = opWs.path;
      } else {
        // rejected/withdrawn 的事实来自 CR worktree；归档提交在 detached origin trunk 上生成，绝不改用户主 checkout。
        if (!['rejected', 'withdrawn'].includes(status)) {
          throw new TxError('ARCHIVE_STATE_MISMATCH', `archive 仅接受 writing-back 或 rejected/withdrawn，当前 ${status}`, { cr, status });
        }
        gitMust(kb.rootPath, ['fetch', 'origin']);
        const trunkSha = gitMust(kb.rootPath, ['rev-parse', `refs/remotes/origin/${kb.trunk}`]);
        editRoot = txWorkspacePath(ctx, cr);
        if (!fs.existsSync(editRoot)) gitMust(kb.rootPath, ['worktree', 'add', '--detach', editRoot, trunkSha]);
        else {
          gitMust(editRoot, ['reset', '--hard', trunkSha]);
          gitMust(editRoot, ['checkout', '--detach', trunkSha]);
        }
      }
      if (payload.status != null && payload.status !== status) {
        throw new TxError('ARCHIVE_STATUS_MISMATCH', `archive 事务 status=${payload.status} 与当前 ${status} 不一致`, { cr });
      }
      payload.status = status;

      // 前置（非幂等重入）：writing-back 路径校验 TASK done + traceability 落点 + approval 存在
      if (status === 'writing-back') {
        const tasksIdx = path.join(editRoot, 'change-requests', cr, 'tasks', '_index.yml');
        const idxText = fs.readFileSync(tasksIdx, 'utf8').replaceAll('\r\n', '\n');
        const pending = [...idxText.matchAll(/^([ \t]*)status:\s*(\S+)/gm)].filter((m) => m[2] !== 'done').map((m) => m[0].trim());
        if (pending.length) throw new TxError('ARCHIVE_TASKS_PENDING', `archive 前置：tasks/_index.yml 仍有非 done 任务`, { cr, pending });
        const traceP = path.join(editRoot, 'specs', specId, 'traceability.yml');
        if (!fs.existsSync(traceP)) throw new TxError('ARCHIVE_TRACEABILITY_MISSING', `archive 前置：specs/${specId}/traceability.yml 不存在（traceability 回写未完成）`, { cr, specId });
        const approvalP = path.join(editRoot, 'change-requests', cr, 'approval.yml');
        if (!fs.existsSync(approvalP)) throw new TxError('ARCHIVE_APPROVAL_MISSING', `archive 前置：approval.yml 缺失`, { cr });
      }
    }

    // 四账本编辑 + write-set + commit + lease push（与 merge finalize 相同 classify 模式）
    const finalStatus = payload.status === 'writing-back' ? 'archived' : payload.status; // writing-back → archived；rejected/withdrawn → 保持
    const buildEntries = (root) => {
      const readT = (p) => fs.readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
      const now = nowIso();
      const bp = path.join(root, 'change-requests', '_backlog.yml');
      const hp = path.join(root, 'change-requests', '_history.yml');
      const ip = path.join(root, 'change-requests', '_index.yml');
      const crp = path.join(root, 'change-requests', cr, 'cr.md');
      const edits = archiveLedgerEdits({
        backlogText: readT(bp), historyText: fs.existsSync(hp) ? readT(hp) : null,
        indexText: readT(ip), cr, finalStatus, specId, reason: 'cr-archive', now,
      });
      const crMdText = readT(crp);
      const nextCrMd = crMdStatusText(crMdText, finalStatus);
      if (!nextCrMd) throw new TxError('ARCHIVE_CRMD_INVALID', `${crp} 无 frontmatter，无法写终态`, { cr });
      // before = 磁盘字节哈希（CAS 锚点，Windows autocrlf 不影响一致性）；after = 编辑产物（LF）
      const file = (p, after) => ({ path: p, beforeSha256: readHashRaw(path.join(root, p)), afterSha256: sha256(after), content: after });
      const entries = [
        file(`change-requests/_backlog.yml`, edits.newBacklog),
        file(`change-requests/_history.yml`, edits.newHistory),
        file(`change-requests/_index.yml`, edits.newIndex),
        file(`change-requests/${cr}/cr.md`, nextCrMd),
      ];
      return { entries, recipients: edits.recipients, now };
    };
    if (!payload.committed) {
      assertGraph();
      const txHeadBefore = gitMust(editRoot, ['rev-parse', 'HEAD']);
      const built = buildEntries(editRoot);
      const pre = built.entries.map((e) => ({ path: e.path, beforeSha256: e.beforeSha256, afterSha256: e.afterSha256, content: e.content }));
      await applyWriteSet({ root: editRoot, txRoot: ctx.installRoot, txId: journal.txId, entries: pre });
      gitMust(editRoot, ['add', '--', ...built.entries.map((e) => e.path)]);
      const staged = gitMust(editRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n').filter(Boolean).sort();
      const expect = built.entries.map((e) => e.path).sort();
      if (staged.length !== expect.length || staged.some((p, i) => p !== expect[i])) {
        throw new TxError('ARCHIVE_STAGED_MISMATCH', `archive staged set 与四账本不精确相等（expect=${expect.length} got=${staged.length}）`, { expect, got: staged });
      }
      const msg = `archive ${cr}\n\nAI-First-Op: archive\nAI-First-Tx: ${journal.txId}\nAI-First-CR: ${cr}\n`;
      gitMust(editRoot, ['commit', '--no-gpg-sign', '--file=-'], { input: msg });
      payload.commit = gitMust(editRoot, ['rev-parse', 'HEAD']);
      payload.baseSha = txHeadBefore;
      payload.recipients = built.recipients;
      payload.committed = true;
      did = true;
      await save('committed');
      faultPoint('archive-after-commit', { cr });
    }
    for (let attempt = 0; attempt < 3 && !payload.pushed; attempt++) {
      assertGraph();
      gitMust(kb.rootPath, ['fetch', 'origin']);
      const remoteSha = gitMust(kb.rootPath, ['rev-parse', `refs/remotes/origin/${kb.trunk}`]);
      const isAncestor = gitRun(kb.rootPath, ['merge-base', '--is-ancestor', payload.commit, remoteSha]).status === 0;
      const cls = classifyRemoteCommit({ remoteSha, expectedBase: payload.baseSha, commitSha: payload.commit, commitIsRemoteAncestor: isAncestor, journalSaysPublished: payload.pushed });
      if (cls === 'confirmed') { payload.pushed = true; did = true; await save('pushed'); break; }
      if (cls === 'history-rewritten') {
        throw new TxError('ARCHIVE_REMOTE_HISTORY_REWRITTEN', 'archive commit 遇远端 trunk history rewrite，硬阻断（不猜测、不自动 force）', { cr, remoteSha, expectedBase: payload.baseSha });
      }
      if (cls === 'rebuild') {
        // 他人推进 trunk：编辑位置 reset 到新 base 后重建四账本 write-set（编辑是纯函数可重算）。
        // committed=true 重放（fault 恢复）时 editRoot 尚未解析，按 journal 原始 status 重新定位。
        if (!editRoot) {
          editRoot = payload.status === 'writing-back'
            ? resolveOperationalWorkspace(ctx, cr).path
            : txWorkspacePath(ctx, cr);
        }
        gitMust(editRoot, ['fetch', 'origin']);
        gitMust(editRoot, ['reset', '--hard', remoteSha]);
        if (payload.status === 'writing-back') gitMust(editRoot, ['checkout', '--detach', remoteSha]);
        const built = buildEntries(editRoot);
        const pre = built.entries.map((e) => ({ path: e.path, beforeSha256: e.beforeSha256, afterSha256: e.afterSha256, content: e.content }));
        await applyWriteSet({ root: editRoot, txRoot: ctx.installRoot, txId: journal.txId, entries: pre });
        gitMust(editRoot, ['add', '--', ...built.entries.map((e) => e.path)]);
        const msg = `archive ${cr} (rebuild)\n\nAI-First-Op: archive\nAI-First-Tx: ${journal.txId}\nAI-First-CR: ${cr}\n`;
        gitMust(editRoot, ['commit', '--no-gpg-sign', '--file=-'], { input: msg });
        payload.commit = gitMust(editRoot, ['rev-parse', 'HEAD']);
        payload.baseSha = remoteSha;
        did = true;
        await save('rebuild');
        continue;
      }
      gitMust(editRoot, ['push', `--force-with-lease=${kb.trunk}:${payload.baseSha}`, 'origin', `HEAD:refs/heads/${kb.trunk}`]);
      payload.pushed = true;
      did = true;
      await save('pushed');
      faultPoint('archive-after-push', { cr });
    }
    if (!payload.pushed) throw new TxError('ARCHIVE_REMOTE_STALE', 'archive push 连续 rebuild 超过上限，无法收敛', { cr });

    // origin confirmed → cleanup 前发送 archive outbox（FR-03 时序：不依赖 cleanup 可能删除的 worktree）
    const { warnings, outbox } = await emitArchiveIfNeeded();

    // origin confirmed → cleanup（逐单元落盘 + fault；失败不抛错，返回 cleanup-pending）
    await save('cleanup-pending');
    if (!payload.cleanupDone) {
      payload.lastCleanupError = null;
      try {
        assertGraph();
        const r = archiveCleanup(ctx, cr, status, journal.txId);
        payload.remaining = r.remaining;
        payload.preservedRefs = r.preservedRefs;
        did = true;
        await save('cleanup-attempted');
        faultPoint('archive-during-cleanup', { cr });
      } catch (ce) {
        payload.lastCleanupError = ce && ce.code ? ce.code : 'CLEANUP_FAILED';
        did = true;
        await save('cleanup-failed');
      }
      if (payload.remaining.length === 0 && !payload.lastCleanupError) payload.cleanupDone = true;
    }
    if (payload.remaining.length === 0 && !payload.lastCleanupError) {
      await save('complete');
      return result('complete', did && !wasComplete, warnings, outbox);
    }
    return result('cleanup-pending', did && !wasComplete, warnings, outbox);
  } finally {
    await lock.release();
  }
}
/* ────────────────────────── TASK-11：upgrade-check（临时只读预检）──────────────────────────
 * 从 origin 权威事实分类新协议激活风险（SDD §4.6）：fetch 后只读 origin trunk 的 CR 状态与
 * 本机 merge journal（已发布事实），不创建 workspace、不修改审批、不合成 snapshot、零写入。
 * 分类：developing 及之前阶段 = safe；旧 code-approved 零 publish = requiresReapproval；
 *       merging/writing-back/部分 publish/authority unknown = blocksUpgrade（保守）。
 * 本命令为临时工具：全部安装完成协议切换且无旧事务后，随 dispatch/help/tests 整体删除
 * （CUSTOM-TODO-009 删除条件）。
 */

const UPGRADE_SAFE_STATUSES = new Set(['drafting', 'requirement-reviewing', 'requirement-approved', 'tech-designing', 'tech-design-review-pending', 'tech-design-reviewed', 'task-breakdown', 'developing', 'code-reviewing']);
const UPGRADE_TERMINAL = new Set(['archived', 'rejected', 'withdrawn']);
const UPGRADE_BLOCKER_STATUSES = new Set(['merging', 'writing-back']);

/** 从 origin trunk 权威事实分类新协议激活风险（只读，零写入）。 */
export function checkUpgrade(ctx) {
  const kb = getRepository(ctx, ctx.knowledgeBaseRepoId);
  gitMust(kb.rootPath, ['fetch', 'origin']); // fetch 更新 remote-tracking refs（只读本地 ref 更新，无业务写入）
  const trunkRef = `refs/remotes/origin/${kb.trunk}`;
  const backlogText = gitMust(kb.rootPath, ['show', `${trunkRef}:change-requests/_backlog.yml`]);
  const crIds = [...backlogText.matchAll(/^[ \t]*- id:\s*(\S+)/gm)].map((m) => m[1]);
  const safe = [];
  const requiresReapproval = [];
  const blocksUpgrade = [];
  for (const cr of crIds) {
    const readStatus = () => {
      const r = gitRun(kb.rootPath, ['show', `${trunkRef}:change-requests/${cr}/cr.md`]);
      if (r.status !== 0) return null;
      const fm = r.stdout.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fm) return null;
      const s = fm[1].match(/^status:\s*["']?([^"'\n]+?)["']?\s*$/m);
      return s ? s[1] : null;
    };
    const status = readStatus();
    if (status == null) {
      blocksUpgrade.push({ cr, why: 'authority-unknown', detail: 'origin trunk 无法读取 cr.md status（缺失或非法）' });
      continue;
    }
    if (UPGRADE_SAFE_STATUSES.has(status)) { safe.push({ cr, status }); continue; }
    if (UPGRADE_TERMINAL.has(status)) { safe.push({ cr, status }); continue; }
    if (UPGRADE_BLOCKER_STATUSES.has(status)) {
      blocksUpgrade.push({ cr, status, why: 'in-flight-writeback', detail: 'status=' + status + '（回写期在途，authority=Transaction Workspace，切协议前须归档）' });
      continue;
    }
    if (status === 'code-approved') {
      // 旧 code-approved：查 merge journal 是否已有发布事实
      const ms = mergeStatus(ctx, cr);
      const published = (ms.repos || []).some((r) => r.pushed) || ms.finalizePushed;
      if (published) {
        blocksUpgrade.push({ cr, status, why: 'partial-publish', detail: `merge journal phase=${ms.phase} 已有 publish，切协议前须完成或回退`, txId: ms.txId });
      } else {
        requiresReapproval.push({ cr, status, why: 'legacy-code-approved', detail: '旧协议 code-approved 零 publish：切协议后须重核 release-subjects 并重新审批' });
      }
      continue;
    }
    // 未知状态：保守阻断
    blocksUpgrade.push({ cr, status, why: 'unknown-status', detail: '非预期 status，保守阻断' });
  }
  return { safe, requiresReapproval, blocksUpgrade, canActivate: blocksUpgrade.length === 0 };
}

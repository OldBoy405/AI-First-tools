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
import { parseYaml } from './yaml-subset.mjs';
import {
  acquireLock, loadOrCreateJournal, saveJournal, applyWriteSet, recoverWriteSet, faultPoint, nowIso,
} from './durable-tx.mjs';

/** 事务层结构化错误：crctl.mjs 接线时捕获并转 fail(code, message, extra)，保持单进程 JSON 输出契约。 */
export class TxError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

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
 *   （source 'transaction-workspace'）；txws 缺失或状态不自洽一律硬失败。
 * 用户主 checkout 永远不是返回值。
 */
export function resolveOperationalWorkspace(ctx, cr) {
  const kb = getRepository(ctx, ctx.knowledgeBaseRepoId);
  const crWorktree = path.join(kb.worktreePath, cr);
  const status = readCrMdStatus(crWorktree, cr);
  if (status == null) {
    throw new TxError('CR_WORKTREE_STATUS_MISSING', `${cr}: CR worktree 的 cr.md 缺少 status（${path.join(crWorktree, 'change-requests', cr, 'cr.md')}）`, { cr, crWorktree });
  }
  if (!POST_FINALIZE_STATUSES.has(status)) return { phase: status, path: crWorktree, source: 'cr-worktree' };
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
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, input: opts.input });
  return { status: r.status == null ? -1 : r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

export function gitMust(cwd, args, opts = {}) {
  const r = gitRun(cwd, args, opts);
  if (r.status !== 0) {
    throw new TxError('TX_GIT_FAILED', `git ${args.join(' ')} 失败（exit=${r.status}）: ${r.stderr || r.stdout}`, { cwd, args, stderr: r.stderr });
  }
  return r.stdout;
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
    // roll-forward：先恢复任何中断的 write-set（本机全局扫描）
    await recoverWriteSet({ root: ctx.installRoot });

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
        // remote 被他人推进：从新 origin base 重建账本写与 commit（本地未发布 commit 作废，trunk 已验证 clean）
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
    const rec = await recoverWriteSet({ root: ctx.installRoot });
    let changed = rec.changed;
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

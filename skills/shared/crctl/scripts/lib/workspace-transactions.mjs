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

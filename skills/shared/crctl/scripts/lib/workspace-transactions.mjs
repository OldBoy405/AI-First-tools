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
import { parseYaml, matchEntryBlock } from './yaml-subset.mjs';
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
    if (path.isAbsolute(declPath) || path.win32.isAbsolute(declPath) || path.posix.isAbsolute(declPath)) {
      throw new TxError('REPO_GRAPH_INVALID', `repo ${id}: path 必须是相对声明路径，收到 absolute: ${declPath}`);
    }
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
  // CR worktree 反解：用文件身份抵抗 Windows 8.3 short path / long path 别名。
  let cr = null;
  let branch = null;
  const wsReal = (() => { try { return fs.realpathSync(path.resolve(workspace)); } catch { return path.resolve(workspace); } })();
  const candidateCr = path.basename(wsReal);
  if (CR_DIR_RE.test(candidateCr)) {
    for (const r of repositories) {
      if (!sameFileIdentity(wsReal, path.join(r.worktreePath, candidateCr))) continue;
      cr = candidateCr;
      branch = `requirement/${candidateCr}`;
      break;
    }
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

/* ────────────────────────── 版本规范化基元（CR-2026-057 TASK-01） ──────────────────────────
 * normalizeTargetVersion：register/writeback-apply/version-set 三命令共用的版本值域与规范化纯函数
 * （SDD §2.1/§4.1）。禁止同义值集合冻结 11 项；v/V 前缀在大小写折叠前对 trim 串剥离恰好一个。
 * 纯 string→result，禁止抛异常（错误码映射由调用方完成）。 */
const FORBIDDEN_VERSION_SYNONYMS = new Set(['tbd', 'n/a', 'na', 'n.a.', 'pending', 'none', 'unknown', 'todo', 'wip', 'null', 'undefined']);
const REAL_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(\.(0|[1-9]\d*))?$/;

export function normalizeTargetVersion(raw, { allowUnassigned = true } = {}) {
  if (raw == null || typeof raw !== 'string') return { ok: false, reason: 'missing' };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  const token = trimmed.toLowerCase();
  if (FORBIDDEN_VERSION_SYNONYMS.has(token)) return { ok: false, reason: 'forbidden' };
  if (token === 'unassigned') {
    return allowUnassigned ? { ok: true, value: 'unassigned' } : { ok: false, reason: 'unassigned-not-allowed' };
  }
  const candidate = (trimmed.startsWith('v') || trimmed.startsWith('V')) ? trimmed.slice(1) : trimmed;
  if (!REAL_VERSION_RE.test(candidate)) return { ok: false, reason: 'malformed' };
  return { ok: true, value: candidate };
}

/**
 * cr.md frontmatter target-version 行级读取器（SDD §2.2）：路径 {ws}/change-requests/{cr}/cr.md；
 * 读入后先 \r\n→\n 规范化（NFR-3），只在 frontmatter 内匹配 ^target-version: 行；
 * 文件不可读 / 无 frontmatter / 缺字段 → { ok:false, reason:'missing' }。纯只读，无任何副作用。
 */
export function readCrMdTargetVersion(workspacePath, cr) {
  const p = path.join(workspacePath, 'change-requests', cr, 'cr.md');
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return { ok: false, reason: 'missing' }; }
  const norm = text.replaceAll('\r\n', '\n');
  const fm = norm.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { ok: false, reason: 'missing' };
  const line = fm[1].split(/\r?\n/).find((l) => /^target-version:/.test(l));
  if (!line) return { ok: false, reason: 'missing' };
  const raw = line.replace(/^target-version:\s*/, '').trim().replace(/^["']|["']$/g, '');
  return { ok: true, raw };
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

/**
 * 窄只读 writeback 版本权威路径解析（CR-2026-058 FR-3，SDD §4.1）：
 * - 仅回答「若 writeback 继续，版本事实源是哪」：返回 { path, source }，source ∈ {'transaction-workspace', 'cr-worktree'}；
 * - **永不抛** STATE/OPERATIONAL_WORKSPACE 类错误：任何证据不足一律回退 { path: crWorktree, source: 'cr-worktree' }；
 * - 与 resolveOperationalWorkspace 的差异（SDD §4.1 差异表）：不抛错、仅版本比较路径定位、mergeStatus 包 try/catch
 *   （journal 损坏按 { phase: 'none' } 无证据处理）；真正的 authority 断言仍由既有 resolveOperationalWorkspace 承担。
 * - 守卫必须在 WRITEBACK_STATE_MISMATCH 之前返回版本错误（FR-1 优先级），故禁止在守卫内调用完整解析器。
 */
export function resolveWritebackAuthorityPath(ctx, cr) {
  const crWorktree = crWorktreePath(ctx, cr);
  const status = readCrMdStatus(crWorktree, cr);
  if (status != null && POST_FINALIZE_STATUSES.has(status)) {
    const txws = txWorkspacePath(ctx, cr);
    if (fs.existsSync(txws)) {
      const txStatus = readCrMdStatus(txws, cr);
      if (txStatus != null && POST_FINALIZE_STATUSES.has(txStatus)) {
        return { path: txws, source: 'transaction-workspace' };
      }
    }
    return { path: crWorktree, source: 'cr-worktree' };
  }
  if (status != null) {
    let ms;
    try { ms = mergeStatus(ctx, cr); } catch { ms = { phase: 'none' }; }
    if (ms.phase === 'complete' && ms.operationalWorkspace) {
      const opStatus = readCrMdStatus(ms.operationalWorkspace, cr);
      if (opStatus != null && POST_FINALIZE_STATUSES.has(opStatus)) {
        return { path: ms.operationalWorkspace, source: 'transaction-workspace' };
      }
    }
  }
  return { path: crWorktree, source: 'cr-worktree' };
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

/** cr.md frontmatter 时间字段统一刷新（CR-2026-039 TASK-03，SDD §4.4）：
 * 先删既有 updated-at: 行（legacy），再对 updated: 行原位刷新（不存在则追加）；任何情况下不得双字段共存。
 * reader 契约：“最后受控修改时间”按 `updated ?? updated-at` 读取（当前无消费点，不新增无调用方 helper）。
 * 入参为 LF 规范化的 frontmatter body（不含 --- 围栏）；`at` 缺省 nowIso()；返回新 body。 */
export function refreshCrMdUpdated(fm, at) {
  const withoutLegacy = fm.replace(/^updated-at:[ \t]*[^\r\n]*(?:\n|$)/gm, '');
  const body = withoutLegacy.replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, '');
  const ts = `updated: "${at || nowIso()}"`;
  const updatedLine = /^updated:[ \t]*[^\r\n]*$/m;
  return updatedLine.test(body) ? body.replace(updatedLine, ts) : body ? `${body}\n${ts}` : ts;
}

/** cr.md 状态文本生成纯函数（status + updated 更新；CR-2026-039 TASK-03 起时间字段收敛为单一 updated）。 */
export function crMdStatusText(text, newStatus, opts = {}) {
  const norm = text.replaceAll('\r\n', '\n'); // 纪律 #1：CRLF 来源先规范化，输出行尾确定
  const m = matchFrontmatter(norm);
  if (!m) return null;
  let fm = m.body;
  if (/^status:\s*.*$/m.test(fm)) fm = fm.replace(/^status:\s*.*$/m, `status: ${newStatus}`);
  else fm = fm + `\nstatus: ${newStatus}`;
  fm = refreshCrMdUpdated(fm, opts.at);
  return norm.replace(m.match, `---\n${fm}\n---`);
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
export function buildRegistrationTexts({ cr, title, summary, source, origin, targetVersion, owners, now }) {
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
    `origin: ${yamlScalarLib(origin)}`,
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
    `    origin: ${yamlScalarLib(origin)}`,
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

/* ────────────────────────── checkpoint 纯函数（CR-2026-033 T03b） ────────────────────────── */

/**
 * checkpoint-specific exact-head 分类（SDD §3.3），独立于 classifyRemoteCommit，不改动其他事务语义。
 * 返回：confirmed / create / pushable / advanced / diverged / history-rewritten。
 */
export function classifyCheckpointRemote({ remoteSha, sourceSha, remoteIsSourceAncestor, sourceIsRemoteAncestor, journalSaysPublished }) {
  if (remoteSha != null && remoteSha === sourceSha) return 'confirmed';
  if (journalSaysPublished) return sourceIsRemoteAncestor ? 'advanced' : 'history-rewritten';
  if (remoteSha == null) return 'create';
  if (remoteIsSourceAncestor) return 'pushable';
  if (sourceIsRemoteAncestor) return 'advanced';
  return 'diverged';
}

/**
 * checkpoint batch-id 内容寻址（SDD §2.2）：canonical JSON（键序固定、repositories 按 repo id 排序、无空白）
 * 的 sha256 前 16 hex。只含 cr/graphDigest/repositories 三要素，不含 message/actor/时间/路径/txId。
 */
export function checkpointBatchId({ cr, graphDigest, repositories }) {
  const sorted = [...repositories].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  const input = {
    cr,
    graphDigest,
    repositories: sorted.map((r) => ({ repo: r.repo, sourceSha: r.sourceSha, remoteRef: r.remoteRef })),
  };
  return sha256(JSON.stringify(input)).slice(0, 16);
}

/** 块内缩进键的值区段结束行（该键到下一个缩进 <= keyIndent 的键行或 EOF）。 */
function keySectionEnd(lines, idx) {
  const keyIndent = lines[idx].match(/^[ \t]*/)[0].length;
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    const ind = l.match(/^[ \t]*/)[0].length;
    if (ind <= keyIndent && /^[ \t]*[A-Za-z0-9_-]+:/.test(l)) return i;
  }
  return lines.length;
}

const yamlScalarCheckpoint = (v) => (/^[\w./-]+$/.test(String(v)) ? String(v) : `"${String(v).replaceAll('"', '\\"')}"`);

function renderCheckpointSnapshot(snapshot, fieldIndent) {
  const sub = ' '.repeat(fieldIndent + 2);
  const item = ' '.repeat(fieldIndent + 4);
  const inner = ' '.repeat(fieldIndent + 6);
  const repos = (snapshot.repositories || []).map((r) => [
    `${item}- repo: ${r.repo}`,
    `${inner}source-sha: ${r.sourceSha}`,
    `${inner}remote-ref: ${yamlScalarCheckpoint(r.remoteRef)}`,
  ].join('\n')).join('\n');
  return [
    `${' '.repeat(fieldIndent)}latest-checkpoint:`,
    `${sub}batch-id: ${snapshot.batchId}`,
    `${sub}repositories:`,
    repos,
  ];
}

/**
 * latest-checkpoint 账本编辑器（SDD §2.1/§3.2，纯函数）：整块替换 latest-checkpoint，
 * 同一 metadata commit 删除旧 checkpoints[]/remote-ref/last-push-at/last-push-by；
 * 不改 cr.md、其他 CR、未知字段或注释。owned key 重复/结构畸形硬失败。
 */
export function editLatestCheckpoint(backlogText, cr, snapshot) {
  const norm = String(backlogText).replaceAll('\r\n', '\n');
  const block = matchEntryBlock(norm, cr);
  if (!block) throw new TxError('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`, { cr });
  // 输入 snapshot 基本校验
  if (!snapshot || !/^[0-9a-f]{16}$/.test(String(snapshot.batchId || ''))) {
    throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', 'checkpoint snapshot batch-id 非法（须 16 hex）', { cr });
  }
  const repos = Array.isArray(snapshot.repositories) ? snapshot.repositories : [];
  if (repos.length === 0) throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', 'checkpoint snapshot repositories 为空', { cr });
  const seen = new Set();
  for (const r of repos) {
    if (!r || typeof r.repo !== 'string' || !r.repo) throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', 'snapshot 缺 repo', { cr });
    if (seen.has(r.repo)) throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', `snapshot repo 重复: ${r.repo}`, { cr });
    seen.add(r.repo);
    if (!/^[0-9a-f]{40}$/.test(String(r.sourceSha || ''))) throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', `repo ${r.repo} source-sha 非法`, { cr });
    if (typeof r.remoteRef !== 'string' || !r.remoteRef.startsWith('refs/heads/requirement/')) {
      throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', `repo ${r.repo} remote-ref 非法`, { cr });
    }
  }
  const lines = block.text.split('\n');
  const fieldIndent = block.indent + 2;
  const keyRe = new RegExp('^' + ' '.repeat(fieldIndent) + '([A-Za-z0-9_-]+):');
  const owned = ['latest-checkpoint', 'checkpoints', 'remote-ref', 'last-push-at', 'last-push-by'];
  for (const k of owned) {
    const hits = lines.filter((l) => { const m = l.match(keyRe); return m && m[1] === k; });
    if (hits.length > 1) throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', `_backlog 条目 ${cr} 的 ${k} 键重复`, { cr });
  }
  const out = [];
  let inserted = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const m = l.match(keyRe);
    if (m && (owned.includes(m[1]))) {
      const end = keySectionEnd(lines, i);
      if (m[1] === 'latest-checkpoint') {
        out.push(...renderCheckpointSnapshot(snapshot, fieldIndent));
        inserted = true;
      }
      i = end;
      continue;
    }
    out.push(l);
    i++;
  }
  if (!inserted) {
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push(...renderCheckpointSnapshot(snapshot, fieldIndent));
  }
  // 条目后仍跟其他条目时 block.end 指向下一条目行首；out.join 丢弃了条目末尾换行，
  // 必须补回，否则下一条目会被粘到块末行（entry-not-last 场景，CR-2026-033 merge 实测）。
  const joined = out.join('\n');
  const sep = out.length && out[out.length - 1] === '' ? '' : '\n';
  return norm.slice(0, block.start) + joined + sep + norm.slice(block.end);
}

/* ────────────────────────── workspace 分类与补齐（SDD §4.2，TASK-05） ────────────────────────── */

export const WORKSPACE_CLASSIFICATIONS = ['missing', 'healthy', 'branch-only', 'remote-only', 'dirty', 'wrong-branch', 'path-unregistered'];

export function branchForCr(cr) { return `requirement/${cr}`; }

function sameFileIdentity(a, b) {
  try {
    const left = fs.statSync(a);
    const right = fs.statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch { return false; }
}

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
  if (list.status !== 0) {
    throw new TxError('WORKSPACE_GIT_INSPECT_FAILED', `${repo.id}: git worktree list --porcelain 失败（exit=${list.status}）: ${list.stderr || list.stdout}`, {
      repo: repo.id, cwd: repo.rootPath, exit: list.status, stderr: list.stderr,
    });
  }
  const registered = list.stdout.split(/\r?\n/).some((l) => {
    if (!l.startsWith('worktree ')) return false;
    return sameFileIdentity(l.slice('worktree '.length), real);
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
    case 'missing': {
      // CR-2026-046 FR-1/3/4：刷新远端事实（fetch --prune 清理已删除的 stale tracking refs），
      // 重新分类后从远端恢复或从 origin/{trunk} 创建；失败结构化终止，不回退本地 trunk。
      try {
        gitMust(repo.rootPath, ['fetch', '--prune', 'origin']);
      } catch (e) {
        throw new TxError('WORKSPACE_TRUNK_UNAVAILABLE', `${repo.id}: fetch origin 失败，无法确认远端 trunk 基点（不创建本地 CR branch/worktree）`, { repo: repo.id, cause: e.message });
      }
      const re = classifyRepoWorkspace(ctx, repo, cr);
      if (re.classification === 'remote-only') {
        gitMust(repo.rootPath, ['branch', '--track', branch, `origin/${branch}`]);
        return create('from-remote');
      }
      if (re.classification === 'branch-only') {
        return create('from-local-branch');
      }
      if (re.classification !== 'missing') {
        throw new TxError('WORKSPACE_ENSURE_BLOCKED', `${repo.id}: fetch 后重新分类=${re.classification}，ensure 零写入硬阻断（需人工处理）`, { ...re });
      }
      const trunkRef = `refs/remotes/origin/${repo.trunk}`;
      const trunk = gitRun(repo.rootPath, ['rev-parse', '--verify', '-q', trunkRef]);
      if (trunk.status !== 0 || !trunk.stdout) {
        throw new TxError('WORKSPACE_TRUNK_UNAVAILABLE', `${repo.id}: ${trunkRef} 不可解析（fetch 后远端无 trunk），不回退本地 trunk`, { repo: repo.id, ref: trunkRef });
      }
      gitMust(repo.rootPath, ['branch', branch, trunkRef]);
      return create('from-remote-trunk');
    }
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
  // 修复类 CR 对被修复 CR 的显式归因（P3 组织智能设计 §1.2/§5 变更失败率的唯一数据源）。
  // 空串=非修复类；非空必须是规范 CR-ID，否则硬失败——下游按此字段精确匹配，不做模糊解析。
  const origin = input.origin ?? '';
  if (origin && !/^CR-\d{4}-\d{3}$/.test(origin)) {
    throw new TxError('REGISTER_INPUT_INVALID', `register --origin 非法：${origin}（须为 CR-YYYY-NNN，留空表示非修复类 CR）`, { origin });
  }
  // FR-12（CR-2026-057）：--target-version 必填硬校验——位于锁/journal/fetch/账本写之前，失败零写入。
  // 缺 flag 不进 cmdRegister 的 BAD_ARGS 循环，由本规范化层返回 REGISTER_VERSION_INVALID（SDD §3.1）。
  const tv = normalizeTargetVersion(input.targetVersion);
  if (!tv.ok) {
    throw new TxError('REGISTER_VERSION_INVALID', `register --target-version 非法：${String(input.targetVersion ?? '') || '(缺失)'}（reason=${tv.reason}；合法值 = 真实版本 MAJOR.MINOR[.PATCH] 或 unassigned）`, { reason: tv.reason, raw: input.targetVersion == null ? null : String(input.targetVersion) });
  }
  const targetVersion = tv.value;
  const keyHash = sha256(String(input.registrationKey));
  const inputDigest = sha256(JSON.stringify({
    title: input.title, summary, source, origin, targetVersion, year,
    owners: { requirement: owners.requirement, development: owners.development, test: owners.test },
  }));
  const kb = getRepository(ctx, ctx.knowledgeBaseRepoId);
  const recoverCommand = `crctl register --registration-key ${input.registrationKey} --title ${JSON.stringify(input.title)}` +
    ` --owner-requirement ${owners.requirement} --owner-development ${owners.development} --owner-test ${owners.test}` +
    (summary ? ` --summary ${JSON.stringify(summary)}` : '') +
    (input.source ? ` --source ${JSON.stringify(input.source)}` : '') +
    (origin ? ` --origin ${origin}` : '') +
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
        const texts = buildRegistrationTexts({ cr, title: input.title, summary, source, origin, targetVersion, owners, now: nowIso() });
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
    return { cr, txId: journal.txId, phase: 'complete', changed: did && !wasComplete, sideEffects: buildSideEffects(payload), targetVersion, recoverCommand };
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

/* ────────────────────────── workspace freshness 分类（CR-2026-043 TASK-01，SDD §4.1） ──────────────────────────
 * 第二层只读分类：基础分类（classifyRepoWorkspace）回答“资源存在/健康”，
 * freshness 回答“CR 分支 HEAD 与 fetch 后 origin/{trunk} 的祖先关系”。
 * 零写入（fetch 只更新 remote-tracking 元数据）；禁止时间戳/log 计数等启发式。 */

/** ancestry 判定：merge-base --is-ancestor 退出码 0=祖先，1=非祖先（Git 唯一正常否定），
 * 其余退出码是技术失败——不得降级为 diverged/unknown（PRD FR-01.5）。 */
export function isAncestorOrThrow(wtPath, a, b) {
  const r = gitRun(wtPath, ['merge-base', '--is-ancestor', a, b]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new TxError('TX_GIT_FAILED', `merge-base --is-ancestor 退出码异常（exit=${r.status}，非 0/1）: ${r.stderr || r.stdout}`, { cwd: wtPath, args: ['merge-base', '--is-ancestor', a, b], status: r.status, stderr: r.stderr });
}

/**
 * 只读业务检查（FR-01/FR-02）：对每个 active repo 逐仓分类。
 * - fresh：HEAD==trunk 或 trunk 是 HEAD 祖先（ahead-only 是正常开发态）；
 * - behind-clean：HEAD 是 trunk 祖先（canFastForward 机械投影）；
 * - diverged：互不为祖先（人工处理，无自动 merge/rebase）；
 * - unknown：基础分类非 healthy 或检查期间变 dirty（reason 透传，不猜测）。
 * fetch 失败或 origin/{trunk} 不可确认 → WORKSPACE_TRUNK_UNAVAILABLE 硬失败。
 */
export function classifyWorkspaceFreshness(ctx, cr) {
  if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) throw new TxError('WORKSPACE_CR_INVALID', `CR-ID 非法: ${cr}`);
  const repositories = [];
  let blocked = false;
  let anyBehind = false;
  for (const repo of ctx.repositories) {
    const info = classifyRepoWorkspace(ctx, repo, cr);
    const fact = {
      repo: repo.id, trunkRef: repo.trunk, trunkSha: null, branch: info.branch,
      headSha: null, worktreePath: info.worktreePath,
      workspaceClassification: info.classification,
      freshness: 'unknown', dirty: info.dirty, canFastForward: false,
    };
    if (info.classification !== 'healthy') {
      fact.reason = info.classification;
      blocked = true;
      repositories.push(fact);
      continue;
    }
    fact.headSha = gitMust(info.worktreePath, ['rev-parse', 'HEAD']);
    const status = gitMust(info.worktreePath, ['status', '--porcelain']);
    if (status !== '') {
      fact.dirty = true;
      fact.reason = 'dirty-during-check';
      blocked = true;
      repositories.push(fact);
      continue;
    }
    let trunkSha;
    try {
      gitMust(repo.rootPath, ['fetch', 'origin']);
      trunkSha = gitMust(repo.rootPath, ['rev-parse', `refs/remotes/origin/${repo.trunk}`]);
    } catch (e) {
      throw new TxError('WORKSPACE_TRUNK_UNAVAILABLE', `${repo.id}: fetch 或 origin/${repo.trunk} 不可确认（${e.message}）`, { repo: repo.id, trunk: repo.trunk });
    }
    fact.trunkSha = trunkSha;
    if (fact.headSha === trunkSha) {
      fact.freshness = 'fresh';
    } else if (isAncestorOrThrow(info.worktreePath, trunkSha, fact.headSha)) {
      fact.freshness = 'fresh'; // ahead-only
    } else if (isAncestorOrThrow(info.worktreePath, fact.headSha, trunkSha)) {
      fact.freshness = 'behind-clean';
      fact.canFastForward = true;
      anyBehind = true;
    } else {
      fact.freshness = 'diverged';
      blocked = true;
    }
    repositories.push(fact);
  }
  const allFresh = repositories.every((r) => r.freshness === 'fresh');
  return { cr, repositories, allFresh, syncable: allFresh ? false : !blocked && anyBehind };
}

/* ────────────────────────── workspace 显式 ff-only 同步（CR-2026-043 TASK-02，SDD §4.2） ──────────────────────────
 * 唯一 worktree 写操作 = git merge --ff-only <preflight 捕获的 trunk SHA>。
 * 全 fresh → no-op 零 journal；阻断 → 零写入抛错零 journal；syncable → intent 绑定 journal，
 * 在途重跑只恢复原 intent（不重算 digest），多仓只向前，不 reset/revert/删 journal。 */

/** 逐仓重核：基础分类、status、HEAD 与 fetch 后 trunk 都必须仍等于记录 intent。 */
function recheckRecordedRepo(ctx, cr, rec) {
  const repo = getRepository(ctx, rec.repo);
  const info = classifyRepoWorkspace(ctx, repo, cr);
  if (info.classification !== 'healthy') {
    throw new TxError('WORKSPACE_FRESHNESS_CHANGED', `${rec.repo}: 重核时 workspace 分类=${info.classification}，与记录 intent 漂移，拒绝写入`, { repo: rec.repo, classification: info.classification });
  }
  const status = gitMust(info.worktreePath, ['status', '--porcelain']);
  if (status !== '') {
    throw new TxError('WORKSPACE_FRESHNESS_CHANGED', `${rec.repo}: 重核时 worktree 非 clean，拒绝写入`, { repo: rec.repo });
  }
  const head = gitMust(info.worktreePath, ['rev-parse', 'HEAD']);
  gitMust(repo.rootPath, ['fetch', 'origin']);
  const trunkNow = gitMust(repo.rootPath, ['rev-parse', `refs/remotes/origin/${repo.trunk}`]);
  if (trunkNow !== rec.targetTrunkSha) {
    throw new TxError('WORKSPACE_FRESHNESS_CHANGED', `${rec.repo}: trunk 在 preflight 后前进/变化（记录=${rec.targetTrunkSha} 当前=${trunkNow}）`, { repo: rec.repo, targetTrunkSha: rec.targetTrunkSha, trunkNow });
  }
  return { wt: info.worktreePath, head };
}

/** 逐仓重核 + 唯一写操作；任一漂移硬失败且停止后续仓。成功时原位更新 rec（afterSha/action）。 */
function syncOneRepo(ctx, cr, rec) {
  const { wt, head } = recheckRecordedRepo(ctx, cr, rec);
  if (head !== rec.beforeSha) {
    throw new TxError('WORKSPACE_FRESHNESS_CHANGED', `${rec.repo}: HEAD 已偏离 preflight 记录（记录=${rec.beforeSha} 当前=${head}）`, { repo: rec.repo, beforeSha: rec.beforeSha, head });
  }
  try {
    gitMust(wt, ['merge', '--ff-only', rec.targetTrunkSha]);
  } catch (e) {
    if (e instanceof TxError && e.code === 'TX_GIT_FAILED') {
      throw new TxError('WORKSPACE_SYNC_CONFLICT', `${rec.repo}: ff-only 到 ${rec.targetTrunkSha} 失败（${e.message}）`, { repo: rec.repo, targetTrunkSha: rec.targetTrunkSha, cause: e.message });
    }
    throw e;
  }
  rec.afterSha = gitMust(wt, ['rev-parse', 'HEAD']);
  if (rec.afterSha !== rec.targetTrunkSha) {
    throw new TxError('WORKSPACE_SYNC_CONFLICT', `${rec.repo}: ff-only 后 HEAD（${rec.afterSha}）≠ 目标 trunk SHA（${rec.targetTrunkSha}）`, { repo: rec.repo });
  }
  rec.action = 'fast-forwarded';
}

export async function syncWorkspaceToTrunk(ctx, { cr }) {
  if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) throw new TxError('WORKSPACE_CR_INVALID', `CR-ID 非法: ${cr}`);
  const recoverCommand = `crctl workspace sync ${cr} --workspace ${JSON.stringify(ctx.installRoot)}`;
  const lock = await acquireLock({ root: ctx.installRoot, scope: `workspace-sync-${cr}`, op: 'workspace', cr });
  try {
    const existing = loadExistingJournal({ root: ctx.installRoot, op: 'workspace', cr });
    if (existing && existing.journal.phase !== 'complete') {
      // 在途事务：只按 journal 已记录的原始 intent 恢复，禁止基于部分完成后的新 HEAD 重算 digest。
      const journal = existing.journal;
      const journalPath = existing.journalPath;
      const payload = journal.workspace;
      if (!payload || !Array.isArray(payload.repos)) throw new TxError('TX_JOURNAL_INVALID', `workspace journal 缺 payload.repos: ${journalPath}`, { path: journalPath });
      if (journal.graphDigest !== ctx.graphDigest) {
        throw new TxError('GRAPH_CHANGED_DURING_TRANSACTION', '在途 sync 事务的 dir-graph 声明已变化，拒绝继续', { journalDigest: journal.graphDigest, currentDigest: ctx.graphDigest });
      }
      let changed = payload.repos.some((r) => r.beforeSha !== r.targetTrunkSha && ['fast-forwarded', 'confirmed'].includes(r.action));
      const save = async (phase) => { payload.phase = phase; journal.phase = phase; await saveJournal({ path: journalPath, journal }); };
      for (const rec of payload.repos) {
        if (!['pending', 'unchanged', 'fast-forwarded', 'confirmed'].includes(rec.action)) {
          throw new TxError('TX_JOURNAL_INVALID', `${rec.repo}: workspace journal action 非法: ${rec.action}`, { repo: rec.repo, action: rec.action });
        }
        const { head } = recheckRecordedRepo(ctx, cr, rec);
        if (rec.action === 'unchanged') {
          if (head !== rec.beforeSha) {
            throw new TxError('WORKSPACE_FRESHNESS_CHANGED', `${rec.repo}: 恢复时 unchanged HEAD（${head}）≠ 记录 before（${rec.beforeSha}）`, { repo: rec.repo });
          }
          continue;
        }
        if (rec.action === 'fast-forwarded' || rec.action === 'confirmed' || head === rec.targetTrunkSha) {
          if (head !== rec.targetTrunkSha) {
            throw new TxError('WORKSPACE_FRESHNESS_CHANGED', `${rec.repo}: 恢复时已完成仓 HEAD（${head}）≠ 记录 target（${rec.targetTrunkSha}）`, { repo: rec.repo });
          }
          rec.action = 'fast-forwarded'; // 兼容旧 journal 的 confirmed 非接口值
          rec.afterSha = head;
          changed = changed || rec.beforeSha !== rec.targetTrunkSha;
          continue;
        }
        if (head !== rec.beforeSha) {
          throw new TxError('WORKSPACE_FRESHNESS_CHANGED', `${rec.repo}: 恢复时 HEAD（${head}）既非记录 before（${rec.beforeSha}）也非 target（${rec.targetTrunkSha}）`, { repo: rec.repo });
        }
        syncOneRepo(ctx, cr, rec);
        changed = true;
        await save('syncing');
        faultPoint('ws-sync-after-repo', { repo: rec.repo });
      }
      await save('complete');
      return { cr, txId: journal.txId, phase: 'complete', changed, repositories: payload.repos, recoverCommand };
    }

    // 无在途 journal（含 latest 为 complete）：锁内全仓 preflight，任何 worktree 写入前。
    const fresh = classifyWorkspaceFreshness(ctx, cr);
    const unhandled = fresh.repositories.map((r) => ({
      repo: r.repo, beforeSha: r.headSha, targetTrunkSha: r.trunkSha, afterSha: null,
      action: r.freshness === 'behind-clean' ? 'pending' : 'unchanged',
    }));
    if (fresh.allFresh) {
      return { cr, txId: null, phase: 'complete', changed: false, repositories: unhandled, recoverCommand };
    }
    const blocker = fresh.repositories.find((r) => r.freshness !== 'fresh' && r.freshness !== 'behind-clean');
    if (blocker) {
      if (blocker.freshness === 'diverged') {
        throw new TxError('WORKSPACE_FRESHNESS_DIVERGED', `${blocker.repo}: 分支与 trunk 互不为祖先，人工处理（无自动 merge/rebase）`, { repo: blocker.repo, headSha: blocker.headSha, trunkSha: blocker.trunkSha });
      }
      throw new TxError('WORKSPACE_SYNC_BLOCKED', `${blocker.repo}: 新鲜度=${blocker.freshness}（${blocker.reason}），零写入阻断`, { repo: blocker.repo, workspaceClassification: blocker.workspaceClassification, reason: blocker.reason });
    }
    // syncable：intent 绑定 before/target；latest complete 同 intent 再现 = 外部回退，保守阻断。
    const intentDigest = sha256(JSON.stringify({ graphDigest: ctx.graphDigest, cr, repos: unhandled.map((r) => ({ repo: r.repo, beforeSha: r.beforeSha, targetTrunkSha: r.targetTrunkSha })) }));
    if (existing && existing.journal.phase === 'complete' && existing.journal.inputDigest === intentDigest) {
      throw new TxError('WORKSPACE_FRESHNESS_CHANGED', '已完成的 sync intent 在外部回退后再次出现，拒绝复用旧 complete（人工确认事实）', { txId: existing.journal.txId });
    }
    const { journal, journalPath } = await loadOrCreateJournal({ root: ctx.installRoot, op: 'workspace', cr, graphDigest: ctx.graphDigest, inputDigest: intentDigest, createAfterComplete: true });
    const payload = { phase: 'preflight', repos: unhandled };
    journal.workspace = payload;
    journal.phase = 'preflight';
    await saveJournal({ path: journalPath, journal });
    faultPoint('ws-sync-after-preflight', { cr });
    let changed = false;
    const save = async (phase) => { payload.phase = phase; journal.phase = phase; await saveJournal({ path: journalPath, journal }); };
    for (const rec of payload.repos) {
      if (rec.action !== 'pending') continue;
      syncOneRepo(ctx, cr, rec);
      changed = true;
      await save('syncing');
      faultPoint('ws-sync-after-repo', { repo: rec.repo });
    }
    await save('complete');
    return { cr, txId: journal.txId, phase: 'complete', changed, repositories: payload.repos, recoverCommand };
  } finally {
    await lock.release();
  }
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
 * - repositories：每个 active 仓的预期发布分支名 + 该仓本地 CR worktree 的 clean committed HEAD（被评审源 SHA）；
 * - artifacts：受控文件集合 + 逐文件 SHA-256 + 集合 digest。
 * CR-2026-044 FR-02：snapshot 只绑定本地事实，不 fetch、不读 remote-tracking ref；
 * remote-ref 仅表示预期发布分支名，不证明远端存在或已同步（发布完整性归 checkpoint/merge）。
 * 任一仓 workspace 非 healthy 或无任何受控 artifact 均硬失败（不得产出空快照）。
 */
export async function buildReleaseSubjects(ctx, cr) {
  const workspaceByRepo = new Map();
  for (const repo of ctx.repositories) {
    const info = classifyRepoWorkspace(ctx, repo, cr);
    if (info.classification !== 'healthy') {
      throw new TxError('RELEASE_WORKSPACE_INVALID', `${repo.id} workspace 分类=${info.classification}，不能构造 release-subjects（code 评审前必须先 ensure workspace）`, { repo: repo.id, classification: info.classification, worktreePath: info.worktreePath, branch: info.branch, dirty: info.dirty });
    }
    workspaceByRepo.set(repo.id, info);
  }
  const files = collectControlledArtifacts(ctx, cr);
  if (!files.length) {
    throw new TxError('RELEASE_SUBJECT_EMPTY', `${cr} 无受控 artifact（PRD/SDD/plan/tasks），不能构造 release-subjects`, { cr });
  }
  const repositories = [];
  for (const repo of ctx.repositories) {
    const info = workspaceByRepo.get(repo.id);
    const sha = gitMust(info.worktreePath, ['rev-parse', 'HEAD']);
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
 * 重核 release subjects 与当前本地事实：任一漂移返回 {ok:false, kind, details}，零写入。
 * CR-2026-044 FR-03：只重核本地 workspace/source/artifact，不 fetch、不读 remote-tracking ref；
 * 远端 requirement ref 缺失或滞后属于 publication lag，由 checkpoint/merge 处理，不在此判失效。
 * 失败 kind 优先级（PRD §7 失败分类）：先核 artifact 内容与集合（prd/sdd/task 精确 kind，
 * 含未提交篡改；PRD/SDD 漂移无条件硬阻断），再逐仓核本地 source 事实（kind=code：
 * workspace 非 healthy、non-KB HEAD ≠ reviewed-source-sha、KB 白名单外路径漂移或仓集合不一致）。
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
  }
  for (const repo of ctx.repositories) {
    if (!snapRepos.has(repo.id)) return bad('code', { reason: 'repo-missing', repo: repo.id });
  }
  // artifact 逐文件重核先行（按 snapshot 声明序）：保证 PRD/SDD/TASK 漂移始终得到精确 kind，
  // 不被 workspace/source 层 kind=code 覆盖（PRD §7：PRD/SDD 漂移无条件硬阻断）。
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
  // 逐仓本地 source 事实：healthy 分类 + HEAD/祖先/白名单（不读远端）
  for (const r of snapshot.repositories) {
    const repo = byId.get(r.repo);
    const info = classifyRepoWorkspace(ctx, repo, cr);
    if (info.classification !== 'healthy') {
      return bad('code', { reason: 'workspace-invalid', repo: r.repo, classification: info.classification, worktreePath: info.worktreePath });
    }
    const wt = info.worktreePath;
    const head = gitMust(wt, ['rev-parse', 'HEAD']);
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
        // _context.md：工作流上下文加速文件（每 run 收尾刷新、随 CR 提交），与 cr.md/traceability.yml 同类，评审后可变更。
        `change-requests/${cr}/_context.md`,
      ]);
      const reviewPrefix = `change-requests/${cr}/review-annotations/`;
      const changed = gitMust(wt, ['diff', '--name-only', `${repoReviewedSha(r)}..${head}`]).split('\n').filter(Boolean);
      const unexpected = changed.filter((p) => !allowed.has(p) && !p.startsWith(reviewPrefix));
      if (unexpected.length) return bad('code', { reason: 'post-review-path-drift', repo: r.repo, unexpected });
    } else if (head !== repoReviewedSha(r)) {
      return bad('code', { reason: 'head-drift', repo: r.repo, expected: repoReviewedSha(r), actual: head });
    }
  }
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

/* ────────────────────────── CR-2026-046：merge 后本地主 checkout 同步（TASK-02） ──────────────────────────
 * 远端 merge/finalize 确认后的非事务化 best-effort ff-only：
 * 只处理 dir-graph 声明的 repo.rootPath 主 checkout，逐仓 8 判据短路；
 * 副作用命令（fetch --prune / merge --ff-only）只经 gitMust 且局部捕获；
 * 不写 journal/账本、不抛错——任何结果只反映在返回行里（FR-7/8/9/10）。 */
export function reconcileLocalTrunks(ctx) {
  const rows = [];
  for (const repo of ctx.repositories) {
    const row = { repo: repo.id, trunk: repo.trunk, before: null, remote: null, after: null, status: null, reason: null };
    rows.push(row);
    const head = () => {
      const h = gitRun(repo.rootPath, ['rev-parse', '-q', 'HEAD']);
      return h.status === 0 ? h.stdout : null;
    };
    row.before = head();

    const cur = gitRun(repo.rootPath, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (cur.status !== 0 || cur.stdout !== repo.trunk) { row.status = 'skipped'; row.reason = 'wrong-branch'; row.after = row.before; continue; }

    const st = gitRun(repo.rootPath, ['status', '--porcelain']);
    if (st.status !== 0 || st.stdout !== '') { row.status = 'skipped'; row.reason = 'dirty'; row.after = row.before; continue; }

    try {
      gitMust(repo.rootPath, ['fetch', '--prune', 'origin']);
    } catch {
      row.status = 'failed'; row.reason = 'fetch-failed'; row.after = row.before; continue;
    }

    const rr = gitRun(repo.rootPath, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${repo.trunk}`]);
    if (rr.status !== 0 || !rr.stdout) { row.status = 'failed'; row.reason = 'trunk-unavailable'; row.after = row.before; continue; }
    row.remote = rr.stdout;

    if (row.before === row.remote) { row.status = 'unchanged'; row.after = row.before; continue; }

    const anc = gitRun(repo.rootPath, ['merge-base', '--is-ancestor', row.before, row.remote]);
    if (anc.status !== 0) { row.status = 'skipped'; row.reason = 'diverged'; row.after = row.before; continue; }

    try {
      faultPoint('local-sync-ff-only-failed', { repo: repo.id });
      gitMust(repo.rootPath, ['merge', '--ff-only', row.remote]);
      row.after = head();
      row.status = 'synced';
    } catch {
      row.after = head();
      row.status = 'failed'; row.reason = 'ff-only-failed';
    }
  }
  return rows;
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

    // CR-2026-044 FR-05：新事务全仓 publication preflight——远端 requirement source 精确等于本地 HEAD 才允许
    // 首次 prepare；publication lag 错误携带 checkpoint recoverCommand，状态保持 code-approved。
    // 既有 prepare/publish journal 的恢复不重跑 preflight（按已持久化 sourceSha 续跑，不采纳移动 ref）。
    const checkpointRecoverCommand = `crctl checkpoint ${cr} --workspace ${JSON.stringify(ctx.installRoot)}`;
    let publicationFacts = null;
    if (!(payload.repos || []).length) {
      publicationFacts = new Map();
      for (const repo of ctx.repositories) {
        assertGraph();
        const snapRepo = snapshot.repositories.find((r) => r.repo === repo.id);
        if (!snapRepo) throw new TxError('RELEASE_SUBJECT_DRIFT', `release-subjects 缺 ${repo.id} 仓声明`, { cr, repo: repo.id });
        gitMust(repo.rootPath, ['fetch', 'origin']);
        const localHead = gitMust(path.join(repo.worktreePath, cr), ['rev-parse', 'HEAD']);
        const sourceRef = `refs/remotes/origin/${branchForCr(cr)}`;
        const src = gitRun(repo.rootPath, ['rev-parse', '--verify', '--quiet', sourceRef]);
        if (src.status !== 0) {
          throw new TxError('MERGE_SOURCE_MISSING', `${repo.id} 缺少远端 source ref ${sourceRef}（被评审分支未 checkpoint，先执行 recoverCommand 再重跑 merge）`, { repo: repo.id, ref: sourceRef, recoverCommand: checkpointRecoverCommand });
        }
        if (src.stdout !== localHead) {
          throw new TxError('RELEASE_REMOTE_NOT_PUSHED', `${repo.id} 远端 ${sourceRef} 未同步本地 HEAD（publication lag，先执行 recoverCommand 再重跑 merge）`, { repo: repo.id, head: localHead, remote: src.stdout, recoverCommand: checkpointRecoverCommand });
        }
        publicationFacts.set(repo.id, { sourceSha: src.stdout, baseSha: gitMust(repo.rootPath, ['rev-parse', `refs/remotes/origin/${repo.trunk}`]) });
      }
    }

    // per-repo prepare（无 ref/worktree/账本副作用）
    for (const repo of ctx.repositories) {
      assertGraph();
      const prev = (payload.repos || []).find((r) => r.repo === repo.id);
      // 已发布/已确认的仓不再重做 prepare：candidate 与 baseSha 保持（发布后 base 不得漂移）
      if (prev && (prev.pushed || prev.confirmed)) continue;
      let baseSha, sourceSha;
      if (publicationFacts) {
        // 新事务首次 prepare：消费 preflight 冻结事实，不做第二轮 fetch/source 读取
        const fact = publicationFacts.get(repo.id);
        baseSha = fact.baseSha;
        sourceSha = fact.sourceSha;
      } else {
        // 既有 journal 恢复：按原合同重新 fetch；已 prepared 仓的 source 用 journal 冻结 SHA，
        // 不重新采纳移动的 requirement ref（merge source 不取移动分支最新值）。
        const snapRepo = snapshot.repositories.find((r) => r.repo === repo.id);
        if (!snapRepo) throw new TxError('RELEASE_SUBJECT_DRIFT', `release-subjects 缺 ${repo.id} 仓声明`, { cr, repo: repo.id });
        gitMust(repo.rootPath, ['fetch', 'origin']);
        baseSha = gitMust(repo.rootPath, ['rev-parse', `refs/remotes/origin/${repo.trunk}`]);
        if (prev) {
          sourceSha = prev.sourceSha;
        } else {
          const sourceRef = `refs/remotes/origin/${branchForCr(cr)}`;
          const src = gitRun(repo.rootPath, ['rev-parse', '--verify', '--quiet', sourceRef]);
          if (src.status !== 0) throw new TxError('MERGE_SOURCE_MISSING', `${repo.id} 缺少远端 source ref ${sourceRef}（被评审分支未 push）`, { repo: repo.id, ref: sourceRef });
          const sourceMatches = repo.id === ctx.knowledgeBaseRepoId
            ? gitRun(repo.rootPath, ['merge-base', '--is-ancestor', repoReviewedSha(snapRepo), src.stdout]).status === 0
            : src.stdout === repoReviewedSha(snapRepo);
          if (!sourceMatches) {
            throw new TxError('RELEASE_SUBJECT_DRIFT', `${repo.id} 远端 ${sourceRef} 与 approved source 不一致`, { repo: repo.id, expected: repoReviewedSha(snapRepo), actual: src.stdout });
          }
          sourceSha = src.stdout;
        }
      }
      if (prev && prev.baseSha === baseSha && prev.sourceSha === sourceSha && prev.mergeSha) continue;
      const prepared = prepareMergeTree({
        repo, baseSha, sourceSha, cr,
        tmpRoot: path.join(ctx.installRoot, '.crctl', 'tmp'),
        knowledgeBase: repo.id === ctx.knowledgeBaseRepoId,
      });
      const tree = prepared.treeSha;
      const msg = `merge ${cr}: ${repo.id}\n\nAI-First-Op: merge\nAI-First-Tx: ${journal.txId}\nAI-First-CR: ${cr}\nAI-First-Merge-Repo: ${repo.id}\nAI-First-Merge-Base: ${baseSha}\nAI-First-Merge-Source: ${sourceSha}\n`;
      const mergeSha = gitMust(repo.rootPath, ['commit-tree', tree, '-p', baseSha, '-p', sourceSha, '-F', '-'], { input: msg });
      const rec = prev || { repo: repo.id, baseSha, sourceSha, mergeSha, pushed: false, confirmed: false };
      Object.assign(rec, { baseSha, sourceSha, mergeSha });
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
          // CR-2026-044：rebuild 使用 journal 已持久化的冻结 sourceSha，不重新采纳移动的 requirement ref
          const prepared = prepareMergeTree({
            repo, baseSha: remoteSha, sourceSha: rec.sourceSha, cr,
            tmpRoot: path.join(ctx.installRoot, '.crctl', 'tmp'),
            knowledgeBase: repo.id === ctx.knowledgeBaseRepoId,
          });
          const msg = `merge ${cr}: ${repo.id} (rebuild)\n\nAI-First-Op: merge\nAI-First-Tx: ${journal.txId}\nAI-First-CR: ${cr}\nAI-First-Merge-Repo: ${repo.id}\nAI-First-Merge-Base: ${remoteSha}\nAI-First-Merge-Source: ${rec.sourceSha}\n`;
          rec.baseSha = remoteSha;
          rec.mergeSha = gitMust(repo.rootPath, ['commit-tree', prepared.treeSha, '-p', remoteSha, '-p', rec.sourceSha, '-F', '-'], { input: msg });
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
    const localTrunkSync = reconcileLocalTrunks(ctx);
    return {
      cr, txId: journal.txId, phase: 'complete', changed: did && !wasComplete,
      sideEffects: buildMergeSideEffects(payload), recoverCommand,
      operationalWorkspace: txws, mergedStatus: payload.mergedStatus,
      localTrunkSync,
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
/* ────────────────────────── TASK-04：checkpoint（CR-2026-033） ──────────────────────────
 * 单一深原语：全仓 source commit → 非 KB lease publish → KB metadata commit 唯一完整批次可见点。
 * 复用 durable-tx 锁/journal/write-set；业务 payload 校验在本模块（不下沉 durable-tx）。
 */

const CHECKPOINT_SENSITIVE_BASENAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
const CHECKPOINT_SENSITIVE_SUFFIXES = ['.aws/credentials', '.config/gcloud/application_default_credentials.json', '.netrc', '.pypirc'];
const CHECKPOINT_ENV_EXEMPT = new Set(['.env.example', '.env.sample', '.env.template']);

function checkpointSensitivePath(p) {
  const base = p.split('/').pop();
  if (base === '.env') return true;
  if (base.startsWith('.env.') && !CHECKPOINT_ENV_EXEMPT.has(base)) return true;
  if (CHECKPOINT_SENSITIVE_BASENAMES.has(base)) return true;
  for (const suf of CHECKPOINT_SENSITIVE_SUFFIXES) if (p.endsWith(suf)) return true;
  return false;
}

function checkpointPrivateKeyHeader(text) {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text);
}

/** NUL-safe 变化 path 集合（tracked ACMR + 未忽略 untracked），不自行解析 porcelain rename 双路径。 */
function checkpointChangedPaths(wtPath) {
  const diff = gitRun(wtPath, ['diff', '--name-only', '-z', '--diff-filter=ACMR', 'HEAD', '--']);
  const untracked = gitRun(wtPath, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const [label, r] of [['diff', diff], ['ls-files', untracked]]) {
    if (r.status !== 0) throw new TxError('TX_GIT_FAILED', `checkpoint 敏感预检 git ${label} 失败（exit=${r.status}）: ${r.stderr || r.stdout}`, { cwd: wtPath, git: label });
  }
  const paths = new Set();
  for (const s of [diff.stdout, untracked.stdout]) {
    for (const p of String(s || '').split('\0')) if (p) paths.add(p);
  }
  return [...paths];
}

function checkpointRemoteHead(repoRoot, branch) {
  const ref = `refs/remotes/origin/${branch}`;
  const r = gitRun(repoRoot, ['rev-parse', '--verify', '-q', ref]);
  if (r.status === 0 && /^[0-9a-f]{40}$/.test(r.stdout)) return r.stdout;
  if (r.status === 1 && !r.stdout) return null;
  throw new TxError('TX_GIT_FAILED', `git rev-parse --verify ${ref} 失败（exit=${r.status}）: ${r.stderr || r.stdout}`, { repoRoot, ref });
}

/** 敏感预检：固定路径规则 + 私钥头；命中全仓零 add/commit/push。 */
function checkpointPreflightSensitive(repos) {
  for (const r of repos) {
    for (const p of checkpointChangedPaths(r.worktreePath)) {
      if (checkpointSensitivePath(p)) {
        throw new TxError('CHECKPOINT_SENSITIVE_PATH', `敏感路径命中: ${r.repo}: ${p}`, { repo: r.repo, path: p });
      }
      const abs = path.join(r.worktreePath, p);
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      if (checkpointPrivateKeyHeader(text)) {
        throw new TxError('CHECKPOINT_SENSITIVE_PATH', `私钥头命中: ${r.repo}: ${p}`, { repo: r.repo, path: p });
      }
    }
  }
}

/** checkpoint 业务 payload 校验（SDD §2.3，归属本模块而非 durable-tx）。 */
function assertCheckpointPayload(payload, cr, expectedRepos) {
  const bad = (message, extra = {}) => { throw new TxError('TX_RECOVERY_CONFLICT', message, { cr, ...extra }); };
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.repositories) || payload.repositories.length === 0) {
    bad(`checkpoint journal 业务 payload 非法: ${cr}`);
  }
  if (!['prepared', 'sources-committed', 'repos-confirmed', 'metadata-committed', 'metadata-pushed', 'complete'].includes(payload.phase)) {
    bad(`checkpoint 顶层 phase 非法: ${payload.phase}`);
  }
  const expected = [...expectedRepos].sort();
  const seen = new Set();
  for (const r of payload.repositories) {
    if (!r || typeof r.repo !== 'string' || !r.repo) bad('checkpoint repo 记录缺 repo');
    if (seen.has(r.repo)) bad(`checkpoint repo 记录重复: ${r.repo}`);
    seen.add(r.repo);
    if (r.remoteRef !== 'refs/heads/' + branchForCr(cr)) bad(`checkpoint repo ${r.repo} remoteRef 非法`);
    for (const f of ['baseSha', 'sourceSha', 'remoteBefore']) {
      if (r[f] != null && !/^[0-9a-f]{40}$/.test(String(r[f]))) bad(`checkpoint repo ${r.repo} ${f} 非法`);
    }
    if (!['prepared', 'committed-local', 'pushed', 'confirmed'].includes(r.phase)) bad(`checkpoint repo ${r.repo} phase 非法: ${r.phase}`);
  }
  const actual = [...seen].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) bad('checkpoint journal repo 集合与当前 graph 不一致', { expected, actual });
  if (payload.batchId != null && !/^[0-9a-f]{16}$/.test(String(payload.batchId))) bad('checkpoint batchId 非法');
  for (const f of ['kbSourceSha', 'metadataCommit']) {
    if (payload[f] != null && !/^[0-9a-f]{40}$/.test(String(payload[f]))) bad(`checkpoint ${f} 非法`);
  }
  if (payload.batchId && !payload.kbSourceSha) bad('checkpoint batchId 存在但 kbSourceSha 缺失');
  if (payload.metadataCommit && !['metadata-committed', 'metadata-pushed', 'complete'].includes(payload.phase)) bad(`checkpoint ${payload.phase} 不允许已有 metadataCommit`);
  if (['metadata-committed', 'metadata-pushed', 'complete'].includes(payload.phase)
    && (!payload.batchId || !payload.kbSourceSha || !payload.metadataCommit)) bad(`checkpoint ${payload.phase} 缺冻结 metadata 事实`);
  if (payload.phase === 'complete' && payload.repositories.some((r) => r.phase !== 'confirmed')) bad('complete checkpoint 含未 confirmed repo');
}

function readCheckpointSnapshot(kbCrRoot, cr) {
  const bp = path.join(kbCrRoot, 'change-requests', '_backlog.yml');
  let text;
  try { text = fs.readFileSync(bp, 'utf8'); }
  catch { throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', `checkpoint backlog 不存在: ${bp}`, { cr }); }
  const norm = text.replaceAll('\r\n', '\n');
  assertSupportedBacklogSchemaText(norm);
  let doc;
  try { doc = parseYaml(norm); }
  catch { throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', 'checkpoint backlog YAML 非法', { cr }); }
  const list = doc && doc['change-requests'];
  if (!Array.isArray(list)) throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', 'checkpoint backlog change-requests 非数组', { cr });
  const entries = list.filter((e) => e && e.id === cr);
  if (entries.length !== 1) throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', `checkpoint backlog ${cr} 条目数量=${entries.length}`, { cr });
  const latest = entries[0]['latest-checkpoint'];
  if (latest == null) return null;
  if (!latest || typeof latest !== 'object' || !/^[0-9a-f]{16}$/.test(String(latest['batch-id'] || '')) || !Array.isArray(latest.repositories) || latest.repositories.length === 0) {
    throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', 'latest-checkpoint 结构非法', { cr });
  }
  const seen = new Set();
  const repositories = latest.repositories.map((r) => {
    if (!r || typeof r.repo !== 'string' || !r.repo || seen.has(r.repo)
      || !/^[0-9a-f]{40}$/.test(String(r['source-sha'] || ''))
      || r['remote-ref'] !== `refs/heads/${branchForCr(cr)}`) {
      throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', `latest-checkpoint repo 条目非法: ${r && r.repo}`, { cr });
    }
    seen.add(r.repo);
    return { repo: r.repo, sourceSha: r['source-sha'], remoteRef: r['remote-ref'] };
  });
  const sorted = [...repositories].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  if (repositories.some((r, i) => r.repo !== sorted[i].repo)) throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', 'latest-checkpoint repositories 未按 repo id 排序', { cr });
  return { batchId: latest['batch-id'], repositories };
}

function checkpointBuildSideEffects(payload) {
  const se = [];
  for (const r of payload.repositories || []) {
    if (r.sourceSha && r.baseSha && r.sourceSha !== r.baseSha) se.push({ kind: 'commit', repo: r.repo, sha: r.sourceSha });
    if ((r.phase === 'pushed' || r.phase === 'confirmed') && r.sourceSha && r.remoteBefore !== r.sourceSha) {
      se.push({ kind: 'push', repo: r.repo, ref: r.remoteRef });
    }
  }
  if (payload.metadataCommit) {
    se.push({ kind: 'commit', repo: 'knowledge-base', sha: payload.metadataCommit, metadata: true });
    if (payload.phase === 'metadata-pushed' || payload.phase === 'complete') {
      const kb = (payload.repositories || []).find((r) => r.sourceSha === payload.kbSourceSha);
      se.push({ kind: 'push', repo: 'knowledge-base', ref: kb && kb.remoteRef, metadata: true });
    }
  }
  return se;
}

export async function checkpointCr(ctx, { cr, message, workspace }) {
  if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) throw new TxError('WORKSPACE_CR_INVALID', `CR-ID 非法: ${cr}`);
  const kb = getRepository(ctx, ctx.knowledgeBaseRepoId);
  const branch = branchForCr(cr);
  const remoteRef = `refs/heads/${branch}`;
  const inputDigest = sha256(JSON.stringify({ cr, graphDigest: ctx.graphDigest }));
  const recoverCommand = `crctl checkpoint ${cr}${message ? ` --message ${JSON.stringify(message)}` : ''} --workspace ${JSON.stringify(workspace || ctx.installRoot)}`;
  let journal = null, journalPath = null, payload = null;
  const lock = await acquireLock({ root: ctx.installRoot, scope: `checkpoint-${cr}`, op: 'checkpoint' });
  try {
    // 逐仓 worktree 事实校验（零写入）
    const repos = [];
    for (const repo of ctx.repositories) {
      const info = classifyRepoWorkspace(ctx, repo, cr);
      if (['missing', 'branch-only', 'remote-only'].includes(info.classification)) {
        throw new TxError('CHECKPOINT_WORKTREE_MISSING', `${repo.id}: CR worktree 不存在`, { repo: repo.id, classification: info.classification });
      }
      if (info.classification === 'path-unregistered') throw new TxError('CHECKPOINT_WORKTREE_UNREGISTERED', `${repo.id}: CR worktree 未注册`, { repo: repo.id });
      if (info.classification === 'wrong-branch') throw new TxError('CHECKPOINT_BRANCH_MISMATCH', `${repo.id}: 当前分支不是 ${branch}`, { repo: repo.id });
      repos.push({ repo: repo.id, rootPath: repo.rootPath, worktreePath: path.join(repo.worktreePath, cr), isKb: repo.id === ctx.knowledgeBaseRepoId });
    }
    // 敏感预检（journal 前与恢复前同一全仓检查，零副作用）
    checkpointPreflightSensitive(repos);

    const kbCrRoot = path.join(kb.worktreePath, cr);
    // journal 前 no-op（§4.2）：snapshot 一旦存在必须先完整校验；畸形时零写硬失败。
    const latest = readCheckpointSnapshot(kbCrRoot, cr);
    if (latest) {
      let allClean = true;
      for (const repo of ctx.repositories) {
        const st = gitRun(path.join(repo.worktreePath, cr), ['status', '--porcelain']);
        if (st.status !== 0) throw new TxError('TX_GIT_FAILED', `${repo.id}: git status 失败（exit=${st.status}）: ${st.stderr}`, { repo: repo.id });
        if (st.stdout !== '') { allClean = false; break; }
      }
      if (allClean) {
        let synced = latest.repositories.length === ctx.repositories.length;
        for (const repo of ctx.repositories) {
          gitMust(repo.rootPath, ['fetch', 'origin']);
          const snap = latest.repositories.find((x) => x.repo === repo.id);
          if (!snap) { synced = false; break; }
          const wtPath = path.join(repo.worktreePath, cr);
          const localHead = gitMust(wtPath, ['rev-parse', 'HEAD']);
          const remoteHead = checkpointRemoteHead(repo.rootPath, branch);
          if (repo.id === ctx.knowledgeBaseRepoId) {
            const parent = gitRun(wtPath, ['rev-parse', `${localHead}^`]).stdout || null;
            if (localHead !== remoteHead || parent !== snap.sourceSha) { synced = false; break; }
          } else if (localHead !== remoteHead || localHead !== snap.sourceSha) {
            synced = false; break;
          }
        }
        if (synced && checkpointBatchId({ cr, graphDigest: ctx.graphDigest, repositories: latest.repositories }) === latest.batchId) {
          return { cr, txId: null, phase: 'complete', batchId: latest.batchId,
            repositories: latest.repositories.map((x) => ({ ...x, confirmed: true })),
            metadataCommit: gitMust(kbCrRoot, ['rev-parse', 'HEAD']), changed: false, sideEffects: [], recoverCommand };
        }
      }
    }

    let created;
    ({ journal, journalPath, created } = await loadOrCreateJournal({ root: ctx.installRoot, op: 'checkpoint', cr, key: cr, graphDigest: ctx.graphDigest, inputDigest: null }));
    const freshPayload = () => ({
      phase: 'prepared', batchId: null, kbSourceSha: null, metadataCommit: null,
      repositories: repos.map((r) => ({ repo: r.repo, remoteRef, baseSha: null, sourceSha: null, remoteBefore: null, phase: 'prepared' })),
    });
    payload = journal.checkpoint;
    const save = async (phase) => {
      payload.phase = phase;
      journal.phase = phase;
      journal.cr = cr;
      journal.inputDigest = inputDigest;
      journal.sideEffects = checkpointBuildSideEffects(payload);
      await saveJournal({ path: journalPath, journal });
    };
    if (payload == null) {
      if (!created && journal.phase !== 'init') throw new TxError('TX_RECOVERY_CONFLICT', `checkpoint journal ${journal.txId} 缺业务 payload`, { cr });
      payload = freshPayload();
      journal.checkpoint = payload;
      await save('prepared');
    } else if (journal.inputDigest != null && journal.inputDigest !== inputDigest && payload.phase !== 'complete') {
      throw new TxError('TX_INPUT_CONFLICT', `checkpoint/${cr} 已有在途事务且 inputDigest 不一致`, { txId: journal.txId });
    }
    assertCheckpointPayload(payload, cr, repos.map((r) => r.repo));
    const assertGraph = () => {
      const hasSideEffects = payload.repositories.some((r) => r.sourceSha || r.phase !== 'prepared') || payload.metadataCommit;
      if (hasSideEffects && journal.graphDigest !== ctx.graphDigest) {
        throw new TxError('GRAPH_CHANGED_DURING_TRANSACTION', 'checkpoint 事务出现副作用后 dir-graph 声明变化，拒绝继续', { journalDigest: journal.graphDigest, currentDigest: ctx.graphDigest });
      }
    };
    await recoverWriteSet({ txRoot: ctx.installRoot, txId: journal.txId });

    // complete journal 只是可清理恢复状态；先复核远端 authority，再删除并在本调用创建下一批。
    if (payload.phase === 'complete') {
      for (const r of repos) {
        const rec = payload.repositories.find((x) => x.repo === r.repo);
        gitMust(r.rootPath, ['fetch', 'origin']);
        const remoteSha = checkpointRemoteHead(r.rootPath, branch);
        if (r.isKb) {
          const parent = payload.metadataCommit && gitRun(r.rootPath, ['rev-parse', `${payload.metadataCommit}^`]).stdout;
          if (remoteSha !== payload.metadataCommit || parent !== payload.kbSourceSha) {
            throw new TxError('CHECKPOINT_REMOTE_HISTORY_REWRITTEN', 'complete checkpoint 的 KB authority 不再成立', { repo: r.repo, remoteSha });
          }
        } else if (remoteSha !== rec.sourceSha) {
          throw new TxError('CHECKPOINT_REMOTE_HISTORY_REWRITTEN', 'complete checkpoint 的 repo authority 不再成立', { repo: r.repo, remoteSha, sourceSha: rec.sourceSha });
        }
      }
      fs.rmSync(path.dirname(journalPath), { recursive: true, force: true });
      ({ journal, journalPath } = await loadOrCreateJournal({ root: ctx.installRoot, op: 'checkpoint', cr, key: cr, graphDigest: ctx.graphDigest, inputDigest: null }));
      payload = freshPayload();
      journal.checkpoint = payload;
      await save('prepared');
    }

    const known = new Map(payload.repositories.map((r) => [r.repo, r]));
    const kbWt = kbCrRoot;

    // metadata commit/save 窗口：trailer 命中即恢复；仅 write-set 候选存在则撤回候选后重扫 source。
    if (!payload.metadataCommit && payload.batchId) {
      const head = gitMust(kbWt, ['rev-parse', 'HEAD']);
      if (head !== payload.kbSourceSha) {
        const parent = gitRun(kbWt, ['rev-parse', `${head}^`]).stdout || null;
        const body = gitRun(kbWt, ['log', '-1', '--format=%B', head]).stdout;
        if (parent !== payload.kbSourceSha || !body.includes('AI-First-Op: checkpoint') || !body.includes(`AI-First-Tx: ${journal.txId}`) || !body.includes(`AI-First-CR: ${cr}`)) {
          throw new TxError('TX_RECOVERY_CONFLICT', `knowledge-base HEAD ${head} 不是本 checkpoint 的 metadata commit`, { cr, head });
        }
        payload.metadataCommit = head;
        await save('metadata-committed');
      } else {
        const rel = 'change-requests/_backlog.yml';
        const before = `${gitMust(kbWt, ['show', `${payload.kbSourceSha}:${rel}`])}\n`;
        const snapRepos = payload.repositories.map((r) => ({ repo: r.repo, sourceSha: r.sourceSha, remoteRef: r.remoteRef }));
        const candidate = editLatestCheckpoint(before, cr, { batchId: payload.batchId, repositories: snapRepos });
        const current = fs.readFileSync(path.join(kbWt, rel), 'utf8').replaceAll('\r\n', '\n');
        if (current === candidate.replaceAll('\r\n', '\n')) {
          fs.writeFileSync(path.join(kbWt, rel), before, 'utf8');
          gitMust(kbWt, ['reset', '--', rel]);
        }
        payload.batchId = null;
        payload.kbSourceSha = null;
        await save('repos-confirmed');
      }
    }

    // metadata 尚未 commit 时逐仓恢复重扫；旧 confirmed repo 出现变化也必须重新 publish。
    let did = false;
    if (!payload.metadataCommit) {
    for (const r of repos) {
      const rec = known.get(r.repo);
      assertGraph();
      const wtPath = r.worktreePath;
      gitMust(r.rootPath, ['fetch', 'origin']);
      rec.remoteBefore = checkpointRemoteHead(r.rootPath, branch);
      const head = gitMust(wtPath, ['rev-parse', 'HEAD']);
      const status = gitRun(wtPath, ['status', '--porcelain']);
      if (status.status !== 0) throw new TxError('TX_GIT_FAILED', `${r.repo}: git status 失败（exit=${status.status}）: ${status.stderr}`, { repo: r.repo });
      const dirty = status.stdout !== '';
      rec.baseSha = head;
      if (!dirty) {
        if (rec.sourceSha && head !== rec.sourceSha) throw new TxError('TX_RECOVERY_CONFLICT', `${r.repo}: HEAD ${head} 与 journal sourceSha ${rec.sourceSha} 不一致（第三方修改）`, { repo: r.repo });
        rec.sourceSha = head;
        if (rec.phase === 'prepared') rec.phase = 'committed-local';
        continue;
      }
      gitMust(wtPath, ['add', '-A']);
      const cachedDiff = gitRun(wtPath, ['diff', '--cached', '--quiet']);
      if (cachedDiff.status === 0) {
        rec.sourceSha = head;
      } else if (cachedDiff.status === 1) {
        const msg = `wip: ${cr} ${r.repo} checkpoint${message ? ` ${message}` : ''}\n\nAI-First-Op: checkpoint\nAI-First-Tx: ${journal.txId}\nAI-First-CR: ${cr}\n`;
        gitMust(wtPath, ['commit', '--no-gpg-sign', '--file=-'], { input: msg });
        rec.sourceSha = gitMust(wtPath, ['rev-parse', 'HEAD']);
        rec.phase = 'committed-local';
        did = true;
        await save('sources-committed');
        faultPoint('checkpoint-after-source-commit', { repo: r.repo });
      } else {
        throw new TxError('TX_GIT_FAILED', `${r.repo}: git diff --cached --quiet 失败（exit=${cachedDiff.status}）`, { repo: r.repo, stderr: cachedDiff.stderr });
      }
      const stable = gitRun(wtPath, ['status', '--porcelain']);
      if (stable.status !== 0) throw new TxError('TX_GIT_FAILED', `${r.repo}: source commit 后 git status 失败（exit=${stable.status}）`, { repo: r.repo });
      if (stable.stdout !== '') {
        throw new TxError('CHECKPOINT_WORKTREE_CHANGED_DURING_TRANSACTION', `${r.repo}: source commit 后工作树仍有变化，不静稳`, { repo: r.repo });
      }
      rec.phase = 'committed-local';
    }
    await save('sources-committed');

    // 非 KB publish（exact-head + lease）
    for (const r of repos) {
      if (r.isKb) continue;
      const rec = known.get(r.repo);
      for (let attempt = 0; attempt < 3 && rec.phase !== 'confirmed'; attempt++) {
        assertGraph();
        gitMust(r.rootPath, ['fetch', 'origin']);
        const remoteSha = checkpointRemoteHead(r.rootPath, branch);
        const remoteIsAncestor = remoteSha != null && gitRun(r.rootPath, ['merge-base', '--is-ancestor', remoteSha, rec.sourceSha]).status === 0;
        const sourceIsAncestor = remoteSha != null && gitRun(r.rootPath, ['merge-base', '--is-ancestor', rec.sourceSha, remoteSha]).status === 0;
        const cls = classifyCheckpointRemote({ remoteSha, sourceSha: rec.sourceSha, remoteIsSourceAncestor: remoteIsAncestor, sourceIsRemoteAncestor: sourceIsAncestor, journalSaysPublished: rec.phase === 'pushed' });
        if (cls === 'confirmed') { rec.phase = 'confirmed'; did = true; await save(payload.phase); faultPoint('checkpoint-after-confirm', { repo: r.repo }); break; }
        if (cls === 'create') gitMust(r.rootPath, ['push', `--force-with-lease=${branch}:`, 'origin', `${rec.sourceSha}:refs/heads/${branch}`]);
        else if (cls === 'pushable') gitMust(r.rootPath, ['push', `--force-with-lease=${branch}:${remoteSha}`, 'origin', `${rec.sourceSha}:refs/heads/${branch}`]);
        else if (cls === 'advanced') throw new TxError('CHECKPOINT_REMOTE_ADVANCED', `${r.repo}: remote 领先 source，先 pull 后重做`, { repo: r.repo, remoteSha, sourceSha: rec.sourceSha });
        else if (cls === 'diverged') throw new TxError('CHECKPOINT_REMOTE_DIVERGED', `${r.repo}: remote 与 source 分叉`, { repo: r.repo, remoteSha, sourceSha: rec.sourceSha });
        else throw new TxError('CHECKPOINT_REMOTE_HISTORY_REWRITTEN', `${r.repo}: 已发布 source 不再被 remote 包含`, { repo: r.repo, remoteSha, sourceSha: rec.sourceSha });
        rec.phase = 'pushed';
        did = true;
        await save(payload.phase);
        faultPoint('checkpoint-after-push', { repo: r.repo });
      }
      if (rec.phase !== 'confirmed') throw new TxError('CHECKPOINT_REMOTE_ADVANCED', `${r.repo}: publish 阶段未收敛`, { repo: r.repo });
    }
    await save('repos-confirmed');
    }

    // KB metadata commit（唯一完整批次可见点）。先 durable 保存待提交 source facts。
    if (!payload.batchId) {
      assertGraph();
      for (const r of repos) {
        const rec = known.get(r.repo);
        if (gitMust(r.worktreePath, ['rev-parse', 'HEAD']) !== rec.sourceSha) {
          throw new TxError('CHECKPOINT_WORKTREE_CHANGED_DURING_TRANSACTION', `${r.repo}: HEAD 与 journal sourceSha 不一致`, { repo: r.repo });
        }
        const st = gitRun(r.worktreePath, ['status', '--porcelain']);
        if (st.status !== 0) throw new TxError('TX_GIT_FAILED', `${r.repo}: metadata 前 git status 失败（exit=${st.status}）`, { repo: r.repo });
        if (st.stdout !== '') throw new TxError('CHECKPOINT_WORKTREE_CHANGED_DURING_TRANSACTION', `${r.repo}: metadata 前工作树不干净`, { repo: r.repo });
      }
      gitMust(kb.rootPath, ['fetch', 'origin']);
      const kbRemoteSha = checkpointRemoteHead(kb.rootPath, branch);
      payload.kbSourceSha = gitMust(kbWt, ['rev-parse', 'HEAD']);
      const kbRemoteIsAncestor = kbRemoteSha != null && gitRun(kb.rootPath, ['merge-base', '--is-ancestor', kbRemoteSha, payload.kbSourceSha]).status === 0;
      const kbHeadIsAncestor = kbRemoteSha != null && gitRun(kb.rootPath, ['merge-base', '--is-ancestor', payload.kbSourceSha, kbRemoteSha]).status === 0;
      const kbCls = classifyCheckpointRemote({ remoteSha: kbRemoteSha, sourceSha: payload.kbSourceSha, remoteIsSourceAncestor: kbRemoteIsAncestor, sourceIsRemoteAncestor: kbHeadIsAncestor, journalSaysPublished: false });
      if (!['confirmed', 'create', 'pushable'].includes(kbCls)) {
        throw new TxError(kbCls === 'advanced' ? 'CHECKPOINT_REMOTE_ADVANCED' : 'CHECKPOINT_REMOTE_DIVERGED', `knowledge-base 在 metadata 前未就绪（${kbCls}）`, { cr, remoteSha: kbRemoteSha });
      }
      const snapRepos = repos.map((r) => ({ repo: r.repo, sourceSha: known.get(r.repo).sourceSha, remoteRef }));
      payload.batchId = checkpointBatchId({ cr, graphDigest: ctx.graphDigest, repositories: snapRepos });
      await save('repos-confirmed');
    }

    if (!payload.metadataCommit) {
      const snapRepos = payload.repositories.map((r) => ({ repo: r.repo, sourceSha: r.sourceSha, remoteRef: r.remoteRef }));
      const backlogP = path.join(kbWt, 'change-requests', '_backlog.yml');
      const backlogText = fs.readFileSync(backlogP, 'utf8');
      assertSupportedBacklogSchemaText(backlogText);
      const after = editLatestCheckpoint(backlogText, cr, { batchId: payload.batchId, repositories: snapRepos });
      await applyWriteSet({ root: kbWt, txRoot: ctx.installRoot, txId: journal.txId, entries: [
        { path: 'change-requests/_backlog.yml', beforeSha256: sha256(backlogText), afterSha256: sha256(after), content: after },
      ] });
      gitMust(kbWt, ['add', 'change-requests/_backlog.yml']);
      const staged = gitRun(kbWt, ['diff', '--cached', '--name-only']).stdout.split('\n').filter(Boolean);
      if (staged.length !== 1 || staged[0] !== 'change-requests/_backlog.yml') {
        throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', `metadata stage 集合非法: ${staged.join(',')}`);
      }
      gitMust(kbWt, ['commit', '--no-gpg-sign', '--file=-'], { input: `[cr] checkpoint ${cr} batch ${payload.batchId}\n\nAI-First-Op: checkpoint\nAI-First-Tx: ${journal.txId}\nAI-First-CR: ${cr}\n` });
      payload.metadataCommit = gitMust(kbWt, ['rev-parse', 'HEAD']);
      did = true;
      await save('metadata-committed');
      faultPoint('checkpoint-after-metadata-commit', { cr });
      const parent = gitRun(kbWt, ['rev-parse', `${payload.metadataCommit}^`]).stdout || null;
      if (parent !== payload.kbSourceSha) throw new TxError('CHECKPOINT_SNAPSHOT_INVALID', `metadata commit 直接父 ${parent} 不等于 kbSourceSha ${payload.kbSourceSha}`, { cr });
    }

    // KB metadata publish + 精确确认
    if (payload.phase !== 'complete') {
      gitMust(kb.rootPath, ['fetch', 'origin']);
      const remoteSha = checkpointRemoteHead(kb.rootPath, branch);
      if (remoteSha !== payload.metadataCommit) {
        const remoteIsAncestor = remoteSha != null && gitRun(kb.rootPath, ['merge-base', '--is-ancestor', remoteSha, payload.metadataCommit]).status === 0;
        const sourceIsAncestor = remoteSha != null && gitRun(kb.rootPath, ['merge-base', '--is-ancestor', payload.metadataCommit, remoteSha]).status === 0;
        const cls = classifyCheckpointRemote({ remoteSha, sourceSha: payload.metadataCommit, remoteIsSourceAncestor: remoteIsAncestor, sourceIsRemoteAncestor: sourceIsAncestor, journalSaysPublished: payload.phase === 'metadata-pushed' });
        if (cls === 'create') gitMust(kb.rootPath, ['push', `--force-with-lease=${branch}:`, 'origin', `${payload.metadataCommit}:refs/heads/${branch}`]);
        else if (cls === 'pushable') gitMust(kb.rootPath, ['push', `--force-with-lease=${branch}:${remoteSha}`, 'origin', `${payload.metadataCommit}:refs/heads/${branch}`]);
        else if (cls === 'history-rewritten') throw new TxError('CHECKPOINT_REMOTE_HISTORY_REWRITTEN', 'knowledge-base metadata commit 遇远端 history rewrite', { cr, remoteSha, metadataCommit: payload.metadataCommit });
        else if (cls === 'advanced') throw new TxError('CHECKPOINT_REMOTE_ADVANCED', 'knowledge-base remote 领先 metadata commit', { cr, remoteSha });
        else throw new TxError('CHECKPOINT_REMOTE_DIVERGED', 'knowledge-base remote 与 metadata commit 分叉', { cr, remoteSha });
        payload.phase = 'metadata-pushed';
        await save('metadata-pushed');
        faultPoint('checkpoint-after-metadata-push', { cr });
      }
      gitMust(kb.rootPath, ['fetch', 'origin']);
      const finalRemote = checkpointRemoteHead(kb.rootPath, branch);
      if (finalRemote !== payload.metadataCommit) throw new TxError('CHECKPOINT_REMOTE_HISTORY_REWRITTEN', 'knowledge-base metadata push 后 remote 不等于 metadata commit', { cr, finalRemote, metadataCommit: payload.metadataCommit });
      known.get(kb.id).phase = 'confirmed';
      await save('complete');
      try { fs.rmSync(path.dirname(journalPath), { recursive: true, force: true }); } catch { /* best-effort 清理 */ }
    }

    return { cr, txId: journal.txId, phase: 'complete', batchId: payload.batchId,
      repositories: payload.repositories.map((r) => ({ repo: r.repo, sourceSha: r.sourceSha, remoteRef: r.remoteRef, confirmed: true })),
      metadataCommit: payload.metadataCommit, changed: did, sideEffects: checkpointBuildSideEffects(payload), recoverCommand };
  } catch (e) {
    if (e instanceof TxError && journal) {
      throw new TxError(e.code, e.message, {
        ...e.extra, txId: journal.txId, phase: payload && payload.phase || journal.phase,
        sideEffects: checkpointBuildSideEffects(payload || {}), recoverCommand,
      });
    }
    throw e;
  } finally {
    await lock.release();
  }
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
    ...(m.event ? { event: { kind: m.event.kind, payload: m.event.payload, payloadSha256: m.event.payloadSha256 } } : {}),
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
  // CR-2026-049 TASK-02：traceability 必须 v2（含 event），baseline/tasks 保持 v1
  const wantV = stage === 'traceability' ? 2 : 1;
  if (m.v !== wantV) throw new TxError('WRITEBACK_MANIFEST_INVALID', `manifest v=${m.v}（${stage} 仅支持 v${wantV}）`);
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
  // v2 event 校验（TD-B1）：重算 payloadSha256、spec_id 与 traceability['spec-id'] 对齐、kind 固定 trace
  let event = null;
  if (m.v === 2) {
    if (stage !== 'traceability') throw new TxError('WRITEBACK_MANIFEST_INVALID', `v2 manifest 仅限 traceability，当前 stage=${stage}`);
    const e = m.event;
    if (!e || typeof e !== 'object' || e.kind !== 'trace') {
      throw new TxError('WRITEBACK_MANIFEST_INVALID', 'v2 manifest 缺 event.kind=trace');
    }
    if (typeof e.payloadSha256 !== 'string' || !HEX64.test(e.payloadSha256)) {
      throw new TxError('WRITEBACK_MANIFEST_INVALID', 'event.payloadSha256 非法');
    }
    if (sha256(JSON.stringify(e.payload)) !== e.payloadSha256) {
      throw new TxError('WRITEBACK_MANIFEST_INVALID', 'event.payloadSha256 与 payload 重算不符');
    }
    const p = e.payload;
    if (!p || typeof p !== 'object' || typeof p.spec_id !== 'string' || !p.spec_id) {
      throw new TxError('WRITEBACK_MANIFEST_INVALID', 'event.payload.spec_id 缺失');
    }
    if (p.spec_id !== m.specId) throw new TxError('WRITEBACK_MANIFEST_MISMATCH', `event.payload.spec_id=${p.spec_id} 与 manifest specId=${m.specId} 不一致`);
    const t = p.traceability;
    if (!t || typeof t !== 'object' || t['spec-id'] !== m.specId) {
      throw new TxError('WRITEBACK_MANIFEST_INVALID', `event.payload.traceability 非对象或 spec-id 与 ${m.specId} 不一致`);
    }
    if (t['cr-ref'] !== cr) throw new TxError('WRITEBACK_MANIFEST_INVALID', `event.payload.traceability.cr-ref=${t['cr-ref']} 与 ${cr} 不一致`);
    event = { kind: e.kind, payload: e.payload, payloadSha256: e.payloadSha256 };
  }
  return {
    parsed: m,
    files: m.files.map((f) => ({
      path: f.path, beforeSha256: f.beforeSha256 == null ? null : f.beforeSha256,
      afterSha256: f.afterSha256, blobText: f._blobText,
    })),
    plannedExisting: new Set(m.files.map((f) => f.path)),
    event,
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
  if (stage === 'baseline' && business.value.milestoneFile != null) throw new TxError('WRITEBACK_STAGE_ARGS_INVALID', 'baseline 不接受 milestoneFile');
  if (stage === 'tasks' && (business.value.milestoneName != null || business.value.brief != null || business.value.milestoneFile != null)) {
    throw new TxError('WRITEBACK_STAGE_ARGS_INVALID', 'tasks 不接受 milestone 参数');
  }
  if (stage === 'traceability' && !business.value.milestoneFile) throw new TxError('WRITEBACK_MILESTONE_PATH_INVALID', 'traceability 需要 milestoneFile');
  if (stage === 'traceability' && (business.value.milestoneName != null || business.value.brief != null)) {
    throw new TxError('WRITEBACK_STAGE_ARGS_INVALID', 'traceability 不接受 milestoneName/brief');
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

/* ── archive 证据门适配（CR-2026-041 FR-04）────────────────────────────────────────
 * 不复制证据校验算法：复用固定 generator writeback-traceability.mjs 的唯一 validator，
 * 通过其内部 --validate-evidence 模式只读调用（spawnSync shell:false，零 candidate/状态/文件写入）。
 * crctl 只负责调用时序、错误映射与事务；不新增共享模块、registry 或 crctl 子命令。 */
const EVIDENCE_TO_ARCHIVE = {
  EVIDENCE_MISSING: 'ARCHIVE_EVIDENCE_MISSING',
  EVIDENCE_DUPLICATE: 'ARCHIVE_EVIDENCE_DUPLICATE',
  EVIDENCE_PATH_INVALID: 'ARCHIVE_EVIDENCE_PATH_INVALID',
  EVIDENCE_DRIFT: 'ARCHIVE_EVIDENCE_DRIFT',
  EVIDENCE_STATE: 'ARCHIVE_EVIDENCE_STATE',
  EVIDENCE_INVALID: 'ARCHIVE_EVIDENCE_MISSING',
};

function runFixedEvidenceValidator({ editRoot, cr, specId }) {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'writeback', 'scripts', WRITEBACK_GENERATORS.traceability);
  const args = [script, '--validate-evidence', '--workspace', editRoot, '--cr', cr, '--spec', specId];
  const result = spawnSync(process.execPath, args, { cwd: editRoot, encoding: 'utf8', shell: false });
  if (result.status === 0) return { ok: true };
  let parsed = null;
  try { parsed = JSON.parse(result.stderr || ''); } catch { /* generator 非结构化崩溃 */ }
  const e = parsed && parsed.error;
  const code = EVIDENCE_TO_ARCHIVE[e?.code] || 'ARCHIVE_EVIDENCE_STATE';
  throw new TxError(code, e?.message || `证据校验失败（exit=${result.status}）: ${(result.stderr || result.stdout || '').trim()}`, { cr, specId, evidenceCode: e?.code ?? null });
}

/** CR-2026-049 TASK-03：archive trace pending 前置门（SDD §1.3）。只读 writeback traceability journal：
 * emitted → 放行；pending → replayTraceEvent 补发（成功把 emitted 事实持久化回原 journal）；
 * 补发失败 → ARCHIVE_TRACE_PENDING（零 archive 写入，保留现场）；journal 缺失/意图不完整/digest 漂移 →
 * ARCHIVE_TRACE_FACT_MISSING。两者均硬失败，禁止跳门/手工清 journal。 */
async function archiveTraceGate(ctx, cr, input) {
  const wb = loadExistingJournal({ root: ctx.installRoot, op: 'writeback', key: `${cr}-traceability` });
  const intent = wb?.journal?.writeback?.traceOutbox;
  if (!intent) {
    throw new TxError('ARCHIVE_TRACE_FACT_MISSING', `writeback/${cr}-traceability journal 缺失或 traceOutbox 意图缺失（无法证明 trace 事件已发射）`, { cr });
  }
  if (intent.state === 'emitted') return;
  if (intent.state !== 'pending') {
    throw new TxError('ARCHIVE_TRACE_FACT_MISSING', `traceOutbox.state=${intent.state} 非法（仅 pending/emitted）`, { cr, txId: wb.journal.txId });
  }
  if (!intent.commit || !intent.dedupName || intent.payload === undefined || typeof intent.payloadSha256 !== 'string') {
    throw new TxError('ARCHIVE_TRACE_FACT_MISSING', `traceOutbox 意图不完整（缺 commit/dedupName/payload/payloadSha256）`, { cr, txId: wb.journal.txId });
  }
  if (sha256(JSON.stringify(intent.payload)) !== intent.payloadSha256) {
    throw new TxError('ARCHIVE_TRACE_FACT_MISSING', `traceOutbox payload digest 漂移（${intent.payloadSha256} != 重算）`, { cr, txId: wb.journal.txId });
  }
  let name = null;
  try {
    if (typeof input.replayTraceEvent !== 'function') throw new Error('replayTraceEvent callback missing');
    name = input.replayTraceEvent({ cr, intent });
  } catch { name = null; }
  if (!name) {
    throw new TxError('ARCHIVE_TRACE_PENDING', `trace 事件仍 pending 且补发失败：archive 零写入、零 cleanup，现场保留；请重跑同一 archive（禁止跳门/手工清 journal）`, { cr, txId: wb.journal.txId });
  }
  wb.journal.writeback.traceOutbox = { ...intent, state: 'emitted' };
  await saveJournal({ path: wb.journalPath, journal: wb.journal });
}

/**
 * FR-14（CR-2026-057）writeback-apply 入口版本守卫（SDD §2.2/§4.3）：
 * - 不调用 resolveOperationalWorkspace（B-SDD-001）：cr.md 侧经 crWorktreePath（repositories graph 纯路径反解）
 *   + readCrMdTargetVersion（单文件行级读取）；authority/merge journal/txws 异常不可能抢先于 WRITEBACK_VERSION_*；
 * - cr.md 侧缺失/无 frontmatter/缺字段 → 规范化失败 → WRITEBACK_VERSION_INVALID（PRD FR-14「任一侧规范化失败」口径）；
 * - 错误优先级：版本错误 > WRITEBACK_STATE_MISMATCH > 其它后续错误（AC-14.6）。
 * 返回 { ok:true, value } 的 value 为规范化串（B-SDD-002 回灌源）。
 */
/**
 * FR-14（CR-2026-057）+ FR-1/FR-3（CR-2026-058）writeback-apply 入口版本守卫（SDD §2.1/§4.2）：
 * - 版本事实源经窄只读解析器 resolveWritebackAuthorityPath 定位（FR-3）：merging/writing-back/archived 或
 *   merge journal complete 时 authority=txws；否则回退 cr-worktree。**不调用 resolveOperationalWorkspace**
 *   （B-SDD-001）：cr.md 侧缺失/无 frontmatter/缺字段 → 规范化失败 → WRITEBACK_VERSION_INVALID；
 * - 判定表（FR-1）：cr.md=unassigned + 输入真实 + authority=txws → 放行回灌（refill=true）；同组合但
 *   authority=cr-worktree → 放行不回灌（refill=false，后续落 WRITEBACK_STATE_MISMATCH）；两侧/输入侧
 *   unassigned → WRITEBACK_VERSION_UNASSIGNED；两侧真实不一致 → WRITEBACK_VERSION_MISMATCH；任一侧
 *   规范化失败 → WRITEBACK_VERSION_INVALID；全等 → 放行不改版本字段；
 * - 错误优先级：版本错误 > WRITEBACK_STATE_MISMATCH > 其它后续错误（AC-14.6）。
 * - 返回 { ok:true, value, refill, authority: { path, source } }（authority 快照是 B-SDD-02 绑定唯一事实源：
 *   applyWritebackAtomic 第 5.5 步校验它与 opWs 同源同路径；planVersionRefill 以它为唯一回灌位置）。
 */
export function guardWritebackVersion(ctx, cr, inputTargetRaw) {
  const b = normalizeTargetVersion(inputTargetRaw);
  const auth = resolveWritebackAuthorityPath(ctx, cr);
  const a = (() => {
    const r = readCrMdTargetVersion(auth.path, cr);
    return r.ok ? normalizeTargetVersion(r.raw) : { ok: false, reason: 'missing' };
  })();
  if (!a.ok || !b.ok) {
    throw new TxError('WRITEBACK_VERSION_INVALID', `writeback --target-version 任一侧规范化失败：输入 ${JSON.stringify(inputTargetRaw == null ? null : String(inputTargetRaw))}（${b.ok ? 'ok' : b.reason}）/ cr.md（${a.ok ? 'ok' : a.reason}）`, { cr, input: inputTargetRaw == null ? null : String(inputTargetRaw), inputReason: b.ok ? null : b.reason, crMdReason: a.ok ? null : a.reason });
  }
  if (a.value === 'unassigned' && b.value !== 'unassigned' && auth.source === 'transaction-workspace') {
    return { ok: true, value: b.value, refill: true, authority: { path: auth.path, source: auth.source } };
  }
  if (a.value === 'unassigned' && b.value !== 'unassigned') {
    // 窄解析器回退（source=cr-worktree）：仅版本比较放行，回灌禁用（后续落既有 STATE_MISMATCH 或第 5.5 步新 throw 位）
    return { ok: true, value: b.value, refill: false, authority: { path: auth.path, source: auth.source } };
  }
  if (a.value === 'unassigned' || b.value === 'unassigned') {
    throw new TxError('WRITEBACK_VERSION_UNASSIGNED', `writeback 版本守卫：两侧或输入侧为 unassigned 一律拒绝（cr.md=${a.value}，输入=${b.value}）；仅 cr.md=unassigned 且输入为真实版本时放行并回灌账本`, { cr, crMd: a.value, input: b.value });
  }
  if (a.value !== b.value) {
    throw new TxError('WRITEBACK_VERSION_MISMATCH', `--target-version ${b.value} 与 cr.md ${a.value} 不一致`, { cr, crMd: a.value, input: b.value });
  }
  return { ok: true, value: a.value, refill: false, authority: { path: auth.path, source: auth.source } };
}

/* ────────────────────────── CR-2026-058：回灌计划与行级编辑（FR-2/FR-2.1，SDD §4.3） ──────────────────────────
 * 三个符号均为顶层 export（B-DP-01 测试 seam，与 normalizeTargetVersion/readCrMdTargetVersion 的 export+直测
 * 模式一致）；生产侧仅 applyWritebackAtomic 消费，调用面不变。纯读 + 纯文本变换，无任何文件写入、
 * 无 journal/lock/candidate 副作用；失败路径零写入（FR-2.1 时序先于 candidate/journal）。 */

/** 行级编辑：frontmatter 内 ^target-version: 行定点替换为规范化版本（幂等口径 + 硬失败纪律，NFR-3）。 */
export function applyTargetVersionToCrMd(text, version) {
  const norm = text.replaceAll('\r\n', '\n');
  const fm = matchFrontmatter(norm);
  if (!fm) throw new TxError('WRITEBACK_VERSION_INVALID', 'cr.md 缺少 frontmatter，无法回灌 target-version', { crMdReason: 'missing' });
  const line = fm.body.split('\n').find((l) => /^target-version:/.test(l));
  if (!line) throw new TxError('WRITEBACK_VERSION_INVALID', 'cr.md frontmatter 缺少 target-version 行，无法回灌', { crMdReason: 'missing' });
  const replaced = line.replace(/^(target-version:).*$/, `$1 ${version}`);
  const body = fm.body.split('\n').map((l) => (l === line ? replaced : l)).join('\n');
  const after = norm.replace(fm.match, `---\n${body}\n---`);
  // 必须校验替换结果：替换后文本不同 → 正常返回；相同（该行已等于目标版本）→ 幂等放行返回原文；
  // 禁止「匹配不到仍静默返回原文」的降级路径（纪律 #1）。
  return after === norm ? norm : after;
}

/** 行级编辑：_backlog.yml 条目块内 target-version 行定点替换（B-CODE-001 口径，SDD §4.3 ②）。
 * 禁止用 block.text split/join 重建（块尾换行不在 block.text 内）；替换未命中一律硬失败。 */
export function editBacklogEntryTargetVersion(text, cr, version) {
  const norm = text.replaceAll('\r\n', '\n');
  const blk = matchEntryBlock(norm, cr);
  if (!blk) throw new TxError('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`, { cr });
  const span = norm.slice(blk.start, blk.end);
  const line = span.split('\n').find((l) => /^[ \t]*target-version:/.test(l));
  if (!line) throw new TxError('WRITEBACK_VERSION_INVALID', `_backlog.yml ${cr} 条目缺少 target-version 行`, { cr, backlogReason: 'missing' });
  const indent = (line.match(/^[ \t]*/) || [''])[0];
  const replaced = line.replace(/^([ \t]*)target-version:.*$/, `${indent}target-version: ${version}`);
  if (replaced === line) {
    throw new TxError('WRITEBACK_VERSION_INVALID', `_backlog.yml ${cr} 条目 target-version 行替换未命中（行级编辑硬失败）`, { cr, backlogReason: 'no-match' });
  }
  const newSpan = span.split('\n').map((l) => (l === line ? replaced : l)).join('\n');
  return norm.slice(0, blk.start) + newSpan + norm.slice(blk.end);
}

/**
 * 回灌分支唯一计划器（FR-2/FR-2.1，SDD §4.3）：同源绑定（⓪）+ backlog 预检四错误码（①）+
 * cr.md 同源重读语义复核（③）。产物 { inputVersion, crMd: RefillEntry|null, backlog: RefillEntry|null,
 * crMdBase: {text, sha256}|null }；RefillEntry = { path, beforeSha256, afterSha256, afterText }。
 * 纯读 + 纯文本变换，无任何文件写入；失败路径零写入（先于 candidate/journal，FR-2.1 时序）。
 */
export function planVersionRefill({ txws, authority, cr, stage, version }) {
  // ⓪ 同源绑定（B-SDD-02 防御性重申）：调用方已在 applyWritebackAtomic 第 5.5 步校验，此处防未来重构漂移
  if (authority.source !== 'transaction-workspace' || authority.path !== txws) {
    throw new TxError('WRITEBACK_STATE_MISMATCH', `writeback 版本权威与操作工作区不同源：guardSource=${authority.source} guardPath=${authority.path} opPath=${txws}`, { cr, phase: null });
  }
  // ① backlog 预检（FR-2.1；先于任何 write-set/journal/candidate 副作用）
  const backlogRel = 'change-requests/_backlog.yml';
  let raw;
  try { raw = fs.readFileSync(path.join(txws, backlogRel), 'utf8'); }
  catch { throw new TxError('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`, { cr }); }
  const norm = raw.replaceAll('\r\n', '\n');
  const lines = backlogLines(norm);
  const hits = lines.filter((l) => {
    const m = l.text.match(/^([ \t]*)- id:\s*["']?([^\s"']+)["']?\s*$/);
    return m && m[2] === cr;
  });
  if (hits.length === 0) throw new TxError('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`, { cr });
  if (hits.length > 1) throw new TxError('WRITEBACK_BACKLOG_ENTRY_DUPLICATE', `_backlog.yml 中 ${cr} 条目重复（命中 ${hits.length} 次），拒绝回灌`, { cr, count: hits.length });
  const blk = matchEntryBlock(norm, cr);
  if (!blk) throw new TxError('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml（条目块定位失败）`, { cr });
  const tLine = blk.text.split('\n').find((l) => /^[ \t]*target-version:/.test(l));
  if (!tLine) throw new TxError('WRITEBACK_VERSION_INVALID', `_backlog.yml ${cr} 条目缺少 target-version 行`, { cr, backlogReason: 'missing' });
  const tRaw = tLine.replace(/^[ \t]*target-version:\s*/, '').trim().replace(/^["']|["']$/g, '');
  const bv = normalizeTargetVersion(tRaw, { allowUnassigned: true });
  if (!bv.ok) throw new TxError('WRITEBACK_VERSION_INVALID', `_backlog.yml ${cr} 条目 target-version 规范化失败`, { cr, backlogReason: bv.reason });
  let backlogEntry = null;
  if (bv.value === 'unassigned') {
    const after = editBacklogEntryTargetVersion(norm, cr, version);
    backlogEntry = { path: backlogRel, beforeSha256: sha256(raw), afterSha256: sha256(after), afterText: after };
  } else if (bv.value === version) {
    backlogEntry = null; // 幂等：条目已是目标版本，不改写
  } else {
    throw new TxError('WRITEBACK_BACKLOG_VERSION_MISMATCH', `_backlog.yml ${cr} 已是另一真实版本 ${bv.value}，与输入 ${version} 不一致，拒绝回灌`, { cr, crMd: 'unassigned', backlog: bv.value, input: version });
  }
  // ③ cr.md 同源重读 + 语义复核（B-SDD-02：与 guard 首次采样同一 authority 路径）
  const rel = `change-requests/${cr}/cr.md`;
  let beforeRaw;
  try { beforeRaw = fs.readFileSync(path.join(txws, rel), 'utf8'); }
  catch { throw new TxError('WRITEBACK_VERSION_INVALID', `${cr} cr.md 不可读，无法回灌`, { crMdReason: 'missing' }); }
  const before = beforeRaw.replaceAll('\r\n', '\n');
  const rvRead = readCrMdTargetVersion(txws, cr);
  if (!rvRead.ok) throw new TxError('WRITEBACK_VERSION_INVALID', `${cr} cr.md target-version 读取失败`, { crMdReason: rvRead.reason });
  const rv = normalizeTargetVersion(rvRead.raw);
  if (!rv.ok) throw new TxError('WRITEBACK_VERSION_INVALID', `${cr} cr.md target-version 规范化失败`, { crMdReason: rv.reason });
  let crMdEntry = null;
  let crMdBase = null;
  if (rv.value === version) {
    // 两次采样间漂移但已到达目标版本（幂等）：cr.md 不再成条目；baseline 仍记录复核文本供 §4.5 合成
    if (stage === 'baseline') crMdBase = { text: before, sha256: sha256(beforeRaw) };
  } else if (rv.value !== 'unassigned') {
    // guard 首次读为 unassigned、本次已是另一真实版本：版本事实在两次采样间漂移，拒绝，零写入
    throw new TxError('WRITEBACK_VERSION_MISMATCH', `cr.md 版本在 guard 采样与回灌计划之间漂移：guard 读 unassigned，现为 ${rv.value}（输入 ${version}），拒绝零写入`, { cr, crMd: rv.value, input: version });
  } else {
    // 语义复核通过：值仍为 unassigned（字节漂移不影响版本事实；beforeSha256 锚定本次复核文本，
    // applyWriteSet 预检以 hash 分类发现此后任何漂移——末段 CAS）
    if (stage === 'baseline') {
      crMdBase = { text: before, sha256: sha256(beforeRaw) }; // cr.md 侧并入 statusTransition（§4.5），不单独成条目
    } else {
      const after = applyTargetVersionToCrMd(before, version);
      crMdEntry = { path: rel, beforeSha256: sha256(beforeRaw), afterSha256: sha256(after), afterText: after };
    }
  }
  return { inputVersion: version, crMd: crMdEntry, backlog: backlogEntry, crMdBase };
}

async function applyWritebackAtomic(ctx, input) {
  const { cr, stage, specId } = input;
  // FR-14（CR-2026-057）：版本守卫最先执行——先于 traceability complete-replay 分支、
  // resolveOperationalWorkspace、prepareWritebackCandidate 与 loadOrCreateJournal（版本错误优先于
  // WRITEBACK_STATE_MISMATCH，失败路径零 candidate/journal/authority 痕迹）。
  // B-SDD-002：守卫通过后回灌规范化值——canonicalWritebackBusinessInput/businessInputDigest/manifest/
  // generator --version 全部消费规范化串；既有 startsWith('v') 剥离降为防御性 no-op。
  const versionGuard = guardWritebackVersion(ctx, cr, input.targetVersion);
  input.targetVersion = versionGuard.value;
  // CR-2026-049 TASK-02（TD-B2）：complete replay 前置——在 operational workspace 解析与 candidate 读取之前，
  // 先查 {cr}-traceability writeback journal；phase=complete && traceOutbox.state=pending 时仅用 journal intent 补发，
  // 不要求 txws/candidate 仍存在。
  if (stage === 'traceability') {
    const traceKey = `${cr}-traceability`;
    const done = loadExistingJournal({ root: ctx.installRoot, op: 'writeback', key: traceKey });
    const wb = done?.journal?.writeback;
    if (wb && wb.phase === 'complete' && wb.traceOutbox && wb.traceOutbox.state === 'pending') {
      const intent = wb.traceOutbox;
      if (!intent.commit || !intent.dedupName || intent.payload === undefined || typeof intent.payloadSha256 !== 'string') {
        throw new TxError('TX_JOURNAL_INVALID', `${traceKey} journal traceOutbox 意图不完整（缺 commit/dedupName/payload/payloadSha256）`, { txId: done.journal.txId });
      }
      if (sha256(JSON.stringify(intent.payload)) !== intent.payloadSha256) {
        throw new TxError('TX_JOURNAL_INVALID', `${traceKey} journal traceOutbox payload digest 漂移`, { txId: done.journal.txId });
      }
      let name = null;
      try {
        if (typeof input.emitTraceEvent !== 'function') throw new Error('emitTraceEvent callback missing');
        name = input.emitTraceEvent({ cr, commit: intent.commit, dedupName: intent.dedupName, payload: intent.payload });
      } catch { name = null; }
      if (name) {
        wb.traceOutbox = { ...intent, state: 'emitted' };
        await saveJournal({ path: done.journalPath, journal: done.journal });
        return {
          cr, txId: done.journal.txId, phase: 'complete', changed: false, replayedTrace: true,
          commit: wb.commit, files: (wb.files || []).map((f) => f.path), warnings: [],
          recoverCommand: `crctl writeback-apply ${cr} --stage traceability --spec-id ${JSON.stringify(specId)} --target-version ${JSON.stringify(input.targetVersion || '')} --milestone-file ${JSON.stringify(input.milestoneFile || '')} --workspace ${JSON.stringify(input.workspace || ctx.installRoot)}`,
        };
      }
      return {
        cr, txId: done.journal.txId, phase: 'complete', changed: false, replayedTrace: false,
        commit: wb.commit, files: (wb.files || []).map((f) => f.path),
        warnings: [{ code: 'EMIT_FAILED', event_kind: 'trace', message: 'trace pending 补发失败，journal 保持 pending（archive 前置门将再次补发）' }],
        recoverCommand: `crctl writeback-apply ${cr} --stage traceability --spec-id ${JSON.stringify(specId)} --target-version ${JSON.stringify(input.targetVersion || '')} --milestone-file ${JSON.stringify(input.milestoneFile || '')} --workspace ${JSON.stringify(input.workspace || ctx.installRoot)}`,
      };
    }
  }
  const opWs = resolveOperationalWorkspace(ctx, cr);
  if (opWs.source !== 'transaction-workspace') {
    throw new TxError('WRITEBACK_STATE_MISMATCH', `writeback-apply 需要 finalize 后 authority（Transaction Workspace），当前 phase=${opWs.phase}（source=${opWs.source}）`, { cr, phase: opWs.phase });
  }
  const txws = opWs.path;
  // CR-2026-058 第 5.5 步（B-SDD-02）：守卫采样的版本权威必须与将被写入的 operational workspace 同源同路径。
  // 不一致 → 复用既有 WRITEBACK_STATE_MISMATCH（extra 保持既有 {cr, phase} 形状，证据进 message），
  // 该检查先于 business/candidate/journal/lock，失败零写入（不新增公开错误码——B-SDD-04）。
  if (versionGuard.authority.source !== 'transaction-workspace' || versionGuard.authority.path !== opWs.path) {
    throw new TxError('WRITEBACK_STATE_MISMATCH', `writeback 版本守卫采样的 authority 与操作工作区不同源：guardSource=${versionGuard.authority.source} guardPath=${versionGuard.authority.path} opPath=${opWs.path}`, { cr, phase: opWs.phase });
  }
  // CR-2026-058 第 7 步：回灌计划（FR-2.1 时序——同源绑定/backlog 预检/语义复核在 candidate 生成与 journal 创建之前）。
  // found 重试（journal 已存在）时本步重算的 refillPlan 仅作纯读 fail-fast（零写入），不落入 payload——
  // payload.versionRefill 一旦落盘即冻结（B-SDD-01，见第 9 步）。
  let refillPlan = null;
  if (versionGuard.refill) {
    refillPlan = planVersionRefill({ txws, authority: versionGuard.authority, cr, stage, version: versionGuard.value });
  }
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
      statusTransition: null, outboxEmitted: false, auditEmitted: false, traceOutbox: null,
    };
    journal.writeback = payload;
    const wasComplete = payload.phase === 'complete';
    let did = false;
    const warnings = [];
    const save = async (phase) => {
      payload.phase = phase; journal.phase = phase;
      journal = await saveJournal({ path: journalPath, journal });
    };
    const assertGraph = () => {
      if ((payload.committed || payload.pushed) && journal.graphDigest !== ctx.graphDigest) {
        throw new TxError('GRAPH_CHANGED_DURING_TRANSACTION', 'writeback 事务出现 commit/push 后 dir-graph 声明发生变化，拒绝继续', {
          journalDigest: journal.graphDigest, currentDigest: ctx.graphDigest,
        });
      }
    };
    if (created) {
      // 第 11 步：payload.versionRefill 完整持久化（含 path/beforeSha256/afterSha256/afterText），
      // 随 save('start') 落盘即冻结（B-SDD-01：found 重试禁止重算/覆写）。
      if (refillPlan) {
        payload.versionRefill = {
          inputVersion: refillPlan.inputVersion,
          crMd: refillPlan.crMd ? { path: refillPlan.crMd.path, beforeSha256: refillPlan.crMd.beforeSha256, afterSha256: refillPlan.crMd.afterSha256, afterText: refillPlan.crMd.afterText } : null,
          backlog: refillPlan.backlog ? { path: refillPlan.backlog.path, beforeSha256: refillPlan.backlog.beforeSha256, afterSha256: refillPlan.backlog.afterSha256, afterText: refillPlan.backlog.afterText } : null,
        };
      }
      await save('start');
      faultPoint('writeback-after-journal-create', { cr, stage });
    }
    if (payload.businessInputDigest !== business.digest || payload.manifestDigest !== manifestDigest) {
      throw new TxError('TX_INPUT_CONFLICT', `writeback/${key} payload digest 漂移`, { txId: journal.txId });
    }
    // CR-2026-058 第 9 步恢复协议（B-SDD-01 冻结）：found 重试保留首次 payload，禁止重算/覆写 versionRefill。
    if (!created) {
      if (versionGuard.refill && !payload.versionRefill) {
        // 防御：guard 仍 refill=true 但 payload 无 versionRefill（只可能来自部署前旧守卫创建的在途 journal，
        // 其 write-set 从未含回灌条目）→ 硬阻断、零写入，人工处置。
        throw new TxError('TX_INPUT_CONFLICT', `writeback/${key} guard 仍 refill=true 但 payload 无 versionRefill（旧守卫在途 journal，不可恢复）`, { txId: journal.txId });
      }
      if (!versionGuard.refill && payload.versionRefill && payload.versionRefill.inputVersion !== versionGuard.value) {
        throw new TxError('TX_INPUT_CONFLICT', `writeback/${key} payload.versionRefill.inputVersion=${payload.versionRefill.inputVersion} 与 guard.value=${versionGuard.value} 不一致（恢复协议硬阻断）`, { txId: journal.txId });
      }
    }
    assertGraph();
    await recoverWriteSet({ txRoot: ctx.installRoot, txId: journal.txId });

    if (stage === 'baseline' && !payload.statusTransition) {
      if (!advanceCandidate) {
        if (typeof input.validateBaselineAdvance !== 'function') throw new TxError('WRITEBACK_CALLBACK_MISSING', 'baseline 恢复缺 validateBaselineAdvance callback');
        advanceCandidate = await input.validateBaselineAdvance({ workspace: txws, plannedExisting: snapshot.plannedExisting });
      }
      // CR-2026-058 §4.5：baseline cr.md 单条目合成——回灌分支（payload.versionRefill 存在且本块未被持久化跳过）
      // 以 plan 语义复核文本为底本（B-SDD-02 绑定：复核文本即 applyWriteSet 的 before 锚点），
      // status + target-version 合成在同一条 afterText；非回灌分支与今日行为完全一致。
      // advanceCandidate 回调仍被执行（gate 检查副作用保留，validateBaselineAdvance 零改动）；
      // 若 advanceCandidate.beforeText 与复核文本不一致（两次读取间漂移），applyWriteSet 预检按 hash 分类
      // 必得 TX_RECOVERY_CONFLICT（第三值），零账本写入，不存在对漂移后真实版本的覆盖。
      let afterText;
      let beforeSha256;
      if (payload.versionRefill && refillPlan && refillPlan.crMdBase) {
        afterText = crMdStatusText(refillPlan.crMdBase.text, 'writing-back', { at: journal.createdAt });
        if (afterText) afterText = applyTargetVersionToCrMd(afterText, payload.versionRefill.inputVersion);
        beforeSha256 = refillPlan.crMdBase.sha256;
      } else {
        afterText = crMdStatusText(advanceCandidate.beforeText, 'writing-back', { at: journal.createdAt });
        beforeSha256 = advanceCandidate.beforeSha256;
      }
      if (!afterText) throw new TxError('WRITEBACK_STATUS_INVALID', 'baseline cr.md 无合法 frontmatter');
      payload.statusTransition = {
        from: 'merging', to: 'writing-back', trigger: 'writeback-prd-sdd', path: advanceCandidate.path,
        transitionAt: journal.createdAt, beforeSha256,
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
      // CR-2026-058 第 13 步：versionRefill 条目合成——只依赖 payload，不依赖瞬时 refillPlan（B-SDD-01）。
      // cr.md 全局恰好一条 write-set 记录：baseline = statusTransition 条目（afterText 已含版本行），
      // tasks/traceability = payload.versionRefill.crMd 条目（statusTransition=null），二者互斥。
      if (payload.versionRefill?.backlog) entries.push({
        path: payload.versionRefill.backlog.path,
        beforeSha256: payload.versionRefill.backlog.beforeSha256,
        afterSha256: payload.versionRefill.backlog.afterSha256,
        content: payload.versionRefill.backlog.afterText,
      });
      if (payload.versionRefill?.crMd) entries.push({
        path: payload.versionRefill.crMd.path,
        beforeSha256: payload.versionRefill.crMd.beforeSha256,
        afterSha256: payload.versionRefill.crMd.afterSha256,
        content: payload.versionRefill.crMd.afterText,
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
      assertGraph();
      gitMust(kb.rootPath, ['fetch', 'origin']);
      originSha = gitMust(kb.rootPath, ['rev-parse', `refs/remotes/origin/${kb.trunk}`]);
      const confirmed = gitRun(kb.rootPath, ['merge-base', '--is-ancestor', payload.commit, originSha]).status === 0;
      if (!confirmed && originSha !== payload.baseSha) {
        gitMust(txws, ['reset', '--hard', originSha]);
        gitMust(txws, ['checkout', '--detach', originSha]);
        fs.rmSync(path.dirname(journalPath), { recursive: true, force: true });
        throw new TxError('WRITEBACK_REMOTE_STALE', 'origin 在未发布 commit 后前进，txws 已重置且旧 journal 已清除，请同业务命令重试', { cr, originSha });
      }
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

    // CR-2026-049 TASK-02（TD-B2）：traceability 阶段 push 确认后，先把完整 canonical payload 持久化为
    // journal traceOutbox intent，再经 emitTraceEvent 写 outbox；失败只记 warning，保持 pending（补发输入不依赖 txws）。
    if (stage === 'traceability') {
      if (!payload.traceOutbox || payload.traceOutbox.state === 'pending') {
        const eventPayload = snapshot.event?.payload;
        if (!eventPayload || !snapshot.event?.payloadSha256) {
          throw new TxError('WRITEBACK_MANIFEST_INVALID', 'traceability v2 manifest 缺 event payload（无法建立 trace intent）');
        }
        payload.traceOutbox = {
          state: 'pending', commit: payload.commit,
          dedupName: `trace-${cr}-${payload.commit}.json`,
          payload: eventPayload, payloadSha256: snapshot.event.payloadSha256,
        };
        await save('pushed');
        faultPoint('writeback-after-trace-intent', { cr, stage });
        let name = null;
        try {
          if (typeof input.emitTraceEvent !== 'function') throw new Error('emitTraceEvent callback missing');
          name = input.emitTraceEvent({ cr, commit: payload.commit, dedupName: payload.traceOutbox.dedupName, payload: eventPayload });
          faultPoint('writeback-after-trace-outbox', { cr, stage });
        } catch (e) { if (e instanceof TxError && e.code === 'FAULT_INJECTED') throw e; name = null; }
        if (name) {
          payload.traceOutbox.state = 'emitted';
          await save('pushed');
        } else {
          warnings.push({ code: 'EMIT_FAILED', event_kind: 'trace', message: 'trace outbox 写入失败，journal 保持 pending' });
        }
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
/** archive 候选校验（CR-2026-054 TASK-02，SDD §2.2/§3.2）：严格解析 + 根形状 + 跨文件不变量。
 * 文件私有，不导出测试接口；任一普通错误规范为有限诊断后抛 TxError('ARCHIVE_YAML_INVALID')，
 * 详情字段：file / category / line / 适用时 cr / key / firstLine。纯“缺失”不变量返回 line: null。 */
const ARCHIVE_FINAL_STATUSES = new Set(['archived', 'rejected', 'withdrawn']);
const ENTRY_ID_RE = /^([ \t]*)- id:[ \t]*["']?([^\s"']+)["']?[ \t]*$/;

function archiveDiag(file, category, line, extra = {}) {
  throw new TxError('ARCHIVE_YAML_INVALID', `archive 候选校验失败：${file} ${category}${line != null ? ` @line ${line}` : ''}`, { file, category, line, ...extra });
}

function strictParseCandidate(text, file) {
  const norm = text.replaceAll('\r\n', '\n');
  try {
    return parseYaml(norm, { strict: true });
  } catch (e) {
    if (e && typeof e.category === 'string') {
      archiveDiag(file, e.category, e.line, {
        ...(e.firstLine != null ? { firstLine: e.firstLine } : {}),
        ...(e.key != null ? { key: e.key } : {}),
      });
    }
    // 解析器非诊断错误（不应发生）：硬失败，不静默降级（纪律 #1）
    throw new TxError('ARCHIVE_YAML_INVALID', `archive 候选解析失败：${file} ${e && e.message}`, { file, category: 'invalid-shape', line: null });
  }
}

// rootShapeCheck validates the archive-specific root field. Only the backlog
// permits a null empty value; history and index must contain arrays.
function rootShapeCheck(doc, file, key, text, allowNull = false) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    archiveDiag(file, 'invalid-shape', 1, {});
  }
  const v = doc[key];
  if (!Array.isArray(v) && !(allowNull && v === null)) {
    const lines = text.replaceAll('\r\n', '\n').split('\n');
    const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}:`));
    archiveDiag(file, 'invalid-shape', idx === -1 ? 1 : idx + 1, { key });
  }
}

function parseCrMdCandidate(text, file) {
  const norm = text.replaceAll('\r\n', '\n');
  const fm = matchFrontmatter(norm);
  if (!fm) archiveDiag(file, 'invalid-shape', null, {});
  const offset = norm.slice(0, norm.indexOf(fm.match)).split('\n').length; // body 首行对应的完整文件行号偏移
  try {
    const doc = parseYaml(fm.body, { strict: true });
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      archiveDiag(file, 'invalid-shape', offset + 1, {});
    }
    return { doc, norm, offset };
  } catch (e) {
    if (e && typeof e.category === 'string') {
      archiveDiag(file, e.category, offset + e.line, {
        ...(e.firstLine != null ? { firstLine: e.firstLine } : {}),
        ...(e.key != null ? { key: e.key } : {}),
      });
    }
    throw new TxError('ARCHIVE_YAML_INVALID', `cr.md frontmatter 解析失败：${e && e.message}`, { file, category: 'invalid-shape', line: null });
  }
}

function entryLinesOf(text, cr) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ENTRY_ID_RE);
    if (m && m[2] === cr) hits.push(i + 1);
  }
  return hits;
}

function fieldLineInEntry(text, cr, field) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  let entryIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const em = lines[i].match(ENTRY_ID_RE);
    if (em) {
      if (entryIndent != null && em[1].length <= entryIndent) return null; // 条目已结束
      if (em[2] === cr) { entryIndent = em[1].length; continue; }
    }
    if (entryIndent != null) {
      const fm = lines[i].match(new RegExp(`^([ \\t]*)${field}:[ \\t]*(\\S+)[ \\t]*$`));
      if (fm) return { line: i + 1, value: fm[2] };
    }
  }
  return null;
}

function validateArchiveCandidates({ cr, finalStatus, candidates }) {
  const { backlog, history, index, crMd } = candidates;
  // 1) 严格解析（语法/缩进/重复键/未消费行诊断）
  const b = strictParseCandidate(backlog, '_backlog.yml');
  const h = strictParseCandidate(history, '_history.yml');
  const i = strictParseCandidate(index, '_index.yml');
  const c = parseCrMdCandidate(crMd, 'cr.md');
  // 2) 根形状
  rootShapeCheck(b, '_backlog.yml', 'change-requests', backlog, true);
  rootShapeCheck(h, '_history.yml', 'history', history);
  rootShapeCheck(i, '_index.yml', 'change-requests', index);
  // 3) 跨文件不变量
  const inBacklog = entryLinesOf(backlog, cr);
  if (inBacklog.length > 0) archiveDiag('_backlog.yml', 'archive-invariant', inBacklog[0], { cr });
  const inHistory = entryLinesOf(history, cr);
  if (inHistory.length === 0) archiveDiag('_history.yml', 'archive-invariant', null, { cr });
  if (inHistory.length > 1) archiveDiag('_history.yml', 'archive-invariant', inHistory[1], { cr });
  // history 全局唯一 + 合法终态
  {
    const lines = history.replaceAll('\r\n', '\n').split('\n');
    const seen = new Map();
    for (let n = 0; n < lines.length; n++) {
      const em = lines[n].match(ENTRY_ID_RE);
      if (em) {
        if (seen.has(em[2])) archiveDiag('_history.yml', 'archive-invariant', n + 1, { key: em[2], cr: em[2] });
        seen.set(em[2], n + 1);
      }
      const fm = lines[n].match(/^([ \t]*)final-status:[ \t]*(\S+)[ \t]*$/);
      if (fm && !ARCHIVE_FINAL_STATUSES.has(fm[2])) {
        archiveDiag('_history.yml', 'archive-invariant', n + 1, { cr, key: 'final-status' });
      }
    }
  }
  const inIndex = entryLinesOf(index, cr);
  if (inIndex.length === 0) archiveDiag('_index.yml', 'archive-invariant', null, { cr });
  if (inIndex.length > 1) archiveDiag('_index.yml', 'archive-invariant', inIndex[1], { cr });
  {
    const st = fieldLineInEntry(index, cr, 'status');
    if (!st) archiveDiag('_index.yml', 'archive-invariant', null, { cr, key: 'status' });
    if (st.value !== finalStatus) archiveDiag('_index.yml', 'archive-invariant', st.line, { cr, key: 'status' });
  }
  // cr.md frontmatter：目标 status 恰好 1 次且等于 finalStatus
  {
    const st = fmBodyLines(crMd);
    if (st.length === 0) archiveDiag('cr.md', 'archive-invariant', null, { cr, key: 'status' });
    if (st.length > 1) archiveDiag('cr.md', 'archive-invariant', st[1].no, { cr, key: 'status' });
    if (st[0].value !== finalStatus) archiveDiag('cr.md', 'archive-invariant', st[0].no, { cr, key: 'status' });
  }
}

function fmBodyLines(text) {
  const norm = text.replaceAll('\r\n', '\n');
  const fm = matchFrontmatter(norm);
  if (!fm) return [];
  const offset = norm.slice(0, norm.indexOf(fm.match)).split('\n').length;
  const hits = [];
  const body = fm.body.split('\n');
  for (let n = 0; n < body.length; n++) {
    if (/^status:[ \t]*\S+/.test(body[n])) hits.push({ no: offset + n + 1, value: body[n].match(/^status:[ \t]*(\S+)/)[1] });
  }
  return hits;
}

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
    // pre-authority 证据门（CR-2026-041 FR-04）：只读分流，journal 创建前校验，失败零 journal/authority 写入。
    // 先 loadExistingJournal（只读）判 needsEvidence；已 commit/push 或 cleanup-pending/complete 的恢复路径跳过。
    const existing = loadExistingJournal({ root: ctx.installRoot, op: 'archive', cr, key: cr, inputDigest: sha256(cr + '|' + (specId || '')) });
    const p0 = existing?.journal?.archive;
    const needsEvidence = !existing
      || !(p0 && (p0.committed || p0.pushed || p0.phase === 'cleanup-pending' || p0.phase === 'complete'));
    if (needsEvidence) {
      const opWs0 = resolveOperationalWorkspace(ctx, cr); // 只读
      if (opWs0.phase === 'writing-back') {
        if (!specId) throw new TxError('ARCHIVE_SPEC_REQUIRED', 'archive writing-back 路径需要 --spec-id（writeback-spec-id 入账）', { cr });
        runFixedEvidenceValidator({ editRoot: opWs0.path, cr, specId });
        // CR-2026-049 TASK-03（TD-B2）：trace pending 前置门——在 archive journal 创建、authority commit、
        // 任何 cleanup 之前读 writeback traceability journal：emitted 放行；pending 用 replayTraceEvent 补发，
        // 成功持久化后放行；仍失败 ARCHIVE_TRACE_PENDING 零写入保留现场；缺失/意图不完整 ARCHIVE_TRACE_FACT_MISSING。
        await archiveTraceGate(ctx, cr, input);
      }
      // rejected/withdrawn：无 writing-back milestone，跳过证据门与 trace 门
    }
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
      validateArchiveCandidates({ cr, finalStatus, candidates: { backlog: edits.newBacklog, history: edits.newHistory, index: edits.newIndex, crMd: nextCrMd } });
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
 * 分类（CR-2026-044 FR-11）：developing 及之前阶段与零 publish 的 code-approved = safe；
 *       code-reviewing = requiresReapproval（重跑 review-code）；
 *       merging/writing-back/部分 publish/authority unknown = blocksUpgrade（保守）。
 * 本命令为临时工具：全部安装完成协议切换且无旧事务后，随 dispatch/help/tests 整体删除
 * （CUSTOM-TODO-009 删除条件）。
 */

const UPGRADE_SAFE_STATUSES = new Set(['drafting', 'requirement-reviewing', 'requirement-approved', 'tech-designing', 'tech-design-review-pending', 'tech-design-reviewed', 'task-breakdown', 'developing']);
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
    if (status === 'code-reviewing') {
      // CR-2026-044 FR-11/AC-21：本地化 verifier 激活后须重跑 review-code 重建本地 snapshot
      requiresReapproval.push({ cr, status, why: 'code-reviewing-rereview', detail: '重跑 review-code 重建本地 release snapshot 后再审批' });
      continue;
    }
    if (status === 'code-approved') {
      // 旧 code-approved：查 merge journal 是否已有发布事实
      const ms = mergeStatus(ctx, cr);
      const published = (ms.repos || []).some((r) => r.pushed) || ms.finalizePushed;
      if (published) {
        blocksUpgrade.push({ cr, status, why: 'partial-publish', detail: `merge journal phase=${ms.phase} 已有 publish，切协议前须完成或回退`, txId: ms.txId });
      } else {
        // CR-2026-044 FR-11/AC-22：零 publish 且本地 snapshot 一致时无需重审批，checkpoint 后 merge
        safe.push({ cr, status, note: '旧协议 code-approved 零 publish：本地 snapshot 一致时 checkpoint 后 merge，无需重新审批' });
      }
      continue;
    }
    // 未知状态：保守阻断
    blocksUpgrade.push({ cr, status, why: 'unknown-status', detail: '非预期 status，保守阻断' });
  }
  return { safe, requiresReapproval, blocksUpgrade, canActivate: blocksUpgrade.length === 0 };
}

/* ────────────────────────── 结构化测试闭环（testCr，CR-2026-040） ──────────────────────────
 * 单一深接口：crctl.mjs cmdTest 薄接线调用 testCr；本模块承担 plan 校验、shell:false 执行、
 * 机器报告/traceability tests/review-loop 的原子写集编排。运行阶段不建 journal、不持锁、
 * 不写 authority；记录阶段复用 durable-tx journal/write-set 一次发布，技术失败与业务 block 分流。
 */

const TEST_PLAN_SCHEMA = 'cr-test-plan/v1';
const TEST_MARKER = '<!-- crctl:analysis-below -->';
const TEST_LOOP_REF = 'write-test-report';
const TEST_PLAN_FIELDS = ['repo', 'cwd', 'executable', 'args', 'timeoutSeconds'];

/** review-loop.yml 全量渲染纯函数（自 crctl.mjs 原样下沉，crctl re-import 共用，禁止两处复刻）。 */
export function renderLoopText(loopsMap) {
  const lines = ['# 由 crctl attempt 维护，请勿手工编辑', 'loops:'];
  for (const [k, v] of Object.entries(loopsMap)) {
    lines.push(`  ${k}:`);
    lines.push(`    current-cycle: ${v['current-cycle'] || 1}`);
    lines.push(`    current-attempt: ${v['current-attempt']}`);
    lines.push('    attempts:');
    for (const a of v.attempts) {
      const c = a && a.cycle ? `, cycle: ${a.cycle}` : '';
      lines.push(`      - { attempt: ${a.attempt}, at: "${a.at}", by: "${a.by}"${c} }`);
    }
  }
  return lines.join('\n') + '\n';
}

function resolveIdentity(ws) {
  const cfgPath = path.join(ws, '.crctl', 'config.json');
  try {
    const j = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (j && j.identity) return String(j.identity);
  } catch { /* fallthrough */ }
  const r = spawnSync('git', ['config', '--get', 'user.name'], { cwd: ws, encoding: 'utf8', shell: false });
  const name = (r.stdout || '').trim();
  return name || 'unknown';
}

/** write-test-report.reviewLoop.maxAttempts 唯一读取点；事实源缺失或非法时硬失败。 */
function resolveTestMaxAttempts(ctx) {
  const graphPath = path.join(ctx.installRoot, 'dir-graph.yaml');
  let cfg;
  try { cfg = parseYaml(fs.readFileSync(graphPath, 'utf8').replaceAll('\r\n', '\n')); }
  catch (e) { throw new TxError('TEST_CONFIG_INVALID', `dir-graph.yaml 无法解析: ${e.message}`, { path: graphPath }); }
  const declared = cfg && cfg.workspace && cfg.workspace.tools_package_path;
  if (typeof declared !== 'string' || !declared.trim()) {
    throw new TxError('TEST_CONFIG_INVALID', 'dir-graph.yaml#workspace.tools_package_path 缺失或非法', { path: graphPath });
  }
  let toolsRoot;
  try { toolsRoot = fs.realpathSync(path.isAbsolute(declared) ? declared : path.resolve(ctx.installRoot, declared)); }
  catch (e) { throw new TxError('TEST_CONFIG_INVALID', `Tools Root 不存在: ${declared}`, { path: declared, why: e.message }); }
  const pipelinePath = path.join(toolsRoot, 'pipeline-templates', 'code-implementation.pipeline.json');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(pipelinePath, 'utf8').replaceAll('\r\n', '\n')); }
  catch (e) { throw new TxError('TEST_CONFIG_INVALID', `code-implementation pipeline 无法解析: ${e.message}`, { path: pipelinePath }); }
  const nodes = doc && doc.nodes;
  const matches = Array.isArray(nodes) ? nodes.filter((n) => n && n.ref === TEST_LOOP_REF && n.reviewLoop) : [];
  if (matches.length !== 1 || !Number.isInteger(matches[0].reviewLoop.maxAttempts) || matches[0].reviewLoop.maxAttempts <= 0) {
    throw new TxError('TEST_CONFIG_INVALID', `${TEST_LOOP_REF}.reviewLoop.maxAttempts 缺失、重复或非法`, { path: pipelinePath });
  }
  return matches[0].reviewLoop.maxAttempts;
}

function readCrMdFrontmatterTest(ws, cr) {
  const p = path.join(ws, 'change-requests', cr, 'cr.md');
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return null; }
  const m = matchFrontmatter(text.replaceAll('\r\n', '\n'));
  if (!m) return null;
  return parseYaml(m.body);
}

function readReviewLoopData(ws, cr) {
  const p = path.join(ws, 'change-requests', cr, 'review-loop.yml');
  if (!fs.existsSync(p)) return { data: {}, loops: {} };
  let data;
  try { data = parseYaml(fs.readFileSync(p, 'utf8').replaceAll('\r\n', '\n')); }
  catch (e) { throw new TxError('TEST_REVIEW_LOOP_INVALID', `review-loop.yml 无法解析: ${e.message}`, { path: p }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !data.loops || typeof data.loops !== 'object' || Array.isArray(data.loops)) {
    throw new TxError('TEST_REVIEW_LOOP_INVALID', 'review-loop.yml#loops 必须是映射', { path: p });
  }
  for (const [key, loop] of Object.entries(data.loops)) {
    if (!loop || typeof loop !== 'object' || Array.isArray(loop)
      || !Number.isInteger(loop['current-cycle']) || loop['current-cycle'] <= 0
      || !Number.isInteger(loop['current-attempt']) || loop['current-attempt'] < 0
      || !Array.isArray(loop.attempts)) {
      throw new TxError('TEST_REVIEW_LOOP_INVALID', `review-loop.yml#loops.${key} 形状非法`, { path: p, loop: key });
    }
    for (const attempt of loop.attempts) {
      if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)
        || !Number.isInteger(attempt.attempt) || attempt.attempt <= 0
        || typeof attempt.at !== 'string' || typeof attempt.by !== 'string') {
        throw new TxError('TEST_REVIEW_LOOP_INVALID', `review-loop.yml#loops.${key}.attempts 条目非法`, { path: p, loop: key });
      }
    }
  }
  return { data, loops: data.loops };
}

function readCanonicalTestStatus(ws, cr) {
  const p = path.join(ws, 'change-requests', cr, 'test-report.md');
  if (!fs.existsSync(p)) return null;
  let fm;
  try {
    const frontmatter = matchFrontmatter(fs.readFileSync(p, 'utf8'));
    fm = frontmatter && parseYaml(frontmatter.body.replaceAll('\r\n', '\n'));
  } catch (e) { throw new TxError('TEST_REPORT_INVALID', `test-report.md 机器区无法解析: ${e.message}`, { path: p }); }
  if (!fm || fm['generated-by'] !== 'crctl-test' || !['pass', 'block'].includes(fm.status)) {
    throw new TxError('TEST_REPORT_INVALID', 'test-report.md 缺少合法 crctl-test status', { path: p });
  }
  return fm.status;
}

/** 查找 test journal；非法记录硬失败，优先恢复 incomplete，其次匹配当前 inputDigest。 */
function latestTestJournal(ws, cr, inputDigest) {
  const base = path.join(ws, '.crctl', 'transactions', 'test', cr);
  if (!fs.existsSync(base)) return null;
  const all = [];
  for (const txId of fs.readdirSync(base).sort()) {
    const journalPath = path.join(base, txId, 'journal.json');
    if (!fs.existsSync(journalPath)) throw new TxError('TX_JOURNAL_INVALID', `test journal 缺 journal.json: ${path.dirname(journalPath)}`, { path: journalPath });
    let j;
    try { j = JSON.parse(fs.readFileSync(journalPath, 'utf8').replaceAll('\r\n', '\n')); }
    catch { throw new TxError('TX_JOURNAL_INVALID', `test journal JSON 非法: ${journalPath}`, { path: journalPath }); }
    const updated = Date.parse(j && j.updatedAt);
    if (!j || j.v !== 1 || j.op !== 'test' || j.cr !== cr || j.txId !== txId
      || typeof j.phase !== 'string' || !Number.isFinite(updated)
      || typeof j.inputDigest !== 'string'
      || (j.phase !== 'init' && (!j.test || typeof j.test !== 'object' || Array.isArray(j.test)))) {
      throw new TxError('TX_JOURNAL_INVALID', `test journal envelope/payload 非法: ${journalPath}`, { path: journalPath });
    }
    all.push({ journal: j, journalPath, txDir: path.dirname(journalPath), updated });
  }
  const newer = (a, b) => b.updated - a.updated || b.journal.txId.localeCompare(a.journal.txId);
  const incomplete = all.filter((x) => x.journal.phase !== 'complete').sort(newer);
  if (incomplete.length > 1) throw new TxError('TX_JOURNAL_INVALID', `${cr} 存在多个 incomplete test journal`, { count: incomplete.length });
  if (incomplete.length === 1) return incomplete[0];
  const matching = all.filter((x) => x.journal.inputDigest === inputDigest).sort(newer);
  return matching[0] || all.sort(newer)[0] || null;
}

function auditLogTest(ws, record) {
  const dir = path.join(ws, '.crctl');
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  fs.appendFileSync(path.join(dir, 'audit.log'), JSON.stringify({ at: nowIso(), ...record }) + '\n');
}

/* ────────────────────────── 纯函数（测试 seam，不成为公共命令） ────────────────────────── */

/** cr-test-plan/v1 解析与校验（schema/字段白名单/repo/cwd containment/branch，失败零 authority 变化）。 */
export function parseTestPlan(raw, ctx, cr) {
  const norm = String(raw).replaceAll('\r\n', '\n');
  let doc;
  try { doc = JSON.parse(norm); } catch { throw new TxError('TEST_PLAN_SCHEMA_INVALID', 'test plan JSON 非法'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new TxError('TEST_PLAN_SCHEMA_INVALID', 'plan 顶层必须是对象');
  if (doc.schema !== TEST_PLAN_SCHEMA) throw new TxError('TEST_PLAN_SCHEMA_INVALID', `schema 必须是 ${TEST_PLAN_SCHEMA}`);
  if (!Array.isArray(doc.commands) || doc.commands.length === 0) throw new TxError('TEST_PLAN_SCHEMA_INVALID', 'commands 必须是非空数组');
  const commands = doc.commands.map((cmd, i) => {
    const where = `commands[${i}]`;
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) throw new TxError('TEST_PLAN_SCHEMA_INVALID', `${where} 必须是对象`);
    for (const k of Object.keys(cmd)) {
      if (!TEST_PLAN_FIELDS.includes(k)) throw new TxError('TEST_PLAN_SCHEMA_INVALID', `${where} 含禁止字段: ${k}`);
    }
    if (typeof cmd.repo !== 'string' || !cmd.repo.trim()) throw new TxError('TEST_PLAN_SCHEMA_INVALID', `${where}.repo 必须是非空字符串`);
    let repo;
    try { repo = getRepository(ctx, cmd.repo); }
    catch (e) {
      if (e instanceof TxError && e.code === 'REPO_INACTIVE') throw new TxError('TEST_REPO_INACTIVE', e.message, e.extra);
      throw new TxError('TEST_REPO_NOT_FOUND', e.message, e.extra);
    }
    const cwdRaw = cmd.cwd == null ? '.' : cmd.cwd;
    if (typeof cwdRaw !== 'string' || cwdRaw === '') throw new TxError('TEST_PLAN_SCHEMA_INVALID', `${where}.cwd 必须是非空字符串`);
    if (path.isAbsolute(cwdRaw) || path.win32.isAbsolute(cwdRaw) || path.posix.isAbsolute(cwdRaw)
      || cwdRaw.split(/[\\/]+/).includes('..')) {
      throw new TxError('TEST_CWD_ESCAPE', `${where}.cwd 不能是绝对路径或包含 .. 段: ${cwdRaw}`);
    }
    if (typeof cmd.executable !== 'string' || !cmd.executable.trim()) throw new TxError('TEST_PLAN_SCHEMA_INVALID', `${where}.executable 必须是非空字符串`);
    if (!Array.isArray(cmd.args) || cmd.args.some((a) => typeof a !== 'string')) throw new TxError('TEST_PLAN_SCHEMA_INVALID', `${where}.args 必须是字符串数组`);
    if (!Number.isInteger(cmd.timeoutSeconds) || cmd.timeoutSeconds <= 0) throw new TxError('TEST_PLAN_SCHEMA_INVALID', `${where}.timeoutSeconds 必须是正整数`);
    const wt = path.join(repo.worktreePath, cr);
    if (!fs.existsSync(wt)) throw new TxError('TEST_WORKTREE_MISSING', `repo ${cmd.repo} 的 requirement/${cr} worktree 不存在: ${wt}`, { repo: cmd.repo, worktree: wt });
    const br = gitRun(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (br.status !== 0 || br.stdout !== `requirement/${cr}`) {
      throw new TxError('TEST_WORKTREE_BRANCH', `repo ${cmd.repo} worktree 分支必须是 requirement/${cr}`, { repo: cmd.repo, branch: br.stdout });
    }
    const absoluteCwd = path.resolve(wt, cwdRaw);
    let realWt;
    let realCwd;
    try { realWt = fs.realpathSync(wt); } catch { throw new TxError('TEST_WORKTREE_MISSING', `repo ${cmd.repo} worktree realpath 失败: ${wt}`, { repo: cmd.repo }); }
    try { realCwd = fs.realpathSync(absoluteCwd); } catch { throw new TxError('TEST_CWD_ESCAPE', `${where}.cwd 不存在: ${absoluteCwd}`, { repo: cmd.repo }); }
    if (realCwd !== realWt && !realCwd.startsWith(realWt + path.sep)) {
      throw new TxError('TEST_CWD_ESCAPE', `${where}.cwd 越出 worktree: ${cwdRaw}`, { repo: cmd.repo, cwd: cwdRaw });
    }
    const relativeCwd = path.relative(realWt, realCwd);
    const cwdRel = relativeCwd ? relativeCwd.split(path.sep).join('/') : '.';
    return { repo: cmd.repo, cwd: cwdRel, absoluteCwd: realCwd, executable: cmd.executable, args: [...cmd.args], timeoutSeconds: cmd.timeoutSeconds };
  });
  return { schema: TEST_PLAN_SCHEMA, commands };
}

/** 命令集合 canonical subject + sha256（固定键序/数组顺序，不绑定临时路径/时间/owner/stdout）。 */
export function canonicalCommandSubject(plan) {
  const subject = {
    schema: TEST_PLAN_SCHEMA,
    commands: plan.commands.map(({ repo, cwd, executable, args, timeoutSeconds }) => ({
      repo, cwd: cwd || '.', executable, args, timeoutSeconds,
    })),
  };
  return { subject, digest: sha256(JSON.stringify(subject)) };
}

/** FR-16（CR-2026-057）skip 模式表（冻结，实施期不得增删；均为字面量 RegExp + i flag）。 */
const FROZEN_SKIP_PATTERNS = [
  /(^|\n)# skip\b/i,
  /(^|\n)ok \d+ # skip\b/i,
  /\bskipped:\s*[1-9]\d*/i,
  /\bSKIPPED\b/i,
  /\bno tests to run\b/i,
];

/**
 * FR-16（CR-2026-057，SDD §2.4/§4.5）log 两段提取（B-SDD-004）：
 * 先 \r\n→\n 规范化（NFR-3），定位 --- stdout --- 与 --- stderr --- 标记行各恰好 1 次；
 * 缺失/重复 → TEST_LOG_MARKER_INVALID 硬失败（禁止静默降级）；
 * stdout 域 = 两标记行之间的行；stderr 域 = --- stderr --- 之后到文件末尾。
 */
export function extractStdioSections(normalizedLogText) {
  const norm = String(normalizedLogText).replaceAll('\r\n', '\n');
  const lines = norm.split(/\r?\n/);
  const stdoutIdx = lines.findIndex((l) => l === '--- stdout ---');
  const stderrIdx = lines.findIndex((l) => l === '--- stderr ---');
  const countOf = (marker) => lines.filter((l) => l === marker).length;
  if (stdoutIdx === -1 || stderrIdx === -1) {
    throw new TxError('TEST_LOG_MARKER_INVALID', 'cmd log 缺少 --- stdout --- / --- stderr --- 标记段（禁止静默降级）');
  }
  if (countOf('--- stdout ---') !== 1 || countOf('--- stderr ---') !== 1) {
    throw new TxError('TEST_LOG_MARKER_INVALID', 'cmd log 的 --- stdout --- / --- stderr --- 标记重复（必须各恰好 1 次）');
  }
  return {
    stdout: lines.slice(stdoutIdx + 1, stderrIdx).join('\n'),
    stderr: lines.slice(stderrIdx + 1).join('\n'),
  };
}

/** shell:false 执行计划，日志落临时目录；已启动 non-zero/timeout 记业务 block 并继续，启动失败技术中止。 */
export function runTestPlan(plan, ctx, cr) {
  const tempRoot = path.join(crWorktreePath(ctx, cr), '.crctl', 'tmp', 'test', cr, `${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tempRoot, { recursive: true });
  const results = [];
  const resultFacts = [];
  let overall = 'pass';
  for (let i = 0; i < plan.commands.length; i++) {
    const cmd = plan.commands[i];
    const source = gitRun(cmd.absoluteCwd, ['rev-parse', 'HEAD']);
    if (source.status !== 0 || !/^[0-9a-f]{40,64}$/.test(source.stdout)) {
      throw new TxError('TEST_SOURCE_REVISION_INVALID', `repo ${cmd.repo} 无法解析测试源 HEAD`, { repo: cmd.repo, stderr: source.stderr });
    }
    const childEnv = { ...process.env };
    delete childEnv.CRCTL_OPERATIONAL_WORKSPACE;
    const r = spawnSync(cmd.executable, cmd.args, {
      cwd: cmd.absoluteCwd, encoding: 'utf8', shell: false, timeout: cmd.timeoutSeconds * 1000, env: childEnv,
    });
    const errCode = r.error ? r.error.code : null;
    const timedOut = errCode === 'ETIMEDOUT';
    const started = errCode == null || timedOut;
    const logRel = `change-requests/${cr}/test-evidence/cmd-${String(i + 1).padStart(2, '0')}.log`;
    const logAbs = path.join(tempRoot, `cmd-${String(i + 1).padStart(2, '0')}.log`);
    const logContent = [
      `$ ${cmd.executable} ${cmd.args.join(' ')}`,
      `(exit=${r.status == null ? 'null' : r.status})`,
      '--- stdout ---',
      r.stdout || '',
      '--- stderr ---',
      r.stderr || '',
    ].join('\n');
    fs.writeFileSync(logAbs, logContent, 'utf8');
    // FR-16（CR-2026-057）：skipped 只在 stdout/stderr 两段匹配域上计算（B-SDD-004）——
    // `$ <cmd> <args>` 与 (exit=...) 元数据行不参与；non-zero/timeout 一律 false（那是失败不是 skip）。
    const normLog = logContent.replaceAll('\r\n', '\n');
    const secs = extractStdioSections(normLog);
    const skipped = r.status === 0 && FROZEN_SKIP_PATTERNS.some((re) => re.test(secs.stdout + '\n' + secs.stderr));
    const result = {
      repo: cmd.repo,
      cwd: cmd.cwd,
      executable: cmd.executable,
      args: cmd.args,
      timeoutSeconds: cmd.timeoutSeconds,
      exitCode: r.status == null ? null : r.status,
      signal: r.signal || null,
      timedOut,
      started,
      skipped,
      log: logRel,
    };
    results.push(result);
    resultFacts.push({ sourceRevision: source.stdout, logSha256: sha256(logContent) });
    if (!started) {
      throw new TxError('TEST_EXECUTABLE_INVALID', `executable 启动失败: ${cmd.executable}${errCode ? ` (${errCode})` : ''}`, { repo: cmd.repo, executable: cmd.executable, errCode, index: i });
    }
    if (r.status !== 0 || timedOut) overall = 'block';
  }
  return { results, resultFacts, tempLogs: tempRoot, overall };
}

/** marker 分区：唯一 canonical literal（兼容旧带说明前缀），缺失/重复/未闭合硬失败，返回 marker 后内容。 */
export function parseAnalysisMarker(existingReport) {
  if (existingReport == null) return { analysisSuffix: '' };
  const text = String(existingReport);
  const prefix = '<!-- crctl:analysis-below';
  const positions = [];
  let idx = text.indexOf(prefix);
  while (idx !== -1) {
    const end = text.indexOf('-->', idx);
    if (end === -1) throw new TxError('TEST_MARKER_INVALID', 'marker 未闭合（缺少 -->）');
    positions.push({ start: idx, end: end + 3 });
    idx = text.indexOf(prefix, end);
  }
  if (positions.length !== 1) throw new TxError('TEST_MARKER_INVALID', `marker 必须恰好出现 1 次，实际 ${positions.length} 次`);
  return { analysisSuffix: text.slice(positions[0].end) };
}

/** test-report.md 机器区渲染（frontmatter + 标题，不含 marker；marker 由 testCr 拼接）。 */
export function renderTestMachineReport(input) {
  const lines = [
    '---',
    `cr: ${input.cr}`,
    `status: ${input.status}`,
    `tester: ${yamlScalarLib(input.tester)}`,
    'generated-by: crctl-test',
    `generated-at: "${input.generatedAt}"`,
    `command-digest: ${input.commandDigest}`,
    'commands:',
  ];
  for (const c of input.commands) {
    lines.push(`  - repo: ${c.repo}`);
    lines.push(`    cwd: ${yamlScalarLib(c.cwd)}`);
    lines.push(`    executable: ${yamlScalarLib(c.executable)}`);
    lines.push(`    args: [${c.args.map((a) => yamlScalarLib(a)).join(', ')}]`);
    lines.push(`    timeout-seconds: ${c.timeoutSeconds}`);
    lines.push(`    exit-code: ${c.exitCode == null ? 'null' : c.exitCode}`);
    lines.push(`    signal: ${c.signal == null ? 'null' : yamlScalarLib(c.signal)}`);
    lines.push(`    timed-out: ${c.timedOut}`);
    lines.push(`    started: ${c.started}`);
    lines.push(`    skipped: ${c.skipped}`);
    lines.push(`    log: ${yamlScalarLib(c.log)}`);
  }
  lines.push('---', '', `# 测试报告 · ${input.cr}`);
  return lines.join('\n') + '\n\n';
}

function renderTestsBlock(input) {
  return [
    'tests:',
    `  report: ${yamlScalarLib(input.reportRel)}`,
    `  status: ${input.status}`,
    `  tester: ${yamlScalarLib(input.tester)}`,
    `  owner-assigned-at: "${input.ownerAssignedAt}"`,
    `  generated-at: "${input.generatedAt}"`,
    `  command-digest: ${input.commandDigest}`,
    `  review-loop: ${input.reviewLoop}`,
  ].join('\n');
}

/** traceability.yml tests 段行级定点编辑（保留其他顶层段；重复 tests: 硬失败，缺失时追加）。 */
export function renderTestsTraceability(existing, input) {
  const block = renderTestsBlock(input);
  if (existing == null) return `cr-id: ${input.cr}\n${block}\n`;
  const norm = existing.replaceAll('\r\n', '\n');
  let doc;
  try { doc = parseYaml(norm); }
  catch (e) { throw new TxError('TRACE_SHAPE', `traceability.yml 无法解析: ${e.message}`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc['cr-id'] !== input.cr) {
    throw new TxError('TRACE_SHAPE', `traceability.yml cr-id 与 ${input.cr} 不一致，拒绝写 tests 投影`);
  }
  const lines = norm.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (/^tests\s*:/.test(lines[i])) hits.push(i);
  if (hits.length > 1) throw new TxError('TRACE_SHAPE', 'traceability.yml 出现重复顶层 tests: 段，拒绝编辑');
  if (hits.length === 1) {
    const tests = doc.tests;
    const required = ['report', 'status', 'tester', 'owner-assigned-at', 'generated-at', 'command-digest', 'review-loop'];
    if (!tests || typeof tests !== 'object' || Array.isArray(tests)
      || tests.report !== input.reportRel || required.some((key) => tests[key] == null)
      || !['pass', 'block'].includes(tests.status)) {
      throw new TxError('TRACE_SHAPE', 'traceability.yml#tests 不是可证明的既有机器投影，拒绝覆盖');
    }
  }
  const blockLines = block.split('\n');
  if (hits.length === 1) {
    const ti = hits[0];
    let te = lines.length;
    for (let i = ti + 1; i < lines.length; i++) { if (/^\S/.test(lines[i])) { te = i; break; } }
    const out = [...lines.slice(0, ti), ...blockLines, ...lines.slice(te)].join('\n');
    return out + (norm.endsWith('\n') ? '\n' : '');
  }
  return (norm.endsWith('\n') ? norm : norm + '\n') + block + '\n';
}

function buildTestResponse({ cr, status, commandDigest, attempt, results, report, traceability, reviewLoop, changed }) {
  return {
    op: 'test', cr, status, commandDigest, attempt,
    commands: results,
    report, traceability, reviewLoop,
    changed,
    recoverCommand: `node {TOOLS_ROOT}/skills/shared/crctl/scripts/crctl.mjs test ${cr} --plan <plan> --workspace <worktree>`,
  };
}

/** 结构化测试业务处理器（SDD §3.2 唯一入口）：校验→执行→原子发布机器证据/tests/review-loop。 */
export async function testCr(ctx, { cr, workspace, planPath }) {
  const fm = readCrMdFrontmatterTest(workspace, cr);
  if (!fm) throw new TxError('CR_MD_MISSING', `${cr} 的 cr.md 缺失或 frontmatter 非法`);
  if (fm.status !== 'developing') throw new TxError('TEST_STATE_INVALID', `${cr} 当前 status=${fm.status}，结构化测试仅在 developing 执行`);
  const testOwner = fm.owners && fm.owners.test;
  if (!testOwner || typeof testOwner !== 'object' || !testOwner.id || !testOwner['assigned-at']) {
    throw new TxError('TEST_OWNER_MISSING', `${cr} 的 cr.md 缺少 owners.test.id 或 owners.test.assigned-at`);
  }
  if (!planPath) throw new TxError('TEST_PLAN_NOT_FOUND', '缺少 --plan 参数');
  const planCandidate = path.isAbsolute(planPath) ? planPath : path.resolve(workspace, planPath);
  let planAbs;
  let raw;
  try {
    planAbs = fs.realpathSync(planCandidate);
    raw = fs.readFileSync(planAbs, 'utf8');
  } catch { throw new TxError('TEST_PLAN_NOT_FOUND', `test plan 不存在: ${planCandidate}`); }
  let tempRoot;
  try { tempRoot = fs.realpathSync(path.join(workspace, '.crctl', 'tmp')); }
  catch { throw new TxError('TEST_PLAN_PATH_INVALID', 'workspace/.crctl/tmp 不存在，test plan 必须位于非 authority 临时目录'); }
  if (planAbs !== tempRoot && !planAbs.startsWith(tempRoot + path.sep)) {
    throw new TxError('TEST_PLAN_PATH_INVALID', `test plan 越出 workspace/.crctl/tmp: ${planCandidate}`, { path: planCandidate, realpath: planAbs });
  }

  const plan = parseTestPlan(raw, ctx, cr);
  const { digest: commandDigest } = canonicalCommandSubject(plan);
  const maxAttempts = resolveTestMaxAttempts(ctx);
  const preLoop = readReviewLoopData(workspace, cr).loops[TEST_LOOP_REF];
  if ((preLoop && preLoop['current-attempt']) >= maxAttempts && readCanonicalTestStatus(workspace, cr) !== 'pass') {
    throw new TxError('TEST_LOOP_EXHAUSTED', `${TEST_LOOP_REF} 已达 maxAttempts=${maxAttempts}，不得继续自修复`);
  }

  // 运行阶段：不建 journal、不持锁、不写 authority；记录阶段在锁内重读 attempt/CAS 事实。
  const { results, resultFacts, tempLogs, overall } = runTestPlan(plan, ctx, cr);
  const tester = String(testOwner.id);
  const ownerAssignedAt = String(testOwner['assigned-at']);
  const resultMetadata = JSON.stringify(results.map((r, i) => ({
    repo: r.repo, cwd: r.cwd, executable: r.executable, args: r.args,
    exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, started: r.started,
    sourceRevision: resultFacts[i].sourceRevision, logSha256: resultFacts[i].logSha256,
  })));
  const inputDigest = sha256(commandDigest + resultMetadata + tester + ownerAssignedAt);
  const reportRel = `change-requests/${cr}/test-report.md`;
  const traceRel = `change-requests/${cr}/traceability.yml`;
  const loopRel = `change-requests/${cr}/review-loop.yml`;

  let lock = null;
  try {
    lock = await acquireLock({ root: workspace, scope: `test-${cr}`, op: 'test', cr });
    const loopData = readReviewLoopData(workspace, cr);
    const prevLoop = loopData.loops[TEST_LOOP_REF] || { 'current-cycle': 1, 'current-attempt': 0, attempts: [] };
    let currentAttempt = prevLoop['current-attempt'] || 0;
    let cycle = prevLoop['current-cycle'] || 1;

    // complete 匹配当前输入时幂等返回；incomplete 有 write-set 时只恢复，不重复 attempt。
    const existing = latestTestJournal(workspace, cr, inputDigest);
    if (existing && existing.journal.phase === 'complete' && existing.journal.inputDigest === inputDigest) {
      const jt = existing.journal.test;
      return buildTestResponse({ cr, status: jt.status, commandDigest: jt.commandDigest, attempt: jt.attempt, results, report: reportRel, traceability: traceRel, reviewLoop: loopRel, changed: false });
    }
    if (existing && existing.journal.phase !== 'complete') {
      if (existing.journal.inputDigest !== inputDigest) {
        throw new TxError('TX_INPUT_CONFLICT', `test/${cr} 已有在途事务且 inputDigest 不一致`, { txId: existing.journal.txId });
      }
      const manifest = path.join(existing.txDir, 'write-set.json');
      const jt = existing.journal.test;
      if (fs.existsSync(manifest)) {
        await recoverWriteSet({ txRoot: workspace, txId: existing.journal.txId });
        jt.phase = 'complete';
        existing.journal.phase = 'complete';
        await saveJournal({ path: existing.journalPath, journal: existing.journal });
        return buildTestResponse({ cr, status: jt.status, commandDigest: jt.commandDigest, attempt: jt.attempt, results, report: reportRel, traceability: traceRel, reviewLoop: loopRel, changed: true });
      }
      if (jt && currentAttempt === jt.attempt) {
        jt.phase = 'complete';
        existing.journal.phase = 'complete';
        await saveJournal({ path: existing.journalPath, journal: existing.journal });
        return buildTestResponse({ cr, status: jt.status, commandDigest: jt.commandDigest, attempt: jt.attempt, results, report: reportRel, traceability: traceRel, reviewLoop: loopRel, changed: false });
      }
    }
    if (currentAttempt >= maxAttempts) {
      if (readCanonicalTestStatus(workspace, cr) !== 'pass') {
        throw new TxError('TEST_LOOP_EXHAUSTED', `${TEST_LOOP_REF} 已达 maxAttempts=${maxAttempts}，不得继续自修复`);
      }
      cycle += 1;
      currentAttempt = 0;
    }

    // 计算全部 after 文本和 raw-byte CAS 锚点后再创建/复用 journal。
    const generatedAt = nowIso();
    const reportAbs = path.join(workspace, reportRel);
    let existingReport = null;
    try { existingReport = fs.readFileSync(reportAbs, 'utf8'); } catch { existingReport = null; }
    const { analysisSuffix } = parseAnalysisMarker(existingReport);
    const machine = renderTestMachineReport({ cr, status: overall, tester, generatedAt, commandDigest, commands: results });
    const reportAfter = machine + TEST_MARKER + analysisSuffix;

    const traceAbs = path.join(workspace, traceRel);
    let existingTrace = null;
    try { existingTrace = fs.readFileSync(traceAbs, 'utf8'); } catch { existingTrace = null; }
    const traceAfter = renderTestsTraceability(existingTrace, { cr, reportRel, status: overall, tester, ownerAssignedAt, generatedAt, commandDigest, reviewLoop: TEST_LOOP_REF });

    const nextAttempt = currentAttempt + 1;
    const by = resolveIdentity(workspace);
    const nextLoop = { 'current-cycle': cycle, 'current-attempt': nextAttempt, attempts: [...prevLoop.attempts, { attempt: nextAttempt, at: generatedAt, by, cycle }] };
    const loopAfter = renderLoopText({ ...loopData.loops, [TEST_LOOP_REF]: nextLoop });

    const loopAbs = path.join(workspace, loopRel);
    let loopBeforeText = null;
    try { loopBeforeText = fs.readFileSync(loopAbs, 'utf8'); } catch { loopBeforeText = null; }
    const rawHash = (text) => (text == null ? null : sha256(text));
    const entries = [
      { path: reportRel, beforeSha256: rawHash(existingReport), afterSha256: sha256(reportAfter), content: reportAfter },
      { path: traceRel, beforeSha256: rawHash(existingTrace), afterSha256: sha256(traceAfter), content: traceAfter },
      { path: loopRel, beforeSha256: rawHash(loopBeforeText), afterSha256: sha256(loopAfter), content: loopAfter },
    ];
    for (let i = 0; i < results.length; i++) {
      const logRel = `change-requests/${cr}/test-evidence/cmd-${String(i + 1).padStart(2, '0')}.log`;
      const logAbs = path.join(tempLogs, `cmd-${String(i + 1).padStart(2, '0')}.log`);
      let logContent;
      try { logContent = fs.readFileSync(logAbs, 'utf8'); }
      catch { throw new TxError('TEST_LOG_MISSING', `临时测试日志缺失: ${logAbs}`, { path: logAbs }); }
      const logDestAbs = path.join(workspace, logRel);
      let logBefore = null;
      try { logBefore = sha256(fs.readFileSync(logDestAbs, 'utf8')); } catch { logBefore = null; }
      entries.push({ path: logRel, beforeSha256: logBefore, afterSha256: sha256(logContent), content: logContent });
    }

    const { journal, journalPath } = await loadOrCreateJournal({
      root: workspace, op: 'test', cr, graphDigest: ctx.graphDigest, inputDigest, createAfterComplete: true,
    });
    journal.test = { targetRoot: path.resolve(workspace), commandDigest, attempt: nextAttempt, status: overall, entries: entries.map((e) => e.path) };
    journal.phase = 'prepared';
    let saved = await saveJournal({ path: journalPath, journal });
    await applyWriteSet({ root: workspace, txRoot: workspace, txId: saved.txId, entries });
    saved.test.phase = 'written';
    saved.phase = 'written';
    saved = await saveJournal({ path: journalPath, journal: saved });

    auditLogTest(workspace, { kind: 'test', cr, status: overall, attempt: nextAttempt, digest: commandDigest });
    saved.test.phase = 'complete';
    saved.phase = 'complete';
    await saveJournal({ path: journalPath, journal: saved });
    return buildTestResponse({ cr, status: overall, commandDigest, attempt: nextAttempt, results, report: reportRel, traceability: traceRel, reviewLoop: loopRel, changed: true });
  } finally {
    try { fs.rmSync(tempLogs, { recursive: true, force: true }); } finally { if (lock) await lock.release(); }
  }
}

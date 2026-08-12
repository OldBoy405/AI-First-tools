/* ────────────────────────── durable-tx.mjs（CR-2026-031 TASK-04） ──────────────────────────
 * 公共持久化原语（SDD §3.1~3.3）：journal envelope、本机目录锁、recoverable write-set。
 * 模块不理解业务 phase/Git/状态机；业务处理器在 workspace-transactions.mjs（TASK-05~09）。
 * 仅 Node 标准库；durable 写 = 同目录 temp + fsync(file) + rename + best-effort fsync(parent)。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export class TxError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/* 故障注入（TASK-01 契约）：CRCTL_FAULT_POINT 未设置 → 零行为；命中 → 抛 TxError FAULT_INJECTED。
 * FAULT_POINTS 为全仓唯一登记表（SDD §9.1）；crctl.mjs re-import 本表做入口校验。 */
export const FAULT_POINTS = [
  'ledger-cas-multi-between-rename', // crctl.mjs 旧 casWriteMulti 连续 rename 间隙（TASK-10 随该函数删除）
  'tx-apply-between-rename',         // write-set 连续 rename 间隙的崩溃窗口（TASK-04）
  'tx-apply-before-complete',        // 全部 rename 完成、complete 标记前的崩溃窗口（TASK-04）
  'register-after-allocate',         // CR-ID 分配落盘后、账本写前（TASK-05）
  'register-after-ledgers',          // 三账本 write-set 完成后、commit 前（TASK-05）
  'register-after-commit',           // registration commit 后、lease push 前（TASK-05）
  'register-after-push',             // lease push 后、worktree ensure 前（TASK-05）
  'register-between-worktrees',      // 每个 worktree ensure 落盘后、下一仓前（TASK-05）
  'merge-after-prepare',             // 每仓 prepare（merge-tree+commit-tree）落盘后、下一仓/推前（TASK-07）
  'merge-after-observation',         // 每仓 confirmed 落盘后、下一仓/推前（TASK-07）
  'merge-after-push',                // 每仓 lease push 落盘后、下一仓/observation 前（TASK-07）
  'merge-before-finalize',           // 全部 confirmed 后、finalize 写集前（TASK-07）
  'merge-after-finalize-commit',     // finalize commit 落盘后、lease push 前（TASK-07）
  'merge-after-finalize-push',       // finalize lease push 落盘后（TASK-07）
  'writeback-after-apply',           // write-set 应用落盘后、stage/commit 前（TASK-08）
  'writeback-after-commit',          // writeback commit 落盘后、lease push 前（TASK-08）
  'writeback-after-push',            // writeback lease push 落盘后（TASK-08）
  'archive-after-commit',            // archive commit 落盘后、lease push 前（TASK-09）
  'archive-after-push',              // archive lease push 落盘后、cleanup 前（TASK-09）
  'archive-during-cleanup',          // 每个清理单元落盘后、下一单元前（TASK-09）
];
export function faultPoint(point, context) {
  if (process.env.CRCTL_FAULT_POINT === point) {
    throw new TxError('FAULT_INJECTED', `确定性故障注入 point=${point}（CR-2026-031 测试专用）`, { point, ...(context || {}) });
  }
}

// 本地时区 ISO 8601（含偏移），由代码生成，不接受外部传入（治理⑩）。
// 原 crctl.mjs 同名函数原样迁入；crctl.mjs 自 TASK-04 起 re-import，不得复刻。
export function nowIso() {
  const d = new Date();
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`
  );
}

/* ────────────────────────── durable write ────────────────────────── */

function fsyncFd(fd) { try { fs.fsyncSync(fd); } catch { /* 个别平台对特定句柄不支持 fsync，文件内容已由 rename 持久化边界保护 */ } }

/** 同目录 temp + fsync(file) + rename；父目录 fsync 为 best-effort。
 * ponytail: Windows/NTFS 无目录 fsync 语义，open(dir) 后 fsync 会 EINVAL——rename 在 NTFS 上已是原子的，忽略该错误。 */
export function durableWriteFile(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text, 0, 'utf8'); fsyncFd(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);
  try {
    const dfd = fs.openSync(path.dirname(p), 'r');
    try { fsyncFd(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* 见 durableWriteFile 注释 */ }
}

function readJsonChecked(p, code, label) {
  let text;
  try { text = fs.readFileSync(p, 'utf8'); }
  catch { throw new TxError(code, `${label}不存在: ${p}`, { path: p }); }
  let obj;
  try { obj = JSON.parse(text.replaceAll('\r\n', '\n')); }
  catch { throw new TxError(code, `${label} JSON 非法: ${p}`, { path: p }); }
  return obj;
}

/* ────────────────────────── 目录锁（SDD §3.2） ────────────────────────── */

const LOCK_SCOPE_RE = /^[A-Za-z0-9:_-]+$/;
const OPS = ['register', 'workspace', 'merge', 'writeback', 'archive'];

/** PID 存活探针：同 hostname 下 process.kill(pid, 0)——无错/EPERM 视为存活，ESRCH 视为不存在。
 * 导出 _setPidProbe 仅为测试 seam（EPERM/ESRCH/PID reuse 矩阵），生产路径不得替换。 */
export let pidProbe = (pid) => process.kill(pid, 0);
export function _setPidProbe(fn) { pidProbe = fn; }

function lockDirFor(root, scope) {
  if (!LOCK_SCOPE_RE.test(scope)) throw new TxError('TX_LOCK_SCOPE_INVALID', `锁 scope 非法: ${scope}`, { scope });
  // Windows 目录名不允许 ':'，映射为 '-'（owner.json 内仍记原始 scope）
  return path.join(root, '.crctl', 'locks', scope.replaceAll(':', '-'));
}

/**
 * 原子 mkdir 目录锁。owner.json 记录 token/pid/hostname/startedAt/op/cr。
 * 竞争判定（全部保守阻断，除 ESRCH 明确死亡外无 TTL、无 force-unlock）：
 * - owner 缺失/不完整/JSON 非法 → TX_LOCK_HELD；
 * - foreign hostname → TX_LOCK_HELD（跨机器证据不足）；
 * - 同 hostname：存活探针无错或 EPERM（含 PID reuse 的无关活进程）→ TX_LOCK_HELD；ESRCH → 接管陈旧锁。
 */
export async function acquireLock({ root, scope, op, cr }) {
  if (!OPS.includes(op)) throw new TxError('TX_LOCK_OP_INVALID', `锁 op 非法: ${op}`, { op });
  const dir = lockDirFor(root, scope);
  const token = crypto.randomBytes(16).toString('hex');
  const owner = { v: 1, token, pid: process.pid, hostname: os.hostname(), startedAt: nowIso(), op, cr: cr == null ? null : cr };
  const writeOwner = () => durableWriteFile(path.join(dir, 'owner.json'), JSON.stringify(owner, null, 2));
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true }); // 父目录预创建；锁目录本身仍是原子 mkdir
    fs.mkdirSync(dir);
    writeOwner();
  } catch (e) {
    if (e && e.code !== 'EEXIST') throw new TxError('TX_LOCK_HELD', `锁获取失败（保守阻断）: ${dir}: ${e.message}`, { scope, why: e.code });
    // EEXIST：读取现有 owner 判定
    const ownerPath = path.join(dir, 'owner.json');
    let cur;
    try { cur = readJsonChecked(ownerPath, 'TX_LOCK_HELD', '现存锁 owner.json'); }
    catch (er) { throw new TxError('TX_LOCK_HELD', `锁 ${scope} 被持有（owner 不可读，保守阻断）`, { scope, why: er.message }); }
    if (!cur || typeof cur !== 'object' || !cur.token || !Number.isInteger(cur.pid) || !cur.hostname || !cur.startedAt) {
      throw new TxError('TX_LOCK_HELD', `锁 ${scope} owner.json 不完整，保守阻断`, { scope });
    }
    if (cur.hostname !== os.hostname()) {
      throw new TxError('TX_LOCK_HELD', `锁 ${scope} 由其他主机持有（${cur.hostname}），保守阻断`, { scope, holder: cur });
    }
    let alive = true;
    try { pidProbe(cur.pid); }
    catch (pe) {
      if (pe && pe.code === 'ESRCH') alive = false;
      else if (pe && pe.code === 'EPERM') alive = true; // 无权限发信号 = 进程存在
      else throw new TxError('TX_LOCK_HELD', `锁 ${scope} 存活探测异常（保守阻断）: ${pe.message}`, { scope });
    }
    if (alive) throw new TxError('TX_LOCK_HELD', `锁 ${scope} 被同机活进程持有（pid=${cur.pid}，含 PID reuse 的无关进程一律阻断）`, { scope, holder: cur });
    // ESRCH：原持有者已死，接管陈旧锁（删目录后重建；删除失败仍保守阻断）
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (re) { throw new TxError('TX_LOCK_HELD', `陈旧锁 ${scope} 清理失败（保守阻断）: ${re.message}`, { scope }); }
    try { fs.mkdirSync(dir); }
    catch (me) { throw new TxError('TX_LOCK_HELD', `锁 ${scope} 接管竞争失败（他人先重建）`, { scope, why: me.code }); }
    writeOwner();
  }
  return {
    token,
    release: async () => {
      let cur;
      try { cur = readJsonChecked(path.join(dir, 'owner.json'), 'TX_LOCK_GONE', '锁 owner.json'); }
      catch (er) {
        if (!fs.existsSync(dir)) return; // 锁已不存在：释放幂等
        throw er;
      }
      if (!cur || cur.token !== token) throw new TxError('TX_LOCK_TOKEN_MISMATCH', `锁 ${scope} 释放 token 不匹配（锁已被接管？）`, { scope });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ────────────────────────── journal envelope（SDD §3.1） ────────────────────────── */

const PAYLOAD_KEYS = ['register', 'workspace', 'merge', 'writeback', 'archive'];

const CR_OR_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

function journalDir(root, op, crOrKey) {
  if (!CR_OR_KEY_RE.test(crOrKey)) {
    throw new TxError('TX_JOURNAL_KEY_INVALID', `journal key 含非法字符（调用方应使用 sha256 派生 key）: ${crOrKey}`, { crOrKey });
  }
  return path.join(root, '.crctl', 'transactions', op, crOrKey);
}

function assertEnvelope(j, p) {
  const bad = (why) => new TxError('TX_JOURNAL_INVALID', `journal 非法（${why}）: ${p}`, { path: p });
  if (!j || typeof j !== 'object') throw bad('非对象');
  if (j.v !== 1) throw bad(`v=${j.v}`);
  for (const f of ['txId', 'op', 'phase', 'createdAt', 'updatedAt']) {
    if (typeof j[f] !== 'string' || !j[f]) throw bad(`缺字段 ${f}`);
  }
  if (!OPS.includes(j.op)) throw bad(`op=${j.op}`);
  const nonNull = PAYLOAD_KEYS.filter((k) => j[k] != null);
  if (nonNull.length > 1) throw bad(`多个 payload 非空: ${nonNull.join(',')}`);
  if (nonNull.length === 1 && nonNull[0] !== j.op) throw bad(`payload ${nonNull[0]} 与 op=${j.op} 不符`);
  if (typeof j.graphDigest !== 'string') throw bad('缺 graphDigest');
}

/**
 * 加载 {root}/.crctl/transactions/{op}/{cr-or-key}/ 下最新 journal（按 updatedAt，平手取 txId 字典序大者），
 * 无则新建空 envelope（五个 payload 均 null，业务首个 save 前必须置位 op 对应 payload）。
 * 任一已存在 journal 非法 → 硬失败（不静默跳过）。
 */
export async function loadOrCreateJournal({ root, op, cr, key, graphDigest, inputDigest }) {
  if (!OPS.includes(op)) throw new TxError('TX_JOURNAL_INVALID', `op 非法: ${op}`, { op });
  const crOrKey = cr || key;
  if (!crOrKey) throw new TxError('TX_JOURNAL_INVALID', 'loadOrCreateJournal 需要 cr 或 key');
  const base = journalDir(root, op, crOrKey);
  let latest = null;
  let latestPath = null;
  if (fs.existsSync(base)) {
    for (const txId of fs.readdirSync(base).sort()) {
      const p = path.join(base, txId, 'journal.json');
      if (!fs.existsSync(p)) continue;
      const j = readJsonChecked(p, 'TX_JOURNAL_INVALID', 'journal');
      assertEnvelope(j, p);
      if (j.op !== op) throw new TxError('TX_JOURNAL_INVALID', `journal op=${j.op} 与目录 op=${op} 不符: ${p}`, { path: p });
      if (!latest) { latest = j; latestPath = p; continue; }
      const ta = Date.parse(j.updatedAt); const tb = Date.parse(latest.updatedAt);
      if (ta > tb || (ta === tb && j.txId > latest.txId)) { latest = j; latestPath = p; }
    }
  }
  if (latest) {
    if (inputDigest != null && latest.inputDigest != null && latest.inputDigest !== inputDigest) {
      throw new TxError('TX_INPUT_CONFLICT', `${op}/${crOrKey} 已有在途事务且 inputDigest 不一致（旧=${latest.inputDigest} 新=${inputDigest}）`, { txId: latest.txId });
    }
    return { journal: latest, journalPath: latestPath, created: false };
  }
  const txId = crypto.randomUUID().replaceAll('-', '').slice(0, 32);
  const now = nowIso();
  const journal = {
    v: 1, txId, op, cr: cr == null ? null : cr, phase: 'init',
    graphDigest: graphDigest == null ? '' : graphDigest,
    inputDigest: inputDigest == null ? null : inputDigest,
    sideEffects: [], commit: null, lastError: null,
    createdAt: now, updatedAt: now,
    register: null, workspace: null, merge: null, writeback: null, archive: null,
  };
  const journalPath = path.join(base, txId, 'journal.json');
  durableWriteFile(journalPath, JSON.stringify(journal, null, 2));
  return { journal, journalPath, created: true };
}

/** durable 保存：updatedAt 由模块刷新；op 对应 payload 必须非空、其余必须为 null（SDD §3.1 不变量）。 */
export async function saveJournal({ path: journalPath, journal }) {
  const j = { ...journal, updatedAt: nowIso() };
  assertEnvelope(j, journalPath);
  if (j[j.op] == null) throw new TxError('TX_JOURNAL_INVALID', `saveJournal: op=${j.op} 对应 payload 为空`, { path: journalPath });
  durableWriteFile(journalPath, JSON.stringify(j, null, 2));
  return j;
}

/* ────────────────────────── recoverable write-set（SDD §3.3） ────────────────────────── */

function findTxDir(root, txId) {
  const txRoot = path.join(root, '.crctl', 'transactions');
  if (!fs.existsSync(txRoot)) return null;
  for (const op of fs.readdirSync(txRoot)) {
    const opDir = path.join(txRoot, op);
    let keys;
    try { keys = fs.readdirSync(opDir); } catch { continue; }
    for (const k of keys) {
      const d = path.join(opDir, k, txId);
      if (fs.existsSync(path.join(d, 'journal.json')) || fs.existsSync(path.join(d, 'write-set.json'))) return d;
    }
  }
  return null;
}

function validateEntry(root, e) {
  if (!e || typeof e !== 'object' || typeof e.path !== 'string' || !e.path) throw new TxError('TX_WRITESET_INVALID', 'write-set entry 缺 path');
  if (path.isAbsolute(e.path) || e.path.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new TxError('TX_WRITESET_INVALID', `write-set path 非法（absolute/.. /空段）: ${e.path}`);
  }
  if (typeof e.afterSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.afterSha256)) throw new TxError('TX_WRITESET_INVALID', `entry ${e.path}: afterSha256 非法`);
  if (e.beforeSha256 != null && !/^[0-9a-f]{64}$/.test(e.beforeSha256)) throw new TxError('TX_WRITESET_INVALID', `entry ${e.path}: beforeSha256 非法`);
  return path.join(root, ...e.path.split('/'));
}

const readHash = (p) => {
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return { hash: null, content: null }; }
  return { hash: sha256(text), content: text };
};

/**
 * prepare + apply 一体的 recoverable write-set。
 * entries[].content 在 blob 尚未落盘时必填（首次 apply）；恢复路径（recoverWriteSet）只依赖已落盘 blob。
 * 分类：当前 hash = after → skip；= before（null=不存在）→ 从 blob redo；其余 → TX_RECOVERY_CONFLICT，绝不覆盖第三值。
 * 全部 entry 确认后才标 complete 并清理 blob；清理失败不逆转已完成写入。
 */
export async function applyWriteSet({ root, txId, entries, txRoot = root }) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TxError('TX_WRITESET_INVALID', 'write-set 为空');
  const txDir = findTxDir(txRoot, txId);
  if (!txDir) throw new TxError('TX_NOT_FOUND', `txId ${txId} 无事务目录（须先 loadOrCreateJournal）`, { txId });
  const manifestPath = path.join(txDir, 'write-set.json');
  const blobDir = path.join(txDir, 'blobs');
  const resolved = entries.map((e) => ({ e, dst: validateEntry(root, e) }));

  // 冲突预检：任一 entry 落在第三值 → 整体中止，零写入
  const plan = [];
  for (const { e, dst } of resolved) {
    const cur = readHash(dst);
    if (cur.hash === e.afterSha256) { plan.push({ e, dst, action: 'skip' }); continue; }
    if (cur.hash === (e.beforeSha256 == null ? null : e.beforeSha256)) { plan.push({ e, dst, action: 'redo' }); continue; }
    throw new TxError('TX_RECOVERY_CONFLICT', `${e.path} 当前内容既非 before 也非 after（第三方修改，拒绝覆盖）`, { path: e.path, before: e.beforeSha256, after: e.afterSha256, actual: cur.hash });
  }
  const todo = plan.filter((p) => p.action === 'redo');
  if (todo.length === 0) {
    durableWriteFile(manifestPath, JSON.stringify({ v: 1, txId, state: 'complete', targetRoot: path.resolve(root), entries }, null, 2));
    await cleanupTxBlobs({ txRoot, txId });
    return { changed: false };
  }
  // stage blob（恢复锚点），随后 prepared manifest，再连续 rename
  for (const { e, dst } of todo) {
    const blobPath = path.join(blobDir, e.afterSha256);
    if (fs.existsSync(blobPath)) {
      if (readHash(blobPath).hash !== e.afterSha256) throw new TxError('TX_BLOB_MISMATCH', `blob 与 afterSha256 不符: ${blobPath}`, { path: e.path });
      continue;
    }
    if (typeof e.content !== 'string') throw new TxError('TX_WRITESET_INVALID', `entry ${e.path}: blob 缺失且未提供 content`, { path: e.path });
    if (sha256(e.content) !== e.afterSha256) throw new TxError('TX_BLOB_MISMATCH', `entry ${e.path}: content 哈希与 afterSha256 不符`, { path: e.path });
    durableWriteFile(blobPath, e.content);
  }
  durableWriteFile(manifestPath, JSON.stringify({
    v: 1, txId, state: 'prepared', targetRoot: path.resolve(root),
    entries: entries.map((e) => ({ path: e.path, beforeSha256: e.beforeSha256 == null ? null : e.beforeSha256, afterSha256: e.afterSha256, blob: `blobs/${e.afterSha256}` })),
  }, null, 2));
  for (let i = 0; i < todo.length; i++) {
    const { e, dst } = todo[i];
    const blobPath = path.join(blobDir, e.afterSha256);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.copyFileSync(blobPath, tmp);
    const fd = fs.openSync(tmp, 'r');
    try { fsyncFd(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, dst);
    if (i < todo.length - 1) faultPoint('tx-apply-between-rename', { path: e.path });
  }
  faultPoint('tx-apply-before-complete', { txId });
  durableWriteFile(manifestPath, JSON.stringify({ v: 1, txId, state: 'complete', targetRoot: path.resolve(root), entries: entries.map((e) => ({ path: e.path, beforeSha256: e.beforeSha256 == null ? null : e.beforeSha256, afterSha256: e.afterSha256, blob: `blobs/${e.afterSha256}` })) }, null, 2));
  await cleanupTxBlobs({ txRoot, txId });
  return { changed: true };
}

/** 只恢复指定事务；目标 root 来自首次 apply 持久化的 manifest，禁止调用方把相对路径重放到其他 checkout。 */
export async function recoverWriteSet({ txRoot, txId }) {
  const txDir = findTxDir(txRoot, txId);
  if (!txDir) return { changed: false };
  const manifestPath = path.join(txDir, 'write-set.json');
  if (!fs.existsSync(manifestPath)) return { changed: false };
  const m = readJsonChecked(manifestPath, 'TX_WRITESET_INVALID', 'write-set manifest');
  if (!m || m.v !== 1 || !Array.isArray(m.entries)
    || typeof m.targetRoot !== 'string' || !path.isAbsolute(m.targetRoot)) {
    throw new TxError('TX_WRITESET_INVALID', `write-set manifest 缺少合法 targetRoot: ${manifestPath}`, { path: manifestPath });
  }
  if (m.state === 'complete') {
    await cleanupTxBlobs({ txRoot, txId });
    return { changed: false };
  }
  if (m.state !== 'prepared') throw new TxError('TX_WRITESET_INVALID', `write-set manifest state 非法: ${m.state}`, { path: manifestPath });
  return applyWriteSet({ root: m.targetRoot, txRoot, txId: m.txId || txId, entries: m.entries });
}

/** 幂等清理：blobs/ 与残留 temp；清理失败不抛业务错误（完成态写入不可逆转）。 */
export async function cleanupTxBlobs({ txRoot, txId }) {
  const txDir = findTxDir(txRoot, txId);
  if (!txDir) return;
  try { fs.rmSync(path.join(txDir, 'blobs'), { recursive: true, force: true }); } catch { /* 幂等清理 */ }
  const manifestPath = path.join(txDir, 'write-set.json');
  try {
    const m = readJsonChecked(manifestPath, 'TX_WRITESET_INVALID', 'write-set manifest');
    if (m && m.state === 'complete') {
      for (const e of m.entries || []) {
        try {
          const dst = path.join(m.targetRoot, ...String(e.path).split('/'));
          const dir = path.dirname(dst);
          for (const f of fs.readdirSync(dir)) {
            if (f.startsWith(`${path.basename(dst)}.tmp-`)) fs.rmSync(path.join(dir, f), { force: true });
          }
        } catch { /* 幂等清理 */ }
      }
      fs.rmSync(manifestPath, { force: true });
    }
  } catch { /* 幂等清理 */ }
}

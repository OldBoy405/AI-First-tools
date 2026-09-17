// FR-2 summary 投影层（CR-2026-069 TASK-08，SDD §3.1 / §4.6 / §4.8）。
//
// 唯一改动面是成功出口 ok(obj)：本模块导出「每命令一个纯函数」的投影器 + 注册表 + 解析函数。
//   - `SUMMARY_PROJECTORS` 的键集 = TASK-01 baseline 的 A8 最小命令集合（`crctl advance` /
//     `crctl review-record` / `crctl status` / `crctl workspace inspect`），由 `cr-cost.mjs
//     verify-selection` 与 `cmd-05` 的活体比对逐项核对，不一致即非零退出。
//   - 投影器只读入参、不读全局状态、不访问文件系统（纯函数）。
//   - 未注册命令收到 `--detail` ⇒ 与现状等价；注册命令收到 `--detail` ⇒ 走原路径（完整字段集）。

/** 去掉运行时噪声字段，保留调用方实际消费的字段。 */
const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
};

/** `crctl status`：保留决策字段与权威来源指针，去掉 owner 三角色副本（`cr.md` 是 owner 的事实源）。 */
export function projectStatus(obj) {
  return pick(obj, ['cr', 'status', 'source', 'legalNext', 'reviewLoops', 'gateBlockers', 'warnings', 'terminal', 'next', 'humanApproval', 'why']);
}

/** `crctl advance`：保留转换结果与提交结论，去掉 cr.md 写入明细与 commitDetail。 */
export function projectAdvance(obj) {
  return pick(obj, ['advanced', 'cr', 'from', 'to', 'trigger', 'files', 'commit', 'committed', 'outbox']);
}

/** `crctl review-record`：保留判定 / 落盘文件 / attempt / 路由，去掉 trace 路径副本。 */
export function projectReviewRecord(obj) {
  return pick(obj, ['op', 'cr', 'stage', 'file', 'files', 'verdict', 'attempt', 'route', 'repairTarget']);
}

/** `crctl workspace inspect`：保留 worktree 发现面与 authority 诊断，去掉 txId 与逐仓分支探针明细。 */
export function projectWorkspaceInspect(obj) {
  const out = pick(obj, ['op', 'cr', 'resources', 'changed', 'operationalWorkspace', 'operationalWorkspaceError']);
  if (Array.isArray(out.resources)) {
    out.resources = out.resources.map((r) => pick(r, ['repo', 'branch', 'worktreePath', 'classification', 'dirty']));
  }
  return out;
}

export const SUMMARY_PROJECTORS = {
  'crctl advance': projectAdvance,
  'crctl review-record': projectReviewRecord,
  'crctl status': projectStatus,
  'crctl workspace inspect': projectWorkspaceInspect,
};

const TWO_WORD = new Set(['workspace', 'task', 'merge']);

/** 命令的规范形态（与 FR-8 baseline 的 crctl 命令聚合口径一致）。 */
export function canonicalCommand(cmd, positional) {
  const sub = Array.isArray(positional) && positional.length > 0 ? positional[0] : null;
  if (TWO_WORD.has(cmd) && sub) return 'crctl ' + cmd + ' ' + sub;
  return 'crctl ' + cmd;
}

/** 当前进程的投影函数（模块级可变状态；作用域严格限于一次 CLI 执行，无并发写者，D-9）。 */
let ACTIVE_PROJECTION = null;

/** main() 在 dispatch 前一次性设定；未设定 ⇒ 恒等（未注册命令与 `--detail` 均逐字走原路径）。 */
export function setActiveProjection(fn) {
  ACTIVE_PROJECTION = typeof fn === 'function' ? fn : null;
}

/** ok(obj) 的唯一消费点。 */
export function applyProjection(obj) {
  return ACTIVE_PROJECTION ? ACTIVE_PROJECTION(obj) : obj;
}

/**
 * 解析本次进程要用的投影函数（SDD §1.4.3 三分支）。
 * detail=true → null（走原路径）；未注册 → null（与现状等价）；否则该命令的纯投影函数。
 */
export function resolveProjection(cmd, positional, flags) {
  if (flags && flags.detail === true) return null;
  const key = canonicalCommand(cmd, positional);
  const fn = SUMMARY_PROJECTORS[key];
  return typeof fn === 'function' ? fn : null;
}

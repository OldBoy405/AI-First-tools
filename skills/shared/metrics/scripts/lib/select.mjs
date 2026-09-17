// A8 — summary 命令集的最小基数选择算法（CR-2026-069 TASK-01，SDD §4.8）。
//
// 本文件是「最小命令集合」算法的唯一事实源：注册表（summary-projectors.mjs）与 evidence
// 都由它派生或据它比对；PRD / Prompt / Skill / 门禁内不复刻该集合。
//
// 纯函数，零依赖。

/**
 * @param {{command: string, tokens: number, calls: number}[]} crctlCommands
 * @param {number} threshold 累计份额阈值（固定 0.8）
 * @returns {string[]} 达到阈值的最小基数集合（tokens 降序、tie-break = command 字典序的前缀）
 */
export function selectMinimalCommandSet(crctlCommands, threshold) {
  const th = typeof threshold === 'number' ? threshold : 0.8;
  const rows = (Array.isArray(crctlCommands) ? crctlCommands : [])
    .filter((x) => x && typeof x.command === 'string' && typeof x.tokens === 'number' && x.tokens > 0)
    .slice()
    .sort((a, b) => (b.tokens - a.tokens !== 0 ? b.tokens - a.tokens : a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
  const total = rows.reduce((s, x) => s + x.tokens, 0);
  if (total <= 0) return [];
  const picked = [];
  let acc = 0;
  for (const row of rows) {
    picked.push(row.command);
    acc += row.tokens;
    if (acc / total >= th) break;
  }
  return picked.sort();
}

/** 注册表 ↔ 最小集合的双向全等判据（verify-selection 与回归面共用的唯一实现）。 */
export function compareSelection(registryKeys, minimalSet) {
  const a = (Array.isArray(registryKeys) ? registryKeys : []).slice().sort();
  const b = (Array.isArray(minimalSet) ? minimalSet : []).slice().sort();
  return { registryKeys: a, minimalSet: b, equal: JSON.stringify(a) === JSON.stringify(b) };
}

/** 累计份额（供人读摘要与证据自洽核对使用）。 */
export function coverageShare(crctlCommands, commands) {
  const rows = Array.isArray(crctlCommands) ? crctlCommands : [];
  const total = rows.reduce((s, x) => s + (typeof x.tokens === 'number' ? x.tokens : 0), 0);
  if (total <= 0) return 0;
  const set = new Set(commands);
  const acc = rows.reduce((s, x) => (set.has(x.command) ? s + x.tokens : s), 0);
  return acc / total;
}

// CR-2026-065 TASK-02（FR-8 / FR-10）：outbox 事件去重比较的**单一事实源**。
//
// 产品（`crctl.mjs#emitOutboxEvent`）与测试共同 import 本模块；禁止再出现第二份
// 字段枚举或易变键的语义副本。语义零变化（FR-8）：比较面逐字段相等即视为「已发送」
// （返回文件名、不覆盖、不新增）；不等 → `OUTBOX_DEDUP_CONFLICT`。
//
// 键空间纪律：`OUTBOX_VOLATILE_PAYLOAD_KEYS` 的键名是 **payload 根下的相对键**
// （与 `buildOutboxComparable` 的 `delete payload[k]` 同一键空间）。

/** 参与去重比较的字段（顺序固定：也是投影 `JSON.stringify` 的键序）。 */
export const OUTBOX_COMPARED_FIELDS = Object.freeze([
  'v',
  'event_kind',
  'cr_id',
  'from_status',
  'to_status',
  'trigger',
  'commit_sha',
  'actor',
  'evidence',
  'payload',
]);

/** 顶层不参与比较的易变字段（每次 `nowIso()` 重新生成）。 */
export const OUTBOX_EXCLUDED_FIELDS = Object.freeze(['occurred_at']);

/** payload 根下不参与比较的易变键（枚举排除，不做「按名字/类型自动排除」）。 */
export const OUTBOX_VOLATILE_PAYLOAD_KEYS = Object.freeze(['detected_at']);

/**
 * 规范化事件对象：缺省值口径与既有 `crctl.mjs` 内联构造逐字一致，字段顺序固定。
 * @param {object} input 事件输入（可只带部分字段）
 * @param {string} nowIsoString occurred_at 取值（由调用方生成，本模块不读时钟）
 */
export function buildOutboxEvent(input, nowIsoString) {
  return {
    v: 1,
    event_kind: input.event_kind,
    cr_id: input.cr_id,
    from_status: input.from_status ?? '',
    to_status: input.to_status ?? '',
    trigger: input.trigger ?? '',
    commit_sha: input.commit_sha ?? '',
    actor: input.actor ?? '',
    evidence: input.evidence ?? {},
    payload: input.payload ?? {},
    occurred_at: nowIsoString,
  };
}

/**
 * 由三个声明驱动的投影：只保留参与比较的字段，并从 payload 中删除登记的易变键。
 * 只读：不得就地删除入参字段（payload 先拷贝）。
 */
export function buildOutboxComparable(event) {
  const out = {};
  for (const field of OUTBOX_COMPARED_FIELDS) out[field] = event[field];
  const payload = { ...(event.payload || {}) };
  for (const key of OUTBOX_VOLATILE_PAYLOAD_KEYS) delete payload[key];
  out.payload = payload;
  return out;
}

---
name: cr-archive
description: "归档终态 CR：一次调用 crctl archive 深原语完成归档与清理，Skill 只做前置确认与结果分类。"
---

# Skill: cr-archive

**类型**: 原子 Skill
**触发时机**: feature-writeback pipeline 最终步骤（`writeback-traceability` 完成后）；或 rejected/withdrawn CR 的终止归档

---

## 用途

把终态 CR（`writing-back` / `rejected` / `withdrawn`）归档。
全部事务逻辑由深原语 `crctl archive` 独占完成（CR-2026-031 TASK-09）。

本 Skill 只拥有：**前置确认、一次深原语调用、结果分类**。不写 Git 命令序列、不手写任何账本、不做清理算法。

---

## 前置条件

| 条件 | 说明 |
|------|------|
| CR 状态 | 成功回写必须为 `writing-back`；终止归档可为 `rejected` / `withdrawn` |
| 成功回写证据 | `specs/{spec_id}/traceability.yml` 已生成、tasks 全 done、approval.yml 存在（由深原语内部校验，缺一反而硬失败） |

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 要归档的 CR 标识符（如 `CR-2026-001`） |
| `spec_id` | string | writing-back 路径必填 | 回写目标 spec id（入账 `writeback-spec-id`） |

---

## 操作步骤

### Step 1 — 前置确认

`crctl status {cr_id} --workspace {knowledge-base 主 checkout}`：确认 status 属于 `writing-back` / `rejected` / `withdrawn`，否则停止。

### Step 2 — 一次深原语调用

```text
crctl archive {cr_id} [--spec-id {spec_id}] --workspace {knowledge-base 主 checkout}
```

深原语内部完成归档与清理（Skill 不重复、不干预）。

### Step 3 — 结果分类（只透传深原语 JSON，不发明第二套字段）

| 深原语输出 | 分类与动作 |
|------|------|
| exit 0，`phase=complete`，`remaining=[]` | 归档与清理全部完成。固定返回透传：`commit`（已确认 authority SHA）、`lastCleanupError`（cleanup 执行异常码或 null）、`remaining`、`preservedRefs`、`recoverCommand`、`warnings` |
| exit 0，`phase=cleanup-pending` | **终态 authority 已发布（status 已是终态），仅安全资源清理未完成**。`lastCleanupError=null` 且 `remaining` 非空 = 保守保留现场（dirty/unknown/未证明合入），不是错误；`lastCleanupError` 非空 = cleanup 执行异常。处理 `remaining` 后**只重跑 `recoverCommand` 续清理** |
| `warnings=[{code:EMIT_FAILED,event_kind:archive}]` | 实时投影事件发送失败，**不表示 Git archive 失败**——authority 已发布。重跑同一 `recoverCommand` 会补发；禁止回滚 commit、重建 commit 或手工生成事件 |
| `ARCHIVE_TASKS_PENDING` | tasks/_index.yml 仍有非 done 任务，回开发期补齐 |
| `ARCHIVE_TRACEABILITY_MISSING` | 先运行 `writeback-traceability` |
| `ARCHIVE_APPROVAL_MISSING` / `ARCHIVE_SPEC_REQUIRED` | 前置缺失，按错误信息补齐后重跑 |
| `ARCHIVE_STATE_MISMATCH` | CR 不在可归档状态，先完成对应 pipeline gate |
| `ARCHIVE_STAGED_MISMATCH` / `ARCHIVE_REMOTE_HISTORY_REWRITTEN` | 硬阻断，人工介入 |

---

## 输出

```
✅ CR {cr_id} 已归档
   final-status    : {深原语 status 字段}
   phase           : {complete | cleanup-pending}
   commit          : {已确认 authority SHA}
   lastCleanupError: {cleanup 执行异常码 | null}
   preservedRefs   : {rejected/withdrawn 保留的远端 ref 列表，archived 为空}
   remaining       : {待清理现场列表，complete 时为空}
   warnings        : {投影发送失败警告列表，通常为空}
   恢复            : 未完成时只重跑 recoverCommand: {recoverCommand}
   下一步          : 以 `crctl next {cr_id}` 为准（终态 CR 返回 next:null）
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| CR 不在终态 | 停止执行，先完成对应 gate |
| cleanup-pending | **终态已发布、仅清理未完成**。按 `remaining` 处理现场后只重跑 `recoverCommand`（唯一续跑入口），禁止手工删除未验证资源 |
| 深原语其他非零退出 | 按 Step 3 分类表处理，不做手工补偿 |

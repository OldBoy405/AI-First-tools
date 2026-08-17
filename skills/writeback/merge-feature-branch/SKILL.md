---
name: merge-feature-branch
description: feature-writeback pipeline 第 1 节点：一次调用 crctl merge 深原语完成跨仓合并，Skill 只做前置确认与结果分类，不写任何 Git 命令序列。
---

# Skill: merge-feature-branch

**类型**: 回写期 Skill（writeback/ 组，入口节点）
**调用时机**: feature-writeback pipeline 第 1 节点
**前置要求**: CR status = `code-approved`

---

## 用途

把所有参与仓的同名分支（`requirement/CR-YYYY-NNN`）合并回各自 trunk，并把 CR 推进到 `merging`。
全部由深原语 `crctl merge` 独占完成（CR-2026-031 TASK-07）。

本 Skill 只拥有：**业务前置确认、一次深原语调用、结果分类**。不写 Git 命令序列、不手写任何账本、不做补偿算法。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |

---

## 执行步骤

### Step 1 — 前置确认

1. 读取 `AGENTS.md`、`dir-graph.yaml`（只读，解析工作区布局）。
2. `crctl status {cr_id} --workspace {knowledge-base 主 checkout}`：确认 status=`code-approved`。非该状态直接停止。

### Step 2 — 一次深原语调用

```text
crctl merge {cr_id} --workspace {knowledge-base 主 checkout}
```

深原语内部完成跨仓合并（Skill 不重复、不干预）。

### Step 3 — 结果分类（只透传深原语 JSON，不发明第二套字段）

| 深原语输出 | 分类与动作 |
|------|------|
| exit 0，`phase=complete`，返回 `operational_workspace` | 合并完成。后续 writeback 节点以返回的 `operational_workspace`（detached Transaction Workspace）为唯一编辑位置 |
| `MERGE_PREPARE_CONFLICT` | 某仓冲突，零远端副作用。按提示解决该仓分支冲突后重跑本 Skill |
| `phase=release-drift`（kind=code/task） | 本地已审批 source/TASK 真实漂移且零 publish：深原语已自动走唯一回退转换 `code-approved -> developing`（输出含 `advanced`）。回到开发期修复后重新走评审/审批 |
| `MERGE_SOURCE_MISSING` / `RELEASE_REMOTE_NOT_PUSHED`（CR-2026-044） | publication lag：本地证据有效但远端 requirement ref 缺失或滞后。状态保持 `code-approved`，不回退；按 extra.recoverCommand 先 checkpoint 再重跑 merge |
| `APPROVED_ARTIFACT_DRIFT`（kind=prd/sdd） | 已审批需求/设计文档漂移，硬阻断。走需求/设计修订链路，不得手工绕过 |
| `MERGE_REMOTE_HISTORY_REWRITTEN` | 远端 trunk 历史被改写，硬阻断。人工介入核实，不得自动 force |
| 非零且 `phase` 为中间态（publish 部分完成等） | 事务已持久化：直接**重跑同一条命令**续跑（幂等恢复），禁止手工清理或补偿 |
| `MERGE_STATE_MISMATCH` / `GATE_BLOCKED` | 前置不满足，按错误信息处理后重跑 |

### Step 4 — 输出摘要

```
✅ 分支合并完成
   CR                  : {cr_id}
   operational_workspace: {深原语返回值，后续 writeback 节点唯一编辑位置}
   merge commits       : 见 {operational_workspace}/change-requests/{cr_id}/merge-commits.yml
   merge-verification  : 已由深原语落盘（change-requests/{cr_id}/merge-verification.md）
   下一步              : 以 `crctl next {cr_id}` 为准
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| CR status 非 `code-approved` | 停止执行 |
| 深原语非零退出 | 按 Step 3 分类表处理；中间态一律重跑同命令续跑，不做手工补偿 |
| 受控 shell 不可用 | 返回 `SHELL_UNAVAILABLE` 结构化错误，不输出手工 git 指令 |

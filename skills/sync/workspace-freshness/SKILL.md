---
name: workspace-freshness
description: code-implementation pipeline 的基线新鲜度 gate：只读检查各 active repo CR worktree 对 trunk 的新鲜度（fresh/behind-clean/diverged/unknown），behind-clean 时经显式同步前移，按 gate 输出 continue / synced-continue / replay / manual 路由；diverged/dirty/unknown 一律人工处理，无自动合并。
---

# Skill: workspace-freshness

**类型**: 远端同步 Skill（sync/ 组；code-implementation pipeline gate 节点的唯一调用方）
**调用时机**: code-implementation pipeline 的「实施前」与「评审前」两个 gate 节点

---

## 用途

在实施开始与代码评审开始前，判断 CR worktree 相对 trunk 的基线新鲜度，并给出唯一路由决定。本 Skill 职责收敛为“远端 trunk 新鲜度预检”（CR-2026-044 FR-08）：不参与本地业务证据门禁，fetch/sync 失败可中止当前 Pipeline 节点，但不改变 CR status、approval、review verdict 或 reviewLoop attempt。只读检查由 `crctl workspace freshness` 完成；仅当结果为可同步（behind-clean）时才调用 `crctl workspace sync` 显式同步。本 Skill 只做业务路由，不复制分类算法，不执行任何状态推进或账本编辑。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `gate` | string | ✅ | `implement-start` \| `review-start` |

---

## 执行步骤

### Step 1 — 只读新鲜度检查

```text
crctl workspace freshness {cr_id} --workspace <installation-workspace>
```

读取结构化结果：每仓 `freshness`（fresh / behind-clean / diverged / unknown）、`workspaceClassification`、SHA 事实与 `allFresh` / `syncable` 汇总。

### Step 2 — 条件显式同步（仅 syncable）

当且仅当 `syncable=true` 时执行：

```text
crctl workspace sync {cr_id} --workspace <installation-workspace>
```

同步成功后重跑一次 Step 1 复核。同步失败（任何非零退出）不重试、不降级，直接按 `manual` 路由输出失败事实。

### Step 3 — 路由分流

| gate | 事实 | route |
|------|------|-------|
| implement-start | `allFresh` | `continue` |
| implement-start | `syncable` 且同步后复核 `allFresh` | `synced-continue` |
| implement-start | 其余（含同步后仍非 fresh、同步失败） | `manual`（abort，不进入 implement-code） |
| review-start | `allFresh` | `continue` |
| review-start | `syncable`（同步成功） | `replay`（review_feedback：基线已前进，需重建实现/测试/checkpoint 证据） |
| review-start | 其余（含同步失败） | `manual`（abort，不盲目消耗 reviewLoop） |

`manual` 时输出逐仓 blockers：repo / worktreePath / freshness / 基础分类 / 相关 SHA，供人工把事实恢复为可比较状态（如提交未提交变更、处理分叉、重开 worktree）后重新进入 gate。

### Step 4 — 输出摘要

```text
✅ workspace freshness gate
   CR       : {cr_id}
   gate     : {gate}
   route    : {continue | synced-continue | replay | manual}
   facts    : [{repo}:{freshness} head={head-sha8} trunk={trunk-sha8}, ...]
   blockers : [（manual 时逐仓原因）]
   下一步   : 以 crctl next {cr_id} 为准
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| freshness 技术失败（`WORKSPACE_TRUNK_UNAVAILABLE` / `TX_GIT_FAILED` 等） | 输出 `manual`，附失败 code；不猜测、不重试 |
| sync 返回 `WORKSPACE_FRESHNESS_CHANGED`（漂移） | `manual`：preflight 与写入间事实变化，人工确认后重跑同一同步命令或恢复事实 |
| sync 返回 `WORKSPACE_FRESHNESS_DIVERGED` / `WORKSPACE_SYNC_BLOCKED` | `manual`：逐仓输出原因；无自动合并/变基 |
| sync 返回 `TX_LOCK_HELD` | `manual`：另一 crctl 事务在进行，稍后重跑 gate |

---

## 边界

- 只调用 `crctl workspace freshness` 与 `crctl workspace sync` 两个命令；权威契约见 `skills/shared/crctl/SKILL.md` 与 `crctl.mjs` 实现。
- 不做状态推进、不编辑任何账本、不执行合并/变基/重置；`diverged` 永远人工处理。

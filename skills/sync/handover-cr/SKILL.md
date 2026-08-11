---
name: handover-cr
description: 正式移交 CR 某一角色 owner：唯一业务入口 = owner-set（双投影/唯一责任历史/隔离 commit/owners+inbox 事件）→ push-progress 发布移交 commit。
---

# Skill: handover-cr

**类型**: 远端同步 Skill（sync/ 组，跨阶段通用）  
**调用时机**: 需要将在途 CR 转交给另一成员时

---

## 用途

<!-- lint-prompts:ignore --> 描述性：移交流程说明（实际写入走 crctl owner-set）
将在途 CR 的某个角色负责人从当前 owner 正式移交给新 owner。**固定顺序为 `owner-set -> push-progress`（CR-2026-030 FR-4：无 `skip_push`，远端包含 Owner 变更提交才算移交完成）**：owner-set 作为受控账本原语一次完成双投影（cr.md + _backlog.yml）、唯一责任历史（`owner-history` 追加一条 `formal-handover`）、通知事实与 owners/inbox 事件投影；push-progress 发布本地正式移交 commit。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `owner_role` | enum | ✅ | 移交角色：`requirement` / `development` / `test` |
| `new_owner` | string | ✅ | 接手人标识（用户名/邮箱） |
| `note` | string | 否 | 移交说明（仅进入 cr.md owner-history 与 inbox 通知事实） |

---

## 执行步骤

### Step 1 — 前置校验

<!-- lint-prompts:ignore --> 描述性：移交流程说明（实际写入走 crctl owner-set）
1. 读取 `change-requests/{cr_id}/cr.md`，确认 CR 处于在途状态（非 `archived`/`rejected`/`withdrawn`）
2. 确认 `owner_role` 为 `requirement` / `development` / `test`
3. 确认当前调用者为当前角色 owner 或具备管理员权限（防止无权移交）

### Step 2 — 经 crctl owner-set 变更负责人（唯一业务入口，FR-20/CR-2026-030 FR-3~FR-5）

<!-- lint-prompts:ignore --> 描述性：移交流程说明（实际写入走 crctl owner-set）
运行 `crctl owner-set {cr_id} --role {owner_role} --id {new_owner} [--note "{note}"] --workspace <worktree>`。crctl 原语负责全部写入：tracked clean 前置（仓库存在 tracked staged/unstaged 变更时返回 `OWNER_WORKTREE_DIRTY` 零写入）、双投影一致性校验（`OWNER_PROJECTION_DRIFT`）、一次时间戳、`cr.md`+`_backlog.yml` 一次 CAS、只含两账本的隔离 commit、`owner-history` 只追加一条 `formal-handover`（不追加 `handover-history`）、owners + inbox 两类 outbox 事件（同一真实 SHA）。**禁止手工编辑** owners 字段、**禁止**调用 `inbox-emit` 或手写 notify（guard deny + crctl 独占写）。

- 返回 `changed=false`（同值重放）：仍进入 Step 3 的 `push-progress`，以发布可能已存在的 commit（AC-10）。
- 返回 `OWNER_WORKTREE_DIRTY`：调用方必须先提交、暂存外移或丢弃自己的 tracked 变更后重试（本 Skill 不提供自动 stash）。
- 返回 `OWNER_COMMIT_FAILED` / `OWNER_COMMIT_ROLLBACK_FAILED`：原样回传结构化错误并停止。

### Step 3 — 推送最新进度（固定执行，无 skip_push）

<!-- lint-prompts:ignore --> 描述性文本：push 由 push-progress 内部经受控 shell 执行
委托 `push-progress` skill（内部已通过受控 shell 执行 git push，详见 `skills/shared/controlled-shell/SKILL.md`）：
```
push-progress(cr_id={cr_id})
```

若 `push-progress` 返回 `SHELL_UNAVAILABLE` 结构化错误，**停止执行**本 skill 并原样回传错误；**禁止**降级为「请手工执行推送」文本。

**push 失败 = 移交未完成**：本地正式移交 commit 保留，输出结构化未完成结果，不得宣称移交完成；远端包含 Owner 变更提交才算完成（FR-4）。

### Step 4 — 输出摘要

```
✅ CR 移交完成
   CR          : {cr_id}
   角色        : {owner_role}
   原 owner    : {old-owner}
   新 owner    : {new_owner}
   移交时间戳  : {handoverAt}
   移交提交    : {commit.sha}（已推送 origin/requirement/{cr_id}）
   inbox 通知  : ✅ 已由 owner-set 事件投影发出
   
新 owner 接手命令：
  resume-from-remote {cr_id}
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| CR 已是终态（archived 等） | 停止执行，提示 CR 已关闭 |
| `OWNER_WORKTREE_DIRTY` / `OWNER_PROJECTION_DRIFT` / `OWNER_COMMIT_FAILED` / `OWNER_COMMIT_ROLLBACK_FAILED` | 原样回传结构化错误并停止；不自动修复、不自动 stash |
| `push-progress` 失败 | 停止执行，原样回传结构化错误；本地移交 commit 保留（未完成≠已丢失）；**禁止**输出「请在终端运行」提示 |
| `new_owner` 与当前角色 owner 相同 | owner-set 返回 `changed=false`（幂等），仍执行 push-progress 发布可能已存在的 commit |

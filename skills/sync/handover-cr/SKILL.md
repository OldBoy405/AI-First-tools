---
name: handover-cr
description: 正式移交 CR 某一角色 owner：先 push-progress 确保远端最新，再经 crctl owner-set 变更 _backlog owners.{role}（S4），并向新 owner 发送 inbox 事件。
---

# Skill: handover-cr

**类型**: 远端同步 Skill（sync/ 组，跨阶段通用）  
**调用时机**: 需要将在途 CR 转交给另一成员时

---

## 用途

<!-- lint-prompts:ignore --> 描述性：移交流程说明（实际写入走 crctl owner-set）
将在途 CR 的某个角色负责人从当前 owner 正式移交给新 owner。流程：先执行 `push-progress` 确保远端已是最新状态，再更新 `cr.md` 和 `_backlog.yml` 中的 `owners.{role}.id` 与 `owners.{role}.assigned-at`，追加 `owner-history` / `handover-history`，最后通过 `inbox-emit` 向新 owner 发送接手通知。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `owner_role` | enum | ✅ | 移交角色：`requirement` / `development` / `test` |
| `new_owner` | string | ✅ | 接手人标识（用户名/邮箱） |
| `note` | string | 否 | 移交说明，写入 handover-history 和 inbox 消息 |
| `skip_push` | boolean | 否 | 跳过 push-progress（已确认远端最新时可设为 true），默认 false |

---

## 执行步骤

### Step 1 — 前置校验

<!-- lint-prompts:ignore --> 描述性：移交流程说明（实际写入走 crctl owner-set）
1. 读取 `change-requests/{cr_id}/cr.md`，确认 CR 处于在途状态（非 `archived`/`rejected`/`withdrawn`）
2. 确认 `owner_role` 为 `requirement` / `development` / `test`
3. 确认当前调用者为当前角色 owner 或具备管理员权限（防止无权移交）

### Step 2 — 推送最新进度（除非 skip_push=true）

<!-- lint-prompts:ignore --> 描述性文本：push 由 push-progress 内部经受控 shell 执行
委托 `push-progress` skill（内部已通过受控 shell 执行 git push，详见 `skills/shared/controlled-shell/SKILL.md`）：
```
push-progress(cr_id={cr_id})
```

若 `push-progress` 返回 `SHELL_UNAVAILABLE` 结构化错误，**停止执行**本 skill 并原样回传错误；**禁止**降级为「请手工执行推送」文本。

确保移交时远端已是最新，新 owner 可直接 `resume-from-remote` 接手。

### Step 3 — 更新 cr.md

<!-- lint-prompts:ignore --> 描述性：移交流程说明（实际写入走 crctl owner-set）
在 `change-requests/{cr_id}/cr.md` 中：
1. 将 `owners.{owner_role}.id` 更新为 `new_owner`
2. 将 `owners.{owner_role}.assigned-at` 更新为当前时间戳
3. 若 `owner_role=requirement`，同步更新顶层兼容字段 `owner={new_owner}`
4. 在 `owner-history` 与 `handover-history` 列表追加：

```yaml
- role: "{owner_role}"
  from: "{current-owner}"
  to: "{new_owner}"
  at: "{YYYY-MM-DDTHH:mm:ss+08:00}"
  note: "{note}"
```

### Step 4 — 经 crctl owner-set 变更负责人（FR-20，CR-2026-022）

<!-- lint-prompts:ignore --> 描述性：移交流程说明（实际写入走 crctl owner-set）
运行 `crctl owner-set {cr_id} --role {owner_role} --id {new_owner} --workspace <worktree>`：crctl 原子更新 `_backlog.yml` 与 `cr.md` 的 `owners.{role}.id`/`assigned-at`（含顶层 `owner` 兼容字段与 owner-history 追加，CAS+审计）；**禁止手工编辑** owners 字段（guard deny + crctl 独占写）。

### Step 5 — 发送 inbox 通知

调用 `crctl inbox-emit`（CLI 形态，事件 `owner-handover`，`subject/body` 塞进 payload）：
```text
crctl inbox-emit {cr_id} --event owner-handover --to {new_owner} --payload '{"subject": "CR {owner_role} owner 移交：{cr_id} — {cr_title}", "body": "你已接手 {cr_id} 的 {owner_role} 责任，当前状态：{status}。\n移交说明：{note}\n\n接手命令：resume-from-remote {cr_id}"}' --workspace <worktree>
```

### Step 6 — 输出摘要

```
✅ CR 移交完成
   CR          : {cr_id}
   角色        : {owner_role}
   原 owner    : {old-owner}
   新 owner    : {new_owner}
   远端分支    : origin/requirement/{cr_id}（已推送最新）
   inbox 通知  : ✅ 已发送给 {new_owner}
   
新 owner 接手命令：
  resume-from-remote {cr_id}
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| CR 已是终态（archived 等） | 停止执行，提示 CR 已关闭 |
| `push-progress` 失败 | 停止执行，原样回传结构化错误；**禁止**输出「请在终端运行」提示 |
| `inbox-emit` 不可用 | 跳过通知，输出警告，其余步骤正常完成 |
| `new_owner` 与当前角色 owner 相同 | 输出警告跳过（幂等处理） |

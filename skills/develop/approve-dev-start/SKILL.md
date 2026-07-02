---
name: approve-dev-start
description: 记录任务拆分后的开发启动人工确认，校验 plan.md 与 tasks/ 已完成，并将 CR status 从 task-breakdown 推进到 developing。用于 code-implementation pipeline 的编码前 human_approval 之后。
---

# Skill: approve-dev-start

**类型**: 开发期 Skill（develop/ 组）  
**调用时机**: code-implementation pipeline 中 TASK 拆分完成并通过人工确认后

---

## 用途

将"任务拆分可进入编码"这个人工确认落成可追溯状态。`write-dev-tasks` 负责生成 TASK 并推进到 `task-breakdown`；本 Skill 只负责确认计划和任务已被接受，然后推进到 `developing`，解锁 `implement-code`。

---

## 输入

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | yes | 目标 CR-ID |
| `approver` | string | no | 确认进入开发的人；为空则使用 `cr.md owners.development.id` |

---

## 前置条件

1. 读取 `AGENTS.md`、`dir-graph.yaml`，从 graph 解析 `change-requests/` 路径。
2. 读取 `change-requests/_backlog.yml` 与 `change-requests/{cr_id}/cr.md`，确认当前 status 为 `task-breakdown`。
3. 确认 `cr.md owners.development.id` 与 `owners.development.assigned-at` 均存在；若 `approver` 为空，使用该负责人。
4. 确认 `change-requests/{cr_id}/plan.md` 存在。
5. 确认 `change-requests/{cr_id}/tasks/_index.yml` 与至少一个 `TASK-*.md` 存在。

---

## 执行步骤

1. 校验所有前置条件；任一失败则 abort，不推进状态。
2. 在 `change-requests/{cr_id}/approval.yml` 写入或更新 `development-start` 段：
   ```yaml
   development-start:
     approved-by: {approver}
     approved-at: {YYYY-MM-DDTHH:mm:ss+08:00}
     owner-role: development
     from-status: task-breakdown
     to-status: developing
     accepted-artifacts:
       plan: change-requests/{cr_id}/plan.md
       tasks-index: change-requests/{cr_id}/tasks/_index.yml
   ```
3. 调用 `cr-status-set`（`next_status=developing`，`trigger=approve-dev-start`，`expected_current_status=task-breakdown`）将 status 推进为 `developing`。
4. 输出审批记录路径、当前 status 和下一步 `implement-code` 指令。

---

## 禁止事项

- 不修改 `plan.md` 或 `tasks/` 内容。
- 不直接写代码。
- 不跳过 `cr-status-set` 手工编辑 `_backlog.yml`。

---

## 失败处理

| 情况 | 处理 |
|------|------|
| status 不是 `task-breakdown` | abort，输出当前 status 与允许的下一步 |
| plan.md 或 tasks 缺失 | abort，要求重新运行 `write-dev-plan` / `write-dev-tasks` |
| 人工确认缺失 | abort，等待 pipeline 的 human_approval |

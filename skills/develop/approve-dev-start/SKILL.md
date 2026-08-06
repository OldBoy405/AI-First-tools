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

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | yes | 目标 CR-ID |
| `approver` | string | no | 确认进入开发的人；为空则使用 `cr.md owners.development.id` |

---

## 执行步骤

1. 运行 `crctl approve {cr_id} --stage dev-start`（**仅限人类交互式终端，或 Ed25519 签名授权 `--grant` 二选一；两者都不可绕过审批本身**）——crctl 自动完成：
   - 前置态校验（当前 status=task-breakdown）
   - 审批前置产物校验（plan.md 与 tasks/ 存在）
   - 计算证据摘要并写入 approval.yml#dev-start（CAS+审计）
   - 级联 advance 到 developing
2. Agent/管道**不得**代写 approval.yml 或推进 status；非 TTY 调用 crctl 一律拒绝（APPROVAL_REQUIRES_HUMAN）。
3. 输出审批记录路径、当前 status 和下一步：implement-code。

## 错误处理

| 场景 | 行为 |
|------|------|
| status 不是 `task-breakdown` | crctl approve 拒绝（CR_STATUS_CURRENT_MISMATCH），abort |
| 评审证据未通过（plan/tasks 缺失） | crctl approve 拒绝（GATE_BLOCKED），先修复并重跑 write-dev-plan / write-dev-tasks |
| 非 TTY 调用 | crctl approve 拒绝（APPROVAL_REQUIRES_HUMAN），必须人工在终端执行 |
| 审批人回答非 yes | crctl 自动执行状态机回退转换（CR 回退到 tech-design-reviewed，错误码 APPROVAL_DECLINED_ROLLED_BACK），请重新执行 write-dev-plan |

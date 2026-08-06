---
name: approve-tech-design
description: 记录架构设计人工审批结论，校验 change-requests/{CR-ID}/review-annotations/sdd.yml 已通过，并将 CR status 推进到 tech-design-reviewed。用于 architecture-design pipeline 的 human_approval 之后。
---

# Skill: approve-tech-design

**类型**: 开发期 Skill（develop/ 组，架构审批收口）
**调用时机**: architecture-design pipeline 的 `human_approval` 通过后

## 用途

将人工审批从提示动作变成可审计的状态推进动作。`review-tech-design` 只负责 AI/结构化评审；本 Skill 负责在人工确认后写入审批记录并解锁 `/coding`。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | yes | 目标 CR-ID |
| `approver` | string | no | 审批人 ID；为空使用 `cr.md owners.development.id` |
| `notes` | string | no | 审批备注 |

## 执行步骤

1. 运行 `crctl approve {cr_id} --stage tech-design`（**仅限人类交互式终端，或 Ed25519 签名授权 `--grant` 二选一；两者都不可绕过审批本身**）——crctl 自动完成：
   - 前置态校验（当前 status=tech-design-review-pending）
   - 评审证据校验（review-annotations/sdd.yml verdict=pass 且 blockers 为空）
   - 计算证据摘要并写入 approval.yml#tech-design（CAS+审计）
   - 级联 advance 到 tech-design-reviewed
2. Agent/管道**不得**代写 approval.yml 或推进 status；非 TTY 调用 crctl 一律拒绝（APPROVAL_REQUIRES_HUMAN）。
3. 输出审批记录路径、当前 status 和下一步：write-dev-plan。

## 错误处理

| 场景 | 行为 |
|------|------|
| status 不是 `tech-design-review-pending` | crctl approve 拒绝（CR_STATUS_CURRENT_MISMATCH），abort |
| 评审证据未通过（review-annotations/sdd.yml verdict 非 pass 或 blockers 非空） | crctl approve 拒绝（GATE_BLOCKED），先修复并重跑 review-tech-design |
| 非 TTY 调用 | crctl approve 拒绝（APPROVAL_REQUIRES_HUMAN），必须人工在终端执行 |
| 审批人回答非 yes | crctl 自动执行状态机回退转换（CR 回退到 tech-designing，错误码 APPROVAL_DECLINED_ROLLED_BACK），请重新执行 write-tech-design |

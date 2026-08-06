---
name: approve-requirement
description: 需求审批通过后的收尾动作：在 approval.yml 记录审批结论，将 CR status 推进到 requirement-approved，供 architecture-design pipeline 解锁使用。
---

# Skill: approve-requirement

**类型**: 需求期 Skill（requirement/ 组，收尾节点）  
**调用时机**: requirement-authoring pipeline 最后节点（human_approval 通过后）

---

## 用途

人工审批通过后，正式完成需求审批流程：记录审批人与审批时间，将 CR status 推进到 `requirement-approved`，该状态是 architecture-design pipeline 的前置 gate。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `approver` | string | ❌ | 审批人 ID；为空则使用 `cr.md owners.requirement.id` |
| `notes` | string | ❌ | 审批备注（可选，写入 approval.yml） |

---

## 执行步骤

1. 运行 `crctl approve {cr_id} --stage requirement`（**仅限人类交互式终端，或 Ed25519 签名授权 `--grant` 二选一；两者都不可绕过审批本身**）——crctl 自动完成：
   - 前置态校验（当前 status=requirement-reviewing）
   - 评审证据校验（review-annotations/requirement.yml verdict=pass 且 blockers 为空）
   - 计算证据摘要并写入 approval.yml#requirement（CAS+审计）
   - 级联 advance 到 requirement-approved
2. Agent/管道**不得**代写 approval.yml 或推进 status；非 TTY 调用 crctl 一律拒绝（APPROVAL_REQUIRES_HUMAN）。
3. 输出审批记录路径、当前 status 和下一步：以 `crctl next {cr_id}` 为准（进入架构设计阶段）。

## 错误处理

| 场景 | 行为 |
|------|------|
| status 不是 `requirement-reviewing` | crctl approve 拒绝（CR_STATUS_CURRENT_MISMATCH），abort |
| 评审证据未通过（review-annotations/requirement.yml verdict 非 pass 或 blockers 非空） | crctl approve 拒绝（GATE_BLOCKED），先修复并重跑 review-requirement |
| 非 TTY 调用 | crctl approve 拒绝（APPROVAL_REQUIRES_HUMAN），必须人工在终端执行 |
| 审批人回答非 yes | crctl 自动执行状态机回退转换（CR 回退到 drafting，错误码 APPROVAL_DECLINED_ROLLED_BACK），请重新执行 write-requirement-prd |

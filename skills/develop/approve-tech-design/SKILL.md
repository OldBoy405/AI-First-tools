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

1. 运行 `crctl approve {cr_id} --stage tech-design --grant`（平台非 TTY，默认 grant 落点；**仅限 Ed25519 签名授权或人类交互式终端二选一，两者都不可绕过审批本身**）——crctl 自动完成：
   - 前置态校验（当前 status=tech-design-review-pending）
   - 评审证据校验（review-annotations/sdd.yml verdict=pass 且 blockers 为空）
   - 计算证据摘要并写入 approval.yml#tech-design（CAS+审计）
   - 级联 advance 到 tech-design-reviewed
2. 本地独立 CLI（无 grant）：`crctl approve {cr_id} --stage tech-design`，仅限交互式终端；非 TTY 拒绝（APPROVAL_REQUIRES_HUMAN）。
3. **驳回（grant decision=reject）**：crctl 完整验证（schema/归属/状态/evidence digest/Ed25519 签名）后执行状态机既有回退转换，返回结构化非零业务结果 `APPROVAL_DECLINED_ROLLED_BACK`（含 rolledBackTo/trigger/changed）。该结果表示人工决定已捕获且回退成功，**必须中止当前正向 Pipeline**；不得伪装为 `EXEC_FAILED`/`CAS_CONFLICT` 等技术失败，不得输出 rerunHint、下一 Skill 指令或手写 review annotation。
4. Agent/管道**不得**代写 approval.yml、手写 reject 或推进 status；非 TTY 且无 grant 调用 crctl 一律拒绝（APPROVAL_REQUIRES_HUMAN）。
5. 输出审批记录路径、当前 status 和下一步：以 `crctl next {cr_id}` 为准。
3. 输出审批记录路径、当前 status 和下一步：以 `crctl next {cr_id}` 为准（进入开发计划阶段）。

## 错误处理

| 场景 | 行为 |
|------|------|
| status 不是 `tech-design-review-pending` | crctl approve 拒绝（CR_STATUS_CURRENT_MISMATCH），abort |
| 评审证据未通过（review-annotations/sdd.yml verdict 非 pass 或 blockers 非空） | crctl approve 拒绝（GATE_BLOCKED），先修复并重跑 review-tech-design |
| 非 TTY 调用 | crctl approve 拒绝（APPROVAL_REQUIRES_HUMAN），必须人工在终端执行 |
| 审批人回答非 y/yes（TTY，CR-2026-044 起 trim 后大小写不敏感接受 `y\|yes`） | crctl 自动执行状态机回退转换（CR 回退到 tech-designing，错误码 APPROVAL_DECLINED_ROLLED_BACK），请重新执行 write-tech-design |
| grant decision=reject | crctl 验签后执行权威回退，返回 `APPROVAL_DECLINED_ROLLED_BACK`（业务结果，中止正向流程）；伪造签名/跨 CR/证据漂移/错误状态均为技术错误（SIGNATURE_INVALID/GRANT_MISMATCH/EVIDENCE_DRIFT/GRANT_STATE_MISMATCH），零写入并中止 |
| 紧邻结果态重放 | crctl 返回 `changed=false` 幂等成功，不重复 audit/commit/outbox |

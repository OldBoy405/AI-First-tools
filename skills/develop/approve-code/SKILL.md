---
name: approve-code
description: 记录代码人工审批结论，校验 change-requests/{CR-ID}/review-annotations/code.yml 已通过，并将 CR status 推进到 code-approved。用于 code-implementation pipeline 的 human_approval 之后。
---

# Skill: approve-code

**类型**: 开发期 Skill（develop/ 组，代码审批收口）
**调用时机**: code-implementation pipeline 的 `human_approval` 通过后

## 用途

将代码审查人的人工批准落成可追溯状态。`review-code` 负责结构化评审并推进到 `code-reviewing`；本 Skill 负责确认无 blocker 后推进到 `code-approved`，解锁 writeback pipeline。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | yes | 目标 CR-ID |
| `approver` | string | no | 审批人 ID；为空使用 `cr.md owners.development.id` |
| `notes` | string | no | 审批备注 |

## 执行步骤

1. 运行 `crctl approve {cr_id} --stage code --grant --approver {cr.md owners.development.id}`（平台非 TTY，默认 grant 落点；**仅限 Ed25519 签名授权或人类交互式终端二选一，两者都不可绕过审批本身**）——crctl 自动完成：
   - 前置态校验（当前 status=code-reviewing）
   - 评审证据校验（review-annotations/code.yml verdict=pass 且 blockers 为空）
   - 计算证据摘要并写入 approval.yml#code（CAS+审计）
   - 级联 advance 到 code-approved
2. 本地独立 CLI（无 grant）：`crctl approve {cr_id} --stage code --approver {cr.md owners.development.id}`，仅限交互式终端；非 TTY 拒绝（APPROVAL_REQUIRES_HUMAN）。
3. **驳回（grant decision=reject）**：crctl 完整验证（schema/归属/状态/evidence digest/Ed25519 签名）后执行状态机既有回退转换，返回结构化非零业务结果 `APPROVAL_DECLINED_ROLLED_BACK`（含 rolledBackTo/trigger/changed）。该结果表示人工决定已捕获且回退成功，**必须中止当前正向 Pipeline**；不得伪装为 `EXEC_FAILED`/`CAS_CONFLICT` 等技术失败，不得输出 rerunHint、下一 Skill 指令或手写 review annotation。
4. Agent/管道**不得**代写 approval.yml、手写 reject 或推进 status；非 TTY 且无 grant 调用 crctl 一律拒绝（APPROVAL_REQUIRES_HUMAN）。
5. 输出审批记录路径、当前 status 和下一步：以 `crctl next {cr_id}` 为准。
4. **suggestions 承接（可选）**：剩余 `suggestions` 可经 `record-idea`（planning 域 Skill）转入 `docs/ideas/`——必须在 approve-code 期做（CR worktree 内随分支合并进 trunk；feature-writeback 硬边界只写 specs/delivery）；不设默认、不阻塞本 CR；不转则仅留档 review-annotations，无损失。

## 错误处理

| 场景 | 行为 |
|------|------|
| status 不是 `code-reviewing` | crctl approve 拒绝（CR_STATUS_CURRENT_MISMATCH），abort |
| 评审证据未通过（review-annotations/code.yml verdict 非 pass 或 blockers 非空） | crctl approve 拒绝（GATE_BLOCKED），先修复并重跑 review-code |
| 非 TTY 调用 | crctl approve 拒绝（APPROVAL_REQUIRES_HUMAN），必须人工在终端执行 |
| 审批人回答非 y/yes（TTY，CR-2026-044 起 trim 后大小写不敏感接受 `y\|yes`） | crctl 自动执行状态机回退转换（CR 回退到 developing，错误码 APPROVAL_DECLINED_ROLLED_BACK），请重新执行 implement-code |
| grant decision=reject | crctl 验签后执行权威回退，返回 `APPROVAL_DECLINED_ROLLED_BACK`（业务结果，中止正向流程）；伪造签名/跨 CR/证据漂移/错误状态均为技术错误（SIGNATURE_INVALID/GRANT_MISMATCH/EVIDENCE_DRIFT/GRANT_STATE_MISMATCH），零写入并中止 |
| 紧邻结果态重放 | crctl 返回 `changed=false` 幂等成功，不重复 audit/commit/outbox |

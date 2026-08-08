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

1. 运行 `crctl approve {cr_id} --stage code`（**仅限人类交互式终端，或 Ed25519 签名授权 `--grant` 二选一；两者都不可绕过审批本身**）——crctl 自动完成：
   - 前置态校验（当前 status=code-reviewing）
   - 评审证据校验（review-annotations/code.yml verdict=pass 且 blockers 为空）
   - 计算证据摘要并写入 approval.yml#code（CAS+审计）
   - 级联 advance 到 code-approved
2. Agent/管道**不得**代写 approval.yml 或推进 status；非 TTY 调用 crctl 一律拒绝（APPROVAL_REQUIRES_HUMAN）。
3. 输出审批记录路径、当前 status 和下一步：以 `crctl next {cr_id}` 为准（进入回写阶段）。
4. **suggestions 承接（可选）**：剩余 `suggestions` 可经 `record-idea`（planning 域 Skill）转入 `docs/ideas/`——必须在 approve-code 期做（CR worktree 内随分支合并进 trunk；feature-writeback 硬边界只写 specs/delivery）；不设默认、不阻塞本 CR；不转则仅留档 review-annotations，无损失。

## 错误处理

| 场景 | 行为 |
|------|------|
| status 不是 `code-reviewing` | crctl approve 拒绝（CR_STATUS_CURRENT_MISMATCH），abort |
| 评审证据未通过（review-annotations/code.yml verdict 非 pass 或 blockers 非空） | crctl approve 拒绝（GATE_BLOCKED），先修复并重跑 review-code |
| 非 TTY 调用 | crctl approve 拒绝（APPROVAL_REQUIRES_HUMAN），必须人工在终端执行 |
| 审批人回答非 yes | crctl 自动执行状态机回退转换（CR 回退到 developing，错误码 APPROVAL_DECLINED_ROLLED_BACK），请重新执行 implement-code |

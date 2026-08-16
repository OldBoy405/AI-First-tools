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

**双模式（CR-2026-030 FR-6）**：平台非 TTY 走默认 grant 落点 `crctl approve {cr_id} --stage requirement --grant`（daemon 已投递 `.crctl/grants/{cr_id}-requirement.grant.json`）；本地独立 CLI 无 grant 时继续要求当前 TTY（`crctl approve {cr_id} --stage requirement`）。Pipeline 不拼 grant 路径、不复制 CLI 算法；grant 缺失/签名错误/归属不符/证据漂移/技术投递失败均为技术失败，必须中止且不得模型代签或直接 advance。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `approver` | string | ❌ | 审批人 ID；为空则使用 `cr.md owners.requirement.id` |
| `notes` | string | ❌ | 审批备注（可选，写入 approval.yml） |

---

## 执行步骤

1. 运行 `crctl approve {cr_id} --stage requirement --grant`（平台非 TTY，默认 grant 落点；**仅限 Ed25519 签名授权或人类交互式终端二选一，两者都不可绕过审批本身**）——crctl 自动完成：
   - 前置态校验（当前 status=requirement-reviewing）
   - 评审证据校验（review-annotations/requirement.yml verdict=pass 且 blockers 为空）
   - 计算证据摘要并写入 approval.yml#requirement（CAS+审计）
   - 级联 advance 到 requirement-approved
2. 本地独立 CLI（无 grant）：`crctl approve {cr_id} --stage requirement`，仅限交互式终端；非 TTY 拒绝（APPROVAL_REQUIRES_HUMAN）。
3. **驳回（grant decision=reject）**：crctl 完整验证（schema/归属/状态/evidence digest/Ed25519 签名）后执行状态机既有回退转换，返回结构化非零业务结果 `APPROVAL_DECLINED_ROLLED_BACK`（含 rolledBackTo/trigger/changed）。该结果表示人工决定已捕获且回退成功，**必须中止当前正向 Pipeline**；不得伪装为 `EXEC_FAILED`/`CAS_CONFLICT` 等技术失败，不得输出 rerunHint、下一 Skill 指令或手写 review annotation。
4. Agent/管道**不得**代写 approval.yml、手写 reject 或推进 status；非 TTY 且无 grant 调用 crctl 一律拒绝（APPROVAL_REQUIRES_HUMAN）。
5. 输出审批记录路径、当前 status 和下一步：以 `crctl next {cr_id}` 为准（进入架构设计阶段）。

## 错误处理

| 场景 | 行为 |
|------|------|
| status 不是 `requirement-reviewing` | crctl approve 拒绝（CR_STATUS_CURRENT_MISMATCH），abort |
| 评审证据未通过（review-annotations/requirement.yml verdict 非 pass 或 blockers 非空） | crctl approve 拒绝（GATE_BLOCKED），先修复并重跑 review-requirement |
| 非 TTY 调用 | crctl approve 拒绝（APPROVAL_REQUIRES_HUMAN），必须人工在终端执行 |
| 审批人回答非 y/yes（TTY，CR-2026-044 起 trim 后大小写不敏感接受 `y\|yes`） | crctl 自动执行状态机回退转换（CR 回退到 drafting，错误码 APPROVAL_DECLINED_ROLLED_BACK），请重新执行 write-requirement-prd |
| grant decision=reject | crctl 验签后执行权威回退，返回 `APPROVAL_DECLINED_ROLLED_BACK`（业务结果，中止正向流程）；伪造签名/跨 CR/证据漂移/错误状态均为技术错误（SIGNATURE_INVALID/GRANT_MISMATCH/EVIDENCE_DRIFT/GRANT_STATE_MISMATCH），零写入并中止 |
| 紧邻结果态重放（approve 已到 requirement-approved 且字段一致 / reject 已回退到 drafting） | crctl 返回 `changed=false` 幂等成功，不重复 audit/commit/outbox |

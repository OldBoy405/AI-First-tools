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

1. 运行 `crctl approve {cr_id} --stage dev-start --grant --approver {cr.md owners.development.id}`（平台非 TTY，默认 grant 落点；**仅限 Ed25519 签名授权或人类交互式终端二选一，两者都不可绕过审批本身**）——crctl 自动完成：
   - 前置态校验（当前 status=task-breakdown）
   - 审批前置产物校验（plan.md 与 tasks/ 存在；CR-2026-026 起含 dev-plan 自动评审 passCondition：`review-annotations/dev-plan.yml` 存在且 verdict=pass、blockers=[]）
   - 计算证据摘要并写入 approval.yml#dev-start（CAS+审计；evidence digest 覆盖 dev-plan.yml / plan.md / tasks/_index.yml 三键，FR-11；TASK-*.md 正文漂移不在承诺范围，AC-12a）
   - 级联 advance 到 developing
2. 本地独立 CLI（无 grant）：`crctl approve {cr_id} --stage dev-start --approver {cr.md owners.development.id}`，仅限交互式终端；非 TTY 拒绝（APPROVAL_REQUIRES_HUMAN）。
3. **驳回（grant decision=reject）**：crctl 完整验证（schema/归属/状态/evidence digest/Ed25519 签名）后执行状态机既有回退转换，返回结构化非零业务结果 `APPROVAL_DECLINED_ROLLED_BACK`（含 rolledBackTo/trigger/changed）。该结果表示人工决定已捕获且回退成功，**必须中止当前正向 Pipeline**；不得伪装为 `EXEC_FAILED`/`CAS_CONFLICT` 等技术失败，不得输出 rerunHint、下一 Skill 指令或手写 review annotation。
4. Agent/管道**不得**代写 approval.yml、手写 reject 或推进 status；非 TTY 且无 grant 调用 crctl 一律拒绝（APPROVAL_REQUIRES_HUMAN）。
5. 输出审批记录路径、当前 status 和下一步：以 `crctl next {cr_id}` 为准。
3. 输出审批记录路径、当前 status 和下一步：以 `crctl next {cr_id}` 为准（进入编码实施阶段）。

## 错误处理

| 场景 | 行为 |
|------|------|
| status 不是 `task-breakdown` | crctl approve 拒绝（CR_STATUS_CURRENT_MISMATCH），abort |
| 评审证据未通过（plan/tasks 缺失） | crctl approve 拒绝（GATE_BLOCKED），先修复并重跑 write-dev-plan / write-dev-tasks |
| dev-plan 自动评审未通过（dev-plan.yml 缺失 / verdict≠pass / blockers 非空） | crctl approve 拒绝（GATE_BLOCKED），先重跑 review-dev-plan（CR-2026-026 FR-10） |
| 非 TTY 调用 | crctl approve 拒绝（APPROVAL_REQUIRES_HUMAN），必须人工在终端执行 |
| 审批人回答非 y/yes（TTY，CR-2026-044 起 trim 后大小写不敏感接受 `y\|yes`） | crctl 自动执行状态机回退转换（CR 回退到 tech-design-reviewed，错误码 APPROVAL_DECLINED_ROLLED_BACK），请重新执行 write-dev-plan |
| grant decision=reject | crctl 验签后执行权威回退，返回 `APPROVAL_DECLINED_ROLLED_BACK`（业务结果，中止正向流程）；伪造签名/跨 CR/证据漂移/错误状态均为技术错误（SIGNATURE_INVALID/GRANT_MISMATCH/EVIDENCE_DRIFT/GRANT_STATE_MISMATCH），零写入并中止 |
| 紧邻结果态重放 | crctl 返回 `changed=false` 幂等成功，不重复 audit/commit/outbox |

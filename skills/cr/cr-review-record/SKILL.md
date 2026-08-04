---
name: cr-review-record
description: CR Review Record（原子）：记录新四阶段 CR 的补充审查意见，不替代 review-* 或 approve-* 主流程状态推进。
---
<!-- meta
id: cr-review-record
title: CR Review Record（原子）
status: active
kind: skill
scope: change-request-lifecycle
-->

# CR Review Record Skill（原子）

记录一次 CR 的补充审查意见或人工决策：写入 `approval.yml` 或对应 review 记录。主流程中需求、技术、代码审批分别由 `approve-requirement`、`approve-tech-design`、`approve-code` 负责推进状态；本 Skill 不替代这些显式状态 Skill。

## 触发意图

- "记录 CR 补充审查意见"
- "登记人工拒绝或撤回原因"
- 历史补丁式 CR 需要保留审查记录但不进入主四阶段 pipeline 时

## 读取契约（启动序）

1. 读 `AGENTS.md`、`dir-graph.yaml`
2. 读 `change-requests/{CR-ID}/cr.md` — 获取 type、submitter 等基础信息

## 输入参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `cr-id` | 是 | 例 `CR-2026-001` |
| `decision` | 是 | `note` \| `reject` \| `withdraw` |
| `reviewer` | 是 | 审批人 id |
| `notes` | 否 | 审批备注 |
| `conditions` | 否 | 附加条件列表 |

## 操作步骤

1. 读 `change-requests/{CR-ID}/cr.md`
2. **写入 / 更新** `change-requests/{CR-ID}/approval.yml` 的 `supplemental-reviews` 段：
   ```yaml
   cr-id: {CR-ID}
   type: {cr.type}
   supplemental-reviews:
     - reviewer: {reviewer}
       recorded-at: "YYYY-MM-DDTHH:mm:ss+HH:mm"
       decision: {decision}
       status-at-record: {current-status}
       conditions: {conditions}
       notes: "{notes}"
   ```
3. 若 `decision=reject`：调用 `cr-status-set`（`next_status=rejected`，`trigger=cr-review-record:reject`）将 status 推进到 `rejected`，并写明 reject reason。
4. 若 `decision=withdraw`：调用 `cr-status-set`（`next_status=withdrawn`，`trigger=cr-review-record:withdraw`）将 status 推进到 `withdrawn`，并写明 withdraw reason。
5. 若 `decision=note`：不改变 status。
6. Commit：`[cr] review {CR-ID} decision={decision} by={reviewer}`

## 不做

- 不替代 `approve-requirement` / `approve-tech-design` / `approve-code`
- 不把 CR 推进到主流程通过态
- 不做多审批人投票聚合
- **不写 notify-pending / notify-log**（由 `inbox-emit` 在 pipeline 中调用）

## 输出

- `change-requests/{CR-ID}/approval.yml`
- 如 decision 为 reject / withdraw，则 `cr.md` frontmatter status 更新

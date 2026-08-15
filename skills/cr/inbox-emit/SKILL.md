---
name: inbox-emit
description: Inbox Emit（原子）
---
<!-- meta
id: inbox-emit
title: Inbox Emit（原子）
status: active
kind: skill
scope: change-request-lifecycle
-->

# Inbox Emit Skill（原子）

Pipeline 所有关键节点的 inbox 写入**单一入口**：
向 `_backlog.yml` 目标 CR 条目追加 `notify-log` 事件，并更新 `notify-pending` 列表。
**原子职责**：只写 inbox 记录，不负责外部通知触达（邮件/IM/推送等由 pipeline 外部 handler 订阅）。

## 触发意图

不直接由用户触发，由各 pipeline / 原子 Skill 在关键节点调用：
- `review-requirement` 完成 → `event=requirement-reviewing`
- `approve-requirement` 完成 → `event=requirement-approved`
- `review-tech-design` 完成 → `event=tech-design-review-pending`
- `approve-tech-design` 完成 → `event=tech-design-reviewed`
- `approve-dev-start` 完成 → `event=developing`
- `review-code` 完成 → `event=code-reviewing`
- `approve-code` 完成 → `event=code-approved`
- `cr-review-record` 拒绝或撤回 → `event=rejected` / `event=withdrawn`
- `cr-archive` 完成 → `event=archived`
- `handover-cr` 移交 → `event=owner-handover`（CR 负责人移交）
- `cr-sla-watchdog.pipeline` → `event=overdue`

## 下游消费方

- `owner-handover`：由 `handover-cr` 作为触发方（新 owner 接手通知）

## 读取契约（启动序）

1. 读 `AGENTS.md`、`dir-graph.yaml`
2. 读 `change-requests/{CR-ID}/cr.md` frontmatter — 获取当前 status
3. 读 `change-requests/_config.yml` — 取 SLA 阈值（仅 event=overdue 时需要）

## 输入参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `cr-id` | 是 | 例 `CR-2026-001` |
| `event` | 是 | `requirement-reviewing` \| `requirement-approved` \| `tech-design-review-pending` \| `tech-design-reviewed` \| `developing` \| `code-reviewing` \| `code-approved` \| `rejected` \| `withdrawn` \| `archived` \| `owner-handover` \| `overdue` |
| `to` | 是 | 收件人列表，例 `["umasuo", "reviewer-2"]`；取值来源：CR `owners.*.id` 或 feedback 发起人（调用方负责传入，不得留空——通知链断裂的根因） |
| `payload` | 否 | 附加 JSON 信息，例 `{ "decision": "approve", "notes": "..." }` |

## 操作步骤

1. 运行 `crctl inbox-emit {cr-id} --event {event} --to {to} [--payload {payload}] --workspace <worktree>`：
   - crctl 以 CAS 追加 `_backlog.yml` 条目 `notify-log[]`（`{at, event, to, payload, handled:false}`，时间戳 crctl 生成）
   - 同步合并 `notify-pending`（去重）
2. 模型**不得**直接 Write `_backlog.yml` 的 notify-log/notify-pending 段（guard deny + crctl 独占写）。
3. Commit：`[cr] inbox-emit {CR-ID} event={event} to={to}`（经 `crctl git commit`）。

## 不做

- 不计算谁该收到通知（调用方 pipeline 负责传入 `to`）
- 不订阅事件（外部 handler 自行订阅 `notify-log` 变更）
- 不发送邮件/IM/推送（外部集成层职责）
- 不校验 to 列表中的用户是否存在

## 幂等性

同一 `cr-id + event + at` 组合若重复调用，追加独立的 notify-log 条目（不去重），
上层 handler 负责判断 `handled: false` 的条目是否已处理。

## 输出

- `_backlog.yml` 目标 CR 的 `notify-log` 追加新条目
- `notify-pending` 更新（合并新收件人）

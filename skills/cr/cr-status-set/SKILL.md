---
name: cr-status-set
status: legacy/deprecated
description: CR Status Set（原子）：按 dir-graph.yaml 新四阶段状态机更新 change-requests/{CR-ID}/cr.md frontmatter 的 status。
---
<!-- lint-prompts:ignore --> legacy skill 自身说明（R3 豁免）

> **legacy/deprecated（CR-2026-021 TASK-16）**：状态推进请改用 `crctl advance --to <status> --trigger <trigger> --expect <current>`——它会跑门禁、写 cr.md、发审计与 outbox 事件。本 Skill 保留仅为历史兼容与文档引用，**新流程不得调用**。
<!-- meta
id: cr-status-set
title: CR Status Set（原子）
status: active
kind: skill
scope: change-request-lifecycle
-->

# CR Status Set Skill（原子）

CR 状态机的**中心校验与写入点**：读取 `dir-graph.yaml#change-request-track.state_machine`，校验当前 status 到目标 status 的转换是否合法，再将 `change-requests/{CR-ID}/cr.md` frontmatter 的 status 更新为目标值。

默认模式下本 Skill 自行提交状态变更。对 `merge-feature-branch`、`cr-archive` 这类必须把状态和领域元数据放入同一 commit 的 Skill，可使用 `commit_mode=embedded`：本 Skill 只做校验并返回待写入 patch，由调用方在同一事务中提交。

## 触发意图

通常不直接由用户触发，由 pipeline 在关键节点内部调用：

- `requirement-register` 后：`drafting`
- `review-requirement` 后：`requirement-reviewing`
- `approve-requirement` 后：`requirement-approved`
- `write-tech-design` / `write-tech-design-complete` / `review-tech-design`：推进技术设计三态
- `write-dev-tasks` 后：`task-breakdown`
- `approve-dev-start` 后：`developing`
- `review-code` 后：`code-reviewing` 或回退 `developing`
- `approve-code` 后：`code-approved`
- `merge-feature-branch` 后：`merging`
- `writeback-prd-sdd` 后：`writing-back`
- `cr-archive` 成功回写后：`archived`
- owner 主动撤回：`withdrawn`

## 读取契约（启动序）

1. 读 `AGENTS.md`、`dir-graph.yaml`
2. 读 `dir-graph.yaml#change-request-track.state_machine`
3. 读 `change-requests/{CR-ID}/cr.md` frontmatter — 获取当前 status

## 输入参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `cr_id` | 是 | 例 `CR-2026-001` |
| `next_status` | 是 | 目标 status 值（必须属于新四阶段状态机枚举） |
| `trigger` | 是 | 触发本次转换的 Skill / 事件，必须匹配 state_machine.transitions[].trigger |
| `expected_current_status` | 否 | 调用方期望的当前状态；可为单值或状态数组，若实际状态不在允许集合内则 abort |
| `updated_at` | 否 | 时间戳，默认当前时间 |
| `commit_mode` | 否 | `standalone` \| `embedded`，默认 `standalone` |

## 操作步骤

1. 读取 `change-requests/{CR-ID}/cr.md` frontmatter，获取当前 status。
2. 若提供 `expected_current_status`，必须与当前 status 一致；若提供状态数组，当前 status 必须包含在数组内。
3. 读取 `change-request-track.state_machine.transitions[]`，按 `(current_status, next_status, trigger)` 查找合法转换：
   - `from` 可为具体状态，也可为 `any-active` 等 `state_machine.wildcards` 中定义的集合。
   - `next_status` 必须属于 transitions[].to 或 terminal 中出现的状态。
   - 若找不到匹配转换，返回 `CR_STATUS_TRANSITION_NOT_ALLOWED`，不得写文件。
4. 将 `change-requests/{CR-ID}/cr.md` frontmatter 的 `status` 字段更新为 `{next_status}`，将 `updated` 更新为当前时间。
5. 保留 `owners` / `owner-history` / 顶层兼容 `owner` 字段不变。
6. 若 `commit_mode=standalone`，Commit：`[cr] status {CR-ID} {current_status} -> {next_status}`。
7. 若 `commit_mode=embedded`，不 commit，只返回已验证的 status patch 和调用方必须一并提交的文件清单。

## 不做

- 不写 approval.yml（由 approve-* / cr-review-record 负责）
- 不修改 `owners.*`；角色 owner 变更只能由 `requirement-register` 初始化或 `handover-cr` / `resume-from-remote` 的角色移交逻辑更新
- 不移动到 _history.yml（由 cr-archive 负责）

## 关于 withdrawn 状态

当 `next_status=withdrawn` 时，本 Skill 只更新 cr.md frontmatter 的 status；是否归档由 `cr-archive` 负责。

> 兼容说明：旧文档中的 `cr-id` / `next-status` 仅作为历史别名理解；新 pipeline 与 skill 参数必须使用 `cr_id` / `next_status`。

## 输出

- `cr.md` frontmatter status 更新（权威状态源，CR-2026-018；`_backlog.yml` 退化为注册索引，不再含 status 字段）

## 错误码

| 错误码 | 含义 |
|---|---|
| `CR_STATUS_NOT_FOUND` | `_backlog.yml`（注册索引）中不存在指定 CR 条目 |
| `CR_MD_STATUS_MISSING` | `cr.md` 与 `_backlog.yml` 中均无 status（无法确定当前状态） |
| `CR_MD_WRITE_FAILED` | 推进时写入 `cr.md` 失败（cr.md 缺失或无 frontmatter），硬失败不留半状态 |
| `CR_STATUS_CURRENT_MISMATCH` | 实际 status 与 `expected_current_status` 不一致 |
| `CR_STATUS_TRANSITION_NOT_ALLOWED` | 状态机中不存在 `(current_status, next_status, trigger)` 合法转换 |
| `CR_STATUS_EMBEDDED_PATCH_ONLY` | `commit_mode=embedded` 时返回给调用方的非错误结果，表示已校验并生成 patch |

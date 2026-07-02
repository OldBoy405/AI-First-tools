---
name: review-alignment
description: Review Alignment：按新四阶段 CR 模型检测 PRD↔SDD↔TASK↔代码↔writeback traceability 的跨节点 drift，读取 CR worktree 与 specs traceability，不使用旧 feature/* 分支。
---
<!-- meta
id: review-alignment
title: Review Alignment (Cross-Node Drift Detection)
status: active
kind: skill
scope: quality-gate
readonly: true
-->

# Review Alignment Skill

跨节点对齐校验器：检测 PRD ↔ SDD ↔ TASK ↔ 代码 ↔ writeback traceability 任意环节的 drift（上游已变更、下游未同步）。

本 Skill 不绑定特定 status，可在任意时刻调用。phase0 中由 CR pipeline 的评审、审批或 writeback 前检查显式调用。

## 触发方式

- `quality-reviewer-agent` 路由（显式"对齐检查 / drift 检查"意图）
- `feature-writeback.pipeline` 合并前或回写后检查
- owner 手动调用
- 每日定时任务 / PR 合入前

## 读取契约（启动序）

1. 读 `dir-graph.yaml#agent_hints.skill_context.review-alignment`
2. 读 `change-requests/_backlog.yml` — 取目标 CR 的 `status` / `checkpoints[]` / `merge-commits[]`
3. 对 in-flight CR：读 knowledge-base CR worktree 中 `change-requests/{cr_id}/{prd.md,sdd.md,plan.md,tasks/,traceability.yml}`
4. 对已 writeback 的 CR：读 `specs/{spec_id}/{PRD.md,SDD.md,traceability.yml}` 与 `delivery/task/_index.yaml`
5. 代码证据仅来自 `review-code` 写入的 `review-annotations/code.yml`、`traceability.yml` 和 `_backlog.yml.merge-commits[]`；不得直接读取主工作区代码目录或旧 `feature/*` 分支

> 本 Skill **只读 + 写 traceability.yml**，不修改 PRD/SDD/TASK/代码。

## 输入参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `cr_id` | 是 | 目标 CR-ID |
| `spec_id` | 否 | 已回写时的目标 spec；若 CR 仍在途可为空 |
| `strict` | 否 | 默认 `true`；status 已进入 `tech-design-review-pending` 之后任一 hard drift 即 fail |

## 检查清单

| 项 | 通过标准 |
|---|---|
| AL-01 PRD→SDD 同步 | `prd.md` 或 `PRD.md` 更新时间 ≤ 最近 `review-annotations/sdd.yml.reviewed-at` |
| AL-02 SDD→TASK 同步 | `sdd.md` 或 `SDD.md` 更新时间 ≤ `tasks/_index.yml` 或 `delivery/task/_index.yaml` 对应条目的生成时间 |
| AL-03 TASK→代码 同步 | CR TASK 更新时间 ≤ `review-annotations/code.yml.reviewed-at`，且 code evidence 覆盖所有 TASK |
| AL-04 代码→writeback 同步 | `_backlog.yml.merge-commits[]` 中每个 active repo 均出现在 `traceability.yml.code.repos[]` |
| AL-05 requirements 指纹 | PRD.md 中 RQ/FR 条目的文本指纹未变更（检测需求文本改写但未重审） |
| AL-06 contracts 同步 | `contracts/` 下文件 mtime ≤ `traceability.reviews.sdd.contracts-completeness.at` |
| AL-07 无 stale 残留 | `traceability.requirements[].reviews.*.{perspective}.result != stale`（由 change-impact-analysis 置位） |

## 对齐矩阵（写入 traceability.yml）

检测到 drift 时追加到 `traceability.yml#drift` 数组：

```yaml
drift:
  - detected-at: "2026-05-02T10:00+08:00"
    node: sdd                    # 哪个下游节点失同步
    requirement-id: RQ-01        # 受影响的 requirement
    reason: "PRD.md 于 2026-05-02T09:30 更新，晚于 SDD 最近评审 2026-05-01T12:00"
    severity: hard               # hard | soft
    suggested-skill: review-tech-design  # 建议重新运行的 reviewer
```

同步更新 `summary.stale` 计数。

## 输出格式

```yaml
skill: review-alignment
cr_id: {cr_id}
spec_id: {spec_id 或 null}
current-status: {status}
result: pass | drift-detected
drifts:
  - { node: sdd, requirement-id: RQ-01, severity: hard, reason: "...", suggested-skill: review-tech-design }
  - { node: code, requirement-id: RQ-03, severity: hard, reason: "...", suggested-skill: review-code }
summary:
  total-drifts: 2
  hard-drifts: 2
  soft-drifts: 0
```

## 接纳标准

- 无 drift → `pass`
- 任一 hard drift 且 CR 已进入 `tech-design-review-pending` 之后 → `fail`（阻塞后续审批或 writeback）
- soft drift 记录但不阻塞
- `drafting` / `requirement-reviewing` 早期阶段 drift 仅告警（早期阶段允许频繁迭代）

## 写入

- in-flight CR：`change-requests/{cr_id}/traceability.yml#drift`（追加）
- 已回写 CR：`specs/{spec_id}/traceability.yml#drift`（追加）
- 同步更新对应 `traceability.yml#summary.stale`（重算）

## 与其他 Skill 的关系

| 关系对象 | 说明 |
|---|---|
| `change-impact-analysis` | 写方：上游变更时置 stale；本 Skill 读取 stale 标记汇总 drift |
| `review-*` | 互补：review-* 审单节点内部质量，本 Skill 审跨节点时间差 |
| `feature-writeback.pipeline` | 消费方：合并或回写前后调用 |

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
- owner 手动调用
- 每日定时任务 / PR 合入前
- **不进入 `feature-writeback` Pipeline**（CR-2026-060 AC-13：对齐巡检不参与回写流程）

## 读取契约（启动序）

本 Skill **任意状态只读**：不落盘、不写 traceability/status/annotation/review-loop/Git、不调用任何 crctl 写命令。仅读以下事实：

1. 读 `dir-graph.yaml#agent_hints.skill_context.review-alignment`
<!-- lint-prompts:ignore --> 描述性：对齐巡检只读引用
2. 读 `change-requests/{cr_id}/cr.md` frontmatter — 取目标 CR 的 `status`；读 `change-requests/_backlog.yml` — 取条目基本信息（不读 mtime/merge-commit/fingerprint）
3. 对 in-flight CR：读 knowledge-base CR worktree 中 `change-requests/{cr_id}/{prd.md,sdd.md,plan.md,tasks/}`
4. 对已 writeback 的 CR：读 `specs/{spec_id}/{PRD.md,SDD.md,traceability.yml}` 与 `delivery/task/_index.yaml`
<!-- lint-prompts:ignore --> 描述性：对齐巡检只读引用
5. 代码证据仅来自 `review-code` 写入的 `review-annotations/code.yml`；不得直接读取主工作区代码目录或旧 `feature/*` 分支

> 本 Skill **只读**：不修改 PRD/SDD/TASK/代码，不写 traceability.yml（与历史版本不同，CR-2026-060 起只读化）。

## 输入参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `cr_id` | 是 | 目标 CR-ID |
| `spec_id` | 否 | 已回写时的目标 spec；若 CR 仍在途可为空 |
| `strict` | 否 | 默认 `true`；status 已进入 `tech-design-review-pending` 之后任一 hard drift 即 fail |

## 检查清单

> 不读 mtime/merge-commit/fingerprint：同步判定只基于可观测字段（status/评审 verdict/reviewed-at）与内容一致。

| 项 | 通过标准 |
|---|---|
<!-- lint-prompts:ignore --> 描述性：对齐巡检只读引用
| AL-01 PRD→SDD 同步 | `sdd.md` 的 `cr-ref` 指向 `cr_id`，且 `review-annotations/sdd.yml` verdict=pass |
| AL-02 SDD→TASK 同步 | `plan.md` 存在且 `tasks/_index.yml` 条目 id 与 plan 交付覆盖表「主责/关联TASK」列一致 |
<!-- lint-prompts:ignore --> 描述性：对齐巡检只读引用
| AL-03 TASK→代码 同步 | `review-annotations/code.yml` verdict=pass 且 release-subjects 覆盖全部 TASK 落点仓 |
<!-- lint-prompts:ignore --> 描述性：对齐巡检只读引用
| AL-04 代码→writeback 同步 | `specs/{spec_id}/traceability.yml` 含 `- cr: {cr_id}` 段（已回写 CR） |
| AL-05 契约闭包 | 评审记录 dimensions 覆盖 PRD 声明的契约域（HTTP/CLI/Skill），缺适用项显式 N/A |
| AL-06 批准范围 | SDD「批准范围」四字段存在且 PLAN/TASK 未触碰 scope_out/zero_diff |

## 对齐矩阵（仅输出，不落盘）

检测到 drift 时仅在本次输出中列出，不写 traceability.yml：

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

**不写入**：不写 traceability.yml / status / annotation / review-loop / Git；不调用任何 crctl 写命令（`review-record`/`advance`/`backlog-set` 等一律禁止）。

## 与其他 Skill 的关系

| 关系对象 | 说明 |
|---|---|
| `review-*` | 互补：review-* 审单节点内部质量，本 Skill 审跨节点时间差 |
| `feature-writeback.pipeline` | 消费方：合并或回写前后调用 |

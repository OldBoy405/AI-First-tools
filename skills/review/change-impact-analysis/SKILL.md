---
name: change-impact-analysis
description: Change Impact Analysis
---
<!-- meta
id: change-impact-analysis
title: Change Impact Analysis
status: active
kind: skill
scope: quality-gate
readonly: false
-->

# Change Impact Analysis Skill

变更影响分析器：任一上游节点（PRD / SDD / TASK）变更时，主动回溯下游受影响节点并把对应 perspective 标记为 `stale`，强制下游重审。

## 触发方式

- `write-requirement-prd` 成功后可调用（影响 SDD/TASK/code）
- `write-tech-design` 成功后可调用（影响 TASK/code）
- `write-dev-tasks` 成功后可调用（影响 code）
- owner 手动调用（给定 `changed-file` 参数）

## 读取契约（启动序）

1. 读 `dir-graph.yaml#agent_hints.skill_context.change-impact-analysis`
2. 读 `specs/{feature-id}/traceability.yml` — 当前对齐状态
3. 读被变更文件的 git diff（`crctl git diff HEAD~1 -- {changed-file} --cwd <worktree>`）
4. 若由 `write-*` 自动触发，上游已传入 `changed-file` 与 `feature-id`

## 输入参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `feature-id` | 是 | 目标 feature |
| `changed-file` | 是 | 被变更的文件路径（相对 workspace） |
| `changed-requirements` | 否 | 若上游已解析出受影响 RQ-NN 列表则直接使用，否则本 Skill 自行解析 diff |

## 影响传播规则

| 变更文件 | 受影响的下游节点（对应 perspective 置 stale） |
|---|---|
| `specs/{id}/PRD.md` 或 `change-requests/{CR-ID}/prd.md` | `reviews.tech-design.prd-alignment` · `reviews.code.implementation-coverage` |
| `specs/{id}/SDD.md` 或 `change-requests/{CR-ID}/sdd.md` | `reviews.code.sdd-coverage` · `reviews.code.drift-sync` |
| `specs/{id}/contracts/*` | `reviews.sdd.contracts-completeness` · `reviews.code.implementation-coverage` |
| `delivery/task/TASK-*` | `reviews.code.task-traceability` · `reviews.code.implementation-coverage` |
| `constraints/feature-flags.yml` | `reviews.code.drift-sync` · `reviews.release.feature-flag-sync` |

## 检查清单

| 项 | 通过标准 |
|---|---|
| IA-01 diff 解析 | 能从 diff 中识别出受影响的 RQ-NN 列表（通过 heading/anchor 扫描） |
| IA-02 影响范围定位 | 按上表规则定位下游 perspective 集合 |
| IA-03 stale 标记 | 将每个受影响 `requirements[].reviews.{node}.{perspective}.result` 改为 `stale` |
| IA-04 change-log 记录 | 向 `traceability.yml#change-log` 追加变更事件 |
| IA-05 summary 同步 | 重算 `summary.stale`；`status=covered` 的 requirement 若有 stale perspective 则降级为 `stale` |

## 对齐矩阵（写入 traceability.yml）

```yaml
change-log:
  - at: "2026-05-02T09:30+08:00"
    source: "specs/collaboration-dashboard/PRD.md"
    diff-hash: "sha256:a3f2..."
    affected-requirements: ["RQ-01", "RQ-03"]
    affected-nodes: [sdd, task, code]
    marked-stale:
      - "RQ-01.reviews.sdd.prd-alignment"
      - "RQ-01.reviews.task.sdd-coverage"
      - "RQ-03.reviews.sdd.prd-alignment"
    triggered-by: write-requirement-prd
```

## 输出格式

```yaml
skill: change-impact-analysis
feature-id: {feature-id}
source-file: {changed-file}
result: pass | no-impact
affected:
  requirements: [RQ-01, RQ-03]
  nodes: [sdd, task, code]
  perspectives: [
    "RQ-01.sdd.prd-alignment",
    "RQ-01.task.sdd-coverage",
    "RQ-03.sdd.prd-alignment"
  ]
suggested-actions:
  - "下次 architecture-design 时，review-tech-design 将重新运行 prd-alignment perspective"
  - "下次 code-implementation 时，review-code 将重新运行 implementation-coverage perspective"
```

## 接纳标准

- 解析 diff 成功（即使无受影响 RQ 也返回 `no-impact`）
- 所有受影响 perspective 均成功置 stale
- change-log 追加成功

## 写入

- `specs/{feature-id}/traceability.yml#requirements[].reviews.*.result`（置 `stale`）
- `specs/{feature-id}/traceability.yml#change-log`（追加）
- `specs/{feature-id}/traceability.yml#summary.stale`（重算）

## 与其他 Skill 的关系

| 关系对象 | 说明 |
|---|---|
| `write-requirement-prd` / `write-tech-design` / `write-dev-tasks` | 上游触发方；写入成功后可调用本 Skill |
| `review-alignment` | 下游消费方；读取 stale 标记汇总 drift |
| `quality-reviewer-agent` | 在下次 stage-gate 时，stale perspective 会被强制重新评审 |

---
name: spec-query
description: 多维度 spec baseline 检索：按 status/scope/version/owner/priority 过滤已回写 PRD.md、SDD.md 与历史记录；在途需求委托 cr-query。
---

<!-- meta
id: spec-query
title: Spec Query
status: active
kind: skill
scope: spec-query
readonly: true
-->

# spec-query — Spec Baseline 多维检索

对应 CR 体系的 `cr-query`。本 Skill 只查询已回写到 `specs/{id}/` 的 baseline 事实与历史记录；仍在 `change-requests/` 中推进的在途需求统一委托 `cr-query` 或 `cr-show`。

> phase0 不再把 `specs/` 当作在途状态源。`specs/` 只代表已回写、可审计的 PRD / SDD / traceability baseline；在途状态属于 CR backlog。

## 触发意图

- "查询 spec / 列出所有 baseline"
- "哪些 spec 已回写"
- "v0.12.0 包含哪些特性"
- "P0 的特性有哪些"
- "umasuo 负责的 feature"
- "已发布（ga）的 spec 列表"
- "在途需求有哪些"（转交 `cr-query`）

## 读取契约（启动序）

1. 读 `AGENTS.md`
2. 读 `dir-graph.yaml` — 解析 specs baseline 路径（默认 `specs/`）与 CR backlog 路径
3. 根据查询目标读取对应数据源：
   - baseline 当前索引 → `specs/_index.yml`
   - baseline 历史记录 → `specs/_history.yml`
   - 在途需求 → 委托 `cr-query` 读取 `change-requests/_backlog.yml`

## 输入参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `status` | 否 | draft / active / ga / archived（默认查全部 baseline） |
| `scope` | 否 | 产品域或仓库域 |
| `target-version` | 否 | 如 v0.12.0 |
| `owner` | 否 | 负责人 |
| `priority` | 否 | P0 / P1 / P2 |
| `include_inflight` | 否 | true 时附带调用 `cr-query` 展示在途 CR 摘要 |

> 所有参数均可省略，省略时返回全量列表。

## 输出格式

```
查询条件: status=ga, priority=P0

结果（共 N 条）:
┌─────────────────────────────┬────────┬────────────┬──────────┬──────────┐
│ id                          │ status │ version    │ priority │ owner    │
├─────────────────────────────┼────────┼────────────┼──────────┼──────────┤
│ ai-cr-workflow              │ ga     │ v0.12.0    │ P0       │ umasuo   │
│ agent-task-board            │ active │ v0.12.0    │ P0       │ umasuo   │
└─────────────────────────────┴────────┴────────────┴──────────┴──────────┘

在途 CR（include_inflight=true 时）:
- CR-2026-001 [developing] ...
```

## 约束

- 只读，不修改任何文件
- 不读取旧式在途 spec backlog 文件，不使用旧 `stage=prd/sdd/task/dev/review` 作为 spec 状态
- 无匹配结果时返回空列表并提示当前可用的过滤值

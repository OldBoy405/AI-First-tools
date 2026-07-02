---
name: spec-show
description: 展示单个 spec baseline 完整状态：PRD摘要/SDD摘要/版本/status/traceability覆盖率，只读
---

<!-- meta
id: spec-show
title: Spec Show
status: active
kind: skill
scope: spec-query
readonly: true
-->

# spec-show — Spec Baseline 详情查看

对应 CR 体系的 `cr-show`。展示已回写 spec baseline 从 PRD 到 traceability 的完整现状快照；在途 CR 请使用 `cr-show`。

## 触发意图

- "查看 {feature-id} 详情 / 现状"
- "spec 概览 / feature 信息"
- "{feature-id} 现在在哪个阶段"

## 读取契约（启动序）

1. 读 `AGENTS.md`
2. 读 `dir-graph.yaml` — 解析 specs baseline index/history 路径
3. 读 `specs/_index.yml` — 获取 name / status / since / updated / cr-ref
4. 若 index 无该 id → 读 `specs/_history.yml` — 查历史记录
5. 读 `specs/{feature-id}/PRD.md` — frontmatter（status / title）+ 功能需求节（统计 RQ/FR 数量）
6. 读 `specs/{feature-id}/SDD.md`（若存在） — frontmatter（status）+ 章节数统计
7. 读 `specs/{feature-id}/traceability.yml`（若存在） — summary（covered/partial/missing）

## 输入参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `feature-id` | 是 | specs index 或 history 中的 id |

## 输出格式

```
Feature: {feature-id}  [{title}]
Status:  {status}  |  Since: {since}  |  Updated: {updated}
CR Ref:  {cr-ref 或 N/A}

PRD:  {status} — {N} 条需求 ({RQ-01~RQ-NN})
SDD:  {status} — {N} 个设计章节    （若 SDD.md 不存在则显示"未创建"）
Contracts: {存在 | 未创建}

Traceability:
  covered={N} / partial={N} / missing={N}  （共 {total} 条需求）
  健康度: {coverage}%

Blockers（missing > 0 时展示）:
  - {RQ-id}: {text}（尚无 SDD/TASK/commit 覆盖）
```

若 spec 在 history（已 ga）：
```
Feature: {feature-id}  [GA ✓]
Released: {target-version}  |  Archived: {archived-date}
RELEASE: {release-ref}
```

## 约束

- 只读，不修改任何文件
- 若 feature-id 在 index 和 history 中均不存在 → 返回 NOT_FOUND，并提示在途需求请使用 `cr-query` / `cr-show`

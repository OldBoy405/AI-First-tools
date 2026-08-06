---
name: write-planning-report
description: 汇总调研期所有分析输出，生成完整产品规划报告并落盘到 docs/product-planning/，是规划期的核心必选节点。
---

# Skill: write-planning-report

**类型**: 规划期 Skill（planning/ 组，必选）  
**调用时机**: product-planning pipeline 第 5 节点（人工审批前）

---

## 用途

汇集本次调研期的所有分析输出（用户反馈洞察、市场调研、竞品分析、当前产品快照），生成完整产品规划报告，落盘到 `docs/product-planning/{YYYY-MM-DD}-{slug}.md`。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | string | ✅ | 规划主题（写入报告标题） |
| `target_version` | string | ❌ | 目标版本号（写入 frontmatter） |
| `prev_outputs` | string | ❌ | 上游节点产物摘要（由 pipeline 自动注入） |
| `review_feedback` | object | ❌ | 来自 review-planning-report 的 blockers、repair-instructions；存在时进入自修复模式 |
| `self_repair_attempt` | number | ❌ | 当前自动修复轮次，由 pipeline reviewLoop 注入 |

---

## 执行步骤

### Step 1 — 汇总上游输入

读取对话上下文中的所有上游节点输出（analyze-user-feedback / conduct-market-research / run-competitive-analysis / analyze-current-product），将可用输出合并为规划报告的输入素材。若某节点标记为 SKIPPED，则对应章节填写"本次调研跳过此维度"。

### Step 2 — 生成规划报告

若存在 `review_feedback`，先进入自修复模式：

1. 读取 `review_feedback.blockers`、`repair-instructions` 与上一版规划报告。
2. 只围绕被指出的问题修订同一报告内容；不得无关扩写或重排已确认章节。
3. 在报告末尾维护 `## 修订记录`，记录 `self_repair_attempt`、修复时间和 fixed-blockers。
4. 输出必须包含 fixed-blockers，供下一轮 `review-planning-report` 核对。

按以下结构生成报告：

```yaml
---
id: planning-{YYYY-MM-DD}-{slug}
type: PLANNING-REPORT
title: {topic} 产品规划报告
date: {YYYY-MM-DD}
target-version: {target_version 或 tbd}
status: draft
summary: "{规划摘要第一段，30-80 字的执行摘要（从报告正文首节提炼）}"
---
```

报告章节：
1. **规划摘要**（Executive Summary，3-5 句）
2. **调研背景** — 触发本次规划的关键事件 / 数据
3. **用户反馈洞察** — 引用 analyze-user-feedback 输出（或"已跳过"）
4. **市场与竞品信号** — 引用 conduct-market-research + run-competitive-analysis 输出
5. **当前产品现状** — 引用 analyze-current-product 输出
6. **规划建议** — 综合以上分析，给出 P0/P1/P2 优先级建议列表
7. **路标建议** — 版本节奏建议（哪些功能进哪个版本）
8. **待决策项** — 需人工审批确认的关键决策点

### Step 3 — 落盘

路径：`docs/product-planning/{YYYY-MM-DD}-{slug}.md`

> **id 与文件名对齐规则**：
> - `_index.yml` 新增 entry 时，`id` 字段填写**不带 `planning-` 前缀**的值（即 `{YYYY-MM-DD}-{slug}`），与文件名保持一致，确保 `readIndexedCollection` 能按 id 正确定位文件。
> - frontmatter 内部的 `id` 字段保持完整格式 `planning-{YYYY-MM-DD}-{slug}`，由 frontmatter 优先覆盖规则在 UI 层呈现完整 id。

若文件已存在且不是自修复模式，在文件名追加 `-v{N}` 后缀。若是自修复模式，修订原规划报告路径，保持 review 与 human approval 引用稳定。

### Step 4 — 输出摘要

输出落盘路径、报告摘要、"待决策项"清单，以及自修复模式下的 fixed-blockers，供下一轮 `review-planning-report` 使用。只有评审通过后才进入人工审批。

---

## 错误处理

| 场景 | 处理 |
|------|------|
| 所有上游节点均 SKIPPED | 仍然生成框架报告，各章节填写"本次调研跳过此维度"（与 Step 1 部分跳过表述统一，FR-23） |
| `docs/product-planning/` 不存在 | 自动创建目录 |

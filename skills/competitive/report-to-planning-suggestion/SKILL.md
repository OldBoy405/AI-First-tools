---
name: report-to-planning-suggestion
description: 读取指定竞品分析报告，结合产品上下文快照生成 DESIGN-DOC 规范的产品规划建议草稿（仅对话输出，不落盘）。
---

# 报告转产品规划建议 (Report to Planning Suggestion)

## 概述

读取已落盘的竞品分析报告，结合 `gather-product-context` 产出的最新产品快照，经 `brainstorming` 融合分析后，委托 `planning-draft` 生成符合 `DESIGN-DOC` 规范的产品规划建议草稿。

**本 Skill 仅输出到对话上下文，不落盘任何文件。** 落盘由调用 Agent 在用户确认后走 `engineering-docs` 与 `validate-doc`。

---

## 输入参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `reportPath` | 否（与 reportDraft 二选一） | 竞品报告路径，形如 `docs/competitive/reports/{competitor-id}-{YYYY-MM-DD}.md`；与 `reportDraft` 同时存在时优先 |
| `reportDraft` | 否（与 reportPath 二选一） | 结构化草稿（node-2 `write-competitive-report(confirmed=false)` 产出，草稿模式不落盘）：`body`（正文 markdown）/ `competitorId` / `reportDate` / `sourceNodeId` / `sourceRef` |
| `focus` | 否 | 规划焦点提示（如 "v0.16" / "2026-Q3" / "AI 能力"），传给 planning-draft |

`reportPath` 与 `reportDraft` 同时存在时优先 `reportPath`；草稿模式只消费输入生成规划建议，不落盘竞品报告。

---

## 前置条件

1. `reportPath` 与 `reportDraft` 必须二选一；`reportPath` 模式要求该路径存在且为 `docs/competitive/reports/` 下的合法报告文件，`reportDraft` 模式要求提供 `body`/`competitorId`/`reportDate`（草稿模式不落盘，无需文件存在）
2. `reportPath` 模式的报告 frontmatter 必须包含 `competitorId` 与 `reportDate`；`reportDraft` 模式由草稿字段承载同等信息
3. workspace 存在可读的 `docs/product-planning/_index.yml`、`specs/_index.yml` 或 `change-requests/_backlog.yml`（`gather-product-context` 能够产出快照）

---

## 执行流程

```
① 读 reportPath → 提取 frontmatter + 正文 5 个章节
   校验 frontmatter.competitorId 是否存在
      ↓
② 委托 gather-product-context → 获取结构化产品快照
      ↓
③ 委托 brainstorming → 输入 {报告摘要, 产品快照, focus 提示}
   探索：
     - 本次竞品动向是否暴露我方空白点
     - 是否与 baseline spec 或在途 CR 冲突、重叠
     - 可能影响的版本主题与优先级
      ↓
④ 委托 planning-draft → 如实传参：`intent`（=从 brainstorming 结论提炼的一句话规划意图）+ `context`（=产品快照）——与 planning-draft 参数表对齐（FR-23，CR-2026-022）
   生成符合 DESIGN-DOC 规范的规划建议草稿（Markdown）
      ↓
⑤ 将完整草稿输出到对话，并明确提示：
   「以上为草稿，仅基于 {reportPath} 与产品快照生成；
    确认后由 competitive-analyst-agent 调用 engineering-docs
    落盘到 docs/product-planning/，再调 validate-doc 校验。」
```

---

## 输出内容（仅对话，不落盘）

输出为两段：

1. **溯源说明**（顶部）：
   - 来源报告：`reportPath`
   - 对应竞品：`competitorId` + name（从报告 frontmatter 读取）
   - 产品快照生成时间
   - focus（若提供）

2. **规划建议草稿**（主体）：
   沿用 `product-planning-agent` 定义的 `DESIGN-DOC` 结构：
   - YAML Frontmatter（由后续 `engineering-docs` 生成，此处仅展示内容主体）
   - 规划背景与目标
   - 现状分析（含竞品动向摘要）
   - 版本规划建议
   - 依赖与风险
   - 成功指标
   - 下一步行动建议

---

## 读写清单

```yaml
report-to-planning-suggestion:
  read:
    - docs/competitive/reports/*.md     # reportPath 模式
    - reportDraft.body                  # reportDraft 模式（草稿不落盘）
  write: []
  delegates:
    - gather-product-context
    - brainstorming     # 目标运行时未提供 brainstorming 时，直接委托 planning-draft（降级路径）
    - planning-draft
    - engineering-docs      # 仅由调用 Agent 在用户确认后触发
    - validate-doc          # 同上
```

---

## 错误处理

| 场景 | 行为 |
|------|------|
| `reportPath` 与 `reportDraft` 均未提供 | 中止并提示调用方二选一提供 |
| `reportPath` 不存在或不在 `docs/competitive/reports/` 下 | 中止并提示用户先用 `write-competitive-report` 生成报告 |
| `reportDraft` 缺 `body`/`competitorId`/`reportDate` | 中止并提示草稿结构不完整（预期五字段：body/competitorId/reportDate/sourceNodeId/sourceRef） |
| 报告 frontmatter 缺少 `competitorId` | 中止并提示报告格式异常，建议重新生成 |
| `gather-product-context` 快照为空 | 降级提示：当前产品上下文为空，规划建议仅基于竞品动向，可能粒度较粗 |
| `brainstorming` / `planning-draft` 失败 | 透传错误，返回部分产出并注明降级 |

---

## 注意事项

1. **只读入口**：本 Skill 不落盘；落盘必须由调用 Agent 在用户确认后显式走 `engineering-docs`
2. **完整展示**：规划草稿不得省略章节
3. **草稿状态提示**：输出时必须明确标注「以上为草稿」
4. **溯源可追**：输出顶部必须展示 `reportPath` 与 `competitorId`，便于审阅者回到报告原文核对
5. **前端入口契约**：平台前端竞品报告详情页「转为规划建议」按钮后续通过 `reportPath` 入参触发本 Skill

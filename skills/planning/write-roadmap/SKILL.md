---
name: write-roadmap
description: 人工审批通过后，将规划报告中的版本节奏建议追写/更新到 docs/product-planning/roadmap.md，完成调研规划期的最终输出。
---

# Skill: write-roadmap

**类型**: 规划期 Skill（planning/ 组）  
**调用时机**: product-planning pipeline 最后节点（人工审批通过后）

---

## 用途

将规划报告中已审批通过的版本节奏建议追写到 `docs/product-planning/roadmap.md`，保持路标文档的持续更新。若文件不存在则新建。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | string | ✅ | 本次规划主题（用于路标条目标题） |
| `target_version` | string | ❌ | 版本号；若为空则从规划报告 frontmatter 中读取 |
| `planning_report_path` | string | ❌ | 规划报告文件路径（由 pipeline 自动注入） |

---

## 执行步骤

### Step 1 — 读取规划报告

读取 `{{planning_report_path}}` 中的"路标建议"章节，提取各版本的功能集与时间节点。

### Step 2 — 读取现有路标

读取 `docs/product-planning/roadmap.md`（若不存在则视为空文档）。

### Step 3 — 合并更新

追写/更新规则：
- 若路标中已存在 `{{target_version}}` 条目：在该版本条目下追加本次规划新增的功能项（不删除已有内容）
- 若路标中无该版本：在合适位置（按版本号顺序）插入新版本节

路标格式约定：

```markdown
## 路标（Roadmap）

> 最后更新：{YYYY-MM-DD}

### {target_version}（{计划时间范围}）
**主题**：{版本主题}

| 功能 / CR | 优先级 | 来源 | 状态 |
|---------|-------|------|------|
| {feature-id 或 CR-ID}（{title}） | P0 | planning-{date} | 规划中 |
```

### Step 4 — 落盘

幂等写回 `docs/product-planning/roadmap.md`。

Commit：`[planning] update roadmap for {topic} (${target_version})`

### Step 5 — 输出摘要

```
✅ 路标更新完成
   文件     : docs/product-planning/roadmap.md
   新增条目 : {N} 条
   版本节   : {target_version}
```

---

## 注意事项

1. **幂等**：重跑不产生重复条目（按功能 ID 去重）
2. **只追加不删除**：不得删除路标中已有的条目，仅新增或更新状态字段
3. **不影响 specs/**：路标文件仅位于 `docs/product-planning/`，与 specs/ 无关

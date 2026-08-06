---
name: conduct-market-research
description: 基于指定主题执行市场调研，输出结构化市场洞察报告并落盘到 docs/market-insights/，供 product-planning pipeline 调用。
---

# Skill: conduct-market-research

**类型**: 规划期 Skill（planning/ 组）  
**调用时机**: product-planning pipeline 第 2 节点；也可独立触发

---

## 用途

针对规划主题执行市场调研（行业趋势、用户规模、技术方向、竞争格局），生成结构化市场洞察报告，落盘到 `docs/market-insights/`。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | string | ✅ | 调研主题（如"AI 编程助手市场"） |
| `target_version` | string | ❌ | 关联目标版本，写入报告 frontmatter |
| `focus_areas` | string | ❌ | 重点调研方向，逗号分隔（如"用户规模,技术趋势,竞争格局"） |

---

## 执行步骤

### Step 1 — 跳过检查

若 pipeline 传入 `skip_market=true`，输出 `SKIPPED（skip_market=true）` 并立即返回。

### Step 2 — 调研内容生成

基于 `topic` 和 `focus_areas`，梳理以下维度：
1. **市场规模与增长**：TAM/SAM/SOM 估算（标注数据来源与置信度）
2. **主要玩家格局**：市场份额分布与近期动向（引用参考来源）
3. **用户需求趋势**：痛点演化、诉求变化
4. **技术演进方向**：关键技术栈趋势
5. **对产品规划的影响**：2-3 条可落地的洞察

### Step 3 — 落盘

文件路径：`docs/market-insights/market-{YYYY-MM-DD}-{slug}.md`

> 约束：文件名必须与 frontmatter `id` 一致，即 `id: market-{YYYY-MM-DD}-{slug}` 对应 `docs/market-insights/market-{YYYY-MM-DD}-{slug}.md`。

```yaml
---
id: market-{YYYY-MM-DD}-{slug}
type: MARKET_INSIGHT
title: {topic} 市场洞察
summary: {一句话总结，建议 50-100 字}
category: industry-trend
source: {主要公开来源，多个来源用分号分隔为单行字符串}
createdAt: {YYYY-MM-DD}
target-version: {target_version 或 tbd}
status: published
pinned: false
---
```

- `category` 可按实际内容改为 `industry-trend` / `user-voice` / `pricing` / `regulation`
- `source` 必须是字符串，不使用数组，保证前端 adapter 能直接读取
- `createdAt` 与前端 adapter 的主字段一致

同时更新 `docs/market-insights/_index.yml`：

```yaml
schema: market-insight-index/v1
# 单一事实源：本文件 schema 由 CR-2026-022 统一定义，新增写入方须先对齐本声明
# 生命周期：raw → briefed → published；顶层 key=insights；type=MARKET_INSIGHT；file 必填
title: 市场洞察索引
insights:
  - id: market-{YYYY-MM-DD}-{slug}
    type: MARKET_INSIGHT
    title: {topic} 市场洞察
    category: {category}
    status: published
    file: docs/market-insights/market-{YYYY-MM-DD}-{slug}.md
    createdAt: {YYYY-MM-DD}
    pinned: false
```

### Step 4 — 输出摘要

输出落盘路径与 3 条关键结论摘要。

---

## 错误处理

| 场景 | 处理 |
|------|------|
| `topic` 为空 | 停止执行，要求补充调研主题 |
| `docs/market-insights/` 不存在 | 自动创建目录 |
| 同名文件已存在 | 在文件名追加 `-v2` 后缀，避免覆盖 |

---
name: extract-market-insight
description: 将用户输入的市场、用户反馈或竞品洞察原始素材提取为结构化 raw insight，并写入 docs/market-insights/。
---

# Skill: extract-market-insight

**类型**: 规划期 Skill（planning/ 组）  
**调用时机**: market-to-plan pipeline 第 1 节点

## 用途

把用户粘贴的市场调研、客户访谈、NPS 反馈、竞品压力或内部反馈材料，整理成可追溯的 raw insight 文档。此 Skill 是写入型 Skill，负责维护 `docs/market-insights/` 与 `_index.yml`。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `insight_source` | multiline | ✅ | 原始洞察素材 |
| `insight_type` | string | ❌ | 用户痛点 / 市场机会 / 竞品压力 / 内部反馈 / 综合 |
| `target_version` | string | ❌ | 关联目标版本；可为空 |
| `owner` | string | ❌ | 记录人；默认 `product-owner` |

## 执行步骤

### Step 1 — 前置校验

1. 读取 `AGENTS.md` 与 `dir-graph.yaml`。
2. 从 `dir-graph.yaml#knowledge-docs.subdirs.market-insights` 解析市场洞察目录；缺失时默认 `docs/market-insights/`。
3. `insight_source` 不能为空；若为空，返回 `INSIGHT_SOURCE_EMPTY`。

### Step 2 — 提取关键信号

从原始素材中提取：

- 高频痛点 TOP5。
- 机会点列表。
- 量化数据摘录。
- 来源可信度评估。
- 待验证假设。
- 与现有 baseline spec 或在途 CR 的可能关联。

不要编造来源中没有的数据。无法确认的内容写入 `assumptions[]` 或 `open_questions[]`。

### Step 3 — 写入 raw insight

写入文件：

```text
docs/market-insights/market-{YYYY-MM-DD}-{slug}.md
```

frontmatter：

```yaml
---
id: market-{YYYY-MM-DD}-{slug}
type: MARKET_INSIGHT
status: raw
insight_type: {insight_type}
target_version: {target_version 或 unassigned}
owner: {owner}
created_at: {YYYY-MM-DDTHH:mm:ss+08:00}
source_kind: pasted
---
```

正文包含：

1. 原始素材摘要。
2. 关键信号。
3. 机会点。
4. 量化证据。
5. 可信度与局限。
6. 待验证问题。

### Step 3.5 — 简报附加区块（FR-32，CR-2026-022：write-insight-brief 合并下线，增量能力并入本 Skill）

当调用方请求简报（原 write-insight-brief 场景）时，在正文后附加输出一份 ≤800 字的产品洞察简报：执行摘要 → 核心机会 → 风险与不确定性 → 建议关注方向 → 待人工决策问题；并将 `docs/market-insights/_index.yml` 对应条目 status 从 `raw` 推进为 `briefed`（生命周期 raw → briefed → published）。

### Step 4 — 维护索引

在 `docs/market-insights/_index.yml` 中追加或更新对应条目：

```yaml
# 单一事实源：本文件 schema 由 CR-2026-022 统一定义，新增写入方须先对齐本声明（顶层 insights:/type=MARKET_INSIGHT/生命周期 raw→briefed→published）
insights:
  - id: market-{YYYY-MM-DD}-{slug}
    type: MARKET_INSIGHT
    file: docs/market-insights/market-{YYYY-MM-DD}-{slug}.md
    status: raw
    insight_type: {insight_type}
    target_version: {target_version 或 unassigned}
    created_at: {timestamp}
```

### Step 5 — 输出摘要

输出 raw insight 路径、提取出的机会点数量、待验证问题数量；若本次生成了简报（见 Step 4 附加区块），一并输出简报路径与推进后的 `_index.yml` 状态。

## 错误处理

| 错误 | 处理 |
|------|------|
| `insight_source` 为空 | 停止执行，返回 `INSIGHT_SOURCE_EMPTY` |
| `_index.yml` 不存在 | 初始化新建 |
| 目录不存在 | 创建 `docs/market-insights/` |

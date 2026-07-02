---
name: write-insight-brief
description: 基于 raw market insight 撰写产品洞察简报，并将 docs/market-insights/_index.yml 中对应条目推进为 briefed。
---

# Skill: write-insight-brief

**类型**: 规划期 Skill（planning/ 组）  
**调用时机**: market-to-plan pipeline 第 2 节点

## 用途

读取 `extract-market-insight` 生成的 raw insight，整理成可供产品规划使用的洞察简报。简报仍属于过程态/探索型知识，写入 `docs/market-insights/`，后续若人工确认，再由 `write-planning-entry` 写入产品规划知识库。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `source` | string | ✅ | raw insight 文件路径或上一节点输出中的文件路径 |
| `target_version` | string | ❌ | 关联目标版本 |
| `owner` | string | ❌ | 记录人；默认 `product-owner` |

## 执行步骤

### Step 1 — 前置校验

1. 读取 `source` 指向的 raw insight 文档。
2. 确认 frontmatter `type=MARKET_INSIGHT` 且 `status=raw` 或 `status=briefed`。
3. 读取 `docs/market-insights/_index.yml`，定位对应 id。

### Step 2 — 撰写洞察简报

输出一份不超过 800 字的简报，结构如下：

1. 执行摘要。
2. 核心机会。
3. 风险与不确定性。
4. 建议关注的需求方向。
5. 需要人工决策的问题。

简报只基于 raw insight 和已存在的 workspace 上下文，不新增未经验证的外部事实。

### Step 3 — 写入 brief 文档

写入：

```text
docs/market-insights/brief-{YYYY-MM-DD}-{slug}.md
```

frontmatter：

```yaml
---
id: brief-{YYYY-MM-DD}-{slug}
type: MARKET_INSIGHT_BRIEF
status: briefed
source: {source}
target_version: {target_version 或 unassigned}
owner: {owner}
created_at: {YYYY-MM-DDTHH:mm:ss+08:00}
---
```

### Step 4 — 更新索引

将 `docs/market-insights/_index.yml` 中 raw insight 条目更新为：

```yaml
status: briefed
brief_ref: docs/market-insights/brief-{YYYY-MM-DD}-{slug}.md
briefed_at: {timestamp}
```

### Step 5 — 输出摘要

输出 brief 文件路径、建议方向数量、待决策问题数量，以及下一步 `planning-draft` 的输入路径。

## 错误处理

| 错误 | 处理 |
|------|------|
| source 不存在 | 停止执行，返回 `INSIGHT_SOURCE_NOT_FOUND` |
| source 不是 MARKET_INSIGHT | 停止执行，返回 `INVALID_INSIGHT_SOURCE` |
| _index.yml 缺失 | 不阻塞 brief 生成，但输出警告并初始化索引 |

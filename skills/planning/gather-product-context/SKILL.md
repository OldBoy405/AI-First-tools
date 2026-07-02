---
name: gather-product-context
description: 聚合 workspace 全量产品知识，生成结构化产品上下文快照，供产品规划分析使用（纯只读）。
---

<!-- meta
category: product-planning
requires: [read, grep, glob]
outputs: [markdown-summary]
delegates: [spec-query, cr-query]
-->

# 产品上下文聚合技能 (Gather Product Context Skill)

## 概述

本技能用于汇聚 workspace 中所有与产品规划相关的知识，生成一份结构化的**产品上下文快照**。
快照输出到对话上下文，供 `product-planning-agent` 或其他 Agent 分析使用。

**本技能纯只读，不写入任何文件。**

---

## 数据来源

所有路径从 `dir-graph.yaml` 动态解析，**不得硬编码**：

| 数据类型 | dir-graph 路径键 | 实际路径 | 说明 |
|---------|----------------|---------|------|
| 版本节奏与功能大盘 | `knowledge-docs.subdirs.product-planning` | `docs/product-planning/_index.yml` | 宏观规划现状 |
| Baseline spec 索引 | `specs.index` 或默认路径 | `specs/_index.yml` | 已回写 PRD/SDD baseline，委托 `spec-query` |
| Baseline spec 历史 | `specs.history` 或默认路径 | `specs/_history.yml` | 已归档/GA baseline |
| 需求想法草稿 | `knowledge-docs.subdirs.ideas` | `docs/ideas/` | 尚未进入 spec 流程 |
| 竞品分析 | `knowledge-docs.subdirs.competitive` | `docs/competitive/` | 最近 5 篇 |
| 市场洞察 | `knowledge-docs.subdirs.market-insights` | `docs/market-insights/` | 最近 5 篇 |
| 活跃变更请求 | `change-request-track.backlog` | `change-requests/_backlog.yml` | 委托 `cr-query` |
| 当前工作焦点 | `runtime.files[focus.yml]` | `focus.yml` | 当前聚焦方向 |

---

## 执行流程

### 步骤 1 — 路径解析

读取 `dir-graph.yaml`，解析上表中所有路径键对应的实际路径。

### 步骤 2 — 并行数据采集

以下数据源**并行**读取，提升效率：

**2a. 当前工作焦点**
```
读 focus.yml → 提取 current-focus, current-version, top-priorities 字段
```

**2b. 版本节奏与功能大盘**
```
读 docs/product-planning/_index.yml → 提取 versions（近 5 个）、planning entries（全量）、focus、next-directions
```

**2c. Baseline spec 索引**
```
委托 spec-query Skill → 按 status/version/owner/priority 分组统计 baseline specs
提取：spec-id、name、status、priority、owner、version、cr-ref
```

**2d. Baseline spec 历史**
```
读 specs/_index.yml 与 specs/_history.yml → 提取已回写和历史 baseline 列表
统计总数、各版本分布
```

**2e. 需求想法草稿**
```
读 docs/ideas/_index.yml → 获取条目列表
逐条读取 docs/ideas/*.md → 提取标题、摘要（前 3 行）、创建时间
```

**2f. 竞品分析（最近 5 篇）**
```
读 docs/competitive/_index.yml → 按 addedAt 排序，取最近 5 条
读对应 docs/competitive/*.md → 提取竞品名称、核心发现摘要（前 5 行）
```

**2g. 市场洞察（最近 5 篇）**
```
读 docs/market-insights/_index.yml → 按日期排序，取最近 5 条
读对应 docs/market-insights/*.md → 提取标题、关键洞察摘要（前 5 行）
```

**2h. 活跃变更请求**
```
委托 cr-query Skill（filter: status ∈ [drafting, requirement-reviewing, requirement-approved, tech-designing, tech-design-review-pending, tech-design-reviewed, task-breakdown, developing, code-reviewing, code-approved, merging, writing-back]）
提取：CR-ID、title、status、target-spec、submitter、created
```

### 步骤 3 — 结构化输出

将采集到的数据整合为标准化 Markdown 快照，输出到对话上下文。

---

## 输出格式

```markdown
## 产品上下文快照
> 生成时间：{YYYY-MM-DD HH:mm}  |  workspace：{workspace-root}

---

### 当前焦点
- **焦点版本**：{current-version}（{theme}）
- **顶优先级**：{top-priorities}
- **阻塞项**：{blockers 或 无}

---

### 版本节奏总览

| 版本 | 状态 | 主题 | 目标时间 |
|------|------|------|---------|
| v0.xx | released/in-progress/planned | ... | ... |
...（最近 5 个版本）

**下一步方向**：
- {direction-1}：{notes}
- {direction-2}：{notes}

---

### Baseline specs（status 分布）

| status | 数量 | spec 列表 |
|-------|------|---------|
| ga    | N    | spec-id (name, P0, vX.Y), ... |
| active| N    | ... |
| draft | N    | ... |

**历史 baseline（ga）**：共 N 个，最近完成：{id (name)}, ...

---

### 活跃变更请求（CR）

| CR-ID | 标题 | 状态 | 目标 spec | 提交人 |
|-------|------|------|---------|-------|
| CR-2026-001 | ... | requirement-reviewing | ... | ... |

{如无活跃 CR → "当前无活跃变更请求"}

---

### 需求想法池

| ID | 标题 | 摘要 | 创建时间 |
|----|------|------|---------|
| d-xxx | ... | ... | ... |

{如无想法 → "想法池当前为空"}

---

### 竞品分析摘要（最近 5 篇）

**{竞品名称}**（{addedAt}）
> {核心发现摘要，2-3 句话}

...

---

### 市场洞察摘要（最近 5 篇）

**{洞察标题}**（{日期}）
> {关键洞察，2-3 句话}

...

---

### 产品功能大盘

| 功能 ID | 名称 | 象限 | 优先级 | 目标版本 | 状态 | 里程碑 |
|---------|------|------|-------|---------|------|-------|
| ... | ... | core/efficiency/knowledge/review | P0/P1/P2 | vX.Y | draft/dev | ... |

---

> 快照完毕。请基于以上产品全貌进行规划分析。
```

---

## 读写清单

```yaml
gather-product-context:
  read:
    - docs/product-planning/_index.yml
    - specs/_index.yml
    - specs/_history.yml
    - docs/ideas/_index.yml
    - docs/ideas/*.md
    - docs/competitive/_index.yml
    - docs/competitive/*.md
    - docs/market-insights/_index.yml
    - docs/market-insights/*.md
    - change-requests/_backlog.yml
    - focus.yml
  write: []
  delegates: [spec-query, cr-query]
```

---

## 错误处理

### 文件不存在

```
⚠ {path} 不存在，跳过该数据源（不影响其他数据采集）
```

### 索引为空

```
ℹ {section} 当前为空（如：想法池当前为空）
```

### dir-graph.yaml 缺失

```
❌ 未找到 dir-graph.yaml，无法解析目录路径，停止执行。
   请确认 workspace 根目录下存在 dir-graph.yaml。
```

---

## 注意事项

1. **不得硬编码路径**：所有路径必须从 `dir-graph.yaml` 动态解析
2. **部分失败不中断**：单个数据源读取失败时记录警告，继续采集其他数据源
3. **内容摘要原则**：长文档只取摘要（前 5 行 / 关键字段），避免输出过长
4. **时效标注**：快照头部必须标注生成时间，提示用户数据为采集时刻的静态快照
5. **委托优先**：`spec-query` 和 `cr-query` 已实现过滤逻辑，优先委托而非直接读 yml

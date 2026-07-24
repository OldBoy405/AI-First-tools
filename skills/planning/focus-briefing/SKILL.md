---
name: focus-briefing
description: "生成今日焦点 AI 简报，聚合多源数据写入 focus.yml"
---

# focus-briefing — 生成今日焦点 AI 简报

## 触发条件

用户意图包含：生成简报、刷新简报、今日焦点、更新 focus.yml

## 职责

聚合 workspace 中多个数据源，经 LLM 提炼后写入 `focus.yml`（根目录），供前端 `loadFocusBriefing` 读取展示。

---

## 数据源（6 个）

| # | 数据源文件 | 提取逻辑 |
|---|-----------|----------|
| 1 | `delivery/task/_index.yaml` | 过滤 status=pending\|in-progress 且 priority=urgent\|important，按优先级排序取前 5 条 |
| 2 | `change-requests/_backlog.yml` | status=developing/code-reviewing/writing-back 的 CR，提醒当前主攻方向 |
| 3 | `docs/competitive/reports/_index.yml` | status=new 的最新报告，生成关注提醒 |
| 4 | `delivery/task/_index.yaml`（进行中任务） | in-progress 任务，防止遗漏 |
| 5 | `.rayai/pipelines/_index.yml` | 已激活 pipeline 列表与默认入口（可选） |
| 6 | （上下文最近操作） | 关键操作或待确认事项 |

> 以上数据源按优先级排序。若文件不存在，静默跳过，不影响整体简报生成。

---

## 执行步骤

### Step 1 — 读取数据源

```
read_file: delivery/task/_index.yaml
read_file: change-requests/_backlog.yml
read_file: docs/competitive/reports/_index.yml（可选）
read_file: .rayai/pipelines/_index.yml（可选）
```

### Step 2 — LLM 提炼

综合以上内容，用以下 prompt 模板生成 YAML：

```
你是一位高效的产品助理。根据以下工作数据，生成今日焦点简报（YAML 格式），
规则：
- items 最多 5 条，按重要程度排序
- priority: urgent | important | normal | low
- reason: 一句话说明原因（≤ 30 字）
- action: cockpit | product-insight | product-dev | knowledge | ai-partner（可选）
- summary: 总结句（≤ 25 字）
```

### Step 3 — 写入 focus.yml

```yaml
schema: rayai.focus/v1
date: "{YYYY-MM-DD}"
summary: "..."
items:
  - id: b1
    title: "..."
    priority: urgent
    reason: "..."
    action: cockpit
  - id: b2
    ...
```

使用 `write_file` 覆盖写入 workspace 根目录的 `focus.yml`。

---

## 输出

- 文件：`focus.yml`（workspace 根目录）
- schema 必须为 `rayai.focus/v1`
- date 字段为当日日期（`YYYY-MM-DD`）
- items 数组 1~5 条

## 校验清单

- [ ] schema 字段值为 `rayai.focus/v1`
- [ ] date 字段为今日日期
- [ ] items 不为空
- [ ] 每条 item 含 id / title / priority / reason
- [ ] priority 值合法（urgent | important | normal | low）

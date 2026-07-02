---
name: analyze-current-product
description: 读取 specs baseline 索引、change-requests/_backlog.yml、metrics.yml，生成当前产品状态快照，供规划期全程使用。
---

# Skill: analyze-current-product

**类型**: 规划期 Skill（planning/ 组）  
**调用时机**: product-planning pipeline 第 4 节点；也可独立触发获取产品现状快照

---

## 用途

汇总当前产品的 baseline spec 完成状态、在途 CR、关键指标与技术债，生成"当前产品分析报告"（对话内），供后续 write-planning-report 节点使用。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | string | ✅ | 规划主题，用于高亮相关特性 |
| `target_version` | string | ❌ | 若指定，额外分析该版本的完成进度 |

---

## 执行步骤

### Step 1 — 跳过检查

若 pipeline 传入 `skip_product=true`，输出 `SKIPPED（skip_product=true）` 并立即返回。

### Step 2 — 读取数据源

并行读取（只读）：
- `specs/_index.yml` — 已回写 baseline spec（status / since / owner / cr-ref）
- `specs/_history.yml` — 历史 baseline / GA 记录（版本归属）
- `change-requests/_backlog.yml` — 在途需求 CR（status / cr_id）
- `metrics.yml` — 产品关键指标（若存在）
- `focus.yml` — 当前焦点版本声明

### Step 3 — 生成产品现状分析

输出以下维度：

**3a. Baseline 完成度**
- 按版本统计已回写 / 历史归档 / 待回写 CR 数量
- 识别当前焦点版本完成率

**3b. 在途需求 CR 情况**
- 统计各阶段 CR 数量（drafting / requirement-approved / developing / ...）
- 识别阻塞风险（超期 CR）

**3c. 关键指标摘要**（若 metrics.yml 存在）
- 列出 North Star 指标当前值 vs 目标值

**3d. 技术债与规划风险**
- 识别长期停留在同一 CR status 的需求
- 识别跨版本遗留的 P0 需求

**3e. 对本次规划的建议**
- 与 `topic` 相关的 baseline spec 与在途 CR 状态总结
- 2-3 条数据驱动的规划建议

---

## 注意事项

1. **只读**：本 Skill 不修改任何文件
2. **增量输入**：若任一数据文件缺失，跳过该维度并注明"数据不可用"

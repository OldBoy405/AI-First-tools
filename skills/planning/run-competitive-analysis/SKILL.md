---
name: run-competitive-analysis
description: 薄封装，委托 fetch-competitor-updates + write-competitive-report 执行竞品分析，并汇总结论供规划期使用。
---

# Skill: run-competitive-analysis

**类型**: 规划期 Skill（planning/ 组，薄封装）  
**调用时机**: product-planning pipeline 第 3 节点

---

## 用途

协调调用现有 `fetch-competitor-updates` 和 `write-competitive-report` skill，针对本次规划主题获取最新竞品动态，并将结论汇总为规划可用的格式。本 Skill 本身不直接写文件，由被委托的 skill 完成落盘。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | string | ✅ | 规划主题，用于定向搜索竞品相关功能 |
| `competitors` | string | ❌ | 指定竞品名称，逗号分隔；留空则从 `docs/competitive/` 已有报告中推断 |

---

## 执行步骤

### Step 1 — 跳过检查

若 pipeline 传入 `skip_competitive=true`，输出 `SKIPPED（skip_competitive=true）` 并立即返回。

### Step 2 — 委托 fetch-competitor-updates

调用 `fetch-competitor-updates` skill，参数：
- `competitors`: `{{competitors}}`（若为空则使用已有竞品列表）
- `focus`: `{{topic}}`

### Step 3 — 委托 write-competitive-report

调用 `write-competitive-report` skill，基于 Step 2 的输出生成/更新报告，落盘到 `docs/competitive/reports/`。

### Step 4 — 生成规划摘要

从竞品报告中提取与 `{{topic}}` 最相关的 3-5 条规划启示，输出到对话上下文：

```markdown
## 竞品分析规划启示（主题：{topic}）

| 竞品 | 近期动向 | 对我方规划的启示 |
|------|---------|----------------|
| ...  | ...     | ...            |

### 差异化机会
- {机会点 1}
- {机会点 2}
```

---

## 注意事项

1. 本 Skill 不重复实现竞品抓取逻辑，完全复用现有 skill
2. 若 `fetch-competitor-updates` 或 `write-competitive-report` 执行失败，本 Skill 标记为部分完成（PARTIAL），不中止 pipeline（`onFail: skip`）

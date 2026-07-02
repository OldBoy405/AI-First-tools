---
name: cr-dashboard
description: "CR 全局看板，展示 SLA 风险与阻塞项"
---

# Skill: cr-dashboard

**类型**: 只读 Skill（全局视图类）  
**触发时机**: 用户请求"CR 全局看板"、"变更管理概览"、"CR 健康状态"

---

## 用途

以看板形式展示 CR 体系的全局健康状态：各状态分布、SLA 红线、阻塞项、近期活动。用于日常 standup / 周会的变更管理仪表盘。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `period` | string | ❌ | 统计周期，如 `7d`（默认）/ `30d` / `all` |
| `focus` | enum | ❌ | `sla`（仅展示 SLA 风险）/ `blocked`（仅展示阻塞项）/ `all`（默认） |

---

## 操作步骤

### Step 1 — 读取数据

1. 读取 `change-requests/_backlog.yml` → `backlog[]`（在途 CR）
2. 读取 `change-requests/_history.yml` → `history[]`（已归档 CR，按 `period` 过滤）
3. 读取 `change-requests/_config.yml`（获取 SLA 阈值）

### Step 2 — 计算指标

**在途 CR 状态分布**（按 `backlog[].status` 分组计数，状态枚举来自 `dir-graph.yaml#change-request-track.state_machine`）：

| 状态 | 数量 |
|------|------|
| drafting | N |
| requirement-reviewing | N |
| requirement-approved | N |
| tech-designing | N |
| tech-design-review-pending | N |
| tech-design-reviewed | N |
| task-breakdown | N |
| developing | N |
| code-reviewing | N |
| code-approved | N |
| merging | N |
| writing-back | N |

**SLA 风险检测**（对比 _config.yml 中的 sla 阈值）：

- emergency-fix：若状态停留在 `drafting` / `requirement-reviewing` 超过配置阈值，标记 🔴
- standard-change：若状态停留在 `requirement-reviewing` / `tech-design-review-pending` / `code-reviewing` 超过配置阈值，标记 🟡
- normal-change：若状态停留在任一人工等待态超过配置阈值，标记 🟡

**近期活动**（从 _history.yml 中按 period 过滤）：
- 本周新开 CR 数、归档 CR 数、archived 数、rejected 数、withdrawn 数

### Step 3 — 构造看板输出

```
╔══════════════════════════════════════════════════════════╗
║              CR 变更管理看板  (2026-05-04)               ║
╚══════════════════════════════════════════════════════════╝

📊 在途 CR（共 N 条）
  drafting                    ████░░░░░░  3
  requirement-reviewing       ██░░░░░░░░  1   ← 待需求评审
  tech-design-review-pending  ███░░░░░░░  2
  developing                  ██░░░░░░░░  2
  code-reviewing              █░░░░░░░░░  1

🚨 SLA 风险（N 条）
  ┌─ 🔴 CR-2026-007  [emergency-fix]  requirement-reviewing 已 6h → 超出需求评审 SLA（4h）
  │     提交人: zhang-san | 等待审查
  └─ 🟡 CR-2026-004  [standard-change] code-reviewing 已 80h → 接近 SLA（72h）

⛔ 阻塞项
  ┌─ CR-2026-003  developing → code-reviewing 阻塞（review-code 未通过）
  └─ 无其他阻塞

📈 近 7 天活动
  新开  : 5 条
  归档  : 3 条（archived: 2 / rejected: 1）
  合并率: 67%

──────────────────────────────────────────────────────────
💡 行动建议：
  1. CR-2026-007 超 SLA，请立即指派审查人
  2. CR-2026-003 需清除 review-alignment blockers 后推进
──────────────────────────────────────────────────────────
详情：cr-show CR-ID | 查询：cr-query | 收件箱：cr-inbox
```

---

## 注意事项

- 只读操作，不修改任何文件
- SLA 计算基于文件中记录的时间戳，非实时，精度为文件最后更新时间
- 若 _backlog.yml 为空，显示"当前无在途 CR"
- `focus=sla` 模式只显示 SLA 风险区块；`focus=blocked` 只显示阻塞项区块

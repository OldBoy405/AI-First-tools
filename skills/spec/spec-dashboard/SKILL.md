---
name: spec-dashboard
description: "Spec/CR 全局看板，展示 baseline 版本分组、在途 CR 状态分布、Blockers 汇总与 traceability 健康度"
---

# Skill: spec-dashboard

**类型**: 只读 Skill（全局视图类）  
**触发时机**: 用户请求「spec 全局看板」、「feature 各阶段分布」、「当前进展概览」、「spec 健康状态」

---

## 用途

以看板形式展示 spec baseline 与在途 CR 的全局健康状态：已回写 baseline 的版本分组、在途 CR 状态分布、Blockers 汇总、traceability 覆盖率。用于日常 standup / 迭代规划会的产品交付仪表盘。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `version` | string | ❌ | 过滤指定版本，如 `v0.13.0`；默认展示所有在途版本 |
| `focus` | enum | ❌ | `blockers`（仅展示阻塞项）/ `health`（仅展示健康度）/ `all`（默认） |

---

## 操作步骤

### Step 1 — 读取数据

1. 读取 `specs/_index.yml` → 已回写 baseline 列表。
2. 读取 `specs/_history.yml` → 历史 baseline / GA 记录。
3. 扫描 `change-requests/{CR-ID}/cr.md` frontmatter → 在途 CR 列表与状态分布。
4. 对每个 baseline spec，若其目录下存在 `traceability.yml`，则读取 `traceability.summary`。

### Step 2 — 计算指标

**在途 CR 状态分布**（按 `change-requests/{CR-ID}/cr.md` frontmatter `status` 分组计数）：

| 状态 | 含义 | 数量 |
|------|------|------|
| drafting | 需求草稿 | N |
| requirement-approved | 需求已审批 | N |
| tech-design-reviewed | 技术设计已审批 | N |
| developing | 开发中 | N |
| code-reviewing | 代码评审中 | N |
| writing-back | 回写中 | N |

**版本分组**（按 `specs/_index.yml#features[].since` 与 CR `target-version` 聚合）：

- 对每个版本列出已回写 baseline（id + name + status + cr-ref）。
- 对每个版本列出在途 CR（id + title + status + owner）。
- 未指定版本的 baseline / CR 归入「未分配版本」桶。

**Blockers 汇总**（traceability 异常）：

- 读取每个 baseline spec 的 `traceability.yml`，若存在 `summary.missing > 0` 或 `summary.partial > 0` 则标记为 Blocker。
- 读取在途 CR 的 `review-annotations/*` 与 `traceability.yml`，汇总 blocker CR。

**健康度计算**：

```
coverage_pct(spec) = summary.covered / (summary.covered + summary.partial + summary.missing) × 100
health = avg(coverage_pct) across all baseline specs that have traceability.yml
baseline specs without traceability.yml → 单独列出，标注"未建立追溯"
```

### Step 3 — 构造看板输出

```
╔══════════════════════════════════════════════════════════╗
║            Spec / CR 看板  (2026-05-05)                   ║
╚══════════════════════════════════════════════════════════╝

📊 在途 CR（共 N 个）
  drafting              ███░░░░░░░  3   需求草稿
  requirement-approved  ██░░░░░░░░  2   需求已审批
  developing            ████░░░░░░  4   开发中
  code-reviewing        █░░░░░░░░░  1   代码评审中

📦 版本分组
  v0.13.0（焦点版本）
    ├─ ai-cr-workflow          [baseline ga]
    ├─ agent-task-board        [baseline active]
    └─ CR-2026-001             [developing]

  v0.14.0（规划中）
    ├─ knowledge-baseline      [baseline active]
    └─ CR-2026-002             [requirement-approved]

  未分配版本（N 个）
    └─ ...

⛔ Blockers（traceability 缺口）
  ┌─ ai-cr-workflow      missing=1  → FR-07 尚无 commit 覆盖
  ├─ CR-2026-003         blocker=2  → 需求评审未通过
  └─ 无其他阻塞

🔬 Traceability 健康度
  整体覆盖率: 82%  (N 个 baseline spec 已建立追溯)
  ┌─ 未建立追溯: agent-permission-policy / release-runbook ...
  └─ 健康（covered=100%）: ai-cr-workflow / review-gate ...

──────────────────────────────────────────────────────────
💡 行动建议：
  1. CR-2026-003 需求评审存在 blocker，建议先修复 PRD 再进入架构设计
  2. agent-permission-policy 尚未建立 traceability.yml，建议在回写阶段补齐
──────────────────────────────────────────────────────────
详情：spec-show {spec-id} | 在途：cr-show {CR-ID} | 查询：spec-query / cr-query
```

---

## 注意事项

- 只读操作，不修改任何文件
- 若 `change-requests/_backlog.yml` 为空，显示「当前无在途 CR」
- 健康度计算仅针对已创建 `traceability.yml` 的 baseline spec；无追溯文件的 spec 单独列出，不计入平均值
- `focus=blockers` 模式只显示 Blockers 区块；`focus=health` 只显示健康度区块
- traceability 时间戳非实时，精度为文件最后更新时间

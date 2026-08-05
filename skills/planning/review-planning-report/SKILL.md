---
name: review-planning-report
<!-- lint-prompts:ignore --> 描述性：规划评审自有记录路径
description: 对 docs/product-planning/ 下的产品规划报告执行 AI 评审，输出评审记录到 docs/product-planning/review-annotations/；未通过时回到 write-planning-report 自修复，通过后才允许进入人工审批。
---

# Skill: review-planning-report

**类型**: 规划期 Skill（planning/ 组）  
**调用时机**: product-planning pipeline 中 `write-planning-report` 之后、`human_approval` 之前

---

## 用途

读取刚生成的产品规划报告，检查其调研依据、规划建议、路标建议、成功指标与待决策项是否足以进入人工审批。若发现 blocker，必须输出结构化修复意见并由 pipeline 的 `reviewLoop` 回到 `write-planning-report` 自动修订；只有 `approved=true` 且 `blockers=[]` 时，才能进入 `human_approval`。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `planning_report_path` | string | ❌ | 规划报告路径；为空时从上一节点输出中提取 `docs/product-planning/*.md` |
| `topic` | string | ❌ | 规划主题，用于评审摘要 |
| `target_version` | string | ❌ | 目标版本号 |
| `reviewer` | string | ❌ | 评审人 ID；默认 `ai-reviewer` |
| `self_repair_attempt` | number | ❌ | 当前 reviewLoop 轮次；首次评审为 0，自修复后由 pipeline 注入 |

---

## 执行步骤

### Step 1 — 定位规划报告

优先读取 `planning_report_path`。若为空，从上一节点输出中提取 `docs/product-planning/{id}.md` 路径。报告 ID 取文件名去掉 `.md`。

### Step 2 — 执行评审

检查以下维度：

1. **调研依据完整性**：用户反馈、市场、竞品、当前产品分析是否明确说明已使用或已跳过。
2. **建议可执行性**：P0/P1/P2 建议是否有清晰理由、范围边界和预期价值。
3. **路标可落地性**：目标版本或季度节奏是否可转写到 `roadmap.md`。
4. **成功指标**：是否包含可观测的产品或交付指标。
5. **待决策项**：是否明确列出需要人工审批确认的决策。

### Step 3 — 写评审记录

<!-- lint-prompts:ignore --> 描述性：规划评审自有记录路径
创建目录 `docs/product-planning/review-annotations/`（若不存在），写入：

```yaml
schema: planning-report-review/v1
review-type: planning-report
source-report: docs/product-planning/{report-id}.md
report-id: {report-id}
reviewer: {reviewer}
reviewed-at: {YYYY-MM-DDTHH:mm:ss+08:00}
approved: true|false
summary: "{1-3 句评审摘要}"
blockers:
  - "{阻断人工批准的问题；没有则为空数组}"
repair-target: write-planning-report
repair-instructions:
  - "{面向 write-planning-report 的可执行修订动作；approved=true 时为空数组}"
review-loop:
  pass-condition:
    allOf:
      - path: approved
        equals: true
      - path: blockers
        isEmpty: true
  on-block: route-to-repair-node
  max-attempts: 3
  current-attempt: {self_repair_attempt 或 0}
  attempts:
    - attempt: {self_repair_attempt 或 0}
      reviewed-at: {YYYY-MM-DDTHH:mm:ss+08:00}
      result: pass | block
      blocker-count: {N}
      repair-target: write-planning-report
risks:
  - "{非阻断风险；没有则为空数组}"
recommendations:
  - "{建议人工审批时关注的点；没有则为空数组}"
```

<!-- lint-prompts:ignore --> 描述性：规划评审自有记录路径
路径：`docs/product-planning/review-annotations/{report-id}.yml`

### Step 4 — 更新索引状态

若 `docs/product-planning/_index.yml` 中存在对应 `features[].id == {report-id}` 条目，将 `status` 从 `draft` 更新为 `reviewing`。若不存在对应条目，只写评审记录，不创建索引条目。

### Step 5 — 输出摘要

输出评审记录路径、`approved` 结论、blocker 数量、当前轮次信息、`repair-target`、`repair-instructions` 和下一步：

- PASS：允许进入 `human_approval`。
- BLOCK：不得进入 `human_approval`，将当前评审记录作为 `review_feedback` 传给 `write-planning-report` 自动修订。

---

## 错误处理

| 场景 | 处理 |
|------|------|
| 找不到规划报告路径 | abort，说明无法进入人工审批 |
| 报告为空或无法读取 | abort，要求重新执行 write-planning-report |
| `_index.yml` 更新失败 | 不阻断评审记录写入，但在输出摘要中标记风险 |
| 达到 reviewLoop.maxAttempts 后仍有 blocker | 停止进入人工审批，输出剩余 blocker 与最后一次修复记录 |

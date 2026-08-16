---
name: write-requirement-prd
description: 在 requirement/CR-* worktree 内编写 PRD 需求文档，落盘到 change-requests/{CR-ID}/prd.md，遵循 PRD 规范。
---

# Skill: write-requirement-prd

**类型**: 需求期 Skill（requirement/ 组）  
**调用时机**: requirement-authoring pipeline 第 2 节点

---

## 用途

在已创建的 CR worktree 内，根据用户提供的需求信息编写完整 PRD，落盘到 `change-requests/{CR-ID}/prd.md`。

> ⚠️ **路径约定**：PRD 写入 `change-requests/{CR-ID}/prd.md`，**不写入 specs/**（specs/ 在回写期才更新）。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID（如 CR-2026-003） |
| `source` | string | ❌ | 规划报告路径或其他输入来源，用于内容提炼 |
| `review_feedback` | object | ❌ | 来自 review-requirement 的 blockers；存在时进入自修复模式 |
| `self_repair_attempt` | number | ❌ | 当前自动修复轮次，由 pipeline reviewLoop 注入 |

---

## 执行步骤

### Step 1 — 前置校验

1. 确认 `change-requests/{cr_id}/cr.md` 存在且 `status: drafting`
2. 确认 knowledge-base worktree `.rayai-worktrees/knowledge-base/requirement/{cr_id}` 存在（若不存在，停止并提示先执行 requirement-register）

### Step 2 — 读取上下文

- 读取 `change-requests/{cr_id}/cr.md` 获取 title / summary / target-version / source / owners.requirement
- `summary` 中已确认的边界（注册阶段拍板或审批确认的范围/排除项）与当前上下文无冲突时优先原样采纳进 PRD 范围与 AC，不以换措辞方式重新定义已拍板事项
- 若 `source` 指向规划报告路径，读取报告中对应功能的规划建议
- 若存在 `review_feedback`，读取上一轮 `review-annotations/requirement.yml` 中的 blockers 与 reviewer 摘要

### Step 3 — 生成 PRD

若存在 `review_feedback`，先进入自修复模式：

1. 逐条处理 `review_feedback.blockers`（blocker 字符串内含可执行修复说明），修订同一份 `prd.md`。
2. 保持已确认的 title、target-version、owner 和需求范围不被无关改写。
3. 对每条修复增加可核查证据，例如新增/修改的 FR、AC、NFR 或范围说明。
4. 修订完成后重新提交，由下一轮 `review-requirement` 校验。

PRD 结构：

```yaml
---
id: {cr_id}-prd
type: PRD
cr-ref: {cr_id}
title: {cr.md.title}
target-version: {target_version}
owner: {cr.md owners.requirement.id}
owner-role: requirement
status: draft
created: {YYYY-MM-DDTHH:mm:ss+08:00}
updated: {YYYY-MM-DDTHH:mm:ss+08:00}
---
```

章节：
1. **概述** — 问题陈述与解决方案摘要
2. **用户故事** — US-* 列表（角色 + 行为 + 价值）
3. **功能需求** — FR-* 列表（必须可量化 / 可测试）
4. **非功能需求** — 性能 / 安全 / 兼容性
5. **验收标准** — AC-* 列表（对应每条 FR）
6. **成功指标** — 上线后如何度量成功
7. **范围排除** — 明确不做的内容

### Step 4 — 落盘

落盘到当前 knowledge-base worktree（`.rayai-worktrees/knowledge-base/requirement/{cr_id}`）的 `change-requests/{cr_id}/prd.md`。

Commit：`feat({cr_id}): draft PRD - {title}`

### Step 5 — 更新 _backlog.yml

运行 `crctl backlog-set {cr_id} --field prd-path --value change-requests/{cr_id}/prd.md --workspace <worktree>`（S5：白名单字段写，模型不得直接编辑 `_backlog.yml`）。

### Step 6 — 输出摘要

```
✅ PRD 已生成
   文件   : change-requests/{cr_id}/prd.md
   FR 数  : {N}
   US 数  : {N}
   下一步 : 以 `crctl next {cr_id}` 为准
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| CR status 非 drafting | 停止执行，提示 CR 当前状态与预期不符 |
| worktree 不存在 | 停止执行，要求先运行 requirement-register |
| prd.md 已存在 | 进入编辑模式（追加/修改），不覆盖已有内容；若存在 review_feedback，则优先按 blocker 定点修复 |

---
name: write-tech-design
description: 读取 change-requests/{CR-ID}/prd.md，在同目录编写 sdd.md 技术设计文档，覆盖架构/数据模型/接口/算法/选型五大章节。
---

# Skill: write-tech-design

**类型**: 开发期 Skill（develop/ 组）
**调用时机**: architecture-design pipeline 第 1 节点
**前置要求**: 初次生成时 CR status = `requirement-approved`；reviewLoop 回修时允许 CR status = `tech-designing`

---

## 用途

以 PRD 为输入，在 CR worktree 内编写完整 SDD 技术设计文档，落盘到 `change-requests/{CR-ID}/sdd.md`。初次生成时从 `requirement-approved` 进入，开始时将 CR status 推进到 `tech-designing`；落盘完成后推进到 `tech-design-review-pending`（待技术评审）。当 `review-tech-design` 发现 blocker 并把 status 回退到 `tech-designing` 后，本 Skill 必须允许以 reviewLoop 回修模式重新进入。

> ⚠️ **路径约定**：SDD 写入 `change-requests/{CR-ID}/sdd.md`，**不写入 specs/**。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `tech_context` | string | ❌ | 额外技术背景（架构决策/已知约束） |
| `review_feedback` | object | ❌ | 来自 review-tech-design 的 blockers、repair-instructions；存在时进入自修复模式 |
| `self_repair_attempt` | number | ❌ | 当前自动修复轮次，由 pipeline reviewLoop 注入 |

---

## 执行步骤

### Step 1 — 前置校验

1. 确认 `change-requests/{cr_id}/prd.md` 存在。
2. 读取本 CR 涉及的目标代码仓根目录 `ARCHITECTURE.md`（依 `dir-graph.yaml#repositories` 解析；多仓 CR 逐仓检查）了解整体架构约束：
   - **已存在**：直接读取，继续下一项（读取 CR 当前 status）。
   - **不存在**（该仓首次走到技术设计评审，按需懒加载起草，成本只付一次）：本 Agent 花一轮读该仓代码（入口文件、目录结构、依赖方向、已有约定），套用 `skills/shared/engineering-docs/templates/ARCHITECTURE-template.md` 填成实际内容（禁止留占位符），落盘到该仓根目录 `ARCHITECTURE.md`，与 `sdd.md` 同一 commit 提交。在 Step 5 输出摘要中标注"新起草 ARCHITECTURE.md（{repo}）"，随本轮 `review-tech-design`/`approve-tech-design` 人工过一眼确认，不另开审批节点。
   - 仅在文件缺失时起草；已存在则只读不改——普通 CR 不得借道修订它（架构级变更需求见该文档自身"维护规则"一节）。
3. 读取 CR 当前 status：
   - 初次生成：必须为 `requirement-approved`，随后调用 `cr-status-set`（`next_status=tech-designing`，`trigger=write-tech-design`，`expected_current_status=requirement-approved`）将 status 推进到 `tech-designing`。
   - reviewLoop 回修：若存在 `review_feedback`，或 `change-requests/{cr_id}/review-annotations/sdd.yml` 的 `verdict=block`，允许当前 status 为 `tech-designing`，不得因非 `requirement-approved` abort。
   - 其他状态：停止执行，输出当前 status、是否存在 `review_feedback` 与下一步建议。

### Step 2 — 生成 SDD

若存在 `review_feedback`，或 status=`tech-designing` 且上一轮 `review-annotations/sdd.yml verdict=block`，先进入自修复模式：

1. 读取上一轮 `review-annotations/sdd.yml` 与 `review_feedback.blockers`；若 `review_feedback` 缺失，则从 `sdd.yml` 的 blockers、repair-target、repair-instructions 组装修复输入。
2. 按 `repair-instructions` 修订同一份 `sdd.md`，重点补齐 PRD↔SDD 映射、接口契约、数据模型、风险与测试设计。
3. 不重写已确认的整体方案，除非 blocker 明确要求替换。
4. 输出 `self_repair_attempt`、fixed-blockers 与仍需人工关注的残余风险，供下一轮 `review-tech-design` 校验。

```yaml
---
id: {cr_id}-sdd
type: SDD
cr-ref: {cr_id}
title: {prd.title} 技术设计
status: draft
created: {YYYY-MM-DDTHH:mm:ss+08:00}
updated: {YYYY-MM-DDTHH:mm:ss+08:00}
---
```

章节：
1. **架构概览** — 模块边界、依赖图、关键流程
2. **数据模型** — 核心实体、字段定义、存储方案
3. **接口契约** — API / IPC / 事件接口（OpenAPI 片段或 TypeScript 类型）
4. **关键算法与流程** — 核心逻辑伪代码 / 流程图描述
5. **技术选型与替代方案** — 决策说明与权衡
6. **FR 到技术实现映射** — 每条 FR-* 对应的技术方案条目
7. **安全与性能考量** — 边界条件、性能目标、安全控制点

### Step 3 — 落盘并 commit

落盘到 `change-requests/{cr_id}/sdd.md`。
Commit：`feat({cr_id}): draft SDD - tech design`

### Step 4 — 推进状态至待评审

sdd.md 完整落盘后，调用 `cr-status-set`（`cr_id={cr_id}`，`next_status=tech-design-review-pending`，`trigger=write-tech-design-complete`，`expected_current_status=tech-designing`）将 CR 推进到「待技术评审」状态，等待 `review-tech-design` 进入。

### Step 5 — 输出摘要

```
✅ SDD 已生成
   文件       : change-requests/{cr_id}/sdd.md
   FR 覆盖率  : {N}/{总数}
   ARCHITECTURE.md : {已存在，直接引用 | 新起草（{repo}），随本次评审一并确认}
   当前状态   : tech-design-review-pending
   下一步     : 执行 review-tech-design
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| prd.md 不存在 | 停止执行，提示先完成 write-requirement-prd |
| 初次生成时 CR status 非 `requirement-approved` | 停止执行，展示当前 status |
| 回修模式下 CR status 非 `tech-designing` | 停止执行，展示当前 status、`review_feedback` 是否存在与上一轮 sdd review verdict |
| sdd.md 已存在 | 进入编辑模式（追加修改），不覆盖；若存在 review_feedback，则优先按 blocker 定点修复 |

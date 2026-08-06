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
2. 读取本 CR **目标代码仓**根目录的 `ARCHITECTURE.md` 了解整体架构约束。目标代码仓路径解析**必须**沿用 `code-implementation` pipeline `implement-code` 节点已定的同一套约定，禁止另行发挥：
   - 独立代码仓：`.rayai-worktrees/{repo.id}/requirement/{cr_id}`
   - 非独立代码目录：knowledge-base CR worktree（`.rayai-worktrees/knowledge-base/requirement/{cr_id}`）内对应代码路径
   - 多仓 CR：按 `dir-graph.yaml#repositories` 逐仓检查，**不得**因为找不到就退而查找会话中最近读过的其他仓（尤其是本方法论包 `tools` 仓自身）的 `ARCHITECTURE.md` 顶替
   - **仅当本 CR 的目标代码仓就是 `tools` 仓自身**（即本 CR 改的是 `tools/skills`、`crctl.mjs` 等方法论包代码）时，`tools/ARCHITECTURE.md` 才是正确的读取对象；否则它与目标仓无关，绝不可当作参考基线
   - **已存在**：直接读取，继续下一项（读取 CR 当前 status）。
   - **不存在**（该仓首次走到技术设计评审，按需懒加载起草，成本只付一次）：本 Agent 花一轮读**目标仓自己的**代码（入口文件、目录结构、依赖方向、已有约定），套用 `skills/shared/engineering-docs/templates/ARCHITECTURE-template.md` 填成实际内容（禁止留占位符），落盘到目标仓根目录 `ARCHITECTURE.md`，与 `sdd.md` 同一 commit 提交。**禁止参考 `tools/ARCHITECTURE.md` 的内容**（其不变量如"零依赖""crctl 单一状态写者"是方法论包自身治理事实，不是通用事实）——只能把它当"8 节骨架长什么样"的结构范例，绝不能抄条款。在 Step 5 输出摘要中标注"新起草 ARCHITECTURE.md（{repo}）"，随本轮 `review-tech-design`/`approve-tech-design` 人工过一眼确认，不另开审批节点。
   - 仅在文件缺失时起草；已存在则只读不改——普通 CR 不得借道修订它（架构级变更需求见该文档自身"维护规则"一节）。
3. 读取 CR 当前 status：
   - 初次生成：必须为 `requirement-approved`，随后调用 `crctl advance --to tech-designing --trigger write-tech-design --expect requirement-approved` 将 status 推进到 `tech-designing`。
<!-- lint-prompts:ignore --> 描述性：回修读取评审记录
   - reviewLoop 回修：若存在 `review_feedback`，或 `change-requests/{cr_id}/review-annotations/sdd.yml` 的 `verdict=block`，允许当前 status 为 `tech-designing`，不得因非 `requirement-approved` abort。
   - 其他状态：停止执行，输出当前 status、是否存在 `review_feedback` 与下一步建议。

### Step 2 — 生成 SDD

<!-- lint-prompts:ignore --> 描述性：回修读取评审记录
若存在 `review_feedback`，或 status=`tech-designing` 且上一轮 `review-annotations/sdd.yml verdict=block`，先进入自修复模式：

<!-- lint-prompts:ignore --> 描述性：回修读取评审记录
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
8. **Prompt 采纳影响**（条件性小节，CR-2026-021 FR-25/AC-15）：**若本 CR 的 diff 会触及 `skills/shared/crctl/scripts/crctl.mjs` 的 dispatch 分支或 `skills/shared/controlled-shell/rules.json` 的 `protectedPaths.deny`（= crctl 命令面或 guard deny 面有新增/变更）**，本节为必填，列出应改为调用新增/扩展子命令的 skill 清单（每项含 skill 路径 + 现状 + 应改为的调用方式），供 `review-tech-design` 与人工审批逐条核对；若本 CR 不触及上述两处，本节可省略。`lint-prompts` 只能机械抓到"prompt 还在做 crctl 已接管/已禁止的事"（CONTRADICTS/STALE），抓不到"crctl 新增了能力、某 skill 该采纳却还没采纳"——这一类必须靠本节 + 评审兜底。

### Step 3 — 落盘并 commit

落盘到 `change-requests/{cr_id}/sdd.md`。
Commit：`feat({cr_id}): draft SDD - tech design`

### Step 4 — 推进状态至待评审

sdd.md 完整落盘后，调用 `crctl advance --to tech-design-review-pending --trigger write-tech-design-complete --expect tech-designing` 将 CR 推进到「待技术评审」状态，等待 `review-tech-design` 进入。

### Step 5 — 输出摘要

```
✅ SDD 已生成
   文件       : change-requests/{cr_id}/sdd.md
   FR 覆盖率  : {N}/{总数}
   ARCHITECTURE.md : {已存在，直接引用 | 新起草（{repo}），随本次评审一并确认}
   当前状态   : tech-design-review-pending
   下一步     : 以 `crctl next {cr_id}` 为准
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| prd.md 不存在 | 停止执行，提示先完成 write-requirement-prd |
| 初次生成时 CR status 非 `requirement-approved` | 停止执行，展示当前 status |
| 回修模式下 CR status 非 `tech-designing` | 停止执行，展示当前 status、`review_feedback` 是否存在与上一轮 sdd review verdict |
| sdd.md 已存在 | 进入编辑模式（追加修改），不覆盖；若存在 review_feedback，则优先按 blocker 定点修复 |

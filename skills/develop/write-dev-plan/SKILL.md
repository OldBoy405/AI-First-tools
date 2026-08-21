---
name: write-dev-plan
description: 基于 change-requests/{CR-ID}/sdd.md 编写开发计划 plan.md，包含里程碑排期、任务依赖图、风险与回滚策略。
---

# Skill: write-dev-plan

**类型**: 开发期 Skill（develop/ 组）  
**调用时机**: code-implementation pipeline 第 1 节点

---

## 用途

将 SDD 转化为可执行的开发计划，落盘到 `change-requests/{CR-ID}/plan.md`，作为 write-dev-tasks 的输入基础。计划的步骤粒度约束引用 `coding-discipline` §2（2-5 分钟切分，仅在实现期生效；计划层不写步骤粒度表述）。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `target_version` | string | ❌ | 目标版本，写入 plan.md frontmatter |
| `review_feedback` | object | ❌ | 来自 review-dev-plan 的 blockers；存在时进入自修复模式（CR-2026-026 FR-8） |
| `self_repair_attempt` | number | ❌ | 当前自动修复轮次，由 pipeline reviewLoop 注入 |

---

## 执行步骤

### Step 1 — 前置校验

1. 确认 `change-requests/{cr_id}/sdd.md` 存在
2. CR status 应为 `tech-design-reviewed`

### Step 2 — 生成 plan.md

```yaml
---
id: {cr_id}-plan
type: PLAN
cr-ref: {cr_id}
sdd-ref: "change-requests/{cr_id}/sdd.md"
target-version: {target_version 或 tbd}
status: draft
created: {YYYY-MM-DDTHH:mm:ss+08:00}
updated: {YYYY-MM-DDTHH:mm:ss+08:00}
---
```

章节：
1. **交付里程碑** — 阶段划分（设计 / 实现 / 测试 / 联调 / 发布）与时间估算
2. **任务依赖图** — 各模块/接口任务的依赖关系（文字描述或 ASCII 图）
3. **资源与分工** — 预计工时分配
4. **风险与回滚策略** — 技术风险列表及对应回滚方案
5. **验收与发布策略** — 发布前 checklist / feature-flag 计划

### Step 2a — 回修模式（CR-2026-026 FR-8/FR-9）

若存在 `review_feedback`（来自 review-dev-plan 普通轨 BLOCK）：

1. 逐条消费 blockers（每条内含可执行修复说明），修订同一份 `plan.md`；只处理评审指出的问题，不扩散 SDD 范围。
2. 禁止只刷新评审证据而不修改被指出的产物（空转由下一轮评审重新读取实际产物继续 BLOCK 兜底）。
3. 回修期间允许 status=`tech-design-reviewed`（普通轨重放态），不因非 task-breakdown abort。

### Step 3 — 落盘并 commit

落盘到 `change-requests/{cr_id}/plan.md`。  
Commit：`[cr] draft dev plan {cr_id}`（白名单前缀 `[cr] `）

### Step 4 — 输出摘要

```
✅ 开发计划已生成
   文件       : change-requests/{cr_id}/plan.md
   里程碑数   : {N}
   估算总工时 : {N} 人天
   下一步     : 以 `crctl next {cr_id}` 为准
```

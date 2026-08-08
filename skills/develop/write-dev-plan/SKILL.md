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

### Step 3 — 落盘并 commit

落盘到 `change-requests/{cr_id}/plan.md`。  
Commit：`feat({cr_id}): draft dev plan`

### Step 4 — 输出摘要

```
✅ 开发计划已生成
   文件       : change-requests/{cr_id}/plan.md
   里程碑数   : {N}
   估算总工时 : {N} 人天
   下一步     : 以 `crctl next {cr_id}` 为准
```

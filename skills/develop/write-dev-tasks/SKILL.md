---
name: write-dev-tasks
description: 将 change-requests/{CR-ID}/plan.md 拆解为独立可执行的 TASK 文件，落盘到 change-requests/{CR-ID}/tasks/TASK-NN.md，是编码的唯一依据。
---

# Skill: write-dev-tasks

**类型**: 开发期 Skill（develop/ 组）  
**调用时机**: code-implementation pipeline 第 2 节点

---

## 用途

将开发计划拆解为最小可执行的 TASK 条目，每个 TASK 包含明确的目标、输入/输出、涉及文件与验收条件。TASK 是编码实施的唯一依据，开发者必须按 TASK 逐一实现。

将 CR status 推进到 `task-breakdown`。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `task_count_hint` | integer | ❌ | 预期任务数量（Agent 参考用，实际由 plan 决定） |

---

## 执行步骤

### Step 1 — 前置校验

确认 `change-requests/{cr_id}/plan.md` 和 `change-requests/{cr_id}/sdd.md` 都存在。

### Step 2 — 拆解原则

- 每个 TASK 应可在 **1-3 天内**独立完成
- TASK 粒度：一个模块 / 一类接口 / 一个组件
- 不得将"整个功能"作为单个 TASK
- 跨模块依赖必须通过 `depends-on` 字段声明

### Step 3 — 生成 TASK 文件

每个 TASK 落盘到 `change-requests/{cr_id}/tasks/TASK-{NN}.md`（NN 从 01 开始，两位补零）：

```yaml
---
id: {cr_id}-TASK-{NN}
type: TASK
cr-ref: {cr_id}
plan-ref: "change-requests/{cr_id}/plan.md"
sdd-ref: "change-requests/{cr_id}/sdd.md"
title: {任务标题}
status: pending
estimate: {N}h
depends-on: []
assignee: ""
created: {YYYY-MM-DDTHH:mm:ss+08:00}
---
```

正文：
1. **任务描述** — 目标、背景、输入条件
2. **涉及文件 / 模块** — 需要新建或修改的文件清单
3. **实现要点** — 参考 SDD 对应章节的关键实现提示
4. **验收条件** — 可执行的测试用例或验证步骤（至少 2 条）
5. **完成标志** — 定义"完成"的明确状态（如"单元测试通过 + lint 零报错"）

### Step 4 — 生成 TASK 索引

在 `change-requests/{cr_id}/tasks/_index.yml` 中汇总所有 TASK 的 id / title / status / estimate / depends-on。

### Step 5 — 推进 CR status 并 commit

- `cr-status-set`（`next_status=task-breakdown`，`trigger=write-dev-tasks`，`expected_current_status=tech-design-reviewed`）
- Commit：`feat({cr_id}): task breakdown ({N} tasks)`

### Step 6 — 输出摘要

```
✅ 任务拆分完成
   TASK 总数   : {N}
   估算总工时  : {sum}h
   依赖关系    : {有/无}
   下一步      : 执行 push-progress 或等待人工确认后开始编码
```

---

## 注意事项

1. TASK 文件是编码实施的**唯一依据**，必须足够具体（不得模糊描述）
2. 每条 TASK 的验收条件必须可被自动或手动验证

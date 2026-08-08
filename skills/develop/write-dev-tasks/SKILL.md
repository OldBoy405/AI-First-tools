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
slug: {任务标题提炼的英文 kebab-case，建议填写但非强制}
status: pending
estimate: {N}h
depends-on: []
created: {YYYY-MM-DDTHH:mm:ss+08:00}
---
```

> `slug` 供回写期 `writeback-tasks` skill 生成 `delivery/task/` 文件名用；建议填写（英文 kebab-case，从标题提炼，控制在 40 字符内），未填时回退为 `task-{NN}`（可读性差但确定性强）。CR-2026-005 起补充此字段。

正文：
1. **任务描述** — 目标、背景、输入条件
2. **涉及文件 / 模块** — 需要新建或修改的文件清单
3. **实现要点** — 参考 SDD 对应章节的关键实现提示
4. **验收条件** — 可执行的测试用例或验证步骤（至少 2 条）
5. **完成标志** — 定义"完成"的明确状态（如"单元测试通过 + lint 零报错"）
6. **接口契约** — 消费：本 TASK 使用哪些上游 TASK 产出的精确函数名/参数/返回类型；产出：本 TASK 暴露给下游 TASK 的精确签名

### Step 4 — 生成 TASK 索引

在 `change-requests/{cr_id}/tasks/_index.yml` 中汇总所有 TASK 的 id / title / status / estimate / depends-on。

**估算交叉校验（FR-23，CR-2026-022）**：汇总后核对 `plan.md` 章节 5 的估算总工时与 TASK 级 `estimate` 求和是否一致；不一致时输出 WARN 并说明差异（不静默覆盖 plan.md，由计划负责人决定以哪侧为准）。

**接口签名核对**：汇总后核对所有 TASK 声明的接口签名一致性——消费方引用的函数名/参数/返回类型必须与产出方声明的签名一致；命名对不上时输出 WARN 并列出差异（不静默覆盖，由计划负责人决定以哪侧为准）。

### Step 5 — 推进 CR status 并 commit

- `crctl advance --to task-breakdown --trigger write-dev-tasks --expect tech-design-reviewed`
- Commit：`crctl git commit --template task-breakdown --cr {cr_id} -m "{N} tasks" --cwd <worktree>`（S10，FR-10 显式直传）

### Step 6 — 输出摘要

```
✅ 任务拆分完成
   TASK 总数   : {N}
   估算总工时  : {sum}h
   依赖关系    : {有/无}
   下一步      : 以 `crctl next {cr_id}` 为准
```

---

## 注意事项

1. TASK 文件是编码实施的**唯一依据**，必须足够具体——判据：禁止 TBD/"待定"；禁止"加适当的错误处理"类空描述；禁止"同 TASK-XX"引用而不给实际签名；禁止引用未在任何 TASK 定义的类型/函数
2. 每条 TASK 的验收条件必须可被自动或手动验证

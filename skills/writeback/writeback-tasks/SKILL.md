---
name: writeback-tasks
description: writing-back 阶段任务回写：在 operational workspace 调 candidate-only generator 产出 delivery/task 回写 manifest，一次 crctl writeback-apply 深原语完成校验、应用、精确 stage、commit+trailer、lease push。
---

# Skill: writeback-tasks

**类型**: 回写期 Skill（writeback/ 组）
**调用时机**: CR 生命周期 `writing-back` 阶段（write-test-report 之后、cr-archive 之前）
**前置要求**: CR status = `writing-back`

---

## 用途

把 `change-requests/{cr_id}/tasks/` 下 `status=done` 的任务原子回写到 `delivery/task/`（拷贝 + frontmatter 注入 + 全局索引 `_index.yaml` 维护），供 archived 门禁的 deliveryIndexComplete 检查通过。
内容生成与落盘分离（CR-2026-031 TASK-08）：**candidate-only generator** 产出 manifest，**`crctl writeback-apply` 深原语**独占校验、应用、精确 stage、commit + trailer、lease push。

本 Skill 只拥有：**前置确认、一次 generator 调用、一次深原语调用、结果分类**。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `spec_id` | string | ✅ | 关联 spec ID |
| `target_version` | string | ✅ | 目标版本 |
| `operational_workspace` | string | ✅ | detached Transaction Workspace |

---

## 执行步骤

### Step 1 — 前置校验

1. 读取 `change-requests/{cr_id}/cr.md`（operational_workspace 内），确认 status=`writing-back`。
2. 确认 `tasks/_index.yml` 有 `status: done` 任务；为空则 generator 输出 noop 结束。

### Step 2 — 生成 candidate（candidate-only，零写 workspace）

```bash
node {TOOLS_ROOT}/skills/writeback/scripts/writeback-tasks.mjs \
  --workspace {operational_workspace} --cr {cr_id} --spec {spec_id} --version {target_version} \
  --candidate-out {candidate_dir}
```

输出 JSON 含 `manifestPath`。**幂等判据（SDD-BLOCK-001）**：已交付 id 集合跳过（不看文件名、不比内容）。

### Step 3 — 一次深原语应用

```text
crctl writeback-apply {cr_id} --stage tasks
  --candidate {manifestPath} --spec-id {spec_id}
  --workspace {knowledge-base 主 checkout}
```

深原语内部完成：manifest 全矩阵校验（allowlist = `delivery/task/` 前缀 + `_index.yaml`）→ 精确 stage + staged set 断言 → commit + trailer → lease push + 远端事实分类；STALE/history-rewritten 语义同 writeback-prd-sdd。

### Step 4 — 输出摘要

```
✅ 任务回写完成
   CR          : {cr_id}
   回写数量    : {N} 个
   tx          : {writeback-apply 返回 txId}
   下一步      : 以 `crctl next {cr_id}` 为准
```

---

## 已核实事实基线（纪律 #4）

| 事实 | 值 |
|---|---|
| 目标文件命名 | `TASK-{version}-{cr_id}-{NN}-{slug}.md`（slug 缺失回退 `task-{NN}`） |
| 幂等唯一判据 | `delivery/task/*.md` frontmatter 的 `id` 集合 |
| frontmatter 注入 | `spec-id` + `version`（置于 id 前） |
| 源任务读取 | `tasks/_index.yml` 账本只读（账本写入唯一经 crctl） |

---

## 错误处理

| 错误码 | 处理 |
|------|------|
| `BAD_ARGS` | 缺参，补参重跑 |
| `CR_STATUS_MISMATCH` | status 非 `writing-back`，先完成 writeback-prd-sdd 的推进 |
| `STRUCTURE_MISMATCH` | done 任务无对应 TASK-*.md 源文件，报告后停止 |
| `WRITEBACK_REMOTE_STALE` | 重跑 Step 2 后重试 |

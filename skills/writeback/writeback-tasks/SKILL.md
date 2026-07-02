---
name: writeback-tasks
description: 将 change-requests/{CR-ID}/tasks/ 下的任务文件映射为 delivery/task/TASK-*.md，维护 delivery/task/_index.yaml，标记任务与 CR、版本的关联关系。
---

# Skill: writeback-tasks

**类型**: 回写期 Skill（writeback/ 组，第 3 节点）  
**调用时机**: feature-writeback pipeline 第 3 节点  
**前置要求**: CR status = `writing-back`（writeback-prd-sdd 已完成）

---

## 用途

将开发期在 `change-requests/{CR-ID}/tasks/` 目录下生产的任务文件（TASK-NN.md）回写到 `delivery/task/`，按规范命名格式重命名为 `TASK-{ver}-{CR-NNN}-{NN}-{slug}.md`，并维护 `delivery/task/_index.yaml`。历史任务若已存在则跳过（幂等）。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID（如 CR-2026-001） |
| `spec_id` | string | ✅ | 关联的 spec ID，写入任务 frontmatter |
| `target_version` | string | ✅ | 目标版本（如 v0.16.0），用于任务文件命名前缀 |

---

## 执行步骤

### Step 1 — 前置校验

1. 读取 `change-requests/{cr_id}/cr.md`，确认 status=`writing-back`
2. 列出 `change-requests/{cr_id}/tasks/` 下所有 `.md` 文件，若为空则跳过并记录警告

### Step 2 — 命名映射规则

原始文件名格式：`TASK-{NN}.md`（两位序号，如 TASK-01.md）  
目标文件名格式：`TASK-{ver}-{CR-NNN}-{NN}-{slug}.md`

| 字段 | 来源 |
|------|------|
| `{ver}` | target_version 去掉 `v` 前缀（如 `0.16.0`） |
| `{CR-NNN}` | cr_id 中的序号段（如 `001`） |
| `{NN}` | 原始序号（如 `01`） |
| `{slug}` | 任务 frontmatter 的 `title` 字段 kebab-case 化（截取前 40 字符） |

示例：`TASK-0.16.0-001-01-write-prd-for-ai-partner.md`

### Step 3 — 复制并写入 delivery/task/

```bash
mkdir -p delivery/task/
```

对每个任务文件：
1. 读取 `change-requests/{cr_id}/tasks/TASK-{NN}.md`
2. 补全 frontmatter 字段：`cr_ref: {cr_id}`、`spec_id: {spec_id}`、`version: {target_version}`、`status: done`（开发期产物默认视为 done）
3. 写入 `delivery/task/{目标文件名}.md`
4. 若目标文件已存在（同 cr_id 同 NN），跳过并记录

### Step 4 — 维护 delivery/task/_index.yaml

在 `delivery/task/_index.yaml` 中追加或更新每个任务的索引条目：

```yaml
- id: TASK-0.16.0-001-01
  file: delivery/task/TASK-0.16.0-001-01-write-prd-for-ai-partner.md
  cr_ref: CR-2026-001
  spec_id: collaboration-dashboard
  version: v0.16.0
  status: done
  created_at: "{YYYY-MM-DDTHH:mm:ss+08:00}"
```

### Step 5 — 输出摘要

```
✅ 任务回写完成
   CR          : {cr_id}
   任务数量    : {N} 个
   目标目录    : delivery/task/
   跳过（已存在）: {M} 个
   下一步      : 执行 writeback-traceability
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| `tasks/` 目录为空 | 输出警告，跳过本 skill，继续执行 pipeline |
| frontmatter `title` 缺失 | 使用 `untitled-{NN}` 作为 slug |
| `_index.yaml` 写入冲突 | 以新写入为准，旧条目移入 `_history` 字段 |
| CR status 非 `writing-back` | 停止执行，提示当前状态 |

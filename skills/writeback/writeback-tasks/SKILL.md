---
name: writeback-tasks
description: 将 change-requests/{CR-ID}/tasks/ 下 status=done 的任务原子回写到 delivery/task/（拷贝+frontmatter+全局索引更新一步完成），供 archived 门禁的 deliveryIndexComplete 检查通过。
---

# Skill: writeback-tasks

**类型**: 回写期 Skill（writeback/ 组）
**调用时机**: CR 生命周期 `writing-back` 阶段，`write-test-report` 完成之后、`cr-archive`（推进到 `archived`）之前。**必须在 archived 转移之前调用**——`archived` 门禁的 `deliveryIndexComplete` 检查（CR-2026-005 起）会校验本 skill 的产物是否齐备，晚于 archived 调用没有意义。
**前置要求**: CR status = `writing-back`

---

## 用途

把 `change-requests/{CR-ID}/tasks/` 下 `status=done` 的任务，一次调用原子完成：拷贝为 `delivery/task/` 下规范命名的文件 + 追加 frontmatter + 更新全局 `delivery/task/_index.yaml`——消除"拷文件"与"更新索引"两个动作靠记忆分别执行、容易漏掉后者的问题（CR-2026-003 归档时曾发生：3 个任务文件被正确拷贝，但 3 条索引行漏加，直到下一个 CR 归档时才被偶然发现，见 CR-2026-005 立项背景）。

> **格式约定**：以下 id/字段/文件名格式取自 CR-2026-001~004 四个 CR 已建立的实际写法（经交叉核实一致），**不是**本文件早期版本描述的 `TASK-{ver}-{CR-NNN}-{NN}` 格式——那个格式从未被真正采用过，本次改写以实际数据为准。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID（如 CR-2026-005） |
| `spec_id` | string | ✅ | 关联的 spec ID，写入任务 frontmatter（如 `ai-first-platform`） |
| `version` | string | ✅ | 目标版本（如 `0.12.1`），写入 frontmatter 与索引 `target-version`，用于文件名前缀 |

---

## 执行步骤

### Step 1 — 前置校验

1. 读取 `change-requests/{cr_id}/cr.md`，确认 `status: writing-back`。
2. 读取 `change-requests/{cr_id}/tasks/_index.yml`，筛出 `status: done` 的任务列表；为空则输出警告并结束（无需回写）。

### Step 2 — 幂等判重（幂等的唯一依据）

读取 `delivery/task/_index.yaml`（不存在则视为空列表），取出已登记的 `id` 集合。**判断某个 done 任务是否需要回写，只看它的 `id` 是否已在这个集合里**——不比较文件内容，不看文件是否存在。已登记的直接跳过（不重写文件、不重复追加索引行）。

### Step 3 — 命名与 slug 派生

原始文件：`change-requests/{cr_id}/tasks/TASK-{NN}.md`
目标文件：`delivery/task/TASK-{version}-{cr_id}-{NN}-{slug}.md`（`{cr_id}` 用完整形式，如 `CR-2026-005`，不是纯数字段）

`{slug}` 派生规则（按序尝试，第一个命中即用，保证确定性——不做中文分词/语义猜测）：
1. 若 `TASK-{NN}.md` frontmatter 存在 `slug:` 字段 → 直接使用。
2. 否则回退 `task-{NN}`（如 `task-01`）——牺牲可读性但保证同一输入永远同一输出，是幂等性的前提。

> 建议 `write-dev-tasks` skill 生成任务文件时，在 frontmatter 里主动填一个语义化 `slug:` 字段（英文 kebab-case，从任务标题提炼），避免落入兜底分支。这是建议项，不是强制——未填不会导致本 skill 出错。

### Step 4 — 拷贝并追加 frontmatter

对每个待回写任务（Step 2 判重后剩下的）：
1. 读取源 `change-requests/{cr_id}/tasks/TASK-{NN}.md` 全文。
2. 在其 frontmatter 闭合的 `---` 之前插入两行：
   ```yaml
   spec-id: {spec_id}
   version: "{version}"
   ```
3. 写入 `delivery/task/{目标文件名}.md`（`mkdir -p delivery/task/` 若目录不存在）。

### Step 5 — 追加全局索引条目

在 `delivery/task/_index.yaml` 追加一行（字段名与既有历史条目完全一致，均为连字符命名）：

```yaml
  - id: {源任务 frontmatter 的 id 字段，如 CR-2026-005-TASK-01}
    file: {Step 4 写出的文件名，不含目录前缀}
    title: {源任务 frontmatter 的 title 字段}
    status: done
    cr-ref: {cr_id}
    target-version: "{version}"
    estimate: {源任务 frontmatter 的 estimate 字段}
```

### Step 6 — 输出摘要

```
✅ 任务回写完成
   CR          : {cr_id}
   回写数量    : {N} 个（跳过已存在 {M} 个）
   目标目录    : delivery/task/
   下一步      : 确认 change-requests/{cr_id}/tasks/_index.yml 与 delivery/task/_index.yaml 一致后执行 cr-archive
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| `tasks/_index.yml` 不存在或无 done 任务 | 输出警告，跳过本 skill，不阻塞后续流程 |
| 源任务 frontmatter 缺 `title`/`estimate` | 索引对应字段留空，不阻塞回写（写入摘要中提示待补） |
| CR status 非 `writing-back` | 停止执行，提示当前状态 |
| `delivery/task/_index.yaml` 不存在 | 视为空列表，正常创建并写入首条记录 |

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

把 `change-requests/{CR-ID}/tasks/` 下 `status=done` 的任务，一次调用原子完成：拷贝为 `delivery/task/` 下规范命名的文件 + 追加 frontmatter + 全量重建全局 `delivery/task/_index.yaml`——消除"拷文件"与"更新索引"两个动作靠记忆分别执行、容易漏掉后者的问题（CR-2026-003 归档时曾发生：3 个任务文件被正确拷贝，但 3 条索引行漏加，直到下一个 CR 归档时才被偶然发现，见 CR-2026-005 立项背景）。

**机械步骤由入库脚本执行（CR-2026-020 起）**：脚本位于 `tools/skills/writeback/scripts/writeback-tasks.mjs`。执行者只做「调脚本 → 核对 dry-run 输出 → 实跑 → 提交」。

> **格式约定**：目标文件名 `TASK-{version}-{cr_id}-{NN}-{slug}.md`（`{cr_id}` 用完整形式如 `CR-2026-005`）。`{slug}` 取源任务 frontmatter 的 `slug:` 字段，缺失回退 `task-{NN}`——由脚本内置逻辑保证，不做中文分词/语义猜测。此格式与 `writeback-traceability` SKILL / pipeline 模板三处一致（CR-2026-020 FR-8 统一）。

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

<!-- lint-prompts:ignore --> 描述性：任务回写说明
1. 读取 `change-requests/{cr_id}/cr.md`，确认 `status: writing-back`（脚本同样校验，不满足即 `CR_STATUS_MISMATCH` 硬失败）。
2. 读取 `change-requests/{cr_id}/tasks/_index.yml`，筛出 `status: done` 的任务列表；为空则脚本输出 noop 并结束（无需回写）。

### Step 2 — 调用脚本，dry-run 核对

```bash
node tools/skills/writeback/scripts/writeback-tasks.mjs \
  --workspace . --cr {cr_id} --spec {spec_id} --version {version} --dry-run
```

核对输出：将新建的文件名列表（`+ TASK-{version}-{cr_id}-{NN}-{slug}.md`）与 `delivery/task/_index.yaml` 全量重建摘要。**幂等判据（SDD-BLOCK-001 修复版）**：脚本扫描 `delivery/task/*.md` frontmatter 的 `id` 集合，已交付的 done 任务直接跳过——不看目标文件名、不比内容；因此源任务后补/修改 `slug` 再重跑不会产生第二份交付文件。

### Step 3 — 实跑 + 自检 + 提交

去掉 `--dry-run` 重跑。脚本末尾自检（新增 id 在索引中恰 1 条、frontmatter 注入齐全、全文件无 CRLF），失败输出 `SELF_CHECK_FAILED` 非零退出。成功后提交：

```bash
crctl git add delivery/task/ --cwd <knowledge-base worktree>
crctl git commit --template writeback --cr {cr_id} -m "任务回写 delivery/task {N} 项（{version}）" --cwd <knowledge-base worktree>
```

### Step 4 — 输出摘要

```
✅ 任务回写完成
   CR          : {cr_id}
   回写数量    : {N} 个（跳过已交付 {M} 个）
   目标目录    : delivery/task/
   下一步      : 确认 tasks/_index.yml 与 delivery/task/_index.yaml 一致后执行 writeback-traceability → cr-archive
```

---

## 已核实事实基线（纪律 #4，2026-08-04 核实）

| 事实 | 值 |
|---|---|
| 目标文件命名 | `TASK-{version}-{cr_id}-{NN}-{slug}.md`（version 不带 v 前缀；slug 缺失回退 `task-{NN}`） |
| 幂等唯一判据 | `delivery/task/*.md` frontmatter 的 `id` 集合（不比较内容、不看文件名） |
| frontmatter 注入 | 拷贝时在 frontmatter 顶部注入 `spec-id: {spec_id}` 与 `version: "{version}"`（置于 id 之前，与既有回写产物一致） |
| `delivery/task/_index.yaml` 结构 | 顶层 `tasks:` 列表；条目七字段 `id/file/title/status/cr-ref/target-version/estimate` 全部可从各任务文件 frontmatter 与文件名投影；重建顺序 = 既有 id 原序 + 新增按 id 排序追加 |
| 源任务读取 | `change-requests/{cr_id}/tasks/_index.yml` 为账本文件，只读（账本写入仍唯一经 crctl） |

---

## 错误处理

| 错误码 | 处理 |
|------|------|
| `BAD_ARGS` | 缺 `--workspace/--cr/--spec/--version`，补参重跑 |
<!-- lint-prompts:ignore --> 描述性：任务回写说明
| `CR_STATUS_MISMATCH` | cr.md status 非 `writing-back`，先完成 writeback-prd-sdd 的 status 推进 |
| `STRUCTURE_MISMATCH` | tasks/_index.yml 标记 done 的任务无对应 TASK-*.md 源文件，报告后停止 |
| `SELF_CHECK_FAILED` | 回写后自检断言失败，检查输出文件后重跑 |

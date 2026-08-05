---
name: writeback-prd-sdd
description: 将 change-requests/{CR-ID}/prd.md 和 sdd.md 回写到 specs/{spec_id}/PRD.md 和 SDD.md，维护 specs/_index.yml，并将 CR status 推进到 writing-back。
---

# Skill: writeback-prd-sdd

**类型**: 回写期 Skill（writeback/ 组，第 2 节点）  
**调用时机**: feature-writeback pipeline 第 2 节点  
**前置要求**: CR status = `merging`（merge-feature-branch 已完成）

---

## 用途

将需求期与开发期在 `change-requests/` 目录下生产的 PRD 和 SDD 文档正式回写到 `specs/{spec_id}/` 知识库，若该 spec 目录不存在则新建，同时维护 `specs/_index.yml` 元数据。回写完成后推进 CR status 到 `writing-back`。

**机械步骤由入库脚本执行（CR-2026-020 起）**：本 skill 不再描述逐文件手工操作；执行者只做「调脚本 → 核对 dry-run diff → 实跑 → 提交」。脚本位于 `tools/skills/writeback/scripts/writeback-prd-sdd.mjs`（版本化、可测试，回归套件 `tools/skills/writeback/scripts/test/writeback.test.mjs`）。脚本不再执行回写前旧版备份步骤——回写本身是一次提交，旧版本由 git 历史承载（CR-2026-020 FR-6）。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID（如 CR-2026-001） |
| `spec_id` | string | ✅ | 目标 spec 目录 ID（如 ai-first-platform） |
| `target_version` | string | ✅ | 本次发版目标（如 0.21），写入 spec frontmatter 与文件名 |
| `milestone_name` | string | ❌ | 里程碑节标题名（如 `治理工具链 P2`）；不传时回退 CR prd.md frontmatter 的 title |
| `brief` | string | ❌ | `specs/_index.yml` 条目 `brief` 的新一句话描述；仅显式传入时替换，不传不动 |

---

## 执行步骤

### Step 1 — 前置校验

1. 读取 `change-requests/{cr_id}/cr.md`，确认 status=`merging`（脚本同样校验，不满足即 `CR_STATUS_MISMATCH` 硬失败）
2. 确认 `change-requests/{cr_id}/prd.md` 与 `change-requests/{cr_id}/sdd.md` 均存在

### Step 2 — 调用脚本，dry-run 核对 diff

```bash
node tools/skills/writeback/scripts/writeback-prd-sdd.mjs \
  --workspace . --cr {cr_id} --spec {spec_id} --version {target_version} \
  [--milestone-name "{milestone_name}"] [--brief "{brief}"] --dry-run
```

核对输出：
- `specs/{spec_id}/PRD.md` / `SDD.md` 的里程碑节追加 diff——标题 `## {名}（v{version} · CR-{id}）`、节内原文 H 级整体 +1、既有里程碑章节原样保留；
- `specs/_index.yml` 字段更新——`current`/`cr-ref`/`updated` 更新、`cr-history[]` 按 id 追加去重、`brief` 仅 `--brief` 传入时替换。

**specs/ 基线是累积文档，不是最近一次 CR 的副本（纪律 #6）**：脚本只做「末尾追加里程碑节 + 头部 frontmatter 行级更新」。dry-run diff 中若出现对既有内容的改写，停止并报告，不得继续。

### Step 3 — 实跑 + 自检 + 提交

去掉 `--dry-run` 重跑。脚本末尾自检（里程碑标题恰 1 次、_index 条目字段齐全、全文件无 CRLF），失败输出 `SELF_CHECK_FAILED` 非零退出（已写入内容留在 git 工作区，`crctl git checkout -- --cwd <worktree>` 可复原）。成功后提交：

```bash
crctl git add specs/{spec_id}/PRD.md specs/{spec_id}/SDD.md specs/_index.yml --cwd <knowledge-base worktree>
crctl git commit --template writeback -m "PRD/SDD 增量回写 specs/{spec_id} v{target_version}" --cwd <knowledge-base worktree>
```

### Step 4 — 更新 CR status

调用 `crctl advance --to writing-back，`trigger=writeback-prd-sdd`，`expected_current_status=merging`

### Step 5 — 输出摘要

```
✅ PRD/SDD 回写完成
   CR          : {cr_id}
   spec_id     : {spec_id}
   版本        : {target_version}
   回写文件    : specs/{spec_id}/PRD.md, SDD.md
   下一步      : 执行 writeback-tasks
```

---

## 已核实事实基线（纪律 #4，2026-08-04 核实）

| 事实 | 值 |
|---|---|
| 里程碑节标题格式 | `## {里程碑名}（v{version} · CR-{id}）`（历史段带 `· archived` 后缀；脚本生成段不带状态后缀） |
| 幂等判据 | 文档内已含 `（v{version} · CR-{cr}` 唯一标识 → noop，重跑不重复追加 |
| 增量回写 frontmatter 更新字段 | `cr-ref` / `cr-history`（按 id 追加去重）/ `target-version` / `version`（v 前缀）；首次回写另补 `spec-id` / `status: ga` |
| specs/_index.yml 结构 | 顶层 `schema: specs-index/v1` + `updated` + `features:` 列表；条目字段 `id/name/scope/status/since/current/brief/cr-ref/cr-history/updated`（字段名严禁写成 specs/items/title/version/updated_at） |
| 脚本落点 | `tools/skills/writeback/scripts/`（非 `skills/shared/scripts/`，范围澄清见 ARCHITECTURE.md §6，CR-2026-020） |

---

## 错误处理

| 错误码 | 处理 |
|------|------|
| `BAD_ARGS` | 缺 `--workspace/--cr/--spec/--version`，补参重跑 |
| `CR_STATUS_MISMATCH` | cr.md status 非 `merging`，先完成 merge-feature-branch 再回写 |
| `STRUCTURE_MISMATCH` | specs/_index.yml 缺 `features:` 列表或条目缺 `cr-history` 等结构异常，报告后停止 |
| `ANCHOR_NOT_UNIQUE` | frontmatter 字段命中 ≥2 次（纪律 #1 硬失败），人工核对文件后修复再跑 |
| `SELF_CHECK_FAILED` | 回写后自检断言失败，检查输出文件后重跑 |

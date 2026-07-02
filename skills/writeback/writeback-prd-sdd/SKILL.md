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

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID（如 CR-2026-001） |
| `spec_id` | string | ✅ | 目标 spec 目录 ID（如 collaboration-dashboard） |
| `target_version` | string | ✅ | 本次发版目标（如 v0.16.0），写入 spec frontmatter |

---

## 执行步骤

### Step 1 — 前置校验

1. 读取 `change-requests/{cr_id}/cr.md`，确认 status=`merging`
2. 确认 `change-requests/{cr_id}/prd.md` 与 `change-requests/{cr_id}/sdd.md` 均存在
3. 读取 `specs/_index.yml`，判断 `specs/{spec_id}/` 目录是否已存在

### Step 2 — 备份旧版本（若存在）

若 `specs/{spec_id}/PRD.md` 或 `SDD.md` 已存在，将旧版本备份到当前 CR 目录，不写 `_archived/**`：

```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p change-requests/{cr_id}/writeback-backups/{spec_id}/{TIMESTAMP}/
cp specs/{spec_id}/PRD.md change-requests/{cr_id}/writeback-backups/{spec_id}/{TIMESTAMP}/PRD.md
cp specs/{spec_id}/SDD.md change-requests/{cr_id}/writeback-backups/{spec_id}/{TIMESTAMP}/SDD.md
```

在备份目录中写入 `metadata.yml`，记录 `archived-by: writeback-prd-sdd`、`cr: {cr_id}`、`spec_id`、`timestamp` 与原文件 SHA。

### Step 3 — 创建或更新 specs/{spec_id}/

```bash
mkdir -p specs/{spec_id}
cp change-requests/{cr_id}/prd.md specs/{spec_id}/PRD.md
cp change-requests/{cr_id}/sdd.md specs/{spec_id}/SDD.md
```

通过 `engineering-docs` skill 校验 frontmatter 合规性（type: PRD / type: SDD），若 frontmatter 缺失则补全：
- `spec_id`、`version`（= target_version）、`status: ga`、`cr_ref: {cr_id}`

### Step 4 — 维护 specs/_index.yml

- 若 spec_id **不存在**：在 `specs/_index.yml` 新增条目，填入 id / title / version / status=ga / created_at / cr_ref
- 若 spec_id **已存在**：更新 version / updated_at / cr_ref 字段

**`specs/_index.yml` 条目格式（严格遵守，不得偏离）：**

列表键名**必须**为 `features:`，不得使用 `specs:`、`items:` 或其他键名。字段名也须严格对齐，错误示例附后。

```yaml
# 文件顶层结构（新建时）
schema: specs-index/v1
updated: {ISO-8601 时间戳}

features:          # ← 必须是 features，不能是 specs / items 等
  - id: {spec_id}
    name: {PRD frontmatter 的 title 字段}  # ← 必须用 name，不能用 title
    scope: product
    status: ga
    since: {target_version}               # ← 必须用 since，不能用 version
    brief: {PRD frontmatter 的 brief/summary 字段，一句话描述}
    cr-ref: {cr_id}
    updated: {ISO-8601 时间戳}             # ← 必须用 updated，不能用 updated_at
```

**字段映射速查（常见错误对比）：**

| 正确字段 | 来源 | 禁止写法 |
|---------|------|----------|
| `features:` | 固定顶层列表键 | ~~`specs:`~~ ~~`items:`~~ ~~`data:`~~ |
| `name:` | PRD frontmatter title | ~~`title:`~~ ~~`label:`~~ |
| `since:` | target_version 参数 | ~~`version:`~~ ~~`target-version:`~~ |
| `updated:` | 当前 ISO-8601 时间 | ~~`updated_at:`~~ ~~`updatedAt:`~~ |

若文件已存在且顶层为 `features:` 列表，则追加或更新对应 id 条目；**不得替换顶层键名**。

### Step 5 — 更新 CR status

调用 `cr-status-set`：`next_status=writing-back`，`trigger=writeback-prd-sdd`，`expected_current_status=merging`

### Step 6 — 输出摘要

```
✅ PRD/SDD 回写完成
   CR          : {cr_id}
   spec_id     : {spec_id}
   版本        : {target_version}
   回写文件    : specs/{spec_id}/PRD.md, SDD.md
   备份位置    : change-requests/{cr_id}/writeback-backups/{spec_id}/{TIMESTAMP}/（如有旧版本）
   下一步      : 执行 writeback-tasks
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| `prd.md` 或 `sdd.md` 不存在 | 停止执行，提示缺失文件路径 |
| `cr.md` status 非 `merging` | 停止执行，提示当前状态 |
| frontmatter 校验失败 | 展示具体缺失字段，要求补全后重试 |
| `_index.yml` 写入失败 | 回滚已复制文件，停止执行 |

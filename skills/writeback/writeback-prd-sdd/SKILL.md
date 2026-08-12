---
name: writeback-prd-sdd
description: feature-writeback pipeline 第 2 节点：在 operational workspace 调 candidate-only generator 产出 PRD/SDD 回写 manifest，一次 crctl writeback-apply 深原语完成校验、应用、精确 stage、commit+trailer、lease push；Skill 只做调用与结果分类。
---

# Skill: writeback-prd-sdd

**类型**: 回写期 Skill（writeback/ 组，第 2 节点）
**调用时机**: feature-writeback pipeline 第 2 节点
**前置要求**: CR status = `merging`（merge-feature-branch 已完成，`operational_workspace` 已由 merge 返回）

---

## 用途

把 `change-requests/{cr_id}/prd.md` 与 `sdd.md` 回写进 `specs/{spec_id}/`（累积基线：末尾追加里程碑节 + frontmatter 行级更新）并维护 `specs/_index.yml`。
回写内容生成与落盘分离（CR-2026-031 TASK-08）：**candidate-only generator** 只读 workspace、只输出 candidate 目录（文件 + blobs + manifest.json v1），**`crctl writeback-apply` 深原语**独占校验、应用、精确 stage、commit + trailer、lease push。

本 Skill 只拥有：**前置确认、一次 generator 调用、一次深原语调用、结果分类**。不写 Git 命令序列、不手写账本。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `spec_id` | string | ✅ | 目标 spec 目录 ID |
| `target_version` | string | ✅ | 本次发版目标 |
| `operational_workspace` | string | ✅ | merge 深原语返回的 detached Transaction Workspace |
| `milestone_name` | string | ❌ | 里程碑节标题名；不传回退 cr.md title |
| `brief` | string | ❌ | `specs/_index.yml` 条目 brief 新描述；仅显式传入时替换 |

---

## 执行步骤

### Step 1 — 前置校验

1. 读取 `change-requests/{cr_id}/cr.md`（在 operational_workspace 内），确认 status=`merging`。
2. 确认 `change-requests/{cr_id}/prd.md` 与 `sdd.md` 存在。

### Step 2 — 生成 candidate（candidate-only，零写 workspace）

```bash
node {TOOLS_ROOT}/skills/writeback/scripts/writeback-prd-sdd.mjs \
  --workspace {operational_workspace} --cr {cr_id} --spec {spec_id} --version {target_version} \
  [--milestone-name "{milestone_name}"] [--brief "{brief}"] \
  --candidate-out {candidate_dir}
```

输出 JSON 含 `manifestPath`。脚本不写任何 workspace 文件（**specs/ 基线是累积文档，不是最近一次 CR 的副本，纪律 #6**：脚本只做末尾追加里程碑节 + 头部行级更新，candidate 内既有内容改写会命中 apply 的 before 校验拒绝）。

### Step 3 — 一次深原语应用

```text
crctl writeback-apply {cr_id} --stage baseline
  --candidate {manifestPath} --spec-id {spec_id}
  --workspace {knowledge-base 主 checkout}
```

深原语内部完成（Skill 不重复、不干预）：

- manifest v1 全矩阵校验（schema/allowlist/path 安全/symlink parent/blob 哈希/before 磁盘字节锚点/inputDigest/stage-generator 绑定，恶意 case 零写入）；
- 在 operational workspace 精确 stage manifest paths + staged set 断言；
- commit + trailer（AI-First-Op: writeback）+ lease push + 远端事实分类（confirmed/pushable/rebuild/history-rewritten）；
- 未发布遇 origin 前进 → `WRITEBACK_REMOTE_STALE`（txws 已重置到新基线，重跑 Step 2 后重试）；已发布丢失 → `WRITEBACK_REMOTE_HISTORY_REWRITTEN` 硬阻断；
- 全程事务 journal，中断后重跑同命令续跑。

### Step 4 — 推进状态（txws 内执行）

```text
crctl advance {cr_id} --to writing-back --trigger writeback-prd-sdd --expect merging --embedded --spec-id {spec_id} --workspace {operational_workspace}
```

### Step 5 — 结果分类

| 输出 | 分类与动作 |
|------|------|
| 深原语 exit 0（phase=complete） | 回写完成，进入下一步 |
| `WRITEBACK_MANIFEST_*`（TAMPERED/PATH_UNSAFE/BLOB_*/BEFORE_MISMATCH 等） | manifest 或基线漂移，核对后重新生成 candidate |
| `WRITEBACK_REMOTE_STALE` | txws 已重置到新基线：重跑 Step 2（generator 读新基线）后重试 |
| `WRITEBACK_REMOTE_HISTORY_REWRITTEN` | 远端历史被改写，硬阻断，人工介入 |
| `GATE_BLOCKED` / 状态前置失败 | 按错误信息处理后重跑 |

### Step 6 — 输出摘要

```
✅ PRD/SDD 回写完成
   CR          : {cr_id}
   spec_id     : {spec_id}
   版本        : {target_version}
   tx          : {writeback-apply 返回 txId}
   下一步      : 以 `crctl next {cr_id}` 为准
```

---

## 已核实事实基线（纪律 #4）

| 事实 | 值 |
|---|---|
| 里程碑节标题格式 | `## {里程碑名}（v{version} · CR-{id}）` |
| 幂等判据 | 文档内已含 `（v{version} · CR-{cr}` 唯一标识 → generator noop，不产 manifest |
| 增量 frontmatter 更新字段 | `cr-ref` / `cr-history`（追加去重）/ `target-version` / `version`（v 前缀）；首次另补 `spec-id` / `status: ga` |
| generator 落点 | `{TOOLS_ROOT}/skills/writeback/scripts/`；回归套件 `test/writeback.test.mjs` |

---

## 错误处理

| 错误码 | 处理 |
|------|------|
| `BAD_ARGS` | 缺参，补参重跑 |
| `CR_STATUS_MISMATCH` | cr.md status 非 `merging`，先完成 merge 再回写 |
| `STRUCTURE_MISMATCH` / `ANCHOR_NOT_UNIQUE` | 基线结构异常，报告后停止，不得手工改基线 |
| `SELF_CHECK_FAILED` | generator 自检失败（candidate 目录内），修复源文档后重跑 |

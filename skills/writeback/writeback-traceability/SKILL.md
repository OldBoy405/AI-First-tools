---
name: writeback-traceability
description: writing-back 阶段追溯回写：在 operational workspace 调 candidate-only generator 产出 traceability.yml 累积追加 manifest，一次 crctl writeback-apply 深原语完成校验、应用、精确 stage、commit+trailer、lease push；merge-commits 取自 merge-commits.yml（TASK-07 事实源）。
---

# Skill: writeback-traceability

**类型**: 回写期 Skill（writeback/ 组，第 4 节点）
**调用时机**: feature-writeback pipeline 第 4 节点（倒数第二，cr-archive 之前）
**前置要求**: CR status = `writing-back`，`specs/{spec_id}/PRD.md` 与 `SDD.md` 已回写

---

## 用途

在 `specs/{spec_id}/traceability.yml`（跨 CR 累积的**唯一权威文件**）追加本 CR 的 milestone 段，建立需求→设计→任务→代码→CR 的完整追溯链。
**不是全量重建**（SDD §8 D3）：头部手工注释与既有 milestones 段逐字节保留，只做「头部结构化字段更新 + 本 CR 段末尾追加」。merge-commits 取自 `change-requests/{cr_id}/merge-commits.yml`（TASK-07 finalize 产物，trunk 由 dir-graph 解析），不再从 `_backlog.yml` 提取。

内容生成与落盘分离（CR-2026-031 TASK-08）：**candidate-only generator** 产出 manifest，**`crctl writeback-apply` 深原语**独占校验、应用、精确 stage、commit + trailer、lease push。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `spec_id` | string | ✅ | 关联 spec ID |
| `target_version` | string | ✅ | 目标版本号 |
| `milestone_file` | string | ✅ | 本 CR milestone 段草稿文件路径 |
| `operational_workspace` | string | ✅ | detached Transaction Workspace |

---

## 执行步骤

### Step 1 — 前置校验

1. 读取 `change-requests/{cr_id}/cr.md`（operational_workspace 内），确认 status=`writing-back`。<!-- lint-prompts:ignore --> 只读前置校验，状态权威仍由 crctl gate 保证
2. 确认 `specs/{spec_id}/PRD.md`、`SDD.md` 存在（writeback-prd-sdd 已完成）。

### Step 2 — 起草 milestone-file

```yaml
cr: {cr_id}
milestone: {里程碑名，如 T2 / M1}
target-version: "{target_version}"
status: writing-back
fr-chain:
  - fr: FR-1
    title: {FR 一句话标题}
    sdd: "SDD §{节号} {方案要点}"
    tasks: [{cr_id}-TASK-01, ...]
    code: "{repo}@{sha8}: {改动要点}"
    evidence: "{AC-x} {验证方式}"
  # ... 每条 FR 一项
```

`merge-commits` **不要手工誊抄**——generator 从 merge-commits.yml 定向提取并注入（若草稿内含则做一致性校验）。

### Step 3 — 生成 candidate（candidate-only，零写 workspace）

```bash
node {TOOLS_ROOT}/skills/writeback/scripts/writeback-traceability.mjs \
  --workspace {operational_workspace} --cr {cr_id} --spec {spec_id} --version {target_version} \
  --milestone-file {milestone_file 路径} --candidate-out {candidate_dir}
```

输出 JSON 含 `manifestPath`。**既有 milestones 段不得出现在 candidate 差异中**（出现即报告，不得继续）。

### Step 4 — 一次深原语应用

```text
crctl writeback-apply {cr_id} --stage traceability
  --candidate {manifestPath} --spec-id {spec_id}
  --workspace {knowledge-base 主 checkout}
```

深原语内部完成：manifest 全矩阵校验（allowlist = `specs/{spec_id}/traceability.yml`）→ 精确 stage + staged set 断言 → commit + trailer → lease push + 远端事实分类；STALE/history-rewritten 语义同 writeback-prd-sdd。

### Step 5 — 结果分类与输出

| 输出 | 动作 |
|------|------|
| 深原语 exit 0（phase=complete） | 追溯链追加完成，等待 cr-archive |
| `MERGE_COMMITS_MISSING` | merge-commits.yml 缺失或字段不全——先修复 merge 输出；不得猜测 |
| `WRITEBACK_REMOTE_STALE` | 重跑 Step 3 后重试 |

```
✅ 追溯链追加完成，等待 cr-archive 归档
   spec_id         : {spec_id}
   traceability    : specs/{spec_id}/traceability.yml
   本 CR 段        : milestone {milestone}（- cr: {cr_id}）
   tx              : {writeback-apply 返回 txId}
   CR status       : writing-back
   下一步          : 以 `crctl next {cr_id}` 为准（cr-archive）
```

---

## 已核实事实基线（纪律 #4）

| 事实 | 值 |
|---|---|
| specs 侧 traceability.yml | 跨 CR 累积文件，不可全量重建（SDD §8 D3） |
| milestone 段格式 | `  - cr: {cr_id}` + milestone + target-version + status + merge-commits: + frs: |
| merge-commits 来源 | `change-requests/{cr_id}/merge-commits.yml`（TASK-07 finalize 产物，schema merge-commits/v1；trunk 由 dir-graph 解析；branch 恒 requirement/{cr}） |
| 幂等判据 | specs 侧已含 `- cr: {cr_id}` 段 → generator noop |

---

## 错误处理

| 错误码 | 处理 |
|------|------|
| `BAD_ARGS` | 缺参，补参重跑 |
| `CR_STATUS_MISMATCH` | status 非 `writing-back`，先完成 writeback-prd-sdd 的推进 |
| `STRUCTURE_MISMATCH` | milestone-file 缺字段，或草稿 merge-commits 与 merge-commits.yml 不一致；报告后停止 |
| `MERGE_COMMITS_MISSING` | merge-commits.yml 缺失/字段不齐——先修复 merge 输出；不得猜测 |
| `SELF_CHECK_FAILED` | generator 自检失败（candidate 目录内），修复后重跑 |

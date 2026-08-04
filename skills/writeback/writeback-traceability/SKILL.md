---
name: writeback-traceability
description: 生成 specs/{spec_id}/traceability.yml 的累积追溯链（头部字段更新 + 本 CR milestone 段追加），merge-commits[] 从 _backlog.yml 定向提取；不归档 CR。
---

# Skill: writeback-traceability

**类型**: 回写期 Skill（writeback/ 组，第 4 节点）  
**调用时机**: feature-writeback pipeline 第 4 节点（倒数第二，cr-archive 之前）  
**前置要求**: CR status = `writing-back`，`specs/{spec_id}/PRD.md` 与 `SDD.md` 已回写

---

## 用途

聚合本次 CR 生命周期中产生的可追溯证据，在 `specs/{spec_id}/traceability.yml`（跨 CR 累积的**唯一权威文件**）追加本 CR 的 milestone 段，建立需求→设计→任务→代码→CR 的完整追溯链。`change-requests/{cr_id}/traceability.yml` 仅作为开发期工作稿，归档后不再维护、不再要求与 specs 侧同步（CR-2026-020 FR-7）。写入完成后保持 CR status=`writing-back`，由 `cr-archive` 统一归档。

**机械步骤由入库脚本执行（CR-2026-020 起）**：脚本位于 `tools/skills/writeback/scripts/writeback-traceability.mjs`。**不是全量重建**（SDD §8 D3）：头部手工注释与既有 milestones 段逐字节保留，只做「头部结构化字段更新 + 本 CR 段末尾追加」。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `spec_id` | string | ✅ | 关联 spec ID |
| `target_version` | string | ✅ | 目标版本号 |
| `milestone_file` | string | ✅ | 本 CR milestone 段草稿文件路径（Agent 起草，结构见 Step 2） |

---

## 执行步骤

### Step 1 — 前置校验

1. 读取 `change-requests/{cr_id}/cr.md`，确认 status=`writing-back`（脚本同样校验，不满足即 `CR_STATUS_MISMATCH` 硬失败）
2. 确认 `specs/{spec_id}/PRD.md`、`specs/{spec_id}/SDD.md` 均存在（writeback-prd-sdd 已完成）

### Step 2 — 起草 milestone-file

按证据源起草本 CR 的 milestone 段草稿（`fr-chain` 的 `title/sdd/code/evidence` 为编辑性内容，由本 Agent 撰写；`merge-commits` **不要手工誊抄**——脚本会从 `_backlog.yml` 定向提取并注入，若草稿内已含则与提取结果做一致性校验）：

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

### Step 3 — 调用脚本，dry-run 核对

```bash
node tools/skills/writeback/scripts/writeback-traceability.mjs \
  --workspace . --cr {cr_id} --spec {spec_id} --version {target_version} \
  --milestone-file {milestone_file 路径} --dry-run
```

核对输出：头部字段更新（`cr-ref`/`target-version`/`generated-at`、`cr-history[]` 追加去重）与本 CR 段的追加 diff——merge-commits 应为 `_backlog.yml` 提取的 repo/trunk/sha/branch 四字段（与既有段格式一致），`frs` 条目来自草稿的 `fr-chain`。**既有 milestones 段不得出现在 diff 中**（出现即报告）。

### Step 4 — 实跑 + 自检 + 提交

去掉 `--dry-run` 重跑。脚本末尾自检（`- cr: {cr_id}` 段恰 1 处、merge-commits 数与提取结果一致、既有段逐字节保留、无 CRLF），失败输出 `SELF_CHECK_FAILED` 非零退出。成功后提交：

```bash
git add specs/{spec_id}/traceability.yml
git commit -m "writeback({cr_id}): specs/{spec_id} traceability.yml 累积 milestone {milestone}"
```

### Step 5 — 输出归档前置证据

在节点输出中写明：

- traceability.yml 路径
- 关联 TASK 数量
- merge commit SHA 是否齐全（脚本已强制六字段齐全，`MERGE_COMMITS_MISSING` 即不齐全）
- 下一节点必须是 `cr-archive`

### Step 6 — 输出摘要

```
✅ 追溯链追加完成，等待 cr-archive 归档
   spec_id         : {spec_id}
   traceability    : specs/{spec_id}/traceability.yml
   本 CR 段        : milestone {milestone}（- cr: {cr_id}）
   merge commits   : [{repo.id}={sha8}, ...]
   CR status       : writing-back
   下一步          : cr-archive
```

---

## 已核实事实基线（纪律 #4，2026-08-04 核实）

| 事实 | 值 |
|---|---|
| specs 侧 traceability.yml 形态 | 跨 CR 累积文件（989 行）：头部（注释 + spec-id/cr-ref/cr-history/target-version/baseline-since/generated-at）+ `milestones:` 段列表——**不可全量重建**（SDD §8 D3） |
| milestone 段格式 | `  - cr: {cr_id}` + `milestone` + `target-version` + `status` + `merge-commits:` + `frs:`（每条 `- fr: FR-x` + title/sdd/tasks/code/evidence） |
| merge-commits 写入格式 | 四字段 `repo/trunk/sha/branch`（CR-2026-018/019 段先例）；提取时校验 `_backlog.yml` 六字段（repo/trunk/sha/branch/source-sha/merged-at）齐全，缺失 `MERGE_COMMITS_MISSING` |
| 幂等判据 | specs 侧已含 `- cr: {cr_id}` 段 → noop |
| 权威文件 | specs 侧为唯一权威；change-requests 侧为开发期工作稿，归档后不再同步（FR-7） |

---

## 错误处理

| 错误码 | 处理 |
|------|------|
| `BAD_ARGS` | 缺 `--workspace/--cr/--spec/--version/--milestone-file`，补参重跑 |
| `CR_STATUS_MISMATCH` | cr.md status 非 `writing-back`，先完成 writeback-prd-sdd 的 status 推进 |
| `STRUCTURE_MISMATCH` | milestone-file 缺 `cr/milestone/target-version/fr-chain[].fr`，或草稿内 merge-commits 与账本提取不一致；报告后停止 |
| `MERGE_COMMITS_MISSING` | `_backlog.yml` 无该 CR 条目 / 无 merge-commits[] / 字段不齐全——先修复 merge-feature-branch 输出；**不得猜测或自动取 trunk 最新提交** |
| `SELF_CHECK_FAILED` | 追加后自检断言失败，检查输出文件后重跑 |

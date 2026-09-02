---
name: writeback-traceability
description: writing-back 阶段起草 milestone 业务内容后，一次 crctl writeback-apply 累积回写 traceability。
---

# Skill: writeback-traceability

**前置**：CR status=`writing-back`，baseline 已存在；`merge-commits.yml` 是合并事实源。

## 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `cr_id` | 是 | CR-ID |
| `spec_id` | legacy 必填；new 可省略 | 关联 spec ID（new 省略时由 `crctl` 从 strict authority 读取） |
| `target_version` | legacy 必填；new 可省略 | 目标版本（new 省略时由 `crctl` 从 strict authority 读取） |
| `milestone_file` | legacy 必填；new = N/A | operational-workspace-relative POSIX 路径；**new 模式不传**（生成输入 = 冻结 PLAN 两张表 + TASK 账本/卡 + test-report + merge facts，SDD §4.8） |

mode 判定由 `crctl writeback-apply` 内部完成；Skill 不自行判定 mode、不自行回退 authority。

## 业务步骤

- **legacy**：
  1. 在 operational workspace 起草 milestone 文件，至少含 `cr`、`milestone`、`target-version` 和非空 `fr-chain`（新 milestone 不写 `status`，CR 状态只由 `cr.md`/`_history.yml` 表达）。`merge-commits` 不手工誊抄，由 `crctl` 从 `change-requests/{cr_id}/merge-commits.yml` 注入。
  2. 调用一次：

```text
crctl writeback-apply {cr_id} --stage traceability
  --spec-id {spec_id} --target-version {target_version}
  --milestone-file {workspace-relative-path}
  --workspace {knowledge-base installation workspace}
```

- **new（不起草 milestone 文件，不传 milestone 参数）**：

```text
crctl writeback-apply {cr_id} --stage traceability
  [--spec-id {spec_id}] [--target-version {target_version}]
  --workspace {knowledge-base installation workspace}
```

`crctl` 内部 generator 的 new 分支从冻结 PLAN 交付覆盖表/证据命令表 + TASK 账本/卡 + test-report + merge facts 确定性生成 `FR→SDD→TASK→repo@mergeSHA→cmd` 引用链（按 FR id 升序）；任一交叉失败 → `STRUCTURE_MISMATCH` 硬失败（禁止静默降级）。重复生成 noop，legacy 夹具逐字节不变。

`crctl` 内部固定 generator/candidate 并执行 manifest 校验、精确 staged set、commit 与 lease push。Skill 不传 candidate/manifest/generator 路径，不写 Git/账本算法。

`MERGE_COMMITS_MISSING` 或 milestone 结构错误时修复业务源；`WRITEBACK_REMOTE_STALE` 同命令重跑；history rewrite 硬阻断。成功输出 txId/commit/files/warnings，下一步以 `crctl next {cr_id}` 为准。

**trace 事件发射结果（CR-2026-049）**：`warnings=[{code:EMIT_FAILED,event_kind:trace}]` 表示 Git writeback 已完成但 trace 事件仍 pending——journal 已持久化完整 intent，不宣称 trace 已交付；重跑同一 `writeback-apply` 会确定性补发，archive 前置门也会在归档前补发。

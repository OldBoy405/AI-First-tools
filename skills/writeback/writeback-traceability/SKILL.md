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
| `spec_id` | 是 | 关联 spec ID |
| `target_version` | 是 | 目标版本 |
| `milestone_file` | 是 | operational-workspace-relative POSIX 路径 |

## 业务步骤

1. 在 operational workspace 起草 milestone 文件，至少含 `cr`、`milestone`、`target-version` 和非空 `fr-chain`（新 milestone 不写 `status`，CR 状态只由 `cr.md`/`_history.yml` 表达）。`merge-commits` 不手工誊抄，由固定 generator 从 `change-requests/{cr_id}/merge-commits.yml` 注入。
2. 调用一次：

```text
crctl writeback-apply {cr_id} --stage traceability
  --spec-id {spec_id} --target-version {target_version}
  --milestone-file {workspace-relative-path}
  --workspace {knowledge-base installation workspace}
```

`crctl` 内部固定 generator/candidate，执行 manifest 全矩阵校验、精确 staged set、commit 与 lease push。Skill 不传 candidate/manifest/generator 路径，不写 Git/账本算法。

`MERGE_COMMITS_MISSING` 或 milestone 结构错误时修复业务源；`WRITEBACK_REMOTE_STALE` 同命令重跑；history rewrite 硬阻断。成功输出 txId/commit/files/warnings，下一步以 `crctl next {cr_id}` 为准。

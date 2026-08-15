---
name: writeback-prd-sdd
description: feature-writeback baseline 节点：只传业务输入，一次 crctl writeback-apply 原子发布累积 PRD/SDD baseline 与 writing-back 状态。
---

# Skill: writeback-prd-sdd

**前置**：`crctl merge` 已返回 operational workspace，CR status=`merging`。

## 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `cr_id` | 是 | CR-ID |
| `spec_id` | 是 | specs 目标 ID |
| `target_version` | 是 | 目标版本 |
| `milestone_name` | 否 | baseline 里程碑标题 |
| `brief` | 否 | specs 索引 brief |

## 执行

只调用一次深原语：

```text
crctl writeback-apply {cr_id} --stage baseline
  --spec-id {spec_id} --target-version {target_version}
  [--milestone-name {milestone_name}] [--brief {brief}]
  --workspace {knowledge-base installation workspace}
```

`crctl` 内部固定 generator 和 `.crctl/candidates/{CR-ID}/baseline`，并完成 generator、manifest/hash/path/before/snapshot/gate preflight、baseline + `cr.md` 同一 recoverable write-set/commit/lease push，以及 origin-confirmed 后 status outbox/advance audit。Skill 不生成 candidate、不传 manifest/generator 路径、不独立执行 `advance writing-back`，也不写 Git/账本算法。

## 结果分类

| 结果 | 动作 |
|---|---|
| `phase=complete` | 输出 txId/commit/status/files/warnings，进入 tasks |
| noop 且状态已 writing-back | 幂等成功 |
| `WRITEBACK_REMOTE_STALE` | 同一业务命令重跑；crctl 内部重生成 candidate |
| `WRITEBACK_MANIFEST_*` / generator 结构化错误 | 修正业务源或版本化 generator 后同命令重跑 |
| `WRITEBACK_REMOTE_HISTORY_REWRITTEN` | 硬阻断，人工处理；禁止 force |
| `EMIT_FAILED` warning | Git 成功不反转；同命令重放只补投影 |

输出后续动作统一以 `crctl next {cr_id}` 为准。

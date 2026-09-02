---
name: writeback-tasks
description: writing-back 阶段只传业务输入，一次 crctl writeback-apply 回写 done TASK 与 delivery 索引。
---

# Skill: writeback-tasks

**前置**：CR status=`writing-back`；`tasks/_index.yml` 是 done 事实源。

## 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `cr_id` | 是 | CR-ID |
| `spec_id` | legacy 必填；new 可省略 | 关联 spec ID（new 省略时由 `crctl` 从 strict authority 读取） |
| `target_version` | legacy 必填；new 可省略 | 目标版本（new 省略时由 `crctl` 从 strict authority 读取） |

mode 判定由 `crctl writeback-apply` 内部完成；Skill 不自行判定 mode、不自行回退 authority。

## 执行

```text
crctl writeback-apply {cr_id} --stage tasks
  [--spec-id {spec_id}] [--target-version {target_version}]
  --workspace {knowledge-base installation workspace}
```

- **legacy**：`--spec-id`/`--target-version` 必填。
- **new**：两者均可省略（从 strict authority 读取）。

**new 模式的 pending-task preflight（SDD §4.6）**：`stage=tasks` 时，`crctl` 在 candidate/journal 之前先证明 `tasks/_index.yml` 全部 TASK done；失败零写入零发布，重试条件 = `crctl task done` 补齐后重跑同一命令。失败码 `WRITEBACK_TASKS_PENDING`，`extra.reason` 区分三类：

| reason | 触发 | 恢复 |
|---|---|---|
| `index-missing` | 索引缺失或为空 | 先完成 `crctl task init`/`task done` 补齐账本 |
| `index-invalid` | 畸形 YAML / 重复 id / 未知 status | 修复账本（只经 crctl 命令）后重跑 |
| `pending` | 存在非 done 条目（`extra.pending` 列 id） | `crctl task done` 逐条补齐后重跑 |

`crctl` 内部固定 `writeback-tasks.mjs` 与 `.crctl/candidates/{CR-ID}/tasks`。Skill 不传 candidate/manifest/generator 路径，不手写 Git 或 delivery 索引。

幂等语义仍以 `delivery/task/*.md` frontmatter id 集合为准；无新增 done TASK 时 `changed=false`。`WRITEBACK_REMOTE_STALE` 使用同一业务命令重跑，history rewrite 硬阻断。输出 txId/commit/files/warnings，下一步以 `crctl next {cr_id}` 为准。

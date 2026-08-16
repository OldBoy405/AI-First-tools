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
| `spec_id` | 是 | 关联 spec ID |
| `target_version` | 是 | 目标版本 |

## 执行

```text
crctl writeback-apply {cr_id} --stage tasks
  --spec-id {spec_id} --target-version {target_version}
  --workspace {knowledge-base installation workspace}
```

`crctl` 内部固定 `writeback-tasks.mjs` 与 `.crctl/candidates/{CR-ID}/tasks`。Skill 不传 candidate/manifest/generator 路径，不手写 Git 或 delivery 索引。

幂等语义仍以 `delivery/task/*.md` frontmatter id 集合为准；无新增 done TASK 时 `changed=false`。`WRITEBACK_REMOTE_STALE` 使用同一业务命令重跑，history rewrite 硬阻断。输出 txId/commit/files/warnings，下一步以 `crctl next {cr_id}` 为准。

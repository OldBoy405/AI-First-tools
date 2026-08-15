---
name: resume-from-remote
description: 在新电脑或本地 worktree 缺失时，通过 crctl workspace ensure 幂等恢复 CR 的全部 active repo workspace。
---

# Skill: resume-from-remote

**类型**: 远端同步 Skill（sync/ 组）
**调用时机**: 换机、接手在途 CR，或本地 CR worktree 丢失时

## 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cr_id` | string | ✅ | 目标 CR-ID |

## 执行

1. 读取 workspace `dir-graph.yaml#repositories`，确认目标 CR 的 active repo 远端 checkpoint 已由上一节点 `list-remote-checkpoints` 验证为 metadata-confirmed 完整批次（只消费单一 `latest-checkpoint`，不读旧 `checkpoints[]`）；独立调用时先执行该只读 Skill。
2. 只调用一次深原语：

```text
crctl workspace ensure {cr_id} --mode resume --workspace {installation_workspace}
```

`crctl` 独占 repository resolver、remote/local/worktree 分类、路径 containment、fetch 与 workspace 创建。Skill 不再复制 Git/worktree 算法，也不清理 dirty、wrong-branch 或 path-unregistered 资源。
3. 从返回的 `resources[]` 展示每个 repo 的 `classification/action/worktreePath/branch`；随后从 knowledge-base CR worktree读取 `cr.md` 的 status 与 owners。
4. 调用 `crctl next {cr_id} --workspace {knowledge_base_worktree}` 获取唯一下一步。

## 成功输出

```text
✅ 工作区恢复完成
   CR        : {cr_id}
   resources : [{repo, classification, action, worktreePath}, ...]
   owners    : requirement={...}, development={...}, test={...}
   下一步    : 以 `crctl next {cr_id}` 为准
```

## 失败处理

| 错误 | 处理 |
|---|---|
| `WORKSPACE_ENSURE_BLOCKED` | 保留 dirty/wrong-branch/path-unregistered 现场，返回对应 resource，不自动删除或 reset |
| `REPO_*` / `GRAPH_CHANGED_DURING_TRANSACTION` | 停止，按结构化错误修正声明或完成既有事务 |
| `TX_LOCK_HELD` | 停止，不 force unlock |
| `SHELL_UNAVAILABLE` / `TX_GIT_FAILED` | 返回结构化错误，不输出手工 Git 指令 |

恢复不修改 Owner；正式移交只走 `handover-cr`。

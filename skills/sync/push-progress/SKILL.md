---
name: push-progress
description: "调用一次 crctl checkpoint 深原语，将同一 CR 全部 active repo 的未提交变更打包为 wip 提交并推送 origin 同名分支，由 crctl 生成并落账 latest-checkpoint 与 KB metadata commit。"
---

# Skill: push-progress

**类型**: 远端同步 Skill（sync/ 组，跨阶段通用）
**调用时机**: 随时可调用；在 requirement-authoring / architecture-design / code-implementation pipeline 中作为可选节点自动触发

---

## 用途

一键将同一 CR workspace 中全部 active repo 的工作进度提交并推送到远端，作为 checkpoint 供换机或协作者续接。全部 Git、账本编辑与恢复分类由 `crctl checkpoint` 深原语独占；本 Skill 只做一次调用与结果解释，不复制逐仓 Git 算法。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `message` | string | 否 | 追加到 source commit message 后的阶段摘要，默认空 |

---

## 执行步骤

### Step 1 — 调用 crctl checkpoint

```text
crctl checkpoint {cr_id} [--message {message}] --workspace <installation-workspace>
```

一次调用完成：全仓 preflight（worktree/branch/敏感路径预检）→ 逐仓 source commit（tracked+untracked 未忽略变化）→ 非 knowledge-base 仓 lease publish → knowledge-base `latest-checkpoint` 账本 + metadata commit → 精确确认完整批次。中断重跑同一命令补齐；幂等重放 no-op 返回 `changed=false`。

### Step 2 — 解释固定输出

- `phase=complete` 且 `changed=true`：完整批次已保存；输出 `batchId`、`repositories[]`（每仓 `sourceSha`+`confirmed`）与 `metadataCommit`。
- `phase=complete` 且 `changed=false`（no-op）：无新变化，未创建 journal/commit/push。
- 错误：按 `code` 与 `recoverCommand` 分流；`CHECKPOINT_SENSITIVE_PATH`/`CHECKPOINT_REMOTE_*` 等为硬阻断，`recoverCommand` 为重跑补齐。

### Step 3 — 输出摘要

```text
✅ checkpoint 已推送
   CR          : {cr_id}
   batchId     : {batchId}
   分支        : requirement/{cr_id}
   repos       : [{repo}:{sourceSha8} confirmed, ...]
   metadata    : {metadataCommit}
   下一步      : 以 crctl next {cr_id} 为准
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| `CHECKPOINT_SENSITIVE_PATH` | 敏感路径/私钥头命中，全仓零 add/commit/push；移除敏感文件后重试 |
| `CHECKPOINT_REMOTE_ADVANCED` | 某仓 remote 领先 source，先执行 pull-progress 后重新 checkpoint |
| `CHECKPOINT_REMOTE_DIVERGED` / `CHECKPOINT_REMOTE_HISTORY_REWRITTEN` | 硬阻断，不 merge/force；人工确认 remote 历史 |
| 其它事务错误（`TX_*` / `GRAPH_CHANGED_DURING_TRANSACTION`） | 按 `recoverCommand` 重跑同一命令补齐 |
| 终态 CR（`ILLEGAL_LEDGER_STATE`） | 停止执行，展示当前状态 |

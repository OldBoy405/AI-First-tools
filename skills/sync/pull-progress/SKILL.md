---
name: pull-progress
description: 按 dir-graph.yaml repositories 遍历所有 active repo，在已存在的本地 CR worktree 中从远端 fast-forward 拉取最新 checkpoint，保持本地与远端同步。
---

# Skill: pull-progress

**类型**: 远端同步 Skill（sync/ 组，跨阶段通用）  
**调用时机**: 协作场景下，接手他人工作或需同步最新进度时随时调用

---

## 用途

在本地已存在 CR worktree 的情况下，从远端拉取他人通过 `push-progress` 推送的最新 checkpoint 进度，保持所有 active repo 的同名分支本地 worktree 与远端同步。仅支持 fast-forward 合并（非 fast-forward 需人工处理），确保不丢失本地未推送的变更。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |

---

## 执行步骤

### Step 1 — 前置检查

1. 读取 `AGENTS.md`、`dir-graph.yaml#repositories`。
2. 解析所有 `active != false` 的 repo，计算 bucket 与 worktreePath：
   - `bucket = knowledge-base`（当 `repo.role=knowledge-base`）或 `repo.id`
   - `worktreePath = {workspaceRoot}/.xinyiai-worktrees/{bucket}/requirement/{cr_id}`
3. 确认每个 active repo 都存在本地 worktree 分支 `requirement/{cr_id}`（通过 `git worktree list` 或等价受控查询检查）。
4. 若任一 worktree 不存在，返回 `WORKTREE_MISSING` 并提示使用 `resume-from-remote` 代替；不得只拉取部分 repo。

> **执行方式**：所有 git 命令必须通过受控 shell 执行（见 `skills/shared/controlled-shell/SKILL.md`）。**禁止**回退到手工指引文本。

### Step 2 — 检查本地未推送变更（受控 shell）

对每个 active repo worktree 执行：

```ts
const st = await runGit({ subcommand: "status", args: ["--short"], cwd: repo.worktreePath });
if (st.ok && st.stdout.trim().length > 0) {
  // 有未提交变更：提示用户先 push-progress 或 stash
}
```

若有未提交变更，返回结构化错误 `LOCAL_CHANGES_PRESENT`，提示先执行 `push-progress` 保存 checkpoint，或由 UI 提供受控清理/暂存入口；不得输出手工 git 命令。

### Step 3 — 拉取所有 active repo（受控 shell）

对每个 active repo worktree 执行：

```ts
await runGit({ subcommand: "fetch", args: ["origin"], cwd: repo.worktreePath });
await runGit({ subcommand: "pull",
  args: ["--ff-only", "origin", `requirement/${crId}`], cwd: repo.worktreePath });
const head = await runGit({ subcommand: "rev-parse", args: ["HEAD"], cwd: repo.worktreePath });
```

### Step 4 — 读取最新 CR 状态

拉取完成后从 knowledge-base CR worktree 读取 `change-requests/{cr_id}/cr.md`，展示当前状态与最近变更。

### Step 5 — 输出摘要

```
✅ 进度拉取完成
   CR              : {cr_id}
   repos           : [{repo.id}:{old-sha-8} → {new-sha-8}, ...]
   CR 当前状态     : {status}
   最近推送者      : {last-push-by}（{last-push-at}）
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| 本地 worktree 不存在 | 返回 `WORKTREE_MISSING`，提示使用 `resume-from-remote {cr_id}` 重建 worktree |
| pull --ff-only 失败（有分叉） | 停止执行，返回 `NON_FAST_FORWARD`，展示分叉提交；由专门冲突处理流程处理 |
| 本地有未提交变更 | 停止执行，提示先提交或 stash |
| 远端分支不存在 | 提示该 CR 尚未推送到远端，无需 pull |
| 受控 shell 不可用（`SHELL_UNAVAILABLE`） | 停止执行，返回结构化错误；**禁止**输出「请在终端运行」提示 |

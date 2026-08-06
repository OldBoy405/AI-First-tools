---
name: push-progress
<!-- lint-prompts:ignore --> 描述性：推送说明（实际写入走 crctl checkpoint-add）
description: "按 dir-graph.yaml repositories 遍历所有 active repo，将 CR worktree 未提交变更打包为 wip checkpoint 并推送 origin 同名分支，经 crctl checkpoint-add 更新 _backlog.yml 的 remote-ref/last-push/checkpoints 字段（S3）。"
---

# Skill: push-progress

**类型**: 远端同步 Skill（sync/ 组，跨阶段通用）  
**调用时机**: 随时可调用；在 requirement-authoring / architecture-design / code-implementation pipeline 中作为可选节点自动触发

---

## 用途

<!-- lint-prompts:ignore --> 描述性：推送说明（实际写入走 crctl checkpoint-add）
一键将同一 CR workspace 中所有 active repo 的工作进度提交并推送到远端，作为 checkpoint 供换机或协作者续接。commit message 采用 `wip:` 前缀以与正式提交区分。同时更新 `change-requests/_backlog.yml` 中对应 CR 条目的 `remote-ref`、`last-push-at`、`last-push-by` 与 `checkpoints[]` 字段。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID，用于定位 worktree 分支与 backlog 条目 |
| `message` | string | 否 | 附加描述（追加到 wip commit message 后），默认空 |

---

## 执行步骤

### Step 1 — 解析 repo worktree map

1. 读取 `AGENTS.md`、`dir-graph.yaml#repositories`。
2. 选择 `active != false` 的 repo。
3. 对每个 repo：`branch = requirement/{cr_id}`，worktreePath 经 `crctl worktree-path {cr_id} --repo {repo.id} --workspace <ws>` 取权威值（FR-29②，CR-2026-022——不再手拼 bucket/worktreePath；bucket 规则由 crctl 唯一派生）
<!-- lint-prompts:ignore --> 描述性：推送说明（实际写入走 crctl checkpoint-add）
4. 读取 `change-requests/_backlog.yml`，确认存在 `cr_id` 条目。
5. 任一 active repo 的 worktree 不存在则返回 `WORKTREE_MISSING`，不得只推部分 repo。

> **执行方式**：本 skill 所有 git 命令必须通过受控 shell 执行，详见 `skills/shared/controlled-shell/SKILL.md`。
> 失败时返回结构化错误（`SHELL_UNAVAILABLE` / `EXEC_FAILED`），**禁止**输出「请在终端手工运行」类文本。

### Step 2 — 提交并推送所有 active repo（受控 shell）

对 Step 1 解析出的每个 repo 执行：

```ts
await runGit({ subcommand: "add", args: ["-A"], cwd: repo.worktreePath });
const diff = await runGit({ subcommand: "diff", args: ["--cached", "--quiet"], cwd: repo.worktreePath });
if (diff.ok === false && diff.code === "EXEC_FAILED") {
  // diff --cached --quiet 退出码 1 表示有变更，需 commit
  await runGit({ subcommand: "commit",
    args: ["-m", `wip: ${crId} ${repo.id} checkpoint${messageSuffix}`], cwd: repo.worktreePath });
}
await runGit({ subcommand: "push", args: ["-u", "origin", `requirement/${crId}`], cwd: repo.worktreePath });
const head = await runGit({ subcommand: "rev-parse", args: ["HEAD"], cwd: repo.worktreePath });
```

> 若工作区已 clean（无变更）则跳过 commit，直接 push（确保远端与本地同步）。

### Step 3 — 经 crctl checkpoint-add 落账（FR-11，CR-2026-022）

对 Step 2 推送成功的**每个 active repo** 显式循环调用（**禁止手工编辑 `_backlog.yml`**——账本写入唯一经 crctl，CAS+审计）：

```ts
// 每个 repo：
const head = await runGit({ subcommand: "rev-parse", args: ["HEAD"], cwd: repo.worktreePath });
// crctl checkpoint-add {cr_id} --repo {repo.id} --sha {head.sha} --workspace {ws}
//   —— 由调用方执行 crctl（受控 shell 白名单外命令），逐仓单次写入 remote-ref/last-push/checkpoints
```

`checkpoints[]` 每次 push-progress 按 repo 覆盖同一 CR 的最新 checkpoint SHA，禁止只记录单仓字段。

**失败语义（D-4 决策）**：任一 repo 的 `checkpoint-add` 失败即非零退出，并在输出摘要中强制输出 `CHECKPOINT_ALERT` 段（推送动作可能已成功，告警由工具层承担，不依赖 pipeline `onFail` 的 skip/abort 二值语义）。

### Step 4 — 输出摘要

```
✅ checkpoint 已推送
   CR              : {cr_id}
   分支            : requirement/{cr_id}
   repos           : [{repo.id}:{sha8}, ...]
   last-push-at    : {YYYY-MM-DDTHH:mm:ss+08:00}
   下一步          : 以 `crctl next {cr_id}` 为准
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| 远端分支不存在（首次 push） | `-u origin` 会自动创建远端分支，正常处理 |
| push 被拒绝（非 fast-forward） | 提示先执行 `pull-progress` 合入他人变更后重试 |
<!-- lint-prompts:ignore --> 描述性：推送说明（实际写入走 crctl checkpoint-add）
| `_backlog.yml` CR 条目不存在 | 停止执行，返回 `CR_NOT_FOUND` |
| active repo worktree 缺失 | 停止执行，返回 `WORKTREE_MISSING`，不得只推部分 repo |
| 受控 shell 不可用（`SHELL_UNAVAILABLE`） | 停止执行，返回结构化错误；**禁止**输出「请在终端运行」提示 |
| `checkpoint-add` 失败（`ILLEGAL_LEDGER_STATE`/`CAS_CONFLICT` 等） | 非零退出 + 摘要输出 `CHECKPOINT_ALERT` 段（推送可能已成功，告警必须可见） |
| `EXEC_FAILED` 且 stderr 含 `rejected` | 归类为非 fast-forward，按上一行处理 |

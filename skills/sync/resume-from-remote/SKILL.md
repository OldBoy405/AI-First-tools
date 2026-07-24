---
name: resume-from-remote
description: 在新电脑或新成员环境下，按 CR-ID 与 dir-graph.yaml repositories 从远端分支恢复所有 active repo 的 CR worktree，无需从头走 pipeline。
---

# Skill: resume-from-remote

**类型**: 远端同步 Skill（sync/ 组，跨阶段通用）  
**调用时机**: 换机、新成员接手在途 CR，或本地 worktree 丢失时  
**参见**: resume-cr.pipeline.json（第 2 节点）

---

## 用途

在没有本地 CR worktree 的环境中，按 CR-ID 从远端 origin 拉取 `requirement/{cr_id}` 分支并重建所有 active repo 的同名 worktree，恢复完整的开发工作区。适用于换电脑、多人接力、worktree 意外删除等场景。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID（如 CR-2026-001） |
| `new_owner` | string | 否 | 接手人标识；若指定则同时更新指定角色 owner（建议配合 `handover-cr` 使用） |
| `new_owner_role` | enum | 否 | 接手角色：`requirement` / `development` / `test`，默认 `development` |

---

## 执行步骤

> **执行方式**：所有 git 命令必须通过受控 shell 执行（见 `skills/shared/controlled-shell/SKILL.md`）。**禁止**回退到手工指引文本。

### Step 1 — 解析 repo map 并校验远端分支存在（受控 shell）

1. 读取 `AGENTS.md`、`dir-graph.yaml#repositories`。
2. 选择 `active != false` 的 repo。
3. 对每个 repo 计算：
   - `bucket = knowledge-base`（当 `repo.role=knowledge-base`）或 `repo.id`
   - `worktreePath = {workspaceRoot}/.rayai-worktrees/{bucket}/requirement/{cr_id}`
   - `branch = requirement/{cr_id}`
4. 对所有 active repo 先执行远端分支预检；任一 repo 缺少远端分支则整体 abort，不创建任何 worktree。

```ts
const ls = await runGit({ subcommand: "ls-remote",
  args: ["--heads", "origin", `requirement/${crId}`],
  cwd: repo.path });
if (!ls.ok || ls.stdout.trim().length === 0) {
  // 远端分支不存在：停止执行
}
```

若远端分支不存在，停止执行并提示：该 CR 尚未推送到远端，请联系原持有者执行 `push-progress`。

### Step 2 — 重建所有 active repo worktree（受控 shell）

对每个 active repo 执行：

```ts
await runGit({ subcommand: "fetch", args: ["origin"], cwd: repo.path });
await runGit({ subcommand: "worktree",
  args: ["add", repo.worktreePath,
         "-b", `requirement/${crId}`,
         "--track", `origin/requirement/${crId}`],
  cwd: repo.path });
```

> 若本地已存在同名 worktree，返回结构化错误（`EXEC_FAILED`，stderr 含 "already exists"），提示改用 `pull-progress`；若确需重建，必须先走受控清理入口移除已有 worktree。

### Step 3 — 读取 CR 状态

从 knowledge-base CR worktree 的 `change-requests/{cr_id}/cr.md` 读取：
- `status`：当前阶段
- `owners`：requirement / development / test 三类负责人及 assigned-at
- `last-push-at`：最后推送时间
- `handover-history`：历史转交记录

### Step 4 — 更新角色 owner（若 new_owner 指定）

若指定了 `new_owner`：
1. 将 `new_owner_role` 默认为 `development`，并校验取值为 `requirement` / `development` / `test`
2. 更新 `change-requests/{cr_id}/cr.md` 中的 `owners.{new_owner_role}.id`
3. 更新 `owners.{new_owner_role}.assigned-at` 为当前时间
4. 若角色为 `requirement`，同步顶层兼容字段 `owner`
5. 追加 `owner-history` 与 `handover-history` 记录（role / from / to / at）
6. 更新 `change-requests/_backlog.yml` 对应条目的同名字段

### Step 5 — 输出摘要

```
✅ 工作区恢复完成
   CR              : {cr_id}
   当前状态        : {status}
   worktrees       : [{repo.id}: .rayai-worktrees/{bucket}/requirement/{cr_id}, ...]
   owners          : requirement={id@assigned-at}, development={id@assigned-at}, test={id@assigned-at}
   新 owner        : {new_owner_role}:{new_owner}（如已指定）
   最后推送时间    : {last-push-at}

➡️  按当前状态和评审证据继续：
   - drafting → requirement-authoring：从 write-requirement-prd / review-requirement 继续
   - requirement-reviewing + requirement.yml verdict=pass 且 blockers=[] → 等待 human_approval，下一节点 approve-requirement
   - requirement-reviewing + requirement.yml 未通过或缺失 → 回到 write-requirement-prd 自修复并重审
   - requirement-approved → architecture-design：从 write-tech-design 开始
   - tech-designing → architecture-design：从 write-tech-design / review-tech-design 继续
   - tech-design-review-pending + sdd.yml verdict=pass 且 blockers=[] → 等待 human_approval，下一节点 approve-tech-design
   - tech-design-review-pending + sdd.yml 未通过或缺失 → 继续 review-tech-design，或回到 write-tech-design 自修复
   - tech-design-reviewed → code-implementation：从 write-dev-plan 开始
   - task-breakdown → 等待开发启动 human_approval，下一节点 approve-dev-start；若任务需修订则回到 write-dev-tasks
   - developing → code-implementation：从 implement-code / write-test-report / review-code 继续
   - code-reviewing + code.yml verdict=pass、blockers=[] 且 test-report.md status=pass → 等待 human_approval，下一节点 approve-code
   - code-reviewing + 代码评审或测试报告未通过 → 回到 implement-code 自修复并重测重审
   - code-approved → feature-writeback pipeline
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| 任一 active repo 远端分支不存在 | 停止执行，提示联系原持有者 `push-progress`；不得部分恢复 |
| 本地 worktree 已存在（stderr 含 `already exists`） | 返回结构化错误，建议改用 `pull-progress`（已有 worktree 的增量同步） |
| `cr.md` 不在恢复的 worktree 中 | 提示 CR 目录可能在 main 分支，检查 `change-requests/_backlog.yml` |
| 受控 shell 不可用（`SHELL_UNAVAILABLE`） | 停止执行，返回结构化错误；**禁止**输出「请在终端运行」提示 |

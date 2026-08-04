---
name: requirement-register
description: 需求编写期入口：生成 CR-ID，在 knowledge-base trunk 登记 CR 并提交注册记录，再按 dir-graph.yaml repositories 为所有 active repo 创建同名 requirement/CR-* worktree。
---

# Skill: requirement-register

**类型**: 需求期 Skill（requirement/ 组，入口节点）  
**调用时机**: requirement-authoring pipeline 第 1 节点

---

## 用途

需求编写的起点。完成以下三件事：
1. 生成唯一 CR-ID（格式 `CR-YYYY-NNN`，NNN 自增）
2. 在 `change-requests/_backlog.yml` 注册 CR 条目（不含 status/updated-at，status 只落 cr.md），并在 `change-requests/_index.yml` 追加条目
3. 将注册记录提交到 knowledge-base trunk，保证 main 可感知在途 CR
4. 按 `dir-graph.yaml#repositories` 为所有 `active != false` 的 repo 创建同名 worktree 分支 `requirement/CR-YYYY-NNN`（不切换当前 HEAD）

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ❌ | 显式指定 CR-ID；为空时自动生成。指定时必须符合 `CR-YYYY-NNN` 且未被占用 |
| `title` | string | ✅ | 需求标题（写入 cr.md） |
| `summary` | string | ✅ | 需求摘要（1-3 句，写入 cr.md） |
| `requirement_owner` | string | ✅ | 需求负责人（写入 cr.md owners.requirement） |
| `dev_owner` | string | ✅ | 开发负责人（写入 cr.md owners.development） |
| `test_owner` | string | ✅ | 测试负责人（写入 cr.md owners.test） |
| `target_version` | string | ❌ | 目标版本（写入 cr.md frontmatter） |
| `source` | string | ❌ | 来源（如 planning-report 路径 / user-feedback / idea） |

---

## 执行步骤

### Step 1 — 读取 graph 并确定 CR-ID

1. 读取 `AGENTS.md`、`dir-graph.yaml`。
2. 解析 `repositories[*]` 中 `active != false` 的参与仓：
   - `role=knowledge-base` 的仓作为注册仓，bucket 固定为 `knowledge-base`
   - 其他 active repo 的 bucket 使用 `repo.id`
   - 每个 repo 的 trunk 取 `repo.trunk`，缺失则返回 `REPO_TRUNK_UNRESOLVED`
3. 确认 knowledge-base trunk 工作区 clean；若存在未提交变更，返回 `REGISTRATION_TRUNK_DIRTY`，不得继续。
4. 若输入 `cr_id` 为空，读取 `change-requests/_index.yml` 中最大 NNN 值，并生成 `CR-{YYYY}-{NNN+1}`（NNN 三位补零，如 CR-2026-003）。
5. 若输入 `cr_id` 非空，校验格式为 `CR-YYYY-NNN`，并确认 `change-requests/_index.yml`、`change-requests/_backlog.yml`、`change-requests/{cr_id}/` 中均不存在同名记录。

### Step 2 — 在 knowledge-base trunk 创建注册记录

在 `change-requests/{CR-ID}/` 下创建 `cr.md`：

```yaml
---
id: {CR-ID}
title: {title}
summary: {summary}
owner: {requirement_owner}   # 兼容字段；权威角色归属见 owners
owners:
  requirement:
    id: {requirement_owner}
    assigned-at: {created timestamp}
  development:
    id: {dev_owner}
    assigned-at: {created timestamp}
  test:
    id: {test_owner}
    assigned-at: {created timestamp}
target-version: {target_version 或 tbd}
source: {source 或 manual}
status: drafting
created: {YYYY-MM-DDTHH:mm:ss+08:00}
updated: {YYYY-MM-DDTHH:mm:ss+08:00}
remote-ref: ""
last-push-at: ""
last-push-by: ""
owner-history:
  - role: requirement
    from: ""
    to: {requirement_owner}
    at: {created timestamp}
    reason: initial-assignment
  - role: development
    from: ""
    to: {dev_owner}
    at: {created timestamp}
    reason: initial-assignment
  - role: test
    from: ""
    to: {test_owner}
    at: {created timestamp}
    reason: initial-assignment
handover-history: []
---
```

### Step 3 — 登记 _backlog.yml 和 _index.yml

- 在 `change-requests/_backlog.yml` 的 `backlog[]` 中追加条目（包含 id/owners/merge-commits 等低频字段，**不含** status/updated-at；status 只落 cr.md）
- 在 `change-requests/_index.yml` 的 `change-requests[]` 中追加摘要条目（id / title / status / created）

### Step 4 — 提交注册记录到 knowledge-base trunk

> **执行方式**：所有 git 命令 **必须**通过受控 shell 执行（详见 `skills/shared/controlled-shell/SKILL.md`）。
> Tauri 桌面壳、opencode session 或其他运行时必须提供平台注入的受控 git 适配器。
> **禁止**在失败时输出「请在终端运行」类手工指引；应返回结构化错误 `{ code: "SHELL_UNAVAILABLE" | ... }`。

在创建任何 CR worktree 之前，必须先把注册记录提交到 knowledge-base trunk：

```ts
await runGit({ subcommand: "add", args: ["change-requests/_backlog.yml", "change-requests/_index.yml", `change-requests/${crId}/cr.md`], cwd: knowledgeBaseRepo.path });
await runGit({ subcommand: "commit", args: ["-m", `[cr] register ${crId}: ${title}`], cwd: knowledgeBaseRepo.path });
await runGit({ subcommand: "push", args: ["origin", knowledgeBaseRepo.trunk], cwd: knowledgeBaseRepo.path });
```

> 这样新建的 knowledge-base CR worktree 会从包含 `cr.md` / `_backlog.yml` 注册记录的 trunk 派生，后续 `write-requirement-prd` 不会读到空 worktree。

### Step 5 — 为所有 active repo 创建 worktree 分支（通过受控 shell 执行）

对 Step 1 解析出的每个 active repo 执行：

**受控 shell 调用序列**：

```ts
const bucket = repo.role === "knowledge-base" ? "knowledge-base" : repo.id;
await runGit({ subcommand: "fetch", args: ["origin"], cwd: repo.path });
await runGit({ subcommand: "worktree",
  args: ["add", "-b", `requirement/${crId}`,
         `${workspaceRoot}/.rayai-worktrees/${bucket}/requirement/${crId}`,
         repo.trunk],
  cwd: repo.path });
```

> **注意**：worktree 创建后不自动切换当前主工作区 HEAD。任一 active repo 创建失败时，返回结构化错误并列出已创建的 worktree，交由受控清理入口处理；不得继续写 PRD。

### Step 6 — 输出摘要

```
✅ CR 已注册
   CR-ID       : {CR-ID}
   分支        : requirement/{CR-ID}
   需求负责人  : {requirement_owner} @ {timestamp}
   开发负责人  : {dev_owner} @ {timestamp}
   测试负责人  : {test_owner} @ {timestamp}
   注册提交    : knowledge-base trunk 已包含 cr.md / _backlog.yml
   Worktree    : [{repo.id}: .rayai-worktrees/{bucket}/requirement/{CR-ID}, ...]
   cr.md       : change-requests/{CR-ID}/cr.md
   下一步      : 在 .rayai-worktrees/knowledge-base/requirement/{CR-ID} 中执行 write-requirement-prd
```

```yaml
execution_context:
  cr_id: {CR-ID}
  branch: requirement/{CR-ID}
  knowledge_base_worktree: {workspaceRoot}/.rayai-worktrees/knowledge-base/requirement/{CR-ID}
  repo_worktrees:
    - repo: knowledge-base
      role: knowledge-base
      path: {workspaceRoot}/.rayai-worktrees/knowledge-base/requirement/{CR-ID}
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| `_index.yml` 不存在 | 初始化新建，从 001 开始编号 |
| knowledge-base trunk 不干净 | 返回 `REGISTRATION_TRUNK_DIRTY`，要求先保存或清理当前变更 |
| `repo.trunk` 缺失 | 返回 `REPO_TRUNK_UNRESOLVED`，不得创建任何 worktree |
| 分支已存在 | 停止执行，提示先检查是否重复注册 |
| 受控 shell 不可用（`SHELL_UNAVAILABLE`） | 停止执行，返回结构化错误；**禁止**输出「请在终端运行」提示 |
| git 命令执行失败（`EXEC_FAILED`） | 展示 stderr；对 `worktree add` 重复分支错误，回退到「分支已存在」分支处理 |

---
name: requirement-register
description: 需求编写期入口：生成 CR-ID，在 knowledge-base trunk 登记 CR 并提交注册记录，再按 dir-graph.yaml repositories 为所有 active repo 创建同名 requirement/CR-* worktree。
---

# Skill: requirement-register

**类型**: 需求期 Skill（requirement/ 组，入口节点）  
**调用时机**: requirement-authoring pipeline 第 1 节点

---

## 用途

需求编写的起点。完成以下四件事：
1. 生成唯一 CR-ID（格式 `CR-YYYY-NNN`，NNN 自增）
2. 在 `change-requests/_backlog.yml` 注册 CR 条目（不含 status/updated-at，status 只落 cr.md），并在 `change-requests/_index.yml` 追加条目<!-- lint-prompts:ignore --> 描述性：登记由 crctl cr-init 原子完成（Step 2）
3. 将注册记录提交到 knowledge-base trunk，保证 main 可感知在途 CR
4. 按 `dir-graph.yaml#repositories` 为所有 `active != false` 的 repo 创建同名 worktree 分支 `requirement/CR-YYYY-NNN`（不切换当前 HEAD）

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
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

### Step 2 — 权威注册：crctl cr-init（S8，唯一权威分配与建档）

1. 运行 `crctl cr-init --title "{title}" --owner-requirement {requirement_owner} [--year Y] --workspace <ws>`（**不取显式 cr-id 入参**——SDD-BLOCK-001 语义：内部分配 `CR-{Y}-{NNN+1}`，以 `casWriteMulti` 原子写 `cr.md`(新建) + `_backlog.yml`(追加) + `_index.yml`(登记)，成功后在输出 JSON 返回分配到的 `cr`）。
   - `cr.md` frontmatter 全量由 crctl 生成（owners/owner-history/时间戳 = identity(ws)/nowIso()）；`--owner-requirement` 只提供被指派人业务身份。
   - 并发下后到者见 `_index`/`_backlog` hash 已变 → `CAS_CONFLICT`，三文件全不落盘 → **重跑 cr-init**（重读 max、自动拿新号），不撞号。
   - `cr_id` 变量 = cr-init 返回的 `cr` 字段。
2. **模型不得手写 `cr.md`/追加 `_backlog.yml`/登记 `_index.yml`**（guard deny + cr-init 独占，含 CAS+审计）。
3. `summary`/`source`/`target-version` 等注册元信息字段由注册方在 cr-init 建档后直接补全 `cr.md` frontmatter，随 Step 3 的 register 提交一并入库（先例：CR-2026-021 register 提交即含完整 summary/source）。注：`crctl backlog-set`（S5）白名单仅 `prd-path|sdd-path`，不承担 summary 写入。

### Step 3 — 提交注册记录到 knowledge-base trunk

> **执行方式**：所有 git 命令 **必须**通过受控 shell 执行（详见 `skills/shared/controlled-shell/SKILL.md`）。
> Tauri 桌面壳、opencode session 或其他运行时必须提供平台注入的受控 git 适配器。
> **禁止**在失败时输出「请在终端运行」类手工指引；应返回结构化错误 `{ code: "SHELL_UNAVAILABLE" | ... }`。

在创建任何 CR worktree 之前，必须先把注册记录提交到 knowledge-base trunk：

```ts
<!-- lint-prompts:ignore --> 受控 shell 代码块：runGit = 受控 git 适配器（S10 模板经 crctl git commit）
await runGit({ subcommand: "add", args: ["change-requests/_backlog.yml", "change-requests/_index.yml", `change-requests/${crId}/cr.md`], cwd: knowledgeBaseRepo.path });
await runGit({ subcommand: "commit", args: ["--template", "register", "--cr", crId, "-m", title], cwd: knowledgeBaseRepo.path });  // S10（FR-10）：--cr 直传 cr-init 返回的已知 CR 号，跳过分支探测/subject 正则反向解析
await runGit({ subcommand: "push", args: ["origin", knowledgeBaseRepo.trunk], cwd: knowledgeBaseRepo.path });
```

> 这样新建的 knowledge-base CR worktree 会从包含 `cr.md` / `_backlog.yml` 注册记录的 trunk 派生，后续 `write-requirement-prd` 不会读到空 worktree。

### Step 5 — 为所有 active repo 创建 worktree 分支（通过受控 shell 执行）

对 Step 1 解析出的每个 active repo 执行：

**受控 shell 调用序列**：

```ts
// 路径拼接用 crctl worktree-path 的唯一权威规则（S9）：bucket = role==='knowledge-base' ? 'knowledge-base' : repo.id
const wt = await runCrctl(["worktree-path", crId, "--repo", repo.id, "--workspace", workspaceRoot]);
await runGit({ subcommand: "fetch", args: ["origin"], cwd: repo.path });
await runGit({ subcommand: "worktree",
  args: ["add", "-b", `requirement/${crId}`,
         wt.path,
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
<!-- lint-prompts:ignore --> 输出摘要：仅展示路径
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

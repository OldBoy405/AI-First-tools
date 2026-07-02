---
name: controlled-shell
description: 受控 shell 执行规范（方案 a）。所有 sync/requirement 组 skill 中的 git 命令必须通过受控 shell 执行，禁止输出「请在终端手工运行」的文本指引。
---

# Skill: controlled-shell

**类型**: 基础能力 Skill（shared/ 组，被 requirement-register / push-progress / pull-progress / resume-from-remote / handover-cr / merge-feature-branch / cr-archive / review-code 引用）
**版本**: v0.1.0（去 MCP 化，基于 Tauri plugin-shell + opencode SDK session.shell）

---

## 用途

为所有需要执行 git 命令或只读 git 证据采集的 skill 提供统一的受控 shell 执行契约：

1. **白名单化**：仅允许预设 git 子命令，避免任意 shell 片段透传
2. **环境自适应**：Tauri 桌面壳 → `@tauri-apps/plugin-shell`；opencode session → `client.session.shell`；均不可用 → 返回结构化错误
3. **禁止回退文本**：**禁止**在 agent 输出中回退到「请在终端运行以下命令」这类人工指引，必须给出结构化错误对象

---

## 命令白名单

| git 子命令 | 用途 | 调用者 |
|---|---|---|
| `worktree` | `add -b` / `add --track` / `remove` / `remove --force` / `list` | requirement-register, resume-from-remote, cr-archive |
| `branch` | `-d` / `-D` / `--show-current` | merge-feature-branch |
| `checkout` | 切换 ref | merge-feature-branch |
| `fetch` | `fetch origin` / `fetch origin <trunk>` | resume-from-remote, pull-progress, merge-feature-branch, cr-archive |
| `pull` | `pull --ff-only` | pull-progress |
| `push` | `push -u origin <branch>` / `push origin <trunk>` / `push origin --delete <branch>` | push-progress, handover-cr, merge-feature-branch, cr-archive |
| `add` | `add -A` / `add <path...>` | requirement-register, push-progress, merge-feature-branch, cr-archive |
| `commit` | `commit -m "wip: ..."` / `commit -m "[cr] ..."` / `commit -m "merge(CR-...): ..."` | requirement-register, push-progress, cr-status-set, inbox-emit, cr-review-record, merge-feature-branch, cr-archive |
| `status` | `status --short` | pull-progress, cr-archive |
| `diff` | `diff --cached --quiet` / `--stat` / `--name-only <range>` / `--unified=N <range>` | push-progress, review-code |
| `log` | `log --oneline -N` / `log --oneline <range>` | review-code |
| `ls-remote` | `ls-remote --heads origin` | resume-from-remote |
| `rev-parse` | `rev-parse HEAD` / `rev-parse origin/<ref>` | push-progress, merge-feature-branch |
| `merge-base` | `merge-base origin/<trunk> HEAD` / `merge-base --is-ancestor <sha> origin/<trunk>` | review-code, merge-feature-branch, cr-archive |
| `merge-tree` | `merge-tree --write-tree origin/<trunk> origin/<branch>` | merge-feature-branch |
| `merge` | `merge --no-commit --no-ff <branch>` / `merge --abort` / `merge --no-ff <branch> -m <message>` | merge-feature-branch |
| `revert` | `revert --no-edit -m 1 <merge-sha>` / `revert --no-edit <metadata-sha>` | merge-feature-branch compensation |
| `config` | `config --get user.name` | requirement-register |
| `remote` | `remote -v` | resume-from-remote |

> 超出白名单的命令 **一律禁止执行**；如确有必要，需先扩展本 Skill 的白名单。

---

## 执行契约（调用者必须遵守）

### 1. 优先级（按环境）

| 运行环境 | 首选 | 次选 |
|---|---|---|
| Tauri 桌面壳（`__TAURI_INTERNALS__` 存在） | 平台注入的 `runGit()` 受控适配器 | — |
| opencode session | 平台注入的 session shell 受控适配器 | `runGit()`（若 webview 可达） |
| 纯 Qoder IDE（agent 仅 markdown） | agent 直接调用 IDE 提供的 shell 工具（如 `run_in_terminal`） | 返回 `SHELL_UNAVAILABLE` |
| 以上均不可用 | **停止执行，返回结构化错误**，不得输出手工指引 | — |

### 2. 结构化错误格式

当 shell 不可用或命令失败时，skill 必须返回以下结构（JSON 或等价 YAML）：

```json
{
  "error": {
    "code": "SHELL_UNAVAILABLE" | "FORBIDDEN_SUBCOMMAND" | "EXEC_FAILED" | "UNEXPECTED",
    "message": "人类可读错误",
    "attempted_command": "git worktree add -b ...",
    "cwd": "/abs/path/or/relative",
    "stdout": "...",
    "stderr": "..."
  }
}
```

上层调用方（UI / 上游 skill）据此决定：
- `SHELL_UNAVAILABLE` → UI 弹出「一键执行」按钮（如 Tauri 可用）或引导用户切换到 opencode 会话
- `EXEC_FAILED` → 展示 stderr 帮助用户定位
- `FORBIDDEN_SUBCOMMAND` → 记入审计日志，提示扩展白名单或修正 skill

### 3. **明令禁止的表述**

以下表述在任何 skill 或 agent 输出中 **一律禁止**：

- ❌ "请在终端中运行以下命令"
- ❌ "当前环境无 Shell 执行权限"（agent 可见的回退提示）
- ❌ 任何把 git 命令原样粘贴给用户让其手动执行的文案

允许的表述（结构化错误的 UI 表达）：
- ✅ "受控 shell 不可用（code: SHELL_UNAVAILABLE）。请切换到 Tauri 桌面应用或 opencode session 后重试。"
- ✅ 「一键重试」按钮（触发 UI 层调用 `runGit`）

---

## 审计与日志

- 每次 `runGit()` 调用应在前端打印日志：`[controlled-shell] git {subcommand} {args} → {ok|code}`
- 失败调用应同时输出 stdout/stderr（截断至 2KB），供 review-code 层复盘
- 日志不包含用户凭证（git 不会输出凭证，但如有 `--password` 等参数应过滤）

---

## 运行时适配要求

- 目标平台必须提供一个受控 git 适配器，输入为 `{ subcommand, args, cwd }`，输出为 `{ ok, stdout, stderr, code }`。
- 适配器实现位置由目标平台决定，不得在 Skill 中硬编码本机绝对路径或特定产品源码路径。
- review-code 可复用同一受控适配器执行只读 diff/log/merge-base 命令。
- AGENTS.md Worktree 规则段应声明受控 shell 白名单说明。

---

## 版本历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1.0 | 2026-05-08T10:00:00+08:00 | 首版。白名单 15 条 git 子命令；要求 skill 返回结构化错误，禁止手工指引。 |

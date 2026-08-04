# crctl · Cursor hooks 适配器

对应 `docs/漂移治理_v2.md` 组件 B（P3）。Cursor 原生支持 hooks，且**官方兼容 Claude Code 的 hook 配置**（见 [Third Party Hooks](https://cursor.com/docs/reference/third-party-hooks)）。本目录提供两条安装路径：

## 路径 A（推荐）：Claude Code 兼容模式——零脚本，直接用现有配置

Cursor 能直接加载 `.claude/settings.json` 的 hooks（需开启 Third-party skills）：

1. Cursor Settings → Rules, Skills, Subagents → 开启 **Include third-party Plugins, Skills, and other configs**
2. 按 `../claude-code/README.md` 正常配置 `.claude/settings.json`（同一份配置同时服务 Claude Code 与 Cursor）
3. Cursor 自动把 hook 名与工具名映射到自身等价物：

| Claude Code hook | Cursor hook |
|---|---|
| `PreToolUse` | `preToolUse` |
| `UserPromptSubmit` | `beforeSubmitPrompt` |
| `SessionStart` | `sessionStart` |
| `PreCompact` | `preCompact` |
| `Stop` | `stop` |

| Claude Code 工具 | Cursor 工具 |
|---|---|
| `Bash` | `Shell` |
| `Write` / `Edit` | `Write` |

- Cursor 支持 Claude Code 的嵌套 `hookSpecificOutput` 响应格式与 exit code 2 阻断——**共享 guard 脚本无需修改**。
- 映射表里 `Notification`/`PermissionRequest` 不支持；`Glob`/`WebFetch`/`WebSearch` 工具不触发 hooks（影响有限：这些工具不涉及受控写入）。

## 路径 B：Cursor 原生格式（`.cursor/hooks.json`）

把 [hooks.json.template](hooks.json.template) 复制到目标 workspace 的 `.cursor/hooks.json`（项目级）或 `~/.cursor/hooks.json`（用户级），替换 `{TOOLS}`：

| 文件 | 作用域 | 路径基准 |
|---|---|---|
| `.cursor/hooks.json` | 项目级 | 从项目根解析（`.cursor/hooks/...`） |
| `~/.cursor/hooks.json` | 用户级 | 相对 `~/.cursor/` |

生效后：

| hook | 行为 |
|---|---|
| `sessionStart` | 经 [hooks/session-start-ctx.mjs](hooks/session-start-ctx.mjs) 薄包装：调用共享 inject 脚本并转换为 Cursor 扁平 `additional_context` 输出（Cursor 的 sessionStart 是 fire-and-forget） |
| `preToolUse`（matcher `Shell\|Write`） | 直接复用共享 guard 脚本（嵌套输出 Cursor 兼容；`Shell` 工具名已在 guard 归一化） |

## 与 Claude Code 适配器的差异

| 项 | Cursor | Claude Code |
|---|---|---|
| 配置位置 | `.cursor/hooks.json`（原生）或 `.claude/settings.json`（兼容模式） | `.claude/settings.json` |
| 事件名 | camelCase（`sessionStart`/`preToolUse`） | PascalCase（`SessionStart`/`PreToolUse`） |
| 工具名 | `Shell`（非 `Bash`）、`Write` | `Bash`、`Write`/`Edit`/`NotebookEdit` |
| sessionStart | fire-and-forget，输出扁平 `additional_context` | 同步，输出嵌套 `hookSpecificOutput.additionalContext` |
| 阻断语义 | exit 2 = deny（与 Claude Code 一致）；hook 崩溃默认 fail-open（可用 `failClosed: true` 收紧） | exit 2 = deny；其他码 fail-open |
| 热加载 | 支持（保存 hooks.json 自动重载） | 支持 |

## 验证安装

```bash
# sessionStart 薄包装：应输出 { additional_context: ... }
echo '{"session_id":"t1","cwd":"<workspace>"}' | node <tools>/tools/skills/shared/crctl/adapters/cursor/hooks/session-start-ctx.mjs

# preToolUse：Cursor 工具名 Shell，裸 git 应 deny
echo '{"tool_name":"Shell","tool_input":{"command":"git status"},"cwd":"<workspace>"}' | node <tools>/tools/skills/shared/crctl/adapters/claude-code/hooks/pretooluse-guard.mjs
```

然后让 Agent 尝试 `git commit`（应被 deny 并提示改用 `crctl git`）、尝试直接编辑 `change-requests/_backlog.yml`（应被 deny）。调试可看 Cursor 的 **Hooks output channel**。

## 边界说明

- hooks 是尽力而为的事前拦截，不是安全边界；配合 `crctl` gate 的事后否决与 `adapters/ci/` 的远端侧校验共同工作（v2 §5.4–5.6）。
- Cursor 的 `Notification`/`PermissionRequest` 事件不支持 Claude Code 映射，相关保护依赖 `crctl gate`。
- 官方文档：https://cursor.com/docs/hooks 、 https://cursor.com/docs/reference/third-party-hooks
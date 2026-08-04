# crctl · Codex hooks 适配器

对应 `docs/漂移治理_v2.md` 组件 B（P3）。Codex 原生支持 hooks，配置格式与 Claude Code **完全一致**（嵌套 `hooks` 数组 + `hookSpecificOutput` 输出协议），因此**直接复用 claude-code 适配器下的两个共享脚本**，本目录只提供配置模板与安装说明。

## 1. 安装 hooks

把 [hooks.json.template](hooks.json.template) 复制到：

| 文件 | 作用域 | 说明 |
|---|---|---|
| `~/.codex/hooks.json` | 用户级 | 对所有项目生效 |
| `<repo>/.codex/hooks.json` | 项目级 | 仅该项目；项目级 hooks 只在项目 `.codex/` 层被信任后加载 |
| `~/.codex/config.toml` 或 `<repo>/.codex/config.toml` | 等效 | 可用 `[[hooks.Event]]` 内联 TOML 替代 hooks.json（见官方文档） |

把模板中的 `{TOOLS}` 替换为 tools 包所在目录的绝对路径（正斜杠）。

## 2. 信任 hooks（Codex 特有）

Codex 对非托管 command hook 有**审查-信任**机制：新 hook 默认跳过，直到你在 Codex 会话里运行 **`/hooks`** 审查并信任（信任记录绑定 hook 当前哈希，脚本变更后需重新信任）。首次启用后：

```text
/hooks          # 列出 hook 源、审查新/变更 hook、信任、禁用单个 hook
```

## 3. 生效后的行为

| hook | 行为 |
|---|---|
| PreToolUse · matcher `Bash\|apply_patch\|Edit\|Write` | 裸 git → deny（只放行 `crctl git`）；重定向/`sed -i`/`mv` 等命中受控路径 → deny；**apply_patch 编辑受控文件 → deny/ask**（guard 从 patch 文本解析 `*** Add/Update/Delete File:` 路径） |
| SessionStart | 注入全部非终态 CR 的权威指针（Codex 支持 SessionStart，matcher 可加 `startup\|resume\|clear\|compact` 过滤） |
| UserPromptSubmit | 同上（每轮用户 prompt 时再注入一次） |

## 4. 与 Claude Code 适配器的差异

| 项 | Codex | Claude Code |
|---|---|---|
| 配置位置 | `.codex/hooks.json`（或 config.toml `[[hooks]]`） | `.claude/settings.json` |
| 文件编辑工具 | `apply_patch`（matcher 别名 `Edit`/`Write` 亦可匹配） | `Write`/`Edit`/`NotebookEdit` |
| matcher 语义 | **正则**（`Bash\|apply_patch`、`startup\|resume\|clear\|compact`） | 正则（同源实现） |
| 信任机制 | **有**（`/hooks` 审查-信任，按哈希） | 无 |
| timeout 默认 | 600s（可配 `timeout`，SessionEnd 默认 1s 上限 3s） | 30s |
| 额外事件 | 支持 `PermissionRequest`（可自动允许/拒绝审批请求）、`PreCompact`/`PostCompact`、`SubagentStart`/`SubagentStop` | 部分重叠 |
| 热加载 | 支持（配置变化自动重载） | 支持 |

**PermissionRequest 可选增强**：Codex 独有的 `PermissionRequest` 事件可在 Codex 要弹审批前自动裁决（如对 `crctl` 相关命令直接 allow）。本模板暂不启用（避免过度自动放行），如需可自行参照官方文档追加。

## 5. 验证安装

```bash
# PreToolUse：裸 git 应被 deny
echo '{"tool_name":"Bash","tool_input":{"command":"git status"},"hook_event_name":"PreToolUse","cwd":"<workspace>"}' | node <tools>/tools/skills/shared/crctl/adapters/claude-code/hooks/pretooluse-guard.mjs

# PreToolUse：apply_patch 改受控文件应被 deny（Codex 特有路径）
echo '{"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Update File: change-requests/_backlog.yml\n@@\n-foo\n+bar\n*** End Patch"},"hook_event_name":"PreToolUse","cwd":"<workspace>"}' | node <tools>/tools/skills/shared/crctl/adapters/claude-code/hooks/pretooluse-guard.mjs

# SessionStart：注入 CR 状态
echo '{"hook_event_name":"SessionStart","cwd":"<workspace>"}' | node <tools>/tools/skills/shared/crctl/adapters/claude-code/hooks/inject-cr-status.mjs
```

然后在 Codex 会话里让 Agent 尝试 `git commit`（应被 deny 并提示改用 `crctl git`）、尝试直接编辑 `change-requests/_backlog.yml`（应被 deny）。

## 6. 边界说明

- hooks 是尽力而为的事前拦截，不是安全边界；配合 `crctl` gate 的事后否决与 `adapters/ci/` 的远端侧校验共同工作（v2 §5.4–5.6）。
- Codex 的 hook 输出默认 2500 token 上限，超限自动落盘并给模型预览；注入内容很小不受影响。
- 官方文档：https://learn.chatgpt.com/docs/hooks 、 https://learn.chatgpt.com/docs/config-file/config-reference
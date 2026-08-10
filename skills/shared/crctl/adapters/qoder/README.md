# crctl · Qoder CN hooks 适配器

对应 `docs/漂移治理_v2.md` 组件 B（P3）。Qoder CN（通义 Lingma 系列）原生支持 hooks，配置格式与 Claude Code 完全一致（嵌套 `hooks` 数组 + `hookSpecificOutput` 输出协议），因此**直接复用 claude-code 适配器下的两个共享脚本**，本目录只提供配置模板与安装说明。

## 1. 安装 hooks

把 [settings.template.json](settings.template.json) 的 `hooks` 段合并进：

| 文件 | 作用域 | 优先级 | 可共享 |
|---|---|---|---|
| `~/.lingma/settings.json` | 用户级 | 1（最低） | 否 |
| `.lingma/settings.json` | 项目级 | 2 | 是（可提交 Git） |
| `.lingma/settings.local.json` | 项目级（本地） | 3 | 否（建议 .gitignore） |

把模板中的 `{TOOLS_ROOT}` 替换为 `dir-graph.yaml#workspace.tools_package_path` 指向的 tools 包绝对路径（建议正斜杠）。**修改配置后需重启 IDE 生效**（Qoder 当前不支持热加载）。

生效后：

| hook | 行为 |
|---|---|
| PreToolUse · Bash（兼容名，等价 `run_in_terminal`） | 裸 git → deny（只放行 `crctl git`）；重定向/`sed -i`/`mv` 等命中受控路径 → deny |
| PreToolUse · Write\|Edit（兼容名，等价 `create_file`/`search_replace`） | `_backlog.yml`、`cr.md`、`approval.yml`、`review-annotations/*.yml`、`review-loop.yml` → **deny**；`specs/**`、`delivery/**`、`test-report.md` → **ask** |
| UserPromptSubmit | 注入全部非终态 CR 的权威指针（Qoder 无 SessionStart 事件，注入挂在每次提交 prompt 时） |

## 2. 与 Claude Code 适配器的差异

| 项 | Qoder | Claude Code |
|---|---|---|
| 配置位置 | `.lingma/settings.json` | `.claude/settings.json` |
| SessionStart | **不支持**（注入改挂 UserPromptSubmit） | 支持 |
| PreCompact | **不支持** | 支持 |
| 工具名 | 双套：原生 `run_in_terminal`/`create_file`/`search_replace` 与兼容 `Bash`/`Write`/`Edit` 等价，matcher 用任一即可（运行时统一映射） | 单套 `Bash`/`Write`/`Edit`/`NotebookEdit` |
| 热加载 | 不支持，改配置需重启 | 支持 |

Guard 脚本已做工具名归一化（`Bash`/`Shell`/`run_in_terminal` 均识别为 shell 类；`Write`/`Edit`/`NotebookEdit`/`create_file`/`search_replace`/`apply_patch` 均识别为 edit 类），Qoder 无论用原生名还是兼容名配置 matcher，脚本都能正确处理。

## 3. 验证安装

用管道模拟测试（Qoder 文档示例协议，stdin JSON + exit code）：

```bash
# PreToolUse：裸 git 应被 deny（exit 2 或 stdout JSON deny）
echo '{"tool_name":"Bash","tool_input":{"command":"git status"},"hook_event_name":"PreToolUse","cwd":"<workspace>"}' | node {TOOLS_ROOT}/skills/shared/crctl/adapters/claude-code/hooks/pretooluse-guard.mjs
echo "Exit code: $?"

# UserPromptSubmit：注入 CR 状态
echo '{"hook_event_name":"UserPromptSubmit","cwd":"<workspace>"}' | node {TOOLS_ROOT}/skills/shared/crctl/adapters/claude-code/hooks/inject-cr-status.mjs
```

然后在 Qoder 面板里让 Agent 尝试 `git commit`（应被 deny 并提示改用 `crctl git`）、尝试直接编辑 `change-requests/_backlog.yml`（应被 deny）。

## 4. 边界说明

- hooks 是尽力而为的事前拦截，不是安全边界；配合 `crctl` gate 的事后否决与 `adapters/ci/` 的远端侧校验共同工作（v2 §5.4–5.6）。
- Qoder 无 SessionStart/PreCompact 事件，上下文注入只能在每次用户提交 prompt 时发生；长对话中途模型可能仍有状态记忆偏差，需要精确状态时让 Agent 先跑 `crctl status`。
- 官方文档：https://help.aliyun.com/zh/lingma/qoder-cn/user-guide/hooks
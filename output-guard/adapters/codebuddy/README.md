# OutputGuard · CodeBuddy Code 适配器安装说明（启用顺序第 3 位）

daemon 侧对 CodeBuddy **只写记忆文件与 skills 发现目录**，**没有** hooks 写点（不为其新开平台层写点）。因此挂载面是「项目级 / 用户级配置文件 + 显式安装一次」。

## 1. 三级 scope 与合并语义

| scope | 配置面 | 语义 |
|---|---|---|
| 项目级 | `<project-root>/.codebuddy/settings.json`（可提交、团队共享） | 多 scope hooks **合并**生效，不是覆盖 |
| 项目本地 | `<project-root>/.codebuddy/settings.local.json` | 同上（个人面） |
| 用户级 | `~/.codebuddy/settings.json` | 同上 |

安装动作 = 把 [settings.template.json](settings.template.json) 的 `hooks` 段**并入**目标配置并物化 `{TOOLS_ROOT}`；与既有用户 hooks 段取并集，不得覆盖整份文件。本工具不做自动合并。

## 2. 生效与验证

配置在会话启动时快照 ⇒ 需**重启到新会话**生效。Windows 下 hook command 经 Git Bash 执行，模板命令形态为 `node "<绝对路径>"`，不依赖 `cmd`/`PowerShell` 内建。

```bash
node "{TOOLS_ROOT}/output-guard/scripts/check-install.mjs" --tools-root "{TOOLS_ROOT}"
```

CodeBuddy 行应显示 `output-guard runtime=codebuddy coverage=full policy=v1`。真实会话冒烟按 `change-requests/CR-2026-069/evidence/ac14-smoke.md` 逐条记录；安装面不经 daemon（本仓 `../multica` 该面零 diff 可证）。

## 3. 行为与回滚

`PreToolUse` → `permissionDecision`（拒绝 + 替代写法）或 `modifiedInput`（读取族加上限）；`PostToolUse` → `hookSpecificOutput.updatedToolOutput` 替换为裁剪后正文 + trailer。逃生阀与四类行为与 Claude 面同构。

回滚：从上述配置移除本目录的 hooks 条目（新会话生效），其余 Runtime 不受影响。**不自动安装、不改写用户配置、不修复 Runtime。**

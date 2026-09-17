# OutputGuard · Claude Code 适配器安装说明（启用顺序第 2 位）

## 1. 三级 scope

| scope | 配置面 | 谁安装 |
|---|---|---|
| Project | `<project-root>/.claude/settings.json`（可提交、团队共享）或 `.claude/settings.local.json` | 显式安装一次（本目录模板） |
| User | `~/.claude/settings.json` | 显式安装一次（本目录模板） |
| Managed | `{workDir}/.claude/settings.json`（Multica 每任务 env） | daemon 单写入点合成，**不由本目录安装**；目标文件已存在时不写/不合并/不覆盖 |

## 2. 安装（Project / User，一次）

把 [settings.template.json](settings.template.json) 的 `hooks` 段**并入**目标配置（合并、不是覆盖），并把 `{TOOLS_ROOT}` 物化为 tools 包绝对路径。已有 hooks 段取并集，不得覆盖他人配置；本工具不做自动合并。

## 3. 生效与验证

配置在会话启动时快照 ⇒ 安装后需**重启到新会话**生效。验证：

```bash
node "{TOOLS_ROOT}/output-guard/scripts/check-install.mjs" --tools-root "{TOOLS_ROOT}"
```

Claude 行应显示 `output-guard runtime=claude coverage=full policy=v1`。真实会话冒烟按 `change-requests/CR-2026-069/evidence/ac14-smoke.md` 的四类行为逐条记录。

## 4. 行为

| hook | 行为 |
|---|---|
| `PreToolUse` | 命中命令族且可判定 → `hookSpecificOutput.permissionDecision=deny` + 可执行替代写法；读取族 → `permissionDecision=allow` + `updatedInput` 加上限；不确定 → 无决策（放行） |
| `PostToolUse` | 超阈值 → `hookSpecificOutput.updatedToolOutput` 替换为裁剪后正文 + trailer（`complete=false`）；不可保持 → 只追加 `coverage=unavailable` 一行、正文逐字不改；未命中 → 无决策 |

逃生阀：`# output-guard: full reason=<一句话>`（命令首行）。只跳过 OutputGuard 封顶，不影响既有安全控制面。

## 5. 回滚

从安装配置移除本目录的 hooks 条目即可（新会话生效）；Managed scope 的合成面回滚见 `../multica` 的登记条目。**不自动安装、不改写用户配置、不修复 Runtime。**

# OutputGuard · Qoder 适配器安装说明（启用顺序第 4 位）

Qoder 的 hook 协议族与 Claude Code 一致（`PreToolUse` / `PostToolUse` + `hookSpecificOutput.updatedToolOutput`）。

## 1. 安装面（三级，显式一次）

| scope | 配置面 |
|---|---|
| 用户级 | `~/.lingma/settings.json` |
| 项目级 | `<project-root>/.lingma/settings.json` |
| 项目本地 | 项目级同目录的本地配置面 |

安装动作 = 把 [settings.template.json](settings.template.json) 的 `hooks` 段**并入**目标配置并物化 `{TOOLS_ROOT}`；与既有 hooks 段取并集。改配置需**重启到新会话**生效。

模板的 `matcher` 覆盖 `capabilities.json` 中本 Runtime **已声明的全部路径**（含 `read_file` 这类非 shell 路径：它不走命令族判定，封顶由 Post 面承担）；`matcher` 与声明的双向一致性由 `test/adapters-contract.test.mjs` 机械核对。

> **实现期核实记录（F-2 复核项，登记而非静默吸收）**：本 CR 实施期按 Qoder 现行 CLI hooks 文档复核，文档给出的配置面为 `~/.qoder/settings.json` / `<project>/.qoder/settings.json` / `<project>/.qoder/settings.local.json`，并列出 `SessionStart`（matcher=`source`）。已审批设计（`dep-11` 与 SDD §2.2.2）取 `.lingma/settings.json` 且 `startRecord=none`。**结论是否受影响**：结果回填能力（`updatedToolOutput`）与 `level=full` 的判定**不受影响**；受影响的是安装面路径与「无会话启动记录」两条事实。本目录按已审批设计声明，同时保留本条差异供人工复核（改判属 scope amendment，不在实施期内自行改写）。

## 2. 生效与验证

```bash
node "{TOOLS_ROOT}/output-guard/scripts/check-install.mjs" --tools-root "{TOOLS_ROOT}"
```

Qoder 行应显示 `output-guard runtime=qoder coverage=full policy=v1`。覆盖度口径：本 Runtime 不产生会话启动记录，FR-8 侧只能由结果 trailer 与安装期检查读数派生覆盖度——**不得**伪造启动记录，也不得用其它事件冒充会话启动。

## 3. 行为与回滚

`PreToolUse` → `permissionDecision` / `updatedInput`；`PostToolUse` → `hookSpecificOutput.updatedToolOutput`。逃生阀与四类行为与 Claude 面同构。

回滚：从 `.lingma/settings.json` 移除本目录的 hooks 条目（重启生效）。**不自动安装、不改写用户配置、不修复 Runtime。**

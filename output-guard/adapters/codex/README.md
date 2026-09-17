# OutputGuard · Codex 适配器安装说明（启用顺序第 5 位，**partial**）

Codex 的结果回填不是透明替换，走 `PostToolUse` 的 block/feedback 路径，因此本 Runtime 只能按 **partial** 覆盖声明，未覆盖路径逐条列示。

## 1. 安装（宿主级 / 项目级，显式一次）

把 [hooks.json.template](hooks.json.template) 的 `hooks` 段并入 `~/.codex/hooks.json`（用户级）或 `<repo>/.codex/hooks.json`（项目级）；`config.toml` 的 `[hooks]` 表与其等效。matcher 为正则。物化 `{TOOLS_ROOT}` 为绝对路径。模板的 `matcher` 覆盖 `capabilities.json` 中本 Runtime **已声明的已覆盖路径**（含 `apply_patch`；它不走命令族判定，封顶由 Post 面承担）；`matcher` 与声明的双向一致性由 `test/adapters-contract.test.mjs` 机械核对。

## 2. 信任步骤（前置，不可跳过）

非托管 command hook 必须经 **`/hooks` 面板审查-信任**后才会运行；信任**按哈希**——hook 脚本内容变更后需**重新信任**，否则 hook 静默不生效。这是本 Runtime 特有的部署风险。

## 3. 未覆盖路径（逐条声明，与 capabilities 声明一一对应）

以下路径不经本地 hook，本适配器**不生效**，不追求全覆盖：

- `hosted-WebSearch`（hosted 搜索路径）
- `codex-cloud-tasks`（云端任务路径）

## 4. 生效与验证

```bash
node "{TOOLS_ROOT}/output-guard/scripts/check-install.mjs" --tools-root "{TOOLS_ROOT}"
```

Codex 行应显示 `output-guard runtime=codex coverage=partial policy=v1`。真实会话冒烟按 `change-requests/CR-2026-069/evidence/ac14-smoke.md` 逐条记录，并至少实测一条上述 uncovered 路径「不生效」。

## 5. 行为与回滚

`PreToolUse` → `hookSpecificOutput.permissionDecision` / `updatedInput`；`PostToolUse` → `{ decision: "block", reason: <裁剪后正文 + trailer> }`（Codex 以该 feedback 替换工具结果并继续）。

回滚：移除 hooks 条目（新会话生效）。**不自动安装、不改写用户配置、不修复 Runtime。**

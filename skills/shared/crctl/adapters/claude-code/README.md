# crctl · Claude Code 适配器安装说明

对应 `docs/漂移治理_v2.md` 组件 B（P3）。在目标 workspace（不是本 tools 包仓库）执行以下步骤。

## 1. 安装 hooks

把 [settings.template.json](settings.template.json) 的 `hooks` 段合并进目标 workspace 的 `.claude/settings.json`（团队共享）或 `.claude/settings.local.json`（个人）。模板假设 tools 包安装在 workspace 的 `tools/` 下；路径不同请同步修改三处 `command`。

生效后：

| hook | 行为 |
|---|---|
| PreToolUse · Bash | 裸 git → deny（只放行 `crctl git`）；重定向/`sed -i`/`mv` 等命中受控路径 → deny |
| PreToolUse · Write/Edit/NotebookEdit | `_backlog.yml`、`cr.md`、`approval.yml`、`review-annotations/*.yml`、`review-loop.yml` → **deny**（crctl 独占）；`specs/**`、`delivery/**`、`test-report.md` → **ask**（人工放行合法回写） |
| SessionStart / UserPromptSubmit | 注入 `_backlog.yml` 中全部非终态 CR 的权威指针（渐进加载的 IDE 等价物） |

## 2. 主工作区代码目录围栏（可选但建议）

hooks 无法通用地推断「哪些目录是主工作区代码目录」。在目标 workspace 创建 `.crctl/hooks.json` 声明追加规则：

```json
{
  "extraDeny": ["^src/", "^packages/"],
  "extraAsk": []
}
```

含义：主工作区代码目录直接写入被拒（代码只写 CR worktree，README 禁止事项）。正则匹配相对路径（正斜杠）。

## 3. 验证安装

```bash
node tools/skills/shared/crctl/scripts/crctl.mjs status <CR-ID>
```

然后在 Claude Code 会话里让模型尝试 `git commit`（应被 deny 并提示改用 `crctl git`）、尝试直接编辑 `change-requests/_backlog.yml`（应被 deny）。

## 边界说明

- hooks 是尽力而为的事前拦截，不是安全边界；配合 `crctl` gate 的事后否决与 `adapters/ci/` 的远端侧校验共同工作（v2 §5.4–5.6）。
- 其余 IDE 适配器已提供：Qoder CN（dapters/qoder/，格式与 Claude Code 完全一致，无 SessionStart）、Cursor（dapters/cursor/，原生扁平格式或 Claude Code 兼容模式二选一）、Codex（dapters/codex/，格式一致 + /hooks 信任机制 + apply_patch）。Kimi/Cline 等未提供适配器的 IDE 依赖「crctl 唯一合法路径 + CI 远端否决」。

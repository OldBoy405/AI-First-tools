# OutputGuard · Pi 适配器安装说明（启用顺序第 1 位）

Pi 的 argv 面封闭（不放开 `--extension` 注入），因此挂载面只有**宿主级显式安装一次**。

## 1. 安装（宿主级，一次）

把本目录写进 Pi 的扩展清单（二选一）：

- `~/.pi/agent/settings.json` 的 `extensions[]` 增加本目录的**绝对路径**（`<TOOLS_ROOT>/output-guard/adapters/pi`）；
- 或把 `index.ts` 复制/软链到 `~/.pi/agent/extensions/` 下。

`PI_CODING_AGENT_DIR` 可覆盖配置目录（默认 `~/.pi/agent`）。扩展发现面与 `settings.json#extensions` 语义以 Pi 官方扩展文档为准；本目录不引入构建步骤、`package.json` 或第三方依赖。

## 2. 生效与验证

新会话生效。安装后运行：

```bash
node "{TOOLS_ROOT}/output-guard/scripts/check-install.mjs" --tools-root "{TOOLS_ROOT}"
```

Pi 行应显示 `output-guard runtime=pi coverage=full policy=v1`。真实会话冒烟按 `change-requests/CR-2026-069/evidence/ac14-smoke.md` 的四类行为逐条记录（拒绝 / 裁剪 / 逃生 / 降级）。

## 3. 行为

| hook | 行为 |
|---|---|
| `tool_call` | 命中命令族且可判定 → `{ block: true, reason }`（拒绝 + 可执行替代写法）；读取族 → 原地改写 `event.input` 的 `offset/limit`；不确定（管道/重定向）→ 放行，交由结果面统一封顶 |
| `tool_result` | 超阈值 → 返回 `{ content }` 局部 patch 并追加一行 trailer（`complete=false`）；字段/结构不可安全保持 → 只追加 `coverage=unavailable` 一行、正文逐字不改；未命中 → 不追加任何文本 |

逃生阀：命令首行写 `# output-guard: full reason=<一句话>` 可一次性取得完整结果。逃生阀只跳过 OutputGuard 自身的封顶，**不影响** controlled-shell 的 git 白名单 / 受控路径 / 审批 / 账本写入控制。

## 4. 回滚

从 `extensions[]` 移除本目录条目（或删除扩展文件）即可停用本 Runtime，新会话生效；其余 Runtime 不受影响。**本地已有配置时需人工合并，本工具不代为合并、不自动安装、不修复 Runtime。**

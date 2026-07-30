---
name: crctl
description: CR 状态机 gate CLI（漂移治理 v2 组件 A）：在 IDE 单独使用本 tools 包时，作为 cr-status-set / controlled-shell / validate-doc 的代码化执行器，把状态推进、门禁校验、人工审批、git 白名单从「模型自觉」变成「代码强制」。
---
<!-- meta
id: crctl
title: crctl 状态机 gate CLI
status: active
kind: skill
scope: drift-governance
-->

# Skill: crctl

**类型**: 基础能力 Skill（shared/ 组，代码执行层）
**定位**: `docs/漂移治理_v2.md` 的组件 A 实现。当本 tools 包脱离平台（渐进加载 + pipeline 执行约束层）在 Codex / Claude Code / Cursor / Kimi / Qoder 中单独使用时，本 Skill 提供的 CLI 是**权威状态的唯一合法写入路径**。

## 用途

| 子命令 | 作用 | 是现有哪个契约的代码化 |
|---|---|---|
| `status` | 确定性读 `_backlog.yml` + `dir-graph.yaml#state_machine`，输出当前 status、合法下一步与门禁缺口。模型不得自报 status | `cr-status-set` 读取契约 |
| `advance` | 校验 `(current, next, trigger)` 合法转换 + 目标状态门禁，全过才写 `_backlog.yml` 与 `cr.md` frontmatter 并 commit；否则非零退出且**不写文件**。支持 `--embedded`（对应 `cr-status-set` 的 `commit_mode=embedded`） | `cr-status-set` |
| `gate` | 只校验不写，供预检与 CI 复用 | pipeline JSON `passCondition` |
| `approve` | **仅限交互式终端**的人工审批：展示证据摘要 → 人类确认 → 写 `approval.yml`（`via: crctl-approve`）→ 级联 advance。非 TTY 调用一律返回 `APPROVAL_REQUIRES_HUMAN`，无任何旁路参数或环境变量 | `human_approval` + `approve-*` |
| `validate` | 受控产物 schema 校验：cr.md / _backlog.yml 的 owners 三角色（id + assigned-at）、review-annotations 的 verdict 枚举与 blockers 结构、test-report / approval / traceability | `validate-doc` |
| `attempt` | review-loop 轮次唯一记账点（`change-requests/{CR-ID}/review-loop.yml`），maxAttempts 从 pipeline JSON 读取，超限返回 `LOOP_EXHAUSTED` | `reviewLoop.maxAttempts` |
| `test` | 代执行 lint/test/build 命令，按真实退出码生成 `test-report.md` 骨架（status/tester/commands 段模型不得改写），原始输出落盘 `test-evidence/` | `write-test-report` 证据部分 |
| `next` | 按 status + 评审/测试证据输出下一个该跑的节点；blocker 未清空**绝不**返回 `human_approval` | 最小 pipeline-runner |
| `git` | controlled-shell 白名单的 IDE 运行时适配器：按「子命令 + 形态 + 调用者」三元放行，越界返回 `FORBIDDEN_SUBCOMMAND`，全量审计日志 | `controlled-shell` |

## 单一事实源约定（重要）

本 Skill **不复刻规则副本**：

- 状态转换：运行时解析目标 workspace 的 `dir-graph.yaml#change-request-track.state_machine`（回退到本包同名文件）。
- 通过条件：运行时解析 `pipeline-templates/*.pipeline.json` 的 `reviewLoop.passCondition`。改 JSON 即改门禁，无需改代码。
- `gates.json` 只声明运行时适配信息：证据文件路径映射、审批段名、各状态适用哪个 pipeline 节点的 passCondition。

## 调用方式

```bash
node tools/skills/shared/crctl/scripts/crctl.mjs status CR-2026-001
node tools/skills/shared/crctl/scripts/crctl.mjs advance CR-2026-001 --to code-reviewing --trigger review-code
node tools/skills/shared/crctl/scripts/crctl.mjs approve CR-2026-001 --stage code        # 仅人类在终端运行
node tools/skills/shared/crctl/scripts/crctl.mjs git status --short --cwd <worktree>
```

要求 Node >= 18。`--workspace <path>` 可显式指定目标 workspace，默认从 cwd 向上探测 `change-requests/_backlog.yml`。

## 读取 / 写入 / 状态推进 / 失败处理

- **读取**：`change-requests/_backlog.yml`、`change-requests/{CR-ID}/`（cr.md、review-annotations/、test-report.md、approval.yml）、目标 workspace `dir-graph.yaml`、`tools/pipeline-templates/*.pipeline.json`、同目录 `gates.json`。
- **写入**：`_backlog.yml` 与 `cr.md` 的 status/updated-at（行级定点编辑，写前 sha256 CAS 复核，防并发覆盖）；`approval.yml`（仅 approve）；`review-loop.yml`（仅 attempt）；`test-report.md` 与 `test-evidence/`（仅 test）；`.crctl/audit.log`（审计，自动 gitignore）。时间戳与执行者身份一律由本工具生成，**拒绝调用方传入**。
- **状态推进**：只经 `advance`；`standalone` 模式自动 commit `[cr] status {CR-ID} {from} -> {to}`（经自身 git 白名单执行），`--embedded` 只写文件由调用方同事务提交。
- **失败处理**：结构化 JSON 错误到 stderr + 非零退出。错误码：`CR_STATUS_NOT_FOUND` / `CR_STATUS_CURRENT_MISMATCH` / `CR_STATUS_TRANSITION_NOT_ALLOWED` / `GATE_BLOCKED` / `APPROVAL_REQUIRES_HUMAN` / `APPROVAL_DECLINED` / `LOOP_EXHAUSTED` / `FORBIDDEN_SUBCOMMAND` / `CAS_CONFLICT` 等。任何校验失败都不写文件。

## IDE 适配器（adapters/）

- `adapters/claude-code/`：PreToolUse 守卫（裸 git、受保护路径写入、Bash 重定向）+ SessionStart/PreCompact 自动注入 `crctl status` 输出 + `settings.template.json`。安装方法见其 README。
- `adapters/ci/`：GitHub Actions 模板，在远端对 `requirement/*` 分支复用 `crctl gate` / `crctl validate` 做强制校验（无 hook IDE 的强兜底）。

## 与现有 Skill 的关系

- 本 Skill 是执行层，不新增编排语义；`cr-status-set`、`controlled-shell`、`validate-doc` 的契约仍是行为规范的事实源。
- Agent 在 IDE 环境应把「调用 cr-status-set」理解为「执行 `crctl advance`」，把「经 controlled-shell 执行 git」理解为「执行 `crctl git`」。
- 诚实边界（`docs/漂移治理_v2.md` §7）：本工具校验证据的存在与形状，不校验真伪与质量；approve 保证有人按键，不保证人认真看过。

## 版本历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1.0 | 2026-07-26 | 首版：status/advance/gate/approve/validate/attempt/test/next/git 九个子命令 + gates.json + IDE 适配器模板 |

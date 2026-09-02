---
name: requirement-register
description: 需求编写期入口：一次调用 crctl register 深原语完成 CR 注册与逐仓 worktree ensure；Skill 只做前置确认与结果分类，不写任何 Git 命令序列、不手写账本。
---

# Skill: requirement-register

**类型**: 需求期 Skill（requirement/ 组，入口节点）
**调用时机**: requirement-authoring pipeline 第 1 节点

---

## 用途

需求编写的起点：生成唯一 CR-ID（`CR-YYYY-NNN`），在 knowledge-base trunk 登记 CR，并按 `dir-graph.yaml#repositories` 为所有 active repo 创建 `requirement/{cr_id}` worktree。
以上全部由深原语 `crctl register` 独占完成（CR-2026-031 TASK-05）。

本 Skill 只拥有：**业务前置确认、一次深原语调用、结果分类**。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | ✅ | 需求标题 |
| `registration_key` | string | ✅ | 注册幂等键（同键同输入续跑、输入漂移拒绝） |
| `requirement_owner` | string | ✅ | 需求负责人 |
| `dev_owner` | string | ✅ | 开发负责人 |
| `test_owner` | string | ✅ | 测试负责人 |
| `summary` | string | ❌ | 需求摘要 |
| `target_version` | string | ✅ | 目标版本（注册阶段人工确定）：真实版本 `MAJOR.MINOR[.PATCH]`（不含 `v` 前缀与 `-rc` 后缀）或字面量 `unassigned`（未排期）。禁止 `tbd` 及同义值（`n/a`、`na`、`n.a.`、`pending`、`none`、`unknown`、`todo`、`wip`、`null`、`undefined`）；未排期时先向用户确认再写 `unassigned`（沿用 `origin`「填写前确认、不自行推测」先例，不自行推断版本）。非法输入被 crctl 以 `REGISTER_VERSION_INVALID` 硬失败零写入。后续 PRD/SDD/PLAN/TASK 一律继承该值；若需把 `unassigned` 更正为真实版本，唯一入口是 `crctl version-set {cr_id} --to <real-version>`（原子同步已存在派生产物，不改 status；不允许真实版本互改或改回 `unassigned`） |
| `target_spec_id` | string | ✅ | 目标 spec 标识（注册阶段人工确定）：匹配 `^[a-z0-9][a-z0-9._-]*$`，禁止 `/`、`\`、CR、LF、路径段。与 `target-version` 一起写入 cr.md 与 _backlog.yml 双账本（全等）；后续 writeback/archive 的 new 分支以它为 authority 唯一裁决事实。缺失/空 → `REGISTER_TARGET_SPEC_ID_REQUIRED`，非法 → `REGISTER_TARGET_SPEC_ID_INVALID`，均零写入 |
| `source` | string | ❌ | 来源 |
| `origin` | string | ❌ | 被修复 CR 的 ID（形如 `CR-2026-013`）。**仅当本 CR 是为修复某个已归档 CR 的缺陷而开时填**；新特性、重构、同一 spec 的后续演进均留空。填写前向用户确认“这是否一个修复”，不自行推测。格式不符会被 crctl 以 `REGISTER_INPUT_INVALID` 硬失败 |

---

## 执行步骤

### Step 1 — 前置确认

1. 读取 `AGENTS.md`、`dir-graph.yaml`（只读，解析工作区布局与参与仓）。
2. 确认 knowledge-base trunk 工作区 clean；存在未提交变更返回 `REGISTRATION_TRUNK_DIRTY`，不得继续。
3. 确认 `registration_key` 为本次注册意图的唯一稳定标识（如来源 + 标题摘要）。

### Step 2 — 一次深原语调用

```text
crctl register --registration-key {registration_key} --title "{title}"
  --owner-requirement {requirement_owner} --owner-development {dev_owner} --owner-test {test_owner}
  --target-version {target_version} --target-spec-id {target_spec_id}
  [--summary "{summary}"] [--source {source}] [--origin {origin}] [--year Y]
  --workspace {knowledge-base 主 checkout}
```

`--target-version` 必填：真实版本 `MAJOR.MINOR[.PATCH]` 或 `unassigned`（未排期先向用户确认），禁止 `tbd` 及同义值。
`--target-spec-id` 必填：匹配 `^[a-z0-9][a-z0-9._-]*$`，禁止 `/`、`\`、CR、LF。

深原语内部完成 CR 注册与逐仓 worktree ensure（Skill 不重复、不干预）。

### Step 3 — 结果分类（只透传深原语 JSON，不发明第二套字段）

| 深原语输出 | 分类与动作 |
|------|------|
| exit 0，含 `cr_id` + `operational_workspace` | 注册完成。`cr_id` = 返回的 `cr_id`，`operational_workspace` = 返回的 `operational_workspace`（snake_case，逐字透传到 execution_context，不解析、不拼接、不持有 resources 快照） |
| `REGISTRATION_INPUT_MISMATCH` | 同 key 不同输入（含 `--target-spec-id` 漂移），零写入。核对 registration_key 后重试 |
| `REGISTER_VERSION_INVALID` | `--target-version` 缺失/空/禁止同义值（含 `tbd`）/畸形真实版本，零写入。确认 `target_version` 取值后重试 |
| `REGISTER_TARGET_SPEC_ID_REQUIRED` | `--target-spec-id` 缺失/空，零写入（先于 BAD_ARGS）。确认 `target_spec_id` 取值后重试 |
| `REGISTER_TARGET_SPEC_ID_INVALID` | `--target-spec-id` 非法（不匹配 `^[a-z0-9][a-z0-9._-]*$` 或含 `/`、`\`、CR、LF），零写入。确认后重试 |
| `CAS_CONFLICT` / `TX_RECOVERY_CONFLICT` | 并发或第三方修改，零写入。重跑同命令自动重分配不撞号 |
| `REGISTRATION_TRUNK_DIRTY` / `TX_GIT_FAILED` | 前置或 git 失败，按错误信息处理后重跑 |
| 非零且 journal 有中间态 | 事务已持久化：直接**重跑同一条命令**续跑（幂等恢复），禁止手工清理 |

### Step 4 — 输出摘要

```
✅ CR 已注册
   CR-ID       : {cr_id}
   owners      : {owners 投影（三角色 + assigned-at）}
   注册提交    : knowledge-base trunk 已含 cr.md / _backlog.yml / _index.yml
   Worktree    : 各 active repo 已 ensure requirement/{cr_id}
   operational_workspace: {operational_workspace}（snake_case，逐字透传 execution_context）
   下一步      : 以 `crctl next {cr_id}` 为准（在 worktree 中继续撰写 PRD）
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| knowledge-base trunk 不干净 | 返回 `REGISTRATION_TRUNK_DIRTY`，先保存或清理再重跑 |
| 深原语非零退出 | 按 Step 3 分类表处理；中间态一律重跑同命令续跑，不做手工补偿或回收 CR-ID |
| 受控 shell 不可用 | 返回 `SHELL_UNAVAILABLE` 结构化错误，不输出手工 git 指令 |

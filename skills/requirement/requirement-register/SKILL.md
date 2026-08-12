---
name: requirement-register
description: 需求编写期入口：一次调用 crctl register 深原语完成 CR-ID 分配、三账本注册、注册 commit/lease push 与逐仓 worktree ensure；Skill 只做前置确认与结果分类，不写任何 Git 命令序列、不手写账本。
---

# Skill: requirement-register

**类型**: 需求期 Skill（requirement/ 组，入口节点）
**调用时机**: requirement-authoring pipeline 第 1 节点

---

## 用途

需求编写的起点：生成唯一 CR-ID（`CR-YYYY-NNN`）、在 knowledge-base trunk 登记 CR（`_backlog.yml` + `_index.yml` + `cr.md` 三账本同批）、注册 commit + trailer + lease push、并按 `dir-graph.yaml#repositories` 为所有 active repo 创建 `requirement/{cr_id}` worktree。
以上全部由深原语 `crctl register` 独占完成（CR-2026-031 TASK-05）：CR-ID 分配、账本编辑、commit/lease push、worktree ensure 均不再由模型手写。

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
| `target_version` | string | ❌ | 目标版本 |
| `source` | string | ❌ | 来源 |

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
  [--summary "{summary}"] [--source {source}] [--target-version {target_version}] [--year Y]
  --workspace {knowledge-base 主 checkout}
```

深原语内部完成（Skill 不重复、不干预）：

- CR-ID 分配（`CR-{Y}-{NNN+1}`，scanMaxCrNumber + CAS 账本写）；
- 三账本（`cr.md` 新建 + `_backlog.yml` 追加 + `_index.yml` 登记）同批 recoverable write-set（CRLF→LF + SHA-256 CAS 锚点）；
- 注册 commit + trailer（AI-First-Op: register）+ lease push；
- 逐仓 worktree ensure（`requirement/{cr_id}` 分支从 trunk 派生，不切换主工作区 HEAD）；
- 全程事务 journal，任意中断后**重跑同一条命令**即从断点续跑（同 registration_key 同输入）。

### Step 3 — 结果分类（只透传深原语 JSON，不发明第二套字段）

| 深原语输出 | 分类与动作 |
|------|------|
| exit 0，含 `cr` + `owners` 投影 | 注册完成。`cr_id` = 返回的 `cr`，后续节点在返回的 worktree 继续 |
| `REGISTRATION_INPUT_MISMATCH` | 同 key 不同输入，零写入。核对 registration_key 后重试 |
| `CAS_CONFLICT` / `TX_RECOVERY_CONFLICT` | 并发或第三方修改，零写入。重跑同命令自动重分配不撞号 |
| `REGISTRATION_TRUNK_DIRTY` / `TX_GIT_FAILED` | 前置或 git 失败，按错误信息处理后重跑 |
| 非零且 journal 有中间态 | 事务已持久化：直接**重跑同一条命令**续跑（幂等恢复），禁止手工清理 |

### Step 4 — 输出摘要

```
✅ CR 已注册
   CR-ID       : {cr}
   owners      : {owners 投影（三角色 + assigned-at）}
   注册提交    : knowledge-base trunk 已含 cr.md / _backlog.yml / _index.yml
   Worktree    : 各 active repo 已 ensure requirement/{cr}
   下一步      : 以 `crctl next {cr_id}` 为准（在 worktree 中继续撰写 PRD）
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| knowledge-base trunk 不干净 | 返回 `REGISTRATION_TRUNK_DIRTY`，先保存或清理再重跑 |
| 深原语非零退出 | 按 Step 3 分类表处理；中间态一律重跑同命令续跑，不做手工补偿或回收 CR-ID |
| 受控 shell 不可用 | 返回 `SHELL_UNAVAILABLE` 结构化错误，不输出手工 git 指令 |

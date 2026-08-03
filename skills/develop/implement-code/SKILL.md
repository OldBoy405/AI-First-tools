---
name: implement-code
description: 在同一 CR workspace 内按 prd/sdd/tasks 执行代码编写，读取 CR worktree 文档并写入对应代码仓 CR worktree。
---

# Skill: implement-code

**类型**: 开发期 Skill（develop/ 组）  
**调用时机**: code-implementation pipeline 的代码编写节点（`approve-dev-start` 后）

---

## 用途

在同一个 `CR-YYYY-NNN` workspace 内完成代码实现。代码与 CR 文档必须作为同一交付集合推进、checkpoint、评审和合并，不得单独推进文档或代码状态。启动前 CR status 必须已经由 `approve-dev-start` 推进到 `developing`。

---

## 输入

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | yes | 目标 CR-ID |
| `runtime` | string | no | 默认 `openwork-opencode`，不可用时 fallback 到第一个可用外部 CLI |
| `review_feedback` | object | no | 来自 write-test-report 或 review-code 的 blockers、repair-instructions；存在时进入自修复模式 |
| `self_repair_attempt` | number | no | 当前自动修复轮次，由 pipeline reviewLoop 注入 |

---

## CR Workspace Contract

1. 先读取 `dir-graph.yaml#repositories`，解析 active repo，不得硬编码某个固定平台目录或 `code`。
2. 文档根固定来自 knowledge-base CR worktree：`.rayai-worktrees/knowledge-base/requirement/{cr_id}`。
3. 独立 git 代码仓写入 `.rayai-worktrees/{repo.id}/requirement/{cr_id}`。
4. 非独立代码目录写入 knowledge-base CR worktree 内对应路径。
5. 主工作区 `change-requests/`、平台运行时代码目录、主工作区 `code/` 不参与开发期读写。

---

## 必读文档

从 CR worktree 读取：

- `{crWorkspaceDocsRoot}/change-requests/{cr_id}/prd.md`
- `{crWorkspaceDocsRoot}/change-requests/{cr_id}/sdd.md`
- `{crWorkspaceDocsRoot}/change-requests/{cr_id}/tasks/TASK-*.md`

缺少任一文件或任一 active repo worktree 不存在时，立即停止并返回结构化错误。

---

## 执行步骤

### Step 1 - Resolve Repo Map

调用 CR workspace resolver，根据 `dir-graph.yaml#repositories` 生成 repo map：

- `role=knowledge-base` 使用 bucket `knowledge-base`
- 独立 git 代码仓使用 bucket `{repo.id}`
- 非独立代码目录使用 knowledge-base worktree 内的 `{repo.path}`

### Step 2 - Validate Workspace

校验：

- CR 当前 status 为 `developing`
- 所有 active repo 的 CR worktree 存在
- 所有参与仓当前分支为 `requirement/{cr_id}`
- PRD、SDD、TASK 文件来自 CR worktree

### Step 3 - Implement Tasks

- 优先使用目标运行时已安装的 external `subagent-driven-development` 执行 TASK。
- 不支持子 agent 时使用目标运行时已安装的 external `executing-plans`。
- 每个 TASK 必须遵循目标运行时已安装的 external `test-driven-development`：先写失败测试，再实现，再验证转绿。
- 实现只写 repo map 指定的 codeRoot。
- 若存在 `review_feedback`，进入自修复模式：读取 blockers、repair-instructions、repair-target 与上一轮 `test-report.md` / `review-annotations/code.yml`，只修复被指出的问题，避免无关重构，并输出 fixed-blockers。

### Step 4 - Verify

按 TASK 验收条件运行 lint/test/build 或对应验证命令。任何失败都必须记录到节点输出并停止推进；在自修复模式下至少重新运行与 blockers 相关的验证命令，并说明未运行全量验证的原因。

### Step 4.5 - 任务状态即时登记

每完成一个 TASK，立即在 `delivery/task/_index.yml`（或本 CR 对应的任务索引文件）中把该任务标记为 `done`，**做完一个标一个，不得积压到回写期补标**。任务全部完成但索引仍为 `pending` 的，视为本节点未完成——回写期补账既打断流程又容易漏标。

### Step 5 - Output

节点输出必须包含：

- 实际读取的 PRD/SDD/TASK 路径
- 实际写入的 repo/worktree/codeRoot
- runtime 与 fallback 情况
- run/session id
- 验证命令与结果
- 未完成项或失败原因
- 自修复模式下的 review_feedback 摘要、self_repair_attempt 与 fixed-blockers

---

## 禁止事项

- 禁止读取或写入主工作区 `change-requests/`。
- 禁止在平台运行时代码目录或主工作区 `code/` 直接编码。
- 禁止只提交或只推送文档、只提交或只推送代码。
- 禁止在缺少任一参与 repo worktree 时继续执行。

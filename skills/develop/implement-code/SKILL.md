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
| `review_feedback` | object | no | 来自 write-test-report 或 review-code 的 blockers；存在时进入自修复模式 |
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

- 执行前读取 `tasks/_index.yml` 的 `depends-on` 拓扑排序：前置 TASK 未 done 不得开始本 TASK，并在节点输出注明被阻塞 TASK 与等待的前置项。依赖顺序由 `crctl task done` 机械强制（CR-2026-025 FR-6）。并发边界：同一 repo worktree 内会修改同一文件的多个 TASK 必须串行；跨 repo 的 TASK 因 worktree 隔离可并发；回修模式默认串行（已装 `dispatching-parallel-agents` 时同层无依赖 TASK 可并发派发，并发只影响耗时不影响产出）。
- 按 `coding-discipline` §1（极简阶梯）选方案、§2（2-5 分钟步骤粒度）拆步骤执行 TASK：优先使用目标运行时已安装的 external `subagent-driven-development`；不支持子 agent 时使用 external `executing-plans`；两者均未提供时，按 `coding-discipline` §2 的粒度自行拆解串行执行，并在节点输出中注明降级。
- 实现只写 repo map 指定的 codeRoot。
- 若存在 `review_feedback`，进入自修复模式：按 `coding-discipline` §3 先定位根因（同一根因下所有失败点一次修完，节点输出含 root-cause 字段）、bug 修复回归先验红再验绿；读取 blockers、repair-target 与上一轮 `test-report.md` / `review-annotations/code.yml`，只修复被指出的问题（blocker 字符串内含可执行修复说明），避免无关重构。<!-- lint-prompts:ignore --> 描述性：仅读取评审证据（写走 review-record）

### Step 4 - Verify

按 TASK 验收条件运行 lint/test/build 或对应验证命令。任何失败都必须记录到节点输出并停止推进；在自修复模式下至少重新运行与 blockers 相关的验证命令，并说明未运行全量验证的原因。

### Step 4.5 - 任务状态即时登记（经 crctl task done，禁止手写 YAML）

每完成一个 TASK，立即调用 `crctl task done <CR-ID> --task <TASK-ID> --workspace <CR worktree>` 把该任务在 `tasks/_index.yml` 标记为 `done`（sha256 CAS + 审计日志 + developing 态守卫），**做完一个标一个，不得积压到回写期补标**。任务全部完成但索引仍为 `pending` 的，视为本节点未完成——回写期补账既打断流程又容易漏标。**禁止会话内手写/现写脚本编辑 `tasks/_index.yml`**（纪律 #7）：该账本唯一写入通道是 `crctl task done`。

### Step 5 - Output

节点输出必须包含：

- 实际读取的 PRD/SDD/TASK 路径
- 实际写入的 repo/worktree/codeRoot
- runtime 与 fallback 情况
- run/session id
- 验证命令与结果
- 未完成项或失败原因
- 自修复模式下的 review_feedback 摘要与 self_repair_attempt

---

## 环境验证与 ENVIRONMENT_MISMATCH

本 Skill 是有界验证与 `ENVIRONMENT_MISMATCH` 的唯一详细事实源（其余文档只链接不复述）：

- 一次环境检查：任务开始时只做一次有界前提检查（依赖、路径、权限、端口等），不反复探测。
- 最多一次重跑：任务范围内可修正的问题修正后最多重跑一次；仍失败或修复超出任务权限时，返回 `ENVIRONMENT_MISMATCH` 并报告所需平台/人工动作，结束执行。
- 遵守测试计划 timeout，使用既有测试入口，不创建脱离验证步骤继续存活的后台进程。
- `ENVIRONMENT_MISMATCH` 是稳定技术失败标签：不写入 crctl 状态、gate、账本、评审 blocker 或测试证据 schema；由既有 Pipeline `onFail=abort` 中止。
- 临时隔离实例例外：任务明确要求且由当前步骤创建、验证后清理的临时实例不属于共享服务；共享服务指任务范围外、可能被其他任务共享或需要调整既有生命周期的实例。
- 验证环境已受控建立时，可归因于当前变更的失败必须按普通代码失败进入既有回修路径，不得用环境标签掩盖。

## 禁止事项

- 禁止读取或写入主工作区 `change-requests/`。
- 禁止在平台运行时代码目录或主工作区 `code/` 直接编码。
- 禁止只提交或只推送文档、只提交或只推送代码。
- 禁止在缺少任一参与 repo worktree 时继续执行。
- **范围越界撤回（CR-2026-057 FR-7）**：code 评审 blocker 若涉范围越界（实际 diff 触碰 SDD 批准范围的 `scope_out`、把 `follow_up` 做成当前交付、或改动 `zero_diff` 调用点），implementer 必须撤回越界 diff，不得在实现期扩大范围。

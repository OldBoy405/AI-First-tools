# AI First 研发协同平台 内置的 tools

![AI First 研发协同平台 tools 封面](assets/readme-illustrations/cartoon/cover.png)

这个 tools 包是 AI First 研发协同平台内置的方法论层：以 CR（Change Request）为工作容器，把一次产品变更从需求、设计、任务、代码、测试、评审到回写，变成可持续推进、可多人接手、可被 AI 稳定理解的结构化事实。既可个人独立使用，也可团队协作推进。

## 1. Tools 定位

本包是 `multica-ai` 生态之外的独立方法论层，由三部分组成：

- **Agent**（`agents/`）：决定路由与职责归属；
- **Pipeline**（`pipeline-templates/`）：编排节点顺序、输入传递、reviewLoop 与失败动作；
- **Skill**（`skills/`）：承载业务判断、编排步骤与公开输入输出；
- **`crctl`**（`skills/shared/crctl/`）：状态、门禁、账本、Git、事务、审批与审计的唯一执行器。

本包不含业务代码，只含提示词合约、流程编排与一个零依赖的治理 CLI。

## 2. 概念生命周期

CR 不是需求单，而是一次变更从想法到回写的工作容器。每个 CR 有自己的目录、分支、worktree、状态、owner 和过程产物，沉淀在 `change-requests/{CR-ID}/` 里：PRD、SDD、任务拆解、测试报告、评审意见、审批记录、traceability。

CR 通过状态机推进。每个关键节点都要由明确的 Skill 写入证据并经 `crctl` 推进状态，不是 prompt 里说"通过了"就算通过。自动评审发现 blocker 时，不丢给人工兜底，而是带 `review_feedback` 回到对应节点自修复，直到证据闭环。

开发完成并通过审批后，`feature-writeback` 把分支合并回 trunk，把 PRD/SDD 写入 `specs/{id}/`、任务写入 `delivery/task/`，最后把 CR 移入 `_history.yml`。CR 是过程工作台，`specs/` 与 `delivery/` 是回写后的团队知识库。

## 3. Owner 职责

每个 CR 由三个角色围绕同一份事实协作，不靠口头同步上下文：

| 角色 | 职责 | 关键产物 |
|------|------|---------|
| `owners.requirement` | 需求编写与需求审批 | `prd.md`、`approval.yml#requirement` |
| `owners.development` | 技术设计、编码与代码审批 | `sdd.md`、`plan.md`、代码、`approval.yml#code` |
| `owners.test` | 测试报告与验证证据 | `test-report.md` |

角色变化留下 owner history；Agent 与 Skill 的权限边界由 `agent-skill-matrix.yml` 限定。

## 4. 8 条 Pipeline 入口

| 触发 | Pipeline | 说明 | 必跑 |
|------|----------|------|------|
| `/planning` | `product-planning` | 产品规划报告与 roadmap | 可选 |
| `/insight-brief` | `market-to-plan` | 市场洞察转规划 | 可选 |
| `/comp-radar` | `competitive-radar` | 竞品雷达与规划建议 | 可选 |
| `/requirement` | `requirement-authoring` | CR 注册 + PRD 编写 + 需求评审审批 | 必跑 |
| `/architecture` | `architecture-design` | SDD 技术设计 + 评审审批 | 必跑 |
| `/coding` | `code-implementation` | 计划、任务、编码、测试、代码评审审批 | 必跑 |
| `/writeback` | `feature-writeback` | 合并、回写 specs/delivery、归档 | 必跑 |
| `/resume` | `resume-cr` | 换机接手，恢复 worktree 并给出下一步 | 按需 |

每条 Pipeline 的节点顺序、输入与 reviewLoop 以 `pipeline-templates/*.pipeline.json` 为权威，README 不复刻节点表。

## 5. 自动评审与人工审批

**自动评审**：需求、技术设计、开发计划、代码四个阶段都有对应 review Skill，产出 canonical `verdict` / `blockers` / `suggestions`，由 `crctl review-record` 落盘。blocker 未清空前不会进入人工审批。

**人工审批**：需求、架构、开发启动、代码四个审批节点只能由人在交互式终端执行 `crctl approve`（或服务端签名授权），Agent 不得代签。评审通过是进入人工审批的前置条件。

## 6. checkpoint / merge / operational workspace / archive

| 机制 | 一句话区别 |
|------|-----------|
| **checkpoint** | 随时把全部 active repo 的进度打包提交并推送远端，供换机或协作者续接（`crctl checkpoint`）；需求/架构/代码三个阶段审批后的阶段终点 checkpoint 是 Pipeline 完成条件，不可跳过，失败保持已审批状态、重跑同一 checkpoint 不重新审批（CR-2026-044） |
| **merge** | 回写期第一步，把所有参与仓的同名分支合并回各自 trunk（`crctl merge`） |
| **operational workspace** | merge 之后、archive 之前的唯一编辑位置，回写节点在此累积 specs/delivery 产物 |
| **archive** | 回写完成后把 CR 移入 `_history.yml` 并清理事务现场（`crctl archive`） |

四者的内部事务、lease 与恢复语义由 `crctl` 独占，README 不复刻实现步骤。

## 7. 恢复与 `crctl status/next`

- 接手在途 CR：`/resume` 恢复本地 worktree，之后永远以 `crctl status {cr_id}` 看当前状态、以 `crctl next {cr_id}` 看下一步。
- 中途失败：`crctl` 的深原语（register/checkpoint/merge/writeback-apply/archive）都是事务化且幂等，按输出的 `recoverCommand` 重跑同一条命令即可从断点续跑。
- 主工作区与 worktree 视图不一致时，`crctl status` 会给出 `STATUS_DIVERGED` 告警并指向权威 worktree。

## 8. 权威事实源链接

| 事项 | 权威文件 |
|------|---------|
| CR 状态机与门禁 | `dir-graph.yaml#change-request-track.state_machine` + `skills/shared/crctl/gates.json` |
| 状态/账本唯一执行器 | `skills/shared/crctl/scripts/crctl.mjs` |
| Agent/Skill 权限矩阵 | `agent-skill-matrix.yml` |
| Agent 定义 | `agents/` |
| Skill 定义 | `skills/` |
| Pipeline 编排 | `pipeline-templates/*.pipeline.json` |
| 受控 shell 约束 | `skills/shared/controlled-shell/rules.json` |
| 架构地图与硬不变量 | `ARCHITECTURE.md` |
| 各阶段该做什么 | `skills/{阶段组}/{skill-name}/SKILL.md` |

> 本 README 只做面向人的流程总览，不作为可执行事实源。任何"下一步是什么、状态是否合法、门禁是否满足"的判断，一律以 `crctl status` / `crctl next` 与上述权威文件为准。

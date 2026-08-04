# Agent / Skill 权限矩阵

`agent-skill-matrix.yml` 是 Agent 与 Skill 关系的机器可读事实源，用来补齐 `agents/_index.yml`、Agent 正文和 Pipeline JSON 之间的治理空白。

## 关系类型

| 关系 | 含义 | 约束 |
|---|---|---|
| `owns` | Actor 对 Skill 负主责，默认维护该 Skill 的执行契约 | 每个 active Skill 必须且只能有一个 owner |
| `can-call` | Actor 可在职责边界内调用该 Skill | 不代表主责，调用时仍需遵守 Skill 前置条件 |
| `external` | 目标运行时提供的外部方法论 Skill | phase0 tools 不打包同名 `SKILL.md` |
| `forbidden` | Actor 明确禁止调用 | 用于防止跨域越权或跳过流程 |

`system-orchestrator` 不是可部署 Agent，而是系统编排器/运行时组件，用来承接同步、回写、CR 状态、受控 shell 等跨 Agent 基础能力。

> IDE 单独使用（无平台执行层）时，`crctl`（`skills/shared/crctl/`）是 `cr-status-set` / `controlled-shell` / `validate-doc` 的代码化执行器。`requirement-writer` 与 `dev-agent` 通过 `can-call: crctl` 执行受控 git、状态查询与经门禁的状态推进；`crctl` 自身即状态机与门禁，因此该 can-call 不构成对 `cr-status-set` forbidden 边界的绕过。

## 主责矩阵

| Actor | 主责 Skill |
|---|---|
| `product-planning-agent` | `analyze-user-feedback`, `conduct-market-research`, `run-competitive-analysis`, `analyze-current-product`, `write-planning-report`, `review-planning-report`, `write-roadmap`, `write-planning-entry`, `extract-market-insight`, `write-insight-brief`, `gather-product-context`, `planning-draft`, `record-idea`, `record-adr`, `focus-briefing` |
| `requirement-writer` | `requirement-register`, `write-requirement-prd`, `review-requirement`, `approve-requirement` |
| `dev-agent` | `write-tech-design`, `review-tech-design`, `approve-tech-design`, `write-dev-plan`, `write-dev-tasks`, `approve-dev-start`, `implement-code`, `write-test-report`, `review-code`, `approve-code` |
| `spec-agent` | `spec-show`, `spec-query`, `spec-dashboard` |
| `delivery-agent` | `writeback-tasks` |
| `quality-reviewer-agent` | `review-alignment`, `change-impact-analysis` |
| `competitive-analyst-agent` | `fetch-competitor-updates`, `write-competitive-report`, `report-to-planning-suggestion` |
| `system-orchestrator` | `merge-feature-branch`, `writeback-prd-sdd`, `writeback-traceability`, `push-progress`, `pull-progress`, `resume-from-remote`, `list-remote-checkpoints`, `handover-cr`, `validate-doc`, `engineering-docs`, `controlled-shell`, `crctl`, `cr-review-record`, `cr-status-set`, `inbox-emit`, `cr-archive`, `feedback-writeback`, `cr-inbox`, `cr-query`, `cr-show`, `cr-dashboard` |

## Pipeline Owner

| Pipeline | Owner |
|---|---|
| `product-planning` | `product-planning-agent` |
| `market-to-plan` | `product-planning-agent` |
| `competitive-radar` | `competitive-analyst-agent` |
| `requirement-authoring` | `requirement-writer` |
| `architecture-design` | `dev-agent` |
| `code-implementation` | `dev-agent` |
| `feature-writeback` | `system-orchestrator` |
| `resume-cr` | `system-orchestrator` |

## 设计缺口

| 缺口 | 说明 | 建议 |
|---|---|---|
| `knowledge-agent` 写入 Skill 不足 | 其能力声明包含技术笔记、洞察写入和设计文档辅助，但当前没有专属 `write-tech-note` / `write-knowledge-entry` | 后续补知识写入 Skill，或收敛声明为只读/校验型 Agent |
| `customer-support-agent` 反馈落盘缺 Skill | 其能力声明包含 unresolved feedback record，但没有 `record-feedback` | 后续补 `record-feedback`，或绑定目标系统工单入口 |
| 回写期没有独立 primary Agent | `feature-writeback` 当前由系统编排器直接编排 writeback / CR / delivery Skill，`spec-agent` 仅做回写后只读核对 | 如需要人工入口，可新增 `writeback-agent`，否则保持系统编排即可 |

## 维护规则

1. 新增 active Skill 时，必须在 `agent-skill-matrix.yml` 中为它指定且只指定一个 `owns` owner。
2. Agent 正文出现的 active Skill，应出现在该 Agent 的 `owns` 或 `can-call` 中。
3. Pipeline 新增或替换 `node.ref` 时，该 Skill 必须存在 owner，且 pipeline 本身必须登记 `pipeline-owners`。
4. 外部方法论 Skill 只能出现在 `external` 或 `external-skills` 中，不能登记为 active Skill。
5. `forbidden` 用于表达跨域禁止调用，不用于表达“暂未支持”；暂未支持请写入 `known-gaps`。

# AGENTS.md — AI First phase0 tools 行为约束

本目录是 AI First 研发协同平台 phase0 的预置 tools 包，不是业务项目工作区。这里维护的是可安装到目标 workspace 的 Agent、Skill、Pipeline 模板和流程手册。

**读取顺序（所有 AI Agent 必须遵守）：**

```text
1. AGENTS.md
2. dir-graph.yaml
3. agent-skill-matrix.yml
4. README.md
5. 与任务相关的 _index.yml、pipeline JSON、Agent 文档或 Skill 文档
```

`AGENTS.md` 是行为约束入口；`dir-graph.yaml` 是目录与事实源入口；`agent-skill-matrix.yml` 是 Agent/Skill 权限与归属入口；`README.md` 是完整使用流程入口。不要在不同入口里维护互相冲突的规则。

---

## 工作区布局

```text
tools/
  AGENTS.md                         # 本文件，所有 AI 工具共享的行为约束
  CLAUDE.MD                         # Claude 专用入口，只转发到 AGENTS.md
  dir-graph.yaml                    # tools 包目录图与事实源声明
  README.md                       # 完整使用流程、流程图与节点说明
  AGENT-SKILL-MATRIX.md             # Agent/Skill 权限矩阵说明
  agent-skill-matrix.yml            # Agent/Skill 权限矩阵机器可读事实源
  agents/                           # 预置 Agent 定义与 _index.yml
  skills/                           # 预置 Skill 定义与 _index.yml
  pipeline-templates/               # Pipeline JSON 模板与 _index.yml
```

所有相对路径默认以 `tools/` 目录为根。若文档中讨论目标 workspace 的路径，必须明确说明那是安装后的运行时路径，不是本 tools 包内路径。

---

## 单一事实源

| 事项 | 权威文件 |
|---|---|
| tools 包目录结构 | `dir-graph.yaml` |
| 完整使用流程 | `README.md` |
| Agent/Skill 权限矩阵 | `agent-skill-matrix.yml` |
| Active Skill 清单 | `skills/_index.yml` |
| Active Agent 清单 | `agents/_index.yml` |
| Active Pipeline 清单 | `pipeline-templates/_index.yml` |

修改任何能力定义时，优先更新权威文件，再更新解释性文档。不要只改说明文档而不改对应索引或模板。

---

## 平台包边界

1. 保留现有完整的 Skill 和 Agent，作为预置平台包交付。除非用户明确要求，不删除、不裁剪、不迁移到 `old/`。
2. 外部 superpowers 能力由目标运行时提供，phase0 tools 不复制同名 `SKILL.md`，只在需要处声明依赖。
3. `pipeline-templates/*.pipeline.json` 只能引用 `skills/_index.yml` 中 active 的 Skill。
4. `agents/_index.yml` 中的 references 必须指向真实存在的 Skill 或明确的目标 workspace 资料入口。
5. `agent-skill-matrix.yml` 必须为每个 active Skill 指定且只指定一个 `owns` owner；Agent 正文或索引引用的 Skill 必须出现在该 Agent 的 `owns` 或 `can-call` 中。
6. 禁止引入本机绝对路径、产品内部源码路径或固定双仓假设；仓库、trunk、worktree 必须由目标 workspace 的 `dir-graph.yaml#repositories` 解析。
7. 禁止恢复旧式单文件 spec 模型；发布态需求以 baseline `PRD.md`、`SDD.md`、`traceability.yml` 为核心，在途变更以 `change-requests/{CR-ID}/` 为核心。
8. 每个 CR 必须使用 `owners.requirement`、`owners.development`、`owners.test` 三角色 owner 模型，且每个角色必须包含 `id` 与 `assigned-at`；顶层 `owner` 仅作兼容显示。

---

## 流程总览

phase0 tools 提供八条 active pipeline：

| 触发 | Pipeline | 作用 |
|---|---|---|
| `planning` | `product-planning.pipeline.json` | 调研规划主流程 |
| `insight-brief` | `market-to-plan.pipeline.json` | 市场/用户洞察转规划条目 |
| `comp-radar` | `competitive-radar.pipeline.json` | 竞品动态到规划建议 |
| `requirement` | `requirement-authoring.pipeline.json` | 注册 CR 并产出 PRD |
| `architecture` | `architecture-design.pipeline.json` | 基于已审批 PRD 产出 SDD |
| `coding` | `code-implementation.pipeline.json` | 计划、任务、实现、测试报告、代码评审与审批 |
| `writeback` | `feature-writeback.pipeline.json` | 合入、回写 baseline spec、生成追溯链并归档 CR |
| `resume` | `resume-cr.pipeline.json` | 从远端 checkpoint 恢复在途 CR |

节点输入、作用、产出和可跳过规则以 `README.md` 为准。Pipeline JSON 是机器可执行编排，二者发生不一致时必须以 JSON 和 Skill 实际契约修正文档。

---

## CR 状态约束

当前四阶段 CR 状态链路为：

```text
drafting
→ requirement-reviewing
→ requirement-approved
→ tech-designing
→ tech-design-review-pending
→ tech-design-reviewed
→ task-breakdown
→ developing
→ code-reviewing
→ code-approved
→ merging
→ writing-back
→ archived
```

`tech-design-review-pending` 需要结合 `change-requests/{CR-ID}/review-annotations/sdd.yml` 判断下一步：`verdict=pass` 且 `blockers=[]` 时才等待 `human_approval -> approve-tech-design`；评审缺失或 block 时继续 `review-tech-design` / `write-tech-design` 自修复。`review-tech-design` block 后状态为 `tech-designing`，`write-tech-design` 必须允许在 `review_feedback` 或上一轮 `sdd.yml verdict=block` 存在时以回修模式进入。

终态还包括 `rejected` 与 `withdrawn`。

人工审批节点的驳回必须走显式回退转换，不得停留在原状态硬改产物：架构审批驳回走 `approve-tech-design:reject -> write-tech-design`（回到 `tech-designing`）；开发启动暂缓走 `write-dev-tasks` 自环重拆（保持 `task-breakdown`）；代码审批驳回走 `approve-code:reject -> implement-code`（回到 `developing`）。需求审批驳回在 `requirement-reviewing` 内修订 PRD 后重跑 `review-requirement` 自环，无需额外转换。

状态推进必须通过对应 Skill 或 Pipeline 节点完成，不得手工编辑目标 workspace 的 `_backlog.yml`。涉及人工确认的节点，后续必须有明确的 `approve-*` 或写入型 Skill 记录结论。

CR 角色 owner 变更必须通过 `handover-cr` 或 `resume-from-remote` 的角色移交逻辑完成，更新 `owners.{role}.id`、`owners.{role}.assigned-at` 并追加 `owner-history`。不得只修改顶层 `owner`。

---

## 编辑规则

### 修改 Skill

1. 先读 `skills/_index.yml`、`agent-skill-matrix.yml`，以及对应 domain 下的相邻 Skill。
2. 新增 Skill 时创建 `skills/{domain}/{skill-id}/SKILL.md`，并登记到 `skills/_index.yml`。
3. 在 `agent-skill-matrix.yml` 中为新增 Skill 指定唯一 `owns` owner，并按需补充 `can-call` / `forbidden`。
4. `SKILL.md` 必须包含 `name:` frontmatter，并明确输入、读取、写入、状态推进、失败处理。
5. 写入型 Skill 必须说明如何调用 `validate-doc` 或等价校验。
6. 涉及 git/shell 的 Skill 必须通过 `controlled-shell` 约束命令范围。

### 修改 Agent

1. 先读 `agents/_index.yml`、`agent-skill-matrix.yml` 和被引用的 Skill。
2. 新增 Agent 时创建 `agents/{agent-id}.md` 并登记到 `agents/_index.yml`。
3. Agent 只做路由、编排和质量判断，不绕过 Skill 直接写受控状态文件。
4. Agent references 中的 Skill 路径必须真实存在，并在 `skills/_index.yml` 中为 active。
5. Agent 正文出现的 active Skill 必须同步到 `agent-skill-matrix.yml` 的 `owns` 或 `can-call`；目标运行时提供的外部 Skill 必须登记到 `external`。

### 修改 Pipeline

1. 先读 `pipeline-templates/_index.yml`、目标 pipeline JSON、`agent-skill-matrix.yml` 和涉及 Skill 文档。
2. 修改节点数量后同步 `_index.yml` 的 `nodes` 字段。
3. `node.ref` 必须是 active Skill；`human_approval` 不得替代状态写入。
4. 新增 Pipeline 时必须在 `agent-skill-matrix.yml#pipeline-owners` 登记 owner；新增 `node.ref` 必须已有唯一 Skill owner。
5. `requirement-authoring` 必须通过机器可读 `execution_context` 传递 CR-ID 与 worktree 信息。
6. `code-implementation` 必须在 `review-code` 前生成 `test-report.md`，并在审批前校验测试报告。
7. 自动审查节点必须声明 `reviewLoop`；若产出 blocker，必须回到对应修复节点并传入 `review_feedback`，完整通过 Review 后才允许进入后续节点或 `human_approval`。
   - 若修复后必须重跑多个节点，`reviewLoop` 必须用机器可读字段声明 `replayNodes[]`，按顺序列出修复节点、证据再生成节点、checkpoint 节点和当前评审节点。
8. 自动审查节点必须持久化 `review-loop.current-attempt` 与 `review-loop.attempts[]`；CR 类闭环还必须同步写入 `traceability.yml`，防止 `/resume` 后自修复轮次重置。
9. `feature-writeback` 必须要求 `spec_id` 与 `target_version`，不得允许空值向下游传播。

### 修改文档

1. 流程说明改 `README.md`。
2. Agent/Skill 权限矩阵改 `agent-skill-matrix.yml` 与 `AGENT-SKILL-MATRIX.md`。
3. 文档里的路径必须使用可移植相对路径，不写本机绝对路径。

---

## 禁止事项

- 禁止把 `old/`、`skills/superpowers/` 或目标运行时提供的外部方法论 Skill 打包进 phase0 tools。
- 禁止让 pipeline 引用未登记或 inactive 的 Skill。
- 禁止在 tools 包文档里写死某个本机路径、某个个人目录、某个产品源码路径。
- 禁止把代码实现约束绑定到固定仓库名；必须从目标 workspace `dir-graph.yaml#repositories` 动态解析。
- 禁止跳过 `review-*` 与 `approve-*`，直接把 CR 推进到后续阶段。
- 禁止让 `writeback-traceability` 触发 `cr-archive`；归档顺序由 `feature-writeback.pipeline.json` 编排。
- 禁止手工清理 CR worktree 或远端分支；成功归档后的清理由 `cr-archive` 负责。

---

## 自检命令

修改完成后，在 tools 目录检查 pipeline JSON 可解析：

```bash
node -e "const fs=require('fs'); for (const f of fs.readdirSync('pipeline-templates').filter(f=>f.endsWith('.json'))) JSON.parse(fs.readFileSync('pipeline-templates/'+f,'utf8')); console.log('json ok')"
```

同时检查新增或修改的 Agent / Skill / Pipeline 是否已同步对应 `_index.yml` 与 `agent-skill-matrix.yml`。

---

## 任务接收格式

执行较大修改前，Agent 应先确认：

| 项目 | 说明 |
|---|---|
| `目标范围` | 本次会修改哪些 tools 文件或目录 |
| `不在范围` | 明确不会修改的 pipeline、Skill、Agent 或目标 workspace 文件 |
| `计划产出` | 将新增/修改什么文件，以及会运行哪些自检 |

若用户已经给出明确修改目标，可以直接实施，但仍要在动手前说明将编辑哪些文件。

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

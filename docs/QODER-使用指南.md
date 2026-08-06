# AI First 研发协同平台 Tools 包 — Qoder 使用指南

本文档说明如何在 **Qoder** 平台中安装、配置和使用 AI First 研发协同平台的 Skills Package。

## 目录

- [一、前置理解：Qoder vs AI First 平台](#一前置理解qoder-vs-ai-first-平台)
- [二、环境准备（必须要做的 4 件事）](#二环境准备必须要做的-4-件事)
- [三、完整配置模板](#三完整配置模板)
- [四、在 Qoder 中如何使用](#四在-qoder-中如何使用)
- [五、场景：已有方案文档，如何启动项目改造](#五场景已有方案文档如何启动项目改造)
- [六、技能包架构速览](#六技能包架构速览)
- [七、常见问题](#七常见问题)
- [八、全部可用指令速查表（57 条）](#八全部可用指令速查表57-条)

---

## 一、前置理解：Qoder vs AI First 平台

这套 tools 包来自 **AI First 研发协同平台**。在那个平台上，你可以通过 slash 命令触发 Pipeline 自动执行：

```
/planning        → 自动跑完产品规划全流程
/requirement     → 自动跑完需求编写全流程
/architecture    → 自动跑完架构设计全流程
/coding          → 自动跑完代码实现全流程
/writeback       → 自动跑完回写归档全流程
/resume          → 从远端恢复在途 CR
```

但在 **Qoder 中，这些 slash 命令不存在**。Qoder 没有内置 AI First 平台的 orchestrator 运行时。

**在 Qoder 中的使用方式是**：直接通过自然语言告诉 AI 你想做什么，AI 会读取 tools 包中的 Skill 定义，按步骤执行。

| | AI First 平台 | Qoder |
|---|---|---|
| 触发方式 | `/requirement` 一键 Pipeline | 自然语言描述任务 |
| 流程控制 | Pipeline JSON 自动编排 | AI 按 Skill 步骤逐步执行 |
| 状态推进 | orchestrator 自动推进 CR 状态 | AI 按 Skill 定义写入状态 |
| 自修复闭环 | Pipeline reviewLoop 自动重试 | AI 分析 blocker 后手动修复 |
| Skill 来源 | `tools/skills/`（同一套） | `tools/skills/`（同一套） |

---

## 二、环境准备（必须要做的 4 件事）

### 第 1 步：创建 Workspace 目录结构

在任意位置创建一个 Git 仓库作为你的 workspace 根目录。以 `c:\my-project\` 为例：

```powershell
# 1. 创建 workspace 并初始化为 Git 仓库
mkdir c:\my-project
cd c:\my-project
git init

# 2. 创建标准目录结构
mkdir change-requests, specs, delivery, docs
mkdir delivery\task
mkdir docs\product-planning, docs\competitive, docs\market-insights
mkdir docs\feedback, docs\ideas, docs\tech-notes

# 3. 创建空的台账文件（空 YAML 列表）
@"
backlog: []
"@ | Out-File -FilePath "change-requests\_backlog.yml" -Encoding utf8

@"
change-requests: []
"@ | Out-File -FilePath "change-requests\_index.yml" -Encoding utf8

@"
specs: []
"@ | Out-File -FilePath "specs\_index.yml" -Encoding utf8

@"
tasks: []
"@ | Out-File -FilePath "delivery\task\_index.yaml" -Encoding utf8

@"
entries: []
"@ | Out-File -FilePath "docs\product-planning\_index.yml" -Encoding utf8

@"
competitors: []
"@ | Out-File -FilePath "docs\competitive\_index.yml" -Encoding utf8

@"
insights: []
"@ | Out-File -FilePath "docs\market-insights\_index.yml" -Encoding utf8

@"
feedback: []
"@ | Out-File -FilePath "docs\feedback\_index.yml" -Encoding utf8

@"
ideas: []
"@ | Out-File -FilePath "docs\ideas\_index.yml" -Encoding utf8

@"
notes: []
"@ | Out-File -FilePath "docs\tech-notes\_index.yml" -Encoding utf8
```

最终目录结构：

```
my-project/
├── change-requests/
│   ├── _backlog.yml          # 在途 CR 台账
│   └── _index.yml            # CR 索引
├── specs/
│   └── _index.yml            # baseline spec 索引
├── delivery/
│   └── task/
│       └── _index.yaml       # 交付任务索引
├── docs/
│   ├── product-planning/     # 产品规划文档
│   ├── competitive/          # 竞品分析报告
│   ├── market-insights/      # 市场洞察
│   ├── feedback/             # 用户反馈
│   ├── ideas/                # 想法池
│   └── tech-notes/           # 技术笔记
└── tools/                    # ← tools 包将被放在这里
```

### 第 2 步：编写 `dir-graph.yaml`

在 workspace 根目录创建 `dir-graph.yaml`，声明你的仓库信息。

**新项目推荐单仓库模式**（最简单）：

```yaml
# dir-graph.yaml
schema: "ai-first.workspace.dir-graph/v1"
workspace:
  root: "."
  timezone: "Asia/Shanghai"

repositories:
  - id: knowledge-base
    path: "."                   # workspace 自身就是 knowledge-base 仓库
    trunk: main
    role: knowledge-base
    active: true
```

> 如果以后需要前后端分离，只需追加条目即可：
>
> ```yaml
>   - id: my-backend
>     path: "../my-backend-repo"     # 相对 workspace 的路径
>     trunk: main
>     active: true
> ```

### 第 3 步：编写 `AGENTS.md`

在 workspace 根目录创建 `AGENTS.md`：

```markdown
# AGENTS.md — 行为约束入口

## 读取顺序

1. AGENTS.md
2. dir-graph.yaml
3. tools/agent-skill-matrix.yml
4. tools/README.md
5. 与任务相关的 tools/skills/ 或 tools/pipeline-templates/ 文件

## 单一事实源

| 事项 | 权威文件 |
|------|----------|
| tools 包目录结构 | tools/dir-graph.yaml |
| 完整使用流程 | tools/README.md |
| Agent/Skill 权限矩阵 | tools/agent-skill-matrix.yml |
| Active Skill 清单 | tools/skills/_index.yml |
| Active Agent 清单 | tools/agents/_index.yml |
| Active Pipeline 清单 | tools/pipeline-templates/_index.yml |

## 核心约束

- 所有仓库路径从 dir-graph.yaml#repositories 动态解析
- 状态推进必须通过对应 Skill 完成，不得手工编辑 _backlog.yml
- 代码实现只写 CR worktree，不在主工作区目录直接编码
```

### 第 4 步：放入 tools 包

将整个 `tools/` 目录复制到 workspace 的 `tools/` 下：

```powershell
# 假设 tools 包在下载目录
Copy-Item -Path "C:\Users\GOBAO\Downloads\AI\tools" `
          -Destination "c:\my-project\tools" -Recurse
```

完成后 workspace 结构：

```
my-project/
├── AGENTS.md                 ← 你创建
├── dir-graph.yaml            ← 你创建
├── change-requests/          ← 你创建
├── specs/                    ← 你创建
├── delivery/                 ← 你创建
├── docs/                     ← 你创建
└── tools/                    ← tools 包（复制过来）
    ├── AGENTS.md
    ├── dir-graph.yaml
    ├── agent-skill-matrix.yml
    ├── README.md
    ├── agents/
    ├── skills/
    └── pipeline-templates/
```

然后在 Qoder 中打开 `c:\my-project` 作为 workspace 即可。

---

## 三、完整配置模板

如果你想一键创建所有配置文件，以下是完整内容，直接复制即可。

### `dir-graph.yaml`（单仓库模式）

```yaml
schema: "ai-first.workspace.dir-graph/v1"
workspace:
  root: "."
  timezone: "Asia/Shanghai"

repositories:
  - id: knowledge-base
    path: "."
    trunk: main
    role: knowledge-base
    active: true
```

### `AGENTS.md`

```markdown
# AGENTS.md — 行为约束入口

## 读取顺序
1. AGENTS.md
2. dir-graph.yaml
3. tools/agent-skill-matrix.yml
4. tools/README.md
5. 与任务相关的 tools/skills/ 或 tools/pipeline-templates/ 文件

## 单一事实源
| 事项 | 权威文件 |
|------|----------|
| tools 包目录结构 | tools/dir-graph.yaml |
| 完整使用流程 | tools/README.md |
| Agent/Skill 权限矩阵 | tools/agent-skill-matrix.yml |
| Active Skill 清单 | tools/skills/_index.yml |
| Active Agent 清单 | tools/agents/_index.yml |
| Active Pipeline 清单 | tools/pipeline-templates/_index.yml |

## 核心约束
- 所有仓库路径从 dir-graph.yaml#repositories 动态解析
- 状态推进必须通过对应 Skill 完成，不得手工编辑 _backlog.yml
- 代码实现只写 CR worktree，不在主工作区目录直接编码
```

---

## 四、在 Qoder 中如何使用

### 调用方式：自然语言描述任务

在 Qoder 对话框中使用自然语言告诉 AI 你要做什么。AI 会读取对应的 SKILL.md 并按步骤执行。

### 完整研发流程示例

以下是完成一个需求从注册到归档的完整对话示例：

```
# === 阶段 1：需求编写 ===

👤 你：帮我注册一个新需求。标题是"用户登录功能"，
      摘要：实现基于账号密码的登录，支持 JWT 认证，
      目标版本 v1.0.0，需求负责人、开发负责人、测试负责人都是我

🤖 AI：（执行 requirement-register Skill）
      ✅ CR 已注册
      CR-ID: CR-2026-001
      已创建 worktree，下一步可以写 PRD

---

👤 你：帮我为 CR-2026-001 编写 PRD

🤖 AI：（执行 write-requirement-prd Skill）
      ✅ PRD 已生成：change-requests/CR-2026-001/prd.md
      包含功能范围、验收标准、非功能需求等

---

👤 你：帮我评审这个 PRD

🤖 AI：（执行 review-requirement Skill）
      ✅ 评审通过，verdict=pass，blockers=[]
      状态推进到 requirement-reviewing
      等待人工审批后进入下一阶段

---

👤 你：审批通过，继续

🤖 AI：（执行 approve-requirement Skill）
      ✅ 需求审批已记录
      状态推进到 requirement-approved

# === 阶段 2：架构设计 ===

👤 你：帮我写这个需求的技术设计 SDD

🤖 AI：（执行 write-tech-design Skill）
      ✅ SDD 已生成：change-requests/CR-2026-001/sdd.md
      包含架构图、接口契约、数据模型等

---

👤 你：评审 SDD

🤖 AI：（执行 review-tech-design Skill）
      ⚠️ 发现 1 个 blocker：SDD-03 接口缺少错误码定义
      回到 write-tech-design 修复…

---

👤 你：修复 blocker

🤖 AI：（执行 write-tech-design Skill，接收 review_feedback）
      ✅ 已修复，补充了错误码定义

---

👤 你：重新评审

🤖 AI：（执行 review-tech-design Skill）
      ✅ 评审通过，等待人工审批

---

👤 你：审批通过

🤖 AI：（执行 approve-tech-design Skill）
      ✅ 技术审批已记录，状态：tech-design-reviewed

# === 阶段 3：代码实现 ===

👤 你：帮我拆分开发任务

🤖 AI：（执行 write-dev-tasks Skill）
      ✅ 已生成 3 个 TASK：TASK-01、TASK-02、TASK-03
      状态：task-breakdown

---

👤 你：确认进入开发

🤖 AI：（执行 approve-dev-start Skill）
      ✅ 开发启动已确认，状态：developing

---

👤 你：按 TASK 实现代码

🤖 AI：（执行 implement-code Skill）
      ✅ 已实现所有 TASK，代码在 CR worktree 中

---

👤 你：生成测试报告

🤖 AI：（执行 write-test-report Skill）
      ✅ 测试报告已生成：test-report.md，status=pass

---

👤 你：评审代码

🤖 AI：（执行 review-code Skill）
      ✅ 代码评审通过，等待人工审批

---

👤 你：代码审批通过

🤖 AI：（执行 approve-code Skill）
      ✅ 代码审批已记录，状态：code-approved

# === 阶段 4：回写归档 ===

👤 你：帮我合入并归档

🤖 AI：（执行 feature-writeback 各 Skill）
      ✅ 分支已合并 → PRD/SDD 已回写到 specs/
      → TASK 已回写到 delivery/task/
      → traceability.yml 已生成
      → CR 已归档，状态：archived
```

### 常用任务对应的自然语言指令

| 你想做的事 | 在 Qoder 中可以这样说 |
|-----------|----------------------|
| 产品规划 | "帮我做产品规划，主题是 Q3 版本规划" |
| 市场洞察转规划 | "把这份用户反馈转成规划建议" |
| 竞品分析 | "帮我分析竞品 XXX 的最新动态" |
| 注册 CR | "帮我注册一个新需求，标题是……" |
| 写 PRD | "帮我为 CR-2026-001 编写 PRD" |
| 评审需求 | "帮我评审 CR-2026-001 的 PRD" |
| 架构设计 | "帮我写 CR-2026-001 的技术设计 SDD" |
| 拆任务 | "帮我拆分 CR-2026-001 的开发任务" |
| 写代码 | "按 TASK 帮我在 CR worktree 中实现代码" |
| 生成测试报告 | "帮我验证已实现的代码并生成测试报告" |
| 代码评审 | "帮我评审 CR-2026-001 的代码变更" |
| 回写归档 | "帮我把 CR-2026-001 合入 trunk 并归档" |
| 恢复在途 CR | "帮我在新电脑上恢复 CR-2026-001" |
| 查看 CR 状态 | "展示 CR-2026-001 的当前状态" |
| 查看 spec 看板 | "展示所有 baseline spec 的看板" |
| CR 收件箱 | "展示我当前的 CR 待办清单" |

---

## 五、场景：已有方案文档，如何启动项目改造

如果你已经有一份方案文档（比如架构设计文档、技术改造方案、产品需求文档等），不需要从零开始规划，可以直接把方案文档作为「输入素材」，注册 CR 后 AI 会从中提取 PRD 和 SDD。

### 5.1 你的文档是什么？

首先要判断你的文档内容对应流程的哪个阶段：

| 文档包含内容 | 对应阶段 | 可以跳过的步骤 |
|-------------|----------|---------------|
| 只有产品目标、功能范围、验收标准 | 需求 PRD | 跳过产品规划 `/planning` |
| 有架构图、数据库设计、API 接口、技术选型 | 架构设计 SDD | 跳过规划 + PRD 编写 |
| **两者都有**（像 config-driven-edi-platform.md 那样） | PRD + SDD 合体 | 跳过规划、直接从注册 CR 开始 |

### 5.2 执行流程

对于已有完整方案文档的项目（常见于改造/重构场景），推荐的执行路径：

```
你的方案文档（specs/xxx.md）
           │
           ▼
  ① 注册 CR（CR-2026-002）
     AI 读取方案文档，提取标题、摘要、目标版本
           │
           ▼
  ② 从方案文档提取 PRD
     AI 读取文档中的概述、目标、核心决策 → 写入 prd.md
           │
           ▼
  ③ 需求评审 + 人工审批
           │
           ▼
  ④ 从方案文档提取 SDD
     AI 读取文档中的架构、数据库、引擎设计、API → 写入 sdd.md
           │
           ▼
  ⑤ 架构评审 + 人工审批
           │
           ▼
  ⑥ 从方案文档拆分 TASK
     AI 读取文档中的开发步骤，拆为独立任务
           │
           ▼
  ⑦ 逐任务编码 → 测试 → 代码评审 → 审批
           │
           ▼
  ⑧ 回写归档
```

### 5.3 实际操作示例

以一份名为 `config-driven-edi-platform.md` 的方案文档为例，它包含了架构图、6 张数据库表设计、核心引擎伪代码、API 路由表、前端页面线框图、以及 6 阶段 31 步开发计划。

**第 1 步：注册 CR**

```
👤 你：我有一份方案文档 specs/config-driven-edi-platform.md，
      帮我注册一个新 CR，读取文档获取标题、摘要、版本信息，
      三个 owner 都是我

🤖 AI：读取文档 → 提取关键信息 → 注册 CR-2026-002 → 写入 cr.md
      ✅ CR 已注册
      CR-ID: CR-2026-002
      标题: 配置驱动 EDI 平台重构
      摘要: 将 EDI 平台从"内存存储+硬编码插件"重构为"SQLite持久化+配置驱动"
```

**第 2 步：从方案文档生成 PRD**

```
👤 你：从方案文档提取需求部分，生成 PRD

🤖 AI：读取文档的概述、核心决策、API 设计部分 →
      生成 change-requests/CR-2026-002/prd.md
```

**第 3 步：评审 + 审批**

```
👤 你：评审 PRD
👤 你：审批通过
```

**第 4 步：从方案文档生成 SDD**

```
👤 你：从方案文档提取架构设计部分，生成 SDD

🤖 AI：读取文档的架构图、数据库设计、核心引擎设计 →
      生成 change-requests/CR-2026-002/sdd.md
```

**第 5 步：评审 + 审批**

```
👤 你：评审 SDD
👤 你：审批通过
```

**第 6 步：从方案文档拆分 TASK（加速方式）**

如果你的方案文档已经有明确的开发步骤（如第九章"开发步骤"列出了 6 阶段 31 步），可以直接让 AI 按此拆分：

```
👤 你：方案文档第九章有 6 阶段 31 步开发计划，
      帮我按这个拆分为 TASK，每个阶段一个 TASK 文件

🤖 AI：读取方案文档第九章 → 生成 6 个 TASK 文件
      TASK-01: SQLite 基础设施（5 步子任务）
      TASK-02: 配置模型（5 步子任务）
      TASK-03: 核心引擎（5 步子任务）
      TASK-04: 推送联动（3 步子任务）
      TASK-05: 前端配置页（5 步子任务）
      TASK-06: 迁移与清理（3 步子任务）
```

> **提示**：如果方案文档已经非常详细，AI 可以一次性连续执行步骤 ①→②→④→⑥，中间只在你需要确认时暂停（需求审批、架构审批、开发启动确认）。

### 5.4 现有项目改造 vs 全新项目

| | 全新项目 | 现有项目改造 |
|---|---|---|
| 起点 | 从 `/planning` 开始或直接注册 CR | 已有方案文档 → 直接注册 CR |
| PRD 来源 | AI 根据你的描述生成 | AI 从方案文档中提取 |
| SDD 来源 | AI 根据 PRD 设计 | AI 从方案文档中提取 |
| TASK 来源 | AI 根据 SDD 拆分 | 方案文档已有开发步骤 → AI 直接转化 |
| Worktree | 需要在 knowledge-base 上创建 | 同上，但代码实现直接写现有仓库的文件 |
| 优势 | 全程 AI 参与，结构规范 | 利用已有设计沉淀，省掉大量前期工作 |

### 5.5 常见问题

**Q: 方案文档放在哪里？**

放在 `specs/` 目录下。AI 注册 CR 时会自动将 `source` 指向该文档路径。

**Q: 方案文档很长，AI 一次能读完吗？**

可以。AI 会分阶段读取：注册时读标题和摘要，写 PRD 时读需求和功能部分，写 SDD 时读架构和设计部分，拆 TASK 时读开发步骤。每次只聚焦当前阶段需要的内容。

**Q: 如果方案文档缺少某些部分怎么办？**

不影响的。缺少的部分 AI 会根据已有信息补充。比如文档没有 API 设计细节，AI 在写 SDD 时会根据架构推断并补全。

**Q: 我的方案文档修改过了，CR 里的 PRD/SDD 会自动更新吗？**

不会。CR 注册后，PRD 和 SDD 是独立副本。如果方案文档有重大修改，告诉 AI"方案文档更新了，帮我在 CR 中同步更新 PRD"即可。

---

## 六、技能包架构速览

```
tools/
├── skills/                     # 57 个原子 Skill，按领域分 10 组
│   ├── planning/               # 调研规划（市场、竞品、产品分析）
│   ├── requirement/            # 需求编写（CR 注册、PRD、评审、审批）
│   ├── develop/                # 开发（SDD、任务、编码、测试、代码评审）
│   ├── writeback/              # 回写（合入、PRD/SDD 回写、追溯链）
│   ├── sync/                   # 远端同步（push/pull/resume/handover）
│   ├── spec/                   # Spec 查询视图
│   ├── competitive/            # 竞品分析
│   ├── review/                 # 横向对齐与影响分析
│   ├── cr/                     # CR 生命周期管理（状态、收件箱、归档）
│   └── shared/                 # 通用能力（文档校验、受控 shell）
│
├── agents/                     # 9 个 Agent（5 Primary + 4 Subagent）
│   ├── product-planning-agent  # 主责：规划、市场洞察、roadmap
│   ├── requirement-writer      # 主责：CR 注册、PRD、需求评审/审批
│   ├── dev-agent               # 主责：SDD、任务、编码、代码评审/审批
│   ├── competitive-analyst-agent
│   ├── customer-support-agent
│   ├── spec-agent              # 子代理：spec 只读查询
│   ├── delivery-agent          # 子代理：任务回写
│   ├── quality-reviewer-agent  # 子代理：质量门与对齐校验
│   └── knowledge-agent         # 子代理：知识写入
│
├── pipeline-templates/         # 8 条 Pipeline 模板
│   ├── product-planning.pipeline.json
│   ├── market-to-plan.pipeline.json
│   ├── competitive-radar.pipeline.json
│   ├── requirement-authoring.pipeline.json
│   ├── architecture-design.pipeline.json
│   ├── code-implementation.pipeline.json
│   ├── feature-writeback.pipeline.json
│   └── resume-cr.pipeline.json
│
├── agent-skill-matrix.yml      # Agent/Skill 权限矩阵（机器可读）
├── AGENT-SKILL-MATRIX.md       # 权限矩阵说明（人读）
└── README.md                   # 完整使用流程文档
```

**三者关系：Pipeline 编排 Skill 执行顺序 → Agent 负责调度 → Skill 是唯一执行单元。**

---

## 七、常见问题

### Q: 为什么 `/requirement` 等命令不生效？

这些命令是 AI First 平台内置的，Qoder 中没有。在 Qoder 中直接向 AI 描述任务即可，例如说"帮我注册一个新需求"。

### Q: 我需要安装额外的东西吗？

只需要：
1. 按本文档创建 workspace 目录结构
2. 复制 tools 包到 `tools/` 下
3. 在 Qoder 中打开 workspace

不需要安装任何 npm 包、不需要配置任何环境变量。

### Q: 单仓库和多仓库怎么选？

**新项目用单仓库**。只需 `knowledge-base` 一个仓库声明，所有东西（代码、文档、CR 过程产物）都在同一个 Git 仓库里。以后拆了再加就行。

### Q: 需要人工审批的节点怎么处理？

当执行到需要人工审批的节点时，AI 会告诉你当前状态并等待确认。你只需回复"审批通过"或指出问题，AI 继续执行下一步。

### Q: 自动评审发现有 blocker 怎么办？

AI 会告诉你具体的 blocker（如"接口缺少错误码定义"），你需要回复"修复"或给出具体指导意见，AI 会回到修复节点重新处理，最多自动重试 3 次。

### Q: tools 包更新了怎么办？

重新复制新的 tools 包到 `tools/` 目录，覆盖旧的即可。已在进行的 CR 不受影响。

---

> **核心要记住的一点**：在 Qoder 中，你就是通过自然语言和 AI 对话来驱动整个研发流程。每次说"帮我做 XXX"，AI 就会读取对应的 Skill 按步骤执行。不需要记任何命令。

---

## 八、全部可用指令速查表（57 条）

以下是 tools 包中所有 active Skill 对应的自然语言指令，按研发阶段分组。你不需要记住所有指令——只需描述你想做什么，AI 会自动匹配对应的 Skill。

### 8.1 产品规划期（15 条）

| 你想做的事 | 在 Qoder 中可以这样说 | 对应 Skill |
|-----------|----------------------|-----------|
| 聚合全量产品知识 | "帮我整理当前产品的全貌，包括 specs、在途 CR、竞品、市场洞察" | `gather-product-context` |
| 分析用户反馈 | "帮我分析 docs/feedback/ 下的用户反馈，归纳高频诉求和痛点" | `analyze-user-feedback` |
| 市场调研 | "帮我调研 XX 市场的现状，生成市场洞察报告" | `conduct-market-research` |
| 竞品分析 | "帮我分析竞品 XX 的情况，串联抓取动态和生成报告" | `run-competitive-analysis` |
| 分析当前产品 | "帮我分析当前产品的现状，包括 specs 基线、在途 CR 和指标" | `analyze-current-product` |
| 生成规划报告 | "综合各项分析，帮我生成产品规划报告" | `write-planning-report` |
| 评审规划报告 | "帮我评审这份产品规划报告，检查依据、建议和待决策项" | `review-planning-report` |
| 更新路线图 | "帮我把已审批的规划条目写入 roadmap" | `write-roadmap` |
| 写入规划知识库 | "把这条已审批的规划建议落盘到 docs/product-planning/" | `write-planning-entry` |
| 提取市场洞察 | "从这份原始素材中提取市场/用户/竞品洞察，写入 raw insight" | `extract-market-insight` |
| 写洞察简报 | "基于这条 raw insight，生成产品洞察简报" | `write-insight-brief` |
| 生成规划草稿 | "帮我生成一份产品规划文档草稿，不落盘只预览" | `planning-draft` |
| 快速记录想法 | "帮我把这个产品想法记录到 docs/ideas/" | `record-idea` |
| 当前焦点简报 | "帮我生成当前焦点版本和在途 CR 的简报摘要" | `focus-briefing` |

### 8.2 需求编写期（4 条）

| 你想做的事 | 在 Qoder 中可以这样说 | 对应 Skill |
|-----------|----------------------|-----------|
| 注册新需求 | "帮我注册一个新需求，标题是 XXX，摘要：XXX，目标版本 v1.0.0，三个 owner 都是我" | `requirement-register` |
| 编写 PRD | "帮我为 CR-2026-001 编写 PRD" | `write-requirement-prd` |
| 评审需求 | "帮我评审 CR-2026-001 的 PRD，检查完整性、可测试性和范围对齐" | `review-requirement` |
| 需求审批 | "需求评审通过了，帮我记录审批结论并推进状态" | `approve-requirement` |

### 8.3 开发期（10 条）

| 你想做的事 | 在 Qoder 中可以这样说 | 对应 Skill |
|-----------|----------------------|-----------|
| 编写技术设计 | "帮我为 CR-2026-001 编写 SDD，包括架构、接口契约、数据模型" | `write-tech-design` |
| 评审技术设计 | "帮我评审 SDD，检查 PRD 对齐、架构合理性和接口完整性" | `review-tech-design` |
| 架构审批 | "技术评审通过了，帮我记录架构审批结论并推进状态" | `approve-tech-design` |
| 编写开发计划 | "帮我编写开发计划 plan.md，包括里程碑、风险和依赖" | `write-dev-plan` |
| 拆分开发任务 | "帮我把 CR-2026-001 拆分为可执行的 TASK" | `write-dev-tasks` |
| 确认进入开发 | "任务拆分已完成，帮我记录开发启动确认并推进状态" | `approve-dev-start` |
| 实现代码 | "按 PRD/SDD/TASK 在 CR worktree 中实现代码" | `implement-code` |
| 生成测试报告 | "帮我汇总验证结果和 TASK 验收覆盖，生成测试报告" | `write-test-report` |
| 代码评审 | "帮我评审 CR-2026-001 的代码变更，检查对齐、质量和安全性" | `review-code` |
| 代码审批 | "代码评审通过了，帮我记录代码审批结论并推进状态" | `approve-code` |

### 8.4 回写期（4 条）

| 你想做的事 | 在 Qoder 中可以这样说 | 对应 Skill |
|-----------|----------------------|-----------|
| 合并分支 | "帮我把 CR-2026-001 的各仓分支合并回 trunk" | `merge-feature-branch` |
| 回写 PRD/SDD | "帮我把 CR 的 PRD 和 SDD 回写到 specs/ 基线" | `writeback-prd-sdd` |
| 回写任务 | "帮我把 CR 的 TASK 映射到 delivery/task/" | `writeback-tasks` |
| 生成追溯链 | "帮我生成 PRD↔SDD↔TASK↔代码↔CR 的完整追溯链" | `writeback-traceability` |

### 8.5 远端同步（5 条）

| 你想做的事 | 在 Qoder 中可以这样说 | 对应 Skill |
|-----------|----------------------|-----------|
| 推送进度 | "帮我把 CR-2026-001 的当前进度推送到远端 checkpoint" | `push-progress` |
| 拉取进度 | "帮我把 CR-2026-001 的远端最新进度拉到本地" | `pull-progress` |
| 恢复在途 CR | "换电脑了，帮我在新环境恢复 CR-2026-001" | `resume-from-remote` |
| 列出远端 CR | "帮我列出远端所有在途的 CR 及其状态" | `list-remote-checkpoints` |
| 移交 CR | "帮我把 CR-2026-001 的开发角色移交给李四" | `handover-cr` |

### 8.6 Spec 查询（3 条）

| 你想做的事 | 在 Qoder 中可以这样说 | 对应 Skill |
|-----------|----------------------|-----------|
| 查看单个 spec | "帮我展示 spec X 的完整状态，包括 PRD 摘要、SDD 摘要、阶段和追溯覆盖率" | `spec-show` |
| 多维度检索 spec | "帮我按 status/version/owner 筛选所有 baseline spec" | `spec-query` |
| Spec 全局看板 | "帮我展示所有 spec 的全局看板，按阶段分布、版本分组、blocker 汇总" | `spec-dashboard` |

### 8.7 竞品分析（3 条）

| 你想做的事 | 在 Qoder 中可以这样说 | 对应 Skill |
|-----------|----------------------|-----------|
| 抓取竞品动态 | "帮我抓取竞品 XX 官网和互联网上的近期新闻" | `fetch-competitor-updates` |
| 生成竞品报告 | "帮我生成竞品 XX 的结构化分析报告，落盘到 docs/competitive/reports/" | `write-competitive-report` |
| 竞品报告转规划建议 | "把这份竞品报告转成产品规划建议草稿" | `report-to-planning-suggestion` |

### 8.8 质量门（2 条）

| 你想做的事 | 在 Qoder 中可以这样说 | 对应 Skill |
|-----------|----------------------|-----------|
| 跨节点对齐校验 | "帮我检测 PRD↔SDD↔TASK↔代码之间是否有不一致" | `review-alignment` |
| 变更影响分析 | "上游变更了，帮我分析对下游的影响，标记 stale 项" | `change-impact-analysis` |

### 8.9 CR 生命周期管理（9 条）

| 你想做的事 | 在 Qoder 中可以这样说 | 对应 Skill |
|-----------|----------------------|-----------|
| 记录补充审查 | "帮我在 CR-2026-001 中记录一条补充审查意见" | `cr-review-record` |
| 原子写入 CR 状态 | "帮我把 CR-2026-001 推进到 XXX" | `crctl advance` |
| 发送收件箱事件 | "帮我就 CR-2026-001 的审批结果向 inbox 发送事件" | `inbox-emit` |
| 归档 CR | "帮我把 CR-2026-001 归档，移入历史记录" | `cr-archive` |
| CR 反馈回写 | "帮我把 CR-2026-001 的实施结论写回 traceability.yml 和技术笔记" | `feedback-writeback` |
| 查看 CR 收件箱 | "帮我按角色展示我的 CR 待办清单" | `cr-inbox` |
| 多维度 CR 检索 | "帮我按类型/状态/提交人检索所有在途 CR" | `cr-query` |
| 查看单个 CR | "帮我展示 CR-2026-001 的完整详情，包括审查记录和追溯链路" | `cr-show` |
| CR 全局看板 | "帮我展示所有 CR 的状态分布、SLA 风险和阻塞项" | `cr-dashboard` |

### 8.10 通用能力（3 条）

| 你想做的事 | 在 Qoder 中可以这样说 | 对应 Skill |
|-----------|----------------------|-----------|
| 文档校验 | "帮我校验这份文档的 frontmatter 和结构是否符合规范" | `validate-doc` |
| 生成工程文档 | "帮我按模板生成 PRD/SDD/TASK/MODULE 等工程文档" | `engineering-docs` |
| 受控 Shell | （由系统自动调用，用户无需手动触发） | `controlled-shell` |

### 8.11 外部方法论 Skill（6 条，由运行时提供）

以下能力由目标运行时（Qoder 本身）提供，不在 phase0 tools 包内，但可直接使用：

| 能力 | 在 Qoder 中可以这样说 |
|------|----------------------|
| 头脑风暴 | "帮我头脑风暴一下 XX 功能的方案" |
| 编写执行计划 | "帮我为这个任务编写执行计划" |
| 执行计划 | "帮我按计划逐步执行这个任务" |
| 子代理驱动开发 | "用子代理方式帮我并行开发这几个模块" |
| 测试驱动开发 | "用 TDD 方式帮我开发这个功能，先写测试再写实现" |
| 完成后校验 | "帮我检查一下刚才的工作是否完整，有没有遗漏" |

### 8.12 流程加速常用组合指令

以下是一句话触发多个步骤的组合指令，适合熟练后提速：

| 场景 | 一句话指令 | 自动执行的步骤 |
|------|-----------|---------------|
| 快速注册+PRD | "帮我注册新需求 XX 并从方案文档提取 PRD" | `requirement-register` → `write-requirement-prd` |
| 注册+PRD+评审 | "帮我注册新需求 XX，写 PRD，然后评审" | `requirement-register` → `write-requirement-prd` → `review-requirement` |
| SDD+任务+计划 | "帮我写 SDD，然后拆任务和写开发计划" | `write-tech-design` → `write-dev-tasks` → `write-dev-plan` |
| 实现+测试+评审 | "帮我实现代码，跑测试生成报告，然后评审" | `implement-code` → `write-test-report` → `review-code` |
| 一键回写归档 | "帮我把这个 CR 合入、回写、生成追溯链、归档" | `merge-feature-branch` → `writeback-prd-sdd` → `writeback-tasks` → `writeback-traceability` → `cr-archive` |
| 从方案文档一键到 TASK | "从方案文档 XX 注册 CR，提取 PRD 和 SDD，评审通过后拆 TASK" | `requirement-register` → `write-requirement-prd` → `review-requirement` → (审批) → `write-tech-design` → `review-tech-design` → (审批) → `write-dev-tasks` |
| 暂停后恢复 | "帮我恢复 CR-2026-002，查看当前状态，然后继续下一步" | `resume-from-remote` → `cr-show` → 等待用户确认下一步 |

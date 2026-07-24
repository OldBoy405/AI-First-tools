# 工程结构文档（Team 模式）：六层产品文档结构详解

> 本文档基于 [KNOWLEDGE-LIFECYCLE.md](./KNOWLEDGE-LIFECYCLE.md) 中定义的六层知识体系，详细描述 **Team 模式**（多仓库/大团队）下每一层的具体文档结构、文件职责及适用场景。
>
> Solo 模式（单仓库/小团队）的文档结构请参见 [ENGINEERING-STRUCTURE-SOLO.md](./ENGINEERING-STRUCTURE-SOLO.md)。

---

## 一、六层知识体系总览

```
平台层   governance-standards/              ← 全公司共享的规范（Schema、模板、质量门禁）
  │
产品线层  {product-line}/                   ← 跨领域知识（统一术语、事件契约、战略 PRD、治理）
  │
领域层   {domain}/                         ← 域内聚合知识（词汇、事件、上下文地图、测试用例）
  │
应用层   {app}/docs/                       ← 应用自治知识（PRD/SDD/MODULE/PLAN/TASK/Runbook）
  │
特性层   docs/features/{feature}/          ← 特性中心（功能模块文档聚合，跨职能协作单元）
  │
表单层   docs/features/{feature}/forms/    ← DDD 最小颗粒度（字段定义/验证规则/聚合数据结构）
```

---

## 二、平台层文档结构

**归属路径**：`governance-standards/`

**定位**：全公司唯一修改入口（SSOT），提供规范、模板和能力定义，所有层均向上引用此层。

```
governance-standards/
├── schemas/                             ← JSON Schema 校验文件
│   ├── prd-schema.json                  ← PRD 元信息结构校验规则
│   ├── sdd-schema.json                  ← SDD 元信息结构校验规则
│   ├── contract-schema.json             ← MODULE 接口规格元信息校验规则
│   ├── plan-schema.json                 ← PLAN 迭代计划元信息校验规则
│   ├── strategy-prd-schema.json         ← 战略 PRD 元信息校验规则
│   └── benchmark-schema.json            ← BENCHMARK 对标报告元信息校验规则
│
├── templates/                           ← 文档生成模板（所有 gen-* Skill 的输出骨架）
│   ├── PRD-template.md                  ← 产品需求文档模板
│   ├── SDD-template.md                  ← 系统设计文档模板
│   ├── CONTRACT-template.md             ← 接口规格文档模板
│   ├── PLAN-template.md                 ← 迭代计划模板
│   ├── TASK-template.md                 ← 开发任务卡模板
│   ├── STRATEGY-PRD-template.md         ← 战略 PRD 模板
│   ├── BENCHMARK-template.md            ← 竞品/方案对比模板
│   ├── FEATURE-template.md              ← 特性 README 模板
│   ├── RUNBOOK-template.md              ← 运维手册模板
│   ├── ROADMAP-template.md              ← 路线图模板
│   ├── PIPELINE-template.yaml           ← CI/CD 流水线模板
│   ├── _index-template.yaml             ← 台账文件模板
│   ├── platform-adapters/               ← 平台适配器（针对不同 CI/CD 平台的模板变体）
│   └── scaffold/                        ← 脚手架初始化模板（he init 命令使用）
│
├── quality-gates/                       ← 质量门禁配置
│   ├── sdd-completeness.yaml            ← 文档链路完整性规则
│   ├── ci-gates.yaml                    ← CI 质量门禁（覆盖率阈值、安全扫描规则）
│   ├── security-compliance.yaml         ← 安全合规门禁
│   └── engineering-metrics.yaml         ← 工程指标门禁（DORA 指标）
│
├── conventions/                         ← 命名/版本/分支约定规范
│   ├── naming.yaml                      ← 资源命名规范
│   ├── versioning.yaml                  ← 版本号规范（SemVer）
│   └── branching.yaml                   ← 分支命名规范
│
└── capabilities/                        ← Agent/Skill 定义（SSOT）
    ├── agents/                          ← Agent 规范文件
    ├── skills/                          ← Skill 规范文件
    ├── platform-overlays/               ← 平台特定叠加层
    └── registry.yaml                    ← 能力注册表
```

### 关键文件说明

| 目录/文件 | 用途 | 消费者 |
|-----------|------|--------|
| `schemas/*.json` | 校验各类文档的元信息结构是否合规 | `validate-schema` Skill |
| `templates/*.md` | 所有 `gen-*` Skill 的输出骨架 | 各文档生成 Agent |
| `quality-gates/*.yaml` | CI 流水线中的质量门禁判定依据 | `check-doc-chain`、CI Pipeline |
| `conventions/*.yaml` | 统一命名、版本、分支规范 | 所有 Agent |
| `capabilities/` | Agent 与 Skill 的规范定义（修改后需 `he sync`） | Agent 运行时 |

---

## 三、产品线层文档结构

**归属路径**：`{product-line}/`

**定位**：管理跨领域知识，是战略 PRD 和跨域集成规范的归属地。

```
{product-line}/
├── docs/                                ← 产品线活文档
│   ├── overview.md                      ← 产品线概述（背景、愿景、管辖领域、核心目标）
│   │
│   ├── features/                        ← 跨领域特性中心
│   │   └── {feature-name}/              ← 每个战略特性一个子目录
│   │       ├── SPRD-{NNN}.md            ← 战略 PRD（跨领域需求主文档）
│   │       ├── GAP-{YYYY-QN}.md         ← GAP 分析报告
│   │       ├── ADR-{NNN}.md             ← 架构决策记录
│   │       └── breakdown.md             ← 跨领域拆解计划
│   │
│   ├── journeys/                        ← 跨域端到端用户旅程
│   │   └── JOURNEY-{NNN}-{name}.md      ← 旅程文档（活文档）
│   │
│   ├── help-center/                     ← 面向客户的帮助中心
│   │   ├── guides/                      ← 操作指南
│   │   │   └── GUIDE-{NNN}-{name}.md
│   │   ├── faq/                         ← 常见问题
│   │   │   └── FAQ-{topic}.md
│   │   ├── troubleshooting/             ← 故障排查
│   │   │   └── TS-{NNN}-{name}.md
│   │   ├── release-notes/               ← 版本更新说明
│   │   │   └── RN-{version}.md
│   │   └── _index.yaml
│   │
│   └── delivery/                        ← 产品线交付状态
│       ├── roadmap.md                   ← 产品线交付路线图
│       └── breakdown/
│           └── strategy-status.yaml     ← 战略 PRD 拆解执行状态
│
├── knowledge/                           ← 产品线知识库（单源，lifecycle: living | stable）
│   ├── GLOSSARY.md                      ← 跨域统一语言词汇表
│   ├── context-map.md                   ← 领域间边界地图
│   ├── data-model.md                    ← 跨域共享数据模型
│   ├── integration-patterns.md          ← 跨域集成规范
│   ├── shared-events.yaml               ← 跨域事件契约
│   ├── scenarios/                       ← 产品线级业务场景
│   │   └── SCENARIO-{NNN}-{name}.md
│   └── adr/                             ← 产品线级架构决策记录
│
├── strategy/                            ← 战略规划文档
│   ├── roadmap.md                       ← 产品线战略路线图（基线文档）
│   ├── prd/
│   │   └── _index.yaml                  ← 战略 PRD 台账
│   ├── gap-analysis/                    ← GAP 分析报告
│   └── research/                        ← 研究分析（过程文档，按季度归档）
│       ├── BENCHMARK-{YYYYQN}-{NNN}-{name}.md
│       ├── MARKET-{YYYYQN}-{NNN}-{name}.md
│       ├── CUSTOMER-{YYYYQN}-{NNN}-{name}.md
│       ├── _index.yaml
│       └── archive/                     ← 过期研究文档归档
│           └── {YYYYQN}/
│
├── registry/                            ← 产品线注册表（CI 自动聚合）
│   ├── domains.yaml                     ← 领域注册表
│   ├── domain-status.yaml               ← 各领域状态聚合
│   └── strategy-status.yaml             ← 战略 PRD 执行进度
│
├── environments/                        ← 跨环境配置
│   ├── dev/
│   ├── staging/
│   └── prod/
│
├── governance/                          ← 产品线治理规则
│   ├── approval-rules.yaml              ← 审批规则
│   ├── rbac.yaml                        ← 角色权限控制
│   └── resource-allocation.yaml         ← 资源配额策略
│
├── .github/workflows/                   ← 产品线 CI/CD
│   ├── ci.yaml                          ← 战略状态聚合
│   ├── cross-domain-test.yaml           ← 跨领域集成测试
│   ├── product-release.yaml             ← 产品线发布流水线
│   └── product-rollback.yaml            ← 产品线回滚流水线
│
├── OWNERS                               ← 产品线 Owner 声明
└── README.md                            ← 产品线入门指南
```

### 关键文件说明

| 目录/文件 | 类型 | 用途 |
|-----------|------|------|
| `docs/features/` | 基线 | 跨领域战略特性的聚合入口，包含战略 PRD、GAP 分析、拆解计划 |
| `docs/journeys/` | 基线 | 跨域端到端用户旅程，随战略演进更新 |
| `docs/help-center/` | 基线 | 面向客户的帮助中心，含 GUIDE/FAQ/TS/RN |
| `knowledge/` | 基线 | 跨域知识库（词汇、事件契约、数据模型），通过 `lifecycle` 字段区分状态 |
| `strategy/` | 基线+过程 | 战略路线图（基线）+ 研究分析（过程，按季度归档） |
| `registry/` | 自动生成 | CI 自动聚合的状态视图，禁止手动修改 |
| `governance/` | 基线 | 产品线治理规则（审批、权限、配额） |

---

## 四、领域层文档结构

**归属路径**：`{domain}/`

**定位**：聚合同一领域内多个应用的知识，是跨应用协作的协调中心。

```
{domain}/
├── docs/                                ← 领域活文档
│   ├── overview.md                      ← 领域概述（边界定义、管辖应用清单）
│   │
│   ├── features/                        ← 跨应用特性中心
│   │   └── {feature-name}/
│   │       └── breakdown.md             ← 跨应用拆解计划
│   │
│   ├── delivery/
│   │   └── breakdown/
│   │       └── app-status.yaml          ← 跨应用交付状态聚合
│   │
│   ├── journeys/                        ← 跨应用业务流程（活文档）
│   │   └── JOURNEY-{NNN}-{name}.md
│   │
│   ├── strategy/                        ← 领域级规划
│   │   ├── roadmap.md                   ← 领域路线图
│   │   └── okr.md                       ← 领域 OKR
│   │
│   └── qa/                              ← 域级测试资产
│       ├── test-cases/                  ← 测试用例
│       │   ├── TC-{NNN}-{name}.md
│       │   └── _index.yaml              ← 测试用例台账（含 refs/coverage 字段）
│       ├── test-plans/                  ← 测试计划
│       │   └── TP-{NNN}-{name}.md
│       └── reports/                     ← 测试执行报告（过程文档）
│           ├── TR-{version}-{NNN}-{name}.md
│           └── _index.yaml
│
├── knowledge/                           ← 领域知识库（单源，lifecycle: living | stable）
│   ├── GLOSSARY.md                      ← 域内统一语言词汇表
│   ├── context-map.md                   ← 域内上下文地图
│   ├── domain-data-model.md             ← 域内共享数据模型
│   ├── integration-patterns.md          ← 域内集成规范
│   ├── shared-events.yaml               ← 域内事件契约
│   └── scenarios/                       ← 域内业务场景
│       └── SCENARIO-{NNN}-{name}.md
│
├── registry/                            ← 领域注册表（CI 自动聚合）
│   ├── apps.yaml                        ← 应用注册表
│   ├── sdd-status.yaml                  ← 各应用 SDD 状态聚合
│   └── delivery-status.yaml             ← PLAN/TASK 交付进度
│
├── environments/                        ← 领域级环境配置
│   ├── dev/
│   │   ├── env.yaml
│   │   └── overrides.yaml
│   ├── staging/
│   └── prod/
│
├── .github/workflows/                   ← 领域 CI/CD
│   ├── ci.yaml                          ← 交付状态聚合
│   ├── domain-release.yaml              ← 领域发布流水线
│   ├── domain-rollback.yaml             ← 领域回滚流水线
│   └── integration-test.yaml            ← 域内集成测试
│
├── OWNERS                               ← 领域 Owner 声明
└── README.md                            ← 领域入门指南
```

### 关键文件说明

| 目录/文件 | 类型 | 用途 |
|-----------|------|------|
| `docs/qa/` | 基线+过程 | 域级测试资产：TC（基线）、TP（基线）、TR（过程，绑定版本） |
| `docs/strategy/` | 基线 | 领域路线图和 OKR，与产品线目标对齐 |
| `knowledge/` | 基线 | 域内知识库（词汇、事件、数据模型），跨域部分上报产品线 |
| `registry/` | 自动生成 | CI 自动聚合，追踪应用注册、SDD 状态、交付进度 |

---

## 五、应用层文档结构

**归属路径**：`{app}/`

**定位**：知识体系的执行末梢，存放一个微服务/应用的全量自治知识。

```
{app}/
├── docs/                                ← 应用完整知识库
│   ├── overview.md                      ← 应用概述（功能边界、架构简图、外部依赖）
│   │
│   ├── journeys/                        ← 应用内用户流
│   │   └── JOURNEY-{NNN}-{name}.md
│   │
│   ├── product/                         ← 产品文档链路（活文档，反映系统当前全貌）
│   │   ├── prd/                         ← 产品需求文档
│   │   │   ├── PRD-{NNN}-{name}.md
│   │   │   └── _index.yaml              ← PRD 台账
│   │   ├── architecture/                ← 系统设计文档
│   │   │   ├── SDD-{NNN}-{name}.md
│   │   │   └── _index.yaml              ← SDD 台账
│   │   └── contracts/                   ← 接口规格
│   │       ├── MODULE-{NNN}-{name}.md   ← 接口规格文档（含行为规格 BH-XX）
│   │       ├── openapi/
│   │       │   └── {service}-{version}.yaml  ← OpenAPI 3.0 接口描述文件
│   │       └── _index.yaml              ← MODULE 台账
│   │
│   ├── delivery/                        ← 交付文档（过程文档区）
│   │   ├── roadmap.md                   ← 应用级产品路线图（基线）
│   │   ├── risk-register.md             ← 风险登记簿
│   │   ├── plan/
│   │   │   ├── PLAN-{version}-{NNN}-{name}.md
│   │   │   └── _index.yaml
│   │   ├── task/
│   │   │   ├── TASK-{version}-{NNN}-{NN}-{name}.md
│   │   │   └── _index.yaml              ← TASK 台账（含 status/branch/PR/refs）
│   │   ├── releases/
│   │   │   ├── RELEASE-{version}.md
│   │   │   └── _index.yaml
│   │   └── archive/                     ← 过程文档归档（按版本隔离）
│   │       └── {version}/
│   │           ├── plan/
│   │           ├── task/
│   │           ├── releases/
│   │           └── _index.yaml          ← 归档台账
│   │
│   ├── features/                        ← 特性中心（详见第六节）
│   │   └── {feature-name}/
│   │
│   ├── VIEWS.yaml                       ← 角色视图映射（角色 → 知识源）
│   │
│   └── ops/                             ← 运维文档
│       └── runbook/
│           ├── deployment.md            ← 部署运维手册
│           ├── incident-response.md     ← 故障响应手册
│           └── monitoring.md            ← 监控手册
│
├── helm/                                ← Helm 部署配置
│   ├── Chart.yaml
│   └── values/
│       ├── dev.yaml
│       ├── staging.yaml
│       └── prod.yaml
│
├── src/                                 ← 源代码
├── .github/workflows/                   ← 应用级 CI/CD
│   ├── ci.yaml
│   └── cd.yaml
│
├── orchestrator.yaml                    ← Pipeline 编排配置
├── .githooks/commit-msg                 ← Git Hook（强制关联 TASK 编号）
├── .pre-commit-config.yaml
├── docker-compose.yaml
├── .env.example
└── Makefile
```

### 应用层文档分区

| 分区 | 路径 | 文档类型 | 更新方式 |
|------|------|---------|---------|
| **产品区** | `docs/product/` | 基线文档（PRD/SDD/MODULE） | 原地更新，追踪 revision |
| **特性区** | `docs/features/` | 基线文档（特性中心/FORM） | 原地更新 |
| **旅程区** | `docs/journeys/` | 基线文档（应用内用户流） | 原地更新 |
| **交付区** | `docs/delivery/` | 过程文档（PLAN/TASK/RELEASE） | 只增不改，版本归档 |
| **运维区** | `docs/ops/` | 基线文档（Runbook） | 原地更新，事故后补充 |

### 文档链路（核心工程链路）

```
PRD（需求）→ SDD（设计）→ MODULE（接口契约）→ PLAN（计划）→ TASK（任务）→ Code（代码）
  每层 approved 后才允许创建下一层
```

---

## 六、特性层文档结构

**归属路径**：`{app}/docs/features/{feature-name}/`

**定位**：以特性为轴聚合所有相关文档，是跨职能协作的单一入口。

```
docs/features/{feature-name}/
├── {feature-name}.md                    ← 特性 README（概述、状态、关联文档索引）
│
├── forms/                               ← DDD 表单层（详见第七节）
│   └── {form-name}/
│
├── spec/                                ← 特性内联规格
│   ├── MODULE-{NNN}-{name}.md           ← 镜像 product/contracts/ 中的 MODULE
│   └── openapi/                         ← 特性内联 OpenAPI
│
├── plan/                                ← 特性关联迭代计划
│   └── PLAN-{NNN}-{name}.md             ← 镜像 delivery/plan/
│
└── task/                                ← 特性关联任务卡
    └── TASK-{NNN}-{name}.md             ← 镜像 delivery/task/
```

### 特性中心的价值

- **产品经理**：从此处查看特性的需求全貌和拆解状态
- **开发人员**：从此处查看特性的 MODULE 规格和 FORM 字段定义
- **测试人员**：从此处查看表单级测试用例和业务规则
- **项目经理**：从此处查看特性关联的 PLAN/TASK 进度

---

## 七、表单层文档结构（DDD 最小颗粒度）

**归属路径**：`{app}/docs/features/{feature-name}/forms/{form-name}/`

**定位**：对应 DDD 中的聚合根（Aggregate Root）的用户侧呈现，承载字段定义、验证规则和业务约束。

```
forms/{form-name}/
├── FORM-{NNN}-{name}.md                 ← 表单规格
│   包含:
│   ├── fields           — 字段清单（名称、类型、必填、默认值、枚举）
│   ├── validations      — 验证规则（格式、长度、范围、正则）
│   ├── conditions       — 条件联动（A 字段变化时 B 字段的显示/必填规则）
│   ├── business-rules   — 业务约束（如密码强度、唯一性约束）
│   └── refs             — 关联 PRD FR 和 MODULE BH
│
├── schema.yaml                          ← 表单数据结构（对应 DDD Aggregate）
│   包含: 字段类型、枚举值、约束定义
│
└── test-cases/                          ← 表单级测试用例
    └── TC-FORM-{NNN}-{name}.md          ← 单条测试用例（refs: PRD FR / MODULE BH）
```

### 表单与上下层的关系

```
PRD 功能点 (FR-X.X) ──拆解──→ FORM 规格（字段级细化）
MODULE 行为规格 (BH-XX) ──对应──→ FORM 提交/验证行为
TASK 实现边界 ──精确到──→ 表单组件
```

---

## 八、文档命名规范速查

### 基线文档（原地更新）

命名格式：`{TYPE}-{NNN}-{short-name}.md`

| 类型 | 示例 | 归属层 |
|------|------|--------|
| PRD | `PRD-001-user-login.md` | 应用层 |
| SDD | `SDD-001-auth-service.md` | 应用层 |
| MODULE | `MODULE-001-auth-api.md` | 应用层 |
| FORM | `FORM-001-login-form.md` | 特性层 |
| JOURNEY | `JOURNEY-001-new-user-onboard.md` | 各层 |
| SCENARIO | `SCENARIO-001-peak-traffic.md` | 产品线/领域 |
| GUIDE | `GUIDE-001-getting-started.md` | 产品线 |

### 过程文档 — 交付类（按版本归档）

命名格式：`{TYPE}-{VERSION}-{NNN}-{short-name}.md`

| 类型 | 示例 | 归属层 |
|------|------|--------|
| PLAN | `PLAN-v1.0-001-mvp-sprint.md` | 应用层 |
| TASK | `TASK-v1.0-001-01-login-api.md` | 应用层 |
| TR | `TR-v1.0-001-regression.md` | 领域层 |
| RELEASE | `RELEASE-v1.0.0.md` | 应用层 |

### 过程文档 — 研究类（按季度归档）

命名格式：`{TYPE}-{YYYYQN}-{NNN}-{short-name}.md`

| 类型 | 示例 | 归属层 |
|------|------|--------|
| BENCHMARK | `BENCHMARK-2026Q2-001-competitor-x.md` | 产品线 |
| GAP | `GAP-2026Q2-001-sso-feature.md` | 产品线 |
| MARKET | `MARKET-2026Q2-001-industry-trend.md` | 产品线 |
| CUSTOMER | `CUSTOMER-2026Q2-001-enterprise-needs.md` | 产品线 |

---

## 九、各层文档类型总览对照表

| 文档类型 | 平台层 | 产品线层 | 领域层 | 应用层 | 特性层 | 表单层 |
|---------|:------:|:------:|:------:|:------:|:------:|:------:|
| Schema / Template | ✅ | — | — | — | — | — |
| Quality Gate | ✅ | — | — | — | — | — |
| Convention | ✅ | — | — | — | — | — |
| 战略 PRD (SPRD) | — | ✅ | — | — | — | — |
| GLOSSARY | — | ✅ | ✅ | — | — | — |
| context-map | — | ✅ | ✅ | — | — | — |
| shared-events | — | ✅ | ✅ | — | — | — |
| data-model | — | ✅ | ✅ | — | — | — |
| SCENARIO | — | ✅ | ✅ | — | — | — |
| JOURNEY | — | ✅ | ✅ | ✅ | — | — |
| GUIDE / FAQ / TS / RN | — | ✅ | — | — | — | — |
| BENCHMARK / MARKET / CUSTOMER | — | ✅ | — | — | — | — |
| TC / TP / TR | — | — | ✅ | — | — | — |
| PRD | — | — | — | ✅ | — | — |
| SDD | — | — | — | ✅ | — | — |
| MODULE + OpenAPI | — | — | — | ✅ | ✅(镜像) | — |
| PLAN | — | — | — | ✅ | ✅(镜像) | — |
| TASK | — | — | — | ✅ | ✅(镜像) | — |
| RELEASE | — | — | — | ✅ | — | — |
| Runbook | — | — | — | ✅ | — | — |
| 特性 README | — | — | — | — | ✅ | — |
| FORM 规格 | — | — | — | — | — | ✅ |
| schema.yaml | — | — | — | — | — | ✅ |
| 表单测试用例 | — | — | — | — | — | ✅ |
| VIEWS.yaml | — | ✅ | ✅ | ✅ | — | — |
| _index.yaml | — | ✅ | ✅ | ✅ | — | — |
| registry/ | — | ✅ | ✅ | — | — | — |

---

## 十、Agent 知识规约集成

产品初始化时，系统会自动在产品工作区生成三层知识规约文件，确保所有 Agent 按照统一规范放置文档产出物。

### 10.1 三层规约结构

```
层级 1: AGENTS.md（产品根目录）
  ├── 目录结构总览
  ├── 角色-目录所有权映射（RACI）
  ├── 文档链路约束（PRD → SDD → MODULE → PLAN → TASK → Code）
  ├── 命名规范（基线/交付/研究三类）
  └── 台账规则

层级 2: .opencode/agents/{brain}.md（增强 Agent 定义）
  ├── 原有 Agent 元信息（id/name/emoji/skills）
  ├── 知识产出规则（CRITICAL 标记）
  ├── 输出目录映射表（文档类型 → 路径 → 命名格式）
  └── 生成后检查清单

层级 3: .opencode/skills/knowledge-conventions/SKILL.md
  ├── 六层路径速查表
  ├── 基线文档放置表（原地更新类）
  ├── 过程文档 — 交付类（按版本归档）
  ├── 过程文档 — 研究类（按季度归档）
  ├── 文档链路约束
  ├── 台账 _index.yaml 结构示例
  └── knowledge/ lifecycle 管理
```

### 10.2 自动生成的 6 个文件

| 文件路径 | 作用 | 消费者 |
|---------|------|--------|
| `AGENTS.md` | 全局规约索引，所有 Agent 通用 | 所有 Agent |
| `.opencode/agents/product-brain.md` | 产品 Agent 增强定义 + 输出目录表 | product-brain |
| `.opencode/agents/eng-brain.md` | 工程 Agent 增强定义 + 输出目录表 | eng-brain |
| `.opencode/agents/growth-brain.md` | 增长 Agent 增强定义 + 输出目录表 | growth-brain |
| `.opencode/agents/ops-brain.md` | 运营 Agent 增强定义 + 输出目录表 | ops-brain |
| `.opencode/skills/knowledge-conventions/SKILL.md` | 知识管理 Skill，Agent 生成文档前必须调用 | 所有 Agent |

### 10.3 代码集成

| 维度 | 说明 |
|------|------|
| 触发入口 | `buildTeamRootConfig()` |
| 路径前缀 | `apps/{app}/`（仓库内相对路径） |
| 目录树展示 | Team 多仓库六层结构树 |
| PathCtx.mode | `'team'` |
| 领域层 | 独立生成 `{domain}/` 目录 |

通过 `buildKnowledgeAgentFiles(ctx: PathCtx)` 统一生成，Team 模式完整生成六层目录结构。

---

## 十一、目录文档关系图谱（dir-graph.yaml）

产品初始化时，系统会在 `.rayai/dir-graph.yaml` 自动生成一份结构化的目录文档关系图谱。该图谱是 **Agent 差异化解析目录结构的机器可读索引**，与 AGENTS.md（面向人类）互补。

### 11.1 定位与用途

Agent 通过读取 `dir-graph.yaml` 可以：

| 能力 | 依赖的图谱字段 |
|------|---------------|
| 快速定位某类文档在哪个目录 | `doc-types.{TYPE}.locations` |
| 理解文档间的上下游依赖链 | `doc-chain` |
| 识别各 Agent 的产出目录和职责边界 | `agents.{brain}.outputs` |
| 根据 Solo/Team 模式差异化解析 | `mode` + `layers` |
| 解析实际目录名（无需猜测） | `path-vars` |

### 11.2 Team 模式完整 Schema

```yaml
# .rayai/dir-graph.yaml
version: "1.0"
mode: team
generated-at: "2026-04-15T00:00:00Z"

# ── 路径变量（Agent 解析时替换为实际值） ──
path-vars:
  pl: "{productCode}-pl"             # 产品线目录，如 myproduct-pl
  domains:                            # Team 模式支持多个 Domain
    - "{domainCode}"                  # 如 auth-domain
  apps:                               # Team 模式支持多个 App
    - "apps/{appCode}"                # 如 apps/auth-service

# ── 知识层级定义（Team 六层） ──
layers:
  - id: platform
    name: 平台层
    path: governance-standards/
    description: 全公司共享规范（Schema、模板、质量门禁）
    contains: [schema, template, quality-gate, convention, capability]
  - id: product-line
    name: 产品线层
    path: "{pl}/"
    description: 跨领域知识、战略PRD、帮助中心
    contains: [strategy-prd, glossary, context-map, shared-events, data-model,
              integration-patterns, scenario, journey, guide, faq,
              benchmark, market, customer]
  - id: domain
    name: 领域层
    paths:                            # Team 模式有多个独立仓库
      - "{domainCode}/"
    description: 域内聚合知识（词汇、事件、上下文地图、测试用例）
    contains: [glossary, context-map, shared-events, domain-data-model, tc, tp, tr]
  - id: application
    name: 应用层
    paths:                            # Team 模式有多个独立仓库
      - "apps/{appCode}/"
    description: 应用自治知识（PRD/SDD/MODULE/PLAN/TASK/Runbook）
    contains: [prd, sdd, module, openapi, plan, task, release, runbook, journey, feature]
  - id: feature
    name: 特性层
    path: "{app}/docs/features/{feature}/"
    description: 以特性为轴聚合文档，跨职能协作单元
    contains: [feature-readme, spec, plan, task, form]
  - id: form
    name: 表单层（DDD 最小颗粒度）
    path: "{app}/docs/features/{feature}/forms/{form}/"
    description: 对应 DDD 聚合根，承载字段定义、验证规则和业务约束
    contains: [form-spec, schema, tc-form]

# ── 文档类型注册表 ──
doc-types:
  # --- 基线文档（原地更新） ---
  PRD:
    name: 产品需求文档
    category: baseline
    naming: "PRD-{NNN}-{name}.md"
    locations: ["{app}/docs/product/prd/"]
    owner: product-brain
    upstream: []
    downstream: [SDD]
    index: _index.yaml
  SDD:
    name: 系统设计文档
    category: baseline
    naming: "SDD-{NNN}-{name}.md"
    locations: ["{app}/docs/product/architecture/"]
    owner: eng-brain
    upstream: [PRD]
    downstream: [MODULE]
    index: _index.yaml
  MODULE:
    name: 接口规格文档
    category: baseline
    naming: "MODULE-{NNN}-{name}.md"
    locations: ["{app}/docs/product/contracts/"]
    owner: eng-brain
    upstream: [SDD]
    downstream: [PLAN]
    index: _index.yaml
  OpenAPI:
    name: OpenAPI 接口定义
    category: baseline
    naming: "{service}-{ver}.yaml"
    locations: ["{app}/docs/product/contracts/openapi/"]
    owner: eng-brain
    upstream: [MODULE]
    downstream: []
  FORM:
    name: 表单规格（DDD 聚合根）
    category: baseline
    naming: "FORM-{NNN}-{name}.md"
    locations: ["{app}/docs/features/{feature}/forms/{form}/"]
    owner: eng-brain
    upstream: [PRD, MODULE]
    downstream: []
  form-schema:
    name: 表单数据结构
    category: baseline
    naming: "schema.yaml"
    locations: ["{app}/docs/features/{feature}/forms/{form}/"]
    owner: eng-brain
    upstream: [FORM]
    downstream: []
  TC-FORM:
    name: 表单测试用例
    category: baseline
    naming: "TC-FORM-{NNN}-{name}.md"
    locations: ["{app}/docs/features/{feature}/forms/{form}/test-cases/"]
    owner: eng-brain
    upstream: [FORM]
    downstream: []
  JOURNEY:
    name: 用户旅程
    category: baseline
    naming: "JOURNEY-{NNN}-{name}.md"
    locations: ["{app}/docs/journeys/", "{pl}/docs/journeys/", "{domain}/docs/journeys/"]
    owner: product-brain
  SCENARIO:
    name: 业务场景
    category: baseline
    naming: "SCENARIO-{NNN}-{name}.md"
    locations: ["{pl}/knowledge/scenarios/", "{domain}/knowledge/scenarios/"]
    owner: product-brain
  GUIDE:
    name: 操作指南
    category: baseline
    naming: "GUIDE-{NNN}-{name}.md"
    locations: ["{pl}/docs/help-center/guides/"]
    owner: product-brain
  FAQ:
    name: 常见问题
    category: baseline
    naming: "FAQ-{topic}.md"
    locations: ["{pl}/docs/help-center/faq/"]
    owner: growth-brain
  Runbook:
    name: 运维手册
    category: baseline
    naming: "{type}.md"
    locations: ["{app}/docs/ops/runbook/"]
    owner: ops-brain
  GLOSSARY:
    name: 统一语言词汇表
    category: baseline
    naming: "GLOSSARY.md"
    locations: ["{pl}/knowledge/", "{domain}/knowledge/"]
    owner: eng-brain
  # --- 过程文档（交付类，按版本归档） ---
  PLAN:
    name: 迭代计划
    category: process-delivery
    naming: "PLAN-{VER}-{NNN}-{name}.md"
    locations: ["{app}/docs/delivery/plan/"]
    owner: eng-brain
    upstream: [MODULE]
    downstream: [TASK]
    index: _index.yaml
  TASK:
    name: 开发任务卡
    category: process-delivery
    naming: "TASK-{VER}-{NNN}-{NN}-{name}.md"
    locations: ["{app}/docs/delivery/task/"]
    owner: eng-brain
    upstream: [PLAN]
    downstream: []
    index: _index.yaml
  RELEASE:
    name: 发版计划
    category: process-delivery
    naming: "RELEASE-{version}.md"
    locations: ["{app}/docs/delivery/releases/"]
    owner: ops-brain
    index: _index.yaml
  TR:
    name: 测试报告
    category: process-delivery
    naming: "TR-{VER}-{NNN}-{name}.md"
    locations: ["{domain}/docs/qa/reports/"]
    owner: ops-brain
    index: _index.yaml
  TC:
    name: 测试用例
    category: process-delivery
    naming: "TC-{NNN}-{name}.md"
    locations: ["{domain}/docs/qa/test-cases/"]
    owner: eng-brain
    index: _index.yaml
  # --- 过程文档（研究类，按季度归档） ---
  BENCHMARK:
    name: 竞品分析报告
    category: process-research
    naming: "BENCHMARK-{YYYYQN}-{NNN}-{name}.md"
    locations: ["{pl}/strategy/research/"]
    owner: growth-brain
    index: _index.yaml
  MARKET:
    name: 市场分析报告
    category: process-research
    naming: "MARKET-{YYYYQN}-{NNN}-{name}.md"
    locations: ["{pl}/strategy/research/"]
    owner: growth-brain
    index: _index.yaml
  CUSTOMER:
    name: 客户洞察报告
    category: process-research
    naming: "CUSTOMER-{YYYYQN}-{NNN}-{name}.md"
    locations: ["{pl}/strategy/research/"]
    owner: growth-brain
    index: _index.yaml
  GAP:
    name: 差距分析报告
    category: process-research
    naming: "GAP-{YYYYQN}-{NNN}-{name}.md"
    locations: ["{pl}/strategy/gap-analysis/"]
    owner: growth-brain

# ── 文档链路（上游 approved 才能创建下游） ──
doc-chain:
  - { from: PRD, to: SDD, gate: "PRD.status == approved" }
  - { from: SDD, to: MODULE, gate: "SDD.status == approved" }
  - { from: MODULE, to: PLAN, gate: "MODULE.status == approved" }
  - { from: PLAN, to: TASK, gate: "PLAN.status == approved" }
  - { from: PRD, to: FORM, gate: "PRD.status == approved" }        # Team 特有
  - { from: MODULE, to: FORM, gate: "MODULE.status == approved" }  # Team 特有

# ── Agent 产出映射 ──
agents:
  product-brain:
    name: AI产品搭档
    outputs:
      - { type: PRD, path: "{app}/docs/product/prd/" }
      - { type: strategy-prd, path: "{pl}/strategy/prd/" }
      - { type: JOURNEY, path: "{app}/docs/journeys/" }
      - { type: SCENARIO, path: "{pl}/knowledge/scenarios/" }
      - { type: GUIDE, path: "{pl}/docs/help-center/guides/" }
      - { type: Roadmap, path: "{app}/docs/delivery/roadmap.md" }
  eng-brain:
    name: AI工程搭档
    outputs:
      - { type: SDD, path: "{app}/docs/product/architecture/" }
      - { type: MODULE, path: "{app}/docs/product/contracts/" }
      - { type: OpenAPI, path: "{app}/docs/product/contracts/openapi/" }
      - { type: FORM, path: "{app}/docs/features/{feat}/forms/{form}/" }
      - { type: form-schema, path: "{app}/docs/features/{feat}/forms/{form}/" }
      - { type: PLAN, path: "{app}/docs/delivery/plan/" }
      - { type: TASK, path: "{app}/docs/delivery/task/" }
      - { type: TC, path: "{domain}/docs/qa/test-cases/" }
      - { type: Helm, path: "{app}/helm/values/" }
  growth-brain:
    name: AI增长搭档
    outputs:
      - { type: BENCHMARK, path: "{pl}/strategy/research/" }
      - { type: MARKET, path: "{pl}/strategy/research/" }
      - { type: CUSTOMER, path: "{pl}/strategy/research/" }
      - { type: GUIDE, path: "{pl}/docs/help-center/guides/" }
      - { type: FAQ, path: "{pl}/docs/help-center/faq/" }
      - { type: RN, path: "{pl}/docs/help-center/release-notes/" }
      - { type: GAP, path: "{pl}/strategy/gap-analysis/" }
  ops-brain:
    name: AI运营搭档
    outputs:
      - { type: Runbook, path: "{app}/docs/ops/runbook/" }
      - { type: RELEASE, path: "{app}/docs/delivery/releases/" }
      - { type: TR, path: "{domain}/docs/qa/reports/" }
      - { type: risk-register, path: "{app}/docs/delivery/risk-register.md" }
```

### 11.3 Solo vs Team 图谱差异对照

| 维度 | Solo 模式 | Team 模式 |
|------|---------|----------|
| `mode` | `solo` | `team` |
| `layers` 数量 | 5（平台 + 产品线 + 领域 + 应用 + 特性） | 6（多出表单层） |
| `path-vars.domain` | 单个字符串 | `domains` 数组（多仓库） |
| `path-vars.app` | 单个字符串 | `apps` 数组（多仓库） |
| 表单层文档类型 | 无 FORM/form-schema/TC-FORM | 包含 FORM/form-schema/TC-FORM |
| `doc-chain` | 4 条主链路 | 6 条（多 PRD→FORM、MODULE→FORM） |
| Agent 产出 | 无 FORM 相关 | eng-brain 含 FORM + form-schema |
| JOURNEY 位置 | 2 个 locations | 3 个 locations（多 domain） |
| SCENARIO 位置 | 1 个 location | 2 个 locations（多 domain） |

### 11.4 与现有规约体系的关系

| 文件 | 格式 | 面向 | 内容侧重 |
|------|------|------|----------|
| `AGENTS.md` | Markdown | 人类 + Agent | 角色-目录所有权、命名规范、台账规则 |
| `.opencode/agents/{brain}.md` | Markdown | 单个 Agent | 该 Agent 的输出目录表和检查清单 |
| `.opencode/skills/knowledge-conventions/SKILL.md` | Markdown | 所有 Agent | 文档放置路径和命名格式的详细速查 |
| **`.rayai/dir-graph.yaml`** | **YAML** | **Agent 程序化解析** | **结构化的层级、文档类型、链路、产出映射** |

三层 Markdown 规约提供人类可读的规范描述，`dir-graph.yaml` 提供机器可读的结构化索引。两者信息同源但形态不同，共同确保 Agent 既能理解规范语义，也能程序化定位文档。

### 11.5 代码集成

| 维度 | 说明 |
|------|------|
| 生成函数 | `buildTeamDirGraph(ctx: PathCtx, domainSlugs: string[], appSlugs: string[])` |
| 触发入口 | `buildTeamRootConfig()` 中 `.rayai/config.yaml` 之后 |
| 输出路径 | `.rayai/dir-graph.yaml` |
| 路径变量 | 使用实际目录名，支持多 domain/app 数组 |
| Team 差异 | 六层 layers、含 FORM/form-schema/TC-FORM、多仓库路径 |

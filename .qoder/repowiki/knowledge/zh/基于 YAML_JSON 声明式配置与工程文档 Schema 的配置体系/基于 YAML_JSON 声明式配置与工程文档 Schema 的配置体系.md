---
kind: configuration_system
name: 基于 YAML/JSON 声明式配置与工程文档 Schema 的配置体系
category: configuration_system
scope:
    - '**'
source_files:
    - dir-graph.yaml
    - agent-skill-matrix.yml
    - AGENTS.md
    - agents/_index.yml
    - skills/_index.yml
    - pipeline-templates/_index.yml
    - skills/shared/engineering-docs/schemas/prd.schema.json
    - skills/shared/engineering-docs/schemas/sdd.schema.json
    - skills/shared/engineering-docs/schemas/task.schema.json
    - skills/shared/engineering-docs/conventions/naming.yaml
    - skills/shared/engineering-docs/conventions/doc-chain.yaml
    - skills/shared/engineering-docs/scripts/src/registry.ts
    - skills/shared/engineering-docs/scripts/src/generators/base.ts
    - skills/shared/engineering-docs/scripts/src/validators/index-sync.ts
    - pipeline-templates/architecture-design.pipeline.json
    - pipeline-templates/code-implementation.pipeline.json
    - pipeline-templates/feature-writeback.pipeline.json
---

本仓库未实现传统意义上的运行时配置系统（无 .env、application.properties、config/ 目录或集中式加载器），而是采用「以文件为配置」的声明式治理模式：通过一组 YAML/JSON 事实源 + JSON Schema 校验，把 Agent 能力、Skill 清单、Pipeline 模板、工程文档规范等全部作为可版本化、可 diff 的「配置」来管理。

1. 使用的框架与工具
- 纯声明式 YAML/JSON 文件作为配置载体，由人类编辑、Git 版本控制；
- TypeScript CLI（skills/shared/engineering-docs/scripts）提供生成、校验、对账能力，依赖 jsonschema / yaml 解析库；
- 工程文档 frontmatter 使用 JSON Schema（schemas/*.schema.json）做结构校验；
- Pipeline 模板以 JSON 描述节点、输入、评审与审批约束，作为 orchestrator 的可执行配置。

2. 核心配置文件与包
- 顶层事实源
  - dir-graph.yaml：tools 包目录图与目标 workspace 仓库拓扑的事实源
  - agent-skill-matrix.yml：Agent/Skill 权限矩阵机器可读事实源
  - AGENTS.md：行为约束入口，声明各入口文件的权威关系
- agents/_index.yml：Active Agent 清单
- skills/_index.yml：Active Skill 清单
- pipeline-templates/_index.yml：Active Pipeline 清单
- skills/shared/engineering-docs/schemas/*.schema.json：PRD/SDD/TASK/MODULE/PLAN/RELEASE/FORM/OpenAPI 等文档结构的 JSON Schema
- skills/shared/engineering-docs/conventions/naming.yaml、doc-chain.yaml：命名约定与文档链契约
- skills/shared/engineering-docs/templates/*.yaml：表单 schema 模板
- skills/shared/engineering-docs/scripts/src/registry.ts：读取 naming.yaml/doc-chain.yaml，注册文档类型与模板映射
- skills/shared/engineering-docs/scripts/src/generators/base.ts：根据 schema 与模板生成文档及 _index.yaml 台账
- skills/shared/engineering-docs/scripts/src/validators/index-sync.ts：校验并重建 _index.yaml 台账
- pipeline-templates/*.pipeline.json：架构设计、代码实现、竞品雷达、特性回写、市场洞察→规划等 Pipeline 模板

3. 架构与约定
- 单一事实源原则：AGENTS.md 明确 dir-graph.yaml、agent-skill-matrix.yml、README.md 的职责边界，禁止在多个入口维护冲突规则；
- 索引即配置：每个 domain 目录下的 _index.yml 是「active 清单」，agents/skills/pipeline-templates 三者通过该清单互相引用；
- 模板驱动生成：engineering-docs scripts 以 schemas + templates + conventions 为输入，生成具体文档与 _index.yaml，保证一致性；
- Pipeline 作为可执行配置：*.pipeline.json 仅声明节点、输入、评审条件与审批提示，不包含业务逻辑，由运行时按模板实例化；
- 路径解耦：所有仓库、trunk、worktree 路径必须从 dir-graph.yaml#repositories 动态解析，禁止硬编码绝对路径或固定双仓假设。

4. 开发者应遵循的规则
- 新增 active Skill 时，必须在 agent-skill-matrix.yml 中为其指定且只指定一个 owns owner；
- pipeline-templates/*.pipeline.json 只能引用 skills/_index.yml 中 active 的 Skill；
- agents/_index.yml 中的 references 必须指向真实存在的 Skill 或明确的目标 workspace 资料入口；
- 新增工程文档类型需同时更新 naming.yaml、doc-chain.yaml、对应 schema 与 template，并通过 engineering-docs scripts 验证；
- 不得手工编辑目标 workspace 的 _backlog.yml 等状态文件，状态推进必须通过对应 Skill 或 Pipeline 节点完成；
- 涉及人工确认的节点，后续必须有明确的 approve-* 或写入型 Skill 记录结论。
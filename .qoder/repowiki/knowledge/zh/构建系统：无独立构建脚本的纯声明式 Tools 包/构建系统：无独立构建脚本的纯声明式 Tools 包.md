---
kind: build_system
name: 构建系统：无独立构建脚本的纯声明式 Tools 包
category: build_system
scope:
    - '**'
---

本仓库是一个「AI First 研发协同平台 Phase0 Tools 包」，其本质是**纯声明式的 Agent/Skill/Pipeline 资产集合**，而非可编译、打包或部署的软件制品。经对根目录与子模块扫描，未发现任何构建系统相关工件：无 Makefile、Dockerfile、CI 流水线配置（.github/workflows）、语言级依赖清单（package.json、go.mod、Cargo.toml、pyproject.toml 等）以及版本/发布脚本。

仓库内容完全由 YAML 台账（agent-skill-matrix.yml、dir-graph.yaml、pipeline-templates/_index.yml）与 Markdown SKILL.md 契约文件构成，通过运行时挂载到目标 workspace 后被 orchestrator 动态消费。skills/shared/engineering-docs/scripts 目录下虽有 package.json、tsconfig.json、vitest.config.ts 等 TypeScript 工程文件，但它们属于**工程文档规范库中的示例工具**，并非本仓库自身的构建入口；该子模块在仓库树中仅以路径占位形式出现，实际未包含源码与 lock 文件。

因此，本仓库不存在跨模块统一的 build_system——它没有编译、测试、打包、容器化或 CI 流程，也不定义版本号策略或交叉编译规则。所有“构建”行为均由外部 orchestrator 在加载 tools 包时完成。
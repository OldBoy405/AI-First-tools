---
kind: dependency_management
name: 工程文档脚本的 pnpm 依赖管理
category: dependency_management
scope:
    - '**'
source_files:
    - skills/shared/engineering-docs/scripts/package.json
    - skills/shared/engineering-docs/scripts/pnpm-lock.yaml
    - skills/shared/engineering-docs/scripts/.gitignore
---

本仓库为 AI First 研发协同平台的 Tools 包，主体由 YAML/Markdown/Pipeline JSON 等声明式文件构成，根目录不存在 Go、Python、Ruby、Rust 或 Java 等语言的依赖清单。唯一的代码级依赖管理位于 `skills/shared/engineering-docs/scripts` 子模块，采用 Node.js + TypeScript 技术栈，通过 pnpm 进行依赖锁定与安装。

- 包清单：`package.json` 将包名声明为 `@openwork/engineering-docs-mcp`，`private: false`，并暴露两个 CLI 入口（`engineering-docs-mcp`、`engdocs`）；运行时依赖包含 `@modelcontextprotocol/sdk`、`ajv`、`commander`、`ejs`、`gray-matter`、`yaml`，开发依赖包含 `typescript`、`tsx`、`vitest`、`@types/node`、`@types/ejs`，并通过 `engines.node >= 18` 约束运行环境。
- 版本锁定：使用 pnpm v9 lockfile（`pnpm-lock.yaml`），以 `importers` 形式记录精确解析后的版本号与 integrity hash，确保多机器构建一致。
- 忽略策略：`.gitignore` 仅排除 `node_modules/`、`dist/`、`.tmp-test/`，未显式配置 `.npmrc` / `.pnpmfile.cjs` / `.yarnrc`，表明默认使用公共 npm registry，无私有源或 GOPRIVATE 类代理配置。
- 工作区模式：未发现 `pnpm-workspace.yaml` 或 monorepo workspace 配置，该 scripts 目录作为独立单包存在。
- 其他语言：仓库根及 agents/skills/pipeline-templates 下均无 `go.mod`、`requirements.txt`、`Gemfile`、`Cargo.toml`、`pyproject.toml`、`setup.py`、`Pipfile`、`poetry.lock`、`vendor/` 等依赖声明或 vendoring 痕迹。

开发者约定
- 新增/升级依赖必须同步更新 `package.json` 与 `pnpm-lock.yaml`，禁止提交未锁定的 `node_modules`。
- 保持 `engines.node >= 18` 与 CI 环境一致，避免平台二进制差异。
- 由于包非 private，发布到公共 npm registry 前需确认许可证与敏感信息合规。
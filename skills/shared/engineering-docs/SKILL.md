---
name: engineering-docs
description: "被动 skill — 按模板生成 PRD/SDD/MODULE/PLAN/TASK/RELEASE/FORM 的 frontmatter 与正文骨架；Agent 按步骤调用 owClient.writeFile 落盘，不依赖任何 MCP server。"
version: 0.4.0
consumers: any
references:
  - standards/ENGINEERING-STRUCTURE-TEAM.md
  - schemas/
  - templates/
---

# engineering-docs

> **v0.4.0 变更**：从 MCP server 模式降级为常规 Skill。所有生成逻辑由调用方 Agent 按步骤执行，不再依赖 `@openwork/engineering-docs-mcp` 或 CLI 脚本。

根据调用方提供的意图与内容，在工作区正确目录下创建对应类型的工程文档，并按内置模板完成 frontmatter 与正文骨架的填充。

## 触发条件

- 用户或 agent 明确要创建某类工程文档（PRD / SDD / MODULE / PLAN / TASK / RELEASE / FORM）时被动触发
- 不主动发起，不拦截其他操作
- **禁止手写 frontmatter**：任何写入工程文档 frontmatter 的场景，必须走本 skill 步骤

## 执行流程

### 步骤 1 — 确定输出目录

读取工作区目录图，查找优先级：

1. `<workspace-root>/dir-graph.yaml`
2. `<workspace-root>/.rayai/dir-graph.yaml`

在文件中按文档类型（`type` 字段）匹配对应的目录路径。

> 若 `dir-graph.yaml` 不存在，停止执行并提示用户先在工作区定义目录结构文件。

### 步骤 2 — 内容完整性检查

核对"各类型必填内容"表（见下）。若调用方提供的内容不足，**先停止**，逐项列出缺失字段，等待用户补齐后再继续。

### 步骤 3 — 读取模板

从本 skill 目录读取对应模板：

| 类型 | 模板文件 |
|------|---------|
| PRD | `templates/PRD-template.md` |
| SDD | `templates/SDD-template.md` |
| MODULE | `templates/MODULE-template.md` |
| PLAN | `templates/PLAN-template.md` |
| TASK | `templates/TASK-template.md` |
| RELEASE | `templates/RELEASE-template.md` |
| FORM | `templates/FORM-template.md`（含 `templates/FORM-schema-template.yaml`） |
| OpenAPI | `templates/OpenAPI-template.yaml` |

模板中使用 `<%= var %>` 占位。

### 步骤 4 — 渲染 frontmatter 与正文

对模板中每个 `<%= var %>` 占位做替换：

| 占位 | 取值 |
|------|------|
| `id` | 由调用方给定（如 `FR-0001`、`PLAN-2026-v0.1`）；若缺失，按 `<type>-<name>-<序号>` 规则生成 |
| `name` | 调用方提供的 slug |
| `title` | 调用方提供的中文标题 |
| `owner` | 调用方提供；缺失时用当前 worktree owner（见 `change-requests/_backlog.yml`） |
| `today` | **北京时间** 当日日期，格式 `YYYY-MM-DDTHH:mm:ss+08:00`（见 `tools/skills/requirement/*/SKILL.md` 时间戳规范） |
| `version` | 调用方提供；PLAN / TASK / RELEASE 必填 |

渲染完成后按 `schemas/<type>.schema.json` 自校验 frontmatter（必需字段齐全、类型正确；例如 PRD 使用 `schemas/prd.schema.json`）。校验不通过时停在本步骤，输出具体错误，等待修正。

### 步骤 5 — 调用 owClient 落盘

目标路径 = 步骤 1 得到的目录 + 文件名（`<type>-<name>.md` / `.yaml`）。

```ts
await owClient.writeFile(workspaceId, targetPath, renderedContent);
```

写入失败（权限、路径冲突等）立即停止并返回结构化错误。

### 步骤 6 — 更新 `_index.yaml`

在目标目录的 `_index.yaml` 中追加条目（若文件不存在则新建）：

```yaml
items:
  - id: <id>
    name: <name>
    title: <title>
    path: <type>-<name>.md
    status: draft
    created: <today>
```

如同目录下已存在同 `id`，则改为更新该条目的 `updated` 字段。

### 步骤 7 — 输出摘要

```
✅ 已生成 {TYPE} 文档
   id    : <id>
   path  : <workspace>/<path>
   title : <title>
```

## 各类型必填内容

| 类型 | 调用方必须提供 |
|------|--------------|
| PRD | `name`（slug）、`title`、feature 目录名 |
| SDD | `name`、`title`、上游 PRD id |
| MODULE | `name`、`title`、上游 SDD id |
| PLAN | `name`、`title`、`version`（vX.Y）、`sprint`、上游 MODULE id |
| TASK | `name`、`title`、`version`、`task-of`（PLAN id） |
| RELEASE | `version` |
| FORM | `name`、`title`、上游 PRD 或 MODULE id |
| OpenAPI | `name`、`title`、上游 SDD id |

## 校验参考

- `schemas/` 下按类型提供 JSON Schema / YAML schema；步骤 4 自校验基于此
- `conventions/` 记录命名、id 规则、版本格式约定
- `standards/ENGINEERING-STRUCTURE-TEAM.md` 为工程结构权威说明

## 弃用历史

- v0.3.0 及以前：提供 `@openwork/engineering-docs-mcp` MCP server + CLI `engdocs_gen`
- v0.4.0：**去 MCP 化**，仅保留 SKILL.md 步骤 + templates + schemas；`scripts/` 目录保留但不再被 Skill 引用，仅供历史参考

# tools/pipeline-templates

本目录存放可复用的 AI First 研发协同平台 Pipeline 模板，是默认模板的**权威来源**。

`.rayai/pipelines/` 存放当前 workspace 已激活的 Pipeline 实例。模板在 workspace mount
时通过 `seedAndSyncDefaults()` 首次复制到 `.rayai/pipelines/`；已存在的实例不会被覆盖，
后续模板更新需要用户显式重新导入或同步。

## 工作机制

`tools/` 目录以独立形式部署到用户的 workspace 根目录下。当 workspace mount 时，平台运行时通过 `loadWorkspaceTemplates()` 读取本目录的 `_index.yml`，动态加载所有 `status: active` 的模板，并通过 `seedAndSyncDefaults()` 种子到 `.rayai/pipelines/`（已存在的激活实例不会被覆盖）。

无需手动同步任何代码文件——修改或新增模板后，重新 mount workspace 即可生效。

## 文件约定

| 文件 | 说明 |
|------|------|
| `_index.yml` | 台账，声明所有模板的 id、path、status |
| `*.pipeline.json` | Pipeline 定义，格式遵循系统侧 `PipelineDefinition` 类型 |

## 新增模板

1. 新建 `<your-template-name>.pipeline.json`，格式参考现有新四阶段模板（如 `requirement-authoring.pipeline.json`、`code-implementation.pipeline.json`）
2. 在 `_index.yml` 中追加一条记录（`status: active`，`path` 为相对 workspace 根目录的路径）
3. 使用稳定的非随机 `id`（如 `your-template-0000-000000000001`），确保重复 seed 幂等

## 现有模板

| 模板 | 触发命令 | 说明 |
|------|---------|------|
| `product-planning.pipeline.json` | `/planning` | 调研、竞品、现状分析与产品规划 |
| `requirement-authoring.pipeline.json` | `/requirement` | 注册 CR、编写 PRD、需求评审与需求审批 |
| `architecture-design.pipeline.json` | `/architecture` | 编写 SDD、技术评审与技术审批 |
| `code-implementation.pipeline.json` | `/coding` | 计划、任务、开发启动确认、代码实现、代码评审与代码审批 |
| `feature-writeback.pipeline.json` | `/writeback` | 合并分支、回写 PRD/SDD/TASK/traceability 并归档 CR |
| `resume-cr.pipeline.json` | `/resume` | 从远端 checkpoint 恢复在途 CR worktree |

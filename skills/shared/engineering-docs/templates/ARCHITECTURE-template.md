<%# ARCHITECTURE 模板 · 结构抄 rust-analyzer（鸟瞰/入口/代码地图/横切关注点），不变量写法抄 TigerBeetle（编号硬规则，违反即 bug）。
    写作三原则（matklad）：
    1. 只写变化慢的事实——不变量、边界、方向；不写会过期的细节（行号、函数签名、文件清单全集）。
    2. 指名重要文件/目录，但不链接行号（会漂移）；读者用 grep 找得到即可。
    3. 全文 ~100-150 行封顶。写不进去的说明它不重要；超了说明混进了 API 文档。
    实例化：填占位符，删除所有 <%# %> 注释，落盘到项目仓根目录 ARCHITECTURE.md。-%>
---
id: <%= projectId %>-architecture
type: ARCHITECTURE
title: <%= projectName %> 架构地图
status: living          # 常青文档：随架构级变更同步修订，不随普通 PR 更新
owner: <%= owner %>
created: <%= today %>
updated: <%= today %>
---

# ARCHITECTURE.md — <%= projectName %>

> 本文档是进入本仓库的心智地图：模块边界、依赖方向、硬不变量。
> 供人类新成员与 AI Agent 首读，也是技术设计评审（review-tech-design"架构合理性"维度）的权威判据。
> 只记录变化慢的事实；实现细节以代码为准。

## 1. 鸟瞰（Bird's Eye View）

<%# 一段话：这个系统解决什么问题、核心思路是什么。再加一行数据流。 -%>

<%= projectName %> 是 <%= oneLineProblemAndApproach %>。

核心数据流：`<%= inputSource %>` → <%= keyStages %> → `<%= outputSink %>`

## 2. 入口点（Entry Points）

<%# 新读者从哪几个文件开始读，每个一行。3-5 个足够。 -%>

| 想理解… | 从这里开始 |
|---|---|
| 启动与装配 | `<%= entryMain %>` |
| 核心领域逻辑 | `<%= entryDomain %>` |
| 对外接口/CLI | `<%= entryInterface %>` |

## 3. 代码地图（Code Map）

<%# 按目录逐条一句话说明"这里放什么、不放什么"。
    rust-analyzer 惯例：在最需要的目录条目后紧跟"**架构不变量**"标注。 -%>

### `<%= dirA %>/`

<%= dirAPurpose %>

**架构不变量**：<%= dirAInvariant %>

### `<%= dirB %>/`

<%= dirBPurpose %>

### `<%= dirC %>/`

<%= dirCPurpose %>

## 4. 分层与依赖方向

<%# 一张 ASCII 图 + 一句话规则。方向违规是最常见的架构腐化，必须显式。 -%>

```
<%= layerTop %>        # 允许依赖 ↓，禁止被 ↓ 依赖
   ↓
<%= layerMiddle %>
   ↓
<%= layerBottom %>     # 最底层：不 import 上层任何东西
```

规则：依赖只朝下。跨层捷径、循环依赖、下层反调上层，评审一律打回。

## 5. 硬不变量（Invariants）

<%# TigerBeetle 写法：编号、可判定、违反即 bug/blocker。
    每条必须满足：评审者能用 grep/测试/肉眼在 10 分钟内核查真伪。
    写不出核查方法的"不变量"是愿望，不是不变量，删掉。 -%>

违反下列任意一条 = bug（评审中 = blocker），无例外；确需破例先修订本文档。

1. **<%= invariant1Name %>**：<%= invariant1Rule %>（核查：<%= invariant1Check %>）
2. **<%= invariant2Name %>**：<%= invariant2Rule %>（核查：<%= invariant2Check %>）
3. **<%= invariant3Name %>**：<%= invariant3Rule %>（核查：<%= invariant3Check %>）

<%# 常见候选（按项目取舍，不要全抄）：
    - 单一写入路径：状态/账本/DB 只有一个写入口，其余只读
    - 依赖预算：零第三方依赖 / 新依赖需评审记录
    - 解析失败硬报错：跨行解析匹配不到必须 fail，禁止静默降级为空
    - 幂等：对外副作用操作可安全重试
    - 权威源唯一：同一事实只有一个权威存储，其余是投影 -%>

## 6. 刻意不做（Negative Space）

<%# 被否决的方案 + 否决理由 + 日期。这是防止"好心人"半年后把否决方案重新实现一遍的疫苗。 -%>

| 不做什么 | 为什么（否决记录） | 何时重新考虑 |
|---|---|---|
| <%= rejected1 %> | <%= rejected1Reason %> | <%= rejected1Revisit %> |
| <%= rejected2 %> | <%= rejected2Reason %> | <%= rejected2Revisit %> |

## 7. 横切关注点（Cross-Cutting Concerns）

<%# 每项 1-3 行：约定是什么、样板在哪个文件。 -%>

- **错误处理**：<%= errorConvention %>
- **测试**：<%= testConvention %>（运行方式：`<%= testCommand %>`）
- **可观测性**：<%= observabilityConvention %>
- **配置**：<%= configConvention %>

## 8. 本文档的维护规则

- 触发修订的变更：新增/删除顶层模块、改依赖方向、增删不变量、否决一个重大方案。
- 普通功能 PR **不需要**改本文档——若发现必须改，说明该 PR 是架构级变更，先过设计评审。
- 评审对照：技术设计评审的"架构合理性"维度逐条对照 §4/§5/§6 判定。

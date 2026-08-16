---
id: ai-first-tools-architecture
type: ARCHITECTURE
title: tools（AI First 方法论包）架构地图
status: living
owner: Ray
created: "2026-08-04T17:45:00+08:00"
updated: "2026-08-05T15:10:00+08:00"
---

# ARCHITECTURE.md — tools（AI First 方法论包）

> 本文档是进入本仓库的心智地图：模块边界、依赖方向、硬不变量。
> 供人类新成员与 AI Agent 首读，也是技术设计评审（review-tech-design"架构合理性"维度）的权威判据。
> 只记录变化慢的事实；实现细节以代码为准。

## 1. 鸟瞰（Bird's Eye View）

本包是 `multica-ai` 生态之外的独立方法论层：9 Agent / 59 Skill / 8 Pipeline，驱动使用方仓库（如 AI First Platform）的 CR（Change Request）全流程，配合 `crctl` 状态机 CLI 做状态与账本的单一权威写入。本包自身不含业务代码，只含**提示词合约（Skill）**、**流程编排（Pipeline）**与**一个可执行治理工具（crctl）**。

核心数据流：`CR 需求输入` → requirement-authoring → architecture-design → code-implementation → feature-writeback（各 Pipeline 依次驱动，状态权威写入 `{workspace}/change-requests/{CR-ID}/cr.md`）→ `specs/ + delivery/` 累积基线

## 2. 入口点（Entry Points）

| 想理解… | 从这里开始 |
|---|---|
| 整体流程与流程图 | `README.md` |
| CR 状态机与门禁唯一事实源 | `dir-graph.yaml`（`change-request-track.state_machine`）+ `skills/shared/crctl/gates.json` |
| 状态/账本读写的唯一执行器 | `skills/shared/crctl/scripts/crctl.mjs` |
| Agent/Skill 权限矩阵 | `agent-skill-matrix.yml` |
| 某条 CR 阶段该做什么 | `skills/{阶段组}/{skill-name}/SKILL.md` |

## 3. 代码地图（Code Map）

### `skills/{requirement,develop,writeback,cr,review,spec,sync,planning,competitive}/`

按 CR 生命周期阶段分组的 Skill 提示词合约（每个子目录一个 `SKILL.md`）：需求撰写/评审、技术设计撰写/评审、回写、CR 台账操作、代码评审、规格、同步、规划、竞品雷达。

**架构不变量**：Skill 文档只描述"读什么、写什么、调用哪个 crctl 子命令、status 前后置条件"，**不得**在 Skill 文档里描述账本文件的手工编辑步骤（历史教训见 §5 不变量 1、2）。

### `skills/shared/crctl/scripts/crctl.mjs`

状态机与账本的唯一可执行治理入口。CLI/门禁留在 `crctl.mjs`；YAML 子集、repository/workspace 事务与持久化原语分别下沉到同级 `lib/yaml-subset.mjs`、`lib/workspace-transactions.mjs`、`lib/durable-tx.mjs`。lib 不反向依赖 CLI，也不形成第二命令入口。

`register`、`merge`、`writeback-apply`、`archive`、`checkpoint` 使用 journal envelope、目录锁与 recoverable write-set。`checkpoint`（CR-2026-033）是单一深原语：复用既有 durable 层与 `workspace-transactions.mjs#checkpointCr`，将逐仓 Git 算法收敛为全仓 source commit → 非 KB lease publish → KB `latest-checkpoint` + metadata commit 唯一完整批次可见点；业务 payload 校验归 workspace-transactions（durable-tx 只做 generic envelope/op-payload slot），测试入口 `skills/shared/crctl/scripts/test/checkpoint-tx.test.mjs`。`approve`、`review-record`、`owner-set` 的多文件写使用同一 `durable-tx.mjs` 中的 command-level ledger transaction：commit 前中断按持久化 before snapshots 整组回滚；commit 后中断按 `AI-First-Tx` trailer 确认 authority 后只清理 journal。旧 `casWriteMulti` 与专属半状态故障点已删除。其余单文件账本命令继续使用 hash-CAS；所有路径共享 `.crctl/audit.log` 与 controlled Git，无旁路。

### `skills/shared/crctl/gates.json` + `dir-graph.yaml`

CR 状态机（15 具名状态 + 注册前 `(new)`，**28 条声明转移、wildcard 展开 50 条**）与门禁判据的唯一事实源。**任何使用方仓库不得复刻这两处声明**，只能引用。

### `skills/shared/engineering-docs/`

工程文档模板层（PRD/SDD/MODULE/FORM/TASK/PLAN/RELEASE/OpenAPI/ARCHITECTURE 等），供各 Skill 落盘文档时保证 frontmatter 合规。

### `pipeline-templates/`

8 个 Pipeline 的 JSON 编排定义（节点顺序、reviewLoop 配置、触发的 Skill），是 Skill 调用顺序的权威声明。

**reviewer 选择边界（CR-2026-042）**：代码评审的 runner 由 Agent/runtime 在进入 Pipeline 前选择，Pipeline 不设置额外的 reviewer 选择人工暂停节点；`review-code` 节点直接使用当前 runner 并在 `dimensions.reviewer-model` 留痕。

### `skills/writeback/scripts/`

回写机械步骤的版本化执行脚本（CR-2026-020 起）：`writeback-prd-sdd.mjs` / `writeback-tasks.mjs` / `writeback-traceability.mjs` + 公共库 `lib.mjs` + 回归套件 `test/writeback.test.mjs`。**硬边界：只写 specs/ 与 delivery/ 内容文件，账本四类文件（`_backlog.yml` / `_history.yml` / `cr.md` / CR `tasks/_index.yml`）只读**——账本写入仍唯一经 crctl；与 crctl 平行、互不依赖。

### `crctl/adapters/`

claude-code（SessionStart/PreCompact 注入）与 CI 两类适配器，只经 crctl 子命令读取状态/门禁结果，不直接解析账本文件。

## 4. 分层与依赖方向

```
使用方仓库（AI First Platform 等） # 消费本包，不反向被本包依赖
   ↓
Pipeline（pipeline-templates/）     # 编排 Skill 调用顺序
   ↓
Skill（skills/{组}/{name}/SKILL.md）# 提示词合约，读写状态/账本必须经 crctl
   ↓
crctl（scripts/crctl.mjs）          # 状态与账本的唯一写入执行器，最底层
```

规则：依赖只朝下。Skill 不得绕过 crctl 直接改写 `cr.md`/`_backlog.yml`/`tasks/_index.yml` 等账本文件。crctl 与 Pipeline 的依赖描述（CR-2026-027 FR-3 修订）：crctl 不执行 Skill，也不依赖 Skill 的自然语言语义；crctl 可以读取 dir-graph、gates 和 Pipeline 中的声明式 gate/reviewLoop 配置；Pipeline 不得调用 crctl 之外的账本写入口。

## 5. 硬不变量（Invariants）

违反下列任意一条 = bug（评审中 = blocker），无例外；确需破例先修订本文档。

1. **状态单一写者**：CR status 只能通过 `crctl advance` 写入 `cr.md` frontmatter，任何 Skill/脚本不得另开状态写入口（核查：`grep -rn "status:" skills --include=SKILL.md` 命中的都应是"读取/展示"而非"写入"描述；`grep -n "updateCrMdStatus" crctl.mjs` 调用点应唯一收敛在 `cmdAdvance`）。
2. **账本单一写入通道**：`_backlog.yml`/`tasks/_index.yml`/`_history.yml` 等账本文件的写入只能经 crctl 子命令（CAS + `.crctl/audit.log` 审计），禁止会话内现写脚本或 Skill 文档指导手工编辑 YAML（核查：`grep -rn "手工编辑\|手动改" skills --include=SKILL.md` 应为空，或仅命中"禁止"类措辞）。
3. **零第三方依赖**：`crctl.mjs` 只用 Node 标准库；YAML 读写用行级定向正则改写（非通用序列化器），避免引入解析器依赖与"全量重排打乱字段序"的副作用（核查：`crctl.mjs` 顶部 `import` 语句只含 `node:*` 内建模块）。
4. **行尾与硬失败纪律**：任何对账本文件做哈希、跨行正则、逐行解析的代码，读入先 `\r\n → \n` 规范化，解析器用 `split(/\r?\n/)`；跨行正则匹配失败必须硬失败报错，禁止静默降级为空结果（核查：新增解析函数是否在 `replaceAll('\r\n','\n')` 之后才做正则匹配；匹配失败路径是否调用 `fail(...)` 而非返回原文/空值）。
5. **状态机口径唯一**：状态机 = 15 个具名状态 + 注册前 `(new)`；转移 = 28 条声明，wildcard 展开后 50 条。任何文档/断言/代码注释引用状态机规模必须与此口径一致（核查：新文档若提及"N 个状态/M 条转移"，核对是否为该口径）。
6. **git 是权威，outbox 只是投影**：`crctl` 状态/事件写入 git 后才是权威事实；`.crctl/outbox/` 事件写入失败只记审计、不阻塞主操作（核查：`emitOutboxEvent` 的失败分支是否仍返回主命令的 `ok()` 结果）。
7. **人工审批无旁路**：需求/架构/开发启动/代码四个人工审批节点只能经 `crctl approve`（交互式 TTY）或 Ed25519 签名授权完成，非 TTY 调用一律拒绝（核查：`cmdApprove` 的 TTY/签名校验分支是否可被参数绕过）。

## 6. 刻意不做（Negative Space）

| 不做什么 | 为什么（否决记录） | 何时重新考虑 |
|---|---|---|
| 独立账本操作脚本库（如 `tools/skills/shared/scripts/`） | CR-2026-012 复盘明确否决：会在 crctl 之外开第二条账本写入通道，绕开 CAS 复核/审计日志/门禁校验，长期必然漂移。（范围澄清，CR-2026-020：否决对象是**账本操作**脚本库；specs/delivery 内容文件回写脚本落点收窄为 `skills/writeback/scripts/`，不是 `skills/shared/scripts/`——防后续 CR 误以为本否决已推翻而把账本脚本堆入该目录） | 若 crctl 子命令模式被证明无法覆盖某类账本操作（如需要跨仓事务），重新评估 |
| 另一套独立 WAL/事务框架 | 跨文件与跨仓写入统一复用 `durable-tx.mjs` 的锁、journal envelope 与 recoverable write-set；再造第二套会分裂恢复语义 | 仅当现有事务 envelope 无法表达新的原子边界，先修订本文档再评估 |
| 引入通用 YAML 序列化库 | 全量重排会打乱既有文件的注释与字段序，扩大 diff 面；且违反零依赖不变量（不变量 3） | 若行级正则改写的维护成本显著超过引入依赖的成本，重新评估 |

## 7. 横切关注点（Cross-Cutting Concerns）

- **错误处理**：`crctl.mjs` 统一用 `fail(code, message, extra)` 非零退出（`:29`），不抛裸异常；调用方按 `code` 分支处理。
- **测试**：`node --test skills/shared/crctl/scripts/test/crctl.test.mjs`，用例覆盖各子命令的正常/边界/CAS 冲突路径，无外部测试框架依赖。
- **可观测性**：所有状态/账本写入追加 `.crctl/audit.log`（JSON Lines）；跨进程/跨设备同步经 `.crctl/outbox/` 事件（daemon 采集），失败不阻塞主操作。
- **配置**：身份识别优先读 `.crctl/config.json` 的 `identity` 字段，否则回退 `git config user.name`。

## 7a. 优化指标基线（CR-2026-027 FR-7 固化）

**正确性指标**（v2 方案 §16.1）：状态和账本无旁路；approval 与 status 同一提交；TASK pending 不可回写/归档；archive event 不丢失；archived CR 可查询；所有参与仓来自机器可读声明；候选工具不通过隐藏路径治理当前 CR。

**外部调用量目标**（v2 方案 §16.2，观测值，用于 Phase 2+ 候选路线对照）：

| 阶段 | 当前 | 目标 |
|---|---:|---:|
| 注册 | 24 | 8–12 |
| PRD 编写 | 9 | 3 |
| PRD 评审 | 6 | 2–3 |
| SDD 编写 | 14 | 4–6 |
| SDD 回修评审 | 10 | 4–6 |
| Plan/TASK | 11 | 4–5 |
| implement-code | 63 | 25–35 |
| test-report | 7 | 2–3 |
| code review | 10 | 3–4 |
| 用户 scope change 回修 | 53 | 12–20 |
| merge | 14 | 2–4 |
| writeback | 18 | 4–7 |
| archive | 8 | 2–3 |

**调用量是观测指标，不得通过删除 gate、测试、补偿或人工审批达成。**

## 8. 本文档的维护规则

本文档只记录当前架构与重大决议，不逐 TASK 记录实施日记；CR 的过程事实留在 `change-requests/{CR-ID}/` 与 Git 历史。

- 触发修订的变更：新增/删除 skills 顶层分组、Pipeline 结构性变化、crctl 新增写入子命令、状态机口径变化、否决一个重大方案。
- 普通 Skill 文档措辞调整、单个 CR 的功能改动**不需要**改本文档——若发现必须改，说明该改动是架构级变更，先过设计评审。
- 评审对照：`review-tech-design` 的"架构合理性"维度逐条对照 §4/§5/§6 判定。

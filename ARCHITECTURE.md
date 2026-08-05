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

状态机与账本的唯一可执行治理工具。**刻意单文件**（当前 1400+ 行），不因体量拆分——拆分会打散"状态机 + CAS + 审计"这条强内聚的写入路径，抵消单文件带来的"改动即全貌可见"优势（对标 esbuild/Litestream 的单文件哲学）。

CR-2026-021 起写入子命令族扩至覆盖：`review-annotations/{stage}.yml`（review-record）、`approval.yml#supplemental-reviews[]`（review-note）、`_backlog` 非 status 字段（checkpoint-add/owner-set/backlog-set/inbox-emit）、CR-ID/TASK-ID 分配与首次建档（next-cr-id/cr-init/task allocate）、只读聚合（worktree-path/report/cr-metrics）、`git commit --template` 消息模板。全部沿用「状态机 + CAS + `.crctl/audit.log` 审计」同一条写入路径，无旁路。

### `skills/shared/crctl/gates.json` + `dir-graph.yaml`

CR 状态机（15 具名状态 + 注册前 `(new)`，23 条声明转移、wildcard 展开 45 条）与门禁判据的唯一事实源。**任何使用方仓库不得复刻这两处声明**，只能引用。

### `skills/shared/engineering-docs/`

工程文档模板层（PRD/SDD/MODULE/FORM/TASK/PLAN/RELEASE/OpenAPI/ARCHITECTURE 等），供各 Skill 落盘文档时保证 frontmatter 合规。

### `pipeline-templates/`

8 个 Pipeline 的 JSON 编排定义（节点顺序、reviewLoop 配置、触发的 Skill），是 Skill 调用顺序的权威声明。

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

规则：依赖只朝下。Skill 不得绕过 crctl 直接改写 `cr.md`/`_backlog.yml`/`tasks/_index.yml` 等账本文件；crctl 不依赖任何 Skill 或 Pipeline 定义。

## 5. 硬不变量（Invariants）

违反下列任意一条 = bug（评审中 = blocker），无例外；确需破例先修订本文档。

1. **状态单一写者**：CR status 只能通过 `crctl advance` 写入 `cr.md` frontmatter，任何 Skill/脚本不得另开状态写入口（核查：`grep -rn "status:" skills --include=SKILL.md` 命中的都应是"读取/展示"而非"写入"描述；`grep -n "updateCrMdStatus" crctl.mjs` 调用点应唯一收敛在 `cmdAdvance`）。
2. **账本单一写入通道**：`_backlog.yml`/`tasks/_index.yml`/`_history.yml` 等账本文件的写入只能经 crctl 子命令（CAS + `.crctl/audit.log` 审计），禁止会话内现写脚本或 Skill 文档指导手工编辑 YAML（核查：`grep -rn "手工编辑\|手动改" skills --include=SKILL.md` 应为空，或仅命中"禁止"类措辞）。
3. **零第三方依赖**：`crctl.mjs` 只用 Node 标准库；YAML 读写用行级定向正则改写（非通用序列化器），避免引入解析器依赖与"全量重排打乱字段序"的副作用（核查：`crctl.mjs` 顶部 `import` 语句只含 `node:*` 内建模块）。
4. **行尾与硬失败纪律**：任何对账本文件做哈希、跨行正则、逐行解析的代码，读入先 `\r\n → \n` 规范化，解析器用 `split(/\r?\n/)`；跨行正则匹配失败必须硬失败报错，禁止静默降级为空结果（核查：新增解析函数是否在 `replaceAll('\r\n','\n')` 之后才做正则匹配；匹配失败路径是否调用 `fail(...)` 而非返回原文/空值）。
5. **状态机口径唯一**：状态机 = 15 个具名状态 + 注册前 `(new)`；转移 = 23 条声明，wildcard 展开后 45 条。任何文档/断言/代码注释引用状态机规模必须与此口径一致（核查：新文档若提及"N 个状态/M 条转移"，核对是否为该口径）。
6. **git 是权威，outbox 只是投影**：`crctl` 状态/事件写入 git 后才是权威事实；`.crctl/outbox/` 事件写入失败只记审计、不阻塞主操作（核查：`emitOutboxEvent` 的失败分支是否仍返回主命令的 `ok()` 结果）。
7. **人工审批无旁路**：需求/架构/开发启动/代码四个人工审批节点只能经 `crctl approve`（交互式 TTY）或 Ed25519 签名授权完成，非 TTY 调用一律拒绝（核查：`cmdApprove` 的 TTY/签名校验分支是否可被参数绕过）。

## 6. 刻意不做（Negative Space）

| 不做什么 | 为什么（否决记录） | 何时重新考虑 |
|---|---|---|
| 独立账本操作脚本库（如 `tools/skills/shared/scripts/`） | CR-2026-012 复盘明确否决：会在 crctl 之外开第二条账本写入通道，绕开 CAS 复核/审计日志/门禁校验，长期必然漂移。（范围澄清，CR-2026-020：否决对象是**账本操作**脚本库；specs/delivery 内容文件回写脚本落点收窄为 `skills/writeback/scripts/`，不是 `skills/shared/scripts/`——防后续 CR 误以为本否决已推翻而把账本脚本堆入该目录） | 若 crctl 子命令模式被证明无法覆盖某类账本操作（如需要跨仓事务），重新评估 |
| 双文件/多文件写入的 WAL 或两阶段提交 | 单写者不变量（不变量 7）下，`casWriteMulti` 的"全校验→全 temp→连续 rename"窗口足够小，过度设计（YAGNI） | 若出现并发 crctl 写者场景，改为文件锁或事务日志 |
| 引入通用 YAML 序列化库 | 全量重排会打乱既有文件的注释与字段序，扩大 diff 面；且违反零依赖不变量（不变量 3） | 若行级正则改写的维护成本显著超过引入依赖的成本，重新评估 |

## 7. 横切关注点（Cross-Cutting Concerns）

- **错误处理**：`crctl.mjs` 统一用 `fail(code, message, extra)` 非零退出（`:29`），不抛裸异常；调用方按 `code` 分支处理。
- **测试**：`node --test skills/shared/crctl/scripts/test/crctl.test.mjs`，用例覆盖各子命令的正常/边界/CAS 冲突路径，无外部测试框架依赖。
- **可观测性**：所有状态/账本写入追加 `.crctl/audit.log`（JSON Lines）；跨进程/跨设备同步经 `.crctl/outbox/` 事件（daemon 采集），失败不阻塞主操作。
- **配置**：身份识别优先读 `.crctl/config.json` 的 `identity` 字段，否则回退 `git config user.name`。

## 8. 本文档的维护规则

- 触发修订的变更：新增/删除 skills 顶层分组、Pipeline 结构性变化、crctl 新增写入子命令、状态机口径变化、否决一个重大方案。
  - 已登记：CR-2026-021（T1.3）crctl 新增 9 写 + 2 只读 + 1 处 git commit 扩展子命令（review-record/review-note/checkpoint-add/owner-set/backlog-set/inbox-emit/next-cr-id/cr-init/task allocate + worktree-path/report/cr-metrics + --template），§3 代码地图已同步；不改 §5/§6 判据（全部合既有不变量）。
- 普通 Skill 文档措辞调整、单个 CR 的功能改动**不需要**改本文档——若发现必须改，说明该改动是架构级变更，先过设计评审。
- 评审对照：`review-tech-design` 的"架构合理性"维度逐条对照 §4/§5/§6 判定。

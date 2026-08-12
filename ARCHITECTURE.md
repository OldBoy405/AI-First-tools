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

状态机与账本的唯一可执行治理工具。**刻意单文件**（当前 1400+ 行），不因体量拆分——拆分会打散“状态机 + CAS + 审计”这条强内聚的写入路径，抵消单文件带来的“改动即全貌可见”优势（对标 esbuild/Litestream 的单文件哲学）。**本轮不创建 `commands/` 模块目录**；若未来需要模块化，必须独立立项并先修订本文档（CR-2026-027 FR-2 拍板）。CR-2026-031 起例外：Git/workspace 事务层按 SDD §2.3 下沉到同级 `lib/`（现有 `yaml-subset.mjs`、`workspace-transactions.mjs`、`durable-tx.mjs`），crctl.mjs 保持 CLI/状态机/门禁的唯一入口并薄接线 lib；lib 不得反向依赖 crctl.mjs、不得成为第二 CLI（TASK-12 回写时统一修订本段基线）。TASK-05 起首个业务事务接线：`register`（幂等注册：CR-ID + 三账本 recoverable write-set + trailer commit/lease push + worktree ensure）与 `workspace inspect|ensure|cleanup`；注册三账本模板与 scanMaxCrNumber/formatCrId/assertSupportedBacklogSchema 下沉 lib 共用（cr-init re-import，TASK-10 删除时一并收敛）。TASK-07 起 `merge`（可恢复跨仓 saga：只消费 approval release-subjects，commit-tree 无副作用 prepare、逐仓 lease publish + classifyRemoteCommit 分流、全部 confirmed 后 detached Transaction Workspace 单 finalize commit 写 status=merging + merge-commits.yml + merge-verification.md，origin confirmed 后返回 operational_workspace；零 publish 的 code/TASK drift 经唯一回退转换 code-approved -> developing）与只读 `merge status`；matchFrontmatter/crMdStatusText 同步下沉 lib 共用。

CR-2026-021 起写入子命令族扩至覆盖：`review-annotations/{stage}.yml`（review-record）、`approval.yml#supplemental-reviews[]`（review-note）、`_backlog` 非 status 字段（checkpoint-add/backlog-set/inbox-emit）、**Owner 双投影 + 唯一责任历史 + 隔离 commit（owner-set，CR-2026-030 起不再是单一 _backlog 写入）**、CR-ID/TASK-ID 分配与首次建档（cr-init；TASK-ID 分配自 CR-2026-031 TASK-02 起由 write-dev-tasks 直接登记，`task allocate` 已删除）、只读聚合（worktree-path/report）、`git commit --template` 消息模板。全部沿用「状态机 + CAS + `.crctl/audit.log` 审计」同一条写入路径，无旁路。

### `skills/shared/crctl/gates.json` + `dir-graph.yaml`

CR 状态机（15 具名状态 + 注册前 `(new)`，**28 条声明转移、wildcard 展开 50 条**）与门禁判据的唯一事实源。**任何使用方仓库不得复刻这两处声明**，只能引用。

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
| 双文件/多文件写入的 WAL 或两阶段提交 | 单写者不变量（不变量 7）下，`casWriteMulti` 的"全校验→全 temp→连续 rename"窗口足够小，过度设计（YAGNI） | 若出现并发 crctl 写者场景，改为文件锁或事务日志 |
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

- 触发修订的变更：新增/删除 skills 顶层分组、Pipeline 结构性变化、crctl 新增写入子命令、状态机口径变化、否决一个重大方案。
  - 已登记：CR-2026-021（T1.3）crctl 新增 8 写 + 2 只读 + 1 处 git commit 扩展子命令（review-record/review-note/checkpoint-add/owner-set/backlog-set/inbox-emit/cr-init/task allocate + worktree-path/report/cr-metrics + --template），§3 代码地图已同步；不改 §5/§6 判据（全部合既有不变量）。
  - 已登记：CR-2026-024 新增 active skill `coding-discipline`（develop 域，dev-agent owns；内化开发纪律，不触 crctl/状态机）+ code-implementation.pipeline.json 新增 `suggestion_policy` select input（strict 默认，评审期 suggestions 策略化分流）——合 §4 依赖方向与 §5 全部不变量。
  - 已登记：CR-2026-022 状态机口径 23→25 声明 / 45→47 展开（新增两条 reject 转换：approve-requirement:reject -> write-requirement-prd、approve-dev-start:reject -> write-dev-plan）；cr-init 补 --summary/--source/--target-version 旗标；git commit --template 补 --cr 旗标且生成形态对齐 commit 白名单；checkpoint-add LEGAL 改状态机派生（全非终态）；approve decline 分支执行状态机 reject 回退（REJECT_ROLLBACK 映射）；gates.json 删 review-planning-report 死配置；§5 不变量 5 口径已同步（25/47）。
  - 已登记：CR-2026-025 crctl 命令面语义扩展（task done 一跳 depends-on 守卫 + review-record 三账本一致写/投影 + next drafting 摘要路由）与 check-skill-matrix 检查 4（external 引用点校验）+ 首个测试文件——§3 代码地图的 crctl 段与测试面已随改动落地；合 §4 依赖方向与 §5 全部不变量（不新增子命令/旗标，不触状态机与 gates 判据），仅按 §8 维护规则登记。
  - 已登记：CR-2026-026 新增 review-dev-plan 编码前合并评审（dev-agent owns / quality-reviewer-agent can-call）——crctl REVIEW_STAGE 四映射扩展（dev-plan stage + resolveDevPlanRoute 双轨路由 + repair-target 顶层字段枚举校验 + upstream 跳过 bump）、code-implementation.pipeline.json 插入 review-dev-plan reviewLoop 节点（onBlock 二分：NORMAL replay / UPSTREAM abort）、gates.json 变更（dev-start evidence 三键 + passCondition、developing 五条件、reviewLoops 映射）、状态机口径 25→27 声明 / 47→49 展开（两条转换：review-dev-plan:block / review-dev-plan:upstream-design-blocker）——合 §4 依赖方向与 §5 全部不变量。
  - 已登记：CR-2026-030 TCA-001~004 契约收敛（不改状态机/gates/§5 判据）——cr-init 三角色 Owner 显式必填（FR-1）、register commit 成功后以真实 SHA 发 status+owners 事件（FR-2）、worktree-path 返回 canonical branch（FR-2）；owner-set 收敛为正式移交原语（tracked clean 前置 + 双投影校验 + 只含两账本的隔离 commit + CAS 回滚 + owners/inbox 同 SHA 事件，FR-3~FR-5）；approve/reject 共用 grant v1 完整验证，合法 reject 走 REJECT_ROLLBACK 权威回退 + 紧邻结果态幂等（FR-6~FR-7）；performAdvance 内核提取（standalone commit 失败不发 status outbox，FR-8）；R7 直读 dir-graph.yaml transitions 静态校验 advance 字面量（FR-9）；review-dev-plan 持有两条精确 advance、code-implementation pipeline 只留路由/replay（FR-8）。**评审回修（pass-at-max）**：attemptsWithinLimit 门禁在最新一轮评审 verdict=pass 且轮次到顶（current≥max）时不判 LOOP_EXHAUSTED——pass 无需再自修复，与 review-code「pass 即可推进 code-reviewing」契约一致；block/缺证据仍阻断。
  - 已登记：CR-2026-027（Phase 0/1 基线统一与正确性修复）——§3/§5 状态机口径统一为 27/49、§4 crctl-Pipeline 依赖描述修订（FR-3）、§7a 指标基线固化（FR-7）、approve 原子提交（approveAndAdvance + evidence override + assertCandidateStatus，FR-8）、archived TASK 门禁五步判定（FR-9，gates.json 声明不动）、migrate-backlog 幽灵条目清理（FR-10）、archive-move 三账本 CAS + 归档事件同批（FR-11）、status/next 终态只读查询（FR-12）、review-record 输出深化 + post-PASS review cycle（FR-13/FR-16）、next 路由 freshness（FR-16）、inbox-emit 空 to 硬失败（FR-11）——合 §4 依赖方向与 §5 全部不变量（不新增子命令/账本类型，crctl 保持单文件）。
  - 已登记：CR-2026-031 TASK-02 删除死代码与永久兼容（不改状态机/gates/§5 判据）——删除 `writeApprovalSection`（死代码，活路径是 buildApprovalSectionText）、`cr-metrics`（report 别名）、`task allocate`（无消费者）、`migrate-backlog` + ghost cleanup（v1 永久迁移兼容）、resolveCrState 的 backlog status 回退读；`_backlog.yml` 最低 schema 收紧为 cr-backlog/v2（assertSupportedBacklogSchema，v1/缺声明 → UNSUPPORTED_BACKLOG_SCHEMA 零写）；cr-init/worktree-path/merge-metadata/archive-move 保留，待 TASK-10 统一切换时删除。合 §4 依赖方向与 §5 全部不变量。
  - 已登记：CR-2026-031 TASK-03 repository resolver 与 authority 判定（不改状态机/gates/§5 判据）——新增 `scripts/lib/workspace-transactions.mjs`（`resolveRepositories`：dir-graph#repositories 声明解析，bucket 由 role 派生，canonical 路径 + symlink escape 拒绝，graphDigest；`resolveOperationalWorkspace`：finalize 前 authority = CR worktree，finalize 后 = detached Transaction Workspace，主 checkout 永不返回；`TxError` 结构化错误供接线层转 fail）与 `scripts/lib/yaml-subset.mjs`（parseYaml 自 crctl.mjs 原样提取，crctl.mjs re-import，消除未来 lib 任务的复刻风险）；`deriveInstallRoot` 同步迁入 lib。TASK-03 无 CLI 面，测试直接 import lib（test/workspace-resolver.test.mjs）。合 §4 依赖方向与 §5 全部不变量。
  - 已登记：CR-2026-031 TASK-04 durable journal 锁与 recoverable write-set（不改状态机/gates/§5 判据）——新增 `scripts/lib/durable-tx.mjs`：目录锁 acquireLock（原子 mkdir + owner.json token/pid/hostname 校验，同机存活探针无错/EPERM 阻断、ESRCH 接管，foreign host/owner 不完整保守阻断，无 TTL/force-unlock，释放 token 必须匹配且幂等）、journal envelope loadOrCreateJournal/saveJournal（单 payload 不变量、inputDigest 冲突硬阻断、非法 journal 不静默跳过）、recoverable write-set applyWriteSet/recoverWriteSet/cleanupTxBlobs（before/after/第三值三分类，blob 先落盘再连续 rename，第三值 TX_RECOVERY_CONFLICT 零写入，complete 后幂等清理，单文件写也走 one-entry write-set）、durableWriteFile（同目录 temp + fsync + rename）；nowIso 与 FAULT_POINTS/fault 下沉至 lib（crctl.mjs re-import，fault 经 TxError→fail 保持 JSON 输出契约）；新增故障点 tx-apply-between-rename/tx-apply-before-complete，真实 kill/restart 恢复矩阵由 test/durable-tx.test.mjs 覆盖。旧 casWrite/casWriteMulti 待 TASK-10 统一切换后删除。合 §4 依赖方向与 §5 全部不变量。
  - 已登记：CR-2026-031 TASK-05 幂等 register 与 workspace 生命周期（不改状态机/gates/§5 判据）——新增 active 命令 `register` 与 `workspace inspect|ensure|cleanup`（crctl 首批事务命令面）；事务逻辑唯一实现在 `lib/workspace-transactions.mjs`：registerCr（registration key 仅 SHA-256 落 journal/trailer，同 key+同 inputDigest 复用 CR-ID/txId 续跑，输入漂移 REGISTRATION_INPUT_MISMATCH，dirty trunk REGISTRATION_TRUNK_DIRTY 零写，三账本走 recoverable write-set，trailer commit + `--force-with-lease` push，remote 推进时 rebuild/重写硬阻断 history-rewritten，副作用后 graph 漂移 GRAPH_CHANGED_DURING_TRANSACTION，逐仓 worktree ensure 每仓落盘）、ensureWorkspace（inspect 七分类 missing/healthy/branch-only/remote-only/dirty/wrong-branch/path-unregistered，resume 只补可证明资源，partial/archived cleanup 只删干净 worktree、dirty/unknown/未合并 ref 零删除）、classifyRemoteCommit（SDD §5.1 原样实现）；scanMaxCrNumber/formatCrId/注册三账本模板/assertSupportedBacklogSchemaText 自 crctl.mjs 下沉 lib 共用（cr-init re-import，TASK-10 删除时收敛）；新增故障点 register-after-allocate/after-ledgers/after-commit/after-push/between-worktrees，三 bare remote 集成矩阵由 test/register-tx.test.mjs 覆盖。cr-init 保留至 TASK-10。合 §4 依赖方向与 §5 全部不变量。
  - 已登记：CR-2026-031 TASK-06 signed release snapshot 与漂移回退（**状态机口径 27/49 → 28/50**；gates 判据不动）——`review-record --stage code` 机器注入 release-subjects（逐仓 worktree HEAD + 受控 artifact PRD/SDD/plan/tasks 的 CRLF→LF + 字典序 + SHA-256 集合 digest；payload 提供/覆盖 → `RELEASE_SUBJECTS_FORGED` 零写）；approve TTY/grant 两条路径在 `approveAndAdvance` 单缝重核（head-drift / remote-ref-drift / prd / sdd / task / missing 六类 → `RELEASE_SUBJECT_DRIFT` 零写入），通过后 release-subjects 原样复制进 `approval.yml#code`（与 annotation 块字节语义一致，被 evidence digest 签入）；`dir-graph.yaml` 新增唯一回退转换 `code-approved -> developing`（trigger `merge-feature-branch:release-drift -> implement-code`，供 TASK-07/08 精确消费）；新增 `test/crctl.test.mjs` TASK-06 ①~⑥（伪造拒绝、独立重算一致性、grant 复制签入、六类漂移零写入、TTY 路径、状态机口径 28/50）。合 §4 依赖方向与 §5 全部不变量。
  - 已登记：CR-2026-031 TASK-07 可恢复跨仓 merge 与 finalize（不改状态机/gates/§5 判据）——新增 active 命令 `merge <cr>` 与 `merge status <cr>`；事务逻辑唯一实现在 `lib/workspace-transactions.mjs`：mergeCr（只消费 approval.yml#code.release-subjects（TASK-06 签入），verifyReleaseSubjects 重核分流：零 publish 的 code/task drift 返回 phase=release-drift 由 crctl 层经回退转换执行、PRD/SDD drift → APPROVED_ARTIFACT_DRIFT、已 publish 后 drift 硬阻断；每仓 `merge-tree --write-tree` + `commit-tree` 无副作用 prepare（冲突 → MERGE_PREPARE_CONFLICT 零远端副作用）；逐仓 lease push + classifyRemoteCommit 分流（confirmed 跳过 / pushable 续推 / rebuild 重做 / history-rewritten 硬阻断，≤3 轮）；全部 confirmed 后 detached Transaction Workspace 单 finalize commit 写 status=merging + merge-commits.yml + merge-verification.md，lease push 后 origin confirmed 返回 operationalWorkspace；matchFrontmatter/crMdStatusText 自 crctl.mjs 下沉 lib 共用）；durable-tx 的 applyWriteSet/recoverWriteSet 增加可选 txRoot 参数（finalize 写集在 txws、事务目录在 installRoot）；新增故障点 merge-after-prepare/after-observation/after-push/before-finalize/after-finalize-commit/after-finalize-push，三 bare remote 集成矩阵由 test/merge-tx.test.mjs 覆盖（prepare conflict、第二仓失败续跑不重复 confirmed push、响应丢失重放、remote stale rebuild、finalize stale rebuild、history rewrite 硬阻断、release-drift 回退、PRD drift 零写、merge status 只读快照、authority 切换）。合 §4 依赖方向与 §5 全部不变量。
  - 已登记：CR-2026-031 TASK-08 candidate-only writeback 与 writeback-apply（不改状态机/gates/§5 判据）——三个 writeback generator（prd-sdd/tasks/traceability）收敛为 candidate-only：只读 workspace、只输出 candidate 目录（文件 + blobs/ + manifest.json v1：files 唯一/POSIX 字典序/仅 create-replace，inputDigest = canonical 自校验 sha256，两侧公式独立内联由测试交叉验证防漂移）；traceability 改读 change-requests/{cr}/merge-commits.yml（TASK-07 事实源，trunk 取自 dir-graph，删 _backlog.yml 提取）；新增 active 命令 `writeback-apply <cr> --stage baseline|tasks|traceability --candidate <manifest> --spec-id <id>`（事务唯一实现在 applyWriteback：authority 解析经 merge journal operationalWorkspace（resolveOperationalWorkspace 修正——CR worktree 是只读被评审源，post-finalize 事实来自 journal）、manifest 全矩阵校验（schema/allowlist/path 安全/symlink parent/blob 存在与哈希/before=磁盘字节锚点/inputDigest/stage-generator 绑定）、txws 精确 stage + staged set 断言、commit+trailer、lease push + classify；before/after CAS 锚点统一为磁盘字节 sha256（Windows autocrlf CRLF 不影响锚点一致性）；STALE 时 txws 重置到新 origin + 零副作用 journal 清理，重跑 generator 后重试；before 校验幂等重入跳过）；writeback-lib 增 readHashRaw/writeCandidate；FAULT_POINTS 新增 writeback-after-apply/after-commit/after-push 与 archive-after-commit/after-push/during-cleanup（TASK-09 预留）；测试：writeback.test.mjs 10（candidate-only 零写/排序/inputDigest 交叉验证/幂等）+ writeback-tx.test.mjs 6（happy path 精确 staged+trailer+幂等、15 类恶意 manifest 矩阵全 hard fail 零写入、STALE 重建闭环、history rewrite 硬阻断、fault 续跑不重复 commit、traceability 全链路），三 bare remote fixture 提取到 test/merge-fixture.mjs 共享。合 §4 依赖方向与 §5 全部不变量。
- 普通 Skill 文档措辞调整、单个 CR 的功能改动**不需要**改本文档——若发现必须改，说明该改动是架构级变更，先过设计评审。
- 评审对照：`review-tech-design` 的"架构合理性"维度逐条对照 §4/§5/§6 判定。

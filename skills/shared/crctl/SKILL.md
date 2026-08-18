---
name: crctl
description: CR 状态机 gate CLI（漂移治理 v2 组件 A）：在 IDE 单独使用本 tools 包时，作为状态推进 / controlled-shell / validate-doc 等历史手动流程的代码化执行器，把状态推进、门禁校验、人工审批、git 白名单从「模型自觉」变成「代码强制」（状态推进唯一通道为 `crctl advance`）。
---
<!-- meta
id: crctl
title: crctl 状态机 gate CLI
status: active
kind: skill
scope: drift-governance
-->

# Skill: crctl

**类型**: 基础能力 Skill（shared/ 组，代码执行层）
**定位**: `docs/漂移治理_v2.md` 的组件 A 实现。当本 tools 包脱离平台（渐进加载 + pipeline 执行约束层）在 Codex / Claude Code / Cursor / Kimi / Qoder 中单独使用时，本 Skill 提供的 CLI 是**权威状态的唯一合法写入路径**。

## 用途

| 子命令 | 作用 | 是现有哪个契约的代码化 |
|---|---|---|
<!-- lint-prompts:ignore --> 描述性：CLI 说明
| `status` | 确定性读 `change-requests/{CR-ID}/cr.md` frontmatter + `dir-graph.yaml#state_machine`，输出当前 status、合法下一步与门禁缺口。模型不得自报 status | 状态读取契约（读路径与历史一致） |
<!-- lint-prompts:ignore --> 描述性：CLI 说明
| `advance` | 校验 `(current, next, trigger)` 合法转换 + 目标状态门禁，全过才写 `cr.md` frontmatter 并 commit；否则非零退出且**不写文件**。支持 `--embedded`（历史 commit_mode=embedded 语义） | crctl advance |
| `gate` | 只校验不写，供预检与 CI 复用 | pipeline JSON `passCondition` |
| `approve` | **仅限交互式终端**的人工审批：展示证据摘要 → 人类确认 → 写 `approval.yml`（`via: crctl-approve`）→ 级联 advance；回答非 y/yes（CR-2026-044 FR-09：trim 后大小写不敏感接受 `y|yes`）时自动执行状态机 `{stage}:reject` 回退转换（错误码 `APPROVAL_DECLINED_ROLLED_BACK`，extra 含 rolledBackTo/rerunHint；CR-2026-022 FR-12）。非 TTY 调用一律返回 `APPROVAL_REQUIRES_HUMAN`；`--grant` 为 Ed25519 签名授权（服务端人在环），与 TTY 二选一、都不可绕过审批本身。**grant 双模式（CR-2026-030 FR-6~FR-7）**：approve/reject 共用完整验证（schema/归属/状态/evidence digest/Ed25519 签名），合法 reject 复用 `REJECT_ROLLBACK` 执行权威回退并返回 `APPROVAL_DECLINED_ROLLED_BACK`（含 decision/stage/rolledBackTo/trigger/changed，无 rerunHint）；approve/reject 紧邻结果态重放返回 `changed=false` 幂等（approve 要求 approval.yml 六字段与 grant 完全一致）；commit 失败重放返回 `GRANT_STATE_UNCOMMITTED`，非邻接状态 `GRANT_STATE_MISMATCH`，回退 commit 失败 `ADVANCE_COMMIT_FAILED`。证据定义变更时，`--resign <reason>` 仅可在 TTY 迁移 `via: crctl-approve` 的历史 digest；迁移前规范化 CRLF，审批段或直属 `evidence-digest` 非唯一时以 `SCHEMA_INVALID` 零副作用拒绝；`server-approve` 必须由服务端按新 digest 重签 grant，本地拒绝改写以免旧签名失效 | `human_approval` + `approve-*` |
<!-- lint-prompts:ignore --> 描述性：CLI 说明
| `validate` | 受控产物 schema 校验：cr.md / _backlog.yml 的 owners 三角色（id + assigned-at）、review-annotations 的 verdict 枚举与 blockers 结构、test-report / approval / traceability | `validate-doc` |
| `attempt` | review-loop 轮次唯一记账点（`change-requests/{CR-ID}/review-loop.yml`），maxAttempts 从 pipeline JSON 读取，超限返回 `LOOP_EXHAUSTED` | `reviewLoop.maxAttempts` |
| `task init` | 开发启动前 TASK 索引唯一初始化入口：在 `tech-design-reviewed` / `task-breakdown` 从 `TASK-NN.md` frontmatter 确定性创建或刷新 `tasks/_index.yml`；坏卡、悬空/成环依赖、已有进度或 CAS 冲突均零写入拒绝 | 任务拆分账本契约 |
| `task append` | developing 期 hardening TASK 追加入口：只接受比现有最大编号更大的 TASK 卡，保留既有 `status/done-at`，校验历史条目 metadata 未漂移后 CAS 追加新 pending 条目 | scope amendment / hardening TASK |
| `task done` | 任务状态唯一写入点（`tasks/_index.yml`）；CAS 写入前校验直接 `depends-on`（一跳）：未完成前置 `DEPENDS_ON_NOT_DONE`、悬空引用 `DEPENDS_ON_UNKNOWN`、非数组形态 `SCHEMA_INVALID`（CR-2026-025 FR-6/FR-7，依赖顺序机械强制） | 任务状态账本契约 |
| `review-record` | 评审判断落盘：canonical annotation + `review-loop.yml` + `traceability.yml#reviews.<stage>` 投影同批写入（同一 recordedAt）；requirement/tech-design 阶段额外写 `subject-sha256` 供 next 路由与 freshness 判定（CR-2026-025 FR-16~FR-19）；`--stage dev-plan` 额外写 plan.md + 全部 `TASK-*.md` 的 composite digest（canonical JSON entries，写入同一 `subject-sha256`；plan 缺失/TASK 集为空 → `SUBJECT_NOT_FOUND` 零写入，CR-2026-039 TASK-01），并支持顶层 `repair-target`（缺省 write-dev-plan / write-tech-design 上游疑点轨，枚举校验），bump 前双轨路由、upstream 跳过 bump（CR-2026-026 FR-4/FR-14）；dev-plan PASS 证据由 `next` 与 developing 门禁（passCondition dev-start）消费前重算 digest：漂移/legacy 无 digest/subject 不完整一律判 stale，next 按 repairTarget 路由（review-dev-plan/write-dev-plan/write-dev-tasks），approve-dev-start 硬失败零写入（CR-2026-039 TASK-02）；`--stage code` 机器注入 `release-subjects`（逐仓本地 healthy worktree HEAD + 受控 artifact digest，不读远端：发布完整性归 checkpoint/merge，CR-2026-031 TASK-06 / CR-2026-044 FR-02），payload 提供/覆盖一律 `RELEASE_SUBJECTS_FORGED` 拒绝 | review-* Skill 评审记录 |
| `test` | 结构化测试闭环：`--plan <cr-test-plan/v1>` 单一入口，`spawnSync(executable, args, {shell:false})` 执行，原子发布 `test-report.md` 机器区 + `traceability.yml#tests` + `review-loop.yml`（write-test-report）+ `test-evidence/cmd-NN.log`；业务 non-zero/timeout 记 `status=block`（exit 0），schema/路径/executable/事务等技术错误非零退出且 canonical 零变化；`--cmd`/`--cwd`/`--timeout` 已移除 | `write-test-report` 证据部分 |
| `next` | 按 status + 评审/测试证据输出下一个该跑的节点；blocker 未清空**绝不**返回 `human_approval`；writing-back 态改查 specs/{spec}/traceability.yml（FR-21） | 最小 pipeline-runner |
| `register` | 幂等注册事务（CR-2026-031 TASK-05，TASK-10 起取代旧注册子命令）：`--registration-key <k> --title <t> --owner-* <id>`——CR-ID + 三账本 recoverable write-set + trailer commit/lease push + 逐仓 worktree ensure，同 key 同输入续跑、输入漂移/trunk dirty/history rewrite 零写或硬阻断 | requirement-register |
| `merge` | 可恢复跨仓 merge saga（CR-2026-031 TASK-07）：只消费 approval.yml#code.release-subjects（纯本地重核，不读远端）；新事务首次 prepare 前先全仓 publication preflight（远端 requirement source 精确等于本地 HEAD 才继续；缺失 `MERGE_SOURCE_MISSING`/滞后 `RELEASE_REMOTE_NOT_PUSHED` 携 checkpoint recoverCommand，状态保持 code-approved，CR-2026-044 FR-05）；commit-tree 无副作用 prepare（冲突 MERGE_PREPARE_CONFLICT 零远端副作用）→ 逐仓 lease publish（confirmed 跳过/pushable 续推/rebuild 用冻结 sourceSha 重做/history-rewritten 硬阻断）→ 全部 confirmed 后 detached Transaction Workspace 单 finalize commit（status=merging + merge-commits.yml + merge-verification.md）；零 publish 的本地 code/TASK drift 经回退转换 `code-approved -> developing`，PRD/SDD drift → APPROVED_ARTIFACT_DRIFT；`merge status` 只读快照 | writeback/merge 阶段 |
| `writeback-apply` | 业务输入原子回写：`--stage baseline|tasks|traceability --spec-id <id> --target-version <ver>`（traceability 另需 workspace-relative `--milestone-file`）。crctl 内部固定 generator 与 `.crctl/candidates/{CR-ID}/{stage}`，journal 前完整 preflight；baseline 文件与 `merging→writing-back` 同 write-set/commit/lease push，origin-confirmed 后幂等发送 status outbox/advance audit。公共接口拒绝 candidate/generator/manifest 路径 | writeback 阶段 |
| `archive` | 单一幂等归档（CR-2026-031 TASK-09；CR-2026-032 固定返回）：`[--spec-id <id>]`——四账本（cr.md/_backlog/_history/_index）同批 recoverable write-set + archive commit + lease push；origin confirmed 后 cleanup（txws/CR worktree/本地 ref，clean 才删），失败返回 phase=cleanup-pending（status 恒 archived）重跑只续清理；rejected/withdrawn 远端未合并 ref 保留为 preservedRefs。统一固定返回 commit/lastCleanupError/remaining/preservedRefs/recoverCommand/warnings；writing-back 在 origin confirmed 后、cleanup 前发 schema v1 archive outbox（EMIT_FAILED 仅 warning，重跑补发不阻断归档） | cr-archive |
| `checkpoint` | 单一深原语：全仓 source commit + 非 KB lease publish + KB latest-checkpoint/metadata commit；前置态 = 非终态（CR-2026-033） | push-progress |
| `workspace freshness` / `workspace sync` | 基线新鲜度窄子命令（CR-2026-043）：定位为远端 trunk 新鲜度预检（CR-2026-044 FR-08）——freshness 只读分类各仓 CR 分支对 trunk 的新鲜度（fresh/behind-clean/diverged/unknown）；sync 仅对 behind-clean 仓执行显式 ff-only 前移（幂等续跑，失败重跑同一命令）；fetch/sync 失败可中止 Pipeline 节点但不改 status/approval/review/attempt；不被状态门禁、approve 或本地 release verifier 调用；能力面声明，算法与错误码以 `crctl.mjs`/`workspace-transactions.mjs` 实现为准 | workspace-freshness |
| `workspace inspect` | 各 active repo workspace 事实分类（只读）；CR-2026-044 FR-06 起额外返回既有 authority resolver 的单一 `operationalWorkspace` 路径（missing/inconsistent 时为 null + `operationalWorkspaceError` 结构化错误，不猜路径）；architecture/code pipeline 入口消费该字段并原样传递 | implement-code / write-tech-design 入口 |
| `git` | controlled-shell 白名单的 IDE 运行时适配器：按「子命令 + 形态 + 调用者」三元放行，越界返回 `FORBIDDEN_SUBCOMMAND`，全量审计日志；`commit --template` 支持 `--cr` 显式直传（FR-10） | `controlled-shell` |

## 单一事实源约定（重要）

本 Skill **不复刻规则副本**：

- 状态转换：运行时解析目标 workspace 的 `dir-graph.yaml#change-request-track.state_machine`（回退到本包同名文件）。
- 通过条件：运行时解析 `pipeline-templates/*.pipeline.json` 的 `reviewLoop.passCondition`。改 JSON 即改门禁，无需改代码。
- `gates.json` 只声明运行时适配信息：证据文件路径映射、审批段名、各状态适用哪个 pipeline 节点的 passCondition。

## 调用方式

```bash
node {TOOLS_ROOT}/skills/shared/crctl/scripts/crctl.mjs status CR-2026-001
node {TOOLS_ROOT}/skills/shared/crctl/scripts/crctl.mjs advance CR-2026-001 --to code-reviewing --trigger review-code
node {TOOLS_ROOT}/skills/shared/crctl/scripts/crctl.mjs approve CR-2026-001 --stage code        # 仅人类在终端运行
node {TOOLS_ROOT}/skills/shared/crctl/scripts/crctl.mjs approve CR-2026-001 --stage dev-start --resign "evidence definition changed"  # 仅迁移本地审批；服务端审批须重签 grant
node {TOOLS_ROOT}/skills/shared/crctl/scripts/crctl.mjs task init CR-2026-001 --workspace <knowledge-base-worktree>
node {TOOLS_ROOT}/skills/shared/crctl/scripts/crctl.mjs git status --short --cwd <worktree>
```

<!-- lint-prompts:ignore --> 描述性：CLI 说明
要求 Node >= 18。`--workspace <path>` 可显式指定目标 workspace，默认从 cwd 向上探测 `change-requests/_backlog.yml`。

## 读取 / 写入 / 状态推进 / 失败处理

<!-- lint-prompts:ignore --> 描述性：CLI 说明
- **读取**：`change-requests/{CR-ID}/cr.md` frontmatter（status 权威源）、`change-requests/_backlog.yml`（注册索引）、`change-requests/{CR-ID}/`（review-annotations/、test-report.md、approval.yml）、目标 workspace `dir-graph.yaml`、Tools Root（`{TOOLS_ROOT}`，运行时经 `workspace.tools_package_path` 解析，CR-2026-028 FR-1）下的 `pipeline-templates/*.pipeline.json` 与 `skills/shared/crctl/gates.json`。
<!-- lint-prompts:ignore --> 描述性：CLI 说明
- **写入**：`cr.md` frontmatter 的 status/updated（行级定点编辑，写前 sha256 CAS 复核，防并发覆盖）；`tasks/_index.yml`（仅 `task init`/`task append`/`task done`）；`approval.yml`（仅 approve）；`review-loop.yml`（仅 attempt）；`test-report.md` 与 `test-evidence/`（仅 test）；`.crctl/audit.log`（审计，自动 gitignore）。时间戳与执行者身份一律由本工具生成，**拒绝调用方传入**。
- **状态推进**：只经 `advance`；`standalone` 模式自动 commit `[cr] status {CR-ID} {from} -> {to}`（经自身 git 白名单执行），`--embedded` 只写文件由调用方同事务提交。
- **失败处理**：结构化 JSON 错误到 stderr + 非零退出。错误码：`CR_STATUS_NOT_FOUND` / `CR_STATUS_CURRENT_MISMATCH` / `CR_STATUS_TRANSITION_NOT_ALLOWED` / `GATE_BLOCKED` / `APPROVAL_REQUIRES_HUMAN` / `APPROVAL_DECLINED` / `LOOP_EXHAUSTED` / `FORBIDDEN_SUBCOMMAND` / `CAS_CONFLICT` / `OWNER_WORKTREE_DIRTY` / `OWNER_PROJECTION_DRIFT` / `OWNER_COMMIT_FAILED` / `OWNER_COMMIT_ROLLBACK_FAILED` / `GRANT_STATE_MISMATCH` / `GRANT_STATE_UNCOMMITTED` / `ADVANCE_COMMIT_FAILED` / `APPROVAL_DECLINED_ROLLED_BACK` 等。任何校验失败都不写文件。

## IDE 适配器（adapters/）

- `adapters/claude-code/`：PreToolUse 守卫（裸 git、受保护路径写入、Bash 重定向）+ SessionStart/PreCompact 自动注入 `crctl status` 输出 + `settings.template.json`。安装方法见其 README。
- `adapters/ci/`：GitHub Actions 模板，在远端对 `requirement/*` 分支复用 `crctl gate` / `crctl validate` 做强制校验（无 hook IDE 的强兜底）。

## 与现有 Skill 的关系

- 本 Skill 是执行层，不新增编排语义；`controlled-shell`、`validate-doc` 的契约仍是行为规范的事实源（状态推进契约已由 `crctl advance` 承接）。
- Agent 在 IDE 环境的状态推进一律执行 `crctl advance`；git 操作一律经 `crctl git`（受控 shell）。
- 诚实边界（`docs/漂移治理_v2.md` §7）：本工具校验证据的存在与形状，不校验真伪与质量；approve 保证有人按键，不保证人认真看过。

## 版本历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1.0 | 2026-07-26 | 首版：status/advance/gate/approve/validate/attempt/test/next/git 九个子命令 + gates.json + IDE 适配器模板 |

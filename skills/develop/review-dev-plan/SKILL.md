---
name: review-dev-plan
description: 对 change-requests/{CR-ID}/plan.md 与 tasks/ 执行编码前合并评审（SDD→plan→TASK 八类维度），判断写 .crctl/tmp/review-dev-plan.yml 并经 crctl review-record --stage dev-plan 落盘；PASS 保持 task-breakdown，BLOCK 按 repair-target 双轨路由。
---

# Skill: review-dev-plan

**类型**: 开发期 Skill（develop/ 组）
**调用时机**: code-implementation pipeline 中 write-dev-tasks 之后、push-progress 之前

---

## 用途

在编码前机械阻断遗漏、矛盾或不可执行的 plan/TASK：一次合并评审检查 `SDD → plan → TASK` 八类维度。评审判断写非受控临时 payload，canonical 落盘交 `crctl review-record --stage dev-plan --bump-attempt`（三账本同批）。PASS 保持 `task-breakdown` 进入现有开发启动人工审批；BLOCK 按顶层 `repair-target` 双轨路由（CR-2026-026 FR-6/FR-6a）。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `workspace` | string | ✅ | 业务权威路径（node-1 execution_context.operational_workspace 原样值）；用于读取 plan.md 与 tasks/ |
| `resources` | array | ✅ | node-1 execution_context.resources 原样值，元素含 `repo`、`worktreePath`；TASK 新事实只按 `resources[].worktreePath` 取证，不重新 inspect、不拼接路径 |
| `review_feedback` | object | ❌ | 来自上一轮 review-dev-plan 的 blockers；存在时进入重审模式 |
| `self_repair_attempt` | number | ❌ | 当前 reviewLoop 轮次；首次为 0，回修后由 pipeline 注入 |

---

## 执行步骤

### Step 1 — 前置校验

1. CR status 必须为 `task-breakdown`（普通轨重放时允许 `tech-design-reviewed`）。
2. 以下输入必须存在：`sdd.md`（已审批技术设计，权威输入）、`plan.md`、`tasks/_index.yml`、至少一个 `TASK-*.md`、`review-annotations/sdd.yml`（技术评审已知风险）。
3. `prd.md` 仅按 SDD 引用定位抽查，不得全量复审 PRD（D-15）。
4. `workspace` 用于读取过程文档；代码事实只按 `resources[].worktreePath` 取证，resources 只来自 node-1 execution_context，不重新 inspect、不拼接路径、不回退主工作区。

### Step 2 — 八类维度评审（FR-3）

| 维度 | 必查内容 |
|------|---------|
| SDD→plan 覆盖 | SDD 的模块/接口/迁移/验证/回滚/风险是否进入计划 |
| plan→TASK 覆盖 | 每个计划交付项至少落一个 TASK；TASK 能回指 plan/SDD |
| TASK 可执行性 | 目标/输入/输出/文件/实现要点/完成标志明确；不得含 TBD/空泛指令 |
| 依赖拓扑 | depends-on 无悬空引用、顺序符合产出/消费、无环 |
| 接口契约一致性 | 上游产出与下游消费的函数名/参数/返回类型一致 |
| 验收可验证性 | 每个 TASK ≥2 条可执行验收步骤，总体覆盖 SDD 验收面 |
| 范围与极简性 | 不引入 SDD 未批准能力；拆分粒度 1-3 天 |
| 风险与回滚 | 高风险变更有验证/开关/迁移/回滚安排 |

估算一致性：仅在揭示任务拆分、依赖或验收结构性问题时作为 blocker；普通工时口径差异进 suggestions。

### 增量职责与事实核验（CR-2026-055）

本评审是「SDD/AC → plan/TASK 的翻译增量」，不无差别重审已审批 SDD 决策。四个增量维度聚焦：

- `sdd-to-plan`：核对每条 AC 设计落点与 SDD 交付物是否在 plan/TASK 有对应，不重新裁决已审批设计；
- `task-executability`：核对 TASK 新造/细化的目标、输入、输出、文件、完成标志与责任边界；
- `interface-contracts`：核对 TASK 新造函数、事件、SQL、签名与 nil 责任层事实是否与目标 worktree 相符；
- `acceptance-verifiability`：核对 TASK 验收步骤是否在真实责任边界组合证明 AC，拒绝无关依赖的假绿短路。

TASK 新事实只能按 `resources[].worktreePath` 取证：事实不存在或与目标 worktree 不符形成 blocker，不得静默记录 N/A；资源缺失或不可读为技术失败，不写临时 payload。若新事实反证 SDD 或 SDD 设计落点本身断裂，`repair-target` 设为 `write-tech-design` 走 UPSTREAM；仅 plan/TASK 翻译问题走 `write-dev-plan` 普通回修轨。

### Step 3 — 平台绑定前置步骤 + 评审判断与落盘

0. **平台绑定前置步骤（FR-B7，CR-2026-053）**：若当前运行具有 Multica task-scoped context（`mat_` task token 注入的 task 上下文）：
   - 先执行 `multica cr bind-current-task {cr_id}`，把当前 reviewer task 绑定到 CR 及其来源 Issue；
   - 绑定失败（七种错误码）→ 按**技术失败中止**：不写临时 payload、不调用 `review-record`、不写 canonical review（`TASK_ISSUE_REQUIRED` = reviewer task 创建路径未按 FR-B12 携带 Issue 上下文，修复创建路径后重试；禁止静默跳过绑定继续评审）；
   - 无 Multica task context 的本地执行 → 跳过绑定，继续现有行为（FR-A7）。
1. 把判断写入非受控临时 payload `.crctl/tmp/review-dev-plan.yml`（已被 .crctl/.gitignore 忽略）：

```yaml
verdict: pass | block
repair-target: write-dev-plan | write-tech-design   # 顶层可选字段，缺省 write-dev-plan；上游设计疑点写 write-tech-design（D-13）
blockers: []                    # 纯字符串列表；crctl 不解析字符串路由
dimensions:                     # 八类维度 + 元信息
  sdd-to-plan: pass | block
  plan-to-tasks: pass | block
  task-executability: pass | block
  dependency-topology: pass | block
  interface-contracts: pass | block
  acceptance-verifiability: pass | block
  scope-and-simplicity: pass | block
  risk-and-rollback: pass | block
  reviewer-model: "<model/runner self report>"
suggestions: []
```

2. 运行 `crctl review-record {cr_id} --stage dev-plan --bump-attempt --workspace <worktree>`，crctl 完成确定性部分：schema 校验（含 repair-target 枚举）、bump 前路由判定（upstream 跳过 bump）、注入 reviewer/reviewed-at、CAS 写 canonical `review-annotations/dev-plan.yml`、级联 review-loop 记账与 traceability 投影、删除临时 payload。
3. 模型不得直接写 `review-annotations/dev-plan.yml` 或手写 review-loop（guard deny + crctl 独占）。

### Step 4 — 路由处理（双轨，CR-2026-026 FR-6/FR-6a/FR-6b）

按 annotation 顶层 `repair-target`（或 review-record 输出的 route）分流：

- **PASS**（verdict=pass 且 blockers=[]）：保持 `task-breakdown`，输出摘要，进入现有 push-progress → human_approval → approve-dev-start。**证据绑定（CR-2026-039）**：PASS 落盘时 crctl 将 plan.md + 全部 `TASK-*.md` 的 composite digest 写入 annotation `subject-sha256`；此后 plan/TASK 正文任何修订都会使旧 PASS 失效——`crctl next` 改建议重审/重建（按缺失类型路由 review-dev-plan/write-dev-plan/write-dev-tasks），`approve-dev-start`（含 grant）硬失败零写入；重跑一次 review-dev-plan 即刷新证据。
- **NORMAL**（repair-target=write-dev-plan，缺省）：调用 `crctl advance --to tech-design-reviewed --trigger "review-dev-plan:block -> write-dev-plan" --expect task-breakdown --embedded` 完成回退（CR-2026-030 FR-8：权威完整 trigger），pipeline 按 write-dev-plan → write-dev-tasks → review-dev-plan 重放（≤3 轮）。
- **UPSTREAM**（repair-target=write-tech-design）：调用 `crctl advance --to tech-design-review-pending --trigger review-dev-plan:upstream-design-blocker --expect task-breakdown --embedded` 回退到 `tech-design-review-pending`，停止自动重放，输出结构化业务结果 `UPSTREAM_DESIGN_BLOCKER`（含 route=upstream、verdict=block、review feedback 与回退状态），由人工走既有技术设计修订、重新评审与审批流程。本节点不得修改或覆盖 `review-annotations/sdd.yml`（US-5）。

### Step 5 — 输出摘要

```
✅ 开发计划与 TASK 合并评审完成
   CR        : {cr_id}
   Verdict   : {PASS / BLOCK}
   Route     : {pass / normal / upstream}
   Blockers  : {N} 条（若有，逐条列出）
   下一步    : 以 `crctl next {cr_id}` 为准（PASS→人工审批；NORMAL→重放回修；UPSTREAM→技术设计链路）
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| prd.md/sdd.md/plan.md/tasks 缺失 | 停止执行，先跑对应生产节点 |
| CR status 非 task-breakdown/tech-design-reviewed | 停止执行，展示当前状态 |
| repair-target 非法值 | crctl review-record 返回 SCHEMA_INVALID，修正 payload 重跑 |
| 达到 maxAttempts=3 仍 block | LOOP_EXHAUSTED 停止，不进入 human approval |

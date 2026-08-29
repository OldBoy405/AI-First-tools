---
name: review-tech-design
description: 对 change-requests/{CR-ID}/sdd.md 执行技术评审，检查 PRD↔SDD 对齐度、架构合理性与风险；未通过时回到 write-tech-design 自修复。
---
<!-- lint-prompts:ignore --> 描述性说明：评审批注输出到 review-annotations（实际写入走 crctl review-record）

# Skill: review-tech-design

**类型**: 开发期 Skill（develop/ 组）
**调用时机**: architecture-design pipeline 第 2 节点，人工审批前
**前置要求**: CR status = `tech-design-review-pending`（由 write-tech-design 落盘后推进）

---

## 用途

对 SDD 执行结构化技术评审并输出评审批注（经 `crctl review-record` 落盘为 review-annotations 记录）。评审通过时保持 CR status=`tech-design-review-pending`，等待 `approve-tech-design` 在人工审批后推进到 `tech-design-reviewed`；有 blocker 时回退至 `tech-designing`，并由 pipeline `reviewLoop` 自动回到 `write-tech-design` 修订。blocker 未清空前不得进入 `human_approval`。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `workspace` | string | ✅ | 业务权威路径（`crctl workspace inspect` 的 operationalWorkspace 原样值）；用于读取 PRD/SDD/架构文档 |
| `resources` | array | ✅ | `crctl workspace inspect` 的 resources 原样值，元素含 `repo`、`worktreePath`；代码事实只按 `resources[].worktreePath` 取证，不拼接 `.rayai-worktrees`、不回退主工作区 |
| `reviewer` | string | ❌ | 评审人 ID；为空则填写 "ai-reviewer" |
| `review_feedback` | object | ❌ | 当前 reviewLoop 的回修反馈（上一轮 blockers）；存在时进入回修复核 |
| `self_repair_attempt` | number | ❌ | 当前 reviewLoop 轮次；首次评审为 0，自修复后由 pipeline 注入 |

`workspace` 用于过程文档，`resources[].worktreePath` 用于代码事实，两者不得混用。

---

## 执行步骤

### Step 1 — 读取输入

以 `workspace` 读取过程文档：`change-requests/{cr_id}/prd.md`（获取 FR 列表）、`change-requests/{cr_id}/sdd.md`（待评审文档）；架构约束参考只从 `resources[]` 中目标仓的 `worktreePath` 读取（若 `write-tech-design` 本轮标注"新起草"，一并快速核查内容是否贴合仓库实际，视为本轮"架构合理性"维度的一部分，不单独加审批节点）。代码事实取证只按 `resources[].worktreePath`，不使用目录命名拼接、主工作区回退或会话记忆替代；`workspace` 与 `resources` 概念不得混用。

### Step 2 — 评审维度

| 维度 | 检查项 |
|------|-------|
| **PRD↔SDD 对齐** | 每条 FR-* 是否有对应技术方案；无遗漏 |
| **架构合理性** | 是否符合 ARCHITECTURE.md 约束，模块边界清晰；决策记录是否满足三判据（难以逆转 + 无上下文会疑惑 + 有真实权衡替代，同时满足才记录；不伪造替代） |
| **数据模型完整性** | 核心实体是否完整，无遗漏字段 |
| **接口契约** | 接口定义是否清晰，类型是否完整；**条件基线（FR-08.2）**：仅当方案新增/修改 HTTP API 时才要求接口契约，且以目标仓 `ARCHITECTURE.md`/既有 OpenAPI 约定优先，不强制复数名/kebab-case/固定错误结构/全列表分页/固定状态码/一律 201+Location |
| **多仓架构约束**（FR-08.4） | 多仓 CR 的跨仓依赖方向、路径 authority（`resources[].worktreePath`，无 `.rayai-worktrees/` 拼接）与各仓提交/checkpoint 口径是否与架构约束一致 |
| **性能与安全** | 关键路径是否有性能考量，安全控制点是否完备 |
| **可测试性** | 技术方案是否易于单元/集成测试 |
| **Prompt 采纳影响**（CR-2026-021 FR-25，条件性） | 若本 CR 的 diff 触及 `crctl.mjs` dispatch 或 `rules.json#protectedPaths.deny`，SDD 第 8 节必须存在且列出应改为调用新增/扩展子命令的 skill 清单；缺失记为 blocker（`lint-prompts` 抓不到"新增能力未被采纳"这类漂移，只能由本维度人工兜底）。不触及上述两处则本项跳过 |

### Step 2.1 — AC 闭环与既有实现依赖核验

在既有 8 个维度检查过程中，对 PRD 的每条 AC 执行闭环判定：

```text
if no_design_landing(ac): blocker("缺少设计落点")
else if landing_cannot_produce_observable_result(ac): blocker("结果不可观察")
else if prerequisite_filters_required_target(ac): blocker("关键前置条件使 AC 不可达")
else: pass with landing + observable + reachability evidence
```

这是既有「PRD↔SDD 对齐」与「可测试性」维度的细化，不新增 annotation dimension；关键前置条件包括过滤条件、状态门槛、权限判定、事件触发顺序、空值分支和跨仓依赖初始化。

只核验 SDD 明确写入且设计成立依赖的既有实现事实，不做全仓库无界扫描：对每项依赖按 `resources` 找到匹配 `repo`，用受控只读取证 `crctl git rev-parse HEAD` 取 commit SHA，并核验文件/稳定符号；事实缺失或行为不符形成业务 blocker（附 repo/SHA/path/symbol/conclusion 证据），资源缺失或不可读为技术失败且不写临时 payload。SDD 正文存在但未列入依赖清单的同类事实引用形成 blocker；只有正文与依赖清单均无依赖时才记录 `N/A（本 CR 无既有实现依赖）`。行号只作辅助，不作唯一证据；评审不执行 lint/build/test。

### Step 2.2 — 首轮全量汇总与回修复核

首轮必须完成全部适用维度后再统一生成 verdict，不得在首个 blocker 处提前结束；合并同根因问题、拆分不同根因问题，同一轮 blockers 同时包含独立根因。存在 `review_feedback`、上一轮 `review-annotations/sdd.yml` verdict=block 或 `self_repair_attempt > 0` 时进入回修复核：逐条复核旧 blocker（已解决/部分解决/未解决/需重新判断），本轮变化影响的维度重新核验，未受影响维度给出有依据的快速复核（不无证据继承旧 PASS），新独立 blocker 同轮加入；继续使用既有 `maxAttempts=3`，达到上限停止自动回修且不 reset cycle。review-record 与既有 replayNodes 不改变。

### Step 3 — 平台绑定前置步骤 + 写评审批注 — 评审判断写临时 payload，canonical 写入交 crctl review-record（S1）

0. **平台绑定前置步骤（FR-B7，CR-2026-053）**：若当前运行具有 Multica task-scoped context（`mat_` task token 注入的 task 上下文）：
   - 先执行 `multica cr bind-current-task {cr_id}`，把当前 reviewer task 绑定到 CR 及其来源 Issue；
   - 绑定失败（七种错误码）→ 按**技术失败中止**：不写临时 payload、不调用 `review-record`、不写 canonical review（`TASK_ISSUE_REQUIRED` = reviewer task 创建路径未按 FR-B12 携带 Issue 上下文，修复创建路径后重试；禁止静默跳过绑定继续评审）；
   - 无 Multica task context 的本地执行 → 跳过绑定，继续现有行为（FR-A7）。
1. 完成上述评审后，把**判断**写入非受控临时 payload `.crctl/tmp/review-tech-design.yml`（该路径不在 guard deny 面，且已被 `.crctl/.gitignore` 忽略）：
   ```yaml
   verdict: pass | block
   blockers: []          # block 时列出 blocker（字符串列表）
   dimensions: {评审维度: 结论, ...}   # 该 stage 门禁要求的维度齐全
   suggestions: []       # 可选
   ```
2. 运行 `crctl review-record {cr_id} --stage tech-design --bump-attempt --workspace <worktree>`（`--from` 缺省即 `.crctl/tmp/review-tech-design.yml`，无需显式指定），crctl 自动完成**确定性部分**：
   - schema 校验（verdict 枚举/blockers 列表/dimensions 齐全；失败 `SCHEMA_INVALID` 不写）
   - stage→文件名显式映射（tech-design→sdd.yml 非同名）
   - 注入 reviewer=identity(ws)/reviewed-at=nowIso()，CAS 写入 canonical `review-annotations/sdd.yml`
   - `--bump-attempt` 级联 `crctl attempt` 记账（review-loop.yml，crctl 独占）
   - 成功后删除临时 payload（避免残留/跨 CR 串味）
3. **模型不得直接 Write `review-annotations/sdd.yml` 或手写 review-loop**（guard deny + crctl 独占写）。

### Step 4 — 按 review-record 输出组织提交与分流（CR-2026-027 FR-13）

`crctl review-record` 已同批写入 annotation + review-loop + traceability（三账本原子），成功即表示写入完成，**不再重新读取 traceability 核对**。按返回结果处理：

- 按 `files[]` 组织 git 提交（提交本次实际写入的文件）；
- 按 `route` 分流：`pass` → 保持 `tech-design-review-pending` 允许进入 `human_approval`；`repair` → 输出 `repair-target`；
- 最后调用 `crctl next {cr_id}` 确认下一步（next 由 crctl 唯一计算）。
- 有 blocker → 调用 `crctl advance --to tech-designing --trigger "review-tech-design:block -> write-tech-design" --expect tech-design-review-pending`，输出 `repair-target=write-tech-design`，pipeline 自动带 `review_feedback` 回到 SDD 修订节点；不得进入 `human_approval`

### Step 5 — 输出摘要

```
✅ 技术设计评审完成
   CR          : {cr_id}
   Verdict     : {PASS / BLOCK}
   FR 覆盖率   : {N}/{总数}
   Blockers    : {N} 条
   下一步      : 以 `crctl next {cr_id}` 为准（PASS→等待人工审批；BLOCK→pipeline 自动回对应修复节点重审）
```

## 错误处理

| 错误 | 处理 |
|------|------|
| sdd.md 不存在 | 停止执行，要求先运行 write-tech-design |
| 达到 reviewLoop.maxAttempts 后仍为 block | 停止进入人工审批，输出剩余 blocker 与最后一次修复记录 |

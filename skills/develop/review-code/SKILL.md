---
name: review-code

description: 读取 CR 代码 worktree 的代码 diff、验证日志、change-requests/{CR-ID}/sdd.md、tasks/* 和 test-report.md 执行代码评审；未通过时回到 implement-code 自修复，通过后推进到 code-reviewing。
---

# Skill: review-code

**类型**: 开发期 Skill（develop/ 组，改造自旧 review/review-code）  
**调用时机**: code-implementation pipeline 第 8 节点（代码编写与统一 checkpoint 后）

---

## 用途

在开发者完成编码并推送统一 checkpoint 后，基于 CR 代码 worktree 的只读 diff、验证日志与 CR 设计文档执行代码评审。release snapshot 由 `review-record --stage code` 从本地 healthy committed worktree 构造，不要求远端 requirement ref 已同步；远端发布完整性由 checkpoint/merge 处理（CR-2026-044）。评审通过时推进 CR status 到 `code-reviewing`，等待 `approve-code` 做人工审批；有 blocker 或 `test-report.status=block` 时回退到 `developing`，并由 pipeline `reviewLoop` 自动回到 `implement-code` 修复。blocker 未清空前不得进入 `human_approval`。

<!-- lint-prompts:ignore --> 反例说明：仅凭统计信息不足
> **证据要求**：仅有 `git diff --stat` 或 commit log 不足以支撑代码评审。必须读取实际 diff、变更文件、lint/test/build 输出或明确的不适用说明。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `reviewer` | string | ❌ | 评审人 ID；默认 "ai-reviewer" |
| `review_focus` | string | ❌ | 评审侧重（全量/安全/性能/可维护性/需求对齐），默认全量 |
| `self_repair_attempt` | number | ❌ | 当前 reviewLoop 轮次；首次评审为 0，自修复后由 pipeline 注入 |

---

## 执行步骤

### Step 1 — 获取代码评审证据

在各参与代码仓的 CR worktree 中解析 trunk，并执行只读命令。不要用已推送的 `origin/requirement/{cr_id}...HEAD` 作为唯一 diff range；checkpoint 推送后该范围可能为空。应比较 trunk merge-base 到当前 HEAD：
```bash
crctl git merge-base origin/{trunk} HEAD --cwd <worktree>
crctl git diff --name-only {merge-base}...HEAD --cwd <worktree>
crctl git diff --unified=80 {merge-base}...HEAD --cwd <worktree>
crctl git log --oneline {merge-base}..HEAD --cwd <worktree>
```

验证证据**只读** `change-requests/{cr_id}/test-report.md` 的机器区（`generated-by: crctl-test`）、`traceability.yml#tests` 与 `test-evidence/cmd-NN.log`，**不得重新执行 lint/test/build**（测试执行已收敛为 `crctl test --plan` 单一入口，评审只做只读取证）。以下任一项均形成 blocker 并回到 implement-code：
- `test-report.md` 缺失，或 marker 之前机器区非 `crctl` 生成（`TEST_EVIDENCE_MISSING`）；
- `test-report.md` `status` 非 `pass`（业务失败不得进入评审）；
- `traceability.yml#tests` 与 `test-report.md` 的 `status`/`command-digest` 不一致（`TEST_EVIDENCE_DRIFT`）；
- 任一被 `test-report.md` 引用的 `test-evidence/cmd-NN.log` 缺失。

"看起来通过"、"之前跑过"或 implement-code 自报结果均不构成评审证据；证据不可信就 blocker，回到既有闭环，而非在评审阶段自行重跑验证命令。

### Step 2 — 读取设计文档

- `change-requests/{cr_id}/sdd.md` — 技术设计（接口契约、架构方案）
- `change-requests/{cr_id}/tasks/` — 全部 TASK 文件（验收条件）
- `change-requests/{cr_id}/test-report.md` — 测试报告（lint/test/build、TASK 验收覆盖、未覆盖风险）
- `change-requests/{cr_id}/review-annotations/sdd.yml` — 技术评审记录（了解已知风险点）

### Step 3 — 代码评审

评审维度：

| 维度 | 检查项 |
|------|-------|
| **代码↔TASK↔SDD 对齐** | 实现是否完整覆盖 TASK 验收条件 + SDD 接口契约 |
| **工程质量** | lint / test / build 结论来自 `test-report.md` 与实际命令输出或明确不适用说明 |
| **关键路径可读性** | 核心逻辑是否清晰，注释是否充分 |
| **安全性** | 输入校验、权限控制、敏感数据处理 |
| **测试覆盖** | 是否有对应单元/集成测试 |
| **测试证据可信度** | `test-report.md` 是否覆盖 TASK 验收条件，是否说明未覆盖风险 |
| **前端质量** | 仅 diff 触及 `*.tsx`、`*.vue`、`*.css`、`*.html` 时触发，检查三项：① a11y 对比度达 WCAG AA（破 AA 升 blocker）；② 组件 loading/empty/error 状态完整覆盖；③ 构建体积在预算内。②③ 未达为 minor |

**改进建议处置**：非阻塞发现一律进 `suggestions`，verdict 只判 CR 本身的 pass/block；语义：blockers=本 CR 内要处理的（不论轻重），suggestions=本 CR 内不处理的。

### Step 4 — 平台绑定前置步骤 + 评审判断写临时 payload，canonical 写入交 crctl review-record（S1）

0. **平台绑定前置步骤（FR-B7，CR-2026-053）**：若当前运行具有 Multica task-scoped context（`mat_` task token 注入的 task 上下文）：
   - 先执行 `multica cr bind-current-task {cr_id}`，把当前 reviewer task 绑定到 CR 及其来源 Issue；
   - 绑定失败（七种错误码）→ 按**技术失败中止**：不写临时 payload、不调用 `review-record`、不写 canonical review（`TASK_ISSUE_REQUIRED` = reviewer task 创建路径未按 FR-B12 携带 Issue 上下文，修复创建路径后重试；禁止静默跳过绑定继续评审）；
   - 无 Multica task context 的本地执行 → 跳过绑定，继续现有行为（FR-A7）。
1. 完成上述评审后，把**判断**写入非受控临时 payload `.crctl/tmp/review-code.yml`（不在 guard deny 面，已被 `.crctl/.gitignore` 忽略）：
   ```yaml
   verdict: pass | block
   blockers: []          # block 时列出 blocker（字符串列表）
   dimensions: {评审维度: 结论, ...}   # 该 stage 门禁要求的维度齐全
   suggestions: []       # 可选
   ```
2. 运行 `crctl review-record {cr_id} --stage code --bump-attempt --workspace <worktree>`（`--from` 缺省即 `.crctl/tmp/review-code.yml`，无需显式指定），crctl 自动完成**确定性部分**：
   - schema 校验（verdict 枚举/blockers 列表/dimensions 齐全；失败 `SCHEMA_INVALID` 不写）
   - stage→文件名显式映射（code→code.yml）
   - 注入 reviewer=identity(ws)/reviewed-at=nowIso()，CAS 写入 canonical `review-annotations/code.yml`
   - `--bump-attempt` 级联 `crctl attempt` 记账（review-loop.yml，crctl 独占）
   - 成功后删除临时 payload（避免残留/跨 CR 串味）
3. **模型不得直接 Write `review-annotations/code.yml` 或手写 review-loop**（guard deny + crctl 独占写）。

### Step 5 — 按 review-record 输出组织提交与分流（CR-2026-027 FR-13）

`crctl review-record` 已同批写入 annotation + review-loop + traceability（三账本原子），成功即表示写入完成，**不再重新读取 traceability 核对**。按返回结果处理：

- 按 `files[]` 组织 git 提交（提交本次实际写入的文件）；
- 按 `route` 分流：`pass` → 进入 Step 6；`repair` → 输出 `repair-target` 并路由回修；
- 最后调用 `crctl next {cr_id}` 确认下一步（next 由 crctl 唯一计算）。
- verdict=pass 且 blockers 为空且 `test-report.status=pass` → 调用 `crctl advance --to code-reviewing --trigger review-code --expect developing`，允许进入 `human_approval`
- verdict=block、blockers 非空或 `test-report.status=block` → 调用 `crctl advance --to developing --trigger "review-code:block -> implement-code" --expect developing`，输出 `repair-target=implement-code`，pipeline 自动带 `review_feedback` 回到代码实现节点；不得进入 `human_approval`

### Step 6 — 输出摘要

```
✅ 代码评审完成
   CR          : {cr_id}
   Verdict     : {PASS / BLOCK}
   Critical    : {N} 条
   Major       : {N} 条
   TASK 覆盖率 : {N}/{总数}
   Suggestions : {N} 条
   Policy      : {strict|lenient}
   下一步      : 以 `crctl next {cr_id}` 为准（PASS→等待人工审批；BLOCK→pipeline 自动回对应修复节点重审）
```

## 错误处理

| 错误 | 处理 |
|------|------|
| test-report.md 不存在或 status 非 pass | 返回 block，repair-target=implement-code，要求补齐测试证据 |
| diff 或 changed files 证据缺失 | 返回 block，要求补齐可审查代码证据 |
| 达到 reviewLoop.maxAttempts 后仍为 block | 停止进入人工审批，输出剩余 blocker 与最后一次修复记录 |

---
name: review-code

description: 读取 CR 代码 worktree 的代码 diff、验证日志、change-requests/{CR-ID}/sdd.md、tasks/* 和 test-report.md 执行代码评审；未通过时回到 implement-code 自修复，通过后推进到 code-reviewing。
---

# Skill: review-code

**类型**: 开发期 Skill（develop/ 组，改造自旧 review/review-code）  
**调用时机**: code-implementation pipeline 第 8 节点（代码编写与统一 checkpoint 后）

---

## 用途

在开发者完成编码并推送统一 checkpoint 后，基于 CR 代码 worktree 的只读 diff、验证日志与 CR 设计文档执行代码评审。评审通过时推进 CR status 到 `code-reviewing`，等待 `approve-code` 做人工审批；有 blocker 或 `test-report.status=block` 时回退到 `developing`，并由 pipeline `reviewLoop` 自动回到 `implement-code` 修复。blocker 未清空前不得进入 `human_approval`。

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

对 `implement-code` 节点输出中的验证命令**无条件重新执行**（不以证据缺失为前提）：implement-code 自报结果仅作参考对照，不一致时以本轮重新执行结果为准并在 blockers 注明差异。「测试通过」必须是本轮重新执行的完整命令输出（0 failures），"看起来通过"或"之前跑过"不构成证据；验证命令缺失时要求补齐后再继续：

```bash
pnpm lint
pnpm test
pnpm build
```

Go 服务或其他仓库使用对应仓库的 lint/test/build 命令。若某项不适用，必须在 review 输出中写明原因。目标运行时已装 `verification-before-completion` 时可用其 Gate Function/Common Failures 表作执行细则参考，未装按本节最低要求执行——本条不得弱化为"可选加速"。

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

**改进建议处置策略**（策略参数由 pipeline 触发参数注入，缺省 strict）：

- **strict（默认）**：非阻塞发现一律进 `suggestions`；verdict 只判 CR 本身的 pass/block。
- **lenient**：非阻塞发现同时满足三条判据且通过轮次闸才升格进 `blockers`（同轮多条成批写入）：
  ① 改动不超出本 CR 已触碰的文件（不扩大 diff）；② 有明确的"改成什么"（能写进 repair-instructions，不是"优化一下"）；③ 不需要产品/架构决策（纯实现层）；
  ④ **轮次闸**：仅首轮评审（attempt=1）允许升格；第 2 轮起一律按 suggestions 处理——防升格消耗 maxAttempts 耗尽轮次、停在 developing 无法进入审批。
- **留痕**：dimensions 记录 `suggestion-policy: {strict|lenient}`（canonical，跨 CR 可比）。
- **语义**：blockers=本 CR 内要处理的（不论轻重）；suggestions=本 CR 内不处理的。

### Step 4 — 评审判断写临时 payload，canonical 写入交 crctl review-record（S1）

1. 完成上述评审后，把**判断**写入非受控临时 payload `.crctl/tmp/review-code.yml`（不在 guard deny 面，已被 `.crctl/.gitignore` 忽略）：
   ```yaml
   verdict: pass | block
   blockers: []          # block 时列出 blocker（字符串列表）
   dimensions: {评审维度: 结论, suggestion-policy: strict|lenient, ...}   # 该 stage 门禁要求的维度齐全；suggestion-policy 为本轮策略留痕（canonical）
   suggestions: []       # 可选
   ```
2. 运行 `crctl review-record {cr_id} --stage code --bump-attempt --workspace <worktree>`（`--from` 缺省即 `.crctl/tmp/review-code.yml`，无需显式指定），crctl 自动完成**确定性部分**：
   - schema 校验（verdict 枚举/blockers 列表/dimensions 齐全；失败 `SCHEMA_INVALID` 不写）
   - stage→文件名显式映射（code→code.yml）
   - 注入 reviewer=identity(ws)/reviewed-at=nowIso()，CAS 写入 canonical `review-annotations/code.yml`
   - `--bump-attempt` 级联 `crctl attempt` 记账（review-loop.yml，crctl 独占）
   - 成功后删除临时 payload（避免残留/跨 CR 串味）
3. **模型不得直接 Write `review-annotations/code.yml` 或手写 review-loop**（guard deny + crctl 独占写）。

### Step 5 — 核对 traceability 投影并推进 status

- 核对 `traceability.yml#reviews.code` 投影与 canonical annotation 一致（由 `crctl review-record` 同步写入，CR-2026-025 FR-16；禁止手改账本补齐）
- verdict=pass 且 blockers 为空且 `test-report.status=pass` → 调用 `crctl advance --to code-reviewing --trigger review-code --expect developing`，允许进入 `human_approval`
- verdict=block、blockers 非空或 `test-report.status=block` → 调用 `crctl advance --to developing --trigger "review-code:block -> implement-code" --expect developing`，输出 `repair-target=implement-code`、`repair-instructions`，pipeline 自动带 `review_feedback` 回到代码实现节点；不得进入 `human_approval`

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

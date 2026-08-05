---
name: review-code
<!-- lint-prompts:ignore --> 评审校验说明：只读 test-report 的 status 字段

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

同时读取 `implement-code` 节点输出中的验证命令与结果；若缺失，必须重新运行或要求补齐：

```bash
pnpm lint
pnpm test
pnpm build
```

Go 服务或其他仓库使用对应仓库的 lint/test/build 命令。若某项不适用，必须在 review 输出中写明原因。

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

### Step 4 — 写评审批注

创建 `change-requests/{cr_id}/review-annotations/code.yml`：

```yaml
cr-id: {cr_id}
review-type: code
reviewer: {reviewer}
reviewed-at: {YYYY-MM-DDTHH:mm:ss+08:00}
verdict: pass | block
blockers:
  - id: CODE-BLOCK-001
    severity: critical | major | minor
    file: "{file}:{line-range}"
    issue: "{问题描述}"
    suggestion: "{改进建议}"
repair-target: implement-code
repair-instructions:
  - "按 CODE-BLOCK-001 修复对应文件，并重新运行受影响测试与构建"
review-loop:
  pass-condition:
    allOf:
      - path: verdict
        equals: pass
      - path: blockers
        isEmpty: true
      - path: test-report.status
        equals: pass
  on-block: route-to-repair-node
  max-attempts: 3
  current-attempt: {self_repair_attempt 或 0}
  attempts:
    - attempt: {self_repair_attempt 或 0}
      reviewed-at: {YYYY-MM-DDTHH:mm:ss+08:00}
      result: pass | block
      blocker-count: {N}
      repair-target: implement-code
suggestions: []
task-coverage:
  total: {N}
  verified: {N}
  unverified: []
verification:
  lint: pass | fail | not-applicable
  test: pass | fail | not-applicable
  build: pass | fail | not-applicable
test-report:
  file: "change-requests/{cr_id}/test-report.md"
  status: pass | block
  uncovered-risks: []
evidence:
  diff-range: "{merge-base}...HEAD"
  changed-files: []
```

### Step 5 — 更新 traceability.yml 并推进 status

- 在 `change-requests/{cr_id}/traceability.yml` 写入 `reviews.code`，并持久化 `review-loop.current-attempt` 与 `review-loop.attempts[]`
- verdict=pass 且 blockers 为空且 `test-report.status=pass` → 调用 `cr-status-set`（`next_status=code-reviewing`，`trigger=review-code`，`expected_current_status=developing`），允许进入 `human_approval`
- verdict=block、blockers 非空或 `test-report.status=block` → 调用 `cr-status-set`（`next_status=developing`，`trigger=review-code:block -> implement-code`，`expected_current_status=developing`），输出 `repair-target=implement-code`、`repair-instructions`，pipeline 自动带 `review_feedback` 回到代码实现节点；不得进入 `human_approval`

### Step 6 — 输出摘要

```
✅ 代码评审完成
   CR          : {cr_id}
   Verdict     : {PASS / BLOCK}
   Critical    : {N} 条
   Major       : {N} 条
   TASK 覆盖率 : {N}/{总数}
   下一步      : {PASS → human_approval 后调用 approve-code | BLOCK → 自动回到 implement-code 修复、重测、重审}
```

## 错误处理

| 错误 | 处理 |
|------|------|
| test-report.md 不存在或 status 非 pass | 返回 block，repair-target=implement-code，要求补齐测试证据 |
| diff 或 changed files 证据缺失 | 返回 block，要求补齐可审查代码证据 |
| 达到 reviewLoop.maxAttempts 后仍为 block | 停止进入人工审批，输出剩余 blocker 与最后一次修复记录 |

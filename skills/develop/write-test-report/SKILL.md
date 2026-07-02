---
name: write-test-report
description: 汇总 implement-code 的验证命令、TASK 验收条件与测试覆盖证据，生成 change-requests/{CR-ID}/test-report.md；测试证据不通过时回到 implement-code 自修复。
---

# Skill: write-test-report

**类型**: 开发期 Skill（develop/ 组）  
**调用时机**: code-implementation pipeline 中 `implement-code` 之后、`review-code` 之前

## 用途

将代码实现后的验证证据结构化沉淀为 `change-requests/{CR-ID}/test-report.md`。这份报告是代码评审与 `approve-code` 的输入之一，避免测试证据只停留在 Agent 输出或终端日志中。若报告 `status=block`，pipeline 必须把失败命令、缺失证据和未覆盖 TASK 作为 `review_feedback` 回传给 `implement-code` 自修复；`status=pass` 前不得进入 `review-code` 或人工审批。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `source_node` | string | ❌ | implement-code 节点输出引用；为空时读取最近执行记录 |
| `tester` | string | ❌ | 测试执行者；为空则使用 `cr.md owners.test.id` |
| `self_repair_attempt` | number | ❌ | 当前 reviewLoop 轮次；首次检查为 0，自修复后由 pipeline 注入 |

## 执行步骤

### Step 1 — 前置校验

1. 确认 CR status 为 `developing`。
2. 确认 `cr.md owners.test.id` 与 `owners.test.assigned-at` 均存在；若 `tester` 为空，使用该负责人。
3. 确认以下文件存在：
   - `change-requests/{cr_id}/prd.md`
   - `change-requests/{cr_id}/sdd.md`
   - `change-requests/{cr_id}/tasks/TASK-*.md`
4. 读取 `implement-code` 节点输出中的验证命令与结果。若缺失，返回 `TEST_EVIDENCE_MISSING`，要求补齐后再继续。

### Step 2 — 汇总验证证据

至少记录：

- lint / test / build 命令、执行目录、结果、时间。
- 每个 TASK 的验收条件是否已有验证证据。
- 新增或修改的测试文件。
- 未覆盖风险与不适用说明。

若某项验证不适用，必须写明原因；不得空白通过。

### Step 3 — 写入 test-report.md

写入 `change-requests/{cr_id}/test-report.md`：

```yaml
---
id: {cr_id}-test-report
type: TEST_REPORT
cr-ref: {cr_id}
tester: {tester}
tester-assigned-at: {cr.md owners.test.assigned-at}
status: pass | block
blockers:
  - id: TEST-BLOCK-001
    issue: "{缺失或失败的验证项}"
    suggestion: "{交回 implement-code 的修复或补证建议}"
repair-target: implement-code
repair-instructions:
  - "{status=block 时列出需要 implement-code 修复或补证的动作；status=pass 时为空数组}"
review-loop:
  pass-condition:
    allOf:
      - path: status
        equals: pass
      - path: blockers
        isEmpty: true
  on-block: route-to-repair-node
  max-attempts: 3
  current-attempt: {self_repair_attempt 或 0}
  attempts:
    - attempt: {self_repair_attempt 或 0}
      generated-at: {YYYY-MM-DDTHH:mm:ss+08:00}
      result: pass | block
      blocker-count: {N}
      repair-target: implement-code
created: {YYYY-MM-DDTHH:mm:ss+08:00}
updated: {YYYY-MM-DDTHH:mm:ss+08:00}
---
```

正文结构：

1. 测试摘要。
2. 验证命令与结果。
3. TASK 验收覆盖矩阵。
4. 新增/修改测试文件。
5. 未覆盖风险。
6. 下一步建议。

### Step 4 — 更新 traceability.yml

在 `change-requests/{cr_id}/traceability.yml` 中写入：

```yaml
tests:
  report: change-requests/{cr_id}/test-report.md
  status: pass | block
  owner: {tester}
  owner-assigned-at: {cr.md owners.test.assigned-at}
  generated-at: {timestamp}
  repair-target: implement-code
  review-loop:
    current-attempt: {self_repair_attempt 或 0}
    max-attempts: 3
    attempts:
      - attempt: {self_repair_attempt 或 0}
        generated-at: {timestamp}
        result: pass | block
        blocker-count: {N}
        repair-target: implement-code
  commands:
    - name: lint
      result: pass | fail | not-applicable
    - name: test
      result: pass | fail | not-applicable
    - name: build
      result: pass | fail | not-applicable
```

### Step 5 — 输出摘要

```
✅ 测试报告已生成
   CR          : {cr_id}
   文件        : change-requests/{cr_id}/test-report.md
   结果        : pass/block
   未覆盖风险  : {N} 项
   自修复轮次  : {self_repair_attempt 或 0}/3
   下一步      : {pass → review-code | block → 自动回到 implement-code 修复后重新生成测试报告}
```

## 错误处理

| 错误 | 处理 |
|------|------|
| `TEST_EVIDENCE_MISSING` | 停止执行，要求补齐 implement-code 的验证命令与结果 |
| TASK 缺少验收条件 | 标记 block，并列出缺失 TASK |
| lint/test/build 有失败 | 标记 block，交回 developing 修复 |
| 达到 reviewLoop.maxAttempts 后仍为 block | 停止进入 review-code 和人工审批，输出剩余失败项 |

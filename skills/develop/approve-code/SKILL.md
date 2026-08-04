---
name: approve-code
description: 记录代码人工审批结论，校验 change-requests/{CR-ID}/review-annotations/code.yml 已通过，并将 CR status 推进到 code-approved。用于 code-implementation pipeline 的 human_approval 之后。
---

# Skill: approve-code

**类型**: 开发期 Skill（develop/ 组，代码审批收口）
**调用时机**: code-implementation pipeline 的 `human_approval` 通过后

## 用途

将代码审查人的人工批准落成可追溯状态。`review-code` 负责结构化评审并推进到 `code-reviewing`；本 Skill 负责确认无 blocker 后推进到 `code-approved`，解锁 writeback pipeline。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | yes | 目标 CR-ID |
| `approver` | string | no | 审批人 ID；为空使用 `cr.md owners.development.id` |
| `notes` | string | no | 审批备注 |

## 执行步骤

1. 读取 `change-requests/{cr_id}/cr.md` frontmatter，确认当前 status 为 `code-reviewing`。
2. 确认 `cr.md owners.development.id` 与 `owners.development.assigned-at` 均存在；若 `approver` 为空，使用该负责人。
3. 确认 `cr.md owners.test.id` 与 `owners.test.assigned-at` 均存在。
4. 读取 `change-requests/{cr_id}/review-annotations/code.yml`，确认 `verdict=pass` 且 blockers 为空。
5. 确认 `change-requests/{cr_id}/test-report.md` 存在且 frontmatter `status=pass`，并确认其 `tester` 与 `owners.test.id` 一致；若不一致，必须在 approval.yml 记录偏差说明。
6. 确认 `review-annotations/code.yml` 包含验证命令记录：lint/test/build 均为 pass，或明确标记不适用并说明原因，并引用 `test-report.md`。
7. 写入或更新 `change-requests/{cr_id}/approval.yml` 的 `code` 段：

```yaml
code:
  approver: {approver}
  approved-at: {YYYY-MM-DDTHH:mm:ss+08:00}
  owner-role: development
  test-owner: {cr.md owners.test.id}
  notes: "{notes 或 ''}"
  review-ref: "change-requests/{cr_id}/review-annotations/code.yml"
  test-report-ref: "change-requests/{cr_id}/test-report.md"
```

8. 调用 `cr-status-set`（`next_status=code-approved`，`trigger=approve-code`，`expected_current_status=code-reviewing`）将 status 推进为 `code-approved`。
9. 输出摘要与下一步：`writeback` pipeline。

## 错误处理

| 场景 | 行为 |
|------|------|
| status 不是 `code-reviewing` | abort，输出当前 status 与允许的下一步 |
| code 评审不存在或 verdict 非 pass | abort，要求先修复代码并重新运行 `review-code` |
| test-report 不存在或 status 非 pass | abort，要求先运行 `write-test-report` 或修复测试失败项 |
| 验证命令缺失 | abort，要求补充 lint/test/build 或不适用说明 |
| cr-status-set 失败 | 回滚本次 approval.yml 修改，保持原 status |

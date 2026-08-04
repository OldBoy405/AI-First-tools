---
name: approve-tech-design
description: 记录架构设计人工审批结论，校验 change-requests/{CR-ID}/review-annotations/sdd.yml 已通过，并将 CR status 推进到 tech-design-reviewed。用于 architecture-design pipeline 的 human_approval 之后。
---

# Skill: approve-tech-design

**类型**: 开发期 Skill（develop/ 组，架构审批收口）
**调用时机**: architecture-design pipeline 的 `human_approval` 通过后

## 用途

将人工审批从提示动作变成可审计的状态推进动作。`review-tech-design` 只负责 AI/结构化评审；本 Skill 负责在人工确认后写入审批记录并解锁 `/coding`。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | yes | 目标 CR-ID |
| `approver` | string | no | 审批人 ID；为空使用 `cr.md owners.development.id` |
| `notes` | string | no | 审批备注 |

## 执行步骤

1. 读取 `change-requests/{cr_id}/cr.md` frontmatter，确认当前 status 为 `tech-design-review-pending`。
2. 确认 `cr.md owners.development.id` 与 `owners.development.assigned-at` 均存在；若 `approver` 为空，使用该负责人。
3. 读取 `change-requests/{cr_id}/review-annotations/sdd.yml`，确认 `verdict=pass` 且 blockers 为空。
4. 写入或更新 `change-requests/{cr_id}/approval.yml` 的 `tech-design` 段：

```yaml
tech-design:
  approver: {approver}
  approved-at: {YYYY-MM-DDTHH:mm:ss+08:00}
  owner-role: development
  notes: "{notes 或 ''}"
  sdd-ref: "change-requests/{cr_id}/sdd.md"
  review-ref: "change-requests/{cr_id}/review-annotations/sdd.yml"
```

5. 调用 `cr-status-set`（`next_status=tech-design-reviewed`，`trigger=approve-tech-design`，`expected_current_status=tech-design-review-pending`）将 status 推进为 `tech-design-reviewed`。
6. 输出摘要与下一步：`coding` pipeline。

## 错误处理

| 场景 | 行为 |
|------|------|
| status 不是 `tech-design-review-pending` | abort，输出当前 status 与允许的下一步 |
| sdd 评审不存在或 verdict 非 pass | abort，要求先修复并重新运行 `review-tech-design` |
| cr-status-set 失败 | 回滚本次 approval.yml 修改，保持原 status |

---
name: approve-requirement
description: 需求审批通过后的收尾动作：在 approval.yml 记录审批结论，将 CR status 推进到 requirement-approved，供 architecture-design pipeline 解锁使用。
---

# Skill: approve-requirement

**类型**: 需求期 Skill（requirement/ 组，收尾节点）  
**调用时机**: requirement-authoring pipeline 最后节点（human_approval 通过后）

---

## 用途

人工审批通过后，正式完成需求审批流程：记录审批人与审批时间，将 CR status 推进到 `requirement-approved`，该状态是 architecture-design pipeline 的前置 gate。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `approver` | string | ❌ | 审批人 ID；为空则使用 `cr.md owners.requirement.id` |
| `notes` | string | ❌ | 审批备注（可选，写入 approval.yml） |

---

## 执行步骤

### Step 1 — 前置校验

1. 确认 `change-requests/{cr_id}/cr.md` 存在
2. CR status 必须为 `requirement-reviewing`
3. 确认 `change-requests/{cr_id}/review-annotations/requirement.yml` 存在，且 `verdict=pass`、blockers 为空
4. 确认 `cr.md owners.requirement.id` 与 `owners.requirement.assigned-at` 均存在；若 `approver` 为空，使用该负责人作为审批人

### Step 2 — 写 approval.yml

创建 `change-requests/{cr_id}/approval.yml`：

```yaml
cr-id: {cr_id}
stage: requirement
approver: {approver}
approved-at: {YYYY-MM-DDTHH:mm:ss+08:00}
owner-role: requirement
notes: "{notes 或 ''}"
prd-ref: "change-requests/{cr_id}/prd.md"
review-ref: "change-requests/{cr_id}/review-annotations/requirement.yml"
```

### Step 3 — 推进 CR status

调用 `cr-status-set`：
```
cr_id: {cr_id}
next_status: requirement-approved
trigger: approve-requirement
expected_current_status: requirement-reviewing
```

同步更新 `change-requests/{cr_id}/cr.md` frontmatter 的 `status` 字段。

### Step 4 — 输出摘要

```
✅ 需求审批完成
   CR       : {cr_id}
   Status   : requirement-approved
   Approver : {approver}
   下一步   : 执行 architecture-design pipeline（trigger: architecture, cr_id: {cr_id}）
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| CR status 非 `requirement-reviewing` | 停止执行，提示当前状态，要求先完成评审 |
| 需求评审不存在或未通过 | 停止执行，要求先修复 PRD 并重新运行 review-requirement |
| cr-status-set 失败 | 回滚 approval.yml 写入，保持原 status |

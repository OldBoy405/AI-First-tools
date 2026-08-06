---
name: feedback-writeback
description: "将实施结论写回 traceability.yml"
---

# Skill: feedback-writeback

**类型**: 原子 Skill  
**触发时机**: feature-writeback pipeline 归档后，或 rejected/withdrawn 结论需要补充经验记录时由人工触发

---

## 用途

将 CR 实施结论（验收结果、偏差记录、经验教训）写回到关联的 spec traceability.yml 和 docs/ 知识库，形成闭环可追溯记录。避免变更知识孤岛——确保 CR 的决策依据和实施偏差能被后续开发者查阅。

---

## 前置条件

| 条件 | 说明 |
|------|------|
| CR 状态 | `archived`、`rejected` 或 `withdrawn`（已有结论） |
| target-kind | 当前仅支持 `spec`（`target.refs` 中 spec 类型） |

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr-id` | string | ✅ | CR 标识符（如 `CR-2026-001`） |
| `outcome` | enum | ✅ | `accepted`（已完成回写）/ `rejected` / `withdrawn` |
| `deviation` | string | ❌ | 实施偏差说明（实际实施与 PRD/SDD/TASK 不一致之处） |
| `lessons` | string | ❌ | 经验教训（供后续 CR 参考） |
| `write-tech-note` | bool | ❌ | 是否将 lessons 追加到 docs/tech-notes/，默认 `false` |

---

## 操作步骤

### Step 1 — 读取 CR 上下文

<!-- lint-prompts:ignore --> 描述性：反馈回写说明
1. 读取 `change-requests/{cr-id}/cr.md` frontmatter，获取：
   - `target.refs`（关联 spec 列表）
   - `type`（变更类型）
   - `title`
2. 读取 `change-requests/{cr-id}/prd.md`、`sdd.md`、`tasks/` 与 review-annotations；若存在历史补丁式 `delta-spec.md`，仅作为兼容输入只读展示，不能作为主流程状态依据

### Step 2 — 写回 traceability.yml

对 `target.refs` 中每个 spec（`target.kind=spec` 的条目）：

1. 定位 `specs/{spec-id}/traceability.yml`
2. 在 `change-requests` 段（若无则新建该段）追加一条记录：
   ```yaml
   change-requests:
     - cr-id: {cr-id}
<!-- lint-prompts:ignore --> 描述性：反馈回写说明
       title: {cr.md frontmatter.title}
<!-- lint-prompts:ignore --> 描述性：反馈回写说明
       type: {cr.md frontmatter.type}
      outcome: {outcome}       # accepted | rejected | withdrawn
      deviation: "{deviation 或 none}"
      recorded-at: "YYYY-MM-DDTHH:mm:ss+HH:mm"
   ```
3. 若 `outcome=accepted`：在 traceability.yml 的 `deltas` 段补充：
   ```yaml
   deltas:
     - cr-id: {cr-id}
       applied-at: "YYYY-MM-DDTHH:mm:ss+HH:mm"
      sections-modified: [从 prd.md / sdd.md / tasks/ 解析的 section-id 列表]
   ```

### Step 3 — 写回 docs/tech-notes/（可选）

若 `write-tech-note=true` 且 `lessons` 非空：

1. 创建或追加文件 `docs/tech-notes/cr-lessons-learned.md`
2. 追加格式：
   ```markdown
<!-- lint-prompts:ignore --> 描述性：反馈回写说明
   ## {cr-id} — {cr.md.title}

   **日期**: YYYY-MM-DDTHH:mm:ss+HH:mm  
   **变更类型**: {type}  
   **outcome**: {outcome}

   ### 经验教训

   {lessons}

   ---
   ```

### Step 4 — emit 写回事件

调用 `crctl inbox-emit`（CLI 形态，接口对齐 CR-2026-022 FR-15；`target/timestamp` 非接口参数，`outcome/specs-updated` 塞进 payload）：
```text
crctl inbox-emit {cr-id} --event feedback-writeback-done --to {owners.*.id 或 feedback 发起人} --payload '{"outcome": "{outcome}", "specs-updated": ["{spec-id}", ...]}' --workspace <worktree>
```

---

## 输出

```
✅ feedback-writeback 完成
   cr-id     : {cr-id}
   outcome   : {outcome}
   specs 回写 : {N} 个 traceability.yml 已更新
   tech-note : {已追加 | 跳过}
```

---

## 错误码

| 错误码 | 含义 | 处理方式 |
|--------|------|----------|
<!-- lint-prompts:ignore --> 描述性：反馈回写说明
| `FWB_CR_NOT_FOUND` | 找不到 change-requests/{cr-id}/cr.md | 检查 cr-id 是否正确 |
| `FWB_OUTCOME_REQUIRED` | outcome 参数缺失 | 必须明确传入 accepted 或 rejected |
| `FWB_TARGET_NOT_SPEC` | target.refs 中存在非 spec 类型 | 当前版本仅支持 spec；其他类型跳过并提示 |
| `FWB_TRACEABILITY_NOT_FOUND` | specs/{spec-id}/traceability.yml 不存在 | 手动创建空 traceability.yml 后重试 |

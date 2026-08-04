---
name: review-tech-design
description: 对 change-requests/{CR-ID}/sdd.md 执行技术评审，检查 PRD↔SDD 对齐度、架构合理性与风险；未通过时回到 write-tech-design 自修复。
---

# Skill: review-tech-design

**类型**: 开发期 Skill（develop/ 组）
**调用时机**: architecture-design pipeline 第 2 节点，人工审批前
**前置要求**: CR status = `tech-design-review-pending`（由 write-tech-design 落盘后推进）

---

## 用途

对 SDD 执行结构化技术评审并输出评审批注到 `review-annotations/sdd.yml`。评审通过时保持 CR status=`tech-design-review-pending`，等待 `approve-tech-design` 在人工审批后推进到 `tech-design-reviewed`；有 blocker 时回退至 `tech-designing`，并由 pipeline `reviewLoop` 自动回到 `write-tech-design` 修订。blocker 未清空前不得进入 `human_approval`。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `reviewer` | string | ❌ | 评审人 ID；为空则填写 "ai-reviewer" |
| `self_repair_attempt` | number | ❌ | 当前 reviewLoop 轮次；首次评审为 0，自修复后由 pipeline 注入 |

---

## 执行步骤

### Step 1 — 读取输入

读取：
- `change-requests/{cr_id}/prd.md` — 获取 FR 列表
- `change-requests/{cr_id}/sdd.md` — 待评审文档
- `ARCHITECTURE.md` — 架构约束参考（若 `write-tech-design` 本轮标注"新起草"，一并快速核查内容是否贴合仓库实际，视为本轮"架构合理性"维度的一部分，不单独加审批节点）

### Step 2 — 评审维度

| 维度 | 检查项 |
|------|-------|
| **PRD↔SDD 对齐** | 每条 FR-* 是否有对应技术方案；无遗漏 |
| **架构合理性** | 是否符合 ARCHITECTURE.md 约束，模块边界清晰 |
| **数据模型完整性** | 核心实体是否完整，无遗漏字段 |
| **接口契约** | 接口定义是否清晰，类型是否完整 |
| **性能与安全** | 关键路径是否有性能考量，安全控制点是否完备 |
| **可测试性** | 技术方案是否易于单元/集成测试 |

### Step 3 — 写评审批注

创建 `change-requests/{cr_id}/review-annotations/sdd.yml`：

```yaml
cr-id: {cr_id}
review-type: tech-design
reviewer: {reviewer}
reviewed-at: {YYYY-MM-DDTHH:mm:ss+08:00}
verdict: pass | block
blockers:
  - id: SDD-BLOCK-001
    location: "第 3.2 节 数据模型"
    issue: "缺少 user_id 外键约束说明"
    suggestion: "补充数据完整性约束"
repair-target: write-tech-design
repair-instructions:
  - "补充第 3.2 节 user_id 外键约束、失败场景与测试映射"
review-loop:
  pass-condition:
    allOf:
      - path: verdict
        equals: pass
      - path: blockers
        isEmpty: true
  on-block: route-to-repair-node
  max-attempts: 3
  current-attempt: {self_repair_attempt 或 0}
  attempts:
    - attempt: {self_repair_attempt 或 0}
      reviewed-at: {YYYY-MM-DDTHH:mm:ss+08:00}
      result: pass | block
      blocker-count: {N}
      repair-target: write-tech-design
suggestions: []
fr-coverage:
  total: {N}
  covered: {N}
  missing: []
```

### Step 4 — 更新 traceability.yml 并处理 status

- 在 `change-requests/{cr_id}/traceability.yml` 写入 `reviews.tech-design`，并持久化 `review-loop.current-attempt` 与 `review-loop.attempts[]`
- 通过评审（无 blocker）→ 保持 status=`tech-design-review-pending`，允许进入 `human_approval`
- 有 blocker → 调用 `cr-status-set`（`next_status=tech-designing`，`trigger=review-tech-design:block -> write-tech-design`，`expected_current_status=tech-design-review-pending`），输出 `repair-target=write-tech-design`、`repair-instructions`，pipeline 自动带 `review_feedback` 回到 SDD 修订节点；不得进入 `human_approval`

### Step 5 — 输出摘要

```
✅ 技术设计评审完成
   CR          : {cr_id}
   Verdict     : {PASS / BLOCK}
   FR 覆盖率   : {N}/{总数}
   Blockers    : {N} 条
   下一步      : {PASS → human_approval 后调用 approve-tech-design | BLOCK → 自动回到 write-tech-design 修复后重审}
```

## 错误处理

| 错误 | 处理 |
|------|------|
| sdd.md 不存在 | 停止执行，要求先运行 write-tech-design |
| 达到 reviewLoop.maxAttempts 后仍为 block | 停止进入人工审批，输出剩余 blocker 与最后一次修复记录 |

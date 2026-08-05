---
name: review-requirement
description: 对 change-requests/{CR-ID}/prd.md 进行质量评审，将评审意见写入 review-annotations/requirement.yml；未通过时回到 write-requirement-prd 自修复，通过后推进到 requirement-reviewing。
---

# Skill: review-requirement

**类型**: 需求期 Skill（requirement/ 组）  
**调用时机**: requirement-authoring pipeline 第 4 节点（push-progress 之后）

---

## 用途

对 PRD 文档执行结构化质量评审：完整性检查、可测试性验证、范围合理性判断。将评审结论写入 `change-requests/{CR-ID}/review-annotations/requirement.yml`，同时更新 `traceability.yml`。只有 `verdict=pass` 且 `blockers=[]` 时，才将 CR status 推进到 `requirement-reviewing` 并允许进入人工审批；有 blocker 时保持或回到 `drafting`，由 pipeline `reviewLoop` 自动回到 `write-requirement-prd` 修复。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `reviewer` | string | ❌ | 评审人 ID；为空则填写 "ai-reviewer" |
| `self_repair_attempt` | number | ❌ | 当前 reviewLoop 轮次；首次评审为 0，自修复后由 pipeline 注入 |

---

## 执行步骤

### Step 1 — 前置校验

1. 确认 `change-requests/{cr_id}/prd.md` 存在
2. CR status 必须为 `drafting` 或 `requirement-reviewing`（允许重审）

### Step 2 — PRD 质量评审

评审维度：

| 维度 | 检查项 |
|------|-------|
| **结构完整性** | 所有必需章节是否存在（概述/用户故事/FR/AC） |
| **FR 可测试性** | 每条 FR 是否有对应 AC，AC 是否可量化 |
| **范围合理性** | 需求范围是否清晰，排除项是否明确 |
| **与规划对齐** | 若有 source 规划报告，FR 是否覆盖规划建议的核心诉求 |
| **依赖识别** | 是否识别了对其他 CR / 特性的依赖 |

### Step 3 — 写评审批注

创建或更新 `change-requests/{cr_id}/review-annotations/requirement.yml`：

```yaml
cr-id: {cr_id}
review-type: requirement
reviewer: {reviewer}
reviewed-at: {YYYY-MM-DDTHH:mm:ss+08:00}
verdict: pass | block
blockers:
  - id: REQ-BLOCK-001
    location: "FR-3"
    issue: "验收标准不可量化"
    suggestion: "补充具体的数值边界"
repair-target: write-requirement-prd
repair-instructions:
  - "补充 FR-3 对应的可量化 AC，明确输入、动作、预期结果与边界值"
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
      repair-target: write-requirement-prd
suggestions:
  - "建议补充非功能需求中的响应时间要求"
```

### Step 4 — 更新 traceability.yml

在 `change-requests/{cr_id}/traceability.yml` 中写入（若文件不存在则新建）：

```yaml
cr-id: {cr_id}
reviews:
  requirement:
    reviewer: {reviewer}
    verdict: {pass|block}
    reviewed-at: {YYYY-MM-DDTHH:mm:ss+08:00}
    blocker-count: {N}
    review-loop:
      current-attempt: {self_repair_attempt 或 0}
      max-attempts: 3
      attempts:
        - attempt: {self_repair_attempt 或 0}
          reviewed-at: {YYYY-MM-DDTHH:mm:ss+08:00}
          result: {pass|block}
          blocker-count: {N}
          repair-target: write-requirement-prd
```

### Step 5 — 更新 CR status

- 若评审通过（无 blocker）：调用 `crctl advance --to requirement-reviewing，`trigger=review-requirement`，`expected_current_status=[drafting, requirement-reviewing]`）将 status 推进到 `requirement-reviewing`，允许进入 `human_approval`
- 若有 blocker：保持或回退到 `drafting`，输出 `repair-target=write-requirement-prd`、`repair-instructions` 与 blocker 列表，pipeline 自动带 `review_feedback` 回到 PRD 修复节点；不得进入 `human_approval`

### Step 6 — 输出摘要

```
✅ 需求评审完成
   CR       : {cr_id}
   Verdict  : {PASS / BLOCK}
   Blockers : {N} 条（若有，逐条列出）
   下一步   : {通过→ 等待人工审批 | 阻塞→ 自动回到 write-requirement-prd 修复后重审}
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| prd.md 不存在 | 停止执行，要求先运行 write-requirement-prd |
| CR status 非预期值 | 输出当前状态，提示是否强制重审 |
| 达到 reviewLoop.maxAttempts 后仍为 block | 停止进入人工审批，输出剩余 blocker 与最后一次修复记录 |

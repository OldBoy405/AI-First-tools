---
name: review-requirement
description: 对 change-requests/{CR-ID}/prd.md 进行质量评审，将评审意见记录为 review-annotations 评审记录（经 crctl review-record 落盘）；未通过时回到 write-requirement-prd 自修复，通过后推进到 requirement-reviewing。
---
<!-- lint-prompts:ignore --> 描述性说明：评审结论写入 review-annotations（实际写入走 crctl review-record）

# Skill: review-requirement

**类型**: 需求期 Skill（requirement/ 组）  
**调用时机**: requirement-authoring pipeline 第 4 节点（push-progress 之后）

---

## 用途

对 PRD 文档执行结构化质量评审：完整性检查、可测试性验证、范围合理性判断。将评审结论记录为 `review-annotations` 评审记录（经 `crctl review-record` 落盘），并更新 `traceability.yml`。只有 `verdict=pass` 且 `blockers=[]` 时，才将 CR status 推进到 `requirement-reviewing` 并允许进入人工审批；有 blocker 时保持或回到 `drafting`，由 pipeline `reviewLoop` 自动回到 `write-requirement-prd` 修复。

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

### Step 3 — 写评审批注 — 评审判断写临时 payload，canonical 写入交 crctl review-record（S1）

1. 完成上述评审后，把**判断**写入非受控临时 payload `.crctl/tmp/review-requirement.yml`（该路径不在 guard deny 面，且已被 `.crctl/.gitignore` 忽略）：
   ```yaml
   verdict: pass | block
   blockers: []          # block 时列出 blocker（字符串列表）
   dimensions: {评审维度: 结论, ...}   # 该 stage 门禁要求的维度齐全
   suggestions: []       # 可选
   ```
2. 运行 `crctl review-record {cr_id} --stage requirement --bump-attempt --workspace <worktree>`（`--from` 缺省即 `.crctl/tmp/review-requirement.yml`，无需显式指定），crctl 自动完成**确定性部分**：
   - schema 校验（verdict 枚举/blockers 列表/dimensions 齐全；失败 `SCHEMA_INVALID` 不写）
   - stage→文件名显式映射（requirement→requirement.yml，tech-design→sdd.yml 非同名）
   - 注入 reviewer=identity(ws)/reviewed-at=nowIso()，CAS 写入 canonical `review-annotations/requirement.yml`
   - `--bump-attempt` 级联 `crctl attempt` 记账（review-loop.yml，crctl 独占）
   - 成功后删除临时 payload（避免残留/跨 CR 串味）
3. **模型不得直接 Write `review-annotations/requirement.yml` 或手写 review-loop**（guard deny + crctl 独占写）。

### Step 4 — 更新 traceability.yml

向 `change-requests/{cr_id}/traceability.yml` 写入 `reviews.requirement` 引用（review-loop 轮次记账已由 `crctl review-record --bump-attempt` 级联完成，见 Step 3）

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

- 若评审通过（无 blocker）：调用 `crctl advance --to requirement-reviewing --trigger review-requirement` 将 status 推进到 `requirement-reviewing`，允许进入 `human_approval`（省略 `--expect`：状态机声明 `drafting→requirement-reviewing` 与 `requirement-reviewing→requirement-reviewing` 两条合法转换，单值写死会误拒合法自环；省略后 `findTransition` 仍拦非法转换）
- 若有 blocker：保持或回退到 `drafting`，输出 `repair-target=write-requirement-prd`、`repair-instructions` 与 blocker 列表，pipeline 自动带 `review_feedback` 回到 PRD 修复节点；不得进入 `human_approval`

### Step 6 — 输出摘要

```
✅ 需求评审完成
   CR       : {cr_id}
   Verdict  : {PASS / BLOCK}
   Blockers : {N} 条（若有，逐条列出）
   下一步   : 以 `crctl next {cr_id}` 为准（PASS→等待人工审批；BLOCK→pipeline 自动回对应修复节点重审）
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| prd.md 不存在 | 停止执行，要求先运行 write-requirement-prd |
| CR status 非预期值 | 输出当前状态，提示是否强制重审 |
| 达到 reviewLoop.maxAttempts 后仍为 block | 停止进入人工审批，输出剩余 blocker 与最后一次修复记录 |

---
name: review-tech-design
description: 对 change-requests/{CR-ID}/sdd.md 执行技术评审，检查 PRD↔SDD 对齐度、架构合理性与风险；未通过时回到 write-tech-design 自修复。
---
<!-- lint-prompts:ignore --> 描述性说明：评审批注输出到 review-annotations（实际写入走 crctl review-record）

# Skill: review-tech-design

**类型**: 开发期 Skill（develop/ 组）
**调用时机**: architecture-design pipeline 第 2 节点，人工审批前
**前置要求**: CR status = `tech-design-review-pending`（由 write-tech-design 落盘后推进）

---

## 用途

对 SDD 执行结构化技术评审并输出评审批注（经 `crctl review-record` 落盘为 review-annotations 记录）。评审通过时保持 CR status=`tech-design-review-pending`，等待 `approve-tech-design` 在人工审批后推进到 `tech-design-reviewed`；有 blocker 时回退至 `tech-designing`，并由 pipeline `reviewLoop` 自动回到 `write-tech-design` 修订。blocker 未清空前不得进入 `human_approval`。

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
| **Prompt 采纳影响**（CR-2026-021 FR-25，条件性） | 若本 CR 的 diff 触及 `crctl.mjs` dispatch 或 `rules.json#protectedPaths.deny`，SDD 第 8 节必须存在且列出应改为调用新增/扩展子命令的 skill 清单；缺失记为 blocker（`lint-prompts` 抓不到"新增能力未被采纳"这类漂移，只能由本维度人工兜底）。不触及上述两处则本项跳过 |

### Step 3 — 写评审批注 — 评审判断写临时 payload，canonical 写入交 crctl review-record（S1）

1. 完成上述评审后，把**判断**写入非受控临时 payload `.crctl/tmp/review-tech-design.yml`（该路径不在 guard deny 面，且已被 `.crctl/.gitignore` 忽略）：
   ```yaml
   verdict: pass | block
   blockers: []          # block 时列出 blocker（字符串列表）
   dimensions: {评审维度: 结论, ...}   # 该 stage 门禁要求的维度齐全
   suggestions: []       # 可选
   ```
2. 运行 `crctl review-record {cr_id} --stage tech-design --bump-attempt --workspace <worktree>`（`--from` 缺省即 `.crctl/tmp/review-tech-design.yml`，无需显式指定），crctl 自动完成**确定性部分**：
   - schema 校验（verdict 枚举/blockers 列表/dimensions 齐全；失败 `SCHEMA_INVALID` 不写）
   - stage→文件名显式映射（tech-design→sdd.yml 非同名）
   - 注入 reviewer=identity(ws)/reviewed-at=nowIso()，CAS 写入 canonical `review-annotations/sdd.yml`
   - `--bump-attempt` 级联 `crctl attempt` 记账（review-loop.yml，crctl 独占）
   - 成功后删除临时 payload（避免残留/跨 CR 串味）
3. **模型不得直接 Write `review-annotations/sdd.yml` 或手写 review-loop**（guard deny + crctl 独占写）。

### Step 4 — 核对 traceability 投影并处理 status

- 核对 `traceability.yml#reviews.tech-design` 投影与 canonical annotation 一致（由 `crctl review-record` 同步写入，CR-2026-025 FR-16；禁止手改账本补齐）

- 通过评审（无 blocker）→ 保持 status=`tech-design-review-pending`，允许进入 `human_approval`
- 有 blocker → 调用 `crctl advance --to tech-designing --trigger "review-tech-design:block -> write-tech-design" --expect tech-design-review-pending`，输出 `repair-target=write-tech-design`、`repair-instructions`，pipeline 自动带 `review_feedback` 回到 SDD 修订节点；不得进入 `human_approval`

### Step 5 — 输出摘要

```
✅ 技术设计评审完成
   CR          : {cr_id}
   Verdict     : {PASS / BLOCK}
   FR 覆盖率   : {N}/{总数}
   Blockers    : {N} 条
   下一步      : 以 `crctl next {cr_id}` 为准（PASS→等待人工审批；BLOCK→pipeline 自动回对应修复节点重审）
```

## 错误处理

| 错误 | 处理 |
|------|------|
| sdd.md 不存在 | 停止执行，要求先运行 write-tech-design |
| 达到 reviewLoop.maxAttempts 后仍为 block | 停止进入人工审批，输出剩余 blocker 与最后一次修复记录 |

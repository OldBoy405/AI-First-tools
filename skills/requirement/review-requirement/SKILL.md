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

#### 首轮完整契约域（CR-2026-057 FR-1）

当 PRD 定义用户可调用契约（HTTP API、CLI 或 Skill 契约）时，首轮必须在生成 verdict 前按下列闭合清单一次检查完该契约域的全部适用项；同一契约域的独立缺口必须出现在同一轮 blockers，不得在首个 blocker 处提前结束、把剩余缺口留给下一轮。缺适用项须显式写 `N/A` 及原因：

| 科目 | 必须一次检查的闭包 |
|---|---|
| HTTP API（PRD 新增或修改时） | endpoint、request、response、error、权限、幂等、状态、验收观察点 |
| crctl / CLI | 命令与 flag、输入约束、JSON/stdout 输出、错误码、调用者约束、幂等、状态副作用、验收观察点 |
| Skill 契约 | 必填参数、落盘路径、允许的状态转换、失败码、与 `crctl` 的唯一写入边界 |

#### blocker / suggestion 分级（CR-2026-057 FR-2）

影响当前实现唯一性或当前验收可达性的缺口必须是 blocker。只影响表达、未来优化或后续 CR 的内容必须是 suggestion。不得把 suggestion 批量升级为 blocker，也不得把当前验收不可达的问题留作 suggestion。

#### 每轮评审报告前缀（CR-2026-057 FR-3，固定句式，可机械核对）

`blockers[]` 与 `suggestions[]` 每条文本必须使用下列固定前缀之一（ASCII 全角冒号 `：`，前缀后可跟空格与正文；禁止自创同义前缀）：

| 前缀 | 含义 | 写入位置 |
|---|---|---|
| `已解决：` | 上一轮某条 blocker 本轮已关闭 | `suggestions`（关闭项不得再进入本轮 `blockers`） |
| `部分解决：` | 上一轮某条 blocker 仍有残留 | `blockers` |
| `未解决：` | 上一轮某条 blocker 本轮仍在 | `blockers` |
| `本轮新增：` | 本轮新发现的 blocker | `blockers` |
| `范围外：` | 不在本 CR 范围，留给后续 CR | `suggestions` |

机械核对规则：

1. 上一轮每条 blocker 必须在本轮 `blockers ∪ suggestions` 中恰好出现一次，且前缀为 `已解决：` / `部分解决：` / `未解决：` 之一；对照键为上一轮文本的稳定标识（若原文以 `B-` 开头取到第一个空白或 `]`，否则取原文）。
2. 本轮新 blocker 必须带 `本轮新增：`，不得伪装成旧 blocker 状态。
3. 首轮（无上一轮 blocker）全部 blocker 使用 `本轮新增：`。
4. 范围外发现只进 `suggestions`，前缀 `范围外：`。

#### 回修必须可重验（CR-2026-057 FR-4）

回修后再评必须按 FR-3 逐条给出旧 blocker 的解决状态，禁止只写「已修复」；不得在报告文本或 canonical 字段中重新引入已删除的旧字段名（见 contract-scan 禁止清单）。

### Step 3 — 平台绑定前置步骤 + 写评审批注 — 评审判断写临时 payload，canonical 写入交 crctl review-record（S1）

0. **平台绑定前置步骤（FR-B7，CR-2026-053）**：若当前运行具有 Multica task-scoped context（`mat_` task token 注入的 task 上下文）：
   - 先执行 `multica cr bind-current-task {cr_id}`，把当前 reviewer task 绑定到 CR 及其来源 Issue；
   - 绑定失败（七种错误码）→ 按**技术失败中止**：不写临时 payload、不调用 `review-record`、不写 canonical review（`TASK_ISSUE_REQUIRED` = reviewer task 创建路径未按 FR-B12 携带 Issue 上下文，修复创建路径后重试；禁止静默跳过绑定继续评审）；
   - 无 Multica task context 的本地执行 → 跳过绑定，继续现有行为（FR-A7）。
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

### Step 4 — 按 review-record 输出组织提交与分流（CR-2026-027 FR-13）

`crctl review-record` 已同批写入 annotation + review-loop + traceability（三账本原子），成功即表示写入完成，**不再重新读取 traceability 核对**。按返回结果处理：

- 按 `files[]` 组织 git 提交（提交本次实际写入的文件）；
- 按 `route` 分流：`pass` → 进入 Step 5；`repair` → 输出 `repair-target` 并路由回修；
- 最后调用 `crctl next {cr_id}` 确认下一步（next 由 crctl 唯一计算）。

### Step 5 — 更新 CR status

- 若评审通过（无 blocker）：调用 `crctl advance --to requirement-reviewing --trigger review-requirement` 将 status 推进到 `requirement-reviewing`，允许进入 `human_approval`（省略 `--expect`：状态机声明 `drafting→requirement-reviewing` 与 `requirement-reviewing→requirement-reviewing` 两条合法转换，单值写死会误拒合法自环；省略后 `findTransition` 仍拦非法转换）
- 若有 blocker：保持或回退到 `drafting`，输出 `repair-target=write-requirement-prd` 与 blocker 列表（每条 blocker 内含可执行修复说明），pipeline 自动带 `review_feedback` 回到 PRD 修复节点；不得进入 `human_approval`

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

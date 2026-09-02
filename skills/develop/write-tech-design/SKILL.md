---
name: write-tech-design
description: 读取 change-requests/{CR-ID}/prd.md，在同目录编写 sdd.md 技术设计文档，覆盖架构/数据模型/接口/算法/选型五大章节。
---

# Skill: write-tech-design

**类型**: 开发期 Skill（develop/ 组）
**调用时机**: architecture-design pipeline 第 1 节点
**前置要求**: 初次生成时 CR status = `requirement-approved`；reviewLoop 回修时允许 CR status = `tech-designing`

---

## 用途

以 PRD 为输入，在 CR worktree 内编写完整 SDD 技术设计文档，落盘到 `change-requests/{CR-ID}/sdd.md`。初次生成时从 `requirement-approved` 进入，开始时将 CR status 推进到 `tech-designing`；落盘完成后推进到 `tech-design-review-pending`（待技术评审）。当 `review-tech-design` 发现 blocker 并把 status 回退到 `tech-designing` 后，本 Skill 必须允许以 reviewLoop 回修模式重新进入。

> ⚠️ **路径约定**：SDD 写入 `change-requests/{CR-ID}/sdd.md`，**不写入 specs/**。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |
| `tech_context` | string | ❌ | 额外技术背景（架构决策/已知约束） |
| `operational_workspace` | string | ✅ | 业务权威路径（`crctl workspace inspect` 的 operationalWorkspace 原样值；code-implementation `implement-code` 同款来源） |
| `resources` | array | ✅ | 各参与仓的 `{repo, worktreePath}` 清单（`crctl workspace inspect` 的 resources 原样值） |
| `review_feedback` | object | ❌ | 来自 review-tech-design 的 blockers；存在时进入自修复模式 |
| `self_repair_attempt` | number | ❌ | 当前自动修复轮次，由 pipeline reviewLoop 注入 |

---

## 执行步骤

### Step 1 — 前置校验

1. 确认 `change-requests/{cr_id}/prd.md` 存在（在 `operational_workspace` 内解析）。
2. 读取本 CR **目标代码仓**根目录的 `ARCHITECTURE.md` 了解整体架构约束。目标代码仓路径**只从 `resources[].worktreePath` 取值**（禁止按 `.rayai-worktrees/{repo.id}/requirement/{cr_id}` 或 `.rayai-worktrees/knowledge-base/requirement/{cr_id}` 目录命名拼接路径）：
   - 独立代码仓：`resources[]` 中 `repo` 匹配该仓的 `worktreePath`
   - 非独立代码目录：`resources[]` 中 knowledge-base 仓的 `worktreePath` 内对应代码路径
   - 多仓 CR：按 `resources[]` 逐仓检查，**不得**因为找不到就退而查找会话中最近读过的其他仓（尤其是本方法论包 `tools` 仓自身）的 `ARCHITECTURE.md` 顶替
   - **仅当本 CR 的目标代码仓就是 `tools` 仓自身**（即本 CR 改的是 `tools/skills`、`crctl.mjs` 等方法论包代码）时，`tools/ARCHITECTURE.md` 才是正确的读取对象；否则它与目标仓无关，绝不可当作参考基线
   - **已存在**：直接读取，继续下一项（读取 CR 当前 status）。
   - **不存在**（该仓首次走到技术设计评审，按需懒加载起草，成本只付一次）：只为本 CR 实际涉及且缺失的仓起草——本 Agent 花一轮读**目标仓自己的**代码（入口文件、目录结构、依赖方向、已有约定），套用 `skills/shared/engineering-docs/templates/ARCHITECTURE-template.md` 填成实际内容（禁止留占位符），落盘到目标仓根目录 `ARCHITECTURE.md`，在所属 `resources[].worktreePath` 内与 `sdd.md` 各仓分别提交；本 CR 未涉及或不缺失的仓不起草。**禁止参考 `tools/ARCHITECTURE.md` 的内容**（其不变量如"零依赖""crctl 单一状态写者"是方法论包自身治理事实，不是通用事实）——只能把它当"8 节骨架长什么样"的结构范例，绝不能抄条款。在 Step 5 输出摘要中标注"新起草 ARCHITECTURE.md（{repo}）"，随本轮 `review-tech-design`/`approve-tech-design` 人工过一眼确认，不另开审批节点。
   - 仅在文件缺失时起草；已存在则只读不改——普通 CR 不得借道修订它（架构级变更需求见该文档自身"维护规则"一节）。
   - **提交口径（FR-07.2）**：ARCHITECTURE.md 与 sdd.md 不再要求"同一 commit"；各仓在所属 `resources[].worktreePath` 分别提交，架构审批后由同一批 checkpoint（`crctl checkpoint`）纳入。
3. 读取 CR 当前 status：
   - 初次生成：必须为 `requirement-approved`，随后调用 `crctl advance --to tech-designing --trigger write-tech-design --expect requirement-approved` 将 status 推进到 `tech-designing`。
<!-- lint-prompts:ignore --> 描述性：回修读取评审记录
   - reviewLoop 回修：若存在 `review_feedback`，或 `change-requests/{cr_id}/review-annotations/sdd.yml` 的 `verdict=block`，允许当前 status 为 `tech-designing`，不得因非 `requirement-approved` abort。
   - 其他状态：停止执行，输出当前 status、是否存在 `review_feedback` 与下一步建议。

### Step 2 — 生成 SDD

<!-- lint-prompts:ignore --> 描述性：回修读取评审记录
若存在 `review_feedback`，或 status=`tech-designing` 且上一轮 `review-annotations/sdd.yml verdict=block`，先进入自修复模式：

<!-- lint-prompts:ignore --> 描述性：回修读取评审记录
1. 读取上一轮 `review-annotations/sdd.yml` 与 `review_feedback.blockers`；若 `review_feedback` 缺失，则从 `sdd.yml` 的 blockers、repair-target 组装修复输入。
2. 按 blockers 内的可执行修复说明修订同一份 `sdd.md`，重点补齐 PRD↔SDD 映射、接口契约、数据模型、风险与测试设计。
3. 不重写已确认的整体方案，除非 blocker 明确要求替换。
4. 输出 `self_repair_attempt` 与仍需人工关注的残余风险，供下一轮 `review-tech-design` 校验。

```yaml
---
id: {cr_id}-sdd
type: SDD
cr-ref: {cr_id}
title: {prd.title} 技术设计
target-version: {cr.md 的 target-version 值}   # 继承 cr.md，禁止 tbd/自行改写（CR-2026-057 FR-13）
status: draft
created: {YYYY-MM-DDTHH:mm:ss+08:00}
updated: {YYYY-MM-DDTHH:mm:ss+08:00}
---
```

章节：
1. **架构概览** — 模块边界、依赖图、关键流程
2. **数据模型** — 核心实体、字段定义、存储方案
3. **接口契约** — API / IPC / 事件接口（OpenAPI 片段或 TypeScript 类型）
4. **关键算法与流程** — 核心逻辑伪代码 / 流程图描述
5. **技术选型与替代方案** — 决策说明与权衡
6. **FR 到技术实现映射** — 每条 FR-* 对应的技术方案条目
7. **安全与性能考量** — 边界条件、性能目标、安全控制点
8. **Prompt 采纳影响**（条件性小节，CR-2026-021 FR-25/AC-15）：**若本 CR 的 diff 会触及 `skills/shared/crctl/scripts/crctl.mjs` 的 dispatch 分支或 `skills/shared/controlled-shell/rules.json` 的 `protectedPaths.deny`（= crctl 命令面或 guard deny 面有新增/变更）**，本节为必填，列出应改为调用新增/扩展子命令的 skill 清单（每项含 skill 路径 + 现状 + 应改为的调用方式），供 `review-tech-design` 与人工审批逐条核对；若本 CR 不触及上述两处，本节可省略。`lint-prompts` 只能机械抓到"prompt 还在做 crctl 已接管/已禁止的事"（CONTRADICTS/STALE），抓不到"crctl 新增了能力、某 skill 该采纳却还没采纳"——这一类必须靠本节 + 评审兜底。
9. **批准范围**（契约必填章节，CR-2026-057 FR-5/FR-6）：承载且仅承载四字段——`scope_in`（当前 CR 必须交付的 FR/AC）、`scope_out`（明确排除的路径和能力）、`zero_diff`（明确不得改动的调用点/签名）、`follow_up`（发现但留给后续 CR 的缺口）；空字段必须显式写 `无` 或 `N/A` 加理由，不得省略章节；不新增独立 ledger 文件、不新增状态。`approve-tech-design` 通过后该节对 PLAN/TASK/code 只读：PLAN/TASK 发现与批准范围冲突时，只能经既有 `review-dev-plan` 双轨回到 `write-tech-design` 或 `write-dev-plan`（不得静默扩大范围、不得把 `follow_up` 或兼容性背景自动转成当前 TASK）；代码阶段发现实际 diff 越界时只回 `implement-code`。

### Step 2.5 — 设计输出收窄（FR-08，CR-2026-050）

**术语硬化（收窄范围）**：只处理进入数据模型 / 状态机 / 接口契约、且存在歧义 / 别名 / 边界风险（影响 FR/AC/角色权限/验收语义）的术语；每个风险术语至少验证一个代表性边界场景；已有 `CONTEXT.md` / 术语表只读沿用；命名冲突记录 `PRD canonical term → 代码别名` 映射；语义冲突**不得自行裁决**——在首次 `crctl advance` 前停止并要求需求负责人澄清。术语预检位于首次状态推进之前。

**HTTP/REST 契约（条件触发基线）**：仅当 PRD / tech_context / 方案表明**新增或修改 HTTP API** 时才编写接口契约；优先级 = 目标仓 `ARCHITECTURE.md` / 既有 OpenAPI → 客户端兼容性 → Skill 默认基线。**不强制**复数名 / kebab-case / 固定错误结构 / 全列表分页 / 固定状态码 / 一律 201+Location；SDD 只写概要、输入、输出、错误、鉴权与条件性幂等分页，复杂接口附最小 OpenAPI 片段。

**决策记录（三判据）**：仅当同时满足「难以逆转 + 无上下文会疑惑 + 有真实权衡替代」时才记录决策（Decision / Context / Alternatives / Consequences）；不伪造替代方案、不新增 ADR 或审批节点。

### Step 2.6 — AC 级输出合同与既有实现证据（CR-2026-055）

第 6 节除逐条 FR 映射外，还必须为 PRD 的每条 AC 提供可核对映射（可并入「AC 逐项设计与验收映射」小节），每项至少包含：

```text
AC-xx
设计落点：负责产生结果的模块、流程、接口或数据字段
可观测结果：评审或测试时能观察到的状态、字段、事件或行为
可达性说明：关键前置条件不会提前过滤掉目标对象
```

涉及既有实现（现有仓库、文件路径、稳定符号、配置键、接口/协议、数据库结构、模块行为、调用顺序或责任边界，且是方案成立前置条件）的断言，必须逐项附证据：`repo`、`commit SHA`、`relative path`、`stable symbol/对象`、`conclusion`；无法绑定这些字段的引用按待核实依赖列出，不得归入 N/A。无既有实现依赖时才明确写 `N/A（本 CR 无既有实现依赖）`，不得用 N/A 掩盖正文中的事实依赖。

### 既有实现依赖与事实

当方案依赖既有实现时，必须在本节按正文首次出现顺序列出每项依赖，使用以下固定结构：

```text
1. repo: <repository id>
   relative path: <path from repository root>
   stable symbol/对象: <symbol, key, interface, module, behavior, or responsibility>
   commit SHA: <40-character SHA>
   依赖结论: <why the current behavior is required by this design>
```

`review-tech-design` 只将本节的有序清单作为 `sdd.explicit_existing_dependencies`，并交叉检查正文是否存在未列出的同类事实引用。无法绑定字段的引用必须列入待核实依赖；只有本节与正文均无既有实现依赖时，才写 `N/A（本 CR 无既有实现依赖）`。

回修模式只按 blocker 和本轮变化定点修订，不无理由重写已确认方案。

**SDD-CLOSE 关闭义务（CR-2026-060 AC-06，与 review-tech-design 成对）**：PRD 中显式延后到 SDD 的设计项（如接口闭包、数据模型、错误码、多仓路径 authority）必须在本 SDD 逐项关闭，并以 `SDD-CLOSE-01` 起编号记录关闭结论；未能关闭的项显式列为待办并在 `review-tech-design` 时标记。与 review-requirement 的七个评审维度使用同一术语集合，不另造同义维度名。

### Step 3 — 落盘并 commit

落盘到 `operational_workspace` 中 `change-requests/{cr_id}/sdd.md`。
Commit：`[cr] write tech design {cr_id}`（白名单前缀 `[cr] `）

### Step 4 — 推进状态至待评审

sdd.md 完整落盘后，调用 `crctl advance --to tech-design-review-pending --trigger write-tech-design-complete --expect tech-designing` 将 CR 推进到「待技术评审」状态，等待 `review-tech-design` 进入。

### Step 5 — 输出摘要

```
✅ SDD 已生成
   文件       : change-requests/{cr_id}/sdd.md
   FR 覆盖率  : {N}/{总数}
   ARCHITECTURE.md : {已存在，直接引用 | 新起草（{repo}），随本次评审一并确认}
   当前状态   : tech-design-review-pending
   下一步     : 以 `crctl next {cr_id}` 为准
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| prd.md 不存在 | 停止执行，提示先完成 write-requirement-prd |
| 初次生成时 CR status 非 `requirement-approved` | 停止执行，展示当前 status |
| 回修模式下 CR status 非 `tech-designing` | 停止执行，展示当前 status、`review_feedback` 是否存在与上一轮 sdd review verdict |
| sdd.md 已存在 | 进入编辑模式（追加修改），不覆盖；若存在 review_feedback，则优先按 blocker 定点修复 |

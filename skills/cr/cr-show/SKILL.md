---
name: cr-show
description: "展示单个 CR 的完整详情"
---

# Skill: cr-show

**类型**: 只读 Skill（详情类）  
**触发时机**: 用户请求查看某 CR 完整详情，如"展示 CR-2026-001"、"cr-show CR-2026-001"

---

## 用途

展示单个 CR 的完整信息，包括：基本信息、三角色 owner、当前状态、PRD/SDD/TASK 摘要、审查记录、关联 spec、追踪链路。历史补丁式 delta-spec 仅作为兼容信息只读展示。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr-id` | string | ✅ | CR 标识符（如 `CR-2026-001`） |
| `section` | enum | ❌ | 仅展示指定部分：`basic` / `artifacts` / `review-history` / `traceability` / `all`（默认） |

---

## 操作步骤

### Step 1 — 定位 CR 文件

1. 优先在 `change-requests/_backlog.yml` 的 `backlog[]` 中查找（在途 CR）
2. 若未找到，在 `change-requests/_history.yml` 的 `history[]` 中查找（已归档 CR）
3. 若均未找到，抛出 `CR_SHOW_NOT_FOUND`
4. 读取 `change-requests/{cr-id}/cr.md`

### Step 2 — 读取关联文件

- 若存在历史补丁式 `change-requests/{cr-id}/delta-spec.md`：只读展示 section 列表；新四阶段 CR 以 `prd.md` / `sdd.md` / `tasks/` 为准
- 读取 `change-requests/{cr-id}/review-annotations/requirement.yml`、`review-annotations/sdd.yml`、`review-annotations/code.yml`（如存在），提取 `verdict`、`blockers` 与 `repair-target`
- 读取 `change-requests/{cr-id}/test-report.md`（如存在），提取 frontmatter `status` 与 blockers
- 若存在 `change-requests/{cr-id}/review-notes.md`：作为历史审查记录只读展示
- 若 `cr.md frontmatter.target.refs` 包含 spec-id：读取对应 `specs/{spec-id}/traceability.yml`（仅提取 change-requests 段）

### Step 3 — 构造详情视图

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CR-2026-001  [emergency-fix]  修复协作看板崩溃问题
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	基本信息
	  状态       : archived  ✅
  提交人     : zhang-san
  审查人     : li-si
  需求负责人 : pm-a @ 2026-04-28T09:30:00+08:00
  开发负责人 : dev-a @ 2026-04-28T09:30:00+08:00
  测试负责人 : qa-a @ 2026-04-28T09:30:00+08:00
  创建时间   : 2026-04-28
	  归档时间   : 2026-04-30
  SLA 剩余   : 已完成（用时 2d）

来源 & 目标
  origin     : docs/feedback/2026-04-27-focus-crash.md
  target     : specs/collaboration-dashboard/PRD.md  [spec]

交付产物
  PRD        : change-requests/CR-2026-001/prd.md
  SDD        : change-requests/CR-2026-001/sdd.md
  TASK       : 3 个
  writeback  : specs/collaboration-dashboard/{PRD.md,SDD.md}

审查记录
  2026-04-29  li-si  requirement-review pass
  备注: "策略合理，需补充降级超时阈值说明 → submitter 已确认补充"

关联 Spec
  affects-feature: collaboration-dashboard
  branch: requirement/CR-2026-001
  writeback-spec-id: collaboration-dashboard

追溯链路
  cr.md → prd.md → sdd.md → tasks/ → specs/collaboration-dashboard/{PRD.md,SDD.md}
  traceability: 已回写 ✅

下一步建议
  next-skill : approve-code
  reason     : status=code-reviewing，code.yml verdict=pass 且 test-report.md status=pass，等待 human_approval
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Step 4 — 生成下一步建议

直接运行 `crctl next {cr_id}`（FR-22，CR-2026-022）：不再本地维护 status→下一节点硬编码映射表——旧表只覆盖到 code-approved，缺 merging/writing-back/archived/rejected/withdrawn，且随状态机漂移（resume-cr 节点 prompt 已声明「不再本地维护映射表，跑 crctl next」）。`crctl next` 会同时校验评审/测试证据（blocker 未清空绝不给 human_approval）并覆盖全部非终态。

---

## 注意事项

- 只读操作，不修改任何文件
- 若某项关联文件不存在（如 review-notes.md），对应部分标注"暂无记录"
- `owners.requirement`、`owners.development`、`owners.test` 是责任归属权威字段；顶层 `owner` 仅作为旧视图兼容字段展示
- `section` 参数可精简输出，适合在流程中快速确认某一维度

---

## 错误码

| 错误码 | 含义 | 处理方式 |
|--------|------|----------|
| `CR_SHOW_NOT_FOUND` | _backlog 和 _history 均无该 CR | 检查 cr-id 是否正确 |
| `CR_SHOW_FILE_MISSING` | change-requests/{cr-id}/cr.md 不存在 | 检查目录结构是否完整 |

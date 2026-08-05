---
name: cr-inbox
description: "查看个人待处理 CR 收件箱"
---

# Skill: cr-inbox

**类型**: 只读 Skill（查询类）  
**触发时机**: 用户询问"我有哪些 CR 待处理"、"CR 收件箱"、"需要我审查的 CR"

---

## 用途

按角色（requirement owner / development owner / test owner / reviewer）展示当前用户需要关注的 CR 列表，聚焦"需要行动"的待办项。类似邮件收件箱——只看与当前用户相关且需要操作的 CR。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `role` | enum | ❌ | `requirement` / `development` / `test` / `reviewer` / `all`（默认） |
| `user` | string | ❌ | 指定用户标识，默认取当前 Agent 上下文用户 |
| `status-filter` | list | ❌ | 仅显示指定状态，如 `[requirement-reviewing, code-reviewing]`；默认显示非终态 |

---

## 操作步骤

### Step 1 — 读取 _backlog.yml

读取 `change-requests/_backlog.yml`，加载 `backlog[]` 列表（顶级字段名为 `backlog`）。

### Step 2 — 过滤与分类

按 `role` 参数过滤：

| role | 过滤条件 | 待办含义 |
|------|----------|----------|
| `requirement` | `backlog[].owners.requirement.id == user` | 我负责需求的 CR，需关注 PRD 与需求审批 |
| `development` | `backlog[].owners.development.id == user` | 我负责开发的 CR，需关注 SDD、任务、编码与代码审批 |
| `test` | `backlog[].owners.test.id == user` | 我负责测试的 CR，需关注测试报告与验证证据 |
| `reviewer` | `backlog[].reviewer == user`（reviewer 字段由 review skill 写入） | 需要我提供审查意见的 CR |
| `all` | 以上角色合并 | 全部相关 CR |

<!-- lint-prompts:ignore --> 描述性：inbox 流程说明
若指定 `status-filter`，进一步过滤各 CR 的 `change-requests/{cr_id}/cr.md` frontmatter `status` 字段（权威状态源，CR-2026-018；`_backlog.yml` 已不含 status）。

否则默认排除终态：`archived / rejected / withdrawn`。

### Step 3 — 构造收件箱视图

按"需要行动"排列，优先级规则：

1. **紧急**（type=emergency-fix）优先
2. **waiting-for-me**（reviewer=user 且 status 属于 `requirement-reviewing` / `tech-design-review-pending` / `code-reviewing`）
3. **test-needed**（owners.test=user 且 status 属于 `developing` / `code-reviewing`）
4. **my-cr-blocked**（任一 owner=user 且 status=`rejected`）
5. **in-progress**（status 属于 `developing` / `merging` / `writing-back`）
6. **other**

### Step 4 — 输出

```
📬 CR 收件箱（共 N 条，需行动 M 条）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 需要我审查（N 条）
  ┌─ CR-2026-001  [emergency-fix] 修复协作看板崩溃问题
  │  status: requirement-reviewing → 等待需求审查意见
  │  owners: requirement=pm-a | development=dev-a | test=qa-a
  │  created-at: 2026-05-01T09:30:00+08:00
  └─ ...

🟡 我提交的 CR（N 条）
  ┌─ CR-2026-003  [standard-change] 新增 AI 伴侣功能
  │  status: tech-design-review-pending → 等待技术设计审查结论
  └─ ...

🟢 实施中（N 条）
  ┌─ CR-2026-002  [normal-change] 重构知识库检索
  │  status: developing
  │  affects-feature: knowledge-search
  │  branch: requirement/CR-2026-002
  └─ ...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
提示：使用 cr-show CR-ID 查看详情
```

---

## 注意事项

- 只读操作，不修改任何文件
- 若 _backlog.yml 为空或过滤后无结果，提示"当前无待处理 CR"

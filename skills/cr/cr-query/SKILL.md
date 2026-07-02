---
name: cr-query
description: "按类型/状态/spec 多维检索 CR"
---

# Skill: cr-query

**类型**: 只读 Skill（查询类）  
**触发时机**: 用户按条件检索 CR，如"查所有 emergency-fix CR"、"查 spec X 相关的变更"

---

## 用途

多维度查询 CR 列表（在途 + 历史），支持按类型、状态、target spec、时间范围等过滤，返回结构化汇总表格。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | enum | ❌ | `emergency-fix` / `standard-change` / `normal-change` |
| `status` | list | ❌ | CR 状态列表，如 `[requirement-approved, developing, code-reviewing]` |
| `target-spec` | string | ❌ | spec-id，查询影响该 spec 的所有 CR |
| `origin-ref` | string | ❌ | 来源引用（如某条 feedback 或文档 ID） |
| `submitter` | string | ❌ | 提交人 |
| `owner` | string | ❌ | 按任一角色 owner 筛选 |
| `owner-role` | enum | ❌ | 限定 owner 角色：`requirement` / `development` / `test` |
| `include-history` | bool | ❌ | 是否包含已归档 CR，默认 `false` |
| `sort-by` | enum | ❌ | `created-at`（默认）/ `status` / `type` |

---

## 操作步骤

### Step 1 — 读取数据源

- 读取 `change-requests/_backlog.yml` → `backlog[]`（在途 CR）
- 若 `include-history=true`：读取 `change-requests/_history.yml` → `history[]`（已归档 CR）
- 将两者合并为单一待过滤集合

### Step 2 — 应用过滤条件

按参数逐项过滤，多条件之间为 AND 关系：

| 参数 | 过滤逻辑 |
|------|----------|
| `type` | `entry.type == type` |
| `status` | `entry.status in status-list` |
| `target-spec` | `entry.target.refs[].path` 包含该 spec-id |
| `origin-ref` | `entry.origin.ref == origin-ref` |
| `submitter` | `entry.submitter == submitter` |
| `owner` | `owner-role` 为空时匹配 `entry.owners.*.id` 任一角色；指定时只匹配对应角色 |

### Step 3 — 排序与输出

```
🔍 CR 查询结果（共 N 条）
条件: type=emergency-fix, include-history=true

 CR-ID        | 类型           | 状态       | 标题                      | Req/Dev/Test Owner      | 日期
──────────────┼────────────────┼────────────┼───────────────────────────┼───────────┼──────────
 CR-2026-001  | emergency-fix  | archived              | 修复协作看板崩溃          | pm/dev/qa | 2026-04-28
 CR-2026-005  | emergency-fix  | requirement-reviewing | 修复 AI 伴侣超时          | pm/dev/qa | 2026-05-03
──────────────┴────────────────┴────────────┴───────────────────────────┴───────────┴──────────

提示：使用 cr-show CR-ID 查看任意条目详情
```

---

## 注意事项

- 只读操作，不修改任何文件
- 无过滤条件时默认显示所有在途 CR（按 created-at 降序）
- 若无匹配结果，提示"未找到符合条件的 CR"并建议放宽过滤条件

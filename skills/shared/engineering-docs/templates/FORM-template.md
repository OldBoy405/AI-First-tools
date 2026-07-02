<%# FORM 模板 (ENGINEERING-STRUCTURE-TEAM.md §七·表单层) -%>
---
id: <%= id %>
type: FORM
name: <%= name %>
title: <%= title %>
status: draft
owner: <%= owner %>
created: <%= today %>
updated: <%= today %>
version: v0.1.0
refs:
  upstream: [<%= prdId || '' %>, <%= moduleId || '' %>]
  downstream: []
fields: []
---

# <%= title %>

> FORM（表单规格） · DDD 聚合根的用户侧呈现，字段定义、验证规则、业务约束的权威来源。

## 1. 概览

- 关联 PRD 功能点：<%= prdId || '待绑定' %>
- 关联 MODULE 行为：<%= moduleId || '待绑定' %>
- 适用场景：

## 2. 字段清单（fields）

| 字段 | 类型 | 必填 | 默认值 | 枚举 | 说明 |
|------|------|------|--------|------|------|
| _待填写_ | string | 是 | - | - | - |

## 3. 验证规则（validations）

| 字段 | 规则 | 错误提示 |
|------|------|----------|
| _待填写_ | _如：length 6-32_ | _待填写_ |

## 4. 条件联动（conditions）

| 触发字段 | 条件 | 作用字段 | 动作 |
|----------|------|----------|------|
| _待填写_ | - | - | - |

## 5. 业务约束（business-rules）

- _待填写_（如：用户名全局唯一；密码至少包含数字与字母）_

## 6. 关联测试用例

位于同目录 `test-cases/` 下的 `TC-FORM-NNN-*.md`。

## 7. 关联 frontmatter refs

- PRD FR：_列出 FR 编号_
- MODULE BH：_列出 BH 编号_

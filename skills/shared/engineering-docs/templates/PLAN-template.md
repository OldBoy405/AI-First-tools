<%# PLAN 模板 (ENGINEERING-STRUCTURE-TEAM.md §五·应用层·交付区) -%>
---
id: <%= id %>
type: PLAN
name: <%= name %>
title: <%= title %>
status: draft
owner: <%= owner %>
created: <%= today %>
updated: <%= today %>
version: <%= docVersion %>
sprint: <%= sprint || docVersion %>
refs:
  upstream: [<%= moduleId || '' %>]
  downstream: []
---

# <%= title %>

> PLAN（迭代计划） · 过程文档，只增不改，按版本归档。

## 1. 目标与范围

- 迭代版本：<%= docVersion %>
- 目标：
- 关联 MODULE：<%= moduleId || '待绑定' %>

## 2. 交付物清单

| TASK ID | 名称 | 负责人 | 预计工时 | 依赖 |
|---------|------|--------|----------|------|
| TASK-<%= docVersion %>-001-01 | _待填写_ | <%= owner %> | - | - |

## 3. 里程碑

| 日期 | 事件 |
|------|------|
| <%= today %> | 计划启动 |

## 4. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| _待填写_ | - | - | - |

## 5. 验收标准

- [ ] 所有 TASK 完成
- [ ] 回归测试通过
- [ ] RELEASE 文档已生成

## 6. 变更记录

| 日期 | 版本 | 作者 | 说明 |
|------|------|------|------|
| <%= today %> | v0.1.0 | <%= owner %> | 初始草稿 |

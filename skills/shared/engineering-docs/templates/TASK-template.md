<%# TASK 模板 (ENGINEERING-STRUCTURE-TEAM.md §五·应用层·交付区) -%>
---
id: <%= id %>
type: TASK
name: <%= name %>
title: <%= title %>
status: draft
owner: <%= owner %>
created: <%= today %>
updated: <%= today %>
version: <%= docVersion %>
task-of: "<%= planId || '' %>"
branch: "<%= branch || '' %>"
pr: ""
refs:
  upstream: [<%= planId || '' %>]
  downstream: []
---

# <%= title %>

> TASK（开发任务卡） · 过程文档，一个 TASK = 一个 PR。

## 1. 任务目标

一句话说明本任务要交付什么。

## 2. 关联上下文

- PLAN：<%= planId || '待绑定' %>
- MODULE BH：_列出实现的行为规格编号，如 BH-01、BH-02_
- 分支：<%= branch || '待建' %>

## 3. 实现步骤

- [ ] 步骤 1：_待填写_
- [ ] 步骤 2：_待填写_

## 4. 测试

- 新增单测：
- 回归用例：

## 5. 验收清单

- [ ] 代码合入 `dev`
- [ ] CI 通过
- [ ] SDD/MODULE 的实现章节已回写
- [ ] `_index.yaml` 已更新

## 6. 变更记录

| 日期 | 版本 | 作者 | 说明 |
|------|------|------|------|
| <%= today %> | v0.1.0 | <%= owner %> | 初始草稿 |

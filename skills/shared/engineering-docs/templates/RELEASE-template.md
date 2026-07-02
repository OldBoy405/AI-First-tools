<%# RELEASE 模板 (ENGINEERING-STRUCTURE-TEAM.md §五·应用层·交付区) -%>
---
id: <%= id %>
type: RELEASE
name: <%= name %>
title: <%= title %>
status: draft
owner: <%= owner %>
created: <%= today %>
updated: <%= today %>
version: <%= docVersion %>
refs:
  upstream: []
  downstream: []
---

# <%= title %>

> RELEASE（发版计划与发布说明） · 过程文档，归档于 `docs/delivery/releases/`。

## 1. 版本信息

- 版本号：<%= docVersion %>
- 计划发布日期：
- 发布负责人：<%= owner %>

## 2. 变更摘要

### 新增
- _待填写_

### 优化
- _待填写_

### 修复
- _待填写_

## 3. 关联文档

- 相关 PLAN：
- 相关 TASK：
- 关联 MODULE 升级：

## 4. 发布步骤

1. _待填写_

## 5. 回滚预案

- 回滚条件：
- 回滚步骤：

## 6. 风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| _待填写_ | - | - | - |

## 7. 验收

- [ ] 生产验证通过
- [ ] 监控告警确认正常
- [ ] Runbook 已更新

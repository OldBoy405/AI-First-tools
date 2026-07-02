<%# PRD 模板 (ENGINEERING-STRUCTURE-TEAM.md §五·应用层·产品区) -%>
---
id: <%= id %>
type: PRD
name: <%= name %>
title: <%= title %>
status: draft
owner: <%= owner %>
created: <%= today %>
updated: <%= today %>
version: v0.1.0
refs:
  upstream: []
  downstream: []
fr-list: []
---

# <%= title %>

> PRD（产品需求文档） · 活文档，反映系统当前需求全貌。

## 1. 背景与目标

说明该需求的业务背景、目标用户、核心价值。

## 2. 用户旅程

对应 JOURNEY 文档：_待补_

## 3. 功能需求（FR）

| 编号 | 名称 | 描述 | 优先级 |
|------|------|------|--------|
| FR-1.1 | _待填写_ | _待填写_ | P0 |

## 4. 非功能需求（NFR）

- 性能：
- 安全：
- 可观测：
- 兼容性：

## 5. 交互与视觉

文案、状态机、关键弹窗说明；视觉稿链接。

## 6. 指标与验收

- 成功指标（North Star / Proxy）：
- 验收标准：

## 7. 风险与边界

- 风险：
- 明确不做：

## 8. 变更记录

| 日期 | 版本 | 作者 | 说明 |
|------|------|------|------|
| <%= today %> | v0.1.0 | <%= owner %> | 初始草稿 |

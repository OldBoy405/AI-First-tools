---
id: PRD-001
type: PRD
name: sample-login
title: 示例·用户登录
status: approved
owner: product-brain
created: "2026-05-01"
updated: "2026-05-01"
version: v0.1.0
refs:
  upstream: []
  downstream: []
fr-list: [FR-1.1, FR-1.2]
---

# 示例·用户登录

> 示例 PRD：演示 engineering-docs skill 生成的骨架结构。请勿直接作为真实需求使用。

## 1. 背景与目标

- 业务背景：给团队一个可参考的 PRD 骨架。
- 目标用户：engineering-docs skill 的 consumer agent。
- 核心价值：把"PRD frontmatter 长什么样"从口头约定变成可执行的 schema。

## 2. 用户旅程

对应 JOURNEY 文档：_示例略_

## 3. 功能需求（FR）

| 编号 | 名称 | 描述 | 优先级 |
|------|------|------|--------|
| FR-1.1 | 账号密码登录 | 用户使用账号 + 密码登录 | P0 |
| FR-1.2 | 登录错误提示 | 登录失败时显示友好错误信息 | P1 |

## 4. 非功能需求（NFR）

- 性能：登录响应 < 300ms（P95）
- 安全：密码传输 HTTPS，服务端 bcrypt 存储
- 可观测：登录成功/失败指标上报
- 兼容性：支持 Chrome/Safari/Edge 最新 2 个主版本

## 5. 交互与视觉

略。

## 6. 指标与验收

- 成功指标：登录成功率 ≥ 99.5%
- 验收标准：FR-1.1、FR-1.2 全部自动化测试通过

## 7. 风险与边界

- 风险：暂无
- 明确不做：社交账号登录（留到下一迭代）

## 8. 变更记录

| 日期 | 版本 | 作者 | 说明 |
|------|------|------|------|
| 2026-05-01 | v0.1.0 | product-brain | 示例骨架 |

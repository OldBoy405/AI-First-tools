---
name: record-adr
description: "记录架构决策 ADR"
---

# record-adr — 记录架构决策 ADR

## 触发条件
用户意图包含：架构决策、技术选型、ADR

## 前置 gate
无（架构决策无前置 gate，随时可写）

## 输出
- `constraints/adrs.yml`（append ADR 条目到索引）

## frontmatter 模板
```yaml
---
file-role: ADR
id: ADR-NNN
title: {决策标题}
status: proposed     # proposed | accepted | deprecated | superseded
date: "{YYYY-MM-DD}"
owner: umasuo
superseded-by: ""    # 若被替代时填写
---
```

## 文档骨架（ADR 标准节）
1. 背景（Context）
2. 决策（Decision）
3. 后果（Consequences）
4. 备选方案（Alternatives Considered）

## 校验清单
- [ ] status 合法（proposed/accepted/deprecated/superseded）
- [ ] 背景节存在且描述了为什么需要决策
- [ ] 决策节明确说明了选择了什么
- [ ] ADR 一旦写入不得修改，只能创建新 ADR 并填写 superseded-by

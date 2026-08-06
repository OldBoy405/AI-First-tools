---
name: write-competitive-report
description: 基于竞品动态块和产品快照生成独立竞品分析报告并落盘到 docs/competitive/reports/，同时幂等回写对应竞品主文件 updates 列表。
---

# 生成竞品分析报告 (Write Competitive Report)

## 概述

基于 `fetch-competitor-updates` 产出的动态块和 `gather-product-context` 产出的产品快照，生成结构化竞品分析报告，落盘到 `docs/competitive/reports/`，并幂等回写对应 `docs/competitive/{id}.md` 的 `updates[]`。

**执行落盘步骤前必须由调用 Agent 向用户完整展示草稿并获得明确确认。**

---

## 输入参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `updates-block` | 是 | `fetch-competitor-updates` 输出的 competitor 条目（含 updates/source-urls） |
| `product-snapshot` | 是 | `gather-product-context` 输出的 Markdown 快照或其结构化摘要 |
| `report-date` | 否 | 报告日期（YYYY-MM-DD），默认取当日 |
| `confirmed` | 是 | 布尔值；未置 true 时仅生成草稿展示，**不落盘** |

---

## 报告结构（固定章节）

报告落盘文件：`docs/competitive/reports/{competitor-id}-{YYYY-MM-DD}.md`

### Frontmatter（由 `engineering-docs` skill 生成，禁止手写）

```yaml
---
id: "report-{competitor-id}-{YYYY-MM-DD}"
competitorId: "{competitor-id}"
reportDate: "YYYY-MM-DD"
addedAt: "YYYY-MM-DDTHH:mm:ss+08:00"   # 北京时间，完整 ISO 8601
docRole: COMPETITIVE
sources:
  - "https://..."
  - "https://..."
---
```

必填字段：`id, competitorId, reportDate, addedAt, sources[]`（`docRole` 固定 `COMPETITIVE`）。

### 正文章节

1. **基本信息**
   - competitor-id / name / website / positioning
   - 报告日期 / 数据采集时间
2. **最新动向**
   - 按日期倒序逐条列 `{date, title, source-url, summary}`
   - 每条后追加来源链接
3. **对我方产品的潜在影响**
<!-- lint-prompts:ignore --> 描述性：竞争报告引用账本字段
   - 对照 `specs/_index.yml` baseline spec 与 `change-requests/_backlog.yml` 在途 CR：命中哪些产品能力、哪些 CR 是正面 or 负面影响
   - 对照 `docs/product-planning/_index.yml` 规划大盘：是否影响下一版本的主题或排序
4. **初步规划建议**
   - 3-5 条要点，每条 ≤ 2 句话
   - 明确说明「详细规划请走 `report-to-planning-suggestion`」
5. **引用来源**
   - 按来源域名分组的完整 URL 列表

---

## 执行流程

### 阶段 A — 草稿生成（仅对话展示）

```
1. 校验输入：updates-block / product-snapshot 必填
2. 组装 5 个章节的 Markdown 文本（不写文件）
3. 将 Markdown 完整输出到对话，并明确提示：
   「以上为草稿，确认后将落盘到 docs/competitive/reports/{id}-{YYYY-MM-DD}.md
    并幂等追加动态到 docs/competitive/{id}.md#updates」
4. 等待调用方传入 confirmed=true 再进入阶段 B
```

### 阶段 B — 落盘（confirmed=true 时执行）

```
1. 生成报告 frontmatter：
   委托 engineering-docs skill（doc-role=COMPETITIVE），
   按模板与 schema 步骤传入 id/competitorId/reportDate/sources 生成 frontmatter + 写入文件
   **`addedAt` 和 `updated` 必须写入当前北京时间（UTC+8）完整 ISO 8601 字符串，**
   **格式：`YYYY-MM-DDTHH:mm:ss+08:00`（例：`2026-05-07T10:30:00+08:00`）**
   **禁止写入纯日期字符串（如 `YYYY-MM-DD`）或 UTC 时间**
   落盘路径：docs/competitive/reports/{competitor-id}-{YYYY-MM-DD}.md
   冲突策略：文件已存在时提示用户选择覆盖 or 改用新日期

2. 幂等回写竞品主文件：
   读 docs/competitive/{competitor-id}.md
   对 updates-block.updates 逐条：
     if 已存在 (date, title) 相同的条目：跳过
     else：向 updates[] 追加 { date, title, source, summary, reportPath }
       reportPath = "docs/competitive/reports/{competitor-id}-{YYYY-MM-DD}.md"
   写回 frontmatter（保留原 body 不变）

3. 追加 reports 索引：
   读 docs/competitive/reports/_index.yml
   entries[] 追加 { id, competitorId, reportDate, path, title, status: new }  # status 供 focus-briefing 按 new 过滤、消费后翻 seen
   按 reportDate 倒序排序后写回

4. 调用 validate-doc 校验报告文件 + 竞品主文件 + reports/_index.yml
```

---

## 读写清单

```yaml
write-competitive-report:
  read:
    - docs/competitive/*.md
    - docs/competitive/reports/_index.yml
    - specs/_index.yml
<!-- lint-prompts:ignore --> 描述性：竞争报告引用账本字段
    - change-requests/_backlog.yml
    - docs/product-planning/_index.yml
  write:
    - docs/competitive/reports/*.md
    - docs/competitive/{id}.md              # 仅 frontmatter.updates 追加
    - docs/competitive/reports/_index.yml
  delegates: [engineering-docs, validate-doc]
```

---

## 错误处理

| 场景 | 行为 |
|------|------|
| `updates-block` 为空 | 中止执行并提示用户：无动态可写，先调用 fetch-competitor-updates |
| `product-snapshot` 缺失 | 中止并提示先调用 gather-product-context |
| 目标报告文件已存在 | 询问用户：覆盖 / 改用新日期 / 取消 |
| 竞品主文件不存在 | 中止并提示用户先在 docs/competitive/_index.yml 中登记竞品 |
| `engineering-docs` 失败 | 透传错误，撤销已写入的索引条目 |

---

## 注意事项

1. **禁止手写 frontmatter**：必须通过 `engineering-docs` skill 的模板与 schema 步骤生成，满足 frontmatter schema
2. **幂等回写**：`updates[]` 追加必须按 `(date, title)` 去重，多次调用结果一致
3. **先草稿后落盘**：`confirmed=false` 时严格禁止任何写操作
4. **保留原有 body**：回写竞品主文件时只更新 frontmatter.updates，不得修改 body
5. **并发安全**：同一竞品同日报告冲突时必须显式让用户决策，不得静默覆盖
6. **所有时间字段必须使用北京时间**：`addedAt`、`updated`、`generated-at` 等所有时间字段必须写入北京时间（UTC+8），格式为 `YYYY-MM-DDTHH:mm:ss+08:00`；**禁止使用纯日期字符串或 UTC 时间**，否则前端显示相对时间将偏差 8 小时

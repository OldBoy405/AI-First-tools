---
name: write-planning-entry
description: 将已经人工审批的规划建议或规划草稿落盘到 docs/product-planning/ 并维护 _index.yml。Use after planning-draft, report-to-planning-suggestion, or market-to-plan human approval when a draft must become a persisted planning artifact.
---

# Skill: write-planning-entry

**类型**: 规划期 Skill（planning/ 组，显式落盘节点）

## 用途

`planning-draft` 只生成草稿，不写文件。本 Skill 是规划建议经过人工确认后的唯一落盘入口，避免草稿生成与写文件职责混淆。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `source` | string | yes | 草稿来源，如 `node-3.md`、竞品报告路径或市场洞察条目 |
| `title` | string | yes | 规划条目标题 |
| `target_version` | string | no | 关联版本；为空则填 `unassigned` |
| `owner` | string | no | 负责人；为空填 `product-owner` |

## 执行步骤

1. 读取 `dir-graph.yaml`，解析 `knowledge-docs.subdirs.product-planning.path` 和 `_index.yml` 路径。
2. 读取 `source` 对应草稿，确认已通过上游 `human_approval`。
3. 使用 `engineering-docs` 生成 `DESIGN-DOC` frontmatter 与正文骨架，保留草稿中的来源、机会点、成功指标、风险与下一步。
4. 写入 `docs/product-planning/{YYYY-MM-DD}-{slug}.md`。
5. 更新 `docs/product-planning/_index.yml`：

```yaml
- id: {YYYY-MM-DD}-{slug}
  title: {title}
  status: approved
  target-version: {target_version 或 unassigned}
  source: {source}
  owner: {owner}
  created-at: {YYYY-MM-DDTHH:mm:ss+08:00}
```

6. 调用 `validate-doc` 校验文档结构；失败则停止并回报问题。

## 输出

输出实际写入路径、index 条目 id、校验结果，以及建议下一步是否进入 `requirement` pipeline。

## 禁止事项

- 不得跳过人工审批直接落盘。
- 不得覆盖已有同名规划文档；若 slug 冲突，追加短 hash。
- 不得修改 `specs/` 或 `change-requests/`。

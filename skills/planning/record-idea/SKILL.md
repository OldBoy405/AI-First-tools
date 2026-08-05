---
name: record-idea
description: 快速记录用户产品想法到 docs/ideas/（原文落盘，不扩写不补充）
---

# record-idea — 快速记录产品想法

## 触发条件
用户意图包含：记一下想法 / 记录产品想法 / 我有个想法 / 草稿一个需求 / 先记下来 / 想法池新增。

## 前置 gate
无。随时可写，且不进入任何质量门。

## 输入
用户原始文本，可能是一句话，也可能是多行。内容可能很简短、不完整、甚至只是一个念头 —— **这是预期的，不要补全**。

## 定位（重要）
本 skill 是「想法池 (DRAFT) 的入口」，对应 [dir-graph.yaml](../../../dir-graph.yaml) 中 `knowledge-docs.subdirs.ideas`（`docs/ideas/`, doc-role=DRAFT）。
与 `requirement-register` / `write-requirement-prd` 的关系：
- record-idea → 原文速记，几秒内落盘
- 想法被认领后由 `requirement` pipeline 注册 CR 并编写 PRD；不得直接写 specs/

## 行为规则（原子化，禁止自由发挥）
1. **id**：`d-{Date.now()}`（13 位毫秒时间戳，与既有样例 `d-1777891853474.md` 保持一致）
2. **title 策略**：取用户原文首行；若首行 > 60 字，按第一个出现的「。」「.」「\n」截断；若只有一句话，整句即 title；末尾去除多余空白
3. **body**：原样保留用户完整输入，**禁止**进行以下任何操作：
   - 润色、改写、翻译
   - 补充背景、动机、受众、验收标准
   - 拆分章节、加小标题
   - 关联 spec / CR / 竞品 / 路线图
   - 给出实现建议或技术方案
4. **status**：固定 `draft`
5. **updatedAt**：当前时间 ISO 8601 字符串（含毫秒，如 `2026-05-05T08:30:12.345Z`）
6. 若用户只给了标题性的一句话，body 就写这一句；**不要**凭空补第二段

## 输出

### 1. 新建文件 `docs/ideas/d-{timestampMS}.md`

```yaml
---
id: d-{timestampMS}
title: {title}
status: draft
updatedAt: "{ISO-时间戳}"
---

{用户原文，原样不动}
```

### 2. 追加一条 entry 到 `docs/ideas/_index.yml`

在 `entries:` 列表末尾 append：

```yaml
  - {id: d-{timestampMS}, title: {title}, updatedAt: "{ISO-时间戳}"}
```

保留文件原有 `schema` 与 `title` 字段不变。

## 明确不做
<!-- lint-prompts:ignore --> 反例说明：不执行任何裸 git 操作
- ❌ 不执行 `git add/commit` 或任何分支操作
- ❌ 不调用 `requirement-register` / `write-requirement-prd` 等后续 skill
- ❌ 不触发 review 门，不建议"进入 spec 流程"
- ❌ 不修改 [dir-graph.yaml](../../../dir-graph.yaml) 或其他索引
- ❌ 不给用户输出"补充建议"、"你是不是想…"之类的反问

## 向用户反馈
写入完成后，仅回一行简短确认，例如：
```
已记录到 docs/ideas/d-{timestampMS}.md
```
不追加任何分析或下一步提示。

## 校验清单
- [ ] 文件名 = `d-{timestampMS}.md`，与 frontmatter `id` 字段完全一致
- [ ] frontmatter 恰好 4 个字段：`id / title / status / updatedAt`
- [ ] `status == draft`
- [ ] `body` 非空且未被改写（字符级等于用户输入）
- [ ] `docs/ideas/_index.yml` 的 `entries` 已追加对应条目
- [ ] 未触发任何下游 skill 调用

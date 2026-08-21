---
name: fetch-competitor-updates
description: 抓取竞品官网与互联网近期新闻，输出结构化动态块（标题、日期、来源、摘要）供竞品分析 Agent 使用；纯读取不落盘。
---

# 抓取竞品最新动态 (Fetch Competitor Updates)

## 概述

读取 `docs/competitive/_index.yml` 与对应竞品 `.md` frontmatter，抓取竞品官网（功能页 / changelog / blog / release notes）以及互联网近期新闻，输出结构化动态块供 `competitive-analyst-agent` 生成分析报告。

**本 Skill 纯读取，不写入任何文件。** 唯一的副作用是联网抓取。

---

## 输入参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `competitor-id` | 否 | 单个竞品 id（如 `c-1777889517568`） |
| `competitor-ids[]` | 否 | 多个竞品 id 列表 |
| `competitor-slug` | 否 | 竞品索引中的 slug；仅在未传 id/ids 时通过 `_index.yml` 精确解析为 id |
| `lookback-days` | 否 | 互联网搜索时间窗，默认 30 天 |

> 优先级：`competitor-id` / `competitor-ids[]` > `competitor-slug` > 全部 entries。slug 必须在 `docs/competitive/_index.yml` 中唯一精确命中，不得猜测或把 slug 直接当 id。

---

## 执行流程

### 步骤 1 — 加载竞品清单

```
读 docs/competitive/_index.yml → 校验 schema == competitive-index/v1
若未传 id/ids 且传入 competitor-slug：按 entries[].slug 唯一精确匹配并取得 id；0 个或多个命中均硬失败
根据解析后的输入过滤目标竞品 id 集合；三者均未传则使用全部 entries
逐个读 docs/competitive/{id}.md → 提取 frontmatter：
  - name, website, positioning, tags
```

### 步骤 2 — 抓取官网动态（对每个竞品并行）

```
if frontmatter.website 存在：
  fetch_content(website)
  启发式定位子页面：
    - changelog / release-notes / whats-new / updates
    - blog / news
    - features / product
  逐页 fetch_content，提取最近条目（标题、发布日期、摘要）
else:
  记录 ⚠ 该竞品未配置 website，跳过官网抓取
```

### 步骤 3 — 互联网搜索近期动态

```
查询词集合（逐条用 search_web）：
  1. "{name} 最新动态"
  2. "{name} 新功能 {YYYY}"
  3. "{name} 产品发布"
  4. "{name} {tag}"（每个 tag 单独查询，最多 3 个 tag）
时间窗：lookback-days（默认 30）
对每条结果：
  - 抓取标题、日期、来源 URL、摘要
  - 去重：(title, source-domain) 作为 key
```

### 步骤 4 — 结构化输出到对话上下文

不落盘，直接以下面格式输出到对话：

```jsonc
{
  "generated-at": "2026-05-05T10:00:00+08:00",  // 必须使用北京时间（UTC+8），格式 YYYY-MM-DDTHH:mm:ss+08:00
  "lookback-days": 30,
  "competitors": [
    {
      "competitor-id": "c-1777889517568",
      "name": "QoderWork",
      "website": "https://qoder.com/qoderwork",
      "source-urls": ["https://qoder.com/qoderwork/changelog", "https://..."],
      "updates": [
        {
          "date": "2026-04-28",
          "title": "QoderWork 发布 v2.5 — 新增多轮对话记忆",
          "source": "https://qoder.com/blog/v2.5",
          "summary": "一句话摘要（≤ 80 字）"
        }
      ],
      "warnings": ["website 未配置 / 官网 blog 抓取超时（已降级）"]
    }
  ]
}
```

输出完毕后用一段自然语言总结：每个竞品采集到 N 条动态，若有 warnings 明确列出。

---

## 读写清单

```yaml
fetch-competitor-updates:
  read:
    - docs/competitive/_index.yml
    - docs/competitive/*.md
  network: true        # 允许 fetch_content + search_web
  write: []            # 不落盘
```

---

## 错误处理

### 竞品配置缺失

```
⚠ 竞品 {id} 未在 _index.yml 中登记，跳过。
```

### competitor-slug 未唯一命中

```
❌ competitor-slug 必须在 _index.yml 中唯一精确命中；不得猜测或直接当作 competitor-id。
```

### website 缺失

```
⚠ 竞品 {name} frontmatter.website 为空，仅执行互联网搜索。
```

### 网络失败 / 抓取超时

```
⚠ 抓取 {url} 失败（{reason}），已降级为仅保留已抓到的条目。
```

### 全部抓取失败

```
❌ 所有数据源均不可达，请用户手工提供原始材料（禁止编造）。
```

---

## 注意事项

1. **禁止编造**：所有条目必须附可追溯的 `source` URL；无法抓取时返回空数组而非凭空补全
2. **时效标注**：输出必须包含 `generated-at`，值必须使用**北京时间（UTC+8）**，格式为 `YYYY-MM-DDTHH:mm:ss+08:00`（例：`2026-05-07T10:30:00+08:00`）；禁止使用 UTC 时间、纯日期字符串或其他时区
3. **并行抓取**：多竞品之间并行，单竞品多页面之间并行
4. **摘要长度**：单条 `summary` 不超过 80 字，超过则截断并附省略号
5. **去重策略**：按 `(date, title-normalized, source-domain)` 三元组去重，相同条目在多源命中时合并 `source` 为列表

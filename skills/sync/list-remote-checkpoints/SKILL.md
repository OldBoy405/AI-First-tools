---
name: list-remote-checkpoints
description: 按 dir-graph.yaml repositories 查询所有 active repo 的 origin requirement/* 分支，展示每个 CR 的状态、三角色 owner、最后推送时间与各 repo checkpoint SHA。
---

# Skill: list-remote-checkpoints

**类型**: 远端同步 Skill（sync/ 组，跨阶段通用）  
**调用时机**: 需要了解远端在途 CR 全貌时；resume-cr.pipeline.json 第 1 节点  
**参见**: resume-from-remote（用于接手具体 CR）

---

## 用途

查询所有 active repo 的 origin 上 `requirement/*` 分支（即所有已推送到远端的在途 CR），结合 `change-requests/_backlog.yml` 展示每个 CR 的元数据（状态、需求/开发/测试 owner、最后推送时间）与各 repo checkpoint SHA，帮助用户快速识别可接手的工作项。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filter_status` | string | 否 | 按 CR status 筛选（如 `developing`），默认显示全部 |
| `filter_owner` | string | 否 | 按任一角色 owner 筛选 |
| `filter_owner_role` | enum | 否 | 限定 owner 角色：`requirement` / `development` / `test` |

---

## 执行步骤

### Step 1 — 查询远端分支

1. 读取 `AGENTS.md`、`dir-graph.yaml#repositories`。
2. 解析所有 `active != false` 的 repo。
3. 对每个 repo 通过受控 shell 执行：

```ts
await runGit({ subcommand: "fetch", args: ["origin"], cwd: repo.path });
await runGit({ subcommand: "ls-remote", args: ["--heads", "origin", "requirement/*"], cwd: repo.path });
```

输出格式：`{SHA}  refs/heads/requirement/CR-YYYY-NNN`，按 `cr_id + repo.id` 汇总。

### Step 2 — 收集 CR 元数据

对每个远端分支中的 `requirement/{cr_id}`：
1. 从 `change-requests/_backlog.yml` 查找对应条目
2. 获取字段：`status`、`owners`、兼容 `owner`、`last-push-at`、`last-push-by`、`title`、`checkpoints[]`
3. 对比远端 SHA 与 `checkpoints[]` 中对应 repo 的 SHA，标记 `synced | drift | unknown`

> 若 `_backlog.yml` 中没有对应条目（已 archived 或未登记），从分支名推断 cr_id，其余字段标为 `unknown`。

### Step 3 — 应用筛选条件

若指定了 `filter_status` 或 `filter_owner`，按条件过滤结果。`filter_owner_role` 为空时匹配任一角色；指定时只匹配对应角色。

### Step 4 — 输出列表

```
远端在途 Checkpoint 列表
═══════════════════════════════════════════════════════
  CR-ID         状态                   Req/Dev/Test Owner              最后推送
───────────────────────────────────────────────────────
  CR-2026-001   developing             pm-a / dev-a / qa-a             2026-05-06 14:32  repos: repo@abc1234
  CR-2026-002   requirement-reviewing  pm-b / dev-b / qa-b             2026-05-07 09:15
  CR-2026-003   tech-designing         pm-a / dev-c / qa-c             2026-05-07 11:00
═══════════════════════════════════════════════════════
共 {N} 个在途 CR

接手方式：resume-from-remote <cr_id>
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| 所有 active repo origin 均无 `requirement/*` 分支 | 输出"暂无远端在途 CR checkpoint" |
| `_backlog.yml` 读取失败 | 仅展示远端分支列表，不附加元数据，输出警告 |
| 单个 repo git fetch 失败 | 标记该 repo 为 `unavailable`；其他 repo 继续展示，但 resume 前必须修复 |

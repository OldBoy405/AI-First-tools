---
name: merge-feature-branch
description: 按 dir-graph.yaml repositories 动态解析参与仓，通过 dry-run 与两阶段本地合并避免跨仓半合并，再将同名 requirement/CR-* 分支合并回各仓 trunk 并推进 CR status=merging。
---

# Skill: merge-feature-branch

**类型**: 回写期 Skill（writeback/ 组，入口节点）  
**调用时机**: feature-writeback pipeline 第 1 节点  
**前置要求**: CR status = `code-approved`

---

## 用途

安全合并所有 active repo 的同名分支（`requirement/CR-YYYY-NNN`）到各自 trunk。参与仓、trunk 与 worktree 路径必须从 `dir-graph.yaml#repositories` 和 CR workspace resolver 动态解析，不得硬编码仓库名或主干名。

本 Skill 必须采用“两阶段合并”：
1. **预检阶段**：所有 repo 先完成远端新鲜度检查与 `merge-tree --write-tree` dry-run，不修改任何 trunk。
2. **本地合并阶段**：所有 repo 使用 `merge --no-commit --no-ff` 完成本地合并准备；只有全部 repo 都成功后才逐仓 commit。
3. **远端发布阶段**：只有全部 repo 本地 merge commit 都已生成，且所有 origin trunk 仍与预检 SHA 一致，才允许 push。全部 push 成功后，使用 `cr-status-set commit_mode=embedded` 校验 `code-approved → merging`，并把状态与 `merge-commits[]` 放在同一 metadata commit 中发布。
4. **自动补偿阶段**：若远端发布阶段任一 repo push 失败，必须对已成功 push 的 repo 自动执行补偿 revert，并验证远端 trunk 回到“未包含本 CR”的状态；补偿完成前不得进入 writeback。

不得在全部参与仓本地合并成功前 push 任何 trunk。本 Skill 不清理本地 worktree、不删除远端分支，统一留给 `cr-archive`。

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 目标 CR-ID |

---

## 执行步骤

### Step 1 — 前置校验

1. 读取 `AGENTS.md`、`dir-graph.yaml`，解析 `repositories[*]` 中 `active != false` 的参与仓。
2. 读取 `change-requests/{cr_id}/cr.md`，确认 status=`code-approved`。
3. 对每个参与仓解析：
   - `repo.id`
   - `repo.path`
   - `repo.trunk`
   - CR 分支：`requirement/{cr_id}`
   - CR worktree：`.xinyiai-worktrees/{bucket}/requirement/{cr_id}`，其中 knowledge-base 使用 `knowledge-base`，独立代码仓使用 `repo.id`
4. 确认每个参与仓 CR worktree 无未提交变更，且 `origin/requirement/{cr_id}` 存在。
5. 任一仓校验失败则 abort，不得单仓提前合并。

### Step 2 — 全仓预检（不得修改 trunk）

对每个参与仓，通过 `controlled-shell` 顺序执行：

```yaml
- runGit: { subcommand: "fetch", args: ["origin"], cwd: "{repo.path}" }
- runGit: { subcommand: "rev-parse", args: ["origin/{repo.trunk}"], cwd: "{repo.path}" }
- runGit: { subcommand: "rev-parse", args: ["origin/requirement/{cr_id}"], cwd: "{repo.path}" }
- runGit:
    subcommand: "merge-tree"
    args: ["--write-tree", "origin/{repo.trunk}", "origin/requirement/{cr_id}"]
    cwd: "{repo.path}"
```

记录每个 repo 的 `preflight-trunk-sha` 与 `source-branch-sha`。任一仓 dry-run 失败或存在冲突时停止执行；此时不得产生任何本地 merge commit，不得 push。

### Step 3 — 全仓本地合并与 commit（push 前必须全部成功）

对每个参与仓顺序执行本地 no-commit merge：

```yaml
- runGit: { subcommand: "checkout", args: ["{repo.trunk}"], cwd: "{repo.path}" }
- runGit: { subcommand: "pull", args: ["--ff-only", "origin", "{repo.trunk}"], cwd: "{repo.path}" }
- runGit:
    subcommand: "merge"
    args: ["--no-commit", "--no-ff", "origin/requirement/{cr_id}"]
    cwd: "{repo.path}"
```

若任一 repo 本地 merge 失败：
1. 对所有已进入 no-commit merge 的 repo 执行 `merge --abort`。
2. 输出 `MERGE_LOCAL_PREPARE_FAILED`，列出失败 repo 与冲突文件。
3. 不得 commit，不得 push，不得继续回写 specs/delivery。

所有 repo 本地 merge 都成功后，再对每个 repo 执行：

```yaml
- runGit:
    subcommand: "commit"
    args: ["-m", "merge({cr_id}): {cr_title}"]
    cwd: "{repo.path}"
- runGit: { subcommand: "rev-parse", args: ["HEAD"], cwd: "{repo.path}" }
```

记录每个 repo 的本地 merge commit SHA。

### Step 4 — 远端新鲜度复核与统一 push

push 前再次对每个 repo 执行：

```yaml
- runGit: { subcommand: "fetch", args: ["origin"], cwd: "{repo.path}" }
- runGit: { subcommand: "rev-parse", args: ["origin/{repo.trunk}"], cwd: "{repo.path}" }
```

若任一 repo 的 `origin/{repo.trunk}` 已不等于 Step 2 记录的 `preflight-trunk-sha`，返回 `MERGE_REMOTE_STALE`，不得 push；要求重新运行本 Skill。

全部 repo 复核通过后，逐仓执行：

```yaml
- runGit: { subcommand: "push", args: ["origin", "{repo.trunk}"], cwd: "{repo.path}" }
```

若 push 阶段出现失败，进入自动补偿：

1. 对已成功 push 的 repo，确认 `origin/{repo.trunk}` 仍等于本次 `merge-sha`；若不相等，返回 `MERGE_REMOTE_COMPENSATION_BLOCKED`，不得继续 writeback，不得改 CR status。
2. 对确认可补偿的 repo 执行：
   ```yaml
   - runGit: { subcommand: "checkout", args: ["{repo.trunk}"], cwd: "{repo.path}" }
   - runGit: { subcommand: "pull", args: ["--ff-only", "origin", "{repo.trunk}"], cwd: "{repo.path}" }
   - runGit: { subcommand: "revert", args: ["--no-edit", "-m", "1", "{merge-sha}"], cwd: "{repo.path}" }
   - runGit: { subcommand: "push", args: ["origin", "{repo.trunk}"], cwd: "{repo.path}" }
   ```
3. 补偿成功后输出 `MERGE_REMOTE_COMPENSATED`，列出失败 repo、已补偿 repo、revert commit SHA 与重试建议；CR status 保持 `code-approved`，不得继续 writeback。
4. 若补偿过程中任一 repo 失败，输出 `MERGE_REMOTE_COMPENSATION_FAILED`，列出已补偿与未补偿 repo，并将 `merge-recovery` 记录写入 `change-requests/_backlog.yml` 对应 CR 条目；不得继续 writeback，不得清理 worktree 或远端分支。

只有全部 repo push 成功才进入下一步。

### Step 5 — 更新 CR status

全部 repo push 成功后，必须将每个 repo 的 merge SHA 与 CR status 在同一知识库 commit 中发布，避免 trunk 已合并但 CR 元数据缺失：

1. 调用 `cr-status-set`，参数为 `next_status=merging`、`trigger=merge-feature-branch`、`expected_current_status=code-approved`、`commit_mode=embedded`，只获取已校验的 status patch，不单独 commit。
2. 将每个 repo 的 merge SHA 写入 `change-requests/_backlog.yml` 对应条目的 `merge-commits` 字段：

```yaml
merge-commits:
  - repo: {repo.id}
    trunk: {repo.trunk}
    sha: {merge-sha}
    branch: requirement/{cr_id}
    source-sha: {source-branch-sha}
    merged-at: {YYYY-MM-DDTHH:mm:ss+08:00}
```

3. 同步更新 `change-requests/{cr_id}/cr.md` frontmatter status=`merging`。
4. 在 knowledge-base trunk 提交并推送，并记录本次 metadata commit SHA：
   ```yaml
   - runGit: { subcommand: "add", args: ["change-requests/_backlog.yml", "change-requests/{cr_id}/cr.md"], cwd: "{knowledgeBaseRepo.path}" }
   - runGit: { subcommand: "commit", args: ["-m", "[cr] merge metadata {cr_id}"], cwd: "{knowledgeBaseRepo.path}" }
   - runGit: { subcommand: "rev-parse", args: ["HEAD"], cwd: "{knowledgeBaseRepo.path}" }
   - runGit: { subcommand: "push", args: ["origin", "{knowledgeBaseRepo.trunk}"], cwd: "{knowledgeBaseRepo.path}" }
   ```
5. 若 metadata commit/push 失败：
   - 先 `fetch origin {knowledgeBaseRepo.trunk}`，确认 metadata commit SHA 是否已包含在 `origin/{knowledgeBaseRepo.trunk}`；若已包含，视为 metadata 发布成功，继续 Step 6。
   - 若未包含，必须对全部已 push 的代码 repo 执行 Step 4 的补偿 revert。
   - 代码 repo 补偿全部成功后，必须回滚 knowledge-base 本地 metadata 变更，使 `_backlog.yml` 与 `cr.md` 恢复 `code-approved` 且移除本次 `merge-commits`；若 metadata commit 已产生，使用 `git revert --no-edit {metadata-sha}` 生成显式回滚提交，并尝试推送 `[cr] rollback merge metadata {cr_id}`。
   - metadata 本地回滚成功后输出 `MERGE_METADATA_PUBLISH_COMPENSATED`，CR status 保持 `code-approved`，不得进入 writeback。
   - 若代码 repo 补偿任一失败，输出 `MERGE_METADATA_PUBLISH_COMPENSATION_FAILED`，写入 `merge-recovery` 记录，列出已合并 repo、补偿状态和阻塞原因；不得进入 writeback 或清理分支。
   - 若代码 repo 补偿成功但 metadata 本地回滚或回滚发布失败，输出 `MERGE_METADATA_ROLLBACK_FAILED`，写入 `merge-recovery` 记录，列出 metadata-sha、rollback-sha（若有）与下一次自动恢复入口；不得进入 writeback。

### Step 6 — 输出摘要

```
✅ 分支合并完成
   CR                  : {cr_id}
   merge commits       : [{repo.id}:{sha8}, ...]
   Worktree            : 保留，等待 cr-archive 统一清理
   下一步              : 执行 writeback-prd-sdd
```

---

## 错误处理

| 错误 | 处理 |
|------|------|
| dry-run 冲突 | 停止执行，列出冲突文件；不得产生本地 commit 或远端 push |
| 本地 no-commit merge 失败 | 对已进入 merge 的 repo 执行 `merge --abort`，停止执行 |
| push 前远端 trunk 变化 | 返回 `MERGE_REMOTE_STALE`，不得 push，要求重新运行 |
| push 阶段部分失败且补偿成功 | 返回 `MERGE_REMOTE_COMPENSATED`，CR status 保持 `code-approved`，不得 writeback |
| push 阶段部分失败且补偿受阻 | 返回 `MERGE_REMOTE_COMPENSATION_BLOCKED` 或 `MERGE_REMOTE_COMPENSATION_FAILED`，写入 `merge-recovery` 记录，不得 writeback |
| 全部 push 成功但 merge metadata 发布失败 | 执行全仓补偿并回滚本地 metadata；返回 `MERGE_METADATA_PUBLISH_COMPENSATED`、`MERGE_METADATA_PUBLISH_COMPENSATION_FAILED` 或 `MERGE_METADATA_ROLLBACK_FAILED`，不得 writeback |
| CR status 非 `code-approved` | 停止执行 |
| 受控 shell 不可用 | 返回 `SHELL_UNAVAILABLE` 结构化错误，不输出手工 git 指令 |

---
name: cr-archive
description: "归档新四阶段 CR：以 cr.md frontmatter status 为 final-status 权威源，将 archived/rejected/withdrawn CR 从 backlog 原子移入 history，并统一清理 requirement worktree 与远端分支。"
---

# Skill: cr-archive

**类型**: 原子 Skill  
**触发时机**: feature-writeback pipeline 最终步骤，`writeback-traceability` 已生成追溯链

---

## 用途

将新四阶段 CR 从 `change-requests/_backlog.yml` 移出，追加到 `change-requests/_history.yml`。成功回写场景必须通过 `crctl advance --to archived --trigger cr-archive --expect writing-back --embedded` 校验 `writing-back → archived`，并在同一个归档账本 commit 中同步 `cr.md`、`_backlog.yml`、`_history.yml` 与 `_index.yml`（经 `crctl archive-move` 一并完成，见 Step 3）。主动撤回或拒绝场景可保留 `withdrawn` / `rejected` 作为 final-status 归档。

---

## 前置条件

| 条件 | 说明 |
|------|------|
| CR 状态 | 成功回写必须为 `writing-back`；终止归档可为 `rejected` / `withdrawn` |
<!-- lint-prompts:ignore --> 描述性：归档流程说明（实际写入走 crctl archive-move）
| 文件存在 | 首次归档时 `change-requests/_backlog.yml` 的 `backlog[]` 中存在该 CR 条目；发布/清理重试时允许该 CR 已在 `_history.yml` 中 |
| 成功回写证据 | `specs/{spec_id}/traceability.yml` 已由 `writeback-traceability` 生成 |

---

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cr_id` | string | ✅ | 要归档的 CR 标识符（如 `CR-2026-001`） |
| `spec_id` | string | 成功回写必填 | 回写目标 spec id |
| `archive_reason` | string | ❌ | 归档原因摘要；默认根据 status 推导 |
| `cleanup_branch` | bool | ❌ | 是否清理远端 requirement/{cr_id} 与本地 worktree，默认 `true` |

---

## 操作步骤

### Step 1 — 校验前置条件

<!-- lint-prompts:ignore --> 描述性：归档流程说明（实际写入走 crctl archive-move）
1. 读取 `change-requests/_backlog.yml`、`change-requests/_history.yml` 与可选 `change-requests/{cr_id}/cleanup-report.yml`。
<!-- lint-prompts:ignore --> 描述性：归档流程说明（实际写入走 crctl archive-move）
2. 若 `_history.yml` 已存在该 CR：
   - 先 `fetch origin {knowledgeBaseRepo.trunk}`，确认包含该 CR 的归档账本已发布到 `origin/{knowledgeBaseRepo.trunk}`。
   - 若工作区仍有归档账本相关未提交变更，或本地 trunk 含归档提交但 `origin/{knowledgeBaseRepo.trunk}` 尚未包含，进入 `publish-retry` 模式，跳过 Step 2-5，只执行 Step 6；Step 6 成功后再进入 Step 7。
   - 若 `cleanup-report.yml cleanup-status=pending`，进入 `cleanup-retry` 模式，跳过 Step 2-6，只执行 Step 7。
   - 若归档账本已发布且 cleanup 已完成或无需 cleanup，返回幂等结果：CR 已归档，无需重复移动 backlog/history。
<!-- lint-prompts:ignore --> 描述性：归档流程说明（实际写入走 crctl archive-move）
3. 若 `_backlog.yml` 中存在该 CR，读取 `change-requests/{cr_id}/cr.md` frontmatter 的 `status` 字段作为权威当前状态。
4. 若 status=`writing-back`：
   - 确认 `spec_id` 存在
   - 确认 `specs/{spec_id}/traceability.yml` 存在
   - 调用 `crctl advance --to archived --trigger cr-archive --expect writing-back --embedded`，只获取已校验的 status patch，不单独 commit
   - 设置 `final-status=archived`
<!-- lint-prompts:ignore --> 描述性：归档流程说明（实际写入走 crctl archive-move）
5. 若 status=`archived` 且仍在 `_backlog.yml` 中：
   - 视为旧版或上次本地归档发布失败留下的 `archive-repair` 状态，允许继续执行 Step 2-6，将 backlog 条目移入 history
   - 设置 `final-status=archived`
6. 若 status=`rejected` 或 `withdrawn`：
   - 设置 `final-status` 为当前 status
   - 不要求 writeback 产物
7. 其他 status 一律抛出 `CR_ARCHIVE_STATUS_NOT_ALLOWED`

### Step 2 — 归档事件（CR-2026-027 FR-11：随 archive-move 同一 CAS，不再独立 inbox-emit）

归档事件与账本移动是同一业务事实：`archive-move` 在内存构造 archive event（复用 inbox-emit 同构的 notify-log 行，含 `final-status` / `archive-reason` / 可选 `writeback-spec-id` / `archived-at`），与 backlog/history/index 三账本同一 `casWriteMulti` 写入，CAS 成功后发 archive outbox。收件人由 crctl 从 backlog 条目的 `owners.{requirement,development,test}.id` 去重解析（旧条目缺 owners 回退顶层 `owner`；最终为空 → `ARCHIVE_RECIPIENTS_MISSING` 硬失败）。**不得单独调用 `inbox-emit` 发归档事件**（历史缺陷：中文 JSON Shell 转义失败后事件永久丢失，CR-2026-026 实测）。

### Step 3 — 原子移动 backlog → history（经 crctl archive-move，禁止手写 YAML）

1. 调用 `crctl archive-move <CR-ID> --final-status {final-status} [--archive-reason "{archive_reason 或系统推导}"] [--spec-id {spec_id}] --workspace {knowledgeBaseRepo.path}`
<!-- lint-prompts:ignore --> 描述性：归档流程说明（实际写入走 crctl archive-move）
2. archive-move 原子完成三账本（CR-2026-027 FR-11）：`_backlog.yml` 删除该条目 + `_history.yml` 追加富化条目（原条目字段 + `final-status` / `archive-reason` / `writeback-spec-id` / `archived-at` + notify-log 归档事件）+ `_index.yml` 更新终态三字段（`status` / `archived-at` / 可选 `writeback-spec-id`，D-2：不复制 history、不删除条目）——同一 `casWriteMulti` 三文件 CAS（任一侧读后被改则整体 `CAS_CONFLICT` 中止、三侧均不落盘），CAS 成功后发 archive outbox，并写 `.crctl/audit.log`
3. 前置守卫：`--final-status` 必须等于 cr.md 当前终态（`archived` / `rejected` / `withdrawn`，由 Step 1 的 `crctl advance --to archived --trigger cr-archive` 推进）；重复归档（CR 已移出 backlog 且 history final-status 一致）返回 `already-archived` 幂等结果（零写入），不一致返回 `FINAL_STATUS_MISMATCH`（TD-BL-3）
4. `_index.yml` 为全生命周期轻量目录：归档只更新终态摘要字段，不复制完整 history 条目、不新增 `history-ref`、不删除条目，也不成为新的查询事实源（查询仍读 backlog + history + cr.md）
<!-- lint-prompts:ignore --> 描述性：归档流程说明（实际写入走 crctl archive-move）
4. **禁止会话内手写/现写脚本编辑 `_backlog.yml` / `_history.yml`**（纪律 #7）：归档账本唯一写入通道是 `crctl archive-move`

### Step 5 —（已并入 Step 3：`crctl archive-move` 一并更新 _index.yml，本步不再手写账本）

### Step 6 — 提交并推送归档记录

在执行任何 worktree 或远端分支清理之前，必须先将归档账本提交并推送到 knowledge-base trunk：

```yaml
<!-- lint-prompts:ignore --> 描述性：归档流程说明（实际写入走 crctl archive-move）
- runGit: { subcommand: "add", args: ["change-requests/_backlog.yml", "change-requests/_history.yml", "change-requests/_index.yml", "change-requests/{cr_id}/"], cwd: "{knowledgeBaseRepo.path}" }
- runGit: { subcommand: "commit", args: ["-m", "[cr] archive {cr_id} final-status={final-status}"], cwd: "{knowledgeBaseRepo.path}" }
- runGit: { subcommand: "push", args: ["origin", "{knowledgeBaseRepo.trunk}"], cwd: "{knowledgeBaseRepo.path}" }
```

若处于 `publish-retry` 模式：

1. 若归档账本变更仍未提交，先执行上述 `add` / `commit`。
2. 若归档账本 commit 已存在于本地 trunk 但尚未出现在 `origin/{knowledgeBaseRepo.trunk}`，只重试 `push origin {knowledgeBaseRepo.trunk}`，不得重复追加 history。
3. push 后再次 `fetch` 并确认 `origin/{knowledgeBaseRepo.trunk}` 已包含本次归档账本；确认失败则继续返回 `CR_ARCHIVE_RECORD_PUBLISH_FAILED`。

<!-- lint-prompts:ignore --> 描述性：归档流程说明（实际写入走 crctl archive-move）
若 commit 或 push 失败，返回 `CR_ARCHIVE_RECORD_PUBLISH_FAILED`，不得清理 worktree 或远端分支；此时 `_backlog.yml`、`_history.yml`、`_index.yml` 与 `cr.md` 可能处于本地已改未提交或本地已提交未推送状态，必须保留现场等待重试，不得继续。再次执行时：

- 若本地状态已是 `archived` 且 backlog 中仍有该 CR，按 Step 1 的 `archive-repair` 继续完成发布。
<!-- lint-prompts:ignore --> 描述性：归档流程说明（实际写入走 crctl archive-move）
- 若 `_history.yml` 已存在该 CR 但远端尚未包含归档账本，按 Step 1 的 `publish-retry` 只重试发布，不重复移动 backlog/history。

### Step 7 — requirement worktree / 分支清理

若 `cleanup_branch=true`（默认）：

<!-- lint-prompts:ignore --> 描述性：归档流程说明（实际写入走 crctl archive-move）
1. 若处于 `cleanup-retry` 模式，从 `cleanup-report.yml` 与 `_history.yml` 读取 `spec_id`、`final-status`、`merge-commits[]` 和待清理 repo；否则读取当前归档上下文。
2. 读取 `dir-graph.yaml#repositories`，解析所有 active repo 与对应 CR worktree。**待清理 repo = 全部 active repo，含无 `merge-commits[]` 条目的"无改动仓"**（该 CR 在其无代码改动、merge-feature-branch 跳过合并的仓）：其 `requirement/{cr_id}` worktree 自注册派生起即存在，即使未合并也必须清理，不得因"未参与合并"而跳过（CR-2026-019 曾因此残留 multica 空 worktree）。
3. 对所有待清理 repo 做**分级删除预检**：
   - 有 `merge-commits[]` 条目的仓：确认当前 trunk 已包含对应 SHA；任一此类 repo 预检失败则跳过所有远端分支删除，只写 `cleanup-pending` 报告并保留本地 worktree。
   - 无 `merge-commits[]` 条目的无改动仓：跳过预检（无 merge 可验证），直接进入 worktree 清理。
4. 通过 `controlled-shell` 清理本地 worktree：
   - knowledge-base: `.rayai-worktrees/knowledge-base/requirement/{cr_id}`
   - 独立代码仓: `.rayai-worktrees/{repo.id}/requirement/{cr_id}`
   - **Windows 环境**：`git worktree remove` 可能因 `Filename too long` 失败。兜底清理链按顺序执行，三步缺一不可：`crctl git worktree remove --force` → `Remove-Item -Recurse -Force` → `git worktree prune`（漏掉最后一步会残留 `.git/worktrees/<name>` 元数据，挡下一个同名 CR 的 `worktree add`）。根治方式是一次性配置 `git config --global core.longpaths true`。详见 `docs/Windows-已知问题清单.md`。
5. worktree 不存在时视为已清理，记录为 `skipped-missing`，不得让归档失败。
6. 预检通过后删除远端 `requirement/{cr_id}` 分支：
   - 有 `merge-commits[]` 的仓：预检通过后按下方 runGit 序列删除。
   - 无改动仓：远端分支**存在才删**（可能从未推送，如无代码改动仓），不存在则记录 `skipped-no-remote-branch`，不报错、不阻塞清理完成。
   ```yaml
   - runGit: { subcommand: "worktree", args: ["remove", "{worktreePath}"], cwd: "{repo.path}" }
   - runGit: { subcommand: "push", args: ["origin", "--delete", "requirement/{cr_id}"], cwd: "{repo.path}" }
   ```
7. 非成功回写的 `rejected` / `withdrawn` 归档只清理 worktree，不删除远端分支，除非用户显式要求。
8. 若任一清理动作失败，不回滚已发布的归档记录；写入 `change-requests/{cr_id}/cleanup-report.yml`，记录 `cleanup-status: pending`、失败 repo、失败动作与可重试条件，并提交推送 `[cr] cleanup pending {cr_id}`。
9. 若清理全部完成，写入或更新 `cleanup-report.yml cleanup-status=done` 并提交推送 `[cr] cleanup done {cr_id}`。若这是 cleanup retry，则只提交 cleanup-report，不重复移动 backlog/history。

---

## 输出

```
✅ CR {cr_id} 已归档
   final-status : {final-status}
   archive_reason : {archive_reason}
   _backlog     : 已移除
   _history     : 已追加（共 N 条历史记录）
   _index       : status 已更新
   writeback_spec_id : {spec_id 或 N/A}
   cleanup      : {done | skipped | cleanup-pending}
```

---

## 错误码

| 错误码 | 含义 | 处理方式 |
|--------|------|----------|
<!-- lint-prompts:ignore --> 描述性：归档流程说明（实际写入走 crctl archive-move）
| `CR_ARCHIVE_NOT_FOUND` | _backlog.yml 中无该 CR | 检查 cr_id 是否正确；若已归档则无需重复操作 |
| `CR_ARCHIVE_STATUS_NOT_ALLOWED` | CR 当前状态不可归档 | 先完成对应 pipeline gate |
| `CR_ARCHIVE_TRACEABILITY_MISSING` | 成功回写场景缺少 traceability.yml | 先运行 `writeback-traceability` |
| `CR_ARCHIVE_STATUS_SYNC_FAILED` | embedded status patch 写入 `cr.md` 后与预期不一致 | 停止归档，修复状态后重试 |
<!-- lint-prompts:ignore --> 描述性：归档流程说明（实际写入走 crctl archive-move）
| `CR_ARCHIVE_HISTORY_WRITE_FAIL` | _history.yml 写入失败 | 修复文件权限或格式问题后重试，不进入清理阶段 |
| `CR_ARCHIVE_RECORD_PUBLISH_FAILED` | 归档账本 commit/push 失败 | 不执行清理，保留 worktree 与远端分支，重试归档发布 |
| `CR_ARCHIVE_CLEANUP_PENDING` | 归档已发布但清理未全部完成 | 保留 cleanup-report.yml，后续重试 cleanup |

# .githooks

Git 不会自动使用这个目录——`.git/hooks/` 才是默认路径，且不随仓库分发。启用本目录下的钩子需要每人一次性执行：

```bash
git config core.hooksPath .githooks
```

## 当前钩子

| 钩子 | 作用 |
|---|---|
| `pre-commit` | 跑 `check-skill-matrix.mjs`（架构评审 §5.2，校验 `skills/_index.yml` / `agent-skill-matrix.yml` / `AGENT-SKILL-MATRIX.md` 三者归属一致）+ `check-agents-contract.mjs`（CR-2026-001 TASK-05，校验 `dir-graph.yaml#agents.contract` 不变式 1-3：agent 登记双向存在、references 的 skill 必须 active、且落在该 actor 的矩阵可调用集合；不变式 4 为行为约束由 crctl 运行时承担），任一失败则拒绝本次 commit |

未执行 `git config core.hooksPath .githooks` 的 clone 不受影响（不会报错，只是没有本地拦截）——CI 里的 `check-skill-matrix.yml` 是不依赖此配置的兜底。

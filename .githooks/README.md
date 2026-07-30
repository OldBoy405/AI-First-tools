# .githooks

Git 不会自动使用这个目录——`.git/hooks/` 才是默认路径，且不随仓库分发。启用本目录下的钩子需要每人一次性执行：

```bash
git config core.hooksPath .githooks
```

## 当前钩子

| 钩子 | 作用 |
|---|---|
| `pre-commit` | 跑 `check-skill-matrix.mjs`（架构评审 §5.2），校验 `skills/_index.yml` / `agent-skill-matrix.yml` / `AGENT-SKILL-MATRIX.md` 三者的归属声明一致，不一致则拒绝本次 commit |

未执行 `git config core.hooksPath .githooks` 的 clone 不受影响（不会报错，只是没有本地拦截）——CI 里的 `check-skill-matrix.yml` 是不依赖此配置的兜底。

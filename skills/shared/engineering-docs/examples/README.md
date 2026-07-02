# examples

本目录是 engineering-docs skill 输出的"可参考骨架"。每份文件都能通过 `engdocs validate`，用于：

- Agent 冷启动时对照格式
- 新文档类型接入时作为最小活样本
- 回归测试时作为已知-良好输入

## 复现方式

在 `scripts/` 目录执行：

```bash
pnpm install
pnpm run build

# 重新生成 PRD 示例（若删除再生成会得到同名文件）
node dist/cli.js gen PRD \
  --name sample-login \
  --title "示例·用户登录" \
  --owner product-brain \
  --out ../examples

# 重新生成 PLAN 示例
node dist/cli.js gen PLAN \
  --name sample-mvp \
  --title "示例·MVP 迭代计划" \
  --owner eng-brain \
  --version v1.0 \
  --module MODULE-001 \
  --out ../examples

# 校验
node dist/cli.js validate ../examples/PRD-001-sample-login.md
node dist/cli.js validate ../examples/PLAN-v1.0-001-sample-mvp.md
```

## 文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `PRD-001-sample-login.md` | PRD | 登录需求示例，`status: approved` 便于下游 gate 放行 |
| `PLAN-v1.0-001-sample-mvp.md` | PLAN | 迭代计划示例，`refs.upstream` 指向一个虚拟 `MODULE-001` |

## 注意

- 示例中 PLAN 的 `refs.upstream: [MODULE-001]` 是占位；本目录不含真实 MODULE，因此 `chain-check` 在本目录上会报 `required-upstream` 缺失——这是预期现象。
- 真实 feature 目录请让链路从 PRD 贯穿到 TASK。

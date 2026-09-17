# OutputGuard（FR-1 通用工具结果守卫）

本目录是「运行期工具结果进入下一轮模型上下文之前」的确定性裁剪面（CR-2026-069 / FR-1）。它只做三类机械变换（唯一文件列表 / 连续行窗口 + 原始行号 / 头尾保留），不做语义压缩、不调用 LLM、不做完整 shell 解析。

## 权威入口（唯一事实源，此处不复刻其内容）

| 文件 | 承载 |
|---|---|
| `policy.json` | 阈值、命令族、裁剪形态、提示文案、逃生阀标记 |
| `capabilities.json` | 五个 Runtime 的能力声明与启用顺序、`preserve` 取值 |
| `conformance.json` | 跨 Adapter 共享测试向量与声明向量数 |

## 组成

- `core.mjs` —— 纯函数 Core（无 fs / 无时钟 / 无随机 / 无环境读取；阈值只从入参取）。
- `adapters/<runtime>/` —— 各 Runtime 的 hook 入口、安装模板与安装说明；只做映射，不含阈值判断。
- `scripts/check-install.mjs` —— 只读启动检查：逐 Runtime 一行读数 + 缺失/损坏时的修复动作说明（不自动安装、不改写用户配置、不修复 Runtime）。
- `test/` —— Core / 向量 / Adapter 合同三个回归面（由 CI 与 `crctl` 证据命令执行）。

## 安装与回滚

安装 = 把对应 Runtime 的模板并入其原生配置面（显式一次），详见各 `adapters/<runtime>/README.md`；claude 的 Managed 面由 `../multica` 的 daemon 单写入点合成，不经本目录安装。回滚 = 移除该 Runtime 的安装条目（新会话生效），其余 Runtime 不受影响。

## 加载路径

Adapter 通过**相对说明符**读取同一 Release 的 `../../core.mjs` 与 `../../policy.json`（不复制 policy、不在运行期依赖绝对路径）。`OUTPUT_GUARD_POLICY_PATH` / `OUTPUT_GUARD_CAPABILITIES_PATH` 可覆盖读取面，仅供检查与合同测试使用。

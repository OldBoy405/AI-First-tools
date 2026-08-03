# Windows 环境已知问题清单

> 适用范围：在 Windows 工作站上执行 tools 包各 Skill（cr-archive / merge-feature-branch / requirement-register 等）涉及的 git 操作。
> 本文档是 Windows 环境卡点的单一事实源，各 Skill 文档引用本文而非各自复述。

---

## 1. worktree 删除 `Filename too long`

**现象**：`git worktree remove` 失败，报 `Filename too long`（Windows 默认 MAX_PATH=260 限制）。

**根治（一次性配置，推荐）**：

```powershell
git config --global core.longpaths true
```

配置后 git 自身的长路径操作不再受限，比每次失败后兜底更便宜。

**兜底清理链**（未配置 core.longpaths 或 git 仍失败时，按顺序执行，三步缺一不可）：

```powershell
git worktree remove --force <worktreePath>     # 第一步：git 原生删除
Remove-Item -Recurse -Force <worktreePath>     # 第二步：git 失败后的文件系统兜底
git worktree prune                             # 第三步：清理残留的 worktree 元数据
```

漏掉第三步会残留 `.git/worktrees/<name>` 元数据，导致下一个同名 CR 的 `git worktree add` 报"已被占用"。

## 2. SSL 代理拦截

**现象**：`git fetch` / `git push` 失败，报 SSL 证书校验错误（企业代理 / 抓包工具拦截 HTTPS）。

**排查顺序**：

1. 确认是否处于需要代理的网络环境：`git config --get http.proxy`。
2. 若是公司代理自带根证书，将代理 CA 导入 Windows 受信根证书存储，或配置 git 使用该 CA 包：`git config --global http.sslCAInfo <path-to-ca-bundle.pem>`。
3. **禁止**用 `git config --global http.sslVerify false` 绕过——那会关闭所有 HTTPS 仓库的证书校验，属安全隐患。

## 3. CRLF 行尾

**现象**：Windows `core.autocrlf=true` 会把检出文件的 `LF` 改写成 `CRLF`，导致对仓库文件做哈希、跨行正则、逐行解析的代码得到与类 Unix 环境不一致的结果。

**纪律**：

- 任何对仓库文件做哈希、跨行正则、逐行解析的代码，读入后必须先把 `\r\n` 规范化为 `\n`。
- 解析器统一用 `split(/\r?\n/)` 或等价形态。
- 跨行正则解析失败必须硬失败报错，禁止静默降级（匹配不到就返回空集合会静默丢数据）。

---

*本文档由 CR-2026-012 收尾复盘（docs/analysis/CR-2026-012-合并回写归档复盘.md §3.1 T4+T5）沉淀。*
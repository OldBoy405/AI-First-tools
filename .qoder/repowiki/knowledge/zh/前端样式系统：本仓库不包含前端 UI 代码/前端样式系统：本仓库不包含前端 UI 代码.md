---
kind: frontend_style
name: 前端样式系统：本仓库不包含前端 UI 代码
category: frontend_style
scope:
    - '**'
---

经全面检索，该仓库为 AI First 研发协同平台的 Tools 包，核心内容是 Agent 能力定义（agents/）、Skill 声明文件（skills/）与 Pipeline 模板（pipeline-templates/），全部以 Markdown、YAML、JSON 等纯文本契约形式组织。仓库中不存在任何 CSS、SCSS、Tailwind 配置、设计令牌或前端组件库引用，唯一匹配到的一处 `theme` 出现在 SKILL.md 的变量占位符 `{theme}` 中，仅用于文档渲染时的主题名注入，并非样式系统实现。因此，frontend_style 类别不适用于此仓库。
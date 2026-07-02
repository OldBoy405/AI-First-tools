---
name: validate-doc
description: "通用文档校验（frontmatter 完整性）"
---

# validate-doc — 通用文档校验

## 触发条件
任何文档写入/修订完成后；或用户明确要求「校验」

## 校验维度
1. **frontmatter 完整性**：必填字段是否存在（对照文档类型约定）
2. **gate 合规性**：流程 gate 由 pipeline 配置决定，当前阶段跳过此维度校验
3. **命名合规性**：文件名是否符合 dir-graph.yaml 中对应类型的 naming 规则
4. **路径合规性**：文件是否在 dir-graph.yaml 声明的 locations 中
5. **引用一致性**：depends-on / plan 等引用字段的目标文件是否存在

## 输出
校验报告（控制台输出）：
- `PASS`：全部通过
- `WARN`：建议修复（非阻断）
- `FAIL`：必须修复（阻断写入）

## 执行时机
所有写入型 Skill（write-requirement-prd / write-tech-design / write-dev-plan / write-dev-tasks / write-planning-report / write-planning-entry / writeback-* / record-adr）在写入后自动调用本 Skill。

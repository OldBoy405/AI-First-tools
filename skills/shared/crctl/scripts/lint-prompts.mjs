#!/usr/bin/env node
/**
 * lint-prompts — prompt↔crctl 漂移检测器（CR-2026-021 TASK-11，SDD §4.3）
 *
 * 检测：skills 目录下的 SKILL.md + pipeline-templates/*.json 的 prompt 文本是否出现
 * "crctl 已接管/已禁止的手写操作"（CONTRADICTS/STALE-REF/OUTDATED）。
 * 判据直读 rules.json（R1 deny 面、R2 git 白名单）与字面黑名单（R3/R4），
 * 不经过任何派生快照（SDD §4.0：与 crctl capabilities 解耦）。
 *
 * 用法：
 *   node skills/shared/crctl/scripts/lint-prompts.mjs [--mode report|enforce] [--root <dir>]
 *   --mode report（默认）：输出 file:line + 规则 + 级别，退出 0（不阻断提交）
 *   --mode enforce：命中 CONTRADICTS/STALE-REF 即退出 1（LINT_DRIFT）
 * 规则：R1~R6（CR-2026-021）+ R7（crctl 命令参数形态：advance --to/--trigger、全角/伪旗标、backlog-set 字段白名单、--template subject 编号）+ R8（inbox-emit 接口：函数式违例、--event 枚举）
 *   豁免契约（CR-2026-022 FR-25）：<!-- lint-prompts:ignore --> 只豁免其所在行 ± radius 行（radius=1，测试向量固化），不再整段生效
 *
 * 零第三方依赖（不变量 3）；读入先 CRLF 归一（纪律 #1）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..'); // tools 包根
const RULES_PATH = process.env.CRCTL_RULES_PATH || path.resolve(__dirname, '..', '..', 'controlled-shell', 'rules.json');
const CRCTL_PATH = path.resolve(__dirname, 'crctl.mjs'); // R7 判据源：backlog-set 字段白名单
const INBOX_SKILL_PATH = path.resolve(__dirname, '..', '..', '..', 'cr', 'inbox-emit', 'SKILL.md'); // R8 判据源：event 枚举

/* ────────────────────────── 判据加载（直读 rules.json / 字面黑名单） ────────────────────────── */

function loadJudgements() {
  const j = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  // R1 行内匹配用无锚版本：deny 正则的 ^$ 锚只对整文件路径成立，prompt 行内目标文件后常跟其他文本
  const denyFilesLoose = (j.protectedPaths?.deny || []).map((re) => new RegExp(re.replace(/^\^/, '').replace(/\$/, ''), 'i'));
  const gitSubs = new Set((j.git || []).map((e) => e.sub));
  // R7 判据：backlog-set 字段白名单直读 crctl.mjs 常量（FR-24，零派生物）
  const crctlSrc = fs.readFileSync(CRCTL_PATH, 'utf8').replaceAll('\r\n', '\n');
  const bsm = crctlSrc.match(/const BACKLOG_SET_FIELDS = \[([^\]]*)\]/);
  const backlogSetFields = new Set(bsm ? (bsm[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)) : []);
  // R8 判据：inbox-emit event 枚举直读 SKILL 参数表（FR-24）
  const inboxSkill = fs.readFileSync(INBOX_SKILL_PATH, 'utf8').replaceAll('\r\n', '\n');
  const evLine = inboxSkill.split('\n').find((l) => l.includes('| `event` |')) || '';
  const inboxEvents = new Set([...evLine.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).filter((s) => s !== 'event'));
  return { denyFilesLoose, gitSubs, backlogSetFields, inboxEvents };
}

const LITERAL_BLACKLIST = {
  R3: ['cr-status-set'],                       // deprecated 机制引用
  R4: ['source-sha', 'merged-at', '六字段'],    // merge-commits 过时口径（必填 3 字段，FR-8）
  R5: ['review-loop.current-attempt', 'attempts[]'], // 手写 review-loop 记账
};

// 写动词（中英）：段内出现 deny 文件 + 写动词 + 无 crctl 调用 → R1 命中
const WRITE_VERBS = /写|写入|创建|编辑|更新|追加|手写|修改|改写|改动|write|create|edit|update|append|persist/i;
const CRCTL_CALL = /crctl\s+[a-z-]+/i; // 同段有 crctl 调用则视为"正确示范/已迁移"，不判 R1

/* ────────────────────────── 文件遍历与段落切分 ────────────────────────── */

function walkFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (name === 'node_modules' || name === '.git') continue;
        walk(p);
      } else if (name === 'SKILL.md' || name.endsWith('.pipeline.json')) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

/** SKILL.md 段落切分：按 Markdown 标题（^#{1,3} ）为段界；段内记录起始行号。 */
function splitMarkdown(text) {
  const norm = text.replaceAll('\r\n', '\n');
  const lines = norm.split('\n');
  const paras = [];
  let cur = [];
  let startLine = 1;
  const flush = () => {
    if (cur.length) paras.push({ text: cur.join('\n'), startLine });
    cur = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) { flush(); startLine = i + 1; }
    cur.push(lines[i]);
  }
  flush();
  return paras;
}

/** pipeline JSON 段落切分：每个 node.prompt 字符串为一段（prompt 内不再细分，行号=节点起始）。 */
function splitPipelineJson(text) {
  const norm = text.replaceAll('\r\n', '\n');
  const paras = [];
  try {
    const doc = JSON.parse(norm);
    for (const node of doc.nodes || []) {
      if (typeof node.prompt === 'string' && node.prompt.trim()) {
        const idx = norm.indexOf(node.prompt);
        const lineNo = idx === -1 ? 1 : norm.slice(0, idx).split('\n').length;
        paras.push({ text: node.prompt, startLine: lineNo, nodeRef: node.ref || '' });
      }
    }
  } catch { /* JSON 解析失败：降级为整文件一段（保留行号 1）——lint 是只读检查器，不 fail */ }
  return paras;
}

/* ────────────────────────── 规则集 R1~R6 ────────────────────────── */

function runRules(para, ctx) {
  const findings = [];
  const t = para.text;
  const lines = t.split('\n');
  const crctlNearby = CRCTL_CALL.test(t);
  const writeVerb = WRITE_VERBS.test(t);
  // R1 手写 guard-deny 文件（判据来自 rules.json deny 面，未来新增 deny 自动覆盖）
  if (writeVerb && !crctlNearby) {
    for (let li = 0; li < lines.length; li++) {
      for (const re of ctx.denyFilesLoose) {
        const m = lines[li].match(re);
        if (m) {
          findings.push({ rule: 'R1', level: 'CONTRADICTS', file: ctx.file, line: para.startLine + li, why: `指示手写 guard-deny 文件 ${m[0]}，且同段无 crctl 调用` });
        }
      }
    }
  }
  // R2 裸 git（白名单子命令字面出现且非 crctl git）
  for (const sub of ctx.gitSubs) {
    const re = new RegExp(`(^|[^\\w-])(git\\s+${sub})(?![\\w-])`, 'g');
    let m;
    while ((m = re.exec(t))) {
      const lineNo = lineOf(t, m.index);
      const lineText = (t.split('\n')[lineNo - 1] || '').trim();
      if (/crctl[.\w-]*\s+git/.test(lineText)) continue; // 已迁移形态
      findings.push({ rule: 'R2', level: 'CONTRADICTS', file: ctx.file, line: para.startLine + lineNo - 1, why: `裸 git 命令：${m[2]}` });
    }
  }
  // R3/R4/R5 字面黑名单（R5 需配合写动词：passCondition 的读取声明不算手写记账）
  for (const [rule, literals] of Object.entries(LITERAL_BLACKLIST)) {
    for (const lit of literals) {
      const idx = t.indexOf(lit);
      if (idx !== -1 && (rule !== 'R5' || WRITE_VERBS.test(t))) {
        const level = rule === 'R5' ? 'OUTDATED' : (rule === 'R3' ? 'STALE-REF' : 'CONTRADICTS');
        findings.push({ rule, level, file: ctx.file, line: para.startLine + lineOf(t, idx) - 1, why: `引用过时机制/口径：${lit}` });
      }
    }
  }
  // R6 手写 test-report frontmatter（行级邻近判定）
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (l.includes('test-report.md') && (/\b(status|commands):/.test(l) || /手写|手动编辑/.test(l))) {
      findings.push({ rule: 'R6', level: 'CONTRADICTS', file: ctx.file, line: para.startLine + li, why: 'test-report.md frontmatter 应由 crctl test 生成，prompt 不得手写 status:/commands:' });
    }
  }
  // R7（FR-24，CR-2026-022）：crctl 命令参数形态（命令跨度含旗标才算命令形态；纯机制描述豁免）
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (l.includes('crctl advance')) {
      const span = backtickSpan(l, 'crctl advance');
      const cmd = span !== null ? span : l;
      if (/--/.test(cmd)) {
        if (!/\s--to\s+\S+/.test(cmd) || !/\s--trigger\s+\S+/.test(cmd)) {
          findings.push({ rule: 'R7', level: 'CONTRADICTS', file: ctx.file, line: para.startLine + li, why: 'crctl advance 必须含 --to 与 --trigger（权威旗标，--expect 可省略）' });
        }
        if (/[，、）]/.test(cmd) || /`(trigger|expected_current_status|commit_mode)=/.test(cmd)) {
          findings.push({ rule: 'R7', level: 'CONTRADICTS', file: ctx.file, line: para.startLine + li, why: 'crctl advance 参数形态违例（全角分隔符/伪旗标反引号包裹）' });
        }
      }
    }
    if (l.includes('backlog-set')) {
      const m = l.match(/--field\s+(\S+)/);
      if (m && !m[1].includes('{') && !ctx.backlogSetFields.has(m[1])) {
        findings.push({ rule: 'R7', level: 'CONTRADICTS', file: ctx.file, line: para.startLine + li, why: `backlog-set --field 越白名单：${m[1]}（允许 prd-path|sdd-path）` });
      }
    }
    if (l.includes('git commit --template') && /\s-m\s/.test(l)) {
      if (!l.includes('--cr') && !/CR-\d{4}-\d{3}/.test(l)) {
        findings.push({ rule: 'R7', level: 'CONTRADICTS', file: ctx.file, line: para.startLine + li, why: 'git commit --template 的 -m subject 必须含 CR 编号或显式 --cr（反向解析兜底）' });
      }
    }
  }
  // R8（FR-24，CR-2026-022）：inbox-emit 接口（函数式违例 + --event 枚举直读）
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (/\binbox-emit\(/.test(l)) {
      findings.push({ rule: 'R8', level: 'CONTRADICTS', file: ctx.file, line: para.startLine + li, why: '函数式 inbox-emit(...) 已废弃，改用 crctl inbox-emit CLI 形态' });
    }
    const m = l.match(/--event\s+(\S+)/);
    if (m && !m[1].includes('{') && !ctx.inboxEvents.has(m[1])) {
      findings.push({ rule: 'R8', level: 'CONTRADICTS', file: ctx.file, line: para.startLine + li, why: `inbox-emit --event 不在声明枚举：${m[1]}` });
    }
  }
  // 豁免收窄（FR-25，CR-2026-022）：<!-- lint-prompts:ignore --> 只豁免其所在行 ± radius 行（radius=1 契约），不再整段生效
  const radius = 1;
  return findings.filter((f) => !isIgnored(lines, f.line - para.startLine, radius));
}

/** 行内反引号代码跨度提取（含关键词的跨度），无则 null。 */
function backtickSpan(line, keyword) {
  const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = line.match(new RegExp('`[^`]*' + esc + '[^`]*`'));
  return m ? m[0] : null;
}

/** 豁免收窄：注释只覆盖其所在行 ± radius 行（radius=1 为契约，测试向量固化）。 */
function isIgnored(lines, idx, radius = 1) {
  for (let k = Math.max(0, idx - radius); k <= Math.min(lines.length - 1, idx + radius); k++) {
    if (lines[k].includes('<!-- lint-prompts:ignore -->')) return true;
  }
  return false;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/* ────────────────────────── 主流程 ────────────────────────── */

function main() {
  const argv = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') flags.mode = argv[++i];
    else if (argv[i] === '--root') flags.root = argv[++i];
  }
  const mode = flags.mode || 'report';
  if (!['report', 'enforce'].includes(mode)) {
    process.stderr.write(JSON.stringify({ error: { code: 'BAD_ARGS', message: `--mode 必须是 report|enforce（当前 ${mode}）` } }, null, 2) + '\n');
    process.exit(1);
  }
  const root = path.resolve(flags.root || PACKAGE_ROOT);
  const ctx = { ...loadJudgements() };
  const findings = [];
  for (const p of walkFiles(root)) {
    const text = fs.readFileSync(p, 'utf8');
    ctx.file = path.relative(root, p).replaceAll('\\', '/');
    const paras = p.endsWith('.json') ? splitPipelineJson(text) : splitMarkdown(text);
    for (const para of paras) findings.push(...runRules(para, ctx));
  }
  // 按 file:line 排序
  findings.sort((a, b) => (a.file + String(a.line)).localeCompare(b.file + String(b.line)));
  const hasBlocking = findings.some((f) => f.level === 'CONTRADICTS' || f.level === 'STALE-REF');
  for (const f of findings) process.stdout.write(`${f.file}:${f.line} [${f.level}] ${f.rule}: ${f.why}\n`);
  if (!findings.length) process.stdout.write(`lint-prompts ${mode}: 0 findings（prompt 与 crctl 无漂移）\n`);
  if (mode === 'enforce' && hasBlocking) {
    process.stderr.write(JSON.stringify({ error: { code: 'LINT_DRIFT', message: `lint-prompts enforce 检出 ${findings.filter((f) => f.level === 'CONTRADICTS' || f.level === 'STALE-REF').length} 处 CONTRADICTS/STALE-REF，拒绝通过` } }, null, 2) + '\n');
    process.exit(1);
  }
}

main();

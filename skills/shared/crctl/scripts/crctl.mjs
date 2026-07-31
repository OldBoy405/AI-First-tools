#!/usr/bin/env node
/**
 * crctl — CR 状态机 gate CLI（漂移治理 v2 的组件 A）
 *
 * 设计原则（docs/漂移治理_v2.md §5.2）：
 * 1. 门禁规则不硬编码：状态转换从目标 workspace dir-graph.yaml#change-request-track.state_machine
 *    运行时解析；passCondition 从 pipeline-templates/*.pipeline.json 运行时解析；
 *    证据文件位置映射由同目录 gates.json 声明。
 * 2. 时间戳与执行者身份由本工具生成，拒绝调用方传入。
 * 3. 写权威文件前做 hash-CAS（读时记 sha256，写前复核），防并发覆盖。
 * 4. approve 仅接受交互式 TTY 会话，无任何旁路参数或环境变量。
 *
 * 无第三方依赖。Node >= 18。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..', '..'); // tools 包根
const GATES_PATH = path.resolve(__dirname, '..', 'gates.json');

/* ────────────────────────── 通用输出 / 错误 ────────────────────────── */

function fail(code, message, extra = {}) {
  const err = { error: { code, message, ...extra } };
  process.stderr.write(JSON.stringify(err, null, 2) + '\n');
  process.exit(1);
}

function ok(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function nowIso() {
  // 本地时区 ISO 8601（含偏移），由代码生成，不接受外部传入（治理⑩）
  const d = new Date();
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`
  );
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// 证据摘要专用：行尾规范化后再哈希。同一份证据在 LF 的 worktree 里审批、
// 合并后被 Windows autocrlf 检出为 CRLF，字节级哈希会产生 EVIDENCE_DRIFT
// 误报（CR-2026-001 回写期实测触发）。证据漂移关心的是内容篡改，不是
// 行尾差异。写入（approve）与复核（gate/status）必须走同一个函数。
function evidenceSha16(text) {
  return sha256(text.replaceAll('\r\n', '\n')).slice(0, 16);
}

/* ────────────────────────── YAML 子集解析器 ──────────────────────────
 * 支持：块映射、块序列、flow 映射 {k: v}、flow 序列 [a, b]、引号字符串、
 * 注释、多行块标量 | 与 >（保守处理为拼接文本）。
 * 不支持：锚点、别名、tag、多文档。对本包受控文件足够。
 */

function parseYaml(text) {
  const rawLines = text.split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const stripped = stripComment(rawLines[i]);
    if (stripped.trim() === '') continue;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trimEnd(), raw: rawLines[i], no: i + 1 });
  }
  const [value] = parseBlock(lines, 0, 0);
  return value;
}

function stripComment(line) {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function parseBlock(lines, idx, minIndent) {
  if (idx >= lines.length || lines[idx].indent < minIndent) return [null, idx];
  const indent = lines[idx].indent;
  const content = lines[idx].text.trimStart();
  if (content.startsWith('- ') || content === '-') return parseSeq(lines, idx, indent);
  return parseMap(lines, idx, indent);
}

function parseSeq(lines, idx, indent) {
  const arr = [];
  let i = idx;
  while (i < lines.length && lines[i].indent === indent) {
    const content = lines[i].text.trimStart();
    if (!(content.startsWith('- ') || content === '-')) break;
    const rest = content === '-' ? '' : content.slice(2).trim();
    if (rest === '') {
      const [v, ni] = parseBlock(lines, i + 1, indent + 1);
      arr.push(v); i = ni;
    } else if (rest.startsWith('{') || rest.startsWith('[')) {
      arr.push(parseInline(rest)); i += 1;
    } else if (/^[^\s:]+(\s*):(\s|$)/.test(rest) || /^["'][^"']*["']\s*:(\s|$)/.test(rest)) {
      // 序列项内联映射："- id: x" 后续行以更深缩进续写同一映射
      const virtualIndent = lines[i].indent + (lines[i].text.trimStart().length - rest.length);
      const fake = { indent: virtualIndent, text: ' '.repeat(virtualIndent) + rest, raw: lines[i].raw, no: lines[i].no };
      const sub = [fake];
      let j = i + 1;
      while (j < lines.length && lines[j].indent >= virtualIndent && !(lines[j].indent === indent && /^-(\s|$)/.test(lines[j].text.trimStart()))) {
        sub.push(lines[j]); j++;
      }
      const [v] = parseMap(sub, 0, virtualIndent);
      arr.push(v); i = j;
    } else {
      arr.push(parseScalar(rest)); i += 1;
    }
  }
  return [arr, i];
}

function parseMap(lines, idx, indent) {
  const obj = {};
  let i = idx;
  while (i < lines.length && lines[i].indent === indent) {
    const content = lines[i].text.trimStart();
    if (content.startsWith('- ')) break;
    const m = content.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^:\s][^:]*?)\s*:(.*)$/);
    if (!m) { i += 1; continue; }
    const key = unquote(m[1].trim());
    let rest = m[2].trim();
    if (rest === '' ) {
      const [v, ni] = parseBlock(lines, i + 1, indent + 1);
      obj[key] = v; i = ni;
    } else if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      const parts = [];
      let j = i + 1;
      while (j < lines.length && lines[j].indent > indent) { parts.push(lines[j].text.trim()); j++; }
      obj[key] = parts.join('\n'); i = j;
    } else {
      obj[key] = parseInline(rest); i += 1;
    }
  }
  return [obj, i];
}

function parseInline(s) {
  s = s.trim();
  if (s.startsWith('{')) return parseFlow(s).value;
  if (s.startsWith('[')) return parseFlow(s).value;
  return parseScalar(s);
}

function parseFlow(s) {
  let i = 0;
  function ws() { while (i < s.length && /\s/.test(s[i])) i++; }
  function value() {
    ws();
    if (s[i] === '{') {
      i++; const o = {};
      ws();
      if (s[i] === '}') { i++; return o; }
      for (;;) {
        ws();
        const k = flowScalar([':']); i++; // skip ':'
        o[unquote(k.trim())] = value();
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return o; }
        throw new Error(`flow map 解析失败 @${i}: ${s}`);
      }
    }
    if (s[i] === '[') {
      i++; const a = [];
      ws();
      if (s[i] === ']') { i++; return a; }
      for (;;) {
        a.push(value());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return a; }
        throw new Error(`flow seq 解析失败 @${i}: ${s}`);
      }
    }
    return parseScalar(flowScalar([',', '}', ']']));
  }
  function flowScalar(stops) {
    ws();
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]; let j = i + 1;
      while (j < s.length && s[j] !== q) { if (q === '"' && s[j] === '\\') j++; j++; }
      const out = s.slice(i, j + 1); i = j + 1; ws();
      return out;
    }
    let j = i;
    while (j < s.length && !stops.includes(s[j])) j++;
    const out = s.slice(i, j); i = j;
    return out;
  }
  const v = value();
  return { value: v, rest: s.slice(i) };
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    return s.startsWith('"') ? inner.replace(/\\(.)/g, '$1') : inner;
  }
  return s;
}

function parseScalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return unquote(s);
}

function getPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/* ────────────────────────── workspace 解析 ────────────────────────── */

function detectWorkspace(explicit) {
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!fs.existsSync(path.join(abs, 'change-requests'))) fail('WORKSPACE_NOT_FOUND', `--workspace 指向的目录缺少 change-requests/: ${abs}`);
    return abs;
  }
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'change-requests', '_backlog.yml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  fail('WORKSPACE_NOT_FOUND', '未找到目标 workspace（向上查找 change-requests/_backlog.yml 失败）。可用 --workspace 显式指定。');
}

function readFileChecked(p) {
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function loadStateMachine(ws) {
  // 权威：目标 workspace 的 dir-graph.yaml；回退：本 tools 包自带的 dir-graph.yaml
  for (const p of [path.join(ws, 'dir-graph.yaml'), path.join(ws, 'tools', 'dir-graph.yaml'), path.join(PACKAGE_ROOT, 'dir-graph.yaml')]) {
    const text = readFileChecked(p);
    if (!text) continue;
    const doc = parseYaml(text);
    const sm = getPath(doc, 'change-request-track.state_machine');
    if (sm && sm.transitions) return { sm, source: p };
  }
  fail('STATE_MACHINE_NOT_FOUND', '任何可达的 dir-graph.yaml 中都没有 change-request-track.state_machine');
}

function loadGates() {
  const text = readFileChecked(GATES_PATH);
  if (!text) fail('GATES_NOT_FOUND', `缺少 ${GATES_PATH}`);
  return JSON.parse(text);
}

function loadPipeline(ws, id) {
  for (const p of [
    path.join(ws, 'tools', 'pipeline-templates', `${id}.pipeline.json`),
    path.join(PACKAGE_ROOT, 'pipeline-templates', `${id}.pipeline.json`),
  ]) {
    const text = readFileChecked(p);
    if (text) return { doc: JSON.parse(text), source: p };
  }
  fail('PIPELINE_NOT_FOUND', `找不到 pipeline 模板 ${id}.pipeline.json`);
}

function crDir(ws, cr) { return path.join(ws, 'change-requests', cr); }
function backlogPath(ws) { return path.join(ws, 'change-requests', '_backlog.yml'); }

function loadBacklogEntry(ws, cr) {
  const p = backlogPath(ws);
  const text = readFileChecked(p);
  if (!text) fail('BACKLOG_NOT_FOUND', `缺少 ${p}`);
  const doc = parseYaml(text);
  const list = Array.isArray(doc) ? doc : doc['change-requests'] || doc.backlog || doc.items || doc.crs;
  if (!Array.isArray(list)) fail('BACKLOG_SHAPE', `_backlog.yml 顶层既不是序列也没有 change-requests/backlog/items 键`);
  const entry = list.find((e) => e && (e.id === cr || e['cr-id'] === cr));
  if (!entry) fail('CR_STATUS_NOT_FOUND', `_backlog.yml 中不存在 ${cr}`);
  return { entry, text, hash: sha256(text), path: p };
}

/* ────────────────────────── 身份 / 审计 ────────────────────────── */

function identity(ws) {
  const cfg = readFileChecked(path.join(ws, '.crctl', 'config.json'));
  if (cfg) {
    try { const j = JSON.parse(cfg); if (j.identity) return String(j.identity); } catch { /* fallthrough */ }
  }
  const r = spawnSync('git', ['config', '--get', 'user.name'], { cwd: ws, encoding: 'utf8', shell: false });
  const name = (r.stdout || '').trim();
  return name || 'unknown';
}

function auditLog(ws, record) {
  const dir = path.join(ws, '.crctl');
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  fs.appendFileSync(path.join(dir, 'audit.log'), JSON.stringify({ at: nowIso(), ...record }) + '\n');
}

/* ────────────────────────── outbox 事件（P1 同步协议，CR-2026-002 TASK-02） ──────────
 * crctl 只写本地文件，网络交给 daemon（零依赖/离线优先）。
 * advance 成功 → status 事件（approve 级联的 advance 附带证据摘要）；
 * git push 成功 → checkpoint 事件（携带 HEAD sha，用于补全 --embedded 的空 commit_sha）。
 * 事件写入失败不阻塞主操作，只记 audit——outbox 是投影通道，git 才是权威。
 */

function emitOutboxEvent(ws, ev) {
  try {
    const dir = path.join(ws, '.crctl', 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const gi = path.join(ws, '.crctl', '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
    const event = {
      v: 1,
      event_kind: ev.event_kind,
      cr_id: ev.cr_id,
      from_status: ev.from_status ?? '',
      to_status: ev.to_status ?? '',
      trigger: ev.trigger ?? '',
      commit_sha: ev.commit_sha ?? '',
      actor: ev.actor ?? '',
      evidence: ev.evidence ?? {},
      payload: ev.payload ?? {},
      occurred_at: nowIso(),
    };
    const ts = new Date().toISOString().replace(/[-:.]/g, '');
    const name = `${ts}-${event.cr_id}-${event.event_kind}-${(event.commit_sha || 'nosha').slice(0, 8)}.json`;
    const tmp = path.join(dir, `.tmp-${process.pid}-${name}`);
    fs.writeFileSync(tmp, JSON.stringify(event, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, path.join(dir, name)); // 原子可见：先写临时名再 rename，防半写
    return name;
  } catch (e) {
    try { auditLog(ws, { kind: 'outbox', result: 'EMIT_FAILED', why: String(e && e.message || e) }); } catch { /* 双重失败只能放弃 */ }
    return null;
  }
}

function gitHeadSha(ws, cwd) {
  const r = controlledGit(ws, 'rev-parse', ['HEAD'], cwd || ws, 'crctl-outbox');
  return r.ok ? (r.stdout || '').trim() : '';
}

/* ────────────────────────── 受控 git（组件 A 的 gitwrap） ──────────────────────────
 * 三元白名单：子命令 + 形态（正则）+ 调用者。
 * 单一事实源：skills/shared/controlled-shell/rules.json（CR-2026-002 TASK-01）。
 * 本文件不再内联规则表；rules.json 缺失/损坏时返回 SHELL_UNAVAILABLE，不静默放行。
 */

const RULES_PATH = process.env.CRCTL_RULES_PATH
  || path.resolve(__dirname, '..', '..', 'controlled-shell', 'rules.json');

let _shellRules; // undefined=未加载, null=加载失败, object=已加载
function loadShellRules() {
  if (_shellRules !== undefined) return _shellRules;
  try {
    const j = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
    const whitelist = {};
    for (const entry of j.git) {
      whitelist[entry.sub] = entry.shapes.map((s) =>
        typeof s === 'string' ? new RegExp(s) : new RegExp(s.re, s.flags || ''));
    }
    if (!Array.isArray(j.forbiddenFlags)) throw new Error('forbiddenFlags 缺失');
    _shellRules = { whitelist, forbiddenFlags: j.forbiddenFlags };
  } catch {
    _shellRules = null;
  }
  return _shellRules;
}

function controlledGit(ws, sub, args, cwd, caller) {
  const joined = args.join(' ');
  const record = { kind: 'git', caller: caller || null, sub, args: joined, cwd };
  const rules = loadShellRules();
  if (!rules) {
    auditLog(ws, { ...record, result: 'SHELL_UNAVAILABLE' });
    return { ok: false, code: 'SHELL_UNAVAILABLE', message: `controlled-shell 规则文件缺失或损坏，拒绝执行任何 git: ${RULES_PATH}` };
  }
  const patterns = rules.whitelist[sub];
  for (const a of args) {
    if (rules.forbiddenFlags.includes(a) || rules.forbiddenFlags.some((f) => a.startsWith(f + '='))) {
      auditLog(ws, { ...record, result: 'FORBIDDEN_FLAG' });
      return { ok: false, code: 'FORBIDDEN_SUBCOMMAND', message: `参数 ${a} 属于配置注入类，禁止透传` };
    }
  }
  if (!patterns) {
    auditLog(ws, { ...record, result: 'FORBIDDEN_SUBCOMMAND' });
    return { ok: false, code: 'FORBIDDEN_SUBCOMMAND', message: `git ${sub} 不在 controlled-shell 白名单中` };
  }
  if (!patterns.some((re) => re.test(joined))) {
    auditLog(ws, { ...record, result: 'FORBIDDEN_FORM' });
    return { ok: false, code: 'FORBIDDEN_SUBCOMMAND', message: `git ${sub} ${joined} 不匹配白名单允许的任何形态` };
  }
  const r = spawnSync('git', [sub, ...args], { cwd: cwd || ws, encoding: 'utf8', shell: false });
  const out = { ok: r.status === 0, exit: r.status, stdout: (r.stdout || '').slice(0, 20000), stderr: (r.stderr || '').slice(0, 20000) };
  auditLog(ws, { ...record, result: out.ok ? 'ok' : `exit=${r.status}` });
  return out;
}

/* ────────────────────────── 证据读取与 passCondition 求值 ────────────────────────── */

function readEvidenceDoc(ws, cr, rel) {
  const p = path.join(ws, rel.replaceAll('{cr}', cr));
  const text = readFileChecked(p);
  if (text == null) return { path: p, exists: false, data: null };
  if (p.endsWith('.md')) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    let data = m ? parseYaml(m[1]) : {};
    if (!m) {
      // 无 frontmatter 时退化扫描前 60 行的顶层 key: value
      data = {};
      for (const line of text.split(/\r?\n/).slice(0, 60)) {
        const km = line.match(/^([a-zA-Z_-]+):\s*(.+)$/);
        if (km) data[km[1]] = parseScalar(km[2]);
      }
    }
    return { path: p, exists: true, data };
  }
  return { path: p, exists: true, data: parseYaml(text) };
}

function evaluatePassCondition(ws, cr, stageCfg, gates) {
  // stageCfg: { passCondition: {pipeline, nodeRef}, evidence: {"$default": rel, "test-report": rel} }
  const results = [];
  const { pipeline, nodeRef } = stageCfg.passCondition;
  const { doc: pl, source } = loadPipeline(ws, pipeline);
  const node = (pl.nodes || []).find((n) => n.ref === nodeRef && n.reviewLoop);
  if (!node) return { pass: false, results: [{ ok: false, why: `pipeline ${pipeline} 中找不到含 reviewLoop 的节点 ref=${nodeRef}` }], source };
  const conds = getPath(node, 'reviewLoop.passCondition.allOf') || [];
  const docsCache = {};
  const getDoc = (key) => {
    if (!(key in docsCache)) docsCache[key] = readEvidenceDoc(ws, cr, stageCfg.evidence[key]);
    return docsCache[key];
  };
  for (const cond of conds) {
    const dot = cond.path;
    const firstSeg = dot.split('.')[0];
    let docKey = '$default', fieldPath = dot;
    if (firstSeg !== dot && stageCfg.evidence[firstSeg]) { docKey = firstSeg; fieldPath = dot.slice(firstSeg.length + 1); }
    const doc = getDoc(docKey);
    if (!doc.exists) { results.push({ ok: false, cond, why: `证据文件缺失: ${doc.path}` }); continue; }
    const val = getPath(doc.data, fieldPath);
    if ('equals' in cond) {
      const okv = String(val) === String(cond.equals);
      results.push({ ok: okv, cond, actual: val ?? null, file: doc.path, why: okv ? null : `期望 ${fieldPath}=${cond.equals}，实际 ${JSON.stringify(val ?? null)}` });
    } else if (cond.isEmpty === true) {
      const okv = val == null || (Array.isArray(val) && val.length === 0) || val === '';
      results.push({ ok: okv, cond, actual: val ?? null, file: doc.path, why: okv ? null : `期望 ${fieldPath} 为空，实际 ${JSON.stringify(val)}` });
    } else {
      results.push({ ok: false, cond, why: `不支持的条件形态: ${JSON.stringify(cond)}` });
    }
  }
  return { pass: results.length > 0 && results.every((r) => r.ok), results, source };
}

function runGateChecks(ws, cr, targetStatus, gates, opts = {}) {
  const checks = gates.statusGates[targetStatus];
  const out = { target: targetStatus, checks: [], pass: true };
  if (!checks) { out.note = `gates.json 未对状态 ${targetStatus} 声明门禁（默认放行，仅校验状态机转换）`; return out; }
  for (const check of checks) {
    if (check.type === 'fileExists') {
      const p = path.join(ws, check.path.replaceAll('{cr}', cr).replaceAll('{spec}', opts.specId || '{spec}'));
      if (check.path.includes('{spec}') && !opts.specId) {
        out.checks.push({ type: check.type, path: check.path, ok: false, why: '需要 --spec-id 参数才能校验 specs 落点' });
      } else {
        const exists = fs.existsSync(p);
        out.checks.push({ type: check.type, path: p, ok: exists, why: exists ? null : '文件不存在' });
      }
    } else if (check.type === 'globNonEmpty') {
      const dir = path.join(ws, check.dir.replaceAll('{cr}', cr));
      const okv = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => new RegExp(check.pattern).test(f));
      out.checks.push({ type: check.type, dir, pattern: check.pattern, ok: okv, why: okv ? null : '目录缺失或无匹配文件' });
    } else if (check.type === 'passCondition') {
      const stageCfg = gates.approvalStages[check.stage];
      const r = evaluatePassCondition(ws, cr, stageCfg, gates);
      out.checks.push({ type: check.type, stage: check.stage, ok: r.pass, detail: r.results, pipelineSource: r.source });
    } else if (check.type === 'approval') {
      const doc = readEvidenceDoc(ws, cr, 'change-requests/{cr}/approval.yml');
      const section = doc.exists ? doc.data?.[check.section] : null;
      const okv = !!(section && section.approver && section['approved-at'] && section.via === 'crctl-approve');
      let why = okv ? null : `approval.yml#${check.section} 缺失或非 crctl approve 写入（via 必须为 crctl-approve）`;
      let drift = null;
      if (okv && section['evidence-sha256-16']) {
        const stageCfg = Object.values(gates.approvalStages || {}).find((s) => s.approvalSection === check.section);
        const evDoc = stageCfg?.evidence?.$default ? readEvidenceDoc(ws, cr, stageCfg.evidence.$default) : { exists: false };
        const currentHash = evDoc.exists ? evidenceSha16(fs.readFileSync(evDoc.path, 'utf8')) : null;
        if (currentHash && currentHash !== section['evidence-sha256-16']) {
          drift = 'EVIDENCE_DRIFT';
          why = `EVIDENCE_DRIFT：approval.yml#${check.section} 记录的证据哈希 ${section['evidence-sha256-16']} 与 ${evDoc.path} 当前哈希 ${currentHash} 不一致，证据在审批后被改动`;
        }
      }
      out.checks.push({ type: check.type, section: check.section, ok: okv && !drift, why, code: drift || undefined });
    } else if (check.type === 'attemptsWithinLimit') {
      const r = readAttempts(ws, cr, check.loop, gates);
      const okv = !r.exhausted;
      out.checks.push({ type: check.type, loop: check.loop, ok: okv, current: r.current, max: r.max, why: okv ? null : 'LOOP_EXHAUSTED：自修复轮次已用尽，禁止继续推进，须人工处理' });
    } else {
      out.checks.push({ type: check.type, ok: false, why: '未知门禁类型' });
    }
  }
  out.pass = out.checks.every((c) => c.ok);
  return out;
}

/* ────────────────────────── 状态机 ────────────────────────── */

function legalTransitions(sm, current) {
  const wc = sm.wildcards || {};
  return (sm.transitions || []).filter((t) => {
    if (t.from === current) return true;
    if (wc[t.from] && wc[t.from].includes(current)) return true;
    return false;
  });
}

function findTransition(sm, current, to, trigger) {
  return legalTransitions(sm, current).find((t) => t.to === to && t.trigger === trigger) || null;
}

/* ────────────────────────── 权威文件写入（行级定点编辑 + CAS） ────────────────────────── */

function casWrite(p, expectedHash, newText) {
  const cur = readFileChecked(p);
  if (cur == null) fail('CAS_FILE_MISSING', `写入前文件消失: ${p}`);
  if (sha256(cur) !== expectedHash) fail('CAS_CONFLICT', `${p} 在读取后被其他进程修改，本次写入中止。请重新执行。`);
  fs.writeFileSync(p, newText, 'utf8');
}

function updateBacklogStatus(ws, cr, newStatus, snapshot) {
  const p = backlogPath(ws);
  const lines = snapshot.text.split(/\r?\n/);
  const eol = snapshot.text.includes('\r\n') ? '\r\n' : '\n';
  let entryStart = -1, entryIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s+id:\s*["']?([^"'\s]+)["']?\s*$/);
    if (m && m[2] === cr) { entryStart = i; entryIndent = m[1].length; break; }
  }
  if (entryStart < 0) fail('CR_STATUS_NOT_FOUND', `_backlog.yml 定位不到条目 - id: ${cr}`);
  let entryEnd = lines.length;
  for (let i = entryStart + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s+id:\s*/);
    if (m && m[1].length <= entryIndent) { entryEnd = i; break; }
  }
  let statusLine = -1, updatedLine = -1, fieldIndent = null;
  for (let i = entryStart; i < entryEnd; i++) {
    const sm2 = lines[i].match(/^(\s*)status:\s*/);
    if (sm2 && statusLine < 0 && (i === entryStart || lines[i].search(/\S/) > entryIndent)) { statusLine = i; fieldIndent = sm2[1]; }
    if (/^\s*updated-at:\s*/.test(lines[i]) && updatedLine < 0) updatedLine = i;
  }
  if (statusLine < 0) fail('BACKLOG_SHAPE', `条目 ${cr} 内找不到 status 字段`);
  lines[statusLine] = `${fieldIndent}status: ${newStatus}`;
  const stamp = `updated-at: "${nowIso()}"`;
  if (updatedLine >= 0) {
    const ind = lines[updatedLine].match(/^(\s*)/)[1];
    lines[updatedLine] = `${ind}${stamp}`;
  } else {
    lines.splice(statusLine + 1, 0, `${fieldIndent}${stamp}`);
  }
  casWrite(p, snapshot.hash, lines.join(eol));
}

function updateCrMdStatus(ws, cr, newStatus) {
  const p = path.join(crDir(ws, cr), 'cr.md');
  const text = readFileChecked(p);
  if (text == null) return { updated: false, why: `cr.md 不存在: ${p}` };
  const hash = sha256(text);
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { updated: false, why: 'cr.md 无 frontmatter' };
  let fm = m[1];
  if (/^status:\s*.*$/m.test(fm)) fm = fm.replace(/^status:\s*.*$/m, `status: ${newStatus}`);
  else fm = fm + `\nstatus: ${newStatus}`;
  if (/^updated-at:\s*.*$/m.test(fm)) fm = fm.replace(/^updated-at:\s*.*$/m, `updated-at: "${nowIso()}"`);
  casWrite(p, hash, text.replace(m[0], `---\n${fm}\n---`));
  return { updated: true, path: p };
}

/* ────────────────────────── attempts（review-loop 轮次记账） ────────────────────────── */

function attemptsFilePath(ws, cr) { return path.join(crDir(ws, cr), 'review-loop.yml'); }

function readAttempts(ws, cr, loopRef, gates) {
  const loopCfg = gates.reviewLoops[loopRef];
  if (!loopCfg) fail('UNKNOWN_LOOP', `gates.json 未声明 reviewLoop ${loopRef}`);
  const { doc: pl } = loadPipeline(ws, loopCfg.pipeline);
  const node = (pl.nodes || []).find((n) => n.ref === loopRef && n.reviewLoop);
  const max = node ? node.reviewLoop.maxAttempts || 3 : 3;
  const text = readFileChecked(attemptsFilePath(ws, cr));
  const data = text ? parseYaml(text) : {};
  const loop = (data && data.loops && data.loops[loopRef]) || { 'current-attempt': 0, attempts: [] };
  const current = loop['current-attempt'] || 0;
  return { current, max, attempts: loop.attempts || [], exhausted: current >= max, data: data || {} };
}

function bumpAttempt(ws, cr, loopRef, gates) {
  const state = readAttempts(ws, cr, loopRef, gates);
  if (state.exhausted) fail('LOOP_EXHAUSTED', `${loopRef} 已达 maxAttempts=${state.max}，不得继续自修复；请人工处理剩余 blocker`, { current: state.current });
  const next = state.current + 1;
  const p = attemptsFilePath(ws, cr);
  const all = state.data.loops ? state.data : { loops: {} };
  all.loops[loopRef] = {
    'current-attempt': next,
    attempts: [...state.attempts, { attempt: next, at: nowIso(), by: identity(ws) }],
  };
  // review-loop.yml 由 crctl 全量生成（crctl 独占该文件，无 CAS 冲突面）
  const lines = ['# 由 crctl attempt 维护，请勿手工编辑', 'loops:'];
  for (const [k, v] of Object.entries(all.loops)) {
    lines.push(`  ${k}:`);
    lines.push(`    current-attempt: ${v['current-attempt']}`);
    lines.push('    attempts:');
    for (const a of v.attempts) lines.push(`      - { attempt: ${a.attempt}, at: "${a.at}", by: "${a.by}" }`);
  }
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return { loop: loopRef, current: next, max: state.max, file: p };
}

/* ────────────────────────── 子命令实现 ────────────────────────── */

function cmdStatus(ws, cr, gates, flags) {
  const { sm, source } = loadStateMachine(ws);
  const snap = loadBacklogEntry(ws, cr);
  const current = snap.entry.status;
  const nexts = legalTransitions(sm, current).map((t) => ({ to: t.to, trigger: t.trigger }));
  const loops = {};
  for (const loopRef of Object.keys(gates.reviewLoops)) {
    try { const a = readAttempts(ws, cr, loopRef, gates); if (a.current > 0) loops[loopRef] = { current: a.current, max: a.max }; } catch { /* ignore */ }
  }
  const missing = {};
  for (const n of nexts) {
    if (gates.statusGates[n.to]) {
      const g = runGateChecks(ws, cr, n.to, gates, { specId: flags['spec-id'] });
      if (!g.pass) missing[n.to] = g.checks.filter((c) => !c.ok).map((c) => c.why || c.path || c.stage || c.section);
    }
  }
  ok({
    cr, status: current,
    source: { backlog: snap.path, backlogSha256: snap.hash.slice(0, 12), stateMachine: source },
    owners: snap.entry.owners || null,
    legalNext: nexts,
    reviewLoops: loops,
    gateBlockers: missing,
  });
}

function cmdGate(ws, cr, gates, flags) {
  if (!flags.for) fail('BAD_ARGS', 'gate 需要 --for <target-status>');
  const result = runGateChecks(ws, cr, flags.for, gates, flags);
  ok(result);
  if (!result.pass) process.exit(1);
}

function cmdAdvance(ws, cr, gates, flags) {
  if (!flags.to || !flags.trigger) fail('BAD_ARGS', 'advance 需要 --to <status> --trigger <trigger>');
  const { sm } = loadStateMachine(ws);
  const snap = loadBacklogEntry(ws, cr);
  const current = snap.entry.status;
  if (flags.expect && flags.expect !== current) {
    fail('CR_STATUS_CURRENT_MISMATCH', `期望当前状态 ${flags.expect}，实际 ${current}`);
  }
  const t = findTransition(sm, current, flags.to, flags.trigger);
  if (!t) {
    fail('CR_STATUS_TRANSITION_NOT_ALLOWED', `状态机中不存在 (${current} → ${flags.to}) @ trigger=${flags.trigger} 的合法转换`, {
      legalNext: legalTransitions(sm, current).map((x) => ({ to: x.to, trigger: x.trigger })),
    });
  }
  const gate = runGateChecks(ws, cr, flags.to, gates, flags);
  if (!gate.pass) {
    fail('GATE_BLOCKED', `目标状态 ${flags.to} 的门禁未通过，拒绝写入`, { gate });
  }
  updateBacklogStatus(ws, cr, flags.to, snap);
  const crmd = updateCrMdStatus(ws, cr, flags.to);
  auditLog(ws, { kind: 'advance', cr, from: current, to: flags.to, trigger: flags.trigger, by: identity(ws) });
  const result = { advanced: true, cr, from: current, to: flags.to, trigger: flags.trigger, files: [backlogPath(ws), crmd.path].filter(Boolean), crMd: crmd };
  if (flags.embedded || flags['no-commit']) {
    result.commit = 'embedded：由调用方在同一事务中提交上述文件';
  } else {
    const msg = `[cr] status ${cr} ${current} -> ${flags.to}`;
    const addR = controlledGit(ws, 'add', ['change-requests'], ws, 'crctl-advance');
    const commitR = addR.ok ? controlledGit(ws, 'commit', ['-m', msg], ws, 'crctl-advance') : addR;
    result.commit = commitR.ok ? { message: msg } : { failed: true, detail: commitR, note: '状态文件已写入但 commit 失败，请修复后手工经 crctl git 提交' };
  }
  // outbox：状态事件。--embedded/--no-commit 时 commit_sha 留空，由 push 的 checkpoint 事件补全（§A.5）
  const committed = result.commit && result.commit.message;
  result.outbox = emitOutboxEvent(ws, {
    event_kind: 'status', cr_id: cr, from_status: current, to_status: flags.to,
    trigger: flags.trigger, commit_sha: committed ? gitHeadSha(ws) : '',
    actor: identity(ws), evidence: flags.outboxEvidence || {},
  });
  ok(result);
  if (result.commit && result.commit.failed) process.exit(1);
}

function cmdApprove(ws, cr, gates, flags) {
  const stage = flags.stage;
  const stageCfg = gates.approvalStages[stage];
  if (!stageCfg) fail('BAD_ARGS', `--stage 必须是 ${Object.keys(gates.approvalStages).join(' | ')}`);
  // 人类在环的硬检查：非交互式会话一律拒绝，无任何旁路（治理⑤）
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('APPROVAL_REQUIRES_HUMAN', 'crctl approve 仅接受交互式终端会话。请由审批人在终端直接运行本命令；模型/管道/脚本调用一律拒绝。');
  }
  const snap = loadBacklogEntry(ws, cr);
  const current = snap.entry.status;
  if (stageCfg.expect && !stageCfg.expect.includes(current)) {
    fail('CR_STATUS_CURRENT_MISMATCH', `审批阶段 ${stage} 要求当前状态 ∈ [${stageCfg.expect.join(', ')}]，实际 ${current}`);
  }
  // 审批前必须先给人看证据摘要
  const summaryLines = [`\n=== crctl approve · ${cr} · ${stage} ===`, `当前状态: ${current} → 通过后: ${stageCfg.to}`];
  let evidenceHash = null;
  if (stageCfg.passCondition) {
    const r = evaluatePassCondition(ws, cr, stageCfg, gates);
    for (const c of r.results) {
      summaryLines.push(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.cond ? c.cond.path : ''} ${c.why || (c.actual !== undefined ? `= ${JSON.stringify(c.actual)}` : '')}`);
    }
    if (!r.pass) {
      process.stderr.write(summaryLines.join('\n') + '\n');
      fail('GATE_BLOCKED', '自动评审证据未达标，禁止进入人工审批（blocker 未清空不得 human_approval）');
    }
    const defaultDoc = readEvidenceDoc(ws, cr, stageCfg.evidence.$default);
    evidenceHash = defaultDoc.exists ? evidenceSha16(fs.readFileSync(defaultDoc.path, 'utf8')) : null;
  }
  if (stageCfg.requireFiles) {
    for (const rel of stageCfg.requireFiles) {
      const p = path.join(ws, rel.replaceAll('{cr}', cr));
      if (!fs.existsSync(p)) fail('GATE_BLOCKED', `审批前置产物缺失: ${p}`);
      summaryLines.push(`  [PASS] 存在 ${rel.replaceAll('{cr}', cr)}`);
    }
  }
  process.stdout.write(summaryLines.join('\n') + '\n');
  const approver = flags.approver || identity(ws);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`以 approver=${approver} 批准该阶段？只有输入 yes 才会写入 approval.yml [yes/N] `, (answer) => {
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      auditLog(ws, { kind: 'approve', cr, stage, approver, result: 'declined' });
      fail('APPROVAL_DECLINED', '审批人未确认，未写入任何文件');
    }
    writeApprovalSection(ws, cr, stage, stageCfg, approver, evidenceHash);
    auditLog(ws, { kind: 'approve', cr, stage, approver, result: 'approved' });
    // 证据摘要随级联 advance 的 status 事件进 outbox（一个 approve 只发一条事件，避免与去重键冲突）
    const outboxEvidence = {};
    if (stageCfg.evidence) {
      for (const rel of Object.values(stageCfg.evidence)) {
        const p = path.join(ws, rel.replaceAll('{cr}', cr));
        const text = readFileChecked(p);
        if (text != null) outboxEvidence[rel.replaceAll('{cr}', cr)] = 'sha256:' + sha256(text.replaceAll('\r\n', '\n'));
      }
    }
    // 级联推进状态（同一 gate 再校验一遍，包含 approval 检查）
    cmdAdvance(ws, cr, gates, { to: stageCfg.to, trigger: stageCfg.trigger, expect: current, specId: flags['spec-id'], outboxEvidence });
  });
}

function writeApprovalSection(ws, cr, stage, stageCfg, approver, evidenceHash) {
  const p = path.join(crDir(ws, cr), 'approval.yml');
  const section = stageCfg.approvalSection;
  const existing = readFileChecked(p);
  const block = [
    `${section}:`,
    `  approver: "${approver}"`,
    `  approved-at: "${nowIso()}"`,
    `  via: crctl-approve`,
    evidenceHash ? `  evidence-sha256-16: "${evidenceHash}"` : null,
    `  target-status: ${stageCfg.to}`,
  ].filter(Boolean).join('\n');
  if (existing == null) {
    fs.writeFileSync(p, `# approval.yml — 人工审批记录（各段仅接受 crctl approve 写入）\n${block}\n`, 'utf8');
    return;
  }
  const hash = sha256(existing);
  const re = new RegExp(`^${section}:\\n(?:[ \\t]+.*\\n?)*`, 'm');
  const next = re.test(existing)
    ? existing.replace(re, block + '\n')
    : existing.replace(/\s*$/, '\n') + block + '\n';
  casWrite(p, hash, next);
}

function cmdValidate(ws, target, gates) {
  const p = path.isAbsolute(target) ? target : path.join(ws, target);
  const text = readFileChecked(p);
  if (text == null) fail('FILE_NOT_FOUND', `文件不存在: ${p}`);
  const base = path.basename(p);
  const errors = [];
  const pushIf = (cond, msg) => { if (cond) errors.push(msg); };

  const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/;
  const validateOwners = (owners, where) => {
    if (!owners || typeof owners !== 'object') { errors.push(`${where}: 缺少 owners 三角色模型`); return; }
    for (const role of ['requirement', 'development', 'test']) {
      const r = owners[role];
      if (!r || typeof r !== 'object') { errors.push(`${where}: owners.${role} 缺失`); continue; }
      pushIf(!r.id, `${where}: owners.${role}.id 缺失`);
      pushIf(!r['assigned-at'], `${where}: owners.${role}.assigned-at 缺失`);
      pushIf(r['assigned-at'] && !isoRe.test(String(r['assigned-at'])), `${where}: owners.${role}.assigned-at 不是带偏移的 ISO 8601: ${r['assigned-at']}`);
    }
  };

  if (base === 'cr.md') {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) errors.push('cr.md: 缺少 YAML frontmatter');
    else {
      const fm = parseYaml(m[1]);
      pushIf(!fm.id, 'cr.md: frontmatter 缺少 id');
      pushIf(!fm.status, 'cr.md: frontmatter 缺少 status');
      const { sm } = loadStateMachine(ws);
      const allStatuses = new Set([...(sm.transitions || []).flatMap((t) => [t.from, t.to]), ...(sm.terminal || [])]);
      pushIf(fm.status && !allStatuses.has(fm.status), `cr.md: status=${fm.status} 不在状态机枚举内`);
      validateOwners(fm.owners, 'cr.md');
    }
  } else if (base === '_backlog.yml') {
    const doc = parseYaml(text);
    const list = Array.isArray(doc) ? doc : doc['change-requests'] || doc.backlog || doc.items || [];
    const { sm } = loadStateMachine(ws);
    const allStatuses = new Set([...(sm.transitions || []).flatMap((t) => [t.from, t.to]), ...(sm.terminal || [])]);
    for (const e of list) {
      const where = `_backlog.yml#${e?.id || '?'}`;
      pushIf(!e.id, `${where}: 缺少 id`);
      pushIf(!e.status, `${where}: 缺少 status`);
      pushIf(e.status && !allStatuses.has(e.status), `${where}: status=${e.status} 不在状态机枚举内`);
      validateOwners(e.owners, where);
    }
  } else if (/review-annotations[\\/].+\.yml$/.test(p) || ['requirement.yml', 'sdd.yml', 'code.yml'].includes(base)) {
    const doc = parseYaml(text) || {};
    pushIf(!('verdict' in doc), `${base}: 缺少 verdict 字段`);
    pushIf('verdict' in doc && !['pass', 'block'].includes(doc.verdict), `${base}: verdict=${doc.verdict} 不在枚举 [pass, block]`);
    pushIf(!('blockers' in doc), `${base}: 缺少 blockers 字段`);
    pushIf('blockers' in doc && !Array.isArray(doc.blockers), `${base}: blockers 必须是列表`);
  } else if (base === 'test-report.md') {
    const doc = readEvidenceDoc(ws, '.', path.relative(ws, p)).data || {};
    pushIf(!doc.status, 'test-report.md: 缺少 status 字段（frontmatter 或文件头 status: 行）');
    pushIf(doc.status && !['pass', 'block', 'fail'].includes(String(doc.status)), `test-report.md: status=${doc.status} 不在枚举 [pass, block, fail]`);
    pushIf(!doc.tester, 'test-report.md: 缺少 tester 字段');
  } else if (base === 'approval.yml') {
    const doc = parseYaml(text) || {};
    for (const [k, v] of Object.entries(doc)) {
      if (typeof v !== 'object' || v == null) continue;
      pushIf(!v.approver, `approval.yml#${k}: 缺少 approver`);
      pushIf(!v['approved-at'], `approval.yml#${k}: 缺少 approved-at`);
      pushIf(v.via !== 'crctl-approve', `approval.yml#${k}: via 必须为 crctl-approve（当前 ${v.via || '缺失'}），否则不被门禁承认`);
    }
  } else if (base === 'traceability.yml') {
    const doc = parseYaml(text) || {};
    pushIf(typeof doc !== 'object', 'traceability.yml: 顶层必须是映射');
  } else {
    fail('UNKNOWN_ARTIFACT', `validate 暂不支持该文件类型: ${base}`);
  }

  if (errors.length) {
    process.stderr.write(JSON.stringify({ file: p, valid: false, errors }, null, 2) + '\n');
    process.exit(1);
  }
  ok({ file: p, valid: true });
}

function cmdAttempt(ws, cr, gates, flags) {
  if (!flags.loop) fail('BAD_ARGS', 'attempt 需要 --loop <review ref>（如 review-code / write-test-report）');
  const r = bumpAttempt(ws, cr, flags.loop, gates);
  auditLog(ws, { kind: 'attempt', cr, loop: flags.loop, current: r.current });
  ok(r);
}

function cmdTest(ws, cr, gates, flags) {
  const cmds = flags.cmdList || [];
  if (cmds.length === 0) fail('BAD_ARGS', 'test 需要至少一个 --cmd "<command>"');
  const cwd = flags.cwd ? path.resolve(flags.cwd) : ws;
  const evidenceDir = path.join(crDir(ws, cr), 'test-evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const runs = [];
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    const r = spawnSync(c, { cwd, encoding: 'utf8', shell: true, timeout: (flags.timeout ? Number(flags.timeout) : 600) * 1000 });
    const logPath = path.join(evidenceDir, `cmd-${String(i + 1).padStart(2, '0')}.log`);
    fs.writeFileSync(logPath, `$ ${c}\n(exit=${r.status})\n--- stdout ---\n${r.stdout || ''}\n--- stderr ---\n${r.stderr || ''}`, 'utf8');
    runs.push({ command: c, exit: r.status, log: path.relative(ws, logPath) });
    auditLog(ws, { kind: 'test', cr, command: c, exit: r.status });
  }
  const allPass = runs.every((r) => r.exit === 0);
  const reportPath = path.join(crDir(ws, cr), 'test-report.md');
  const tester = identity(ws);
  const lines = [
    '---',
    `cr: ${cr}`,
    `status: ${allPass ? 'pass' : 'block'}`,
    `tester: "${tester}"`,
    `generated-by: crctl-test`,
    `generated-at: "${nowIso()}"`,
    'commands:',
    ...runs.map((r) => `  - { command: "${r.command.replaceAll('"', '\\"')}", exit: ${r.exit}, log: "${r.log.replaceAll('\\', '/')}" }`),
    '---',
    '',
    `# 测试报告 · ${cr}`,
    '',
    `> status 与 commands 段由 crctl test 依据真实退出码生成，模型不得改写。`,
    `> 原始输出见 ${path.relative(ws, evidenceDir).replaceAll('\\', '/')}/。`,
    '',
    '## 命令与结果',
    '',
    '| # | 命令 | 退出码 | 日志 |',
    '|---|------|--------|------|',
    ...runs.map((r, i) => `| ${i + 1} | \`${r.command}\` | ${r.exit} | ${r.log.replaceAll('\\', '/')} |`),
    '',
    '## 分析（由测试负责人 / 模型补充）',
    '',
    '<!-- crctl:analysis-below 此标记以下允许人工/模型补充 TASK 覆盖、未覆盖风险等分析内容 -->',
    '',
  ];
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  ok({ report: reportPath, status: allPass ? 'pass' : 'block', tester, runs });
  if (!allPass) process.exit(1);
}

function cmdNext(ws, cr, gates, flags) {
  const snap = loadBacklogEntry(ws, cr);
  const status = snap.entry.status;
  const ev = (rel) => readEvidenceDoc(ws, cr, rel);
  const passAndClean = (doc) => doc.exists && doc.data && doc.data.verdict === 'pass' && Array.isArray(doc.data.blockers) && doc.data.blockers.length === 0;
  const suggest = (node, why, human = false) => ok({ cr, status, next: node, humanApproval: human, why });

  switch (status) {
    case 'drafting': {
      const prd = fs.existsSync(path.join(crDir(ws, cr), 'prd.md'));
      return suggest(prd ? 'review-requirement' : 'write-requirement-prd', prd ? 'prd.md 已存在，进入需求评审' : 'prd.md 缺失');
    }
    case 'requirement-reviewing': {
      const a = ev('change-requests/{cr}/review-annotations/requirement.yml');
      if (passAndClean(a)) return suggest('crctl approve --stage requirement', '需求评审 pass 且无 blocker，等待人工审批', true);
      return suggest('write-requirement-prd', a.exists ? `评审未通过（verdict=${a.data?.verdict}，blockers=${(a.data?.blockers || []).length}），带 review_feedback 回修` : '缺少需求评审记录，先跑 review-requirement');
    }
    case 'requirement-approved': return suggest('write-tech-design', '需求已审批，进入技术设计');
    case 'tech-designing': {
      const sdd = fs.existsSync(path.join(crDir(ws, cr), 'sdd.md'));
      return suggest(sdd ? 'review-tech-design' : 'write-tech-design', sdd ? 'sdd.md 已存在，进入技术评审' : 'sdd.md 缺失');
    }
    case 'tech-design-review-pending': {
      const a = ev('change-requests/{cr}/review-annotations/sdd.yml');
      if (passAndClean(a)) return suggest('crctl approve --stage tech-design', '技术评审 pass 且无 blocker，等待人工审批', true);
      return suggest('write-tech-design', a.exists ? `评审未通过（verdict=${a.data?.verdict}），按 blocker 回修 SDD` : '缺少 sdd.yml 评审记录，先跑 review-tech-design');
    }
    case 'tech-design-reviewed': return suggest('write-dev-plan', '技术设计已审批，编写开发计划');
    case 'task-breakdown': {
      const planOk = fs.existsSync(path.join(crDir(ws, cr), 'plan.md'));
      const tasksOk = fs.existsSync(path.join(crDir(ws, cr), 'tasks'));
      if (planOk && tasksOk) return suggest('crctl approve --stage dev-start', 'plan 与 tasks 就绪，等待开发启动人工确认', true);
      return suggest(planOk ? 'write-dev-tasks' : 'write-dev-plan', '开发计划或任务拆分缺失');
    }
    case 'developing': {
      const tr = ev('change-requests/{cr}/test-report.md');
      if (!tr.exists) return suggest('implement-code → write-test-report', '尚无测试报告');
      if (String(tr.data?.status) !== 'pass') return suggest('implement-code', `test-report.status=${tr.data?.status}，按 replayNodes 回修`);
      const code = ev('change-requests/{cr}/review-annotations/code.yml');
      if (!code.exists) return suggest('push-progress → review-code', '测试证据 pass，推送 checkpoint 后进入代码评审');
      return suggest('review-code', '存在旧评审记录，重跑代码评审刷新证据');
    }
    case 'code-reviewing': {
      const code = ev('change-requests/{cr}/review-annotations/code.yml');
      const tr = ev('change-requests/{cr}/test-report.md');
      if (passAndClean(code) && String(tr.data?.status) === 'pass') {
        return suggest('crctl approve --stage code', '代码评审 pass、无 blocker、测试 pass，等待人工审批', true);
      }
      return suggest('implement-code', 'blocker 未清空或测试未 pass，禁止进入 human_approval，按 replayNodes 回修');
    }
    case 'code-approved': return suggest('merge-feature-branch', '代码已审批，进入回写合并');
    case 'merging': return suggest('writeback-prd-sdd', '合并完成后回写 baseline');
    case 'writing-back': {
      const trace = fs.existsSync(path.join(crDir(ws, cr), 'traceability.yml'));
      return suggest(trace ? 'cr-archive' : 'writeback-tasks → writeback-traceability', trace ? '追溯链已生成，可归档' : '先完成任务与追溯链回写');
    }
    default:
      return suggest(null, `状态 ${status} 为终态或未覆盖，无自动建议`);
  }
}

function cmdGit(ws, argv, flags) {
  const sub = argv[0];
  if (!sub) fail('BAD_ARGS', 'git 需要子命令，如 crctl git status --short --cwd <path>');
  const args = argv.slice(1);
  const r = controlledGit(ws, sub, args, flags.cwd ? path.resolve(flags.cwd) : ws, flags.caller);
  if (r.code === 'FORBIDDEN_SUBCOMMAND') fail('FORBIDDEN_SUBCOMMAND', r.message, { attempted: `git ${sub} ${args.join(' ')}` });
  if (r.code === 'SHELL_UNAVAILABLE') fail('SHELL_UNAVAILABLE', r.message, { attempted: `git ${sub} ${args.join(' ')}` });
  let outbox = null;
  if (r.ok && sub === 'push' && !args.includes('--delete')) {
    // checkpoint 事件：携带被推送仓的 HEAD sha，供 worker 补全 --embedded 状态事件的空 commit_sha（§A.5）。
    // CR 上下文从 HEAD 提交信息或分支参数提取；提不到（非 CR 相关推送）则不发。
    const cwd = flags.cwd ? path.resolve(flags.cwd) : ws;
    const sha = gitHeadSha(ws, cwd);
    const headMsgR = controlledGit(ws, 'log', ['--oneline', '-1'], cwd, 'crctl-outbox');
    const headMsg = headMsgR.ok ? (headMsgR.stdout || '').trim() : '';
    const crMatch = (headMsg.match(/CR-\d{4}-\d{3}/) || args.join(' ').match(/CR-\d{4}-\d{3}/));
    if (crMatch) {
      outbox = emitOutboxEvent(ws, {
        event_kind: 'checkpoint', cr_id: crMatch[0], commit_sha: sha,
        actor: identity(ws), payload: { pushed: args.join(' '), cwd, headMessage: headMsg },
      });
    }
  }
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  ok(outbox ? { ok: r.ok, exit: r.exit, outbox } : { ok: r.ok, exit: r.exit });
  if (!r.ok) process.exit(r.exit || 1);
}

/* ────────────────────────── CLI 入口 ────────────────────────── */

const HELP = `crctl — CR 状态机 gate CLI（漂移治理 v2 组件 A）

用法:
  crctl status  <cr_id>                          输出权威指针：status / 合法下一步 / 门禁缺口
  crctl gate    <cr_id> --for <status>           只校验不写；非零退出表示 block
  crctl advance <cr_id> --to <s> --trigger <t>   校验转换+门禁后写入 _backlog.yml 与 cr.md 并 commit
                        [--expect <cur>] [--embedded] [--spec-id <id>]
  crctl approve <cr_id> --stage <requirement|tech-design|dev-start|code>
                        [--approver <id>] [--spec-id <id>]   仅限交互式终端（人类在环）
  crctl validate <file>                          受控产物 schema 校验（validate-doc 代码化）
  crctl attempt <cr_id> --loop <ref>             review-loop 轮次唯一记账点；超限返回 LOOP_EXHAUSTED
  crctl test    <cr_id> --cmd "<c>" [--cmd ...]  代执行验证命令，生成 test-report.md 骨架
                        [--cwd <p>] [--timeout <sec>]
  crctl next    <cr_id>                          输出下一个该跑的节点（blocker 未清空绝不给 human_approval）
  crctl git     <sub> [args...] [--cwd <p>] [--caller <skill>]   controlled-shell 白名单执行

全局: --workspace <path> 指定目标 workspace（默认从 cwd 向上探测 change-requests/_backlog.yml）
`;

function parseArgs(argv) {
  const flags = { cmdList: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cmd') { flags.cmdList.push(argv[++i]); continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

/** git 子命令专用解析：只抽取 crctl 自己的旗标，git 的旗标（--short 等）原样透传 */
function parseGitArgs(argv) {
  const CRCTL_FLAGS = ['--cwd', '--caller', '--workspace'];
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (CRCTL_FLAGS.includes(argv[i])) { flags[argv[i].slice(2)] = argv[++i]; continue; }
    positional.push(argv[i]);
  }
  return { flags, positional };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { process.stdout.write(HELP); return; }
  const { flags, positional } = cmd === 'git' ? parseGitArgs(rest) : parseArgs(rest);
  const ws = detectWorkspace(flags.workspace);
  const gates = loadGates();
  switch (cmd) {
    case 'status': return cmdStatus(ws, requireCr(positional), gates, flags);
    case 'gate': return cmdGate(ws, requireCr(positional), gates, { ...flags, specId: flags['spec-id'] });
    case 'advance': return cmdAdvance(ws, requireCr(positional), gates, { ...flags, specId: flags['spec-id'] });
    case 'approve': return cmdApprove(ws, requireCr(positional), gates, flags);
    case 'validate': {
      if (!positional[0]) fail('BAD_ARGS', 'validate 需要一个文件路径');
      return cmdValidate(ws, positional[0], gates);
    }
    case 'attempt': return cmdAttempt(ws, requireCr(positional), gates, flags);
    case 'test': return cmdTest(ws, requireCr(positional), gates, flags);
    case 'next': return cmdNext(ws, requireCr(positional), gates, flags);
    case 'git': return cmdGit(ws, positional, flags);
    default: fail('BAD_ARGS', `未知子命令 ${cmd}。运行 crctl help 查看用法`);
  }
}

function requireCr(positional) {
  if (!positional[0]) fail('BAD_ARGS', '缺少 <cr_id> 参数');
  return positional[0];
}

main();

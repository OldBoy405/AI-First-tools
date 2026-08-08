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

/* canonical evidence digest（P1 签名审批 §B.2，CR-2026-002 TASK-03）
 * 对 approvalStages[stage].evidence 声明的全部文件：按解析后路径字典序，
 * 逐文件 sha256(行尾规范化内容) 得 hex，拼接后再整体 sha256。
 * ⚠️ 这是 crctl 内摘要计算的唯一实现（AC-7⑤）：TTY approve 写入、--grant 验证、
 * gate/validate 复核全部调用本函数，不得各自维护哈希逻辑。
 * Go 侧（multica governance/approval.go）为等价实现，一致性由共享测试向量
 * test/fixtures/digest-vectors/ 固定。任一证据文件缺失返回 null（无法计算 ≠ 漂移）。
 * evidenceSha16 自本任务起仅用于历史 approval.yml 的 evidence-sha256-16 兼容复核（已废弃字段）。 */
function canonicalEvidenceDigest(ws, cr, stageCfg) {
  if (!stageCfg || !stageCfg.evidence) return null;
  const rels = Object.values(stageCfg.evidence).map((rel) => rel.replaceAll('{cr}', cr)).sort();
  const parts = [];
  for (const rel of rels) {
    const text = readFileChecked(path.join(ws, rel));
    if (text == null) return null;
    parts.push(sha256(text.replaceAll('\r\n', '\n')));
  }
  return sha256(parts.join(''));
}

function grantCanonicalString(g) {
  return `v1|${g.cr_id}|${g.stage}|${g.decision}|${g.approver}|${g.approved_at}|${g.evidence_digest}`;
}

function verifyGrantSignature(ws, grant) {
  const keyPath = path.join(ws, '.crctl', 'keys', `${grant.key_id}.pub`);
  const pem = readFileChecked(keyPath);
  if (pem == null) return { ok: false, code: 'KEY_NOT_FOUND', why: `公钥不存在: ${keyPath}（公钥应提交进 knowledge-base 仓的 .crctl/keys/）` };
  try {
    const pub = crypto.createPublicKey(pem);
    const okv = crypto.verify(null, Buffer.from(grantCanonicalString(grant), 'utf8'), pub, Buffer.from(grant.signature, 'base64'));
    return okv ? { ok: true } : { ok: false, code: 'SIGNATURE_INVALID', why: 'Ed25519 验签失败：签名与 canonical 串不匹配（grant 被篡改或挪用）' };
  } catch (e) {
    return { ok: false, code: 'SIGNATURE_INVALID', why: `验签异常: ${String(e && e.message || e)}` };
  }
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
    // 文件名片段消毒：pending: 占位 sha（CR-2026-003）含冒号，Windows 文件名非法；只影响文件名，事件内容不动
    const shaSlug = (event.commit_sha || 'nosha').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'nosha';
    const name = ev.dedup_name || `${ts}-${event.cr_id}-${event.event_kind}-${shaSlug}.json`;
    if (ev.dedup_name && fs.existsSync(path.join(dir, name))) return name; // 同一事实待采集期间只留一份
    const tmp = path.join(dir, `.tmp-${process.pid}-${name}`);
    fs.writeFileSync(tmp, JSON.stringify(event, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, path.join(dir, name)); // 原子可见：先写临时名再 rename，防半写
    return name;
  } catch (e) {
    try { auditLog(ws, { kind: 'outbox', result: 'EMIT_FAILED', why: String(e && e.message || e) }); } catch { /* 双重失败只能放弃 */ }
    return null;
  }
}

/* EVIDENCE_DRIFT 留证（TASK-10，P1 §B.4）：gate/validate 每次检出漂移都发一条 audit
 * 事件（daemon 采集 → 服务端 activity_log）。payload 只有摘要与阶段名，不含证据内容。
 * 文件名确定性（cr+stage+两侧摘要前 8 位）：同一份漂移在被采集走之前只留一份；
 * 采集后若漂移仍在，下一次 gate/validate 观测会再留一条——按观测窗口计数，符合审计语义。 */
function emitDriftAudit(ws, cr, stage, expected, actual) {
  const id8 = (s) => String(s || 'none').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  return emitOutboxEvent(ws, {
    event_kind: 'audit', cr_id: cr, trigger: 'evidence-drift',
    payload: {
      action: 'aifirst.evidence_drift', stage: stage || '',
      expected_digest: String(expected || ''), actual_digest: String(actual || ''),
      detected_at: nowIso(),
    },
    dedup_name: `audit-drift-${cr}-${id8(stage)}-${id8(expected)}${id8(actual)}.json`,
  });
}

/* embedded 占位 sha（CR-2026-003 FR-1）：--embedded/--no-commit 模式没有真实 commit，
 * 但 commit_sha 是服务端 cr_sync_event 幂等键 (cr_id, commit_sha, event_kind) 的一部分——
 * 恒定空串会让同一 CR 的第二次 embedded status 事件被 ON CONFLICT 静默吞掉（CR-2026-002
 * 归档期实测）。改为进程内唯一占位符；"pending:" 前缀是与 multica projectableSha() 的
 * 跨语言契约（服务端据此把它排除在投影指针之外），两侧测试各锁同一字面量。 */
let embeddedSeq = 0;
function pendingCommitSha() {
  embeddedSeq += 1;
  return `pending:${Date.now()}:${process.pid}:${embeddedSeq}`;
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
  const r = spawnSync('git', [sub, ...args], { cwd: cwd || ws, encoding: 'utf8', shell: false, env: { ...process.env, GIT_EDITOR: 'true', EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' } });
  const out = { ok: r.status === 0, exit: r.status, stdout: (r.stdout || '').slice(0, 20000), stderr: (r.stderr || '').slice(0, 20000) };
  auditLog(ws, { ...record, result: out.ok ? 'ok' : `exit=${r.status}` });
  return out;
}

/* ────────────────────────── 证据读取与 passCondition 求值 ────────────────────────── */

/** 抽取 Markdown frontmatter 块。命中返回 {match, body}（match=完整 `---…---` 串供替换重写，
 * body=内部 YAML 原文供 parseYaml 解析或行级正则改写）；无 frontmatter 返回 null。
 * 唯一收敛点：此正则此前在 5 处逐字复制（readEvidenceDoc / updateCrMdStatus /
 * readCrMdFrontmatter / detectStatusDivergence / validate）。刻意只收敛正则、不代解析——
 * updateCrMdStatus 只做字符串改写不 parse，代解析会引入无谓 parseYaml 调用。 */
function matchFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? { match: m[0], body: m[1] } : null;
}

function readEvidenceDoc(ws, cr, rel) {
  const p = path.join(ws, rel.replaceAll('{cr}', cr));
  const text = readFileChecked(p);
  if (text == null) return { path: p, exists: false, data: null };
  if (p.endsWith('.md')) {
    const m = matchFrontmatter(text);
    let data = m ? parseYaml(m.body) : {};
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

// CR-2026-025 项③（FR-11，D-7：常量不做配置）：isEmpty 数组失败逐项截断。
// 只封单条长度、不封条数；非字符串项原样保留，数组类型不变（FR-13/NFR-3）。
const ITEM_MAX = 120;
function briefArray(v) {
  return v.map((x) => (typeof x === 'string' && x.length > ITEM_MAX)
    ? x.slice(0, ITEM_MAX) + `…(+${x.length - ITEM_MAX}字)` : x);
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
      // CR-2026-025 回显收敛（FR-11/FR-12/FR-14）：只封单条长度、不封条数——条目数极多时输出仍线性增长；
      // 全量原文唯一来源是 file 字段指向的 review-annotations/{stage}.yml。equals 分支与标量路径保持现状（D-9）。
      if (!okv && Array.isArray(val)) {
        results.push({ ok: okv, cond, actual: briefArray(val), file: doc.path, why: `期望 ${fieldPath} 为空，实际 ${val.length} 条（详见 ${doc.path}）` });
      } else {
        results.push({ ok: okv, cond, actual: val ?? null, file: doc.path, why: okv ? null : `期望 ${fieldPath} 为空，实际 ${JSON.stringify(val)}` });
      }
    } else {
      results.push({ ok: false, cond, why: `不支持的条件形态: ${JSON.stringify(cond)}` });
    }
  }
  return { pass: results.length > 0 && results.every((r) => r.ok), results, source };
}

// CR-2026-005 FR-1: delivery/task 回写一致性检查。tasks/_index.yml 中每条
// status=done 的任务，必须能在全局 delivery/task/_index.yaml 里按 id 找到
// 对应条目——两份索引的 id 字段已核实同名同值（如 CR-2026-004-TASK-01），
// 简单集合差即可，不需要映射表。两个边界（PRD FR-3）处理不同：doneIds 为
// 空时直接放行（没有待核对项）；全局索引文件不存在但 doneIds 非空时视为
// 全局集合为空集，正常计算 missing（此时应报告缺失，因为回写确实没做，
// 不是"视为通过"）。
function checkDeliveryIndexComplete(ws, cr) {
  const tasksIdx = readEvidenceDoc(ws, cr, 'change-requests/{cr}/tasks/_index.yml');
  const doneIds = tasksIdx.exists
    ? (tasksIdx.data?.tasks || []).filter((t) => t.status === 'done').map((t) => t.id)
    : [];
  if (doneIds.length === 0) return { ok: true, missing: [] };
  const globalPath = path.join(ws, 'delivery/task/_index.yaml');
  const globalIds = fs.existsSync(globalPath)
    ? (parseYaml(fs.readFileSync(globalPath, 'utf8'))?.tasks || []).map((e) => e.id)
    : [];
  const missing = doneIds.filter((id) => !globalIds.includes(id));
  return { ok: missing.length === 0, missing };
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
      // 两轨审批（TASK-03）：TTY 的 crctl-approve 与 grant 的 server-approve 都被门禁承认
      const okv = !!(section && section.approver && section['approved-at'] && ['crctl-approve', 'server-approve'].includes(section.via));
      let why = okv ? null : `approval.yml#${check.section} 缺失或非 crctl approve 写入（via 必须为 crctl-approve 或 server-approve）`;
      let drift = null;
      const stageEntry = Object.entries(gates.approvalStages || {}).find(([, s]) => s.approvalSection === check.section);
      const stageKey = stageEntry ? stageEntry[0] : null;
      const stageCfg = stageEntry ? stageEntry[1] : null;
      if (okv && section['evidence-digest']) {
        // 摘要漂移检测：两轨统一，只要统一字段存在就重算比对（canonical 唯一实现）
        const currentDigest = canonicalEvidenceDigest(ws, cr, stageCfg);
        if (currentDigest && currentDigest !== section['evidence-digest']) {
          drift = 'EVIDENCE_DRIFT';
          why = `EVIDENCE_DRIFT：approval.yml#${check.section} 记录的证据摘要 ${section['evidence-digest'].slice(0, 16)}… 与当前重算 ${currentDigest.slice(0, 16)}… 不一致，证据在审批后被改动`;
          emitDriftAudit(ws, cr, stageKey || check.section, section['evidence-digest'], currentDigest);
        }
      } else if (okv && section['evidence-sha256-16']) {
        // 废弃字段兼容：历史审批（M0 口径）继续按单文件短哈希复核，不报错不阻塞（AC-7②）
        const evDoc = stageCfg?.evidence?.$default ? readEvidenceDoc(ws, cr, stageCfg.evidence.$default) : { exists: false };
        const currentHash = evDoc.exists ? evidenceSha16(fs.readFileSync(evDoc.path, 'utf8')) : null;
        if (currentHash && currentHash !== section['evidence-sha256-16']) {
          drift = 'EVIDENCE_DRIFT';
          why = `EVIDENCE_DRIFT：approval.yml#${check.section} 记录的证据哈希 ${section['evidence-sha256-16']} 与 ${evDoc.path} 当前哈希 ${currentHash} 不一致，证据在审批后被改动`;
          emitDriftAudit(ws, cr, stageKey || check.section, section['evidence-sha256-16'], currentHash);
        }
      }
      if (okv && !drift && section.via === 'server-approve') {
        // 签名重验证（仅新轨）：从存档字段重建 canonical 并验签——摘要漂移与签名有效性分开判断
        const sig = verifyGrantSignature(ws, {
          cr_id: cr, stage: stageKey, decision: 'approve', approver: section.approver,
          approved_at: section['grant-approved-at'], evidence_digest: section['evidence-digest'] || '',
          key_id: section['key-id'], signature: section.signature,
        });
        if (!sig.ok) { drift = sig.code; why = `approval.yml#${check.section} server-approve 签名重验证失败：${sig.why}`; }
      }
      out.checks.push({ type: check.type, section: check.section, ok: okv && !drift, why, code: drift || undefined });
    } else if (check.type === 'deliveryIndexComplete') {
      const r = checkDeliveryIndexComplete(ws, cr);
      out.checks.push({
        type: check.type, ok: r.ok, missing: r.missing,
        why: r.ok ? null : `delivery/task 索引缺失 ${r.missing.length} 项: ${r.missing.join(', ')}`,
      });
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
/* casWriteMulti — 多文件全有或全无 CAS 写（CR-2026-019 TASK-01，archive-move 双文件原子）
 * 三阶段：全校验 → 全写 temp → 连续 rename。任一侧读后被改则整体 CAS_CONFLICT 中止，
 * 不落任何一侧（NFR-2：绝不产生 backlog 已删而 history 未写的半状态）。
 * expectedHash 为 null 表示"期望目标文件不存在"（首次归档时 _history.yml 可缺省）：
 * 文件实际不存在则放行（新建），文件实际存在则 CAS_CONFLICT（创建冲突）。
 * 残余窗口（ponytail 天花板）：两次 rename 间进程崩溃留半状态，SDD §4.3 判定为可接受：
 * rename 微秒级窗口 + 账本随 --embedded 进同一 git 提交可整体回滚 + 单写者不变量下无并发。
 */
function casWriteMulti(writes) {
  for (const w of writes) {
    const cur = readFileChecked(w.path);
    if (cur == null && w.expectedHash == null) continue;
    if (cur == null) fail('CAS_FILE_MISSING', `写入前文件消失: ${w.path}`);
    if (w.expectedHash == null || sha256(cur) !== w.expectedHash)
      fail('CAS_CONFLICT', `${w.path} 在读取后被其他进程修改（或与预期存在状态不符），本次写入中止，两侧均未落盘。请重新执行。`);
  }
  const staged = writes.map((w) => {
    const tmp = w.path + `.tmp-${process.pid}`;
    fs.writeFileSync(tmp, w.newText, 'utf8');
    return { tmp, dst: w.path };
  });
  for (const s of staged) fs.renameSync(s.tmp, s.dst);
}
/* ────────────────────────── 账本编辑纯函数（CR-2026-019） ──────────────────────────
 * 行级正则改写，纯 string→string（SDD §1.1）；匹配不到一律 fail 硬失败（纪律 #1），
 * 禁止静默返回原文（T04 教训）。三个子命令只做账本编辑、不发 status 事件（纪律 #5：
 * 状态唯一写者仍是 advance）。
 */

/** 锚定 "- id: <id>" 条目块（该行到下一个同缩进 "- id:" 或 EOF）。返回 {start,end,text,indent}（start/end 为字符偏移）。 */
function matchEntryBlock(text, id) {
  const lines = text.split('\n');
  let startLine = -1, indent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)- id:\s*["']?([^\s"']+)["']?\s*$/);
    if (m && m[2] === id) { startLine = i; indent = m[1].length; break; }
  }
  if (startLine === -1) return null;
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)- id:\s*["']?([^\s"']+)["']?\s*$/);
    if (m && m[1].length <= indent) { endLine = i; break; }
  }
  let start = 0;
  for (let i = 0; i < startLine; i++) start += lines[i].length + 1;
  let end = start;
  for (let i = startLine; i < endLine; i++) end += lines[i].length + 1;
  if (endLine === lines.length && text.endsWith('\n')) end -= 1;
  return { start, end, text: lines.slice(startLine, endLine).join('\n'), indent };
}

/** task done：块内 status 行替换 + done-at 插入，一次完成（SDD §4.1）。 */
function editTaskDone(text, taskId) {
  const norm = text.replaceAll('\r\n', '\n');
  const block = matchEntryBlock(norm, taskId);
  if (!block) fail('TASK_NOT_FOUND', `${taskId} 不在 tasks/_index.yml`);
  if (/^\s*status:\s*done\b/m.test(block.text)) fail('TASK_ALREADY_DONE', `${taskId} 已是 done 状态`);
  let hit = false;
  const nb = block.text.replace(/^(\s*)status:\s*\S.*$/m, (_, indent) => {
    hit = true;
    return `${indent}status: done\n${indent}done-at: "${nowIso()}"`;
  });
  if (!hit) fail('TASK_INDEX_SHAPE', `${taskId} 块内无 status 行（tasks/_index.yml 结构异常）`);
  // 块替换后补尾部换行：紧凑格式（块间无空行）下 block.text 无尾随换行，直接拼接会把下一块粘连（T04 教训延伸）
  return norm.slice(0, block.start) + nb + '\n' + norm.slice(block.end);
}

/** task done 依赖守卫（CR-2026-025 TASK-01，PRD FR-6/FR-7，SDD §4.2）：一跳直接前置校验。
 * 缺失/空数组 = 无依赖放行（D-5）；悬空引用 DEPENDS_ON_UNKNOWN；未完成前置 DEPENDS_ON_NOT_DONE。
 * 非数组形态复用 SCHEMA_INVALID（TD-BL-3：不新增错误码）。成环 TASK 天然互卡在 DEPENDS_ON_NOT_DONE，
 * 不做传递闭包遍历、不单独检测环（D-6）。解析复用既有 parseYaml（FR-8/NFR-8，禁新写解析）。 */
function guardDependsOn(normText, taskId) {
  const idx = parseYaml(normText) || {};
  const tasks = Array.isArray(idx.tasks) ? idx.tasks : [];
  const byId = new Map(tasks.filter((t) => t && t.id != null).map((t) => [String(t.id), t]));
  const target = byId.get(taskId);
  if (!target) return; // TASK 不存在由后续 editTaskDone 的 TASK_NOT_FOUND 兜底
  const deps = target['depends-on'];
  if (deps == null || (Array.isArray(deps) && deps.length === 0)) return; // D-5：缺失/空数组 = 无依赖
  if (!Array.isArray(deps)) fail('SCHEMA_INVALID', `${taskId} 的 depends-on 必须是列表，实际 ${JSON.stringify(deps)}`, { taskId, field: 'depends-on' });
  const ids = deps.map((d) => String(d));
  const unknown = ids.filter((d) => !byId.has(d));
  if (unknown.length) fail('DEPENDS_ON_UNKNOWN', `${taskId} 的 depends-on 引用了不存在的 TASK：${unknown.join(', ')}`, { unknown });
  const notDone = ids.filter((d) => byId.get(d).status !== 'done');
  if (notDone.length) fail('DEPENDS_ON_NOT_DONE',
    `${taskId} 的直接前置未全部 done：${notDone.map((d) => `${d}(${byId.get(d).status})`).join(', ')}。若前置互相等待，检查 depends-on 是否成环`,
    { notDone: notDone.map((d) => ({ id: d, status: byId.get(d).status })) });
}

/** merge-metadata：条目 merge-commits[] 追加 {repo,trunk,sha,branch}，无则创建键（SDD §4.2）。
 * branch 由 CR id 按硬约定（分支恒为 requirement/{cr}）自动补全——必填集仍为 {repo,trunk,sha}
 * （唯一生产者保证输出的集合），branch 是可推导的富化字段（CR-2026-020 复盘 FR-8：字段契约收敛）。 */
function editMergeMetadata(text, cr, commit) {
  const norm = text.replaceAll('\r\n', '\n');
  const block = matchEntryBlock(norm, cr);
  if (!block) fail('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`);
  const lines = block.text.split('\n');
  const mcIdx = lines.findIndex((l) => /^[ \t]*merge-commits:/.test(l));
  const itemIndent = ' '.repeat(block.indent + 4);
  const fieldIndent = ' '.repeat(block.indent + 6);
  const item = `${itemIndent}- repo: ${commit.repo}\n${fieldIndent}trunk: ${commit.trunk}\n${fieldIndent}sha: ${commit.sha}\n${fieldIndent}branch: requirement/${cr}`;
  if (mcIdx === -1) {
    const fieldIndent2 = ' '.repeat(block.indent + 2);
    lines.push(`${fieldIndent2}merge-commits:`, item);
  } else {
    if (/^[ \t]*merge-commits:\s*\[\]\s*$/.test(lines[mcIdx])) lines[mcIdx] = lines[mcIdx].replace(/:\s*\[\]\s*$/, ':');
    // 段边界：merge-commits 键行之后第一个缩进不深于键的行（含块尾）
    const mcIndent = lines[mcIdx].match(/^[ \t]*/)[0].length;
    let segEnd = lines.length;
    for (let i = mcIdx + 1; i < lines.length; i++) {
      if (lines[i].match(/^[ \t]*/)[0].length <= mcIndent) { segEnd = i; break; }
    }
    // 段内最后一个列表项行
    let lastItem = -1;
    for (let i = segEnd - 1; i > mcIdx; i--) {
      if (/^[ \t]*- /.test(lines[i])) { lastItem = i; break; }
    }
    // 插入点 = 最后一项行 + 其嵌套字段行之后（段尾前）；无项则紧跟键行
    let insAt = lastItem === -1 ? mcIdx + 1 : lastItem + 1;
    if (lastItem !== -1) {
      const itemInd = lines[lastItem].match(/^[ \t]*/)[0].length;
      while (insAt < segEnd && lines[insAt].match(/^[ \t]*/)[0].length > itemInd) insAt++;
    }
    lines.splice(insAt, 0, item);
  }
  return norm.slice(0, block.start) + lines.join('\n') + norm.slice(block.end);
}

/** archive-move：生成 newBacklog（删块）+ newHistory（history 追加富化块）（SDD §4.3）。 */
function editArchiveMove(textB, textH, cr, meta) {
  const normB = textB.replaceAll('\r\n', '\n');
  const block = matchEntryBlock(normB, cr);
  if (!block) fail('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`);
  const newBacklog = normB.slice(0, block.start) + normB.slice(block.end);
  const normH = textH == null ? '' : textH.replaceAll('\r\n', '\n');
  if (normH && matchEntryBlock(normH, cr)) fail('ENTRY_ALREADY_IN_HISTORY', `${cr} 已在 _history.yml，禁止重复归档`);
  const minIndent = Math.min(...block.text.split('\n').map((l) => (l.match(/^[ \t]*/) || [''])[0].length));
  const entry = block.text.split('\n').map((l) => '  ' + l.slice(minIndent)).join('\n');
  const reason = String(meta.archiveReason || '').replaceAll('"', '\\"');
  const enrich = [
    `    final-status: ${meta.finalStatus}`,
    `    archive-reason: "${reason}"`,
    meta.specId ? `    writeback-spec-id: ${meta.specId}` : null,
    `    archived-at: "${nowIso()}"`,
  ].filter(Boolean).join('\n');
  const record = entry + '\n' + enrich + '\n';
  const newHistory = (normH.trim() === '' ? 'history:' : normH.trimEnd()) + '\n' + record;
  return { newBacklog, newHistory };
}



function updateCrMdStatus(ws, cr, newStatus) {
  const p = path.join(crDir(ws, cr), 'cr.md');
  const text = readFileChecked(p);
  if (text == null) return { updated: false, why: `cr.md 不存在: ${p}` };
  const hash = sha256(text);
  const m = matchFrontmatter(text);
  if (!m) return { updated: false, why: 'cr.md 无 frontmatter' };
  let fm = m.body;
  if (/^status:\s*.*$/m.test(fm)) fm = fm.replace(/^status:\s*.*$/m, `status: ${newStatus}`);
  else fm = fm + `\nstatus: ${newStatus}`;
  if (/^updated-at:\s*.*$/m.test(fm)) fm = fm.replace(/^updated-at:\s*.*$/m, `updated-at: "${nowIso()}"`);
  casWrite(p, hash, text.replace(m.match, `---\n${fm}\n---`));
  return { updated: true, path: p };
}

/* ────────────────────────── 状态读取收敛（CR-2026-018 FR-2） ──────────────────────────
 * 状态权威源 = cr.md frontmatter；_backlog.yml 退化为注册索引（owners/merge-commits 等低频字段）。
 * 迁移期兼容读：cr.md 无 status 时回退 backlog 条目 status（deprecated since v0.2.0，计划 v0.3.0 移除）。
 * 冲突裁决：cr.md 与 backlog 都有 status 且不一致时 cr.md 胜（权威），不报错——漂移检测归 validate。
 */

function readCrMdFrontmatter(ws, cr) {
  const p = path.join(crDir(ws, cr), 'cr.md');
  const text = readFileChecked(p);
  if (text == null) return null;
  const m = matchFrontmatter(text);
  if (!m) return null;
  return parseYaml(m.body);
}

function resolveCrState(ws, cr) {
  const snap = loadBacklogEntry(ws, cr);            // 注册字段 + CAS snapshot（保留原样）
  const md = readCrMdFrontmatter(ws, cr);
  if (md && md.status) {
    const mixed = snap.entry.status && snap.entry.status !== md.status;
    return { snap, status: md.status, statusSource: 'cr.md', mixedLayout: mixed };
  }
  if (snap.entry.status)                             // 迁移期兼容读（FR-2，deprecated）
    return { snap, status: snap.entry.status, statusSource: '_backlog.yml', legacySource: true, mixedLayout: false };
  fail('CR_MD_STATUS_MISSING', `${cr} 在 cr.md 与 _backlog.yml 中均无 status`);
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

/* ────────────────────────── 工作区漂移检测（CR-2026-020 复盘 FR-2） ──────────────────────────
 * 根因：CR 全部状态推进发生在 worktree 分支 requirement/{cr}，主工作区 cr.md 停在注册快照，
 * 二者静默分叉时承接会话据陈旧视图重写产物（会话工作区漂移复盘）。
 * 修复：status 检出该 CR 是否存在 worktree（分支恒为 requirement/{cr}，纯约定、无需存指针），
 * 若其 cr.md 状态与当前 workspace 视图不一致，附 STATUS_DIVERGED 告警（warn-only，只读）。
 * git worktree list 走 controlled-shell（白名单形态仅 `list`，不能带 --porcelain），解析纯文本。 */

function parseWorktreeList(stdout, branch) {
  for (const line of stdout.split(/\r?\n/)) {
    // 形如：<path>  <sha7-40> [<branch>]；bare/detached 行无 [branch] 括号，正则不匹配自然跳过
    const m = line.match(/^(.*\S)\s+[0-9a-f]{7,40}\s+\[([^\]]+)\]\s*$/);
    if (m && m[2].trim() === branch) return m[1].trim();
  }
  return null;
}

function detectStatusDivergence(ws, cr, currentStatus) {
  // 非 git 工作区无 worktree 概念，直接跳过——保证 status 在非 git 目录下零副作用（纯读）
  if (!fs.existsSync(path.join(ws, '.git'))) return null;
  const r = controlledGit(ws, 'worktree', ['list'], ws, 'crctl-status');
  if (!r.ok || !r.stdout) return null;
  const wtPath = parseWorktreeList(r.stdout, `requirement/${cr}`);
  if (!wtPath || path.resolve(wtPath) === path.resolve(ws)) return null; // 无 worktree 或正在 worktree 内读（即事实源本身）
  const md = readFileChecked(path.join(wtPath, 'change-requests', cr, 'cr.md'));
  if (md == null) return null;
  const m = matchFrontmatter(md);
  const fm = m ? parseYaml(m.body) : null;
  const wtStatus = fm && fm.status;
  if (!wtStatus || wtStatus === currentStatus) return null;
  return {
    code: 'STATUS_DIVERGED',
    message: `当前 workspace 视图 status=${currentStatus}，但该 CR 的 worktree 分支 requirement/${cr}（${wtPath}）cr.md status=${wtStatus}。worktree 分支为 CR 事实源——请改用 \`crctl status --workspace ${wtPath}\` 为准，勿据当前陈旧视图动手。`,
  };
}

/* ────────────────────────── 子命令实现 ────────────────────────── */

function cmdStatus(ws, cr, gates, flags) {
  const { sm, source } = loadStateMachine(ws);
  const state = resolveCrState(ws, cr);
  const snap = state.snap;
  const current = state.status;
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
  const warnings = [];
  if (state.mixedLayout) warnings.push({ code: 'MIXED_LAYOUT_WARN', message: `cr.md status=${current} 与 _backlog.yml status=${snap.entry.status} 不一致，以 cr.md 为准；workspace 可能被新旧 crctl 混用，建议统一版本后执行 migrate-backlog` });
  if (state.legacySource) warnings.push({ code: 'MIXED_LAYOUT_WARN', message: `状态从 _backlog.yml 回退读取（cr.md 无 status），workspace 布局为旧版；建议执行 migrate-backlog 升级到 v2` });
  const diverged = detectStatusDivergence(ws, cr, current);
  if (diverged) warnings.push(diverged);
  ok({
    cr, status: current,
    source: { backlog: snap.path, backlogSha256: snap.hash.slice(0, 12), crMd: path.join(crDir(ws, cr), 'cr.md'), stateMachine: source },
    ...(state.legacySource ? { legacySource: '_backlog.yml' } : {}),
    owners: snap.entry.owners || null,
    legalNext: nexts,
    reviewLoops: loops,
    gateBlockers: missing,
    ...(warnings.length ? { warnings } : {}),
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
  const state = resolveCrState(ws, cr);
  const snap = state.snap;
  const current = state.status;
  if (flags.expect && flags.expect !== current) {
    fail('CR_STATUS_CURRENT_MISMATCH', `期望当前状态 ${flags.expect}，实际 ${current}`);
  }
  const t = findTransition(sm, current, flags.to, flags.trigger);
  if (!t) {
    fail('CR_STATUS_TRANSITION_NOT_ALLOWED', `状态机中不存在 (${current} → ${flags.to}) @ trigger=${flags.trigger} 的合法转换`, {
      legalNext: legalTransitions(sm, current).map((x) => ({ to: x.to, trigger: x.trigger })),
    });
  }
  // FR-4（CR-2026-020 复盘）：目标态门禁需校验 specs 落点（path 含 {spec}）却缺 --spec-id 时，
  // 命令入口即 fail-fast，不埋进 GATE_BLOCKED.checks[].why（--spec-id 曾同坑犯两次）。
  const targetChecks = gates.statusGates[flags.to] || [];
  if (!flags.specId && targetChecks.some((c) => typeof c.path === 'string' && c.path.includes('{spec}'))) {
    fail('BAD_ARGS', `advance --to ${flags.to} 需要 --spec-id <specId>：该目标态门禁需校验 specs 落点（specs/{spec}/...）。请补 --spec-id 后重试。`);
  }
  const gate = runGateChecks(ws, cr, flags.to, gates, flags);
  if (!gate.pass) {
    // FR-5：把未过门禁的具体原因提升进错误摘要，避免调用方漏读 checks[].why
    const why = gate.checks.filter((c) => !c.ok).map((c) => c.why).filter(Boolean).join('；');
    fail('GATE_BLOCKED', `目标状态 ${flags.to} 的门禁未通过，拒绝写入${why ? '：' + why : ''}`, { gate });
  }
  const crmd = updateCrMdStatus(ws, cr, flags.to);
  if (!crmd.updated) fail('CR_MD_WRITE_FAILED', `advance 写入 cr.md 失败: ${crmd.why}`);
  auditLog(ws, { kind: 'advance', cr, from: current, to: flags.to, trigger: flags.trigger, by: identity(ws) });
  const result = { advanced: true, cr, from: current, to: flags.to, trigger: flags.trigger, files: [crmd.path], crMd: crmd };
  if (flags.embedded || flags['no-commit']) {
    result.commit = 'embedded：由调用方在同一事务中提交上述文件';
  } else {
    const msg = `[cr] status ${cr} ${current} -> ${flags.to}`;
    const addR = controlledGit(ws, 'add', [`change-requests/${cr}/cr.md`], ws, 'crctl-advance');
    const commitR = addR.ok ? controlledGit(ws, 'commit', ['-m', msg], ws, 'crctl-advance') : addR;
    result.commit = commitR.ok ? { message: msg } : { failed: true, detail: commitR, note: '状态文件已写入但 commit 失败，请修复后手工经 crctl git 提交' };
  }
  // outbox：状态事件。--embedded/--no-commit 时 commit_sha 留空，由 push 的 checkpoint 事件补全（§A.5）
  const committed = result.commit && result.commit.message;
  // 证据快照：进入某审批阶段的 expect 状态（待审批）时附带该阶段证据摘要——
  // 服务端签发 grant 前靠它确定"批的是哪一版证据"（P1 §B.1 ①，TASK-08 补挂）。
  // approve 级联传入的 flags.outboxEvidence 优先（同一份数据，来源不同时点）。
  let outboxEvidence = flags.outboxEvidence || {};
  if (!Object.keys(outboxEvidence).length) {
    const pendingStage = Object.values(gates.approvalStages || {}).find(
      (s) => Array.isArray(s.expect) && s.expect.includes(flags.to) && s.evidence);
    if (pendingStage) outboxEvidence = collectOutboxEvidence(ws, cr, pendingStage);
  }
  result.outbox = emitOutboxEvent(ws, {
    event_kind: 'status', cr_id: cr, from_status: current, to_status: flags.to,
    trigger: flags.trigger, commit_sha: committed ? gitHeadSha(ws) : pendingCommitSha(),
    actor: identity(ws), evidence: outboxEvidence,
  });
  ok(result);
  if (result.commit && result.commit.failed) process.exit(1);
}

// FR-12（CR-2026-022）：四 stage 审批驳回回退映射（与 dir-graph.yaml 的 {approve}:reject -> {write} 转换一一对应）
const REJECT_ROLLBACK = {
  requirement: { to: 'drafting', approve: 'approve-requirement', write: 'write-requirement-prd' },
  'tech-design': { to: 'tech-designing', approve: 'approve-tech-design', write: 'write-tech-design' },
  'dev-start': { to: 'tech-design-reviewed', approve: 'approve-dev-start', write: 'write-dev-plan' },
  code: { to: 'developing', approve: 'approve-code', write: 'implement-code' },
};

function cmdApprove(ws, cr, gates, flags) {
  const stage = flags.stage;
  const stageCfg = gates.approvalStages[stage];
  if (!stageCfg) fail('BAD_ARGS', `--stage 必须是 ${Object.keys(gates.approvalStages).join(' | ')}`);
  // grant 模式（P1 签名审批 §B，CR-2026-002 TASK-03）：服务端已完成人类身份校验并签名，
  // crctl 本地验签 + 重算证据摘要后非 TTY 放行——强度不降级，只是"人在环"发生在服务端。
  if (flags.grant) return approveWithGrant(ws, cr, gates, flags, stage, stageCfg);
  // TTY 路径：人类在环的硬检查，非交互式会话一律拒绝，无任何旁路（治理⑤）
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('APPROVAL_REQUIRES_HUMAN', 'crctl approve 仅接受交互式终端会话（或 --grant 携带服务端签名审批）。模型/管道/脚本直接调用一律拒绝。');
  }
  const state = resolveCrState(ws, cr);
  const current = state.status;
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
    // 统一字段 evidence-digest：canonical 摘要覆盖 stage 声明的全部证据文件（替代废弃的 evidence-sha256-16 单文件短哈希）
    evidenceHash = canonicalEvidenceDigest(ws, cr, stageCfg);
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
      // FR-12（CR-2026-022）：驳回必须真正执行状态机已声明的 {stage}:reject 回退转换（AGENTS.md 强制），不再只是 fail
      const rollback = REJECT_ROLLBACK[stage];
      const { sm } = loadStateMachine(ws);
      const trigger = `${rollback.approve}:reject -> ${rollback.write}`;
      const t = findTransition(sm, current, rollback.to, trigger);
      if (!t) fail('APPROVAL_DECLINED', '审批人未确认，且状态机未声明该阶段回退转换', { stage, current });
      cmdAdvance(ws, cr, gates, { to: rollback.to, trigger, expect: current });
      auditLog(ws, { kind: 'approve', cr, stage, approver, result: 'declined-rolled-back', to: rollback.to });
      fail('APPROVAL_DECLINED_ROLLED_BACK', `审批未通过，CR 已回退到 ${rollback.to}，请重跑 ${rollback.write}`, { rolledBackTo: rollback.to, rerunHint: rollback.write });
    }
    writeApprovalSection(ws, cr, stage, stageCfg, approver, evidenceHash);
    auditLog(ws, { kind: 'approve', cr, stage, approver, result: 'approved' });
    // 证据摘要随级联 advance 的 status 事件进 outbox（一个 approve 只发一条事件，避免与去重键冲突）
    const outboxEvidence = collectOutboxEvidence(ws, cr, stageCfg);
    // 级联推进状态（同一 gate 再校验一遍，包含 approval 检查）
    cmdAdvance(ws, cr, gates, { to: stageCfg.to, trigger: stageCfg.trigger, expect: current, specId: flags['spec-id'], outboxEvidence });
  });
}

function approveWithGrant(ws, cr, gates, flags, stage, stageCfg) {
  // 裸 --grant（无值）= 用 daemon 投递的标准落点 .crctl/grants/{cr}-{stage}.grant.json
  const grantArg = typeof flags.grant === 'string' ? flags.grant : path.join('.crctl', 'grants', `${cr}-${stage}.grant.json`);
  const gp = path.isAbsolute(grantArg) ? grantArg : path.join(ws, grantArg);
  const text = readFileChecked(gp);
  if (text == null) fail('GRANT_UNREADABLE', `grant 文件不存在或不可读: ${gp}`);
  let grant;
  try { grant = JSON.parse(text); } catch { fail('GRANT_UNREADABLE', `grant 不是合法 JSON: ${gp}`); }
  if (grant.v !== 1) fail('GRANT_UNSUPPORTED', `grant schema v=${grant.v}，当前仅支持 v1`);
  if (grant.decision === 'reject') {
    fail('GRANT_DECISION_REJECT', '驳回 grant 不走 approve：由编排方按状态机既有回退转移执行 advance，并把 reject_reason 作为 review_feedback 注入修复节点');
  }
  if (grant.decision !== 'approve') fail('GRANT_UNSUPPORTED', `decision=${grant.decision} 不在 [approve, reject]`);
  if (grant.cr_id !== cr || grant.stage !== stage) {
    fail('GRANT_MISMATCH', `grant 归属 (${grant.cr_id}, ${grant.stage})，当前审批 (${cr}, ${stage}) —— 签名绑定 cr_id+stage，禁止挪用`);
  }
  const state = resolveCrState(ws, cr);
  const current = state.status;
  if (stageCfg.expect && !stageCfg.expect.includes(current)) {
    fail('CR_STATUS_CURRENT_MISMATCH', `审批阶段 ${stage} 要求当前状态 ∈ [${stageCfg.expect.join(', ')}]，实际 ${current}`);
  }
  if (stageCfg.passCondition) {
    const r = evaluatePassCondition(ws, cr, stageCfg, gates);
    if (!r.pass) fail('GATE_BLOCKED', '自动评审证据未达标，禁止审批（grant 不豁免 blocker 检查）');
  }
  if (stageCfg.requireFiles) {
    for (const rel of stageCfg.requireFiles) {
      const p = path.join(ws, rel.replaceAll('{cr}', cr));
      if (!fs.existsSync(p)) fail('GATE_BLOCKED', `审批前置产物缺失: ${p}`);
    }
  }
  // 本地重算证据摘要：grant 签发的是"这一版证据"的批准，证据变了 grant 即失效
  const digest = canonicalEvidenceDigest(ws, cr, stageCfg) || '';
  if (digest !== (grant.evidence_digest || '')) {
    fail('EVIDENCE_DRIFT', `grant 签发时证据摘要 ${grant.evidence_digest || '(空)'}，当前重算 ${digest || '(空)'} —— 证据在签发后被改动或缺失`);
  }
  const sig = verifyGrantSignature(ws, grant);
  if (!sig.ok) fail(sig.code, sig.why);
  writeApprovalSection(ws, cr, stage, stageCfg, grant.approver, digest || null, { via: 'server-approve', grant });
  auditLog(ws, { kind: 'approve', cr, stage, approver: grant.approver, via: 'server-approve', keyId: grant.key_id, result: 'approved' });
  const outboxEvidence = collectOutboxEvidence(ws, cr, stageCfg);
  cmdAdvance(ws, cr, gates, { to: stageCfg.to, trigger: stageCfg.trigger, expect: current, specId: flags['spec-id'], outboxEvidence });
}

function collectOutboxEvidence(ws, cr, stageCfg) {
  const out = {};
  if (stageCfg.evidence) {
    for (const rel of Object.values(stageCfg.evidence)) {
      const p = path.join(ws, rel.replaceAll('{cr}', cr));
      const text = readFileChecked(p);
      if (text != null) out[rel.replaceAll('{cr}', cr)] = 'sha256:' + sha256(text.replaceAll('\r\n', '\n'));
    }
  }
  return out;
}

function writeApprovalSection(ws, cr, stage, stageCfg, approver, evidenceHash, opts = {}) {
  const p = path.join(crDir(ws, cr), 'approval.yml');
  const section = stageCfg.approvalSection;
  const existing = readFileChecked(p);
  const g = opts.grant || null;
  const block = [
    `${section}:`,
    `  approver: "${approver}"`,
    `  approved-at: "${nowIso()}"`,
    `  via: ${opts.via || 'crctl-approve'}`,
    evidenceHash ? `  evidence-digest: "${evidenceHash}"` : null,
    g ? `  key-id: "${g.key_id}"` : null,
    g ? `  signature: "${g.signature}"` : null,
    g ? `  grant-approved-at: "${g.approved_at}"` : null,
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
  const warnings = [];
  const pushIf = (cond, msg) => { if (cond) errors.push(msg); };
  const warnIf = (cond, msg) => { if (cond) warnings.push(msg); };

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
    const m = matchFrontmatter(text);
    if (!m) errors.push('cr.md: 缺少 YAML frontmatter');
    else {
      const fm = parseYaml(m.body);
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
    const schemaVer = (doc && !Array.isArray(doc) && doc.schema) || '';
    const isV2 = schemaVer === 'cr-backlog/v2';
    const { sm } = loadStateMachine(ws);
    const allStatuses = new Set([...(sm.transitions || []).flatMap((t) => [t.from, t.to]), ...(sm.terminal || [])]);
    for (const e of list) {
      const where = `_backlog.yml#${e?.id || '?'}`;
      pushIf(!e.id, `${where}: 缺少 id`);
      if (isV2) {
        // v2 布局：status/updated-at 已撤出，不应再出现
        warnIf(e.status !== undefined, `${where}: LEGACY_STATUS_FIELD — v2 schema 条目仍含 status 行（值=${e.status}），应执行 migrate-backlog 清除`);
        warnIf(e['updated-at'] !== undefined, `${where}: LEGACY_STATUS_FIELD — v2 schema 条目仍含 updated-at 行，应执行 migrate-backlog 清除`);
      } else {
        // v1 布局（迁移期）：status 必填，但与 cr.md 不一致时告警
        pushIf(!e.status, `${where}: 缺少 status`);
        pushIf(e.status && !allStatuses.has(e.status), `${where}: status=${e.status} 不在状态机枚举内`);
        if (e.id && e.status) {
          const md = readCrMdFrontmatter(ws, e.id);
          warnIf(md && md.status && md.status !== e.status, `${where}: 漂移 — backlog status=${e.status} 与 cr.md status=${md.status} 不一致，以 cr.md 为准；建议执行 migrate-backlog`);
        }
      }
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
    const crFromPath = (p.replaceAll('\\', '/').match(/change-requests\/([^/]+)\/approval\.yml$/) || [])[1] || null;
    for (const [k, v] of Object.entries(doc)) {
      if (typeof v !== 'object' || v == null) continue;
      pushIf(!v.approver, `approval.yml#${k}: 缺少 approver`);
      pushIf(!v['approved-at'], `approval.yml#${k}: 缺少 approved-at`);
      pushIf(!['crctl-approve', 'server-approve'].includes(v.via), `approval.yml#${k}: via 必须为 crctl-approve 或 server-approve（当前 ${v.via || '缺失'}），否则不被门禁承认`);
      // 两轨统一摘要复核 + server-approve 额外验签（与 gate 同口径，供 CI cr-guard 远端复核）
      const stageEntry = Object.entries(gates.approvalStages || {}).find(([, s]) => s.approvalSection === k);
      if (crFromPath && stageEntry && v['evidence-digest']) {
        const current = canonicalEvidenceDigest(ws, crFromPath, stageEntry[1]);
        if (current && current !== v['evidence-digest']) {
          pushIf(true, `approval.yml#${k}: EVIDENCE_DRIFT — 记录摘要与当前证据重算不一致`);
          emitDriftAudit(ws, crFromPath, stageEntry[0], v['evidence-digest'], current);
        }
      }
      if (crFromPath && stageEntry && v.via === 'server-approve') {
        const sig = verifyGrantSignature(ws, {
          cr_id: crFromPath, stage: stageEntry[0], decision: 'approve', approver: v.approver,
          approved_at: v['grant-approved-at'], evidence_digest: v['evidence-digest'] || '',
          key_id: v['key-id'], signature: v.signature,
        });
        pushIf(!sig.ok, `approval.yml#${k}: server-approve 签名重验证失败（${sig.code}）`);
      }
    }
  } else if (base === 'traceability.yml') {
    const doc = parseYaml(text) || {};
    pushIf(typeof doc !== 'object', 'traceability.yml: 顶层必须是映射');
  } else {
    fail('UNKNOWN_ARTIFACT', `validate 暂不支持该文件类型: ${base}`);
  }

  if (errors.length) {
    process.stderr.write(JSON.stringify({ file: p, valid: false, errors, ...(warnings.length ? { warnings } : {}) }, null, 2) + '\n');
    process.exit(1);
  }
  ok({ file: p, valid: true, ...(warnings.length ? { warnings } : {}) });
}


function cmdTaskDone(ws, cr, gates, flags) {
  if (!flags.task) fail('BAD_ARGS', 'task done 需要 --task <TASK-ID>');
  const state = resolveCrState(ws, cr);
  const LEGAL = ['developing'];
  if (!LEGAL.includes(state.status)) fail('ILLEGAL_LEDGER_STATE', `task done 仅允许在前置态 ${LEGAL.join('/')} 执行，当前 ${state.status}`, { current: state.status, expect: LEGAL });
  const p = path.join(crDir(ws, cr), 'tasks', '_index.yml');
  const text = readFileChecked(p);
  if (text == null) fail('TASK_INDEX_NOT_FOUND', `缺少 ${p}`);
  const norm = text.replaceAll('\r\n', '\n'); // 纪律 #1：守卫与编辑共用同一份规范化文本，不重复读盘
  guardDependsOn(norm, flags.task);
  const newText = editTaskDone(norm, flags.task);
  casWrite(p, sha256(text), newText);
  auditLog(ws, { kind: 'ledger', op: 'task-done', cr, actor: identity(ws), before: { taskId: flags.task, from: 'pending' }, after: { taskId: flags.task, to: 'done' } });
  ok({ op: 'task-done', cr, task: flags.task, status: 'done', file: p });
}

function cmdMergeMetadata(ws, cr, gates, flags) {
  if (!flags.repo || !flags.trunk || !flags.sha) fail('BAD_ARGS', 'merge-metadata 需要 --repo <r> --trunk <t> --sha <sha>');
  const state = resolveCrState(ws, cr);
  const LEGAL = ['merging', 'writing-back'];
  if (!LEGAL.includes(state.status)) fail('ILLEGAL_LEDGER_STATE', `merge-metadata 仅允许在前置态 ${LEGAL.join('/')} 执行，当前 ${state.status}。请先 crctl advance 到 ${LEGAL[0]} 再写 merge 元数据（状态前置强制：先推进状态，后写账本）`, { current: state.status, expect: LEGAL });
  const snap = loadBacklogEntry(ws, cr);
  const before = (snap.entry['merge-commits'] || []).length;
  const dup = (snap.entry['merge-commits'] || []).some((c) => c && String(c.sha) === String(flags.sha));
  if (dup) {
    auditLog(ws, { kind: 'ledger', op: 'merge-metadata', cr, actor: identity(ws), result: 'dup-idempotent', sha: flags.sha });
    return ok({ op: 'merge-metadata', cr, sha: flags.sha, result: 'dup-idempotent', note: '同 sha 已存在，未重复写入' });
  }
  const newText = editMergeMetadata(snap.text, cr, { repo: flags.repo, trunk: flags.trunk, sha: flags.sha });
  casWrite(snap.path, snap.hash, newText);
  auditLog(ws, { kind: 'ledger', op: 'merge-metadata', cr, actor: identity(ws), before: { count: before }, after: { sha: flags.sha, count: before + 1 } });
  ok({ op: 'merge-metadata', cr, repo: flags.repo, trunk: flags.trunk, sha: flags.sha, branch: `requirement/${cr}`, result: 'appended' });
}

function cmdArchiveMove(ws, cr, gates, flags) {
  if (!flags['final-status']) fail('BAD_ARGS', 'archive-move 需要 --final-status <status>');
  const state = resolveCrState(ws, cr);
  if (state.status !== 'archived') fail('ILLEGAL_LEDGER_STATE', `archive-move 仅允许在前置态 archived 执行，当前 ${state.status}。请先 crctl advance 到 archived（带 --spec-id）再 archive-move（状态前置强制）`, { current: state.status, expect: ['archived'] });
  const bp = backlogPath(ws);
  const hp = path.join(ws, 'change-requests', '_history.yml');
  const textB = readFileChecked(bp);
  if (textB == null) fail('BACKLOG_NOT_FOUND', `缺少 ${bp}`);
  const textH = readFileChecked(hp);
  const parts = editArchiveMove(textB, textH, cr, {
    finalStatus: flags['final-status'],
    archiveReason: flags['archive-reason'] || '',
    specId: flags['spec-id'] || null,
  });
  casWriteMulti([
    { path: bp, expectedHash: sha256(textB), newText: parts.newBacklog },
    { path: hp, expectedHash: textH == null ? null : sha256(textH), newText: parts.newHistory },
  ]);
  auditLog(ws, { kind: 'ledger', op: 'archive-move', cr, actor: identity(ws), before: { inBacklog: true }, after: { inBacklog: false, inHistory: true, finalStatus: flags['final-status'] } });
  ok({ op: 'archive-move', cr, finalStatus: flags['final-status'], backlog: bp, history: hp });
}

function cmdAttempt(ws, cr, gates, flags) {
  if (!flags.loop) fail('BAD_ARGS', 'attempt 需要 --loop <review ref>（如 review-code / write-test-report）');
  const r = bumpAttempt(ws, cr, flags.loop, gates);
  auditLog(ws, { kind: 'attempt', cr, loop: flags.loop, current: r.current });
  ok(r);
}

/* ────────────────────────── review-record（S1，CR-2026-021 TASK-02） ──────────────────────────
 * 判断/写入分离（SDD §4.1）：agent 把评审判断写进非受控临时 payload（默认 .crctl/tmp/review-{stage}.yml，
 * 已被 .crctl/.gitignore 的 `*` 规则忽略），crctl 只做确定性部分——schema 校验 → stage→文件名显式映射
 * （tech-design→sdd.yml 非同名，与门禁读取口径对齐）→ 注入 reviewer/reviewed-at → casWrite canonical →
 * 可选级联 attempt → 删除临时 payload。
 */
const REVIEW_STAGE_FILES = { requirement: 'requirement.yml', 'tech-design': 'sdd.yml', code: 'code.yml' };
const REVIEW_STAGE_LOOPS = { requirement: 'review-requirement', 'tech-design': 'review-tech-design', code: 'review-code' };
// 前置态与各 review-* SKILL 的 Step 顺序对齐（先 review-record 落盘证据、后 advance 进评审态）：
// - requirement：评审在 drafting 执行（block 回 drafting 重审；requirement-reviewing 保留兼容重跑）
// - tech-design：write-tech-design 落盘后先进 tech-design-review-pending（其 statusGate 只需 sdd.md），再评审
// - code：评审在 developing 执行（block 回 developing 修复后重审）
// 注意：requirement/code 的评审态 statusGate 含 passCondition（需评审证据已存在），
// 若前置态错设为评审态将与 advance 门禁互锁成死锁——CR-2026-021 开发期实测缺陷（先写后推进）。
const REVIEW_STAGE_EXPECT = { requirement: ['drafting', 'requirement-reviewing'], 'tech-design': ['tech-design-review-pending'], code: ['developing'] };

function cmdReviewRecord(ws, cr, gates, flags) {
  const stage = flags.stage;
  const fileName = REVIEW_STAGE_FILES[stage];
  if (!fileName) fail('STAGE_UNKNOWN', `--stage 必须是 ${Object.keys(REVIEW_STAGE_FILES).join(' | ')}`);
  const expect = REVIEW_STAGE_EXPECT[stage];
  const state = resolveCrState(ws, cr);
  if (!expect.includes(state.status)) {
    fail('ILLEGAL_LEDGER_STATE', `review-record --stage ${stage} 仅允许在前置态 ${expect.join('/')} 执行，当前 ${state.status}`, { current: state.status, expect });
  }
  // 读取临时 payload（CRLF 归一，纪律 #1；解析失败硬失败不静默）
  const fromRel = flags.from || path.join('.crctl', 'tmp', `review-${stage}.yml`);
  const fromPath = path.isAbsolute(fromRel) ? fromRel : path.join(ws, fromRel);
  const raw = readFileChecked(fromPath);
  if (raw == null) fail('PAYLOAD_NOT_FOUND', `临时评审 payload 不存在: ${fromPath}（agent 应先把判断写到该非受控路径）`);
  const payload = parseYaml(raw.replaceAll('\r\n', '\n'));
  // schema 校验（判断是 agent 的、格式是机械的——这里只校验格式，不替 agent 判断）
  if (!payload || typeof payload !== 'object') fail('SCHEMA_INVALID', 'payload 顶层必须是映射');
  if (!['pass', 'block'].includes(payload.verdict)) fail('SCHEMA_INVALID', `verdict=${JSON.stringify(payload.verdict)} 不在枚举 [pass, block]`);
  if (!Array.isArray(payload.blockers)) fail('SCHEMA_INVALID', 'blockers 必须是列表（可空）');
  if (!payload.dimensions || typeof payload.dimensions !== 'object' || Array.isArray(payload.dimensions)) {
    fail('SCHEMA_INVALID', 'dimensions 缺失或不是映射（该 stage 门禁要求的维度必须齐全）');
  }
  // --bump-attempt：先检查未 exhausted（避免 canonical 已写而记账失败产生半状态）
  if (flags['bump-attempt']) {
    const a = readAttempts(ws, cr, REVIEW_STAGE_LOOPS[stage], gates);
    if (a.exhausted) fail('LOOP_EXHAUSTED', `${REVIEW_STAGE_LOOPS[stage]} 已达 maxAttempts=${a.max}，不得继续自修复；请人工处理剩余 blocker`, { current: a.current });
  }
  // canonical 写入（crctl 独占写：首次创建无 CAS 冲突面；已存在走 casWrite 防并发覆盖）
  const target = path.join(crDir(ws, cr), 'review-annotations', fileName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = readFileChecked(target);
  const yamlOf = (v) => (typeof v === 'string' ? `"${String(v).replaceAll('"', '\\"')}"` : JSON.stringify(v));
  const lines = [
    `cr-id: ${cr}`,
    `review-type: ${stage}`,
    `reviewer: "${identity(ws)}"`,
    `reviewed-at: "${nowIso()}"`,
    `verdict: ${payload.verdict}`,
    payload.blockers.length === 0 ? 'blockers: []' : 'blockers:',
    ...payload.blockers.map((b) => `  - ${yamlOf(b)}`),
    'dimensions:',
    ...Object.entries(payload.dimensions).map(([k, v]) => `  ${k}: ${yamlOf(v)}`),
    ...(payload.suggestions && payload.suggestions.length
      ? ['suggestions:', ...payload.suggestions.map((s) => `  - ${yamlOf(s)}`)]
      : ['suggestions: []']),
    '',
  ];
  const newText = lines.join('\n');
  if (existing == null) fs.writeFileSync(target, newText, 'utf8');
  else casWrite(target, sha256(existing), newText);
  // 级联 attempt 记账（复用既有 bumpAttempt，不重写）
  let attempt = null;
  if (flags['bump-attempt']) attempt = bumpAttempt(ws, cr, REVIEW_STAGE_LOOPS[stage], gates);
  // 删除临时 payload（避免残留误提交或跨 CR 串味）
  try { fs.rmSync(fromPath, { force: true }); } catch { /* 删除失败不阻塞主结果 */ }
  auditLog(ws, { kind: 'ledger', op: 'review-record', cr, stage, verdict: payload.verdict, actor: identity(ws), file: target });
  emitOutboxEvent(ws, {
    event_kind: 'review', cr_id: cr, actor: identity(ws),
    payload: { stage, verdict: payload.verdict, blockerCount: (payload.blockers || []).length },
  });
  ok({ op: 'review-record', cr, stage, file: target.replaceAll('\\', '/'), verdict: payload.verdict, ...(attempt ? { attempt: attempt.current } : {}) });
}
/* ────────────────────────── review-note（S2，CR-2026-021 TASK-03） ──────────────────────────
 * 向 approval.yml 的 supplemental-reviews[] 追加一条补充审查记录（CAS+审计）。
 * 安全边界（不变量 7）：只写 supplemental-reviews 段，绝不触碰 approval.yml 的
 * #requirement/#tech-design/#development-start/#code 四段审批本体（那四段只经 crctl approve）。
 * 操作者身份由 identity(ws) 生成，不接受 --by（时间戳/身份生成原则）。
 */
function cmdReviewNote(ws, cr, gates, flags) {
  if (!flags.note) fail('BAD_ARGS', 'review-note 需要 --note <text>');
  if (flags.by !== undefined) fail('BAD_ARGS', 'review-note 不接受 --by：操作者身份必须由 crctl identity(ws) 生成（与 attempt/task done 同构）');
  const state = resolveCrState(ws, cr);
  const { sm } = loadStateMachine(ws);
  const terminals = sm.terminal || [];
  if (terminals.includes(state.status)) {
    fail('ILLEGAL_LEDGER_STATE', `review-note 不允许在终态 ${state.status} 追加补充审查记录（已终结 CR 不再接受补充意见）`, { current: state.status, expect: '非终态' });
  }
  const p = path.join(crDir(ws, cr), 'approval.yml');
  const existing = readFileChecked(p);
  const stage = flags.stage || '';
  const note = flags.note.replaceAll('"', '\\"');
  const entry = [
    `  - reviewer: "${identity(ws)}"`,
    `    recorded-at: "${nowIso()}"`,
    '    decision: note',
    `    stage: "${stage.replaceAll('"', '\\"')}"`,
    `    status-at-record: ${state.status}`,
    `    notes: "${note}"`,
  ].join('\n');
  const newText = existing == null
    ? `# approval.yml — 人工审批记录（各段仅接受 crctl approve 写入；supplemental-reviews 仅接受 crctl review-note 写入）\nsupplemental-reviews:\n${entry}\n`
    : appendSupplementalReview(existing, entry);
  if (existing == null) fs.writeFileSync(p, newText, 'utf8');
  else casWrite(p, sha256(existing), newText);
  auditLog(ws, { kind: 'ledger', op: 'review-note', cr, actor: identity(ws), stage, file: p });
  emitOutboxEvent(ws, {
    event_kind: 'review-note', cr_id: cr, actor: identity(ws),
    payload: { stage, statusAtRecord: state.status },
  });
  ok({ op: 'review-note', cr, file: p.replaceAll('\\', '/'), recordedAt: nowIso() });
}

/* ────────────────────────── S3/S4/S5（CR-2026-021 TASK-04）：_backlog 白名单字段写 ──────────────────────────
 * 三个结构同构的字段级写子命令（SDD §3.1）：purpose-specific 白名单，不做通用 patch。
 * 全部 casWrite 保护单文件 _backlog.yml + matchEntryBlock 定位条目 + auditLog 审计。
 * 时间戳/操作者身份一律 crctl 生成；owner-set 的 --id 是被指派人业务身份（可调用方传入）。
 */

/** 从 keyLineIdx 行开始向后扫，返回该 YAML 段的结尾行号（下一个同级或更浅缩进的顶层键，或 EOF）。 */
function findBlockEnd(lines, keyLineIdx) {
  const keyIndent = lines[keyLineIdx].match(/^[ \t]*/)[0].length;
  for (let i = keyLineIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^[ \t]*/)[0];
    if (m.length <= keyIndent && /^[A-Za-z0-9_-]+:/.test(lines[i])) return i;
  }
  return lines.length;
}

/**
 * 在 lines（原地不改，返回新数组）中把 itemText 追加为 keyName: 块序列的最后一项。
 * key 不存在则新建（fieldIndent 为新键行缩进）；key 存在但值为空 flow `[]` 先展开为块序列。
 */
function appendToBlockSequence(lines, keyName, itemText, fieldIndent) {
  const keyRe = new RegExp('^[ \\t]*' + keyName + ':');
  const idx = lines.findIndex((l) => keyRe.test(l));
  if (idx === -1) return [...lines, `${fieldIndent}${keyName}:`, itemText];
  const out = [...lines];
  if (new RegExp('^[ \\t]*' + keyName + ':\\s*\\[\\]\\s*$').test(out[idx])) {
    out[idx] = out[idx].replace(/:\s*\[\]\s*$/, ':');
  }
  const segEnd = findBlockEnd(out, idx);
  let lastItem = -1;
  for (let i = segEnd - 1; i > idx; i--) {
    if (/^[ \t]*- /.test(out[i])) { lastItem = i; break; }
  }
  let insAt = lastItem === -1 ? idx + 1 : lastItem + 1;
  if (lastItem !== -1) {
    const itemInd = out[lastItem].match(/^[ \t]*/)[0].length;
    while (insAt < segEnd && out[insAt].match(/^[ \t]*/)[0].length > itemInd) insAt++;
  }
  out.splice(insAt, 0, itemText);
  return out;
}

/** 在块顶层 lines 中 upsert 一个标量字段 `key: "value"`：命中则原位替换，未命中则追加到块尾。返回新数组。 */
function upsertTopField(lines, indent, key, value) {
  const re = new RegExp('^[ \\t]*' + key + ':');
  const newLine = `${indent}${key}: "${value}"`;
  const hit = lines.some((l) => re.test(l));
  return hit ? lines.map((l) => (re.test(l) ? newLine : l)) : [...lines, newLine];
}

/** checkpoint-add：块内 checkpoints[] 追加 + remote-ref/last-push-at/last-push-by 更新（SDD §3.1）。 */
function editCheckpointAdd(text, cr, meta) {
  const norm = text.replaceAll('\r\n', '\n');
  const block = matchEntryBlock(norm, cr);
  if (!block) fail('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`);
  const lines = block.text.split('\n');
  const fieldIndent = ' '.repeat(block.indent + 2);
  const itemIndent = ' '.repeat(block.indent + 4);
  const subIndent = ' '.repeat(block.indent + 6);
  // 1) checkpoints[] 追加（无键则创建；空 flow [] 展开为块序列）
  const cpItem = [
    `${itemIndent}- repo: ${meta.repo}`,
    `${subIndent}sha: ${meta.sha}`,
    meta.remoteRef ? `${subIndent}remote-ref: "${meta.remoteRef}"` : null,
    `${subIndent}pushed-at: "${nowIso()}"`,
    `${subIndent}by: "${meta.by}"`,
  ].filter(Boolean).join('\n');
  let result = appendToBlockSequence(lines, 'checkpoints', cpItem, fieldIndent);
  // 2) remote-ref / last-push-at / last-push-by 更新（无则插入到条目块尾部）
  if (meta.remoteRef) result = upsertTopField(result, fieldIndent, 'remote-ref', meta.remoteRef);
  result = upsertTopField(result, fieldIndent, 'last-push-at', nowIso());
  result = upsertTopField(result, fieldIndent, 'last-push-by', meta.by);
  return norm.slice(0, block.start) + result.join('\n') + norm.slice(block.end);
}

/** owner-set：块内 owners.{role} 的 id + assigned-at 更新（crctl 生成时间戳）。 */
function editOwnerSet(text, cr, role, id) {
  const norm = text.replaceAll('\r\n', '\n');
  const block = matchEntryBlock(norm, cr);
  if (!block) fail('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`);
  const roleRe = new RegExp('^([ \\t]*)' + role + ':', 'm');
  if (!roleRe.test(block.text)) fail('OWNER_ROLE_MISSING', `${cr} 条目中缺少 owners.${role} 块，结构异常`);
  const subIndent = ' '.repeat(block.indent + 6);
  const lines = block.text.split('\n');
  const roleIdx = lines.findIndex((l) => new RegExp('^[ \\t]*' + role + ':').test(l));
  const endIdx = findBlockEnd(lines, roleIdx);
  const seg = lines.slice(roleIdx + 1, endIdx);
  const hasId = seg.some((l) => /^\s*id:/.test(l));
  const hasAt = seg.some((l) => /^\s*assigned-at:/.test(l));
  const out = [];
  for (let i = roleIdx + 1; i < endIdx; i++) {
    const l = lines[i];
    if (/^\s*id:/.test(l)) out.push(l.replace(/^(\s*)id:.*$/, `$1id: ${id}`));
    else if (/^\s*assigned-at:/.test(l)) out.push(l.replace(/^(\s*)assigned-at:.*$/, `$1assigned-at: "${nowIso()}"`));
    else out.push(l);
  }
  if (!hasId) out.unshift(`${subIndent}id: ${id}`);
  if (!hasAt) out.splice(1, 0, `${subIndent}assigned-at: "${nowIso()}"`);
  const nb = lines.slice(0, roleIdx + 1).concat(out, lines.slice(endIdx)).join('\n');
  return norm.slice(0, block.start) + nb + '\n' + norm.slice(block.end);
}

/** backlog-set：白名单标量字段 prd-path/sdd-path 替换或插入。 */
const BACKLOG_SET_FIELDS = ['prd-path', 'sdd-path'];
function editBacklogSet(text, cr, field, value) {
  const norm = text.replaceAll('\r\n', '\n');
  const block = matchEntryBlock(norm, cr);
  if (!block) fail('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`);
  const lines = block.text.split('\n');
  const fieldIndent = ' '.repeat(block.indent + 2);
  const out = upsertTopField(lines, fieldIndent, field, value);
  return norm.slice(0, block.start) + out.join('\n') + norm.slice(block.end);
}

function cmdCheckpointAdd(ws, cr, gates, flags) {
  if (!flags.repo || !flags.sha) fail('BAD_ARGS', 'checkpoint-add 需要 --repo <r> --sha <sha> [--remote-ref <ref>]');
  const state = resolveCrState(ws, cr);
  // FR-11（CR-2026-022）：LEGAL 从状态机派生全非终态（transitions from/to + wildcards 展开，排除 (new) 与 terminal），
  // 不硬编码列表——push-progress 在 drafting/task-breakdown 等阶段也会被调用，窄列表会炸 ILLEGAL_LEDGER_STATE；
  // 与 cmdOwnerSet 的 sm.terminal 判断同源，状态机增态自动覆盖。
  const { sm } = loadStateMachine(ws);
  const known = new Set();
  for (const t of sm.transitions || []) { known.add(t.from); known.add(t.to); }
  for (const list of Object.values(sm.wildcards || {})) for (const s of list) known.add(s);
  const LEGAL = [...known].filter((s) => s !== '(new)' && !(sm.terminal || []).includes(s));
  if (!LEGAL.includes(state.status)) fail('ILLEGAL_LEDGER_STATE', `checkpoint-add 仅允许在非终态执行，当前 ${state.status}`, { current: state.status, expect: LEGAL });
  const snap = loadBacklogEntry(ws, cr);
  const newText = editCheckpointAdd(snap.text, cr, { repo: flags.repo, sha: flags.sha, remoteRef: flags['remote-ref'] || null, by: identity(ws) });
  casWrite(snap.path, snap.hash, newText);
  auditLog(ws, { kind: 'ledger', op: 'checkpoint-add', cr, actor: identity(ws), repo: flags.repo, sha: flags.sha });
  ok({ op: 'checkpoint-add', cr, repo: flags.repo, sha: flags.sha, file: snap.path });
}

function cmdOwnerSet(ws, cr, gates, flags) {
  if (!flags.role || !flags.id) fail('BAD_ARGS', 'owner-set 需要 --role <requirement|development|test> --id <id>');
  if (!['requirement', 'development', 'test'].includes(flags.role)) fail('BAD_ARGS', `--role 必须是 requirement|development|test（当前 ${flags.role}）`);
  const state = resolveCrState(ws, cr);
  const { sm } = loadStateMachine(ws);
  if ((sm.terminal || []).includes(state.status)) fail('ILLEGAL_LEDGER_STATE', `owner-set 不允许在终态 ${state.status} 修改负责人`, { current: state.status, expect: '非终态' });
  const snap = loadBacklogEntry(ws, cr);
  const newText = editOwnerSet(snap.text, cr, flags.role, flags.id);
  casWrite(snap.path, snap.hash, newText);
  auditLog(ws, { kind: 'ledger', op: 'owner-set', cr, actor: identity(ws), role: flags.role, to: flags.id });
  ok({ op: 'owner-set', cr, role: flags.role, id: flags.id, file: snap.path });
}

function cmdBacklogSet(ws, cr, gates, flags) {
  if (!flags.field || flags.value === undefined) fail('BAD_ARGS', 'backlog-set 需要 --field <prd-path|sdd-path> --value <v>');
  if (!BACKLOG_SET_FIELDS.includes(flags.field)) {
    fail('FIELD_NOT_ALLOWED', `backlog-set 白名单仅允许 ${BACKLOG_SET_FIELDS.join(' | ')}；${flags.field} 属受控字段，各有专命令（status→advance、updated-at/owners→crctl 自动维护、merge-commits→merge-metadata）`, { field: flags.field, allowed: BACKLOG_SET_FIELDS });
  }
  const state = resolveCrState(ws, cr);
  const { sm } = loadStateMachine(ws);
  if ((sm.terminal || []).includes(state.status)) fail('ILLEGAL_LEDGER_STATE', `backlog-set 不允许在终态 ${state.status} 修改字段`, { current: state.status, expect: '非终态' });
  const snap = loadBacklogEntry(ws, cr);
  const newText = editBacklogSet(snap.text, cr, flags.field, flags.value);
  casWrite(snap.path, snap.hash, newText);
  auditLog(ws, { kind: 'ledger', op: 'backlog-set', cr, actor: identity(ws), field: flags.field, value: flags.value });
  ok({ op: 'backlog-set', cr, field: flags.field, value: flags.value, file: snap.path });
}

/* ────────────────────────── inbox-emit（CR-2026-021 TASK-05） ──────────────────────────
 * 专命令追加 _backlog 条目 notify-log[]（事件追加语义，比标量 set 重，不复用 backlog-set）。
 * 同时把 to 列表合并进 notify-pending（去重）。事件 payload 结构与 inbox-emit SKILL 既有
 * 消费逻辑对齐：{at, event, to, payload, handled:false}。时间戳/身份由 crctl 生成。
 */
function editInboxEmit(text, cr, meta) {
  const norm = text.replaceAll('\r\n', '\n');
  const block = matchEntryBlock(norm, cr);
  if (!block) fail('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`);
  const lines = block.text.split('\n');
  const fieldIndent = ' '.repeat(block.indent + 2);
  const itemIndent = ' '.repeat(block.indent + 4);
  const subIndent = ' '.repeat(block.indent + 6);
  const payloadJson = meta.payload ? ` ${JSON.stringify(meta.payload)}` : '';
  const logItem = [
    `${itemIndent}- at: "${nowIso()}"`,
    `${subIndent}event: ${meta.event}`,
    `${subIndent}to: ${JSON.stringify(meta.to)}`,
    `${subIndent}payload:${payloadJson || ' {}'}`,
    `${subIndent}handled: false`,
  ].join('\n');
  // notify-log 追加（无键则创建）
  const result = appendToBlockSequence(lines, 'notify-log', logItem, fieldIndent);
  // notify-pending 合并（去重；无键则创建）
  const npIdx = result.findIndex((l) => /^[ \t]*notify-pending:/.test(l));
  const npFlow = /^[ \t]*notify-pending:\s*\[[^\]]*\]\s*$/.exec(npIdx === -1 ? '' : result[npIdx]);
  if (npIdx === -1) {
    result.push(`${fieldIndent}notify-pending: ${JSON.stringify(meta.to)}`);
  } else if (npFlow) {
    let items = [];
    const inner = npFlow[0].replace(/^[ \t]*notify-pending:\s*\[/, '').replace(/\]\s*$/, '').trim();
    if (inner) {
      try { items = JSON.parse('[' + inner + ']'); } catch { fail('LEDGER_PARSE_FAILED', `notify-pending 现有内容不是合法 JSON 数组: ${inner}`); }
      if (!Array.isArray(items)) fail('LEDGER_PARSE_FAILED', `notify-pending 现有内容解析结果非数组: ${inner}`);
    }
    const merged = [...new Set([...items, ...meta.to])];
    result[npIdx] = result[npIdx].replace(/^([ \t]*)notify-pending:.*$/, `$1notify-pending: ${JSON.stringify(merged)}`);
  } else {
    // 块序列形态：解析现有元素后整段重写为 flow（crctl 独占写，无并发面）
    const npEnd = findBlockEnd(result, npIdx);
    const seg = result.slice(npIdx + 1, npEnd).map((l) => l.trim().replace(/^- /, '').replace(/^["']|["']$/g, '')).filter(Boolean);
    const merged = [...new Set([...seg, ...meta.to])];
    result.splice(npIdx, npEnd - npIdx, `${fieldIndent}notify-pending: ${JSON.stringify(merged)}`);
  }
  return norm.slice(0, block.start) + result.join('\n') + norm.slice(block.end);
}

function cmdInboxEmit(ws, cr, gates, flags) {
  if (!flags.event) fail('BAD_ARGS', 'inbox-emit 需要 --event <event> [--to <a,b>] [--payload <json>]');
  const state = resolveCrState(ws, cr);
  const { sm } = loadStateMachine(ws);
  if ((sm.terminal || []).includes(state.status)) fail('ILLEGAL_LEDGER_STATE', `inbox-emit 不允许在终态 ${state.status} 追加通知`, { current: state.status, expect: '非终态' });
  let to = [];
  if (flags.to) {
    try { to = JSON.parse(flags.to); } catch { to = String(flags.to).split(',').map((s) => s.trim()).filter(Boolean); }
    if (!Array.isArray(to)) to = [String(to)];
  }
  let payload = null;
  if (flags.payload) {
    try { payload = JSON.parse(flags.payload); } catch { fail('BAD_ARGS', `--payload 不是合法 JSON: ${flags.payload}`); }
  }
  const snap = loadBacklogEntry(ws, cr);
  const newText = editInboxEmit(snap.text, cr, { event: flags.event, to, payload });
  casWrite(snap.path, snap.hash, newText);
  auditLog(ws, { kind: 'ledger', op: 'inbox-emit', cr, actor: identity(ws), event: flags.event, to });
  emitOutboxEvent(ws, {
    event_kind: 'inbox-emit', cr_id: cr, actor: identity(ws),
    payload: { event: flags.event, to },
  });
  ok({ op: 'inbox-emit', cr, event: flags.event, to, file: snap.path });
}

/* ────────────────────────── cr-init（S8，CR-2026-021 TASK-06） ──────────────────────────
 * SDD §2.3/§4.2（SDD-BLOCK-001 修复语义）：
 * cr-init = 唯一权威原子分配：不取显式 cr-id 入参，内部读 max → 计算 → casWriteMulti 一次写
 *   cr.md(新建,expectedHash=null) + _backlog(追加) + _index(登记) → 输出返回分配到的 cr-id。
 * 并发下后到者见 _index/_backlog hash 已变 → CAS_CONFLICT，三文件全不落盘，调用方重跑拿新号。
 * 唯一并发冲突码是 CAS_CONFLICT；正常路径无 CR_ALREADY_EXISTS（无外部传入 id，无 TOCTOU）。
 */

function scanMaxCrNumber(ws, year) {
  const re = new RegExp('^CR-' + year + '-(\\d{3})$');
  let max = 0;
  for (const p of [path.join(ws, 'change-requests', '_index.yml'), backlogPath(ws)]) {
    const text = readFileChecked(p);
    if (text == null) continue;
    for (const m of text.matchAll(/^\s*- id:\s*["']?(CR-\d{4}-\d{3})["']?\s*$/gm)) {
      const mm = m[1].match(re);
      if (mm) max = Math.max(max, Number(mm[1]));
    }
  }
  return max;
}

function formatCrId(year, n) { return `CR-${year}-${String(n).padStart(3, '0')}`; }

function cmdCrInit(ws, gates, flags) {
  if (!flags.title) fail('BAD_ARGS', 'cr-init 需要 --title <t> --owner-requirement <id> [--year Y] [--summary <s>] [--source <s>] [--target-version <v>]');
  if (!flags['owner-requirement']) fail('BAD_ARGS', 'cr-init 需要 --owner-requirement <id>（被指派人业务身份）');
  const year = flags.year || String(new Date().getFullYear());
  const cr = formatCrId(year, scanMaxCrNumber(ws, year) + 1);
  const now = nowIso();
  const by = identity(ws);
  const ownerId = String(flags['owner-requirement']);
  // FR-9（CR-2026-022）：注册元信息可选旗标，缺省值与旧硬编码同义（summary="" / source=manual / target-version=tbd），向后兼容
  const yamlScalar = (v) => (/^[\w./-]+$/.test(String(v)) ? String(v) : `"${String(v).replaceAll('"', '\\"')}"`);
  const summary = flags.summary ?? '';
  const source = flags.source ?? 'manual';
  const tv = flags['target-version'] ?? 'tbd';
  // cr.md 全量 frontmatter（owners/owner-history/时间戳全 crctl 生成）
  const fm = [
    '---',
    `id: ${cr}`,
    `title: ${flags.title.replaceAll('"', '\\"')}`,
    `summary: ${yamlScalar(summary)}`,
    `owner: ${ownerId}`,
    'owners:',
    `  requirement:`,
    `    id: ${ownerId}`,
    `    assigned-at: "${now}"`,
    `  development:`,
    `    id: ${ownerId}`,
    `    assigned-at: "${now}"`,
    `  test:`,
    `    id: ${ownerId}`,
    `    assigned-at: "${now}"`,
    `target-version: ${yamlScalar(tv)}`,
    `source: ${yamlScalar(source)}`,
    'status: drafting',
    `created: "${now}"`,
    `updated: "${now}"`,
    'remote-ref: ""',
    'last-push-at: ""',
    'last-push-by: ""',
    'owner-history:',
    `  - { role: requirement, from: "", to: ${ownerId}, at: "${now}", reason: initial-assignment }`,
    `  - { role: development, from: "", to: ${ownerId}, at: "${now}", reason: initial-assignment }`,
    `  - { role: test, from: "", to: ${ownerId}, at: "${now}", reason: initial-assignment }`,
    'handover-history: []',
    '---',
    '',
  ].join('\n');
  // _backlog 条目追加
  const bp = backlogPath(ws);
  const backlogText = readFileChecked(bp);
  if (backlogText == null) fail('BACKLOG_NOT_FOUND', `缺少 ${bp}`);
  const backlogEntry = [
    `  - id: ${cr}`,
    `    title: ${flags.title.replaceAll('"', '\\"')}`,
    `    summary: ${yamlScalar(summary)}`,
    `    owner: ${ownerId}`,
    '    owners:',
    `      requirement:`,
    `        id: ${ownerId}`,
    `        assigned-at: "${now}"`,
    `      development:`,
    `        id: ${ownerId}`,
    `        assigned-at: "${now}"`,
    `      test:`,
    `        id: ${ownerId}`,
    `        assigned-at: "${now}"`,
    `    target-version: ${yamlScalar(tv)}`,
    `    source: ${yamlScalar(source)}`,
    '    prd-path: ""',
    `    created: "${now}"`,
    `    updated: "${now}"`,
  ].join('\n');
  const newBacklog = backlogText.trimEnd() + '\n' + backlogEntry + '\n';
  // _index 条目追加
  const ip = path.join(ws, 'change-requests', '_index.yml');
  const indexText = readFileChecked(ip);
  if (indexText == null) fail('INDEX_NOT_FOUND', `缺少 ${ip}`);
  const indexEntry = [
    `  - id: ${cr}`,
    `    title: ${flags.title.replaceAll('"', '\\"')}`,
    '    status: drafting',
    `    created: "${now}"`,
  ].join('\n');
  const newIndex = indexText.trimEnd() + '\n' + indexEntry + '\n';
  // 原子三文件写：cr.md 期望不存在（创建冲突即 CAS_CONFLICT）；_backlog/_index 用读时 sha256
  const crDirPath = crDir(ws, cr);
  fs.mkdirSync(crDirPath, { recursive: true });
  casWriteMulti([
    { path: path.join(crDirPath, 'cr.md'), expectedHash: null, newText: fm },
    { path: bp, expectedHash: sha256(backlogText), newText: newBacklog },
    { path: ip, expectedHash: sha256(indexText), newText: newIndex },
  ]);
  auditLog(ws, { kind: 'ledger', op: 'cr-init', cr, actor: by, title: flags.title });
  emitOutboxEvent(ws, {
    event_kind: 'cr-init', cr_id: cr, actor: by,
    payload: { title: flags.title, ownerRequirement: ownerId },
  });
  ok({ op: 'cr-init', cr, title: flags.title, status: 'drafting', files: { crMd: path.join('change-requests', cr, 'cr.md'), backlog: bp, index: ip } });
}

/* ────────────────────────── task allocate（S7，CR-2026-021 TASK-07） ──────────────────────────
 * 扩展现有 task 子命令族：CAS 保护的 TASK-ID 分配（SDD §2.3）。
 * 分配即写、不接受调用方传入编号：内部扫 tasks/_index.yml 现有 max → {cr}-TASK-{NN+1}，
 * slug 缺失回退 task-{NN}（与 writeback-tasks.mjs 的 slug 兜底风格对齐）。唯一并发冲突码 CAS_CONFLICT。
 */
function scanMaxTaskNumber(text, cr) {
  const re = new RegExp('- id:\\s*["\']?' + cr + '-TASK-(\\d+)', 'g');
  let max = 0;
  for (const m of text.matchAll(re)) max = Math.max(max, Number(m[1]));
  return max;
}

/** tasks/_index.yml 追加最小条目 {id, slug, status: pending}（title/estimate/depends-on 由 write-dev-tasks 后续填充）。 */
function appendTaskEntry(text, cr, taskId, slug) {
  const norm = text.replaceAll('\r\n', '\n');
  const lines = norm.split('\n');
  const idx = lines.findIndex((l) => /^tasks:/.test(l));
  if (idx === -1) fail('TASK_INDEX_SHAPE', 'tasks/_index.yml 缺少 tasks: 段，结构异常');
  if (lines.some((l) => new RegExp('- id:\\s*["\']?' + taskId + '["\']?\\s*$').test(l))) {
    fail('TASK_ALREADY_EXISTS', `${taskId} 已存在于 tasks/_index.yml`);
  }
  const entry = `  - id: ${taskId}\n    slug: ${slug}\n    status: pending`;
  // 定位 tasks: 段尾（下一个顶层键或 EOF）
  let tail = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^[ \t]*/)[0];
    if (m.length === 0 && /^[A-Za-z0-9_-]+:/.test(lines[i])) { tail = i; break; }
  }
  lines.splice(tail, 0, entry);
  return lines.join('\n');
}

function cmdTaskAllocate(ws, cr, gates, flags) {
  const state = resolveCrState(ws, cr);
  const LEGAL = ['task-breakdown', 'developing'];
  if (!LEGAL.includes(state.status)) fail('ILLEGAL_LEDGER_STATE', `task allocate 仅允许在前置态 ${LEGAL.join('/')} 执行，当前 ${state.status}`, { current: state.status, expect: LEGAL });
  const p = path.join(crDir(ws, cr), 'tasks', '_index.yml');
  const text = readFileChecked(p);
  if (text == null) fail('TASK_INDEX_NOT_FOUND', `缺少 ${p}（请先由 write-dev-tasks 创建 tasks/_index.yml 骨架）`);
  const n = scanMaxTaskNumber(text, cr) + 1;
  const nn = String(n).padStart(2, '0');
  const taskId = `${cr}-TASK-${nn}`;
  const slug = flags.slug || `task-${nn}`;
  const newText = appendTaskEntry(text, cr, taskId, slug);
  casWrite(p, sha256(text), newText);
  auditLog(ws, { kind: 'ledger', op: 'task-allocate', cr, actor: identity(ws), task: taskId, slug });
  ok({ op: 'task-allocate', cr, task: taskId, slug, file: p });
}

/* ────────────────────────── worktree-path / report / cr-metrics（S9/S11，CR-2026-021 TASK-08） ──────────────────────────
 * 两个只读子命令（SDD §3.2）：不写任何文件、无 CAS。
 * - worktree-path <cr> --repo <r>：唯一权威拼接规则（从 requirement-register 等 4+ 处 SKILL prose 提炼）：
 *   bucket = role==='knowledge-base' ? 'knowledge-base' : repo.id；path = {ws}/.rayai-worktrees/{bucket}/requirement/{cr}
 * - report / cr-metrics [--period <N>d]：跨 CR 聚合（对齐 cr-dashboard Step 2 口径）——
 *   状态直方图（在途 cr.md frontmatter + _history.yml 归档 final-status，累计口径，不受 --period 影响）、
 *   周期活动计数 periodActivity（按 archived-at，仅当传 --period 时按窗口过滤，格式仅支持 <N>d 如 7d/30d，
 *   非法格式 BAD_ARGS 硬拒而非静默忽略）、SLA 阈值比较（change-requests/_config.yml#sla，缺省跳过，累计口径）。
 */

function cmdWorktreePath(ws, cr, gates, flags) {
  if (!flags.repo) fail('BAD_ARGS', 'worktree-path 需要 --repo <repo-id>');
  const bucket = flags.repo === 'knowledge-base' || flags.repo === 'ai-first-platform-docs' ? 'knowledge-base' : flags.repo;
  const p = path.join(ws, '.rayai-worktrees', bucket, 'requirement', cr);
  ok({ op: 'worktree-path', cr, repo: flags.repo, bucket, path: p });
}

/** 解析 --period（仅支持 <N>d，如 7d/30d），返回该窗口起始的日期字符串（YYYY-MM-DD）；无 period 输入返回 null。 */
function periodCutoffDay(period) {
  const m = /^(\d+)d$/.exec(String(period).trim());
  if (!m) fail('BAD_ARGS', `--period 格式不支持: ${period}（仅支持 <N>d，如 7d/30d）`);
  const cutoff = new Date(Date.now() - Number(m[1]) * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`;
}

function cmdReport(ws, gates, flags) {
  const cutoffDay = flags.period !== undefined ? periodCutoffDay(flags.period) : null;
  const statusHistogram = {};
  const active = [];
  // 在途：扫描 change-requests/*/cr.md frontmatter status
  const crDirPath = path.join(ws, 'change-requests');
  if (fs.existsSync(crDirPath)) {
    for (const name of fs.readdirSync(crDirPath)) {
      if (!/^CR-/.test(name) || name.includes('.')) continue; // CR 目录（含测试短 ID），排除 _backlog.yml 等文件
      const md = readCrMdFrontmatter(ws, name);
      if (!md || !md.status) continue;
      statusHistogram[md.status] = (statusHistogram[md.status] || 0) + 1;
      active.push({ cr: name, status: md.status, created: md.created || '' });
    }
  }
  // 归档：_history.yml final-status
  const historyText = readFileChecked(path.join(ws, 'change-requests', '_history.yml'));
  let archived = 0;
  const periodActivity = { byDay: {}, byMonth: {} };
  if (historyText) {
    const doc = parseYaml(historyText);
    const list = Array.isArray(doc) ? doc : (doc && doc.history) || [];
    for (const e of list) {
      if (!e || !e.id) continue;
      const fs_ = e['final-status'] || 'archived';
      statusHistogram[fs_] = (statusHistogram[fs_] || 0) + 1;
      if (e['archived-at']) {
        archived++;
        const d = String(e['archived-at']).slice(0, 10);
        if (cutoffDay === null || d >= cutoffDay) {
          periodActivity.byDay[d] = (periodActivity.byDay[d] || 0) + 1;
          periodActivity.byMonth[d.slice(0, 7)] = (periodActivity.byMonth[d.slice(0, 7)] || 0) + 1;
        }
      }
    }
  }
  // SLA：_config.yml#sla（缺省跳过比较）
  const configText = readFileChecked(path.join(ws, 'change-requests', '_config.yml'));
  let sla = null;
  if (configText) {
    try { sla = parseYaml(configText).sla || null; } catch { /* 结构异常跳过 SLA */ }
  }
  ok({
    op: 'report',
    total: active.length + archived,
    active: active.length,
    archived,
    statusHistogram,
    period: flags.period !== undefined ? flags.period : null,
    periodActivity,
    ...(sla ? { sla } : {}),
  });
}

function cmdCrMetrics(ws, gates, flags) {
  const period = flags.period || '7d';
  return cmdReport(ws, gates, { ...flags, period });
}

/* ────────────────────────── git commit --template（S10，CR-2026-021 TASK-09） ──────────────────────────
 * 给既有 git commit 分支加格式化模板（不是新顶层子命令）：
 *   register:        [cr] register {cr}: {subject}
 *   task-breakdown:  feat({cr}): task breakdown ({subject})
 *   writeback:       writeback({cr}): {subject}
 * cr 从 --cwd 当前分支名 requirement/{cr} 提取（提取不到则要求 subject 自带 CR 前缀）。
 * 不改变现有 -m 直传路径的白名单校验（--template 是新增可选分支）。
 */
const COMMIT_TEMPLATES = {
  // CR-2026-022 TASK-04：生成形态必须命中 controlled-shell commit 白名单（-m 前缀 wip: | [cr] | merge(）——
  // task-breakdown/writeback 原 feat()/writeback() 前缀被 FORBIDDEN_SUBCOMMAND 拒绝，统一改 [cr] 前缀（现场坐实：CR-2026-022 任务拆分 commit）
  register: (cr, subject) => `[cr] register ${cr}: ${subject}`,
  'task-breakdown': (cr, subject) => `[cr] task-breakdown ${cr}: ${subject}`,
  writeback: (cr, subject) => `[cr] writeback ${cr}: ${subject}`,
};

function resolveTemplateCr(ws, cwd, subject) {
  const r = controlledGit(ws, 'branch', ['--show-current'], cwd, 'crctl-commit-template');
  if (r.ok && r.stdout) {
    const m = r.stdout.trim().match(/requirement\/(CR-[\w-]+)/); // 兼容 CR-YYYY-NNN 与测试短 ID
    if (m) return m[1];
  }
  const sm = subject.match(/CR-\d{4}-\d{3}/);
  if (sm) return sm[0];
  fail('BAD_ARGS', 'git commit --template 无法确定 cr：--cwd 分支非 requirement/CR-* 且 subject 不含 CR 编号');
}

function applyCommitTemplate(ws, argv, flags) {
  const kind = flags.template;
  const tpl = COMMIT_TEMPLATES[kind];
  if (!tpl) fail('BAD_ARGS', `--template 必须是 ${Object.keys(COMMIT_TEMPLATES).join(' | ')}（当前 ${kind}）`);
  const mi = argv.indexOf('-m');
  if (mi === -1) fail('BAD_ARGS', 'git commit --template 需要同时提供 -m <subject>（作为模板的 subject 部分）');
  const subject = String(argv[mi + 1] || '').trim();
  if (!subject) fail('BAD_ARGS', '-m subject 为空');
  // FR-10（CR-2026-022）：--cr 显式旗标直传已知值，跳过「分支探测→subject 正则」反向解析；缺省走原兜底
  let cr;
  if (flags.cr) {
    const m = String(flags.cr).match(/^CR-\d{4}-\d{3}$/);
    if (!m) fail('BAD_ARGS', `--cr 必须是 CR-YYYY-NNN 格式（当前 ${flags.cr}）`);
    const crp = path.join(ws, 'change-requests', String(flags.cr));
    if (!fs.existsSync(crp)) fail('BAD_ARGS', `--cr ${flags.cr} 在 change-requests/ 下不存在`);
    cr = String(flags.cr);
  } else {
    cr = resolveTemplateCr(ws, flags.cwd ? path.resolve(flags.cwd) : ws, subject);
  }
  argv[mi + 1] = tpl(cr, subject);
  return argv;
}

/** 行级追加 supplemental-reviews 段条目（硬失败：无该段则创建，段结构异常则报错）。 */
function appendSupplementalReview(text, entry) {
  const norm = text.replaceAll('\r\n', '\n');
  const lines = norm.split('\n');
  const idx = lines.findIndex((l) => /^supplemental-reviews:/.test(l));
  if (idx === -1) {
    const tail = norm.trimEnd();
    return tail + '\n' + (tail.endsWith(':') ? '' : 'supplemental-reviews:\n') + entry + '\n';
  }
  const keyIndent = lines[idx].match(/^[ \t]*/)[0].length;
  const segEnd = findBlockEnd(lines, idx);
  const seg = lines.slice(idx + 1, segEnd);
  // 段结构检查只针对列表项层级（缩进 ≤ 键缩进+2 的非空行）：子字段行（更深缩进）不算异常
  const badLine = seg.find((l) => {
    const ind = l.match(/^[ \t]*/)[0].length;
    return ind > 0 && ind <= keyIndent + 2 && /^\S/.test(l.trimStart()) && !/^-/.test(l.trimStart());
  });
  if (badLine) fail('APPROVAL_SHAPE', `supplemental-reviews 段包含非列表行（${badLine.trim()}），结构异常，拒绝追加`);
  lines.splice(segEnd, 0, entry);
  return lines.join('\n');
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

/* ────────────────────────── migrate-backlog（CR-2026-018 FR-5） ──────────────────────────
 * 一次性迁移命令：_backlog.yml 从 v1（含 status/updated-at）升为 v2（注册索引）。
 * 预检逐条目比对 backlog status 与 cr.md status，不一致则硬失败不写文件（纪律#1）。
 * 幂等：v2 + 无 status 行时输出 already-migrated，退出码 0。
 */

function cmdMigrateBacklog(ws, gates, flags) {
  const p = backlogPath(ws);
  const text = readFileChecked(p);
  if (!text) fail('BACKLOG_NOT_FOUND', `缺少 ${p}`);
  const hash = sha256(text);
  const doc = parseYaml(text);
  const list = Array.isArray(doc) ? doc : doc['change-requests'] || doc.backlog || doc.items || [];
  const schemaVer = (doc && !Array.isArray(doc) && doc.schema) || '';
  const isV2 = schemaVer === 'cr-backlog/v2';

  // 幂等检查：v2 且所有条目无 status/updated-at
  if (isV2) {
    const hasLegacy = list.some((e) => e && (e.status !== undefined || e['updated-at'] !== undefined));
    if (!hasLegacy) {
      ok({ migrated: false, reason: 'already-migrated', entries: list.length });
      return;
    }
  }

  // 预检：逐条目比对 backlog status 与 cr.md status
  const diffs = [];
  const toMigrate = [];
  for (const e of list) {
    if (!e || !e.id) continue;
    if (e.status === undefined && e['updated-at'] === undefined) continue; // 已迁移
    const md = readCrMdFrontmatter(ws, e.id);
    if (!md || !md.status) {
      diffs.push({ id: e.id, backlogStatus: e.status, crMdStatus: null, why: 'cr.md 缺失或无 status' });
      continue;
    }
    if (e.status !== undefined && e.status !== md.status) {
      diffs.push({ id: e.id, backlogStatus: e.status, crMdStatus: md.status, why: 'backlog 与 cr.md status 不一致' });
      continue;
    }
    toMigrate.push(e.id);
  }
  if (diffs.length) {
    fail('MIGRATE_STATUS_MISMATCH', `迁移预检发现 ${diffs.length} 个条目 backlog 与 cr.md 状态不一致，拒绝写入`, { diffs });
  }
  if (!toMigrate.length) {
    ok({ migrated: false, reason: 'already-migrated', entries: list.length });
    return;
  }

  // 行级定点删除各条目 status:/updated-at: 行
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const removed = [];
  for (const crId of toMigrate) {
    let entryStart = -1, entryIndent = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)-\s+id:\s*["']?([^"'\s]+)["']?\s*$/);
      if (m && m[2] === crId) { entryStart = i; entryIndent = m[1].length; break; }
    }
    if (entryStart < 0) continue;
    let entryEnd = lines.length;
    for (let i = entryStart + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)-\s+id:\s*/);
      if (m && m[1].length <= entryIndent) { entryEnd = i; break; }
    }
    // 从尾到头删，避免行号偏移
    for (let i = entryEnd - 1; i >= entryStart; i--) {
      if (/^\s*status:\s*/.test(lines[i]) || /^\s*updated-at:\s*/.test(lines[i])) {
        removed.push(lines[i].trim());
        lines.splice(i, 1);
      }
    }
  }

  // 顶层 schema 升 v2
  let finalText = lines.join(eol);
  if (!isV2) {
    if (/^schema:\s*.+$/m.test(finalText)) {
      finalText = finalText.replace(/^schema:\s*.+$/m, 'schema: cr-backlog/v2');
    } else {
      finalText = 'schema: cr-backlog/v2\n' + finalText;
    }
  }

  casWrite(p, hash, finalText);

  // 迁移报告（gitignored）
  const reportDir = path.join(ws, '.crctl');
  fs.mkdirSync(reportDir, { recursive: true });
  const gi = path.join(reportDir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  const report = {
    'migrated-at': nowIso(),
    entries: toMigrate.map((id) => ({ id, 'status-at-migration': 'consistent', consistent: true })),
    'removed-lines': removed.length,
    schema: 'cr-backlog/v1 -> cr-backlog/v2',
  };
  fs.writeFileSync(path.join(reportDir, 'migrate-backlog-report.yml'),
    Object.entries(report).map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((e) => `  - { id: ${e.id}, status-at-migration: ${e['status-at-migration']}, consistent: ${e.consistent} }`).join('\n')}`;
      return `${k}: ${v}`;
    }).join('\n') + '\n', 'utf8');

  auditLog(ws, { kind: 'migrate-backlog', entries: toMigrate.length, removedLines: removed.length, by: identity(ws) });

  // standalone commit
  const msg = `[cr] migrate backlog to v2: ${toMigrate.length} entries, status->cr.md`;
  if (flags.embedded || flags['no-commit']) {
    ok({ migrated: true, entries: toMigrate.length, removedLines: removed.length, commit: 'embedded：由调用方在同一事务中提交' });
  } else {
    const addR = controlledGit(ws, 'add', ['change-requests/_backlog.yml'], ws, 'crctl-migrate');
    const commitR = addR.ok ? controlledGit(ws, 'commit', ['-m', msg], ws, 'crctl-migrate') : addR;
    ok({ migrated: true, entries: toMigrate.length, removedLines: removed.length, commit: commitR.ok ? { message: msg } : { failed: true, detail: commitR } });
    if (commitR && !commitR.ok) process.exit(1);
  }
}

function cmdNext(ws, cr, gates, flags) {
  const state = resolveCrState(ws, cr);
  const status = state.status;
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
      // FR-21（CR-2026-022）：改查 writeback-traceability 的产物 specs/{spec_id}/traceability.yml——
      // change-requests/{cr}/traceability.yml 是 developing 期工作稿、恒存在，误判"可归档"；
      // spec_id 不落账本（--spec-id 为调用方旗标参数），从 specs/ 目录文件系统推断：唯一子目录取其名，多目录/无目录显式报错不猜。
      const specsDir = path.join(ws, 'specs');
      const subs = fs.existsSync(specsDir) ? fs.readdirSync(specsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
      if (subs.length !== 1) return suggest('writeback-prd-sdd', `specs/ 子目录数=${subs.length}，无法唯一确定 spec_id，先完成 PRD/SDD 回写`);
      const trace = fs.existsSync(path.join(specsDir, subs[0], 'traceability.yml'));
      return suggest(trace ? 'cr-archive' : 'writeback-tasks → writeback-traceability', trace ? `追溯链已生成（specs/${subs[0]}/traceability.yml），可归档` : '先完成任务与追溯链回写');
    }
    default:
      return suggest(null, `状态 ${status} 为终态或未覆盖，无自动建议`);
  }
}

function cmdGit(ws, argv, flags) {
  const sub = argv[0];
  if (!sub) fail('BAD_ARGS', 'git 需要子命令，如 crctl git status --short --cwd <path>');
  let args = argv.slice(1);
  // S10（CR-2026-021 TASK-09）：git commit --template <kind> 生成规范 message（可选分支，不影响 -m 直传白名单校验）
  if (sub === 'commit' && flags.template) args = applyCommitTemplate(ws, args, flags);
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
  crctl advance <cr_id> --to <s> --trigger <t>   校验转换+门禁后写入 cr.md 并 commit
                        [--expect <cur>] [--embedded] [--spec-id <id>]
  crctl approve <cr_id> --stage <requirement|tech-design|dev-start|code>
                        [--approver <id>] [--spec-id <id>]   仅限交互式终端（人类在环）
  crctl validate <file>                          受控产物 schema 校验（validate-doc 代码化）
  crctl attempt <cr_id> --loop <ref>             review-loop 轮次唯一记账点；超限返回 LOOP_EXHAUSTED
  crctl review-record <cr_id> --stage <requirement|tech-design|code> --from <payload.yml> [--bump-attempt]
                                                schema 校验临时 payload 后写入 review-annotations（tech-design→sdd.yml）
  crctl review-note  <cr_id> [--stage <s>] --note <text>  approval.yml supplemental-reviews[] 追加（不接受 --by，身份 crctl 生成）
  crctl checkpoint-add <cr_id> --repo <r> --sha <sha> [--remote-ref <ref>]   _backlog checkpoints[] 追加 + 推送元数据（developing~writing-back）
  crctl owner-set     <cr_id> --role <requirement|development|test> --id <id>   _backlog owners.{role} 指派（非终态）
  crctl backlog-set   <cr_id> --field <prd-path|sdd-path> --value <v>    _backlog 白名单标量字段（硬拒 status 等受控字段）
  crctl inbox-emit   <cr_id> --event <e> [--to <a,b>] [--payload <json>]   _backlog notify-log 事件追加 + notify-pending 合并（非终态）
  crctl cr-init     --title <t> --owner-requirement <id> [--year Y] [--summary <s>] [--source <s>] [--target-version <v>]   权威原子分配：内部 max+1 + 三文件 casWriteMulti 建档登记（注册元信息一次写齐）
  crctl worktree-path <cr_id> --repo <r>       派生 worktree bucket/path（只读，唯一权威拼接规则）
  crctl report | crctl cr-metrics [--period <N>d]   跨 CR 聚合：状态直方图/SLA（累计口径）+ periodActivity（受 --period 窗口过滤，如 7d/30d；不传则不过滤，只读）
  crctl test    <cr_id> --cmd "<c>" [--cmd ...]  代执行验证命令，生成 test-report.md 骨架
                        [--cwd <p>] [--timeout <sec>]
  crctl next    <cr_id>                          输出下一个该跑的节点（blocker 未清空绝不给 human_approval）
  crctl migrate-backlog                          _backlog.yml v1->v2 迁移（撤出 status/updated-at，升 schema）
  crctl git     <sub> [args...] [--cwd <p>] [--caller <skill>]   controlled-shell 白名单执行
                （git commit 可加 --template <register|task-breakdown|writeback> [--cr <CR-ID>] 生成规范 message；--cr 显式直传，缺省走分支/subject 反向解析）
  crctl task done <cr_id> --task <task_id>      tasks/_index.yml 标 done（developing 态，CAS+审计）
  crctl task allocate <cr_id> [--slug <s>]   tasks/_index.yml CAS 分配 TASK-ID（task-breakdown/developing 态）
  crctl merge-metadata <cr_id> --repo <r> --trunk <t> --sha <sha>
                                                _backlog.yml merge-commits[] 追加（merging/writing-back 态）
  crctl archive-move <cr_id> --final-status <s> [--archive-reason <r>] [--spec-id <id>]
                                                backlog→history 原子移动（archived 态，双文件 CAS）


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
  const CRCTL_FLAGS = ['--cwd', '--caller', '--workspace', '--template', '--cr']; // --template/--cr 是 crctl 的 commit 模板旗标（FR-10），不透传给 git
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
    case 'review-record': return cmdReviewRecord(ws, requireCr(positional), gates, flags);
    case 'review-note': return cmdReviewNote(ws, requireCr(positional), gates, flags);
    case 'checkpoint-add': return cmdCheckpointAdd(ws, requireCr(positional), gates, flags);
    case 'owner-set': return cmdOwnerSet(ws, requireCr(positional), gates, flags);
    case 'backlog-set': return cmdBacklogSet(ws, requireCr(positional), gates, flags);
    case 'inbox-emit': return cmdInboxEmit(ws, requireCr(positional), gates, flags);
    case 'cr-init': return cmdCrInit(ws, gates, flags);
    case 'worktree-path': return cmdWorktreePath(ws, requireCr(positional), gates, flags);
    case 'report': return cmdReport(ws, gates, flags);
    case 'cr-metrics': return cmdCrMetrics(ws, gates, flags);
    case 'task': {
      if (positional[0] === 'done') return cmdTaskDone(ws, requireCr(positional.slice(1)), gates, flags);
      if (positional[0] === 'allocate') return cmdTaskAllocate(ws, requireCr(positional.slice(1)), gates, flags);
      fail('BAD_ARGS', 'task 仅支持子命令 done/allocate：crctl task done <CR-ID> --task <TASK-ID> | crctl task allocate <CR-ID> [--slug <s>]');
    }
    case 'merge-metadata': return cmdMergeMetadata(ws, requireCr(positional), gates, flags);
    case 'archive-move': return cmdArchiveMove(ws, requireCr(positional), gates, flags);

    case 'test': return cmdTest(ws, requireCr(positional), gates, flags);
    case 'next': return cmdNext(ws, requireCr(positional), gates, flags);
    case 'migrate-backlog': return cmdMigrateBacklog(ws, gates, flags);
    case 'git': return cmdGit(ws, positional, flags);
    default: fail('BAD_ARGS', `未知子命令 ${cmd}。运行 crctl help 查看用法`);
  }
}

function requireCr(positional) {
  if (!positional[0]) fail('BAD_ARGS', '缺少 <cr_id> 参数');
  return positional[0];
}

main();

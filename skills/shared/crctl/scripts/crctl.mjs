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

// CR-2026-027 代码评审回修（b4）：reviewed-at 时间戳统一解析为 epoch 毫秒后再比较。
// ISO 字符串字典序比较在跨时区偏移时会产生错误先后判定（如 +08:00 vs Z）；
// Date.parse 归一到 UTC epoch，与偏移无关。非法/缺失时间戳硬失败（fail-fast，不静默降级）。
function reviewedAtEpoch(s, field) {
  const ms = Date.parse(String(s == null ? '' : s));
  if (!Number.isFinite(ms)) fail('BAD_TIMESTAMP', `${field} 时间戳非法（无法解析为 epoch）: ${JSON.stringify(s)}`);
  return ms;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// CR-2026-030 TASK-02：最小标量转义（原 cmdCrInit 局部定义提升为文件内通用 helper，供注册/移交共用）
function yamlScalar(v) {
  return /^[\w./-]+$/.test(String(v)) ? String(v) : `"${String(v).replaceAll('"', '\\"')}"`;
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
  // `$comment` 为声明内元注释（非证据文件路径），不参与 digest（CR-2026-027 代码评审回修 b9）
  const rels = Object.entries(stageCfg.evidence).filter(([k]) => k !== '$comment').map(([, rel]) => rel.replaceAll('{cr}', cr)).sort();
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
    else if (c === '"' && !inS && !isEscaped(line, i)) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function isEscaped(text, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
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
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1).replace(/\\(.)/g, '$1'); }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
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

// Dynamic YAML strings use JSON's quoted-string form, which is valid YAML and
// safely escapes quotes, backslashes, control characters, and line breaks.
function yamlStringScalar(value) {
  return JSON.stringify(String(value));
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

/* ────────────────────────── Tools Root 唯一解析（CR-2026-028 FR-1/FR-3） ──────────────────────────
 * 权威声明：{InstWS}/dir-graph.yaml#workspace.tools_package_path。无任何回退（不做 ws/tools、cwd、PACKAGE_ROOT）。
 * 仅缓存成功值；失败由 fail() 直接结束进程，不缓存失败（进程内无第二次调用）。
 * 四标志只证明“这是一个 tools 包”，不校验内容/branch/SHA（FR-3）；目标文件由各 loader 按需校验。
 */
let toolsRootCache; // undefined=未解析, string=成功

const TOOLS_ROOT_MARKERS = [
  'AGENTS.md',
  'dir-graph.yaml',
  'skills/_index.yml',
  'skills/shared/crctl/scripts/crctl.mjs',
];

function resolveToolsRoot(opWs) {
  if (toolsRootCache) return toolsRootCache;
  const inst = deriveInstallRoot(opWs);
  const cfgPath = path.join(inst, 'dir-graph.yaml');
  const text = readFileChecked(cfgPath);
  if (!text) fail('TOOLS_PACKAGE_NOT_FOUND', `缺少 ${cfgPath}，无法解析 workspace.tools_package_path`,
    { instRoot: inst, field: 'workspace.tools_package_path', reason: 'dir-graph-missing' });
  const doc = parseYaml(text);
  const v = getPath(doc, 'workspace.tools_package_path');
  if (typeof v !== 'string' || v.trim() === '') {
    fail('TOOLS_PACKAGE_NOT_FOUND', 'workspace.tools_package_path 缺失、非字符串或为空',
      { instRoot: inst, field: 'workspace.tools_package_path', reason: 'missing-or-invalid' });
  }
  const raw = path.isAbsolute(v) ? v : path.resolve(inst, v);
  let real;
  try { real = fs.realpathSync(raw); }
  catch { fail('TOOLS_PACKAGE_NOT_FOUND', `tools 包路径不存在: ${raw}`,
    { instRoot: inst, field: 'workspace.tools_package_path', reason: 'path-not-exists', resolved: raw }); }
  const missing = TOOLS_ROOT_MARKERS.filter((rel) => !fs.existsSync(path.join(real, rel)));
  if (missing.length) {
    fail('TOOLS_PACKAGE_NOT_FOUND', `tools 包缺少身份标志: ${missing.join(', ')}`,
      { instRoot: inst, field: 'workspace.tools_package_path', reason: 'identity-marker-missing', missing });
  }
  toolsRootCache = real;
  return real;
}

function loadStateMachine(ws) {
  // 权威：Tools Root 的 dir-graph.yaml（CR-2026-028 FR-4）。无 workspace/tools、PACKAGE_ROOT 回退。
  const p = path.join(resolveToolsRoot(ws), 'dir-graph.yaml');
  const text = readFileChecked(p);
  if (text) {
    const doc = parseYaml(text);
    const sm = getPath(doc, 'change-request-track.state_machine');
    if (sm && sm.transitions) return { sm, source: p };
  }
  fail('STATE_MACHINE_NOT_FOUND', `缺少 ${p} 中的 change-request-track.state_machine`);
}

function loadGates(ws) {
  // 权威：Tools Root 的 gates.json（CR-2026-028 FR-4）。
  const p = path.join(resolveToolsRoot(ws), 'skills', 'shared', 'crctl', 'gates.json');
  const text = readFileChecked(p);
  if (!text) fail('GATES_NOT_FOUND', `缺少 ${p}`);
  return JSON.parse(text);
}

function loadPipeline(ws, id) {
  // 权威：Tools Root 的 pipeline-templates（CR-2026-028 FR-4）。无 ws/tools 候选回退。
  const p = path.join(resolveToolsRoot(ws), 'pipeline-templates', `${id}.pipeline.json`);
  const text = readFileChecked(p);
  if (!text) fail('PIPELINE_NOT_FOUND', `找不到 pipeline 模板 ${id}.pipeline.json（期望 ${p}）`);
  return { doc: JSON.parse(text), source: p };
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
 * 单一事实源：{toolsRoot}/skills/shared/controlled-shell/rules.json（CR-2026-002 TASK-01；来源改 Tools Root，CR-2026-028 FR-4）。
 * CRCTL_RULES_PATH 显式覆盖时优先（唯一覆盖入口）。
 * rules.json 缺失/损坏时返回 SHELL_UNAVAILABLE，不静默放行。
 */

const RULES_PATH = process.env.CRCTL_RULES_PATH; // undefined=未设置 → 从 Tools Root 派生

let _shellRules; // undefined=未加载, null=加载失败, object=已加载
function loadShellRules(ws) {
  if (_shellRules !== undefined) return _shellRules;
  const rulesPath = RULES_PATH || path.join(resolveToolsRoot(ws), 'skills', 'shared', 'controlled-shell', 'rules.json');
  try {
    const j = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
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

function controlledGit(ws, sub, args, cwd, caller, options = {}) {
  const joined = args.join(' ');
  const record = { kind: 'git', caller: caller || null, sub, args: joined, cwd };
  // CR-2026-030 TASK-03（SDD §3.6）：options.audit=false 只用于 owner-set 的纯只读 clean 查询——
  // dirty 拒绝与同值幂等路径必须零审计副作用；白名单/forbidden flags/fail-closed 仍全部执行。
  const audit = options.audit !== false;
  const rules = loadShellRules(ws);
  if (!rules) {
    if (audit) auditLog(ws, { ...record, result: 'SHELL_UNAVAILABLE' });
    return { ok: false, code: 'SHELL_UNAVAILABLE', message: `controlled-shell 规则文件缺失或损坏，拒绝执行任何 git` };
  }
  const patterns = rules.whitelist[sub];
  for (const a of args) {
    if (rules.forbiddenFlags.includes(a) || rules.forbiddenFlags.some((f) => a.startsWith(f + '='))) {
      if (audit) auditLog(ws, { ...record, result: 'FORBIDDEN_FLAG' });
      return { ok: false, code: 'FORBIDDEN_SUBCOMMAND', message: `参数 ${a} 属于配置注入类，禁止透传` };
    }
  }
  if (!patterns) {
    if (audit) auditLog(ws, { ...record, result: 'FORBIDDEN_SUBCOMMAND' });
    return { ok: false, code: 'FORBIDDEN_SUBCOMMAND', message: `git ${sub} 不在 controlled-shell 白名单中` };
  }
  if (!patterns.some((re) => re.test(joined))) {
    if (audit) auditLog(ws, { ...record, result: 'FORBIDDEN_FORM' });
    return { ok: false, code: 'FORBIDDEN_SUBCOMMAND', message: `git ${sub} ${joined} 不匹配白名单允许的任何形态` };
  }
  const r = spawnSync('git', [sub, ...args], { cwd: cwd || ws, encoding: 'utf8', shell: false, env: { ...process.env, GIT_EDITOR: 'true', EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' } });
  const out = { ok: r.status === 0, exit: r.status, stdout: (r.stdout || '').slice(0, 20000), stderr: (r.stderr || '').slice(0, 20000) };
  if (audit) auditLog(ws, { ...record, result: out.ok ? 'ok' : `exit=${r.status}` });
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

function parseEvidenceText(p, text) {
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

function readEvidenceDoc(ws, cr, rel, overrides) {
  // 候选证据 override（CR-2026-027 FR-8/TASK-03）：overrides 的 key 用含 {cr} 占位符的规范相对路径，
  // 匹配发生在路径展开前（调用方与读取方统一占位符形态）；命中时用内存文本走同一解析路径，不落盘。
  if (overrides && overrides[rel]) return parseEvidenceText(path.join(ws, rel.replaceAll('{cr}', cr)), overrides[rel].text);
  const p = path.join(ws, rel.replaceAll('{cr}', cr));
  const text = readFileChecked(p);
  if (text == null) return { path: p, exists: false, data: null };
  return parseEvidenceText(p, text);
}

// CR-2026-025 项③（FR-11，D-7：常量不做配置）：isEmpty 数组失败逐项截断。
// 只封单条长度、不封条数；非字符串项原样保留，数组类型不变（FR-13/NFR-3）。
const ITEM_MAX = 120;
function briefArray(v) {
  return v.map((x) => (typeof x === 'string' && x.length > ITEM_MAX)
    ? x.slice(0, ITEM_MAX) + `…(+${x.length - ITEM_MAX}字)` : x);
}

function evaluatePassCondition(ws, cr, stageCfg, gates, evidence) {
  // stageCfg: { passCondition: {pipeline, nodeRef}, evidence: {"$default": rel, "test-report": rel} }
  // evidence: 候选证据 override（CR-2026-027 FR-8），透传给 readEvidenceDoc；缺省为磁盘读。
  const results = [];
  const { pipeline, nodeRef } = stageCfg.passCondition;
  const { doc: pl, source } = loadPipeline(ws, pipeline);
  const node = (pl.nodes || []).find((n) => n.ref === nodeRef && n.reviewLoop);
  if (!node) return { pass: false, results: [{ ok: false, why: `pipeline ${pipeline} 中找不到含 reviewLoop 的节点 ref=${nodeRef}` }], source };
  const conds = getPath(node, 'reviewLoop.passCondition.allOf') || [];
  const docsCache = {};
  const getDoc = (key) => {
    if (!(key in docsCache)) docsCache[key] = readEvidenceDoc(ws, cr, stageCfg.evidence[key], evidence);
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

// CR-2026-027 FR-9/TASK-04：archived 目标态任务完成门禁五步判定（SDD §4.1，D-8）。
// 缺文件/空数组/pending 均不得被解释为 no-task：正常归档必须存在非空 task index 且全部 done，
// 全部 done 后再校验 delivery/task/_index.yaml。rejected/withdrawn 属提前终止，不走本门禁（gates.json 不挂载）。
function checkDeliveryIndexComplete(ws, cr) {
  const tasksIdx = readEvidenceDoc(ws, cr, 'change-requests/{cr}/tasks/_index.yml');
  if (!tasksIdx.exists) return { ok: false, code: 'TASK_INDEX_MISSING', why: 'tasks/_index.yml 不存在（缺文件不得解释为 no-task）' };
  const tasks = Array.isArray(tasksIdx.data?.tasks) ? tasksIdx.data.tasks : [];
  if (tasks.length === 0) return { ok: false, code: 'TASK_LIST_EMPTY', why: 'tasks[] 为空（空数组不得解释为 no-task）' };
  const pending = tasks.filter((t) => t.status !== 'done');
  if (pending.length > 0) {
    return { ok: false, code: 'TASK_STATUS_INCOMPLETE', why: `存在未完成任务: ${pending.map((t) => t.id).filter(Boolean).join(', ')}` };
  }
  const globalPath = path.join(ws, 'delivery/task/_index.yaml');
  if (!fs.existsSync(globalPath)) return { ok: false, code: 'DELIVERY_INDEX_MISSING', why: 'delivery/task/_index.yaml 缺失（TASK 全 done 后回写索引必须存在）' };
  const globalIds = (parseYaml(fs.readFileSync(globalPath, 'utf8'))?.tasks || []).map((e) => e.id);
  const missing = tasks.map((t) => t.id).filter((id) => !globalIds.includes(id));
  return { ok: missing.length === 0, missing, code: missing.length ? 'DELIVERY_INDEX_INCOMPLETE' : undefined, why: missing.length ? `delivery/task 索引缺失 ${missing.length} 项: ${missing.join(', ')}` : null };
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
      const r = evaluatePassCondition(ws, cr, stageCfg, gates, opts.evidence);
      out.checks.push({ type: check.type, stage: check.stage, ok: r.pass, detail: r.results, pipelineSource: r.source });
    } else if (check.type === 'approval') {
      const doc = readEvidenceDoc(ws, cr, 'change-requests/{cr}/approval.yml', opts.evidence);
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
        type: check.type, ok: r.ok, code: r.code, missing: r.missing || [],
        why: r.ok ? null : (r.why || `delivery/task 索引缺失 ${(r.missing || []).length} 项: ${(r.missing || []).join(', ')}`),
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
  // BL-1（代码评审 attempt-1）：根结构形状硬失败，禁止静默降级为空集合绕过守卫——
  // 复用既有 TASK_INDEX_SHAPE 错误码（editTaskDone 同款），不新增错误码（TD-BL-3 口径）
  const idx = parseYaml(normText);
  if (!idx || typeof idx !== 'object' || Array.isArray(idx)) fail('TASK_INDEX_SHAPE', 'tasks/_index.yml 顶层必须是映射（结构异常，禁止静默降级）');
  if (!Array.isArray(idx.tasks)) fail('TASK_INDEX_SHAPE', 'tasks/_index.yml 缺少 tasks 列表（结构异常，禁止静默降级）');
  const tasks = idx.tasks;
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
  // minIndent 必须排除空行（block.text 结尾换行会产生空串，其缩进为 0，会把整块错压成 +2 缩进——CR-2026-027 TASK-07 实测）
  const minIndent = Math.min(...block.text.split('\n').filter((l) => l.trim() !== '').map((l) => (l.match(/^[ \t]*/) || [''])[0].length));
  const entry = block.text.split('\n').map((l) => '  ' + l.slice(minIndent)).join('\n');
  const reason = String(meta.archiveReason || '').replaceAll('"', '\\"');
  const enrich = [
    `    final-status: ${meta.finalStatus}`,
    `    archive-reason: "${reason}"`,
    meta.specId ? `    writeback-spec-id: ${meta.specId}` : null,
    `    archived-at: "${nowIso()}"`,
  ].filter(Boolean).join('\n');
  // CR-2026-027 FR-11/TASK-06：归档事件随 history 条目同批写入（meta.notifyLog 行数组，4 空格基准缩进）
  const notifyLog = meta.notifyLog && meta.notifyLog.length ? '\n' + meta.notifyLog.join('\n') : '';
  const record = entry + '\n' + enrich + notifyLog + '\n';
  const newHistory = (normH.trim() === '' ? 'history:' : normH.trimEnd()) + '\n' + record;
  return { newBacklog, newHistory };
}

// CR-2026-027 FR-11/TASK-06：归档事件行构造（与 editInboxEmit 同构：at/event/to/payload）。
// 收件人由 resolveArchiveRecipients 解析（owners 三角色去重 → legacy 顶层 owner → 空则硬失败）。
function buildArchiveNotifyLog(finalStatus, to, payload) {
  return [
    '    notify-log:',
    `      - at: "${nowIso()}"`,
    `        event: ${finalStatus}`,
    `        to: ${JSON.stringify(to)}`,
    `        payload: ${JSON.stringify(payload)}`,
  ];
}

// CR-2026-027 FR-11/TASK-06：收件人解析（D-10）。
function resolveArchiveRecipients(ws, cr) {
  const snap = loadBacklogEntry(ws, cr);
  const o = snap.entry.owners || {};
  const to = [...new Set([o.requirement && o.requirement.id, o.development && o.development.id, o.test && o.test.id].filter(Boolean))];
  if (to.length === 0 && snap.entry.owner) to.push(String(snap.entry.owner));
  if (to.length === 0) fail('ARCHIVE_RECIPIENTS_MISSING', `归档事件收件人为空：${cr} 缺少 owners 三角色且无顶层 owner，CAS 前拒绝归档`);
  return to;
}

// CR-2026-027 FR-11/TASK-06：_index.yml 终态字段更新（只写 status/archived-at/可选 writeback-spec-id，D-2）。
function editIndexFinalStatus(text, cr, finalStatus, specId) {
  const norm = text.replaceAll('\r\n', '\n');
  const block = matchEntryBlock(norm, cr);
  if (!block) fail('INDEX_ENTRY_NOT_FOUND', `${cr} 不在 _index.yml`);
  const fieldIndent = ' '.repeat(block.indent + 2);
  let body = block.text;
  const set = (key, val) => {
    const re = new RegExp(`^([ \\t]*)${key}:.*$`, 'm');
    return re.test(body) ? body.replace(re, `$1${key}: ${val}`) : body + `\n${fieldIndent}${key}: ${val}`;
  };
  body = set('status', finalStatus);
  body = set('archived-at', `"${nowIso()}"`);
  if (specId) body = set('writeback-spec-id', String(specId));
  return norm.slice(0, block.start) + body + norm.slice(block.end);
}



function updateCrMdStatus(ws, cr, newStatus) {
  const p = path.join(crDir(ws, cr), 'cr.md');
  const text = readFileChecked(p);
  if (text == null) return { updated: false, why: `cr.md 不存在: ${p}` };
  const hash = sha256(text);
  const next = crMdStatusText(text, newStatus);
  if (next == null) return { updated: false, why: 'cr.md 无 frontmatter' };
  casWrite(p, hash, next);
  return { updated: true, path: p };
}

// CR-2026-027 FR-8/TASK-03：cr.md 状态文本生成纯函数（status + updated-at 更新），供 approve 原子提交在内存生成候选文本。
function crMdStatusText(text, newStatus) {
  const m = matchFrontmatter(text);
  if (!m) return null;
  let fm = m.body;
  if (/^status:\s*.*$/m.test(fm)) fm = fm.replace(/^status:\s*.*$/m, `status: ${newStatus}`);
  else fm = fm + `\nstatus: ${newStatus}`;
  if (/^updated-at:\s*.*$/m.test(fm)) fm = fm.replace(/^updated-at:\s*.*$/m, `updated-at: "${nowIso()}"`);
  return text.replace(m.match, `---\n${fm}\n---`);
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

// CR-2026-027 FR-12/TASK-07：终态只读查询——从 _history.yml 找 CR 条目（仅 status/next 使用；写命令不 fallback）。
// 行级解析（兼容新旧两种缩进：archive-move 旧版 4 空格条目 + 新版 2 空格条目），不依赖 YAML 解析器对嵌套缩进的解析。
function findHistoryEntry(ws, cr) {
  const hText = readFileChecked(path.join(ws, 'change-requests', '_history.yml'));
  if (hText == null) return null;
  const lines = hText.replaceAll('\r\n', '\n').split('\n');
  // CR-2026-027 代码评审回修（b1）：先统计同 id 条目数，history 重复 CR → 硬失败，终态查询不得据二义数据判定
  const idHits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)- id:\s*["']?([^"'\s]+)["']?\s*$/);
    if (m && m[2] === cr) idHits.push(i);
  }
  if (idHits.length === 0) return null;
  if (idHits.length > 1) fail('HISTORY_DUPLICATE_ENTRY', `_history.yml 中 ${cr} 出现 ${idHits.length} 个条目，终态查询拒绝二义数据`, { count: idHits.length });
  const idLine = idHits[0];
  const indent = lines[idLine].match(/^([ \t]*)/)[0].length;
  const entry = { id: cr };
  for (let i = idLine + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    const ind = l.match(/^[ \t]*/)[0].length;
    // 同级下一条目（缩进 == indent 的 `- id:` 行）必须停止，否则后续条目字段会覆盖本 CR（b1）
    if (ind <= indent) break;
    const km = l.match(/^\s*([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (km) entry[km[1]] = km[2].replace(/^["']|["']$/g, '').trim();
  }
  return entry;
}

// CR-2026-027 FR-12/TASK-07：终态前置检测（status/next 专用）。命中 history 时：
// backlog 同存同 CR → CR_LOCATION_CONFLICT 硬失败；history 缺 final-status → 硬失败；否则返回终态条目。
function resolveTerminalForQuery(ws, cr) {
  const hist = findHistoryEntry(ws, cr);
  if (!hist) return null;
  const bText = readFileChecked(backlogPath(ws));
  if (bText != null) {
    const bDoc = parseYaml(bText);
    const bList = Array.isArray(bDoc) ? bDoc : bDoc['change-requests'] || [];
    if (bList.some((e) => e && e.id === cr)) fail('CR_LOCATION_CONFLICT', `${cr} 同时存在于 _backlog.yml 与 _history.yml，数据冲突`, { location: 'both' });
  }
  if (hist['final-status'] == null) fail('HISTORY_FINAL_STATUS_MISSING', `${cr} 在 _history.yml 中缺少 final-status，终态查询失败`);
  return hist;
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
  // CR-2026-027 FR-16/TASK-08：review cycle 兼容（SDD §2.4）——current-cycle 缺失视为 1；
  // attempt 缺 cycle 视为 cycle=1（legacy）；current-attempt 只表示当前 cycle 内轮次，attemptsWithinLimit 只查当前 cycle。
  const cycle = loop['current-cycle'] || 1;
  const attempts = loop.attempts || [];
  const cycleAttempts = attempts.filter((a) => (a && a.cycle || 1) === cycle);
  const current = cycleAttempts.length;
  return { current, max, attempts, cycle, cycleAttempts, exhausted: current >= max, data: data || {} };
}

/** review-loop.yml 全量渲染纯函数（CR-2026-025 I-1 拆分：bumpAttempt 与 review-record 共用同一渲染，
 * 使 review-record 能"先算后写"并入 casWriteMulti 同批，消除半状态，B-16）。 */
function renderLoopText(loopsMap) {
  const lines = ['# 由 crctl attempt 维护，请勿手工编辑', 'loops:'];
  for (const [k, v] of Object.entries(loopsMap)) {
    lines.push(`  ${k}:`);
    lines.push(`    current-cycle: ${v['current-cycle'] || 1}`);
    lines.push(`    current-attempt: ${v['current-attempt']}`);
    lines.push('    attempts:');
    for (const a of v.attempts) {
      const c = a && a.cycle ? `, cycle: ${a.cycle}` : '';
      lines.push(`      - { attempt: ${a.attempt}, at: "${a.at}", by: "${a.by}"${c} }`);
    }
  }
  return lines.join('\n') + '\n';
}

function bumpAttempt(ws, cr, loopRef, gates) {
  const state = readAttempts(ws, cr, loopRef, gates);
  if (state.exhausted) fail('LOOP_EXHAUSTED', `${loopRef} 已达 maxAttempts=${state.max}，不得继续自修复；请人工处理剩余 blocker`, { current: state.current });
  const next = state.current + 1;
  const p = attemptsFilePath(ws, cr);
  const all = state.data.loops ? state.data : { loops: {} };
  const prev = all.loops[loopRef] || { 'current-cycle': 1, 'current-attempt': 0, attempts: [] };
  const cycle = prev['current-cycle'] || 1;
  all.loops[loopRef] = {
    'current-cycle': cycle,
    'current-attempt': next,
    attempts: [...state.attempts, { attempt: next, at: nowIso(), by: identity(ws), cycle }],
  };
  // review-loop.yml 由 crctl 全量生成（crctl 独占该文件，无 CAS 冲突面）
  fs.writeFileSync(p, renderLoopText(all.loops), 'utf8');
  return { loop: loopRef, current: next, max: state.max, cycle, file: p };
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
  // CR-2026-027 FR-12/TASK-07：终态只读查询（history final-status 为权威；写命令不 fallback）
  const terminal = resolveTerminalForQuery(ws, cr);
  if (terminal) {
    ok({ cr, status: String(terminal['final-status']), terminal: true, source: { history: 'change-requests/_history.yml' }, legalNext: [], reviewLoops: {}, gateBlockers: {}, next: null });
    return;
  }
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

// CR-2026-030 TASK-04（SDD §4.9）：advance 内核——不打印 JSON，供 cmdAdvance 与 reject 回退共用。
// “Git 是权威”：standalone commit 失败时不得发 status outbox；只有 commit 成功（或 embedded 由调用方提交）
// 才返回 committed=true 并以真实/占位 SHA 发 outbox。返回 {committed, commitDetail, ...}。
function performAdvance(ws, cr, gates, flags) {
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
  // outbox：状态事件。--embedded/--no-commit 时 commit_sha 留空，由 push 的 checkpoint 事件补全（§A.5）；
  // standalone commit 失败不发 outbox（Git 才是权威事实，SDD §4.9）。
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
  if (flags.embedded || flags['no-commit']) {
    result.outbox = emitOutboxEvent(ws, {
      event_kind: 'status', cr_id: cr, from_status: current, to_status: flags.to,
      trigger: flags.trigger, commit_sha: pendingCommitSha(),
      actor: identity(ws), evidence: outboxEvidence,
    });
  } else if (committed) {
    result.outbox = emitOutboxEvent(ws, {
      event_kind: 'status', cr_id: cr, from_status: current, to_status: flags.to,
      trigger: flags.trigger, commit_sha: gitHeadSha(ws),
      actor: identity(ws), evidence: outboxEvidence,
    });
  }
  result.committed = !!committed;
  result.commitDetail = result.commit && result.commit.failed ? result.commit.detail : null;
  return result;
}

function cmdAdvance(ws, cr, gates, flags) {
  const result = performAdvance(ws, cr, gates, flags);
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

// CR-2026-027 FR-8/TASK-03：候选 cr.md 独立 invariant 校验。
// 现有目标态 gate（如 tech-design-reviewed）没有任何 checker 读取 cr.md，runGateChecks 只以 targetStatus 选择门禁，
// 因此候选 cr.md 的目标态一致性必须由本 helper 在 CAS 前直接断言（不假设 gate 消费 cr.md）。
function assertCandidateStatus(crMdText, expectStatus) {
  const m = matchFrontmatter(crMdText);
  if (!m) fail('CANDIDATE_STATUS_MISMATCH', '候选 cr.md 无 frontmatter');
  const fm = parseYaml(m.body) || {};
  if (fm.status !== expectStatus) {
    fail('CANDIDATE_STATUS_MISMATCH', `候选 cr.md status=${fm.status}，目标态应为 ${expectStatus}`);
  }
  return true;
}

// CR-2026-027 FR-8/TASK-03：approval 与 status 的原子提交核心（TTY 与 --grant 共用）。
// 流程：预检（调用方完成）→ 内存生成候选两文件 → runGateChecks（approval.yml evidence override）→
// assertCandidateStatus → casWriteMulti 两文件 → controlledGit add/commit 单次提交 → commit 成功后发 status outbox。
// 失败边界：gate/候选校验失败零写入；CAS 冲突两文件均不写；commit 失败两文件共同留在工作区、不发 outbox、返回结构化恢复信息。
function approveAndAdvance(ws, cr, gates, stage, stageCfg, ctx) {
  const { approver, via, evidenceHash, grant, outboxEvidence, specId, fromStatus } = ctx;
  const crMdP = path.join(crDir(ws, cr), 'cr.md');
  const approvalP = path.join(crDir(ws, cr), 'approval.yml');
  const crMdText = readFileChecked(crMdP);
  if (crMdText == null) fail('CR_MD_WRITE_FAILED', `cr.md 不存在: ${crMdP}`);
  // 1) 内存生成候选文本（零落盘）
  const approvalText = buildApprovalSectionText(approvalP, stageCfg, approver, evidenceHash, { via, grant });
  const nextCrMd = crMdStatusText(crMdText, stageCfg.to);
  if (nextCrMd == null) fail('CANDIDATE_STATUS_MISMATCH', '候选 cr.md 无 frontmatter，无法生成目标态文本');
  // 2) 按候选 approval 复核目标 gate（evidence override，approval.yml 不落盘）
  const gate = runGateChecks(ws, cr, stageCfg.to, gates, {
    specId,
    evidence: { 'change-requests/{cr}/approval.yml': { text: approvalText } },
  });
  if (!gate.pass) {
    const why = gate.checks.filter((c) => !c.ok).map((c) => c.why).filter(Boolean).join('；');
    fail('GATE_BLOCKED', `目标状态 ${stageCfg.to} 的门禁未通过，拒绝写入${why ? '：' + why : ''}`, { gate });
  }
  // 3) 候选 cr.md 独立 invariant 校验（零写入前提）
  assertCandidateStatus(nextCrMd, stageCfg.to);
  // 4) 两文件同一 CAS：全校验→全 temp→连续 rename，任一冲突整体中止
  const approvalHash = readFileChecked(approvalP) == null ? null : sha256(readFileChecked(approvalP));
  casWriteMulti([
    { path: approvalP, expectedHash: approvalHash, newText: approvalText },
    { path: crMdP, expectedHash: sha256(crMdText), newText: nextCrMd },
  ]);
  // 5) 单次 commit（approval.yml + cr.md 同批可见）
  const addR = controlledGit(ws, 'add', [`change-requests/${cr}/approval.yml`, `change-requests/${cr}/cr.md`], ws, 'crctl-approve');
  const msg = `[cr] approve ${cr} ${stage} approval+status -> ${stageCfg.to}`;
  const commitR = addR.ok ? controlledGit(ws, 'commit', ['-m', msg], ws, 'crctl-approve') : addR;
  auditLog(ws, { kind: 'approve', cr, stage, approver, via, result: 'approved', commit: commitR.ok ? msg : 'commit-failed' });
  const result = { advanced: true, op: 'approve', cr, stage, from: fromStatus, to: stageCfg.to, trigger: stageCfg.trigger, crMd: { updated: true, path: crMdP }, files: [approvalP, crMdP], commit: commitR.ok ? { message: msg } : { failed: true, detail: commitR, note: 'approval.yml 与 cr.md 已同批写入工作区；commit 失败时两文件共同保留、未发 status outbox，请修复后手工经 crctl git 提交' } };
  // 6) commit 成功后发 status outbox（git 是权威、outbox 只是投影）；commit 失败不发
  if (commitR.ok) {
    result.outbox = emitOutboxEvent(ws, {
      event_kind: 'status', cr_id: cr, from_status: fromStatus, to_status: stageCfg.to,
      trigger: stageCfg.trigger, commit_sha: gitHeadSha(ws),
      actor: identity(ws), evidence: outboxEvidence || {},
    });
  }
  ok(result);
  if (!commitR.ok) process.exit(1);
}

function cmdApprove(ws, cr, gates, flags) {
  const stage = flags.stage;
  const stageCfg = gates.approvalStages[stage];
  if (!stageCfg) fail('BAD_ARGS', `--stage 必须是 ${Object.keys(gates.approvalStages).join(' | ')}`);
  // CR-2026-027 代码评审回修（b10）：受控历史审批迁移路径（TTY 人类在环，无旁路）——
  // 证据定义变更（如 dev-start 剔除 task-index）后既有 approval 段 digest 按旧定义签发，
  // 门禁复算不一致报 EVIDENCE_DRIFT；--resign 只重算当前定义下 digest 并改写该段，保留审批本体。
  if (flags.resign !== undefined) return approveResign(ws, cr, gates, flags, stage, stageCfg);
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
      const trigger = `${rollback.approve}:reject -> ${rollback.write}`;
      // CR-2026-030 TASK-04（SDD §4.9）：TTY reject 复用 performAdvance 内核，仅 committed=true 才返回统一业务 decline
      const adv = performAdvance(ws, cr, gates, { to: rollback.to, trigger, expect: current });
      if (!adv.committed) {
        fail('ADVANCE_COMMIT_FAILED', '驳回回退提交失败，未产生权威回退事实（不发送 status outbox）', { detail: adv.commitDetail });
      }
      auditLog(ws, { kind: 'approve', cr, stage, approver, result: 'declined-rolled-back', to: rollback.to });
      fail('APPROVAL_DECLINED_ROLLED_BACK', `审批未通过，CR 已回退到 ${rollback.to}，请重跑 ${rollback.write}`, { rolledBackTo: rollback.to, rerunHint: rollback.write });
    }
    // CR-2026-027 FR-8/TASK-03：TTY 确认后走 approveAndAdvance（approval.yml + cr.md 单次原子提交），替代原分提交路径
    approveAndAdvance(ws, cr, gates, stage, stageCfg, {
      approver, via: 'crctl-approve', evidenceHash,
      outboxEvidence: collectOutboxEvidence(ws, cr, stageCfg),
      specId: flags['spec-id'], fromStatus: current,
    });
  });
}

/* ────────────────────────── 签名 grant 双模式与 reject（CR-2026-030 TASK-04，SDD §2.6/§3.7/§4.8~§4.10） ──────────────────────────
 * approve/reject 共用 v1 grant 完整验证（schema/decision → 归属 → 状态分类 → evidence digest → key/signature），
 * 合法 reject 复用 REJECT_ROLLBACK + 权威状态机 trigger 完成回退；仅权威 commit 成功后返回业务 decline。
 * approve/reject 紧邻结果态重放必须再次验签并证明结果账本已在 HEAD（assertResultLedgersCommitted）。
 */

/** 当前状态分类：fresh（审批前置态）| adjacent-approve | adjacent-reject | mismatch。 */
function classifyGrantState(current, stageCfg, rollback, decision) {
  if (decision === 'approve') {
    if (stageCfg.expect && stageCfg.expect.includes(current)) return 'fresh';
    if (current === stageCfg.to) return 'adjacent-approve';
    return 'mismatch';
  }
  if (stageCfg.expect && stageCfg.expect.includes(current)) return 'fresh';
  if (current === rollback.to) return 'adjacent-reject';
  return 'mismatch';
}

/** FR-7：approve 紧邻目标态重放的持久化字段精确比较（approval.yml 对应 section 六字段全等）。 */
function assertAdjacentApprove(ws, cr, stageCfg, grant, current) {
  const section = stageCfg.approvalSection;
  const ap = path.join(crDir(ws, cr), 'approval.yml');
  const text = readFileChecked(ap);
  const doc = text == null ? {} : (parseYaml(text) || {});
  const sec = doc[section];
  const okv = sec
    && sec.via === 'server-approve'
    && sec.approver === grant.approver
    && sec['key-id'] === grant.key_id
    && sec.signature === grant.signature
    && sec['grant-approved-at'] === grant.approved_at
    && sec['evidence-digest'] === grant.evidence_digest
    && sec['target-status'] === stageCfg.to;
  if (!okv) fail('GRANT_STATE_MISMATCH', `approval.yml#${section} 持久化字段与 grant 不一致（或缺少 server-approve 段），不能按幂等成功消费`, { current });
}

/** FR-7/AC-22：幂等重放前证明结果账本已在 HEAD——porcelain 输出中出现目标路径即 GRANT_STATE_UNCOMMITTED。
 * 无 audit 的受控只读查询，白名单与 fail-closed 仍全部执行。 */
function assertResultLedgersCommitted(ws, relPaths) {
  const r = controlledGit(ws, 'status', ['--short'], ws, 'crctl-approve', { audit: false });
  if (!r.ok) fail('GRANT_LEDGER_CHECK_FAILED', '受控 Git 只读查询失败，无法证明审批结果账本已在 HEAD', { detail: r.code || r.exit });
  const porcelain = (r.stdout || '').replaceAll('\r\n', '\n').split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
  const dirty = relPaths.filter((p) => porcelain.includes(p));
  if (dirty.length) {
    fail('GRANT_STATE_UNCOMMITTED', `审批结果账本尚未提交到 HEAD（工作区存在 staged/unstaged/untracked 目标文件），不得按幂等成功消费: ${dirty.join(', ')}`, { uncommitted: dirty });
  }
}

function approveWithGrant(ws, cr, gates, flags, stage, stageCfg) {
  // 裸 --grant（无值）= 用 daemon 投递的标准落点 .crctl/grants/{cr}-{stage}.grant.json
  const grantArg = typeof flags.grant === 'string' ? flags.grant : path.join('.crctl', 'grants', `${cr}-${stage}.grant.json`);
  const gp = path.isAbsolute(grantArg) ? grantArg : path.join(ws, grantArg);
  const text = readFileChecked(gp);
  if (text == null) fail('GRANT_UNREADABLE', `grant 文件不存在或不可读: ${gp}`);
  let grant;
  try { grant = JSON.parse(text); } catch { fail('GRANT_UNREADABLE', `grant 不是合法 JSON: ${gp}`); }
  // 1) schema v1 + decision 枚举（reject 与 approve 同构，统一在此校验）
  if (grant.v !== 1) fail('GRANT_UNSUPPORTED', `grant schema v=${grant.v}，当前仅支持 v1`);
  if (!['approve', 'reject'].includes(grant.decision)) fail('GRANT_UNSUPPORTED', `decision=${grant.decision} 不在 [approve, reject]`);
  // 2) 归属：签名绑定 cr_id+stage，禁止挪用
  if (grant.cr_id !== cr || grant.stage !== stage) {
    fail('GRANT_MISMATCH', `grant 归属 (${grant.cr_id}, ${grant.stage})，当前审批 (${cr}, ${stage}) —— 签名绑定 cr_id+stage，禁止挪用`);
  }
  // 3) 状态分类（非前置态且非合法紧邻结果态 → GRANT_STATE_MISMATCH）
  const state = resolveCrState(ws, cr);
  const current = state.status;
  const rollback = REJECT_ROLLBACK[stage];
  const cls = classifyGrantState(current, stageCfg, rollback, grant.decision);
  if (cls === 'mismatch') {
    fail('GRANT_STATE_MISMATCH', `当前状态 ${current} 既不是 ${stage} 审批前置态，也不是合法紧邻结果态，grant 不可消费`, { current, decision: grant.decision });
  }
  // 4) approve 才跑 passCondition/requireFiles；reject 跳过（blocker 是合法驳回原因，SDD §4.8）
  if (grant.decision === 'approve') {
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
  }
  // 5) 本地重算证据摘要：grant 签发的是"这一版证据"的决定，证据变了 grant 即失效（approve/reject 同校验）
  const digest = canonicalEvidenceDigest(ws, cr, stageCfg) || '';
  if (digest !== (grant.evidence_digest || '')) {
    fail('EVIDENCE_DRIFT', `grant 签发时证据摘要 ${grant.evidence_digest || '(空)'}，当前重算 ${digest || '(空)'} —— 证据在签发后被改动或缺失`);
  }
  // 6) key + Ed25519 signature
  const sig = verifyGrantSignature(ws, grant);
  if (!sig.ok) fail(sig.code, sig.why);
  // 7) 副作用 / 幂等分支
  if (grant.decision === 'approve') {
    if (cls === 'fresh') {
      // approveAndAdvance 内部已 ok() 输出成功结果并处理 commit 失败退出，这里直接返回
      approveAndAdvance(ws, cr, gates, stage, stageCfg, {
        approver: grant.approver, via: 'server-approve', evidenceHash: digest || null, grant,
        outboxEvidence: collectOutboxEvidence(ws, cr, stageCfg),
        specId: flags['spec-id'], fromStatus: current,
      });
      return;
    }
    assertAdjacentApprove(ws, cr, stageCfg, grant, current);
    assertResultLedgersCommitted(ws, [`change-requests/${cr}/approval.yml`, `change-requests/${cr}/cr.md`]);
    ok({ op: 'approve', cr, stage, changed: false, reason: 'grant-already-applied', status: current });
    return;
  }
  // reject 分支
  const trigger = `${rollback.approve}:reject -> ${rollback.write}`;
  if (cls === 'fresh') {
    const adv = performAdvance(ws, cr, gates, { to: rollback.to, trigger, expect: current });
    if (!adv.committed) {
      fail('ADVANCE_COMMIT_FAILED', '驳回回退提交失败，未产生权威回退事实（不发送 status outbox）', { detail: adv.commitDetail });
    }
    fail('APPROVAL_DECLINED_ROLLED_BACK', `审批人驳回，CR 已回退到 ${rollback.to}`, {
      decision: 'reject', stage, rolledBackTo: rollback.to, trigger, changed: true,
    });
  }
  // 紧邻回退态重放：grant/evidence/signature 已再次验证，证明 cr.md 已在 HEAD 后返回 changed=false
  assertResultLedgersCommitted(ws, [`change-requests/${cr}/cr.md`]);
  fail('APPROVAL_DECLINED_ROLLED_BACK', `驳回 grant 已在紧邻回退态消费（${rollback.to}），本次重放无副作用`, {
    decision: 'reject', stage, rolledBackTo: rollback.to, trigger, changed: false,
  });
}

// CR-2026-027 代码评审回修（b10）：受控历史审批迁移 —— `crctl approve <cr> --stage <stage> --resign <reason>`
// 场景：gates.json evidence 定义变更（如 dev-start 剔除 task-index）后，既有 approval.yml 段仍按旧证据集签发
// digest，developing 门禁复算不一致报 EVIDENCE_DRIFT（非证据内容被改动，而是证据定义变了）。
// 约束：① 仅 TTY 人类在环，无旁路（与 approve 同强度）；② 仅迁移 via=crctl-approve 的本地审批；
// server-approve 必须由服务端按新 digest 重签 grant，禁止保留旧 signature 改 digest；③ 只改写该段的 evidence-digest，
// 保留 approver/approved-at/via/target-status；④ 追加 resign 审计块（at/by/from-digest/reason）；⑤ CAS + audit + 单次 commit。
function approveResign(ws, cr, gates, flags, stage, stageCfg) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('APPROVAL_REQUIRES_HUMAN', 'crctl approve --resign 仅接受交互式终端会话（人类在环，无旁路）。模型/管道/脚本直接调用一律拒绝。');
  }
  const reason = typeof flags.resign === 'string' && flags.resign.trim() ? flags.resign.trim() : null;
  if (!reason) fail('BAD_ARGS', '--resign 需要原因说明（--resign <reason>），如 evidence-definition-change（gates.json 证据集调整）');
  const section = stageCfg.approvalSection;
  const ap = path.join(crDir(ws, cr), 'approval.yml');
  const text = readFileChecked(ap);
  if (text == null) fail('APPROVAL_NOT_FOUND', `approval.yml 不存在: ${ap}`);
  const doc = parseYaml(text);
  const sec = doc && doc[section];
  if (!sec || !sec.approver || !sec['approved-at'] || !['crctl-approve', 'server-approve'].includes(sec.via)) {
    fail('RESIGN_NO_PRIOR_APPROVAL', `approval.yml#${section} 无既有 crctl approve 审批记录，不能 --resign`);
  }
  if (sec.via === 'server-approve') {
    fail('RESIGN_SERVER_APPROVAL_UNSUPPORTED', `approval.yml#${section} 是 server-approve 签名审批；本地改写 digest 会使原签名失效，必须由服务端按新 digest 重新签发 grant`);
  }
  const oldDigest = sec['evidence-digest'] || null;
  const newDigest = canonicalEvidenceDigest(ws, cr, stageCfg);
  if (!newDigest) fail('RESIGN_DIGEST_UNAVAILABLE', '按当前 gates.json evidence 定义无法重算 digest（证据文件缺失）');
  if (newDigest === oldDigest) {
    ok({ op: 'approve-resign', cr, stage, changed: false, reason: 'digest-already-current' });
    return;
  }
  const approver = flags.approver || identity(ws);
  process.stdout.write(`\n=== crctl approve --resign · ${cr} · ${stage} ===\n`);
  process.stdout.write(`证据定义变更（gates.json）导致 evidence-digest 漂移，需受控迁移：\n  旧 digest: ${oldDigest || '(无)'}\n  新 digest: ${newDigest}\n  原因: ${reason}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`以 approver=${approver} 确认将该段 evidence-digest 迁移到当前定义？只有输入 yes 才会写入 approval.yml [yes/N] `, (answer) => {
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      auditLog(ws, { kind: 'approve-resign', cr, stage, approver, result: 'declined' });
      fail('RESIGN_DECLINED', '人工未确认，approval.yml 未变更');
    }
    // 只替换该段 evidence-digest，其余字段原样保留；追加 resign 审计块（幂等：先清旧 resign 子块）
    const next = resignApprovalSectionText(text, section, newDigest, approver, reason, oldDigest || '');
    if (next == null) fail('SCHEMA_INVALID', `approval.yml#${section} 无法唯一定位，拒绝 --resign`);
    casWrite(ap, sha256(text), next);
    auditLog(ws, { kind: 'approve-resign', cr, stage, approver, via: sec.via, result: 'resigned', from: oldDigest || '', to: newDigest, reason });
    const addR = controlledGit(ws, 'add', [`change-requests/${cr}/approval.yml`], ws, 'crctl-approve');
    const msg = `[cr] resign ${cr} ${stage} evidence-digest（${reason}）`;
    const commitR = addR.ok ? controlledGit(ws, 'commit', ['-m', msg], ws, 'crctl-approve') : addR;
    ok({ op: 'approve-resign', cr, stage, changed: true, from: oldDigest || '', to: newDigest, reason, commit: commitR.ok ? { message: msg } : { failed: true, detail: commitR } });
    if (commitR && !commitR.ok) process.exit(1);
  });
}

// CR-2026-027 代码评审回修（b10）：approve --resign 的段文本变换纯函数（供测试提取验证）——
// 只改写该段 evidence-digest 行，其余字段保留；幂等清旧 resign 子块后追加新 resign 审计块。
function resignApprovalSectionText(text, section, newDigest, approver, reason, oldDigest) {
  const normalized = text.replaceAll('\r\n', '\n');
  const sectionRe = new RegExp(`^${section}:\\n(?:[ \\t]+.*\\n?)*`, 'gm');
  const matches = [...normalized.matchAll(sectionRe)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const block = match[0];
  if ([...block.matchAll(/^  evidence-digest:.*$/gm)].length !== 1) return null;
  const base = block.replace(/\n  resign:[\s\S]*$/, '');
  const newBlock = base.replace(/^  evidence-digest:.*$/m, `  evidence-digest: ${yamlStringScalar(newDigest)}`)
    .replace(/\s*$/, '') + `\n  resign:\n    at: ${yamlStringScalar(nowIso())}\n    by: ${yamlStringScalar(approver)}\n    from-digest: ${yamlStringScalar(oldDigest)}\n    reason: ${yamlStringScalar(reason)}\n`;
  return normalized.slice(0, match.index) + newBlock + '\n' + normalized.slice(match.index + block.length);
}

function collectOutboxEvidence(ws, cr, stageCfg) {
  const out = {};
  if (stageCfg.evidence) {
    for (const [k, rel] of Object.entries(stageCfg.evidence)) {
      if (k === '$comment') continue; // 声明元注释非证据文件，跳过（b9）
      const p = path.join(ws, rel.replaceAll('{cr}', cr));
      const text = readFileChecked(p);
      if (text != null) out[rel.replaceAll('{cr}', cr)] = 'sha256:' + sha256(text.replaceAll('\r\n', '\n'));
    }
  }
  return out;
}

function writeApprovalSection(ws, cr, stage, stageCfg, approver, evidenceHash, opts = {}) {
  const p = path.join(crDir(ws, cr), 'approval.yml');
  const existing = readFileChecked(p);
  const next = buildApprovalSectionText(p, stageCfg, approver, evidenceHash, opts);
  if (existing == null) {
    fs.writeFileSync(p, next, 'utf8');
    return;
  }
  casWrite(p, sha256(existing), next);
}

// CR-2026-027 FR-8/TASK-03：approval.yml 候选文本生成（含既有文件段落合并），供 approve 原子提交在内存构造。
function buildApprovalSectionText(p, stageCfg, approver, evidenceHash, opts = {}) {
  const section = stageCfg.approvalSection;
  const existing = readFileChecked(p);
  const block = buildApprovalBlock(stageCfg, approver, evidenceHash, opts);
  if (existing == null) return `# approval.yml — 人工审批记录（各段仅接受 crctl approve 写入）\n${block}\n`;
  const re = new RegExp(`^${section}:\\n(?:[ \\t]+.*\\n?)*`, 'm');
  return re.test(existing)
    ? existing.replace(re, block + '\n')
    : existing.replace(/\s*$/, '\n') + block + '\n';
}

function buildApprovalBlock(stageCfg, approver, evidenceHash, opts = {}) {
  const section = stageCfg.approvalSection;
  const g = opts.grant || null;
  return [
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
  // CR-2026-027 FR-11/TASK-06：重复调用检测（TD-BL-3 拍板）——先查 history：
  // 同 CR 且 final-status 一致 → already-archived 幂等（零写入、不发 outbox）；不一致 → FINAL_STATUS_MISMATCH。
  const hp = path.join(ws, 'change-requests', '_history.yml');
  const hText = readFileChecked(hp);
  if (hText != null) {
    const hDoc = parseYaml(hText);
    const hList = Array.isArray(hDoc) ? hDoc : hDoc['change-requests'] || hDoc['history'] || [];
    const histEntry = hList.find((e) => e && e.id === cr);
    if (histEntry) {
      // CR-2026-027 代码评审回修（b2）：幂等前提是 CR 已移出 backlog；backlog/history 双存是数据冲突，不得静默判为幂等成功
      const bpText = readFileChecked(backlogPath(ws));
      if (bpText != null && matchEntryBlock(bpText.replaceAll('\r\n', '\n'), cr)) {
        fail('CR_LOCATION_CONFLICT', `${cr} 同时存在于 _backlog.yml 与 _history.yml，重复归档判定拒绝（数据冲突，非幂等）`, { location: 'both' });
      }
      if (String(histEntry['final-status']) === String(flags['final-status'])) {
        auditLog(ws, { kind: 'ledger', op: 'archive-move', cr, actor: identity(ws), result: 'already-archived', finalStatus: flags['final-status'] });
        ok({ op: 'archive-move', cr, result: 'already-archived', finalStatus: flags['final-status'] });
        return;
      }
      fail('FINAL_STATUS_MISMATCH', `history 中 ${cr} 的 final-status=${histEntry['final-status']}，与 --final-status ${flags['final-status']} 不一致`, { current: histEntry['final-status'], expect: flags['final-status'] });
    }
  }
  const state = resolveCrState(ws, cr);
  // CR-2026-027 FR-11/TASK-06：前置态放宽为三种终态，且 --final-status 必须与 cr.md 当前 status 完全一致（D-8）
  if (!['archived', 'rejected', 'withdrawn'].includes(state.status)) {
    fail('ILLEGAL_LEDGER_STATE', `archive-move 仅允许在终态 archived/rejected/withdrawn 执行，当前 ${state.status}。请先 crctl advance 到终态再 archive-move（状态前置强制）`, { current: state.status, expect: ['archived', 'rejected', 'withdrawn'] });
  }
  if (String(flags['final-status']) !== String(state.status)) {
    fail('FINAL_STATUS_MISMATCH', `--final-status ${flags['final-status']} 与 cr.md 当前状态 ${state.status} 不一致`, { current: state.status, expect: flags['final-status'] });
  }
  const bp = backlogPath(ws);
  const ip = path.join(ws, 'change-requests', '_index.yml');
  const textB = readFileChecked(bp);
  if (textB == null) fail('BACKLOG_NOT_FOUND', `缺少 ${bp}`);
  // 收件人解析（CAS 前，空则硬失败）
  const to = resolveArchiveRecipients(ws, cr);
  const payload = {
    'final-status': flags['final-status'],
    'archive-reason': flags['archive-reason'] || '',
    ...(flags['spec-id'] ? { 'writeback-spec-id': flags['spec-id'] } : {}),
    'archived-at': nowIso(),
  };
  const parts = editArchiveMove(textB, hText, cr, {
    finalStatus: flags['final-status'],
    archiveReason: flags['archive-reason'] || '',
    specId: flags['spec-id'] || null,
    notifyLog: buildArchiveNotifyLog(flags['final-status'], to, payload),
  });
  // _index.yml 终态更新（D-2：只写 status/archived-at/可选 writeback-spec-id，不复制 history、不删除条目）
  const textI = readFileChecked(ip);
  if (textI == null) fail('INDEX_NOT_FOUND', `缺少 ${ip}`);
  const newIndex = editIndexFinalStatus(textI, cr, flags['final-status'], flags['spec-id'] || null);
  // 三账本同一 CAS：事件与 backlog/history/index 要么同生要么同灭
  casWriteMulti([
    { path: bp, expectedHash: sha256(textB), newText: parts.newBacklog },
    { path: hp, expectedHash: hText == null ? null : sha256(hText), newText: parts.newHistory },
    { path: ip, expectedHash: sha256(textI), newText: newIndex },
  ]);
  auditLog(ws, { kind: 'ledger', op: 'archive-move', cr, actor: identity(ws), before: { inBacklog: true }, after: { inBacklog: false, inHistory: true, inIndex: true, finalStatus: flags['final-status'] } });
  // CAS 成功后发 archive outbox（git 是权威、outbox 只是投影）
  const outbox = emitOutboxEvent(ws, {
    event_kind: 'archive', cr_id: cr, from_status: state.status, to_status: flags['final-status'],
    actor: identity(ws), payload,
  });
  ok({ op: 'archive-move', cr, finalStatus: flags['final-status'], recipients: to, backlog: bp, history: hp, index: ip, outbox });
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
const REVIEW_STAGE_FILES = { requirement: 'requirement.yml', 'tech-design': 'sdd.yml', code: 'code.yml', 'dev-plan': 'dev-plan.yml' };
const REVIEW_STAGE_LOOPS = { requirement: 'review-requirement', 'tech-design': 'review-tech-design', code: 'review-code', 'dev-plan': 'review-dev-plan' };
// 前置态与各 review-* SKILL 的 Step 顺序对齐（先 review-record 落盘证据、后 advance 进评审态）：
// - requirement：评审在 drafting 执行（block 回 drafting 重审；requirement-reviewing 保留兼容重跑）
// - tech-design：write-tech-design 落盘后先进 tech-design-review-pending（其 statusGate 只需 sdd.md），再评审
// - code：评审在 developing 执行（block 回 developing 修复后重审）
// 注意：requirement/code 的评审态 statusGate 含 passCondition（需评审证据已存在），
// 若前置态错设为评审态将与 advance 门禁互锁成死锁——CR-2026-021 开发期实测缺陷（先写后推进）。
const REVIEW_STAGE_EXPECT = { requirement: ['drafting', 'requirement-reviewing'], 'tech-design': ['tech-design-review-pending'], code: ['developing'], 'dev-plan': ['task-breakdown'] };

// CR-2026-025 项④（FR-16）：三 stage 的 repair-target 映射（同一 review-record 契约，D-10 不做特判）
const REVIEW_REPAIR_TARGETS = { requirement: 'write-requirement-prd', 'tech-design': 'write-tech-design', code: 'implement-code', 'dev-plan': 'write-dev-plan' };

// CR-2026-026（FR-6/FR-6a/D-13）：dev-plan 双轨路由判定。
// 顶层 repair-target 表达分流（缺省 write-dev-plan；write-tech-design=上游设计疑点轨），不解析 blockers 字符串。
function resolveDevPlanRoute(payload) {
  if (payload.verdict === 'pass') return 'pass';
  if (payload['repair-target'] === 'write-tech-design') return 'upstream';
  return 'normal';
}

// CR-2026-027 FR-16/TASK-08：post-PASS 设计修订的新审查周期检测（SDD §3.5）。
// 条件：上一 tech-design annotation 为 PASS + 存在较新的 dev-plan upstream blocker（repair-target=write-tech-design
// 且 reviewed-at 晚于 sdd 评审）+ 当前 SDD LF digest 与上一 subject-sha256 不同；
// legacy annotation 无 digest 时以上游时间关系兜底（必须重审）。
function detectNewTechDesignCycle(ws, cr) {
  const sddAnn = readEvidenceDoc(ws, cr, 'change-requests/{cr}/review-annotations/sdd.yml');
  if (!sddAnn.exists || !sddAnn.data || sddAnn.data.verdict !== 'pass') return false;
  const dpAnn = readEvidenceDoc(ws, cr, 'change-requests/{cr}/review-annotations/dev-plan.yml');
  if (!dpAnn.exists || !dpAnn.data || dpAnn.data.verdict !== 'block' || dpAnn.data['repair-target'] !== 'write-tech-design') return false;
  // CR-2026-027 代码评审回修（b4）：epoch 比较替代 ISO 字符串字典序，跨时区偏移不再误判先后
  if (reviewedAtEpoch(dpAnn.data['reviewed-at'], 'dev-plan reviewed-at') <= reviewedAtEpoch(sddAnn.data['reviewed-at'], 'sdd reviewed-at')) return false;
  const sddRaw = readFileChecked(path.join(crDir(ws, cr), 'sdd.md'));
  if (sddRaw == null) return false;
  const curSha = sha256(sddRaw.replaceAll('\r\n', '\n'));
  if (sddAnn.data['subject-sha256'] != null && sddAnn.data['subject-sha256'] !== curSha) return true;
  return sddAnn.data['subject-sha256'] == null; // legacy 无 digest：较新 upstream blocker 已满足时间关系 → 重审
}

/** traceability reviews.<stage> 投影块渲染（2 空格基准缩进，含尾换行；FR-16 字段集，§2.4）。 */
function renderReviewsStageBlock(stage, p) {
  const L = [];
  L.push(`  ${stage}:`);
  L.push(`    reviewer: "${p.reviewer}"`);
  L.push(`    verdict: ${p.verdict}`);
  L.push(`    reviewed-at: "${p.recordedAt}"`);
  L.push(`    blocker-count: ${p.blockerCount}`);
  L.push(`    annotation: "${p.annotationRel}"`);
  if (p.repairTarget != null) L.push(`    repair-target: ${p.repairTarget}`); // suggestion-1：pass 轨顶层省略
  L.push('    review-loop:');
  L.push(`      current-cycle: ${p.currentCycle || 1}`); // CR-2026-027 代码评审回修（b3）：投影 cycle 供跨账本历史审计
  L.push(`      current-attempt: ${p.current}`);
  L.push(`      max-attempts: ${p.max}`);
  if (p.attempts.length === 0) {
    L.push('      attempts: []'); // current-attempt=0 时空历史，不伪造 attempt=1（plan v0.1.1）
  } else {
    L.push('      attempts:');
    for (const a of p.attempts) {
      L.push(`        - attempt: ${a.attempt}`);
      L.push(`          cycle: ${a.cycle || 1}`); // b3：每轮 cycle 投影（legacy 无 cycle 记 1）
      if (a['reviewed-at'] != null) L.push(`          reviewed-at: "${a['reviewed-at']}"`);
      L.push(`          result: ${a.result}`);
      L.push(`          blocker-count: ${a['blocker-count']}`);
      L.push(`          repair-target: ${a['repair-target']}`);
    }
  }
  return L.join('\n') + '\n';
}

/** traceability reviews.<stage> 行级定点编辑（FR-18，风格对齐 matchEntryBlock/editTaskDone）：
 * trace 为 null → 最小骨架；cr-id 不匹配/无顶层 reviews:/重复 stage 键 → TRACE_SHAPE；
 * 非目标行 LF 规范化后逐字节保留（AC-19 口径，TD-SUG-2）。本函数不关心轮次语义（合并规则在 cmdReviewRecord）。 */
function upsertReviewsStage(traceNorm, cr, stage, blockText) {
  if (traceNorm == null) return `cr-id: ${cr}\nreviews:\n${blockText}`;
  const lines = traceNorm.split('\n');
  // BL-3（代码评审 attempt-1）：顶层 reviews: 段必须唯一，重复时无法唯一定位，禁止静默编辑首段
  const reviewsHits = [];
  for (let i = 0; i < lines.length; i++) if (/^reviews:\s*$/.test(lines[i])) reviewsHits.push(i);
  if (reviewsHits.length === 0) fail('TRACE_SHAPE', 'traceability.yml 缺少顶层 reviews: 段，不猜位置插入顶层键');
  if (reviewsHits.length > 1) fail('TRACE_SHAPE', 'traceability.yml 出现重复顶层 reviews: 段，无法唯一定位，拒绝编辑');
  const ri = reviewsHits[0];
  let re = lines.length;
  for (let i = ri + 1; i < lines.length; i++) { if (/^\S/.test(lines[i])) { re = i; break; } }
  const stageRe = new RegExp(`^  ${stage}:\\s*$`);
  const hits = [];
  for (let i = ri + 1; i < re; i++) if (stageRe.test(lines[i])) hits.push(i);
  if (hits.length > 1) fail('TRACE_SHAPE', `reviews 段内出现多个 ${stage}: 键，不静默择一`);
  const blockLines = blockText.replace(/\n$/, '').split('\n');
  if (hits.length === 1) {
    const si = hits[0];
    let se = re;
    for (let i = si + 1; i < re; i++) { if (/^ {0,2}\S/.test(lines[i])) { se = i; break; } }
    return [...lines.slice(0, si), ...blockLines, ...lines.slice(se)].join('\n');
  }
  return [...lines.slice(0, re), ...blockLines, ...lines.slice(re)].join('\n');
}

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
  const bumpFlag = !!flags['bump-attempt'];
  // dev-plan 双轨路由（CR-2026-026，TD-BL-2）：bump 之前判定；repair-target 枚举校验（非法值 SCHEMA_INVALID 不写）；
  // upstream 轨跳过 bump（review-loop current-attempt 不递增、attempts 不追加，AC-8b）
  let bump = bumpFlag;
  let devPlanRoute = null;
  if (stage === 'dev-plan') {
    if (payload['repair-target'] != null && !['write-dev-plan', 'write-tech-design'].includes(payload['repair-target'])) {
      fail('SCHEMA_INVALID', `dev-plan payload 顶层 repair-target 不在枚举 [write-dev-plan, write-tech-design]，实际 ${JSON.stringify(payload['repair-target'])}`);
    }
    devPlanRoute = resolveDevPlanRoute(payload);
    if (devPlanRoute === 'upstream') bump = false;
  }
  const loopRef = REVIEW_STAGE_LOOPS[stage];
  const att = readAttempts(ws, cr, loopRef, gates);
  // CR-2026-027 FR-16/TASK-08：post-PASS 设计修订自动开启新 review cycle（SDD §3.5）——
  // tech-design bump 且满足 detectNewTechDesignCycle 时：current-cycle+1、本 cycle attempt 从 1 重新计；
  // 旧 attempts 仅保留（不删除），legacy 无 cycle 条目按 cycle=1 解释。
  const newCycle = stage === 'tech-design' && bumpFlag ? detectNewTechDesignCycle(ws, cr) : false;
  const nextCycleNo = newCycle ? (att.data.loops && att.data.loops[loopRef] && att.data.loops[loopRef]['current-cycle'] || 1) + 1 : null;
  if (bump && att.exhausted && !newCycle) fail('LOOP_EXHAUSTED', `${loopRef} 已达 maxAttempts=${att.max}，不得继续自修复；请人工处理剩余 blocker`, { current: att.current });
  const recordedAt = nowIso(); // 一次生成，三账本共用（FR-17）
  const reviewer = identity(ws);
  const blockerCount = payload.blockers.length;
  // 上游疑点轨的 repair-target 为 write-tech-design（覆盖映射默认，TD-BL-1：顶层字段落盘）
  const routeRepairTarget = (stage === 'dev-plan' && devPlanRoute === 'upstream') ? 'write-tech-design' : REVIEW_REPAIR_TARGETS[stage];
  // TD-BL-2 真值表（CR-2026-027 FR-13）：任意 stage pass → repairTarget=null（顶层省略）；
  // block 时按 stage 默认修复目标；dev-plan upstream 轨为 write-tech-design（覆盖映射默认）。
  const repairTarget = payload.verdict === 'pass' ? null : routeRepairTarget;

  // ── traceability：读取 + 结构校验 + attempts 历史合并（全部在任何写入之前，FR-17）──
  const tracePath = path.join(crDir(ws, cr), 'traceability.yml');
  const traceRaw = readFileChecked(tracePath);
  const traceNorm = traceRaw == null ? null : traceRaw.replaceAll('\r\n', '\n'); // 纪律 #1
  let oldAttempts = [];
  if (traceNorm != null) {
    const traceDoc = parseYaml(traceNorm);
    if (!traceDoc || typeof traceDoc !== 'object' || Array.isArray(traceDoc) || traceDoc['cr-id'] !== cr) {
      fail('TRACE_SHAPE', `traceability.yml 顶层不是映射或 cr-id 与 ${cr} 不一致，拒绝写投影`, { crId: traceDoc && traceDoc['cr-id'] });
    }
    const stageNode = traceDoc.reviews && typeof traceDoc.reviews === 'object' ? traceDoc.reviews[stage] : undefined;
    if (stageNode === undefined) {
      // TD-BL-4/BL-2：仅 undefined（键缺失）是合法首写（FR-18 定点新增），空历史起步；
      // null 与其余非映射形态一律 TRACE_SHAPE（TASK-03 明定口径，不得用宽泛空值兜底）
    } else {
      // 目标 stage 已存在：review-loop 与 attempts 必须齐全且形状合规（TD-BL-1/TD-BL-4 收紧口径，
      // 不得用宽泛空值兜底掩盖形状损坏——历史数据源唯一 = trace 现有投影，禁从 review-loop.yml/annotation 臆造）
      if (stageNode === null || typeof stageNode !== 'object' || Array.isArray(stageNode)) fail('TRACE_SHAPE', `traceability reviews.${stage} 必须是映射，实际 ${stageNode === null ? 'null' : typeof stageNode}`);
      const rl = stageNode['review-loop'];
      if (!rl || typeof rl !== 'object' || Array.isArray(rl)) fail('TRACE_SHAPE', `traceability reviews.${stage}.review-loop 缺失或不是映射`);
      const old = rl.attempts;
      if (!Array.isArray(old)) fail('TRACE_SHAPE', `traceability reviews.${stage}.review-loop.attempts 缺失或不是列表`);
      for (const e of old) {
        if (!e || typeof e !== 'object' || Array.isArray(e) || e.attempt == null || !('result' in e) || e['blocker-count'] == null || e['repair-target'] == null) {
          fail('TRACE_SHAPE', `traceability reviews.${stage} attempts 条目形状非法：${JSON.stringify(e)}`);
        }
        // CR-2026-027 代码评审回修（b3 suggestion）：cycle 若存在必须是正整数（legacy 无 cycle 记 1）
        if (e.cycle != null && (!Number.isInteger(Number(e.cycle)) || Number(e.cycle) < 1)) {
          fail('TRACE_SHAPE', `traceability reviews.${stage} attempts 条目 cycle 非法（需正整数）：${JSON.stringify(e)}`);
        }
      }
      oldAttempts = old;
    }
  }
  let mergedAttempts;
  let projCurrent;
  if (stage === 'dev-plan' && devPlanRoute === 'upstream') {
    // 上游疑点轨：attempts 不追加、current 不递增（AC-8b），仅投影当前值
    mergedAttempts = oldAttempts;
    projCurrent = att.current;
  } else if (bump) {
    const nextNo = newCycle ? 1 : att.current + 1;
    if (oldAttempts.some((e) => Number(e.attempt) === nextNo && (e.cycle || 1) === (nextCycleNo || 1))) {
      fail('TRACE_SHAPE', `traceability reviews.${stage} attempts 已含第 ${nextNo} 轮（cycle ${nextCycleNo || 1}），不得静默覆盖历史`);
    }
    mergedAttempts = [...oldAttempts, { attempt: nextNo, cycle: nextCycleNo || 1, 'reviewed-at': recordedAt, result: payload.verdict, 'blocker-count': blockerCount, 'repair-target': routeRepairTarget }];
    projCurrent = nextNo;
  } else {
    projCurrent = att.current;
    if (att.current > 0) {
      // 刷新当前轮证据：命中整条替换、未命中追加；不新增轮次
      const entry = { attempt: att.current, cycle: att.cycle, 'reviewed-at': recordedAt, result: payload.verdict, 'blocker-count': blockerCount, 'repair-target': routeRepairTarget };
      mergedAttempts = oldAttempts.some((e) => Number(e.attempt) === att.current && (e.cycle || 1) === att.cycle)
        ? oldAttempts.map((e) => (Number(e.attempt) === att.current && (e.cycle || 1) === att.cycle ? entry : e))
        : [...oldAttempts, entry];
    } else {
      mergedAttempts = []; // current-attempt=0 → 投影空历史，不伪造 attempt=1（plan v0.1.1；仅 --bump-attempt 创建首条轮次账本）
    }
  }

  // ── 构造三份新文本（同一 recordedAt），再交 casWriteMulti 统一写入（FR-17/D-11，复用 B-18 语义）──
  const target = path.join(crDir(ws, cr), 'review-annotations', fileName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = readFileChecked(target);
  const yamlOf = (v) => (typeof v === 'string' ? `"${String(v).replaceAll('"', '\\"')}"` : JSON.stringify(v));
  const lines = [
    `cr-id: ${cr}`,
    `review-type: ${stage}`,
    `reviewer: "${reviewer}"`,
    `reviewed-at: "${recordedAt}"`,
    `verdict: ${payload.verdict}`,
    ...(stage === 'dev-plan' && payload.verdict === 'block' ? [`repair-target: ${repairTarget}`] : []), // CR-2026-026：dev-plan annotation 顶层字段（TD-BL-1）；pass 轨省略（suggestion-1）
    payload.blockers.length === 0 ? 'blockers: []' : 'blockers:',
    ...payload.blockers.map((b) => `  - ${yamlOf(b)}`),
    'dimensions:',
    ...Object.entries(payload.dimensions).map(([k, v]) => `  ${k}: ${yamlOf(v)}`),
    ...(payload.suggestions && payload.suggestions.length
      ? ['suggestions:', ...payload.suggestions.map((s) => `  - ${yamlOf(s)}`)]
      : ['suggestions: []']),
  ];
  if (stage === 'requirement') {
    // 被评审内容摘要（FR-19/D-12）：LF 规范化后 SHA-256，mtime 不参与判定；供 cmdNext 回修/重审路由
    const prdPath = path.join(crDir(ws, cr), 'prd.md');
    const prdRaw = readFileChecked(prdPath);
    if (prdRaw == null) fail('SUBJECT_NOT_FOUND', `requirement review-record 需要 ${prdPath} 存在（写入 subject-sha256）`);
    lines.push(`subject-file: change-requests/${cr}/prd.md`);
    lines.push(`subject-sha256: ${sha256(prdRaw.replaceAll('\r\n', '\n'))}`);
  }
  if (stage === 'tech-design') {
    // CR-2026-027 FR-16/TASK-08：SDD subject digest（供 cmdNext tech-design freshness 判定，SDD §3.5）
    const sddPath = path.join(crDir(ws, cr), 'sdd.md');
    const sddRaw = readFileChecked(sddPath);
    if (sddRaw == null) fail('SUBJECT_NOT_FOUND', `tech-design review-record 需要 ${sddPath} 存在（写入 subject-sha256）`);
    lines.push(`subject-file: change-requests/${cr}/sdd.md`);
    lines.push(`subject-sha256: ${sha256(sddRaw.replaceAll('\r\n', '\n'))}`);
  }
  lines.push('');
  const annotationText = lines.join('\n');
  const blockText = renderReviewsStageBlock(stage, {
    reviewer, verdict: payload.verdict, recordedAt, blockerCount,
    annotationRel: `change-requests/${cr}/review-annotations/${fileName}`,
    repairTarget, current: projCurrent, currentCycle: newCycle ? att.cycle + 1 : att.cycle, max: att.max, attempts: mergedAttempts,
  });
  const newTrace = upsertReviewsStage(traceNorm, cr, stage, blockText);
  const writes = [
    { path: target, expectedHash: existing == null ? null : sha256(existing), newText: annotationText },
    { path: tracePath, expectedHash: traceRaw == null ? null : sha256(traceRaw), newText: newTrace },
  ];
  if (bump) {
    const loopPath = attemptsFilePath(ws, cr);
    const loopRaw = readFileChecked(loopPath);
    const all = att.data.loops ? att.data : { loops: {} };
    const prev = all.loops[loopRef] || { 'current-cycle': 1, 'current-attempt': 0, attempts: [] };
    const cycle = newCycle ? (prev['current-cycle'] || 1) + 1 : (prev['current-cycle'] || 1);
    const attemptNo = newCycle ? 1 : projCurrent;
    all.loops[loopRef] = {
      'current-cycle': cycle,
      'current-attempt': attemptNo,
      attempts: [...(att.attempts || []), { attempt: attemptNo, at: recordedAt, by: reviewer, cycle }],
    };
    writes.push({ path: loopPath, expectedHash: loopRaw == null ? null : sha256(loopRaw), newText: renderLoopText(all.loops) });
  }
  casWriteMulti(writes); // 任一前置校验/CAS 失败时本次涉及的受控文件均不落盘；保留 B-18 已声明的连续 rename 极小崩溃窗口，不另造事务
  auditLog(ws, { kind: 'ledger', op: 'review-record', cr, stage, verdict: payload.verdict, actor: reviewer, file: target });
  emitOutboxEvent(ws, {
    event_kind: 'review', cr_id: cr, actor: reviewer,
    payload: { stage, verdict: payload.verdict, blockerCount },
  });
  // 删除临时 payload（避免残留误提交或跨 CR 串味）——放在写入成功之后，失败路径 payload 保留供重试
  try { fs.rmSync(fromPath, { force: true }); } catch { /* 删除失败不阻塞主结果 */ }
  // CR-2026-027 FR-13/TASK-08：输出深化（TD-BL-2 真值表 + 真实写入文件 + attempt 信息）
  const writtenFiles = [target, tracePath];
  if (bump) writtenFiles.push(attemptsFilePath(ws, cr));
  const route = payload.verdict === 'pass' ? 'pass'
    : (stage === 'dev-plan' && devPlanRoute === 'upstream') ? 'upstream' : 'repair';
  ok({
    op: 'review-record', cr, stage, file: target.replaceAll('\\', '/'), verdict: payload.verdict, trace: tracePath.replaceAll('\\', '/'),
    files: writtenFiles.map((f) => f.replaceAll('\\', '/')),
    attempt: { current: projCurrent, max: att.max, bumped: bump },
    route, repairTarget,
  });
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
/* ────────────────────────── Owner 正式移交原语（CR-2026-030 TASK-03，SDD §2.2~§2.5/§3.5/§4.4~§4.7） ──────────────────────────
 * owner-set 收敛为受控账本原语：tracked clean 前置 → 双投影一致性校验 → 唯一时间戳两账本候选 →
 * 一次 casWriteMulti → 只 add 两受控路径并复核 staged set → 一次隔离正式 commit → 成功后同 SHA 发 owners/inbox 事件。
 * 失败回滚以候选 hash 为 CAS 前提恢复原始快照并复核 clean baseline；禁止 reset/checkout/补偿 commit。
 */

/** tracked 变更只读快照（FR-3/FR-5）：staged=git diff --name-only --cached，unstaged=git diff --name-only -- .。
 * 路径统一 Git 输出的 / 分隔形式，过滤空行去重排序；untracked 不属于该结构。
 * 纯只读查询传 audit:false——dirty 拒绝与同值幂等路径必须零审计副作用（SDD §3.6）。 */
function queryTrackedChanges(ws, opts = {}) {
  const run = (args) => controlledGit(ws, 'diff', args, ws, 'crctl-owner-set', { audit: opts.audit !== false });
  const staged = run(['--name-only', '--cached']);
  const unstaged = run(['--name-only', '--', '.']);
  if (!staged.ok || !unstaged.ok) {
    return { ok: false, code: 'OWNER_GIT_CHECK_FAILED', detail: { staged: staged.code || staged.exit, unstaged: unstaged.code || unstaged.exit } };
  }
  const norm = (s) => [...new Set(String(s || '').replaceAll('\r\n', '\n').split('\n').map((l) => l.trim()).filter(Boolean))].sort();
  return { ok: true, staged: norm(staged.stdout), unstaged: norm(unstaged.stdout) };
}

/** 双投影读取：cr.md + _backlog.yml 的 path/text/hash/owners/兼容 owner。 */
function readOwnerState(ws, cr) {
  const snap = loadBacklogEntry(ws, cr);
  const crMdP = path.join(crDir(ws, cr), 'cr.md');
  const crMdText = readFileChecked(crMdP);
  if (crMdText == null) fail('CR_MD_WRITE_FAILED', `cr.md 不存在: ${crMdP}`);
  const m = matchFrontmatter(crMdText);
  const md = m ? parseYaml(m.body) || {} : {};
  const be = snap.entry || {};
  return {
    crMd: { path: crMdP, text: crMdText, hash: sha256(crMdText), owners: md.owners, compatibilityOwner: md.owner },
    backlog: { path: snap.path, text: snap.text, hash: snap.hash, owners: be.owners, compatibilityOwner: be.owner },
  };
}

function ownerSlotId(slot) {
  return slot && slot.id !== undefined && slot.id !== null ? String(slot.id) : null;
}

/** FR-3：cr.md 与 _backlog.yml 的三个当前 Owner 及顶层兼容 owner 必须逐项一致；任一漂移结构化错误且零写入。 */
function assertOwnerProjectionConsistent(state) {
  const bad = [];
  for (const role of ['requirement', 'development', 'test']) {
    const a = ownerSlotId(state.crMd.owners?.[role]);
    const b = ownerSlotId(state.backlog.owners?.[role]);
    if (a === null || b === null || a !== b) bad.push(role);
  }
  if (ownerSlotId(state.crMd.owners?.requirement) !== String(state.crMd.compatibilityOwner ?? '')) bad.push('cr.md.owner');
  if (ownerSlotId(state.backlog.owners?.requirement) !== String(state.backlog.compatibilityOwner ?? '')) bad.push('backlog.owner');
  if (bad.length) {
    fail('OWNER_PROJECTION_DRIFT', `Owner 双投影不一致（漂移字段: ${bad.join(', ')}），拒绝写入（不自动修复）`, { changed: false, drifted: bad });
  }
}

/** 行级替换 owners.{role} slot 内的 id/assigned-at 两行（slot 块必须完整，缺失即 LEDGER_PARSE_FAILED）。
 * 块尾判定必须含缩进（findBlockEnd 的 key 正则无 \s 前缀，只识别 0 缩进键——会越过同缩进的下一个 slot）。 */
function slotBlockEnd(lines, idx) {
  const keyIndent = lines[idx].match(/^[ \t]*/)[0].length;
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    const ind = l.match(/^[ \t]*/)[0].length;
    if (ind <= keyIndent && /^[ \t]*[A-Za-z0-9_-]+:/.test(l)) return i;
  }
  return lines.length;
}

function replaceOwnerSlot(lines, role, newId, slotIndent, at) {
  const out = [...lines];
  const re = new RegExp('^' + ' '.repeat(slotIndent) + role + ':');
  const idx = out.findIndex((l) => re.test(l));
  if (idx === -1) fail('LEDGER_PARSE_FAILED', `owners.${role} 块缺失`);
  const segEnd = slotBlockEnd(out, idx);
  let idReplaced = false;
  let atReplaced = false;
  for (let i = idx + 1; i < segEnd; i++) {
    if (/^[ \t]*id:/.test(out[i])) { out[i] = out[i].replace(/^( *)(id:).*$/, `$1$2 ${newId}`); idReplaced = true; }
    else if (/^[ \t]*assigned-at:/.test(out[i])) { out[i] = out[i].replace(/^( *)(assigned-at:).*$/, `$1$2 "${at}"`); atReplaced = true; }
  }
  if (!idReplaced || !atReplaced) fail('LEDGER_PARSE_FAILED', `owners.${role} 块缺少 id/assigned-at`);
  return { out, segEnd };
}

/** owner-history 块追加一项（缺块则创建）。 */
function appendOwnerHistory(lines, entryLine) {
  const idx = lines.findIndex((l) => /^owner-history:/.test(l));
  if (idx === -1) return [...lines, 'owner-history:', entryLine];
  const out = [...lines];
  const segEnd = findBlockEnd(out, idx);
  let lastItem = -1;
  for (let i = segEnd - 1; i > idx; i--) { if (/^[ \t]*- /.test(out[i])) { lastItem = i; break; } }
  out.splice(lastItem + 1, 0, entryLine);
  return out;
}

/** cr.md 候选：slot 更新 + requirement 顶层兼容 owner 同步 + owner-history 追加一条（note 可含）。 */
function editCrOwnerProjection(text, cr, role, newId, historyEntry, handoverAt) {
  const norm = text.replaceAll('\r\n', '\n');
  const m = matchFrontmatter(norm);
  if (!m) fail('LEDGER_PARSE_FAILED', `cr.md 无 frontmatter: ${cr}`);
  const lines = m.body.split('\n');
  if (role === 'requirement') {
    const oi = lines.findIndex((l) => /^owner:/.test(l));
    if (oi === -1) fail('LEDGER_PARSE_FAILED', 'cr.md 缺少顶层 owner 兼容字段');
    lines[oi] = lines[oi].replace(/^( *)(owner:).*$/, `$1$2 ${newId}`);
  }
  const { out } = replaceOwnerSlot(lines, role, newId, 2, handoverAt);
  const entryLine = `  - { role: ${historyEntry.role}, from: ${historyEntry.from || '""'}, to: ${historyEntry.to}, at: "${historyEntry.at}", reason: ${historyEntry.reason}${historyEntry.note ? `, note: ${yamlScalar(historyEntry.note)}` : ''} }`;
  const body = appendOwnerHistory(out, entryLine).join('\n');
  return norm.replace(m.match, '---\n' + body + '\n---');
}

/** _backlog.yml 候选：slot 更新 + requirement 顶层兼容 owner 同步 + notify-log 追加/notify-pending 合并（复用 inbox-emit 结构，时间戳显式传入）。 */
function editBacklogOwnerProjection(text, cr, role, newId, inboxPayload, handoverAt) {
  const norm = text.replaceAll('\r\n', '\n');
  const block = matchEntryBlock(norm, cr);
  if (!block) fail('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`);
  const lines = block.text.split('\n');
  const { out } = replaceOwnerSlot(lines, role, newId, block.indent + 4, handoverAt);
  if (role === 'requirement') {
    const oi = out.findIndex((l) => /^[ \t]*owner:/.test(l));
    if (oi === -1) fail('LEDGER_PARSE_FAILED', 'backlog 条目缺少顶层 owner 兼容字段');
    out[oi] = out[oi].replace(/^( *)(owner:).*$/, `$1$2 ${newId}`);
  }
  const nb = norm.slice(0, block.start) + out.join('\n') + norm.slice(block.end);
  return editInboxEmit(nb, cr, { at: handoverAt, event: 'owner-handover', to: inboxPayload.to, payload: inboxPayload });
}

/** casWriteMulti 的软失败变体（回滚专用，SDD §4.7）：语义一致（全校验→全 temp→连续 rename），失败抛 Error 而非 process.exit。 */
function tryCasWriteMulti(writes) {
  for (const w of writes) {
    const cur = readFileChecked(w.path);
    if (cur == null && w.expectedHash == null) continue;
    if (cur == null) throw new Error(`写入前文件消失: ${w.path}`);
    if (w.expectedHash == null || sha256(cur) !== w.expectedHash) {
      throw new Error(`${w.path} CAS 失配（候选 hash ${String(w.expectedHash).slice(0, 8)}…），疑似并发修改`);
    }
  }
  const staged = writes.map((w) => {
    const tmp = w.path + `.tmp-${process.pid}`;
    fs.writeFileSync(tmp, w.newText, 'utf8');
    return { tmp, dst: w.path };
  });
  for (const s of staged) fs.renameSync(s.tmp, s.dst);
}

/** FR-5 失败回滚：以候选 hash 为 CAS 前提恢复两原始快照，撤销本次暂存，复核 clean baseline。
 * 任一步失败 → OWNER_COMMIT_ROLLBACK_FAILED（不吞外部并发变化，不 reset/checkout）。 */
function rollbackOwnerWrite(ws, os, candidateHashes, rels) {
  try {
    tryCasWriteMulti([
      { path: os.crMd.path, expectedHash: candidateHashes.crMd, newText: os.crMd.text },
      { path: os.backlog.path, expectedHash: candidateHashes.backlog, newText: os.backlog.text },
    ]);
    const unR = controlledGit(ws, 'add', rels, ws, 'crctl-owner-set'); // 原文等于 HEAD → 清除本次 staged diff
    if (!unR.ok) throw new Error(`撤销本次暂存失败: git add ${rels.join(' ')}`);
    const clean = queryTrackedChanges(ws, { audit: true });
    if (!clean.ok || clean.staged.length || clean.unstaged.length) {
      throw new Error(`clean baseline 复核失败 staged=[${(clean.staged || []).join(',')}] unstaged=[${(clean.unstaged || []).join(',')}]`);
    }
  } catch (e) {
    fail('OWNER_COMMIT_ROLLBACK_FAILED', `正式移交提交失败后的恢复未完成：${String(e && e.message || e)}`, { affected: rels });
  }
  fail('OWNER_COMMIT_FAILED', '正式移交提交失败，已恢复两个原始快照并撤销本次暂存（tracked clean baseline 已复原），请修复后重试', { changed: false, rolled_back: true });
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
  if (!flags.role || !flags.id) fail('BAD_ARGS', 'owner-set 需要 --role <requirement|development|test> --id <id> [--note <text>]');
  if (!['requirement', 'development', 'test'].includes(flags.role)) fail('BAD_ARGS', `--role 必须是 requirement|development|test（当前 ${flags.role}）`);
  const state = resolveCrState(ws, cr);
  const { sm } = loadStateMachine(ws);
  if ((sm.terminal || []).includes(state.status)) fail('ILLEGAL_LEDGER_STATE', `owner-set 不允许在终态 ${state.status} 修改负责人`, { current: state.status, expect: '非终态' });
  // FR-3：tracked clean 前置（untracked 不阻塞）；任一 tracked staged/unstaged 变更 → 零副作用拒绝
  const dirty = queryTrackedChanges(ws, { audit: false });
  if (!dirty.ok) {
    fail(dirty.code, '受控 Git 只读查询失败，无法确认 tracked clean 前置', { changed: false, detail: dirty.detail });
  }
  if (dirty.staged.length || dirty.unstaged.length) {
    fail('OWNER_WORKTREE_DIRTY', '仓库存在 tracked 变更：正式移交要求 tracked index 与 tracked working tree 均 clean（untracked 不阻塞）。请先提交、暂存外移或丢弃自己的 tracked 变更', { changed: false, staged: dirty.staged, unstaged: dirty.unstaged });
  }
  // FR-3：双投影一致性校验（cr.md 与 _backlog.yml 三角色 + 顶层兼容 owner）
  const os = readOwnerState(ws, cr);
  assertOwnerProjectionConsistent(os);
  const from = ownerSlotId(os.crMd.owners[flags.role]);
  const newId = String(flags.id);
  if (newId === from) {
    // FR-3：同值重放仅在双投影一致且 tracked clean 时返回 changed=false，零副作用
    ok({ op: 'owner-set', cr, changed: false, role: flags.role, id: newId });
    return;
  }
  // FR-3：真实变化只生成一次时间戳，复用于两处 slot、requirement 两处兼容 owner、history、notify、audit、outbox
  const handoverAt = nowIso();
  const note = typeof flags.note === 'string' && flags.note.trim() ? flags.note.trim() : null;
  const ownerChange = { role: flags.role, from, to: newId, at: handoverAt, reason: 'formal-handover' };
  const historyEntry = note ? { ...ownerChange, note } : ownerChange;
  const inboxPayload = { event: 'owner-handover', to: [newId], role: flags.role, from, owner: newId, handover_at: handoverAt, ...(note ? { note } : {}) };
  const newCrMd = editCrOwnerProjection(os.crMd.text, cr, flags.role, newId, historyEntry, handoverAt);
  const newBacklog = editBacklogOwnerProjection(os.backlog.text, cr, flags.role, newId, inboxPayload, handoverAt);
  const relCrMd = path.relative(ws, os.crMd.path).split(path.sep).join('/');
  const relBacklog = path.relative(ws, os.backlog.path).split(path.sep).join('/');
  const rels = [relCrMd, relBacklog];
  const expected = [...rels].sort();
  const candidateHashes = { crMd: sha256(newCrMd), backlog: sha256(newBacklog) };
  // FR-5：两账本候选一次 CAS 写入
  casWriteMulti([
    { path: os.crMd.path, expectedHash: os.crMd.hash, newText: newCrMd },
    { path: os.backlog.path, expectedHash: os.backlog.hash, newText: newBacklog },
  ]);
  // FR-5：只 add 两受控路径，commit 前复核 staged set 恰好等于两文件且无其他 tracked working-tree 变化
  const addR = controlledGit(ws, 'add', rels, ws, 'crctl-owner-set');
  if (addR.ok) {
    const iso = queryTrackedChanges(ws, { audit: false });
    if (iso.ok && iso.unstaged.length === 0 && JSON.stringify(iso.staged) === JSON.stringify(expected)) {
      const msg = `[cr] owner handover ${cr} ${flags.role} ${from} -> ${newId}`;
      const commitR = controlledGit(ws, 'commit', ['-m', msg], ws, 'crctl-owner-set');
      if (commitR.ok) {
        const sha = gitHeadSha(ws);
        auditLog(ws, { kind: 'ledger', op: 'owner-set', cr, actor: identity(ws), role: flags.role, from, to: newId, handover_at: handoverAt, result: 'ok' });
        // FR-5：同一真实 SHA 分别尝试 owners + inbox 事件；outbox 失败只 warning，不回滚 commit
        const warnings = [];
        const emit = (ev) => {
          const n = emitOutboxEvent(ws, ev);
          if (!n) warnings.push({ code: 'EMIT_FAILED', event_kind: ev.event_kind });
          return n;
        };
        const proj = {};
        for (const role of ['requirement', 'development', 'test']) {
          const s = os.crMd.owners[role];
          proj[role] = role === flags.role
            ? { id: newId, 'assigned-at': handoverAt }
            : { id: String(s.id), 'assigned-at': s['assigned-at'] ? String(s['assigned-at']) : '' };
        }
        const outbox = {
          owners: emit({ event_kind: 'owners', cr_id: cr, from_status: state.status, to_status: state.status, trigger: 'owner-handover', commit_sha: sha, actor: identity(ws), payload: { owners: proj, changes: [ownerChange], handover_at: handoverAt } }),
          inbox: emit({ event_kind: 'inbox', cr_id: cr, from_status: state.status, to_status: state.status, trigger: 'owner-handover', commit_sha: sha, actor: identity(ws), payload: inboxPayload }),
        };
        ok({ op: 'owner-set', cr, changed: true, role: flags.role, from, to: newId, handoverAt, files: [os.crMd.path, os.backlog.path], commit: { sha, message: msg }, outbox, warnings });
        return;
      }
    }
  }
  // add/commit/隔离复核失败 → 回滚恢复 clean baseline
  rollbackOwnerWrite(ws, os, candidateHashes, rels);
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
    `${itemIndent}- at: "${meta.at || nowIso()}"`,
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
  // CR-2026-027 FR-11 + 代码评审回修（b6）：--to 解析后必须是列表（不接受 JSON 标量包装）；
  // 逐项 trim、过滤空、去重后为空 → BAD_ARGS（与 Skill 契约对齐，不写无收件人 notify-log）
  let to = [];
  if (flags.to !== undefined) {
    let parsed;
    try { parsed = JSON.parse(flags.to); } catch { parsed = String(flags.to).split(','); }
    if (!Array.isArray(parsed)) fail('BAD_ARGS', `inbox-emit --to 解析后必须是列表（不接受 JSON 标量），实际 ${JSON.stringify(flags.to)}`);
    to = [...new Set(parsed.map((s) => String(s).trim()).filter(Boolean))];
  }
  if (flags.to === undefined || to.length === 0) {
    fail('BAD_ARGS', 'inbox-emit 需要非空 --to <a,b>（缺失、非数组或去重过滤后为空均拒绝，不写无收件人 notify-log）');
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
  if (!flags.title) fail('BAD_ARGS', 'cr-init 需要 --title <t> --owner-requirement <id> --owner-development <id> --owner-test <id> [--year Y] [--summary <s>] [--source <s>] [--target-version <v>]');
  // FR-1（CR-2026-030）：三角色显式必填，缺任一参数在读取/创建任何文件之前零写入；不保留复制兼容路径
  const req = String(flags['owner-requirement'] || '');
  const dev = String(flags['owner-development'] || '');
  const tst = String(flags['owner-test'] || '');
  if (!req || !dev || !tst) {
    fail('BAD_ARGS', 'cr-init 需要显式 --owner-requirement <id> --owner-development <id> --owner-test <id>（三角色独立指定，无隐式继承）');
  }
  const year = flags.year || String(new Date().getFullYear());
  const cr = formatCrId(year, scanMaxCrNumber(ws, year) + 1);
  const now = nowIso();
  const by = identity(ws);
  // FR-9（CR-2026-022）：注册元信息可选旗标，缺省值与旧硬编码同义（summary="" / source=manual / target-version=tbd），向后兼容
  const summary = flags.summary ?? '';
  const source = flags.source ?? 'manual';
  const tv = flags['target-version'] ?? 'tbd';
  // FR-1：同一个注册时间戳 now 复用于三角色当前 Owner 与三条 initial-assignment history
  const ownerSlot = (id, indent) => [`${' '.repeat(indent)}id: ${id}`, `${' '.repeat(indent)}assigned-at: "${now}"`];
  // cr.md 全量 frontmatter（owners/owner-history/时间戳全 crctl 生成）
  const fm = [
    '---',
    `id: ${cr}`,
    `title: ${flags.title.replaceAll('"', '\\"')}`,
    `summary: ${yamlScalar(summary)}`,
    `owner: ${req}`,
    'owners:',
    '  requirement:',
    ...ownerSlot(req, 4),
    '  development:',
    ...ownerSlot(dev, 4),
    '  test:',
    ...ownerSlot(tst, 4),
    `target-version: ${yamlScalar(tv)}`,
    `source: ${yamlScalar(source)}`,
    'status: drafting',
    `created: "${now}"`,
    `updated: "${now}"`,
    'remote-ref: ""',
    'last-push-at: ""',
    'last-push-by: ""',
    'owner-history:',
    `  - { role: requirement, from: "", to: ${req}, at: "${now}", reason: initial-assignment }`,
    `  - { role: development, from: "", to: ${dev}, at: "${now}", reason: initial-assignment }`,
    `  - { role: test, from: "", to: ${tst}, at: "${now}", reason: initial-assignment }`,
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
    `    owner: ${req}`,
    '    owners:',
    '      requirement:',
    ...ownerSlot(req, 8),
    '      development:',
    ...ownerSlot(dev, 8),
    '      test:',
    ...ownerSlot(tst, 8),
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
  // FR-1/FR-2：成功 audit 记录完整 Owner 投影与三项初始变化；不记录 branch/worktree/commit SHA/outbox 成功事实（尚未发生）
  auditLog(ws, {
    kind: 'ledger', op: 'cr-init', cr, actor: by, title: flags.title,
    owners: { requirement: req, development: dev, test: tst },
    changes: ['requirement', 'development', 'test'].map((role) => ({ role, from: '', to: role === 'requirement' ? req : role === 'development' ? dev : tst, at: now, reason: 'initial-assignment' })),
  });
  // FR-2：cr-init 自身不发 outbox——注册事实由 register commit 成功后以真实 SHA 产生
  ok({
    op: 'cr-init', cr, title: flags.title, status: 'drafting',
    owners: {
      requirement: { id: req, 'assigned-at': now },
      development: { id: dev, 'assigned-at': now },
      test: { id: tst, 'assigned-at': now },
    },
    files: { crMd: path.join('change-requests', cr, 'cr.md'), backlog: bp, index: ip },
  });
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

/* ────────────────────────── worktree-path / report / cr-metrics（S9/S11，CR-2026-021 TASK-08 + CR-2026-028 FR-2） ──────────────────────────
 * 只读子命令（SDD §3.2/§3.3）：不写任何文件、无 CAS。
 * - worktree-path <cr> --repo <r>：唯一权威拼接规则（从 requirement-register 等 4+ 处 SKILL prose 提炼）：
 *   bucket = role==='knowledge-base' ? 'knowledge-base' : repo.id；path = {installRoot}/.rayai-worktrees/{bucket}/requirement/{cr}
 *   installRoot = Installation Workspace（deriveInstallRoot）：linked worktree 场景由 git common-dir 派生主 checkout，
 *   避免从 CR worktree 内部再拼出第二个 .rayai-worktrees（CR-2026-028 FR-2 实测 bug）。
 * - report / cr-metrics [--period <N>d]：跨 CR 聚合（对齐 cr-dashboard Step 2 口径）——
 *   状态直方图（在途 cr.md frontmatter + _history.yml 归档 final-status，累计口径，不受 --period 影响）、
 *   周期活动计数 periodActivity（按 archived-at，仅当传 --period 时按窗口过滤，格式仅支持 <N>d 如 7d/30d，
 *   非法格式 BAD_ARGS 硬拒而非静默忽略）、SLA 阈值比较（change-requests/_config.yml#sla，缺省跳过，累计口径）。
 */

/**
 * Installation Workspace（InstWS）：Tools Root 相对路径与 .rayai-worktrees/ 的解析基准（CR-2026-028 FR-2）。
 * linked worktree 场景 git common-dir 指向主 checkout 的 .git，其 dirname 即主 checkout 根；
 * 非 git 目录（普通 checkout / 测试临时目录）回退 opWs。仅 spawn git 只读查询，无副作用。
 */
function deriveInstallRoot(opWs) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: opWs, encoding: 'utf8', shell: false });
  if (r.status === 0 && r.stdout && r.stdout.trim()) {
    const commonDir = path.resolve(opWs, r.stdout.trim());
    return path.dirname(commonDir);
  }
  return opWs;
}

function cmdWorktreePath(ws, cr, gates, flags) {
  if (!flags.repo) fail('BAD_ARGS', 'worktree-path 需要 --repo <repo-id>');
  const bucket = flags.repo === 'knowledge-base' || flags.repo === 'ai-first-platform-docs' ? 'knowledge-base' : flags.repo;
  const p = path.join(deriveInstallRoot(ws), '.rayai-worktrees', bucket, 'requirement', cr);
  // CR-2026-030 TASK-02（FR-2/AC-5）：canonical branch 只在此处生成，Skill/Pipeline 不再拼接
  ok({ op: 'worktree-path', cr, repo: flags.repo, bucket, branch: `requirement/${cr}`, path: p });
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

// CR-2026-030 TASK-02：cr.md 权威 Owner 投影读取（register commit 后置事件的数据源）。
// 软失败变体：commit 已是权威事实，Owner 校验失败只返回结构化原因，由调用方记 warning + SKIPPED audit（SDD §4.2）。
function tryReadCrOwnerProjection(ws, cr) {
  try {
    const md = readCrMdFrontmatter(ws, cr);
    if (!md || !md.owners) return { ok: false, why: `cr.md 缺少 owners 投影: ${cr}` };
    const slots = {};
    for (const role of ['requirement', 'development', 'test']) {
      const s = md.owners[role];
      if (!s || !s.id) return { ok: false, why: `cr.md owners.${role} 缺失，无法产生注册事件` };
      slots[role] = { id: String(s.id), 'assigned-at': s['assigned-at'] ? String(s['assigned-at']) : '' };
    }
    return { ok: true, owners: slots };
  } catch (e) {
    return { ok: false, why: String(e && e.message || e) };
  }
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
  // CR-2026-030 TASK-02：返回模板上下文（register 模板在 commit 成功后触发真实 SHA 注册事件）
  return { args: argv, templateContext: { kind, cr } };
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
  const md = readCrMdFrontmatter(ws, cr);
  const tester = md?.owners?.test?.id ? String(md.owners.test.id) : identity(ws);
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

// CR-2026-027 FR-10/TASK-05：迁移提前返回路径的统一收尾——幽灵清理若删除了条目且非 embedded，需 standalone commit。
function finishMigrateBacklog(ws, flags, base, ghostResult) {
  if (ghostResult.ghost && ghostResult.ghost.removed && !flags.embedded && !flags['no-commit']) {
    const addR = controlledGit(ws, 'add', ['change-requests/_backlog.yml'], ws, 'crctl-migrate');
    const commitR = addR.ok ? controlledGit(ws, 'commit', ['-m', `[cr] migrate backlog ghost cleanup: ${ghostResult.ghost.title}`], ws, 'crctl-migrate') : addR;
    base.commit = commitR.ok ? { message: 'ghost cleanup' } : { failed: true, detail: commitR };
    if (commitR && !commitR.ok) process.exit(1);
  }
  ok({ ...base, ...ghostResult });
}

function cmdMigrateBacklog(ws, gates, flags) {
  const p = backlogPath(ws);
  const text = readFileChecked(p);
  if (!text) fail('BACKLOG_NOT_FOUND', `缺少 ${p}`);
  const hash = sha256(text);
  const doc = parseYaml(text);
  const list = Array.isArray(doc) ? doc : doc['change-requests'] || doc.backlog || doc.items || [];
  const schemaVer = (doc && !Array.isArray(doc) && doc.schema) || '';
  const isV2 = schemaVer === 'cr-backlog/v2';

  // 幂等检查：v2 且所有条目无 status/updated-at（仍执行幽灵清理——清理独立于 v1→v2 迁移）
  if (isV2) {
    const hasLegacy = list.some((e) => e && (e.status !== undefined || e['updated-at'] !== undefined));
    if (!hasLegacy) {
      const ghostResult = migrateGhostCleanup(ws, text);
      if (ghostResult.ghost.removed) casWrite(p, hash, ghostResult.cleanedText);
      auditGhostCleanup(ws, ghostResult); // b10：casWrite 成功后才记幽灵审计（CAS_CONFLICT 时零成功记录）
      finishMigrateBacklog(ws, flags, { migrated: false, reason: 'already-migrated', entries: list.length }, ghostResult);
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
    const ghostResult = migrateGhostCleanup(ws, text);
    if (ghostResult.ghost.removed) casWrite(p, hash, ghostResult.cleanedText);
    auditGhostCleanup(ws, ghostResult); // b10：casWrite 成功后才记幽灵审计（CAS_CONFLICT 时零成功记录）
    finishMigrateBacklog(ws, flags, { migrated: false, reason: 'already-migrated', entries: list.length }, ghostResult);
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

  // CR-2026-027 FR-10/TASK-05 + 代码评审回修（b5）：幽灵块归属校验必须前置于任何写入——
  // orphan 时 GHOST_ENTRY_ORPHANED 硬失败且 backlog 文件保持不变；通过则迁移+清理合并为一次 casWrite（原子）。
  const ghostResult = migrateGhostCleanup(ws, finalText);
  const writeText = ghostResult.ghost.removed ? ghostResult.cleanedText : finalText;
  casWrite(p, hash, writeText);
  auditGhostCleanup(ws, ghostResult); // b10：迁移+清理合并 casWrite 成功后才记幽灵审计（CAS_CONFLICT 时零成功记录）

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
    ok({ migrated: true, entries: toMigrate.length, removedLines: removed.length, ...ghostResult, commit: 'embedded：由调用方在同一事务中提交' });
  } else {
    const addR = controlledGit(ws, 'add', ['change-requests/_backlog.yml'], ws, 'crctl-migrate');
    const commitR = addR.ok ? controlledGit(ws, 'commit', ['-m', msg], ws, 'crctl-migrate') : addR;
    ok({ migrated: true, entries: toMigrate.length, removedLines: removed.length, ...ghostResult, commit: commitR.ok ? { message: msg } : { failed: true, detail: commitR } });
    if (commitR && !commitR.ok) process.exit(1);
  }
}

// CR-2026-027 FR-10/TASK-05：幽灵条目清理（幂等；删除依据 = history 存在同 title 归档条目）。
// B-12 实测形态：幽灵块是某条目块内的重复字段 key（如 title 二次出现，CR-2026-024 归档残留），
// 后续可能有正常条目（如 CR-2026-027），因此遍历所有条目块，删除范围 = 重复 key 行 到 下一个条目行。
// CR-2026-027 代码评审回修（b5）：本函数只做幽灵块检测与归属校验（orphan 硬失败），不写盘；
// 调用方拿到 cleanedText 后再统一 casWrite，保证"失败时文件不变"。
// 代码评审回修（b10）：审计事件移出本函数——幽灵审计必须发生在 casWrite 成功之后（见 auditGhostCleanup），
// CAS_CONFLICT 时 _backlog.yml 不变且 audit.log 不得误记已清理（FR-10 一致性边界）。
function migrateGhostCleanup(ws, text) {
  const norm = text.replaceAll('\r\n', '\n');
  const lines = norm.split('\n');
  // 列表项缩进（'  - id:' 的缩进）与条目字段层缩进（itemIndent+2）
  let itemIndent = -1;
  for (const l of lines) {
    const m = l.match(/^(\s*)-\s+id:/);
    if (m) { itemIndent = m[1].length; break; }
  }
  if (itemIndent < 0) return { ghost: { removed: false, reason: 'no-list-items' } };
  const fieldIndent = itemIndent + 2;
  // 所有条目行号
  const idLines = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s+id:\s*["']?([^"'\s]+)["']?\s*$/);
    if (m && m[1].length === itemIndent) idLines.push(i);
  }
  if (idLines.length === 0) return { ghost: { removed: false, reason: 'no-list-items' } };
  // 遍历每个条目块，找第一个重复字段 key（幽灵起点）；只统计字段层缩进（嵌套子字段不参与）
  let ghostStart = -1, ghostEnd = -1, ghostTitle = '';
  for (let k = 0; k < idLines.length && ghostStart < 0; k++) {
    const start = idLines[k] + 1;
    const end = k + 1 < idLines.length ? idLines[k + 1] : lines.length;
    const seen = new Set();
    for (let i = start; i < end; i++) {
      const l = lines[i];
      if (l.trim() === '') continue;
      const ind = l.match(/^[ \t]*/)[0].length;
      if (ind <= itemIndent) break;
      if (ind !== fieldIndent) continue;
      const km = l.match(/^\s*([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (!km) continue;
      if (seen.has(km[1])) { ghostStart = i; ghostEnd = end; ghostTitle = km[2].replace(/^["']|["']$/g, '').trim(); break; }
      seen.add(km[1]);
    }
  }
  if (ghostStart < 0) return { ghost: { removed: false, reason: 'already-clean' } };
  // 归属判定：_history.yml 存在同 title 的终态条目（行级匹配，不依赖 YAML 解析器对复杂标量的解析）
  const hText = readFileChecked(path.join(ws, 'change-requests', '_history.yml'));
  let archived = false;
  if (hText != null && ghostTitle) {
    archived = hText.replaceAll('\r\n', '\n').split('\n').some((l) => {
      const tm = l.match(/^\s*title:\s*(.*)$/);
      return tm && tm[1].replace(/^["']|["']$/g, '').trim() === ghostTitle;
    });
  }
  if (!archived) {
    fail('GHOST_ENTRY_ORPHANED', `_backlog.yml 条目块内存在无 id 归属的重复字段块（title=${ghostTitle || '(未解析)'}），但 _history.yml 无对应归档条目，拒绝删除`);
  }
  const cleaned = lines.slice(0, ghostStart).concat(lines.slice(ghostEnd)).join('\n').replace(/\s+$/, '') + '\n';
  return { ghost: { removed: true, title: ghostTitle, reason: 'archived-in-history' }, cleanedText: cleaned };
}

// CR-2026-027 代码评审回修（b10）：幽灵清理的审计事件必须发生在 casWrite 成功之后——
// CAS_CONFLICT 时 _backlog.yml 保持不变而 audit.log 不得误记已清理（FR-10 一致性边界）。
// 调用方在 casWrite 成功后才调用本函数补记审计；迁移+清理合并的单次 casWrite 同样适用。
function auditGhostCleanup(ws, ghostResult) {
  if (ghostResult.ghost && ghostResult.ghost.removed) {
    auditLog(ws, { kind: 'migrate-backlog-ghost', removed: true, title: ghostResult.ghost.title, by: identity(ws) });
  }
}

function cmdNext(ws, cr, gates, flags) {
  // CR-2026-027 FR-12/TASK-07：终态只读查询（next:null 不报错；写命令不 fallback）
  const terminal = resolveTerminalForQuery(ws, cr);
  if (terminal) {
    ok({ cr, status: String(terminal['final-status']), terminal: true, source: { history: 'change-requests/_history.yml' }, legalNext: [], reviewLoops: {}, gateBlockers: {}, next: null, humanApproval: false, why: '终态 CR：无后继节点' });
    return;
  }
  const state = resolveCrState(ws, cr);
  const status = state.status;
  const ev = (rel) => readEvidenceDoc(ws, cr, rel);
  const passAndClean = (doc) => doc.exists && doc.data && doc.data.verdict === 'pass' && Array.isArray(doc.data.blockers) && doc.data.blockers.length === 0;
  const suggest = (node, why, human = false) => ok({ cr, status, next: node, humanApproval: human, why });

  switch (status) {
    case 'drafting': {
      // CR-2026-025 FR-20/D-12：block 后先回修；PRD 实质修订后转重审；以 LF 规范化摘要判 freshness，禁 mtime
      const prdPath = path.join(crDir(ws, cr), 'prd.md');
      if (!fs.existsSync(prdPath)) return suggest('write-requirement-prd', 'prd.md 缺失');
      const a = ev('change-requests/{cr}/review-annotations/requirement.yml');
      const failed = a.exists && a.data && (a.data.verdict === 'block' || (Array.isArray(a.data.blockers) && a.data.blockers.length > 0));
      if (failed) {
        const recSha = a.data['subject-sha256'];
        if (recSha == null) return suggest('review-requirement', `旧评审证据无摘要，维持改动前行为（verdict=${a.data.verdict}）`); // FR-20⑤ 兼容，不做历史迁移
        const curSha = sha256(fs.readFileSync(prdPath, 'utf8').replaceAll('\r\n', '\n'));
        if (recSha === curSha) return suggest('write-requirement-prd', `需求评审未通过（blockers=${(a.data.blockers || []).length} 条，证据 ${a.path}）且 PRD 未回修，先回修`);
        return suggest('review-requirement', 'PRD 已修订，评审证据过时，重新评审刷新证据');
      }
      return suggest('review-requirement', 'prd.md 已存在，进入需求评审');
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
      if (!a.exists) return suggest('review-tech-design', '缺少 sdd.yml 评审记录，先跑 review-tech-design');
      // CR-2026-027 FR-16/TASK-07：SDD freshness——subject digest 不一致 → 重审（旧 PASS 不得直接建议审批）
      const sddPath = path.join(crDir(ws, cr), 'sdd.md');
      if (fs.existsSync(sddPath) && a.data && a.data['subject-sha256'] != null) {
        const curSha = sha256(fs.readFileSync(sddPath, 'utf8').replaceAll('\r\n', '\n'));
        if (curSha !== a.data['subject-sha256']) return suggest('review-tech-design', 'SDD 已修订（subject digest 不一致），重新评审刷新证据');
      }
      // CR-2026-027 FR-16/TASK-07：较新的 dev-plan upstream blocker → 重审（即使旧 PASS；legacy 无 digest 同样适用）
      const dp = ev('change-requests/{cr}/review-annotations/dev-plan.yml');
      const upstreamStale = dp.exists && dp.data && dp.data.verdict === 'block'
        && dp.data['repair-target'] === 'write-tech-design'
        && (!a.data || reviewedAtEpoch(dp.data['reviewed-at'], 'dev-plan reviewed-at') > reviewedAtEpoch(a.data['reviewed-at'], 'sdd reviewed-at'));
      if (upstreamStale) return suggest('review-tech-design', '存在较新的 dev-plan 上游设计疑点（upstream blocker），技术评审证据过时，重新评审');
      if (passAndClean(a)) return suggest('crctl approve --stage tech-design', '技术评审 pass 且无 blocker，等待人工审批', true);
      return suggest('write-tech-design', `评审未通过（verdict=${a.data && a.data.verdict}），按 blocker 回修 SDD`);
    }
    case 'tech-design-reviewed': return suggest('write-dev-plan', '技术设计已审批，编写开发计划');
    case 'task-breakdown': {
      const planOk = fs.existsSync(path.join(crDir(ws, cr), 'plan.md'));
      const tasksOk = fs.existsSync(path.join(crDir(ws, cr), 'tasks'));
      if (!planOk) return suggest('write-dev-plan', 'plan.md 缺失');
      if (!tasksOk) return suggest('write-dev-tasks', 'tasks/ 缺失');
      // CR-2026-027 FR-16/TASK-07：canonical dev-plan.yml 判定（缺失/畸形 → 评审；PASS → 审批；BLOCK → 按 annotation 重算 route）
      const dp = ev('change-requests/{cr}/review-annotations/dev-plan.yml');
      if (!dp.exists || !dp.data || !['pass', 'block'].includes(dp.data.verdict) || !Array.isArray(dp.data.blockers)) {
        return suggest('review-dev-plan', dp.exists ? 'dev-plan.yml 畸形（缺 verdict/blockers），重跑评审' : '缺少 dev-plan.yml 评审记录，先跑 review-dev-plan');
      }
      if (dp.data.verdict === 'pass' && dp.data.blockers.length === 0) {
        return suggest('crctl approve --stage dev-start', '开发计划评审 pass 且无 blocker，等待开发启动人工确认', true);
      }
      const route = resolveDevPlanRoute(dp.data);
      if (route === 'upstream') return suggest('write-tech-design', '开发计划评审发现上游设计疑点（repair-target=write-tech-design），先修订 SDD');
      const att = readAttempts(ws, cr, 'review-dev-plan', gates);
      if (att.exhausted) return suggest(null, '开发计划评审已 LOOP_EXHAUSTED（当前 cycle 3/3），需人工处理剩余 blocker', true);
      return suggest('write-dev-plan', `开发计划评审未通过（blockers=${dp.data.blockers.length} 条），回修 plan/TASK`);
    }
    case 'developing': {
      const tr = ev('change-requests/{cr}/test-report.md');
      if (!tr.exists) return suggest('implement-code → write-test-report', '尚无测试报告');
      if (String(tr.data?.status) !== 'pass') return suggest('implement-code', `test-report.status=${tr.data?.status}，按 replayNodes 回修`);
      const code = ev('change-requests/{cr}/review-annotations/code.yml');
      if (!code.exists) return suggest('push-progress → review-code', '测试证据 pass，推送 checkpoint 后进入代码评审');
      // CR-2026-027 代码评审回修（b8）：code.yml=block 时属回修轮，应回 implement-code 而非再次评审
      if (code.data && code.data.verdict === 'block') return suggest('implement-code', `代码评审未通过（blockers=${(code.data.blockers || []).length} 条），按 blocker 回修后重跑测试再重审`);
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
  let templateContext = null;
  if (sub === 'commit' && flags.template) {
    const t = applyCommitTemplate(ws, args, flags);
    args = t.args;
    templateContext = t.templateContext;
  }
  const r = controlledGit(ws, sub, args, flags.cwd ? path.resolve(flags.cwd) : ws, flags.caller);
  if (r.code === 'FORBIDDEN_SUBCOMMAND') fail('FORBIDDEN_SUBCOMMAND', r.message, { attempted: `git ${sub} ${args.join(' ')}` });
  if (r.code === 'SHELL_UNAVAILABLE') fail('SHELL_UNAVAILABLE', r.message, { attempted: `git ${sub} ${args.join(' ')}` });
  let outbox = null;
  let registerMeta = null;
  // CR-2026-030 TASK-02（FR-2）：register commit 成功后，以真实 HEAD SHA 产生 status + owners 两类注册事件。
  // commit 失败不读 HEAD、不发事件；单个 outbox 写出失败对应 null + warnings EMIT_FAILED，commit 不回滚（Git 是权威）。
  if (r.ok && sub === 'commit' && templateContext && templateContext.kind === 'register') {
    const cwd = flags.cwd ? path.resolve(flags.cwd) : ws;
    const cr = templateContext.cr;
    const sha = gitHeadSha(ws, cwd);
    const warnings = [];
    const emit = (ev) => {
      const name = emitOutboxEvent(ws, ev);
      if (!name) warnings.push({ code: 'EMIT_FAILED', event_kind: ev.event_kind });
      return name;
    };
    try {
      const proj = tryReadCrOwnerProjection(ws, cr);
      if (!proj.ok) {
        auditLog(ws, { kind: 'register-events', cr, result: 'SKIPPED', why: proj.why });
        registerMeta = { commit: { sha }, outbox: { status: null, owners: null }, warnings: [{ code: 'REGISTER_EVENTS_SKIPPED', why: proj.why }] };
      } else {
        const owners = proj.owners;
        const changes = ['requirement', 'development', 'test'].map((role) => ({
          role, from: '', to: owners[role].id, at: owners[role]['assigned-at'], reason: 'initial-assignment',
        }));
        registerMeta = {
          commit: { sha },
          outbox: {
            status: emit({ event_kind: 'status', cr_id: cr, from_status: '(new)', to_status: 'drafting', trigger: 'requirement-register', commit_sha: sha, actor: identity(ws) }),
            owners: emit({ event_kind: 'owners', cr_id: cr, from_status: '(new)', to_status: 'drafting', trigger: 'requirement-register', commit_sha: sha, actor: identity(ws), payload: { owners, changes } }),
          },
          warnings,
        };
      }
    } catch (e) {
      // commit 已是权威事实，不回滚；事件构造异常仅结构化 warning + audit（SDD §4.2）
      const why = String(e && e.message || e);
      auditLog(ws, { kind: 'register-events', cr, result: 'SKIPPED', why });
      registerMeta = { commit: { sha }, outbox: { status: null, owners: null }, warnings: [{ code: 'REGISTER_EVENTS_SKIPPED', why }] };
    }
  }
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
  const extra = registerMeta ? { commit: registerMeta.commit, outbox: registerMeta.outbox, warnings: registerMeta.warnings } : (outbox ? { outbox } : {});
  ok({ ok: r.ok, exit: r.exit, ...extra });
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
  crctl approve <cr_id> --stage <stage> --resign <reason>   受控历史审批迁移：仅限交互式终端迁移 via=crctl-approve；server-approve 必须由服务端重签 grant
  crctl validate <file>                          受控产物 schema 校验（validate-doc 代码化）
  crctl attempt <cr_id> --loop <ref>             review-loop 轮次唯一记账点；超限返回 LOOP_EXHAUSTED
  crctl review-record <cr_id> --stage <requirement|tech-design|code> --from <payload.yml> [--bump-attempt]
                                                schema 校验临时 payload 后写入 review-annotations（tech-design→sdd.yml）
  crctl review-note  <cr_id> [--stage <s>] --note <text>  approval.yml supplemental-reviews[] 追加（不接受 --by，身份 crctl 生成）
  crctl checkpoint-add <cr_id> --repo <r> --sha <sha> [--remote-ref <ref>]   _backlog checkpoints[] 追加 + 推送元数据（developing~writing-back）
  crctl owner-set     <cr_id> --role <requirement|development|test> --id <id>   双投影 owners 更新 + 正式移交 commit（非终态）
  crctl backlog-set   <cr_id> --field <prd-path|sdd-path> --value <v>    _backlog 白名单标量字段（硬拒 status 等受控字段）
  crctl inbox-emit   <cr_id> --event <e> [--to <a,b>] [--payload <json>]   _backlog notify-log 事件追加 + notify-pending 合并（非终态）
  crctl cr-init     --title <t> --owner-requirement <id> --owner-development <id> --owner-test <id>
                        [--year Y] [--summary <s>] [--source <s>] [--target-version <v>]   权威原子分配：内部 max+1 + 三文件 casWriteMulti 建档登记（注册元信息一次写齐）
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
  const gates = loadGates(ws);
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

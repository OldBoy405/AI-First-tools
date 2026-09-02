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
// CR-2026-031 TASK-03：YAML 子集解析器与 workspace 基础设施同源共享（lib/ 下，禁止在 crctl.mjs 复刻）。
import { parseYaml, matchEntryBlock } from './lib/yaml-subset.mjs';
import {
  deriveInstallRoot, TxError, resolveRepositories, registerCr, ensureWorkspace,
  classifyWorkspaceFreshness, syncWorkspaceToTrunk,
  assertSupportedBacklogSchemaText,
  buildReleaseSubjects, verifyReleaseSubjects, renderReleaseSubjects,
  matchFrontmatter, crMdStatusText, refreshCrMdUpdated, mergeCr, mergeStatus, resolveOperationalWorkspace,
  applyWriteback, archiveCr, checkUpgrade, checkpointCr, renderLoopText, testCr,
  normalizeTargetVersion, readCrMdTargetVersion, crWorktreePath, txWorkspacePath,
  resolveTargetSpecMode, resolveWritebackAuthorityStrict,
} from './lib/workspace-transactions.mjs';
import {
  FAULT_POINTS, faultPoint, nowIso,
  hasLedgerTransaction, recoverLedgerTransaction, beginLedgerTransaction, abortLedgerTransaction, finishLedgerTransaction,
} from './lib/durable-tx.mjs';

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

// nowIso 与 FAULT_POINTS 自 TASK-04 起 re-import 自 lib/durable-tx.mjs（唯一实现）。

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
  const configured = explicit || String(process.env.CRCTL_WORKSPACE || '').trim();
  if (configured) {
    const abs = path.resolve(configured);
    const source = explicit ? '--workspace' : 'CRCTL_WORKSPACE';
    if (!fs.existsSync(path.join(abs, 'change-requests'))) fail('WORKSPACE_NOT_FOUND', `${source} 指向的目录缺少 change-requests/: ${abs}`);
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

// CR-2026-031 TASK-02：最低支持 schema = cr-backlog/v2。v1 / 缺声明一律硬失败（UNSUPPORTED_BACKLOG_SCHEMA），
// migrate-backlog 永久迁移兼容已删除；TASK-05/09 的所有账本事务复用本检查。
function assertSupportedBacklogSchema(text) {
  try { assertSupportedBacklogSchemaText(text); } catch (e) {
    if (e instanceof TxError) fail(e.code, e.message, e.extra);
    throw e;
  }
}

function loadBacklogEntry(ws, cr) {
  const p = backlogPath(ws);
  const text = readFileChecked(p);
  if (!text) fail('BACKLOG_NOT_FOUND', `缺少 ${p}`);
  assertSupportedBacklogSchema(text);
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

function auditLogOnce(ws, record, dedupKey) {
  const p = path.join(ws, '.crctl', 'audit.log');
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)) {
      let item;
      try { item = JSON.parse(line); } catch { throw new Error(`audit.log 含非法 JSONL，拒绝追加 dedup 事实: ${p}`); }
      if (item.dedup_key === dedupKey) return false;
    }
  }
  auditLog(ws, { ...record, dedup_key: dedupKey });
  return true;
}

/* ────────────────────────── outbox 事件（P1 同步协议，CR-2026-002 TASK-02） ──────────
 * crctl 只写本地文件，网络交给 daemon（零依赖/离线优先）。
 * advance 成功 → status 事件（approve 级联的 advance 附带证据摘要）；
 * git push 成功 → checkpoint 事件（携带 HEAD sha，用于补全 --embedded 的空 commit_sha）。
 * 事件写入失败不阻塞主操作，只记 audit——outbox 是投影通道，git 才是权威。
 */

function emitOutboxEvent(ws, ev) {
  const installRoot = deriveInstallRoot(ws);
  try {
    // fault injection（测试钩子，与 CRCTL_FAULT_POINT 同风格）：模拟 outbox 落盘失败
    if (process.env.CRCTL_OUTBOX_FAIL) throw new Error('CRCTL_OUTBOX_FAIL injected');
    const dir = path.join(installRoot, '.crctl', 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const gi = path.join(installRoot, '.crctl', '.gitignore');
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
    const target = path.join(dir, name);
    if (ev.dedup_name && fs.existsSync(target)) {
      let existing;
      try { existing = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { throw new Error(`OUTBOX_DEDUP_INVALID: ${name}: ${e.message}`); }
      const comparable = (value) => JSON.stringify({
        v: value.v, event_kind: value.event_kind, cr_id: value.cr_id,
        from_status: value.from_status, to_status: value.to_status,
        trigger: value.trigger, commit_sha: value.commit_sha,
        actor: value.actor, evidence: value.evidence,
        // AIFIRST: CR-2026-052 TASK-08 (FR-12, SDD §4.4/DD-6): payload.detected_at
        // is the sole observation-time volatile field (regenerated per
        // emitDriftAudit via nowIso()). Excluding it lets the same drift be
        // observed twice during the pre-collection window without a spurious
        // OUTBOX_DEDUP_CONFLICT → EMIT_FAILED, matching the "leave one copy
        // while pending collection" semantics. The digest/summary fields stay
        // in the comparison so a real content change still conflicts (AC-12
        // third branch). New volatile time fields must be added here too.
        payload: (() => { const p = { ...(value.payload || {}) }; delete p.detected_at; return p; })(),
      });
      if (comparable(existing) === comparable(event)) return name;
      throw new Error(`OUTBOX_DEDUP_CONFLICT: ${name}`);
    }
    const tmp = path.join(dir, `.tmp-${process.pid}-${name}`);
    fs.writeFileSync(tmp, JSON.stringify(event, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, path.join(dir, name)); // 原子可见：先写临时名再 rename，防半写
    return name;
  } catch (e) {
    try { auditLog(installRoot, { kind: 'outbox', cr: ev.cr_id, event_kind: ev.event_kind, result: 'EMIT_FAILED', why: String(e && e.message || e) }); } catch { /* 双重失败只能放弃 */ }
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

function authorityWorkspace(ws, _cr, override) {
  const configured = override || String(process.env.CRCTL_OPERATIONAL_WORKSPACE || '').trim();
  return configured ? path.resolve(configured) : ws;
}

function runGateChecks(ws, cr, targetStatus, gates, opts = {}) {
  const gateWs = opts.operationalWorkspace || ws;
  const plannedExisting = opts.plannedExisting;
  if (plannedExisting != null) {
    if (!(plannedExisting instanceof Set)) fail('GATE_PLANNED_PATH_INVALID', 'plannedExisting 必须是 Set<string>');
    for (const rel of plannedExisting) {
      if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\\')
        || rel.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
        fail('GATE_PLANNED_PATH_INVALID', `plannedExisting 含非法 workspace-relative POSIX path: ${rel}`);
      }
      const resolved = path.resolve(gateWs, ...rel.split('/'));
      const root = path.resolve(gateWs) + path.sep;
      if (!resolved.startsWith(root)) fail('GATE_PLANNED_PATH_INVALID', `plannedExisting 越出 workspace: ${rel}`);
    }
  }
  const checks = gates.statusGates[targetStatus];
  const out = { target: targetStatus, checks: [], pass: true };
  if (!checks) { out.note = `gates.json 未对状态 ${targetStatus} 声明门禁（默认放行，仅校验状态机转换）`; return out; }
  for (const check of checks) {
    if (check.type === 'fileExists') {
      const p = path.join(gateWs, check.path.replaceAll('{cr}', cr).replaceAll('{spec}', opts.specId || '{spec}'));
      if (check.path.includes('{spec}') && !opts.specId) {
        out.checks.push({ type: check.type, path: check.path, ok: false, why: '需要 --spec-id 参数才能校验 specs 落点' });
      } else {
        const rel = path.relative(gateWs, p).split(path.sep).join('/');
        const exists = fs.existsSync(p) || (plannedExisting instanceof Set && plannedExisting.has(rel));
        out.checks.push({ type: check.type, path: p, ok: exists, why: exists ? null : '文件不存在' });
      }
    } else if (check.type === 'globNonEmpty') {
      const dir = path.join(gateWs, check.dir.replaceAll('{cr}', cr));
      const okv = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => new RegExp(check.pattern).test(f));
      out.checks.push({ type: check.type, dir, pattern: check.pattern, ok: okv, why: okv ? null : '目录缺失或无匹配文件' });
    } else if (check.type === 'passCondition') {
      const stageCfg = gates.approvalStages[check.stage];
      const r = evaluatePassCondition(gateWs, cr, stageCfg, gates, opts.evidence);
      let passOk = r.pass;
      let passWhy = null;
      if (r.pass && check.stage === 'dev-start') {
        // CR-2026-039 TASK-02：dev-plan PASS 证据 freshness（复用 gate 失败通道，不新增错误码/gates.json）
        const dp = readEvidenceDoc(gateWs, cr, 'change-requests/{cr}/review-annotations/dev-plan.yml', opts.evidence);
        const fr = devPlanFreshness(gateWs, cr, dp.exists ? dp.data : null);
        if (!fr.fresh) { passOk = false; passWhy = fr.why; }
      }
      out.checks.push({ type: check.type, stage: check.stage, ok: passOk, why: passWhy, detail: r.results, pipelineSource: r.source });
    } else if (check.type === 'approval') {
      const doc = readEvidenceDoc(gateWs, cr, 'change-requests/{cr}/approval.yml', opts.evidence);
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
        const currentDigest = canonicalEvidenceDigest(gateWs, cr, stageCfg);
        if (currentDigest && currentDigest !== section['evidence-digest']) {
          drift = 'EVIDENCE_DRIFT';
          why = `EVIDENCE_DRIFT：approval.yml#${check.section} 记录的证据摘要 ${section['evidence-digest'].slice(0, 16)}… 与当前重算 ${currentDigest.slice(0, 16)}… 不一致，证据在审批后被改动`;
          emitDriftAudit(ws, cr, stageKey || check.section, section['evidence-digest'], currentDigest);
        }
      } else if (okv && section['evidence-sha256-16']) {
        // 废弃字段兼容：历史审批（M0 口径）继续按单文件短哈希复核，不报错不阻塞（AC-7②）
        const evDoc = stageCfg?.evidence?.$default ? readEvidenceDoc(gateWs, cr, stageCfg.evidence.$default) : { exists: false };
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
      const r = checkDeliveryIndexComplete(gateWs, cr);
      out.checks.push({
        type: check.type, ok: r.ok, code: r.code, missing: r.missing || [],
        why: r.ok ? null : (r.why || `delivery/task 索引缺失 ${(r.missing || []).length} 项: ${(r.missing || []).join(', ')}`),
      });
    } else if (check.type === 'attemptsWithinLimit') {
      const r = readAttempts(gateWs, cr, check.loop, gates);
      // CR-2026-030 review repair（pass-at-max）：轮次到顶但最新评审 verdict=pass 时不判 exhausted——
      // pass 无需再自修复（与 review-code SKILL「pass 即可推进 code-reviewing」契约一致）；
      // block/缺证据仍 LOOP_EXHAUSTED 阻断，须人工处理。
      const passedAtLimit = r.exhausted && latestReviewVerdict(gateWs, cr, check.loop) === 'pass';
      const okv = !r.exhausted || passedAtLimit;
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
function ledgerTxKey(op, cr, stage = '') {
  return `${op}-${cr}${stage ? `-${stage}` : ''}`.replace(/[^A-Za-z0-9._-]/g, '-');
}

function syncLedgerIndex(ws, paths, caller) {
  const tracked = queryTrackedChanges(ws, { audit: false });
  const staged = new Set(tracked.ok ? tracked.staged : []);
  const syncPaths = paths.filter((p) => fs.existsSync(path.join(ws, ...p.split('/'))) || staged.has(p));
  if (!syncPaths.length) return;
  const add = controlledGit(ws, 'add', ['-A', '--', ...syncPaths], ws, caller);
  if (!add.ok) throw new TxError('TX_GIT_FAILED', `ledger rollback 后 index 恢复失败: ${add.stderr || add.message}`, { paths: syncPaths });
}

async function recoverLedgerCommand(ws, key) {
  const root = deriveInstallRoot(ws);
  if (!hasLedgerTransaction({ root, key })) return { recovered: false, paths: [] };
  const head = gitHeadSha(ws);
  const log = controlledGit(ws, 'log', ['--format=%B', '-1'], ws, 'crctl-ledger-recovery');
  const recovered = await runTxAsync(recoverLedgerTransaction({ root, key, currentHead: head, headMessage: log.ok ? log.stdout : '' }));
  if (recovered.rolledBack && recovered.paths.length && head) await runTxAsync((async () => syncLedgerIndex(ws, recovered.paths, 'crctl-ledger-recovery'))());
  return recovered;
}

async function injectLedgerFault(point) {
  return runTxAsync((async () => faultPoint(point))());
}

async function beginLedgerCommand(ws, key, writes, commitRequired) {
  const inputDigest = sha256(JSON.stringify(writes.map((w) => ({ path: path.relative(ws, w.path).split(path.sep).join('/'), expectedHash: w.expectedHash, afterSha256: sha256(w.newText) }))));
  return runTxAsync(beginLedgerTransaction({
    root: deriveInstallRoot(ws), targetRoot: ws, key, inputDigest, writes,
    headBefore: gitHeadSha(ws), commitRequired,
  }));
}
/* ────────────────────────── 账本编辑纯函数（CR-2026-019） ──────────────────────────
 * 行级正则改写，纯 string→string（SDD §1.1）；匹配不到一律 fail 硬失败（纪律 #1），
 * 禁止静默返回原文（T04 教训）。三个子命令只做账本编辑、不发 status 事件（纪律 #5：
 * 状态唯一写者仍是 advance）。
 */

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

// CR-2026-027 FR-8/TASK-03（CR-2026-039 TASK-03 起时间字段收敛为单一 updated）：cr.md 状态文本生成纯函数（status + updated 更新），供 approve 原子提交在内存生成候选文本。
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
  // CR-2026-031 TASK-02：v1 回退读（backlog entry.status）随永久迁移兼容一并删除；cr.md 是状态唯一权威。
  fail('CR_MD_STATUS_MISSING', `${cr} 的 cr.md 缺少 status 字段（_backlog.yml 不再是状态来源）`);
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
  if (state.mixedLayout) warnings.push({ code: 'MIXED_LAYOUT_WARN', message: `cr.md status=${current} 与 _backlog.yml status=${snap.entry.status} 不一致，以 cr.md 为准；_backlog.yml 条目中的 status 行是 v2 schema 下的残留字段，应清除` });
  const diverged = detectStatusDivergence(ws, cr, current);
  if (diverged) warnings.push(diverged);
  ok({
    cr, status: current,
    source: { backlog: snap.path, backlogSha256: snap.hash.slice(0, 12), crMd: path.join(crDir(ws, cr), 'cr.md'), stateMachine: source },
    owners: snap.entry.owners || null,
    legalNext: nexts,
    reviewLoops: loops,
    gateBlockers: missing,
    ...(warnings.length ? { warnings } : {}),
  });
}

function cmdGate(ws, cr, gates, flags) {
  if (!flags.for) fail('BAD_ARGS', 'gate 需要 --for <target-status>');
  if (flags.mode === 'pre-review') {
    if (flags.for !== 'requirement-reviewing') fail('BAD_ARGS', '--mode pre-review 仅支持 --for requirement-reviewing');
    const result = runPreReviewGateChecks(ws, cr);
    ok(result);
    if (!result.pass) {
      const why = result.checks.filter((c) => !c.ok).map((c) => c.why).filter(Boolean).join('；');
      process.stderr.write(JSON.stringify({ error: { code: 'GATE_BLOCKED', message: `pre-review 门禁未通过${why ? '：' + why : ''}`, gate: result } }, null, 2) + '\n');
      process.exit(1);
    }
    return;
  }
  const result = runGateChecks(ws, cr, flags.for, gates, flags);
  ok(result);
  if (!result.pass) process.exit(1);
}

function preflightAdvance(ws, cr, gates, flags) {
  const dataWs = authorityWorkspace(ws, cr, flags.operationalWorkspace);
  if (!flags.to || !flags.trigger) fail('BAD_ARGS', 'advance 需要 --to <status> --trigger <trigger>');
  const { sm } = loadStateMachine(ws);
  const state = resolveCrState(dataWs, cr);
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
  // CR-2026-060 G1（SDD §4.7）：advance 层零写入 guard——runGateChecks 之前，仅 requirement-reviewing；
  // new mode + unassigned → GATE_BLOCKED/TARGET_VERSION_UNASSIGNED，preflightAdvance 自身无写入。
  if (flags.to === 'requirement-reviewing') {
    assertRequirementReviewAdvanceGuard(ws, cr);
  }
  // FR-4（CR-2026-020 复盘）：目标态门禁需校验 specs 落点（path 含 {spec}）却缺 --spec-id 时，
  // 命令入口即 fail-fast，不埋进 GATE_BLOCKED.checks[].why（--spec-id 曾同坑犯两次）。
  const targetChecks = gates.statusGates[flags.to] || [];
  if (!flags.specId && targetChecks.some((c) => typeof c.path === 'string' && c.path.includes('{spec}'))) {
    fail('BAD_ARGS', `advance --to ${flags.to} 需要 --spec-id <specId>：该目标态门禁需校验 specs 落点（specs/{spec}/...）。请补 --spec-id 后重试。`);
  }
  const gate = runGateChecks(ws, cr, flags.to, gates, { ...flags, operationalWorkspace: dataWs });
  if (!gate.pass) {
    // FR-5：把未过门禁的具体原因提升进错误摘要，避免调用方漏读 checks[].why
    const why = gate.checks.filter((c) => !c.ok).map((c) => c.why).filter(Boolean).join('；');
    fail('GATE_BLOCKED', `目标状态 ${flags.to} 的门禁未通过，拒绝写入${why ? '：' + why : ''}`, { gate });
  }
  const crMdPath = path.join(crDir(dataWs, cr), 'cr.md');
  const beforeText = readFileChecked(crMdPath);
  if (beforeText == null) fail('CR_MD_WRITE_FAILED', `advance 读取 cr.md 失败: ${crMdPath}`);
  return {
    from: current, to: flags.to, trigger: flags.trigger, gate,
    path: `change-requests/${cr}/cr.md`, beforeText, beforeSha256: sha256(beforeText),
  };
}

// CR-2026-030 TASK-04（SDD §4.9）：advance 内核——不打印 JSON，供 cmdAdvance 与 reject 回退共用。
// “Git 是权威”：standalone commit 失败时不得发 status outbox；只有 commit 成功（或 embedded 由调用方提交）
// 才返回 committed=true 并以真实/占位 SHA 发 outbox。返回 {committed, commitDetail, ...}。
function performAdvance(ws, cr, gates, flags) {
  const dataWs = authorityWorkspace(ws, cr, flags.operationalWorkspace);
  const candidate = preflightAdvance(ws, cr, gates, { ...flags, operationalWorkspace: dataWs });
  const current = candidate.from;
  const crmd = updateCrMdStatus(dataWs, cr, flags.to);
  if (!crmd.updated) fail('CR_MD_WRITE_FAILED', `advance 写入 cr.md 失败: ${crmd.why}`);
  auditLog(ws, { kind: 'advance', cr, from: current, to: flags.to, trigger: flags.trigger, by: identity(ws) });
  const result = { advanced: true, cr, from: current, to: flags.to, trigger: flags.trigger, files: [crmd.path], crMd: crmd };
  if (flags.embedded || flags['no-commit']) {
    result.commit = 'embedded：由调用方在同一事务中提交上述文件';
  } else {
    const msg = `[cr] status ${cr} ${current} -> ${flags.to}`;
    const addR = controlledGit(ws, 'add', [`change-requests/${cr}/cr.md`], dataWs, 'crctl-advance');
    const commitR = addR.ok ? controlledGit(ws, 'commit', ['-m', msg], dataWs, 'crctl-advance') : addR;
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
    if (pendingStage) outboxEvidence = collectOutboxEvidence(dataWs, cr, pendingStage);
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
      trigger: flags.trigger, commit_sha: gitHeadSha(ws, dataWs),
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
// assertCandidateStatus → durable ledger transaction → controlledGit add/commit 单次提交 → commit 成功后发 status outbox。
// 失败边界：gate/候选校验失败零写入；CAS 冲突两文件均不写；commit 失败两文件共同留在工作区、不发 outbox、返回结构化恢复信息。
async function approveAndAdvance(ws, cr, gates, stage, stageCfg, ctx) {
  const { approver, via, evidenceHash, grant, outboxEvidence, specId, fromStatus } = ctx;
  // TASK-06（SDD §3.4）：code 审批重核机器注入的 release-subjects，任一漂移零写入拒绝；
  // TTY 与 grant 两条路径在此单缝汇合，通过后原样复制到 approval.yml#code.release-subjects。
  if (stageCfg.approvalSection === 'code') {
    ctx.releaseSubjects = await runTxAsync((async () => {
      const snap = readCodeReleaseSubjects(ws, cr);
      if (!snap) fail('RELEASE_SUBJECT_DRIFT', 'code 审批需要 review-annotations/code.yml#release-subjects（机器注入），当前缺失或形状非法，拒绝签入', { kind: 'missing' });
      const v = await verifyReleaseSubjects(resolveRepositories(ws), cr, snap);
      if (!v.ok) fail('RELEASE_SUBJECT_DRIFT', `release-subjects 漂移（kind=${v.kind}），零写入拒绝审批`, { kind: v.kind, ...v.details });
      return snap;
    })());
  }
  const crMdP = path.join(crDir(ws, cr), 'cr.md');
  const approvalP = path.join(crDir(ws, cr), 'approval.yml');
  const crMdText = readFileChecked(crMdP);
  if (crMdText == null) fail('CR_MD_WRITE_FAILED', `cr.md 不存在: ${crMdP}`);
  // 1) 内存生成候选文本（零落盘）
  const approvalText = buildApprovalSectionText(approvalP, stageCfg, approver, evidenceHash, { via, grant, releaseSubjects: ctx.releaseSubjects });
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
  // 4) 两文件进入 command-level durable transaction；commit 前崩溃会在同命令下次启动时整体回滚。
  const approvalHash = readFileChecked(approvalP) == null ? null : sha256(readFileChecked(approvalP));
  const ledgerTx = await beginLedgerCommand(ws, ledgerTxKey('approve', cr, stage), [
    { path: approvalP, expectedHash: approvalHash, newText: approvalText },
    { path: crMdP, expectedHash: sha256(crMdText), newText: nextCrMd },
  ], true);
  // 5) 单次 commit（approval.yml + cr.md 同批可见），tx trailer 供 crash-after-commit 恢复判定。
  const addR = controlledGit(ws, 'add', [`change-requests/${cr}/approval.yml`, `change-requests/${cr}/cr.md`], ws, 'crctl-approve');
  const msg = `[cr] approve ${cr} ${stage} approval+status -> ${stageCfg.to}`;
  const commitMsg = `${msg}\n\nAI-First-Tx: ${ledgerTx.txId}`;
  const commitR = addR.ok ? controlledGit(ws, 'commit', ['-m', commitMsg], ws, 'crctl-approve') : addR;
  if (!commitR.ok) {
    const rolled = await runTxAsync(abortLedgerTransaction(ledgerTx));
    if (rolled.paths.length) await runTxAsync((async () => syncLedgerIndex(ws, rolled.paths, 'crctl-approve'))());
  } else {
    await injectLedgerFault('ledger-after-commit');
    await runTxAsync(finishLedgerTransaction(ledgerTx));
  }
  auditLog(ws, { kind: 'approve', cr, stage, approver, via, result: commitR.ok ? 'approved' : 'commit-failed', commit: commitR.ok ? msg : 'rolled-back' });
  const result = { advanced: commitR.ok, op: 'approve', cr, stage, from: fromStatus, to: stageCfg.to, trigger: stageCfg.trigger, crMd: { updated: commitR.ok, path: crMdP }, files: [approvalP, crMdP], commit: commitR.ok ? { message: msg } : { failed: true, detail: commitR, rolledBack: true } };
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

async function cmdApprove(ws, cr, gates, flags) {
  const stage = flags.stage;
  const stageCfg = gates.approvalStages[stage];
  if (!stageCfg) fail('BAD_ARGS', `--stage 必须是 ${Object.keys(gates.approvalStages).join(' | ')}`);
  await recoverLedgerCommand(ws, ledgerTxKey('approve', cr, stage));
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
  rl.question(`以 approver=${approver} 批准该阶段？只有输入 y 或 yes 才会写入 approval.yml [y/N] `, async (answer) => {
    rl.close();
    // CR-2026-044 FR-09：四 stage 共享入口接受 trim 后大小写不敏感的 y|yes；其余输入保持既有 reject 回退
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
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
    await approveAndAdvance(ws, cr, gates, stage, stageCfg, {
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
      // approveAndAdvance 内部已 ok() 输出成功结果并处理 commit 失败退出；TASK-06 起为 async（code 重核），返回 promise 给调用链
      return approveAndAdvance(ws, cr, gates, stage, stageCfg, {
        approver: grant.approver, via: 'server-approve', evidenceHash: digest || null, grant,
        outboxEvidence: collectOutboxEvidence(ws, cr, stageCfg),
        specId: flags['spec-id'], fromStatus: current,
      });
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
  const lines = [
    `${section}:`,
    `  approver: "${approver}"`,
    `  approved-at: "${nowIso()}"`,
    `  via: ${opts.via || 'crctl-approve'}`,
    evidenceHash ? `  evidence-digest: "${evidenceHash}"` : null,
    g ? `  key-id: "${g.key_id}"` : null,
    g ? `  signature: "${g.signature}"` : null,
    g ? `  grant-approved-at: "${g.approved_at}"` : null,
    `  target-status: ${stageCfg.to}`,
  ].filter(Boolean);
  // TASK-06：release-subjects 原样复制到 approval.yml#code 段内（与 annotation 块字节语义一致，缩进 2 格嵌套）
  if (opts.releaseSubjects) lines.push(...renderReleaseSubjects(opts.releaseSubjects).map((l) => `  ${l}`));
  return lines.join('\n');
}

/** TASK-06：读取 review-annotations/code.yml#release-subjects（机器注入块）；缺失/非法返回 null。 */
function readCodeReleaseSubjects(ws, cr) {
  const p = path.join(crDir(ws, cr), 'review-annotations', REVIEW_STAGE_FILES.code);
  const text = readFileChecked(p);
  if (text == null) return null;
  const doc = parseYaml(text.replaceAll('\r\n', '\n'));
  const rs = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc['release-subjects'] : null;
  return rs && typeof rs === 'object' && !Array.isArray(rs) ? rs : null;
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
    assertSupportedBacklogSchema(text); // CR-2026-031 TASK-02：v1 布局不再支持，validate 同样硬失败
    const doc = parseYaml(text);
    const list = Array.isArray(doc) ? doc : doc['change-requests'] || doc.backlog || doc.items || [];
    for (const e of list) {
      const where = `_backlog.yml#${e?.id || '?'}`;
      pushIf(!e.id, `${where}: 缺少 id`);
      // v2 布局：status/updated-at 已撤出，不应再出现
      warnIf(e.status !== undefined, `${where}: LEGACY_STATUS_FIELD — v2 schema 条目仍含 status 行（值=${e.status}），应清除`);
      warnIf(e['updated-at'] !== undefined, `${where}: LEGACY_STATUS_FIELD — v2 schema 条目仍含 updated-at 行，应清除`);
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


function taskCardInvalid(file, field, why) {
  fail('TASK_CARD_INVALID', `${file} 的 ${field} 非法：${why}`, { file, field });
}

function loadTaskCards(ws, cr) {
  const dir = path.join(crDir(ws, cr), 'tasks');
  const names = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => /^TASK-\d{2}\.md$/.test(name)).sort((a, b) => Number(a.slice(5, 7)) - Number(b.slice(5, 7)))
    : [];
  if (!names.length) fail('TASK_SET_EMPTY', `${dir} 中没有 TASK-NN.md`);
  const cards = [];
  const ids = new Set();
  for (const file of names) {
    const p = path.join(dir, file);
    const raw = readFileChecked(p);
    if (raw == null) fail('TASK_SET_CHANGED', `读取后 TASK 文件消失: ${file}`, { file });
    const fm = matchFrontmatter(raw.replaceAll('\r\n', '\n'));
    if (!fm) taskCardInvalid(file, 'frontmatter', '缺失');
    let doc;
    try { doc = parseYaml(fm.body); }
    catch (e) { taskCardInvalid(file, 'frontmatter', String(e && e.message || e)); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) taskCardInvalid(file, 'frontmatter', '顶层必须是映射');
    const nn = file.slice(5, 7);
    const expectedId = `${cr}-TASK-${nn}`;
    if (doc.id !== expectedId) taskCardInvalid(file, 'id', `必须为 ${expectedId}`);
    if (doc.type !== 'TASK') taskCardInvalid(file, 'type', '必须为 TASK');
    if (doc['cr-ref'] !== cr) taskCardInvalid(file, 'cr-ref', `必须为 ${cr}`);
    if (typeof doc.title !== 'string' || !doc.title.trim()) taskCardInvalid(file, 'title', '必须为非空字符串');
    if (doc.status !== 'pending') taskCardInvalid(file, 'status', '初始化时必须为 pending');
    if (typeof doc.estimate !== 'string' || !/^[1-9]\d*h$/.test(doc.estimate)) taskCardInvalid(file, 'estimate', '必须为正整数小时，如 4h');
    if (!Array.isArray(doc['depends-on']) || doc['depends-on'].some((v) => typeof v !== 'string')) taskCardInvalid(file, 'depends-on', '必须为字符串数组');
    if (ids.has(doc.id)) taskCardInvalid(file, 'id', '重复');
    ids.add(doc.id);
    cards.push({
      file, number: Number(nn), id: doc.id, title: doc.title, status: doc.status,
      estimate: doc.estimate, dependsOn: doc['depends-on'], sourceSha256: sha256(raw),
    });
  }
  const byId = new Map(cards.map((card) => [card.id, card]));
  for (const card of cards) {
    const unknown = card.dependsOn.filter((id) => !byId.has(id));
    if (unknown.length) fail('DEPENDS_ON_UNKNOWN', `${card.id} 引用了不存在的 TASK：${unknown.join(', ')}`, { taskId: card.id, unknown });
  }
  const visiting = new Set(), visited = new Set();
  function visit(id, pathIds) {
    if (visiting.has(id)) fail('TASK_DEPENDENCY_CYCLE', `TASK 依赖成环：${[...pathIds, id].join(' -> ')}`, { cycle: [...pathIds, id] });
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).dependsOn) visit(dep, [...pathIds, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const card of cards) visit(card.id, []);
  return { dir, names, cards };
}

function renderTaskIndex(cr, cards) {
  const lines = [`cr-id: ${cr}`, 'tasks:'];
  for (const card of cards) {
    lines.push(`  - id: ${card.id}`);
    lines.push(`    title: ${yamlStringScalar(card.title)}`);
    lines.push('    status: pending');
    lines.push(`    estimate: ${card.estimate}`);
    lines.push(`    depends-on: [${card.dependsOn.join(', ')}]`);
  }
  return lines.join('\n') + '\n';
}

function renderTaskIndexWithProgress(cr, entries) {
  const lines = [`cr-id: ${cr}`, 'tasks:'];
  for (const entry of entries) {
    lines.push(`  - id: ${entry.id}`);
    lines.push(`    title: ${yamlStringScalar(entry.title)}`);
    lines.push(`    status: ${entry.status}`);
    if (entry.doneAt) lines.push(`    done-at: ${yamlStringScalar(entry.doneAt)}`);
    lines.push(`    estimate: ${entry.estimate}`);
    lines.push(`    depends-on: [${entry.dependsOn.join(', ')}]`);
  }
  return lines.join('\n') + '\n';
}

function guardTaskIndexHasNoProgress(text, cr) {
  let doc;
  try { doc = parseYaml(text.replaceAll('\r\n', '\n')); }
  catch { fail('TASK_INDEX_HAS_PROGRESS', '现有 tasks/_index.yml 无法证明全部 pending，拒绝覆盖'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)
      || (doc['cr-id'] != null && doc['cr-id'] !== cr) || !Array.isArray(doc.tasks) || !doc.tasks.length
      || doc.tasks.some((task) => !task || typeof task !== 'object' || Array.isArray(task)
        || typeof task.id !== 'string' || task.status !== 'pending' || Object.hasOwn(task, 'done-at'))) {
    fail('TASK_INDEX_HAS_PROGRESS', '现有 tasks/_index.yml 无法证明全部 pending，拒绝覆盖');
  }
}

function assertTaskCardsFresh(set) {
  const currentNames = fs.existsSync(set.dir)
    ? fs.readdirSync(set.dir).filter((name) => /^TASK-\d{2}\.md$/.test(name)).sort((a, b) => Number(a.slice(5, 7)) - Number(b.slice(5, 7)))
    : [];
  if (JSON.stringify(currentNames) !== JSON.stringify(set.names)) fail('TASK_SET_CHANGED', 'TASK 文件集合在读取后发生变化');
  for (const card of set.cards) {
    const raw = readFileChecked(path.join(set.dir, card.file));
    if (raw == null || sha256(raw) !== card.sourceSha256) fail('TASK_SET_CHANGED', `TASK 文件在读取后发生变化: ${card.file}`, { file: card.file });
  }
}

function createFileExclusive(p, text) {
  let fd;
  let created = false;
  try {
    fd = fs.openSync(p, 'wx');
    created = true;
    fs.writeFileSync(fd, text, 'utf8');
    fs.closeSync(fd);
    fd = undefined;
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve original error */ } }
    if (created) { try { fs.unlinkSync(p); } catch { /* preserve original error */ } }
    if (e && e.code === 'EEXIST') fail('CAS_CONFLICT', `${p} 在读取后被其他进程创建，本次写入中止。请重新执行。`);
    throw e;
  }
}

function cmdTaskAppend(ws, cr) {
  const state = resolveCrState(ws, cr);
  if (state.status !== 'developing') fail('ILLEGAL_LEDGER_STATE', `task append 仅允许在 developing 执行，当前 ${state.status}`, { current: state.status, expect: ['developing'] });
  const set = loadTaskCards(ws, cr);
  const p = path.join(set.dir, '_index.yml');
  const current = readFileChecked(p);
  if (current == null) fail('TASK_INDEX_NOT_FOUND', `缺少 ${p}；首次初始化必须使用 task init`);
  let doc;
  try { doc = parseYaml(current.replaceAll('\r\n', '\n')); }
  catch { fail('TASK_INDEX_SHAPE', '现有 tasks/_index.yml 无法解析，拒绝追加'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || (doc['cr-id'] ?? doc['cr-ref']) !== cr || !Array.isArray(doc.tasks) || !doc.tasks.length) {
    fail('TASK_INDEX_SHAPE', '现有 tasks/_index.yml 结构非法，拒绝追加');
  }
  const cardsById = new Map(set.cards.map((card) => [card.id, card]));
  const seen = new Set();
  const entries = [];
  let maxExistingNumber = 0;
  for (const task of doc.tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.id !== 'string' || seen.has(task.id)) {
      fail('TASK_INDEX_SHAPE', '现有 tasks/_index.yml 含非法或重复 TASK 条目，拒绝追加');
    }
    seen.add(task.id);
    const card = cardsById.get(task.id);
    if (!card) fail('TASK_INDEX_DRIFT', `${task.id} 已在索引中但对应 TASK 卡缺失，拒绝追加`);
    if (task.title !== card.title || task.estimate !== card.estimate
        || !Array.isArray(task['depends-on']) || JSON.stringify(task['depends-on']) !== JSON.stringify(card.dependsOn)) {
      fail('TASK_INDEX_DRIFT', `${task.id} 的 title/estimate/depends-on 与 TASK 卡不一致，拒绝追加`);
    }
    if (!['pending', 'done'].includes(task.status)
        || (task.status === 'done' && typeof task['done-at'] !== 'string')
        || (task.status === 'pending' && Object.hasOwn(task, 'done-at'))) {
      fail('TASK_INDEX_SHAPE', `${task.id} 的 status/done-at 结构非法，拒绝追加`);
    }
    maxExistingNumber = Math.max(maxExistingNumber, card.number);
    entries.push({ ...card, status: task.status, doneAt: task['done-at'] || null });
  }
  const missing = set.cards.filter((card) => !seen.has(card.id));
  if (missing.some((card) => card.number <= maxExistingNumber)) {
    fail('TASK_APPEND_ORDER', 'task append 只允许在现有最大编号之后追加 TASK，拒绝插入或重排历史条目');
  }
  assertTaskCardsFresh(set);
  if (!missing.length) return ok({ op: 'task-append', cr, file: p, appended: [], taskCount: entries.length, changed: false });
  const appended = missing.map((card) => card.id);
  const next = renderTaskIndexWithProgress(cr, [...entries, ...missing.map((card) => ({ ...card, status: 'pending', doneAt: null }))]);
  casWrite(p, sha256(current), next);
  auditLog(ws, { kind: 'ledger', op: 'task-append', cr, actor: identity(ws), appended, changed: true });
  ok({ op: 'task-append', cr, file: p, appended, taskCount: entries.length + missing.length,
    totalEstimateHours: set.cards.reduce((sum, card) => sum + Number.parseInt(card.estimate, 10), 0), changed: true });
}

/** `--count-hint N` 写入前校验（CR-2026-060 G3/AC-08）：在 render/casWrite/createFileExclusive/audit 之前校验卡片集 id 集合恰为 {cr}-TASK-01..{cr}-TASK-{pad2(N)}，失败 TASK_COUNT_MISMATCH 零写入；缺省行为与现行完全一致。 */
function assertCountHint(cr, cards, hint) {
  if (hint === undefined || hint === null || hint === true) return;
  const n = Number(hint);
  if (!Number.isInteger(n) || n <= 0) fail('BAD_ARGS', 'task init --count-hint 必须是正整数（N >= 1）');
  const expected = [];
  for (let i = 1; i <= n; i++) expected.push(`${cr}-TASK-${String(i).padStart(2, '0')}`);
  const actual = cards.map((c) => c.id);
  const expectedSet = new Set(expected);
  const ok = cards.length === n
    && actual.every((id) => expectedSet.has(id))
    && new Set(actual).size === n;
  if (!ok) {
    fail('TASK_COUNT_MISMATCH', `task init --count-hint ${n} 写入前校验失败：期望 TASK 集 = [${expected.join(', ')}]，实际 = [${actual.join(', ')}]（数量/缺号/重号/越界），零写入`, { expected, actual });
  }
}

function cmdTaskInit(ws, cr, flags) {
  const state = resolveCrState(ws, cr);
  const legal = ['tech-design-reviewed', 'task-breakdown'];
  if (!legal.includes(state.status)) fail('ILLEGAL_LEDGER_STATE', `task init 仅允许在前置态 ${legal.join('/')} 执行，当前 ${state.status}`, { current: state.status, expect: legal });
  const set = loadTaskCards(ws, cr);
  // CR-2026-060 G3（AC-08）：--count-hint 写入前校验，位于 render/CAS/audit 之前，失败零写入。
  assertCountHint(cr, set.cards, flags && flags['count-hint']);
  const canonical = renderTaskIndex(cr, set.cards);
  const p = path.join(set.dir, '_index.yml');
  const current = readFileChecked(p);
  if (current != null) {
    guardTaskIndexHasNoProgress(current, cr);
    const expectedHash = sha256(current);
    assertTaskCardsFresh(set);
    if (current.replaceAll('\r\n', '\n') === canonical) {
      return ok({ op: 'task-init', cr, file: p, taskCount: set.cards.length,
        totalEstimateHours: set.cards.reduce((sum, card) => sum + Number.parseInt(card.estimate, 10), 0), changed: false });
    }
    casWrite(p, expectedHash, canonical);
  } else {
    assertTaskCardsFresh(set);
    createFileExclusive(p, canonical);
  }
  auditLog(ws, { kind: 'ledger', op: 'task-init', cr, actor: identity(ws), taskCount: set.cards.length, changed: true });
  ok({ op: 'task-init', cr, file: p, taskCount: set.cards.length,
    totalEstimateHours: set.cards.reduce((sum, card) => sum + Number.parseInt(card.estimate, 10), 0), changed: true });
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

function cmdAttempt(ws, cr, gates, flags) {
  if (!flags.loop) fail('BAD_ARGS', 'attempt 需要 --loop <review ref>（如 review-code / write-test-report）');
  const r = bumpAttempt(ws, cr, flags.loop, gates);
  auditLog(ws, { kind: 'attempt', cr, loop: flags.loop, current: r.current });
  ok(r);
}

/* ────────────────────────── review-loop reset（CR-2026-049 人工重置）─────────────────────────
 * 唯一受控的人工出口：review-loop 耗尽（maxAttempts）后，由人类在交互式终端确认处理完毕，
 * 开启下一个 review cycle（current-cycle+1、current-attempt 归零、保留 attempts[] 历史）。
 * 与 approve 同强度的人类在环硬检查（非 TTY 一律拒绝，无旁路），写审计留 reason，禁止在未耗尽时调用。 */
function cmdReviewLoopReset(ws, cr, gates, flags) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('NOT_TTY', 'review-loop reset 仅接受交互式 TTY 会话（人类在环），无旁路参数或环境变量');
  }
  const loopRef = flags.loop;
  if (!loopRef) fail('BAD_ARGS', 'review-loop reset 需要 --loop <review ref>（如 write-test-report / review-code）');
  const reason = flags.reason == null ? '' : String(flags.reason);
  if (!reason.trim()) fail('BAD_ARGS', 'review-loop reset 需要 --reason <人工处理说明>（写入审计，禁止空）');
  const state = readAttempts(ws, cr, loopRef, gates);
  if (!state.exhausted) {
    fail('LOOP_NOT_EXHAUSTED', `${loopRef} 尚未耗尽（current=${state.current}/${state.max}），无需重置`, { current: state.current, max: state.max });
  }
  const p = attemptsFilePath(ws, cr);
  const all = state.data.loops ? state.data : { loops: {} };
  const prev = all.loops[loopRef] || { 'current-cycle': 1, 'current-attempt': 0, attempts: [] };
  const fromCycle = prev['current-cycle'] || 1;
  const nextCycle = fromCycle + 1;
  all.loops[loopRef] = {
    'current-cycle': nextCycle,
    'current-attempt': 0,
    attempts: [...(prev.attempts || [])], // 旧轮次保留（cycle 标签不变），审计链不断
  };
  // review-loop.yml 由 crctl 全量生成（crctl 独占该文件，无 CAS 冲突面），复用同一渲染器
  fs.writeFileSync(p, renderLoopText(all.loops), 'utf8');
  auditLog(ws, { kind: 'review-loop-reset', cr, loop: loopRef, fromCycle, toCycle: nextCycle, reason, by: identity(ws) });
  ok({ op: 'review-loop-reset', cr, loop: loopRef, 'current-cycle': nextCycle, 'current-attempt': 0, file: p, reason });
}

/* ────────────────────────── review-record（S1，CR-2026-021 TASK-02） ──────────────────────────
 * 判断/写入分离（SDD §4.1）：agent 把评审判断写进非受控临时 payload（默认 .crctl/tmp/review-{stage}.yml，
 * 已被 .crctl/.gitignore 的 `*` 规则忽略），crctl 只做确定性部分——schema 校验 → stage→文件名显式映射
 * （tech-design→sdd.yml 非同名，与门禁读取口径对齐）→ 注入 reviewer/reviewed-at → casWrite canonical →
 * 可选级联 attempt → 删除临时 payload。
 */
const REVIEW_STAGE_FILES = { requirement: 'requirement.yml', 'tech-design': 'sdd.yml', code: 'code.yml', 'dev-plan': 'dev-plan.yml' };
const REVIEW_STAGE_LOOPS = { requirement: 'review-requirement', 'tech-design': 'review-tech-design', code: 'review-code', 'dev-plan': 'review-dev-plan' };

// CR-2026-030 review repair（pass-at-max）：attempt 计数到顶但最新一轮评审 verdict=pass 时无需再自修复。
// loop→stage 反查 REVIEW_STAGE_LOOPS，读取对应 canonical 评审文件的 verdict；非评审 loop 或文件缺失/不可解析返回 null（fail-closed，不豁免）。
function latestReviewVerdict(ws, cr, loopRef) {
  const stage = Object.keys(REVIEW_STAGE_LOOPS).find((s) => REVIEW_STAGE_LOOPS[s] === loopRef) || null;
  if (!stage) return null;
  const p = path.join(crDir(ws, cr), 'review-annotations', REVIEW_STAGE_FILES[stage]);
  const text = readFileChecked(p);
  if (text == null) return null;
  const doc = parseYaml(text.replaceAll('\r\n', '\n')) || {};
  return typeof doc.verdict === 'string' ? doc.verdict : null;
}
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

// CR-2026-039 TASK-01（SDD §4.1）：dev-plan composite digest 唯一权威定义。
// entries = plan.md 首项 + tasks/ 下全部 TASK-*.md（workspace-relative POSIX path 字符串升序，plan.md 自然居首），
// 每项 { path, content }（键序固定），content 为 CRLF→LF 规范化全文（纪律 #1）；JSON.stringify 无空白后 UTF-8 sha256。
// 任一预期缺失返回带 repairTarget 的结构化失败（不跳过、不降级为空集合）；权限/I/O 异常继续抛出，不宽泛 catch。
function devPlanCompositeDigest(ws, cr) {
  const planRel = `change-requests/${cr}/plan.md`;
  const planRaw = readFileChecked(path.join(ws, planRel));
  if (planRaw == null) return { ok: false, repairTarget: 'write-dev-plan', why: 'plan.md 缺失' };
  const tasksDir = path.join(ws, 'change-requests', cr, 'tasks');
  if (!fs.existsSync(tasksDir)) return { ok: false, repairTarget: 'write-dev-tasks', why: 'tasks/ 缺失' };
  const names = fs.readdirSync(tasksDir).filter((f) => /^TASK-.*\.md$/.test(f)).sort();
  if (names.length === 0) return { ok: false, repairTarget: 'write-dev-tasks', why: 'TASK-*.md 集合为空' };
  const entries = [{ path: planRel, content: planRaw.replaceAll('\r\n', '\n') }];
  for (const f of names) {
    const taskRaw = readFileChecked(path.join(tasksDir, f));
    if (taskRaw == null) return { ok: false, repairTarget: 'write-dev-tasks', why: `TASK 文件缺失: ${f}` };
    entries.push({ path: `change-requests/${cr}/tasks/${f}`, content: taskRaw.replaceAll('\r\n', '\n') });
  }
  return { ok: true, digest: sha256(JSON.stringify(entries)) };
}

// CR-2026-039 TASK-02（SDD §4.3）：dev-plan PASS 证据 freshness 唯一判定（cmdNext 与 runGateChecks 两消费点共用）。
// legacy 无 digest → review-dev-plan；subject 不完整 → 透传 helper repairTarget；digest 漂移 → review-dev-plan。
function devPlanFreshness(ws, cr, annData) {
  const recSha = annData && typeof annData === 'object' ? annData['subject-sha256'] : null;
  if (recSha == null) return { fresh: false, repairTarget: 'review-dev-plan', why: 'dev-plan annotation 无 subject-sha256（legacy 或畸形），无法判 freshness，重审刷新证据' };
  const cur = devPlanCompositeDigest(ws, cr);
  if (!cur.ok) return { fresh: false, repairTarget: cur.repairTarget, why: `dev-plan subject 不完整：${cur.why}` };
  if (cur.digest !== recSha) return { fresh: false, repairTarget: 'review-dev-plan', why: `dev-plan digest 漂移（annotation 记录 ${String(recSha).slice(0, 16)}…，当前重算 ${cur.digest.slice(0, 16)}…；plan/TASK 在评审后被改动），重审刷新证据` };
  return { fresh: true };
}

async function cmdReviewRecord(ws, cr, gates, flags) {
  const stage = flags.stage;
  const fileName = REVIEW_STAGE_FILES[stage];
  if (!fileName) fail('STAGE_UNKNOWN', `--stage 必须是 ${Object.keys(REVIEW_STAGE_FILES).join(' | ')}`);
  await recoverLedgerCommand(ws, ledgerTxKey('review', cr, stage));
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
  // TASK-06（SDD §3.4）：release-subjects 只由 crctl 机器注入；payload 提供/覆盖一律零写入拒绝
  if (stage === 'code' && payload['release-subjects'] !== undefined) {
    fail('RELEASE_SUBJECTS_FORGED', 'release-subjects 只能由 crctl review-record 机器注入，模型 payload 不得提供或覆盖', { stage });
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
  const nextCycleNo = newCycle ? (att.data.loops && att.data.loops[loopRef] && att.data.loops[loopRef]['current-cycle'] || 1) + 1 : att.cycle;
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

  // ── 构造三份新文本（同一 recordedAt），再交 durable ledger transaction 统一写入（FR-17/D-11）──
  const target = path.join(crDir(ws, cr), 'review-annotations', fileName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = readFileChecked(target);
  const yamlOf = (v) => (typeof v === 'string' ? `"${String(v).replaceAll('"', '\\"')}"` : JSON.stringify(v));
  let subjectDigest = null;
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
    // CR-2026-045: commit-scan fallback reads the canonical annotation. Keep
    // the crctl-owned attempt beside the verdict so outbox and fallback emit
    // the same attempt without guessing from commit order.
    'review-loop:',
    `  current-attempt: ${projCurrent}`,
  ];
  if (stage === 'requirement') {
    // 被评审内容摘要（FR-19/D-12）：LF 规范化后 SHA-256，mtime 不参与判定；供 cmdNext 回修/重审路由
    const prdPath = path.join(crDir(ws, cr), 'prd.md');
    const prdRaw = readFileChecked(prdPath);
    if (prdRaw == null) fail('SUBJECT_NOT_FOUND', `requirement review-record 需要 ${prdPath} 存在（写入 subject-sha256）`);
    subjectDigest = sha256(prdRaw.replaceAll('\r\n', '\n'));
    lines.push(`subject-file: change-requests/${cr}/prd.md`);
    lines.push(`subject-sha256: ${subjectDigest}`);
  }
  if (stage === 'tech-design') {
    // CR-2026-027 FR-16/TASK-08：SDD subject digest（供 cmdNext tech-design freshness 判定，SDD §3.5）
    const sddPath = path.join(crDir(ws, cr), 'sdd.md');
    const sddRaw = readFileChecked(sddPath);
    if (sddRaw == null) fail('SUBJECT_NOT_FOUND', `tech-design review-record 需要 ${sddPath} 存在（写入 subject-sha256）`);
    subjectDigest = sha256(sddRaw.replaceAll('\r\n', '\n'));
    lines.push(`subject-file: change-requests/${cr}/sdd.md`);
    lines.push(`subject-sha256: ${subjectDigest}`);
  }
  if (stage === 'dev-plan') {
    // CR-2026-039 TASK-01（SDD §4.2）：plan.md + 全部 TASK-*.md composite digest；pass/block 两轨同写；
    // 失败统一 SUBJECT_NOT_FOUND（在任何账本写入之前，零写入）；供 TASK-02 next/gate freshness 消费。
    const subject = devPlanCompositeDigest(ws, cr);
    if (!subject.ok) fail('SUBJECT_NOT_FOUND', subject.why, { repairTarget: subject.repairTarget });
    subjectDigest = subject.digest;
    lines.push(`subject-sha256: ${subject.digest}`);
  }
  if (stage === 'code') {
    // TASK-06（SDD §3.4）：机器注入逐仓 source SHA 与受控 artifact digest；approve-code 重核后原样签入
    const rs = await runTxAsync((async () => buildReleaseSubjects(resolveRepositories(ws), cr))());
    lines.push(...renderReleaseSubjects(rs));
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
  const ledgerTx = await beginLedgerCommand(ws, ledgerTxKey('review', cr, stage), writes, false);
  await runTxAsync(finishLedgerTransaction(ledgerTx));
  auditLog(ws, { kind: 'ledger', op: 'review-record', cr, stage, verdict: payload.verdict, actor: reviewer, file: target });
  emitOutboxEvent(ws, {
    event_kind: 'review', cr_id: cr, commit_sha: gitHeadSha(ws), actor: reviewer,
    evidence: collectOutboxEvidence(ws, cr, gates.approvalStages[stage === 'dev-plan' ? 'dev-start' : stage]),
    payload: {
      stage, verdict: payload.verdict, blockerCount,
      attempt: projCurrent, blockers: payload.blockers, reviewed_at: recordedAt, subject_sha256: subjectDigest,
    },
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

/** checkpoint：单一深原语。状态守卫在 CLI 层（从 KB CR worktree cr.md 读 status，非主 checkout）；
 * 事务逻辑唯一实现在 workspace-transactions.mjs。 */
async function cmdCheckpoint(ws, cr, gates, flags) {
  const ctx = resolveRepositories(ws);
  const kb = ctx.repositories.find((r) => r.role === 'knowledge-base');
  if (!kb) fail('REPO_GRAPH_INVALID', 'repositories 缺 knowledge-base role');
  const crMdP = path.join(kb.worktreePath, cr, 'change-requests', cr, 'cr.md');
  let status = null;
  try {
    const text = fs.readFileSync(crMdP, 'utf8').replaceAll('\r\n', '\n');
    const m = matchFrontmatter(text);
    if (m) { const doc = parseYaml(m.body); status = doc && doc.status; }
  } catch { /* status 缺失由 checkpointCr 的 worktree 校验兜底 */ }
  if (status == null) fail('CR_MD_STATUS_MISSING', `${cr} 的 KB CR worktree cr.md 缺少 status: ${crMdP}`);
  const { sm } = loadStateMachine(ws);
  if ((sm.terminal || []).includes(status)) {
    fail('ILLEGAL_LEDGER_STATE', `checkpoint 不允许在终态 ${status} 执行`, { current: status, expect: '非终态' });
  }
  const result = await runTxAsync(checkpointCr(ctx, { cr, message: flags.message == null ? undefined : String(flags.message), workspace: ws }));
  auditLog(ws, { kind: 'checkpoint', cr, txId: result.txId, batchId: result.batchId, phase: result.phase, changed: result.changed, actor: identity(ws) });
  if (result.changed && result.metadataCommit) {
    emitOutboxEvent(ws, {
      event_kind: 'checkpoint', cr_id: cr, commit_sha: result.metadataCommit, actor: identity(ws),
      payload: { batch_id: result.batchId, repositories: (result.repositories || []).map((r) => ({ repo: r.repo, sourceSha: r.sourceSha })) },
      dedup_name: `checkpoint-${cr}-${result.metadataCommit}.json`,
    });
  }
  ok({ op: 'checkpoint', ...result });
}

/** owner-set：块内 owners.{role} 的 id + assigned-at 更新（crctl 生成时间戳）。 */
/* ────────────────────────── Owner 正式移交原语（CR-2026-030 TASK-03，SDD §2.2~§2.5/§3.5/§4.4~§4.7） ──────────────────────────
 * owner-set 收敛为受控账本原语：tracked clean 前置 → 双投影一致性校验 → 唯一时间戳两账本候选 →
 * 一次 durable ledger transaction → 只 add 两受控路径并复核 staged set → 一次隔离正式 commit → 成功后同 SHA 发 owners/inbox 事件。
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
  if (/^owner-history:\s*\[\]\s*$/.test(out[idx])) out[idx] = 'owner-history:';
  const segEnd = findBlockEnd(out, idx);
  let lastItem = -1;
  for (let i = segEnd - 1; i > idx; i--) { if (/^[ \t]*- /.test(out[i])) { lastItem = i; break; } }
  out.splice(lastItem === -1 ? idx + 1 : lastItem + 1, 0, entryLine);
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
  // CR-2026-039 TASK-03：移交同样刷新单一 updated（与移交时间一致）
  const body = refreshCrMdUpdated(appendOwnerHistory(out, entryLine).join('\n'), handoverAt);
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

/** FR-5 失败回滚：复用 durable ledger transaction 的 before snapshots，撤销暂存并复核 clean baseline。 */
async function rollbackOwnerWrite(ws, ledgerTx, rels) {
  try {
    await runTxAsync(abortLedgerTransaction(ledgerTx));
    const unR = controlledGit(ws, 'add', rels, ws, 'crctl-owner-set');
    if (!unR.ok) throw new Error(`撤销本次暂存失败: git add ${rels.join(' ')}`);
    const clean = queryTrackedChanges(ws, { audit: true });
    if (!clean.ok || clean.staged.length || clean.unstaged.length) {
      throw new Error(`clean baseline 复核失败 staged=[${(clean.staged || []).join(',')}] unstaged=[${(clean.unstaged || []).join(',')}]`);
    }
  } catch (e) {
    fail('OWNER_COMMIT_ROLLBACK_FAILED', `正式移交提交失败后的恢复未完成：${String(e && e.message || e)}`, { affected: rels });
  }
  fail('OWNER_COMMIT_FAILED', '正式移交提交失败，已由 durable transaction 恢复两个原始快照并撤销暂存', { changed: false, rolled_back: true });
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

async function cmdOwnerSet(ws, cr, gates, flags) {
  if (!flags.role || !flags.id) fail('BAD_ARGS', 'owner-set 需要 --role <requirement|development|test> --id <id> [--note <text>]');
  if (!['requirement', 'development', 'test'].includes(flags.role)) fail('BAD_ARGS', `--role 必须是 requirement|development|test（当前 ${flags.role}）`);
  await recoverLedgerCommand(ws, ledgerTxKey('owner', cr));
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
  const ledgerTx = await beginLedgerCommand(ws, ledgerTxKey('owner', cr), [
    { path: os.crMd.path, expectedHash: os.crMd.hash, newText: newCrMd },
    { path: os.backlog.path, expectedHash: os.backlog.hash, newText: newBacklog },
  ], true);
  // FR-5：只 add 两受控路径，commit 前复核 staged set 恰好等于两文件且无其他 tracked working-tree 变化
  const addR = controlledGit(ws, 'add', rels, ws, 'crctl-owner-set');
  if (addR.ok) {
    const iso = queryTrackedChanges(ws, { audit: false });
    if (iso.ok && iso.unstaged.length === 0 && JSON.stringify(iso.staged) === JSON.stringify(expected)) {
      const msg = `[cr] owner handover ${cr} ${flags.role} ${from} -> ${newId}`;
      const commitR = controlledGit(ws, 'commit', ['-m', `${msg}\n\nAI-First-Tx: ${ledgerTx.txId}`], ws, 'crctl-owner-set');
      if (commitR.ok) {
        await injectLedgerFault('ledger-after-commit');
        await runTxAsync(finishLedgerTransaction(ledgerTx));
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
  await rollbackOwnerWrite(ws, ledgerTx, rels);
}

/* ────────────────────────── version-set（CR-2026-057 TASK-04，SDD §4.4） ──────────────────────────
 * 版本事实唯一更正入口：unassigned → 真实版本，原子同步 cr.md/_backlog/已存在派生产物，幂等短路，
 * 零状态副作用。同构复用 owner-set 的 durable ledger 事务骨架，但恢复时点按 B-SDD-005 定稿：
 * 允许状态校验（步骤 3）→ recoverLedgerCommand（步骤 4）→ tracked-clean（步骤 5）→ 漂移检查（步骤 6）。
 */

/** 已允许状态核验后才执行的可恢复优先路径说明见 cmdVersionSet 步骤注释。 */
function failVersionSetLedger(e) {
  return `ledger 事务失败：${String(e && e.message || e)}`;
}

/** 行级读取 frontmatter 内 ^target-version: 行（cr.md/prd/sdd/plan/TASK-* 共用；无 frontmatter/缺行 → null）。 */
function readTargetVersionField(text) {
  const norm = String(text).replaceAll('\r\n', '\n');
  const m = matchFrontmatter(norm);
  if (!m) return null;
  const line = m.body.split('\n').find((l) => /^target-version:/.test(l));
  if (!line) return null;
  return line.replace(/^target-version:\s*/, '').trim().replace(/^["']|["']$/g, '');
}

/** 行级读取 _backlog.yml 条目块内 target-version（缺块/缺行 → null）。 */
function readBacklogTargetVersionField(text, cr) {
  const norm = String(text).replaceAll('\r\n', '\n');
  const block = matchEntryBlock(norm, cr);
  if (!block) return null;
  const line = block.text.split('\n').find((l) => /^[ \t]*target-version:/.test(l));
  if (!line) return null;
  return line.replace(/^[ \t]*target-version:\s*/, '').trim().replace(/^["']|["']$/g, '');
}

/* ────────────────────────── CR-2026-060 G1：target-spec-id 模式裁决与 authority（唯一裁决 + 生命周期绑定，SDD §2.2/§4.1） ──────────────────────────
 * 模式裁决与 strict authority 解析器已收敛至 lib/workspace-transactions.mjs（单一实现），本文件 re-import 消费。 */

const PRE_REVIEW_KIND_CHECK_CODES = { missing: 'TARGET_SPEC_AUTHORITY_MISSING', invalid: 'TARGET_SPEC_AUTHORITY_INVALID', mismatch: 'TARGET_SPEC_AUTHORITY_DRIFT' };

/** spec-authority 路径快照：优先 CR worktree；单仓 legacy fixture（无 repositories 声明）回退主 workspace（仅旧测试/旧布局，new mode 不存在该形态）。 */
function specAuthorityPath(ws, cr) {
  try {
    const ctx = resolveRepositories(ws);
    return { path: crWorktreePath(ctx, cr), source: 'cr-worktree' };
  } catch (e) {
    if (e instanceof TxError && (e.code === 'REPO_GRAPH_INVALID' || e.code === 'REPO_GRAPH_NOT_FOUND' || e.code === 'REPO_PATH_NOT_FOUND')) {
      return { path: ws, source: 'cr-worktree' };
    }
    throw e;
  }
}

/** pre-review 检查序列（SDD §4.2）：authority=CR worktree；kind→check code 一对一映射；new+unassigned → TARGET_VERSION_UNASSIGNED。 */
function runPreReviewGateChecks(ws, cr) {
  const authority = specAuthorityPath(ws, cr);
  const checks = [];
  let mode = null;
  try {
    mode = resolveTargetSpecMode({}, cr, { authority });
  } catch (e) {
    if (e instanceof TxError && e.code === 'TARGET_SPEC_AUTHORITY_DRIFT') {
      const code = PRE_REVIEW_KIND_CHECK_CODES[e.extra && e.extra.kind] || 'TARGET_SPEC_AUTHORITY_DRIFT';
      checks.push({ type: 'target-spec-authority', code, ok: false, why: e.message });
    } else {
      throw e;
    }
  }
  if (mode && mode.mode === 'new') {
    const r = readCrMdTargetVersion(authority.path, cr);
    if (!r.ok) {
      checks.push({ type: 'target-version', code: 'TARGET_VERSION_MISSING', ok: false, why: `cr.md target-version ${r.reason}` });
    } else {
      const n = normalizeTargetVersion(r.raw);
      if (!n.ok) {
        checks.push({ type: 'target-version', code: 'TARGET_VERSION_INVALID', ok: false, why: `cr.md target-version 非法（reason=${n.reason}）` });
      } else if (n.value === 'unassigned') {
        checks.push({ type: 'target-version', code: 'TARGET_VERSION_UNASSIGNED', ok: false, why: 'new mode 且 target-version=unassigned，禁止 requirement-reviewing（先 version-set）' });
      }
    }
  }
  const pass = checks.every((c) => c.ok);
  return { cr, for: 'requirement-reviewing', mode: 'pre-review', pass, checks };
}

/** advance 层零写入 guard（SDD §4.7）：仅 flags.to==='requirement-reviewing'；new+unassigned → GATE_BLOCKED/TARGET_VERSION_UNASSIGNED 零写入。 */
function assertRequirementReviewAdvanceGuard(ws, cr) {
  const authority = specAuthorityPath(ws, cr);
  let mode;
  try {
    mode = resolveTargetSpecMode({}, cr, { authority });
  } catch (e) {
    if (e instanceof TxError) fail(e.code, e.message, e.extra);
    throw e;
  }
  if (!mode || mode.mode !== 'new') return; // legacy 零改动
  const r = readCrMdTargetVersion(authority.path, cr);
  if (!r.ok) return; // version 缺失由既有 gate/version-set 消费，guard 只阻断 unassigned
  const n = normalizeTargetVersion(r.raw);
  if (n.ok && n.value === 'unassigned') {
    fail('GATE_BLOCKED', 'new mode unassigned 禁止直接 advance 到 requirement-reviewing（先 version-set）', {
      gate: { target: 'requirement-reviewing', pass: false, checks: [{ type: 'target-version', code: 'TARGET_VERSION_UNASSIGNED', ok: false, why: 'new mode 且 target-version=unassigned' }] },
    });
  }
}

/** 统一结果 builder（SDD §4.3.2）：成功/幂等/恢复共用；operationalWorkspace 由既有 resolver 生产。 */
function buildRegisterResult(ctx, r) {
  const operationalWorkspace = resolveOperationalWorkspace(ctx, r.cr).path;
  return {
    cr: r.cr, txId: r.txId, phase: r.phase, changed: r.changed,
    targetVersion: r.targetVersion, targetSpecId: r.targetSpecId, registrationAt: r.registrationAt,
    sideEffects: r.sideEffects, recoverCommand: r.recoverCommand, operationalWorkspace,
  };
}

/**
 * frontmatter 内 ^target-version: 行替换（行级纯函数）：先 \r\n→\n（NFR-3）；
 * 无 frontmatter / 缺行 → LEDGER_PARSE_FAILED 硬失败，禁止静默返回原文（纪律 #1）。
 */
function editTargetVersionLine(text, version) {
  const norm = String(text).replaceAll('\r\n', '\n');
  const m = matchFrontmatter(norm);
  if (!m) fail('LEDGER_PARSE_FAILED', '文件无 frontmatter（target-version 行替换失败）');
  const lines = m.body.split('\n');
  const idx = lines.findIndex((l) => /^target-version:/.test(l));
  if (idx === -1) fail('LEDGER_PARSE_FAILED', 'frontmatter 缺 target-version 行');
  lines[idx] = lines[idx].replace(/^(target-version:).*$/, `$1 ${yamlScalar(version)}`);
  return norm.replace(m.match, '---\n' + lines.join('\n') + '\n---');
}

/** _backlog.yml 条目块内 target-version 行替换（同 editBacklogSet 的行级模式；缺块/缺行 → 硬失败）。 */
function editBacklogTargetVersionLine(text, cr, version) {
  const norm = String(text).replaceAll('\r\n', '\n');
  const block = matchEntryBlock(norm, cr);
  if (!block) fail('ENTRY_NOT_IN_BACKLOG', `${cr} 不在 _backlog.yml`);
  const lines = block.text.split('\n');
  const idx = lines.findIndex((l) => /^[ \t]*target-version:/.test(l));
  if (idx === -1) fail('LEDGER_PARSE_FAILED', `backlog 条目 ${cr} 缺 target-version 行`);
  // B-CODE-001：块替换必须基于权威区间 norm.slice(block.start, block.end) 做单行定点替换，
  // 禁止用 block.text 的 split/join 重建后拼接——matchEntryBlock 的 end 指向后继条目首字符，
  // 块尾换行不在 block.text 内（末条目时文本与区间还各含一半换行），重建会丢失分隔换行，
  // 把目标块最后一行与下一条目拼接破坏 YAML。区间文本自带块尾换行，替换后原样保留；
  // 未命中（区间与 block.text 不一致）一律硬失败，禁止静默返回原文（纪律 #1）。
  const spanText = norm.slice(block.start, block.end);
  const replaced = spanText.replace(/^([ \t]*)target-version:.*$/m, (_, ind) => `${ind}target-version: ${yamlScalar(version)}`);
  if (replaced === spanText) fail('LEDGER_PARSE_FAILED', '_backlog.yml 条目块内 target-version 行替换未命中（块区间与条目文本不一致）');
  return norm.slice(0, block.start) + replaced + norm.slice(block.end);
}

/** 提交失败回滚：abort ledger + 撤销暂存 + clean 复核（镜像 rollbackOwnerWrite，错误码 VERSION_SET_COMMIT_*）。 */
async function rollbackVersionWrite(ws, ledgerTx, rels) {
  try {
    await runTxAsync(abortLedgerTransaction(ledgerTx));
    const unR = controlledGit(ws, 'add', rels, ws, 'crctl-version-set');
    if (!unR.ok) throw new Error(`撤销本次暂存失败: git add ${rels.join(' ')}`);
    const clean = queryTrackedChanges(ws, { audit: true });
    if (!clean.ok || clean.staged.length || clean.unstaged.length) {
      throw new Error(`clean baseline 复核失败 staged=[${(clean.staged || []).join(',')}] unstaged=[${(clean.unstaged || []).join(',')}]`);
    }
  } catch (e) {
    fail('VERSION_SET_COMMIT_ROLLBACK_FAILED', `version-set 提交失败后的恢复未完成：${failVersionSetLedger(e)}`, { affected: rels });
  }
  fail('VERSION_SET_COMMIT_FAILED', 'version-set 提交失败，已由 durable transaction 恢复原始快照并撤销暂存', { changed: false, rolled_back: true });
}

async function cmdVersionSet(ws, cr, gates, flags) {
  if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) fail('BAD_ARGS', 'version-set 需要 CR-ID');
  // 步骤 1：缺 --to（未提供或无值）→ BAD_ARGS（与既有命令口径一致）
  if (flags.to === undefined || flags.to === true || typeof flags.to !== 'string') {
    fail('BAD_ARGS', 'version-set 需要 --to <real-version>（真实版本 MAJOR.MINOR[.PATCH]；unassigned → 真实版本 的唯一更正入口）');
  }
  // 步骤 2：--to 共用规范化且必须是真实版本（allowUnassigned=false）；失败零写入
  const to = normalizeTargetVersion(flags.to, { allowUnassigned: false });
  if (!to.ok) {
    fail('VERSION_SET_INVALID', `version-set --to 非法：${JSON.stringify(flags.to)}（reason=${to.reason}；必须为真实版本，禁止 unassigned/同义值/畸形）`, { reason: to.reason, raw: flags.to });
  }
  // 步骤 3：允许状态校验（禁止状态在恢复之前短路 → 零恢复，B-SDD-005）
  const state = resolveCrState(ws, cr);
  const { sm } = loadStateMachine(ws);
  if ((sm.terminal || []).includes(state.status) || state.status === 'merging' || state.status === 'writing-back') {
    fail('VERSION_SET_STATE_INVALID', `version-set 不允许在 ${state.status}（merge 一旦开始版本冻结，只允许 writeback 消费；终态拒绝）`, { current: state.status });
  }
  // 步骤 4：可恢复优先路径——允许状态已核验，先于 tracked-clean 与漂移检查；
  // 本事务残留（键 version/{cr}）幂等回滚/确认，外部 dirty 不在该键下、不被恢复。
  await recoverLedgerCommand(ws, ledgerTxKey('version', cr));
  // 步骤 5：tracked clean 前置（恢复后残留已清，任何 tracked 变更必为外部 dirty）
  const dirty = queryTrackedChanges(ws, { audit: false });
  if (!dirty.ok) {
    fail(dirty.code, '受控 Git 只读查询失败，无法确认 tracked clean 前置', { changed: false, detail: dirty.detail });
  }
  if (dirty.staged.length || dirty.unstaged.length) {
    fail('VERSION_SET_WORKTREE_DIRTY', '仓库存在 tracked 变更：version-set 要求 tracked index 与 tracked working tree 均 clean（untracked 不阻塞）。请先提交、暂存外移或丢弃自己的 tracked 变更', { changed: false, staged: dirty.staged, unstaged: dirty.unstaged });
  }
  // 步骤 6：双投影 + 派生产物漂移检查（在恢复后的事务前状态上执行）
  const crMdPath = path.join(crDir(ws, cr), 'cr.md');
  const crMdText = readFileChecked(crMdPath);
  if (crMdText == null) fail('CR_MD_WRITE_FAILED', `cr.md 不存在: ${crMdPath}`);
  const crMdRead = readCrMdTargetVersion(ws, cr);
  const crMdNorm = crMdRead.ok ? normalizeTargetVersion(crMdRead.raw) : { ok: false, reason: 'missing' };
  if (!crMdNorm.ok) {
    fail('VERSION_SET_DERIVED_DRIFT', `cr.md target-version 缺失或无法规范化（${crMdRead.ok ? crMdRead.raw : '(缺失)'}）`, { cr, field: 'cr.md', reason: crMdNorm.reason });
  }
  const snap = loadBacklogEntry(ws, cr);
  const backlogRaw = readBacklogTargetVersionField(snap.text, cr);
  const backlogNorm = backlogRaw == null ? { ok: false, reason: 'missing' } : normalizeTargetVersion(backlogRaw);
  if (!backlogNorm.ok || backlogNorm.value !== crMdNorm.value) {
    fail('VERSION_SET_DERIVED_DRIFT', `_backlog.yml 条目 target-version 缺失或与 cr.md（${crMdNorm.value}）不一致`, { cr, field: '_backlog.yml' });
  }
  const derived = [];
  for (const name of ['prd.md', 'sdd.md', 'plan.md']) {
    const p = path.join(crDir(ws, cr), name);
    if (!fs.existsSync(p)) continue;
    const text = readFileChecked(p);
    const raw = readTargetVersionField(text);
    const n = raw == null ? { ok: false, reason: 'missing' } : normalizeTargetVersion(raw);
    if (!n.ok || n.value !== crMdNorm.value) {
      fail('VERSION_SET_DERIVED_DRIFT', `${name} target-version 缺失或与 cr.md（${crMdNorm.value}）不一致`, { cr, field: name });
    }
    derived.push({ rel: `change-requests/${cr}/${name}`, path: p, text, hash: sha256(text) });
  }
  const tasksDir = path.join(crDir(ws, cr), 'tasks');
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir).filter((x) => /^TASK-.*\.md$/.test(x)).sort()) {
      const p = path.join(tasksDir, f);
      const text = readFileChecked(p);
      const raw = readTargetVersionField(text);
      const n = raw == null ? { ok: false, reason: 'missing' } : normalizeTargetVersion(raw);
      if (!n.ok || n.value !== crMdNorm.value) {
        fail('VERSION_SET_DERIVED_DRIFT', `${f} target-version 缺失或与 cr.md（${crMdNorm.value}）不一致`, { cr, field: `tasks/${f}` });
      }
      derived.push({ rel: `change-requests/${cr}/tasks/${f}`, path: p, text, hash: sha256(text) });
    }
  }
  // 真实版本 → 真实版本 / 真实版本 → unassigned 均不允许（后者由 --to 规范化拦截）
  if (crMdNorm.value !== 'unassigned' && crMdNorm.value !== to.value) {
    fail('VERSION_SET_NOT_UNASSIGNED', `cr.md 已是 ${crMdNorm.value}，version-set 只允许 unassigned → 真实版本（不允许真实版本互改）`, { current: crMdNorm.value, to: to.value });
  }
  // 幂等短路：全链已等于 to.value → changed=false 零新 commit
  if (crMdNorm.value === to.value) {
    ok({ op: 'version-set', cr, from: crMdNorm.value, to: to.value, changed: false, files: [] });
    return;
  }
  // 步骤 7：行级编辑纯函数（匹配不到 LEDGER_PARSE_FAILED 硬失败，纪律 #1）
  const newCrMd = editTargetVersionLine(crMdText, to.value);
  const newBacklog = editBacklogTargetVersionLine(snap.text, cr, to.value);
  const writes = [
    { path: crMdPath, expectedHash: sha256(crMdText), newText: newCrMd },
    { path: snap.path, expectedHash: snap.hash, newText: newBacklog },
  ];
  for (const d of derived) writes.push({ path: d.path, expectedHash: d.hash, newText: editTargetVersionLine(d.text, to.value) });
  const rels = writes.map((w) => path.relative(ws, w.path).split(path.sep).join('/'));
  const expected = [...rels].sort();
  // 步骤 8：durable ledger transaction（expectedHash 取调用前 SHA；commitRequired=true）
  const ledgerTx = await beginLedgerCommand(ws, ledgerTxKey('version', cr), writes, true);
  // 步骤 9：只 add 受控路径，commit 前复核 staged set 恰好等于写入集
  const addR = controlledGit(ws, 'add', rels, ws, 'crctl-version-set');
  if (addR.ok) {
    const iso = queryTrackedChanges(ws, { audit: false });
    if (iso.ok && iso.unstaged.length === 0 && JSON.stringify(iso.staged) === JSON.stringify(expected)) {
      const msg = `[cr] version-set ${cr} ${crMdNorm.value} -> ${to.value}`;
      const commitR = controlledGit(ws, 'commit', ['-m', `${msg}\n\nAI-First-Tx: ${ledgerTx.txId}`], ws, 'crctl-version-set');
      if (commitR.ok) {
        await injectLedgerFault('ledger-after-commit');
        await runTxAsync(finishLedgerTransaction(ledgerTx));
        const sha = gitHeadSha(ws);
        auditLog(ws, { kind: 'ledger', op: 'version-set', cr, actor: identity(ws), from: crMdNorm.value, to: to.value, result: 'ok' });
        ok({ op: 'version-set', cr, from: crMdNorm.value, to: to.value, changed: true, files: rels, commit: { sha, message: msg } });
        return;
      }
    }
  }
  // 步骤 10：add/commit/隔离复核失败 → 回滚恢复 clean baseline（VERSION_SET_COMMIT_* 镜像 OWNER_*）
  await rollbackVersionWrite(ws, ledgerTx, rels);
}

function cmdBacklogSet(ws, cr, gates, flags) {
  if (!flags.field || flags.value === undefined) fail('BAD_ARGS', 'backlog-set 需要 --field <prd-path|sdd-path> --value <v>');
  if (!BACKLOG_SET_FIELDS.includes(flags.field)) {
    fail('FIELD_NOT_ALLOWED', `backlog-set 白名单仅允许 ${BACKLOG_SET_FIELDS.join(' | ')}；${flags.field} 属受控字段，各有专命令（status→advance、updated-at/owners→crctl 自动维护、merge-commits→crctl merge）`, { field: flags.field, allowed: BACKLOG_SET_FIELDS });
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

async function cmdTest(ws, cr, gates, flags) {
  if (!flags.plan) fail('BAD_ARGS', 'test 需要 --plan <temp-json>（--cmd/--cwd/--timeout 已移除，改用结构化 cr-test-plan/v1）');
  if (flags.cmd || flags.cwd || flags.timeout || (flags.cmdList && flags.cmdList.length)) {
    fail('BAD_ARGS', 'test 不再接受 --cmd/--cwd/--timeout，仅接受 --plan');
  }
  const ctx = resolveRepositories(ws);
  const dataWs = authorityWorkspace(ws, cr, flags.operationalWorkspace);
  const result = await runTxAsync(testCr(ctx, { cr, workspace: dataWs, planPath: flags.plan }));
  ok(result);
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
      const indexOk = fs.existsSync(path.join(crDir(ws, cr), 'tasks', '_index.yml'));
      if (!planOk) return suggest('write-dev-plan', 'plan.md 缺失');
      if (!tasksOk) return suggest('write-dev-tasks', 'tasks/ 缺失');
      if (!indexOk) return suggest('write-dev-tasks', 'tasks/_index.yml 缺失，先调用 crctl task init');
      // CR-2026-027 FR-16/TASK-07：canonical dev-plan.yml 判定（缺失/畸形 → 评审；PASS → 审批；BLOCK → 按 annotation 重算 route）
      const dp = ev('change-requests/{cr}/review-annotations/dev-plan.yml');
      if (!dp.exists || !dp.data || !['pass', 'block'].includes(dp.data.verdict) || !Array.isArray(dp.data.blockers)) {
        return suggest('review-dev-plan', dp.exists ? 'dev-plan.yml 畸形（缺 verdict/blockers），重跑评审' : '缺少 dev-plan.yml 评审记录，先跑 review-dev-plan');
      }
      if (dp.data.verdict === 'pass' && dp.data.blockers.length === 0) {
        // CR-2026-039 TASK-02：PASS 后先判 freshness；漂移/legacy/不完整 → 按 repairTarget 可执行路由
        const fr = devPlanFreshness(ws, cr, dp.data);
        if (!fr.fresh) return suggest(fr.repairTarget, fr.why);
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
  const args = argv.slice(1);
  const r = controlledGit(ws, sub, args, flags.cwd ? path.resolve(flags.cwd) : ws, 'crctl-git');
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
  ok({ ok: r.ok, exit: r.exit, ...(outbox ? { outbox } : {}) });
  if (!r.ok) process.exit(r.exit || 1);
}

/* ────────────────────────── CLI 入口 ────────────────────────── */

/* ──────────────────── CR-2026-031 TASK-05：幂等 register 与 workspace 生命周期 ────────────────────
 * 事务逻辑唯一实现在 lib/workspace-transactions.mjs；本处只做 flag 解析、TxError→fail 转换与 audit 登记。
 * TASK-10 统一切换后 cr-init 删除，register 成为注册唯一入口。 */
async function runTxAsync(promise) {
  try { return await promise; } catch (e) {
    if (e instanceof TxError) fail(e.code, e.message, e.extra);
    throw e;
  }
}

async function cmdRegister(ws, flags) {
  // CR-2026-060 G1（AC-01）：--target-spec-id 校验在既有必填 flag 循环之前（优先且唯一，不落 BAD_ARGS）。
  const rawSpecId = flags['target-spec-id'];
  if (rawSpecId === undefined || rawSpecId === true || String(rawSpecId).trim() === '') {
    fail('REGISTER_TARGET_SPEC_ID_REQUIRED', 'register 需要 --target-spec-id <id>（非空，匹配 ^[a-z0-9][a-z0-9._-]*$，禁止 / \\ CR LF）');
  }
  const targetSpecId = String(rawSpecId);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(targetSpecId) || /[/\\\r\n]/.test(targetSpecId)) {
    fail('REGISTER_TARGET_SPEC_ID_INVALID', `register --target-spec-id 非法: ${JSON.stringify(targetSpecId)}（须匹配 ^[a-z0-9][a-z0-9._-]*$，禁止 / \\ CR LF）`);
  }
  for (const f of ['registration-key', 'title', 'owner-requirement', 'owner-development', 'owner-test']) {
    if (!flags[f]) fail('BAD_ARGS', `register 需要 --${f} <v>`);
  }
  const input = {
    registrationKey: String(flags['registration-key']),
    title: String(flags.title),
    summary: flags.summary == null ? undefined : String(flags.summary),
    source: flags.source == null ? undefined : String(flags.source),
    origin: flags.origin == null ? undefined : String(flags.origin),
    targetVersion: flags['target-version'] == null ? undefined : String(flags['target-version']),
    targetSpecId,
    year: flags.year ? String(flags.year) : undefined,
    workspace: ws,
    owners: { requirement: String(flags['owner-requirement']), development: String(flags['owner-development']), test: String(flags['owner-test']) },
  };
  const ctx = resolveRepositories(ws);
  const result = await runTxAsync(registerCr(ctx, input));
  auditLog(ws, { kind: 'ledger', op: 'register', cr: result.cr, txId: result.txId, actor: identity(ws), title: input.title, phase: result.phase, changed: result.changed });
  // 统一结果 builder（成功/幂等/恢复共用；删除 :3098 早退，changed=false 同构输出 outbox=null/warnings=[]）。
  // 输出同时保留历史 camelCase 键（既有消费方）与新增 snake_case 键（PRD §3.3 命名矩阵）。
  const r = buildRegisterResult(ctx, result);
  const out = {
    op: 'register',
    cr: r.cr, cr_id: r.cr,
    txId: r.txId, tx_id: r.txId,
    phase: r.phase, changed: r.changed,
    targetVersion: r.targetVersion, target_version: r.targetVersion,
    targetSpecId: r.targetSpecId, target_spec_id: r.targetSpecId,
    registrationAt: r.registrationAt, registration_at: r.registrationAt,
    sideEffects: r.sideEffects, side_effects: r.sideEffects,
    recoverCommand: r.recoverCommand, recover_command: r.recoverCommand,
    operationalWorkspace: r.operationalWorkspace, operational_workspace: r.operationalWorkspace,
    outbox: null, warnings: [],
  };
  if (!r.changed) { ok(out); return; }
  // 注册事件：register commit 落盘后以真实 SHA 发 status + owners 事件；全部时间字段原样消费单一 registrationAt（删除第二个 nowIso）。
  const commitSe = (r.sideEffects || []).find((s) => s.kind === 'commit');
  const commitSha = commitSe ? commitSe.sha : null;
  const now = r.registrationAt;
  const owners = {
    requirement: { id: input.owners.requirement, 'assigned-at': now },
    development: { id: input.owners.development, 'assigned-at': now },
    test: { id: input.owners.test, 'assigned-at': now },
  };
  const changes = ['requirement', 'development', 'test'].map((role) => ({ role, from: '', to: owners[role].id, at: now, reason: 'initial-assignment' }));
  const warnings = [];
  const emit = (ev) => { const name = emitOutboxEvent(ws, ev); if (!name) warnings.push({ code: 'EMIT_FAILED', event_kind: ev.event_kind }); return name; };
  out.outbox = {
    status: emit({ event_kind: 'status', cr_id: r.cr, from_status: '(new)', to_status: 'drafting', trigger: 'requirement-register', commit_sha: commitSha, actor: identity(ws) }),
    owners: emit({ event_kind: 'owners', cr_id: r.cr, from_status: '(new)', to_status: 'drafting', trigger: 'requirement-register', commit_sha: commitSha, actor: identity(ws), payload: { owners, changes } }),
  };
  out.warnings = warnings;
  ok(out);
}

/* CR-2026-043 TASK-01/02：freshness/sync 不走 runTxAsync 全局错误路径（其失败直接 fail，
 * 审计不可达），而是局部 try/catch：成功 non-fresh 业务阻断与 TxError 均先写 audit 再输出。 */
function workspaceFreshnessAuditFail(ws, cr, e) {
  auditLog(ws, { kind: 'workspace-freshness', cr, actor: identity(ws), error: e.code, extra: e.extra || {} });
  fail(e.code, e.message, e.extra);
}

async function cmdWorkspace(ws, positional, flags) {
  const sub = positional[0];
  const cr = positional[1];
  if (!['inspect', 'ensure', 'cleanup', 'freshness', 'sync'].includes(sub)) fail('BAD_ARGS', 'workspace 支持 inspect|ensure|cleanup|freshness|sync <CR-ID> [--mode <m>]');
  if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) fail('BAD_ARGS', 'workspace 需要 CR-ID');
  if (sub === 'ensure' && flags.mode !== 'resume') fail('BAD_ARGS', 'workspace ensure 需要 --mode resume');
  if (sub === 'cleanup' && !['partial', 'archived'].includes(flags.mode)) fail('BAD_ARGS', 'workspace cleanup 需要 --mode partial|archived');
  const ctx = resolveRepositories(ws);
  if (sub === 'freshness' || sub === 'sync') {
    const extra = Object.keys(flags).filter((k) => k !== 'workspace' && k !== 'cmdList');
    if (extra.length) fail('BAD_ARGS', `workspace ${sub} 不接受额外参数: ${extra.map((x) => `--${x}`).join(', ')}`);
    if (sub === 'freshness') {
      try {
        const result = classifyWorkspaceFreshness(ctx, cr);
        if (!result.allFresh) {
          auditLog(ws, {
            kind: 'workspace-freshness', cr, actor: identity(ws),
            blocked: result.repositories.filter((r) => r.freshness !== 'fresh').map((r) => ({ repo: r.repo, freshness: r.freshness, reason: r.reason || null })),
          });
        }
        return ok({ op: 'workspace-freshness', ...result });
      } catch (e) {
        if (e instanceof TxError) workspaceFreshnessAuditFail(ws, cr, e);
        throw e;
      }
    }
    try {
      const result = await syncWorkspaceToTrunk(ctx, { cr });
      auditLog(ws, {
        kind: 'workspace-sync', cr, actor: identity(ws), txId: result.txId, phase: result.phase, changed: result.changed,
        repos: result.repositories.map((r) => ({ repo: r.repo, action: r.action, beforeSha: r.beforeSha, targetSha: r.targetTrunkSha, afterSha: r.afterSha })),
      });
      return ok({ op: 'workspace-sync', ...result });
    } catch (e) {
      if (e instanceof TxError) {
        auditLog(ws, { kind: 'workspace-sync', cr, actor: identity(ws), error: e.code, extra: e.extra || {} });
        fail(e.code, e.message, e.extra);
      }
      throw e;
    }
  }
  const mode = sub === 'inspect' ? 'inspect' : sub === 'ensure' ? 'resume' : flags.mode;
  const result = await runTxAsync(ensureWorkspace(ctx, { cr, mode }));
  if (sub === 'inspect') {
    // CR-2026-044 FR-06：暴露既有 authority resolver 的单一 operationalWorkspace 路径；
    // missing/inconsistent 返回结构化错误信息（不猜路径），由调用方中止并指向 resume。
    let operationalWorkspace = null, operationalWorkspaceError = null;
    try { operationalWorkspace = resolveOperationalWorkspace(ctx, cr).path; } catch (e) {
      if (e instanceof TxError) operationalWorkspaceError = { code: e.code, message: e.message };
      else throw e;
    }
    return ok({ op: 'workspace-inspect', cr, mode, ...result, operationalWorkspace, operationalWorkspaceError });
  }
  ok({ op: `workspace-${sub}`, cr, mode, ...result });
}

async function cmdMerge(ws, positional, flags) {
  const sub = positional[0];
  if (sub === 'status') {
    const cr = positional[1];
    if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) fail('BAD_ARGS', 'merge status 需要 CR-ID');
    const ctx = resolveRepositories(ws);
    ok({ op: 'merge-status', ...mergeStatus(ctx, cr) });
    return;
  }
  const cr = sub;
  if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) fail('BAD_ARGS', 'merge 需要 CR-ID');
  const ctx = resolveRepositories(ws);
  const authority = resolveOperationalWorkspace(ctx, cr);
  const authWs = authority.path;
  const gates = loadGates(ctx.installRoot);
  const state = resolveCrState(authWs, cr);
  if (state.status !== 'code-approved') {
    fail('MERGE_STATE_MISMATCH', `merge 需要 status=code-approved，实际 ${state.status}`, { cr, status: state.status });
  }
  const gate = runGateChecks(authWs, cr, 'code-approved', gates, {});
  if (!gate.pass) {
    const why = gate.checks.filter((c) => !c.ok).map((c) => c.why).filter(Boolean).join('；');
    fail('GATE_BLOCKED', `merge 前置门禁未通过，拒绝写入${why ? '：' + why : ''}`, { gate });
  }
  const result = await runTxAsync(mergeCr(ctx, { cr, workspace: authWs }));
  if (result.phase === 'release-drift') {
    // 零 publish 的 code/source/TASK 漂移：原子回退 code-approved -> developing（唯一回退转换）
    auditLog(authWs, { kind: 'merge', cr, result: 'release-drift', drift: result.drift, actor: identity(authWs) });
    const adv = performAdvance(authWs, cr, gates, {
      to: 'developing', trigger: 'merge-feature-branch:release-drift -> implement-code', expect: 'code-approved',
    });
    ok({ op: 'merge', ...result, advanced: { to: 'developing', trigger: adv.trigger, committed: adv.committed } });
    return;
  }
  auditLog(authWs, { kind: 'merge', cr, txId: result.txId, phase: result.phase, changed: result.changed, actor: identity(authWs) });
  ok({ op: 'merge', ...result });
}

const HELP = `crctl — CR 状态机 gate CLI（漂移治理 v2 组件 A）

用法:
  crctl status  <cr_id>                          输出权威指针：status / 合法下一步 / 门禁缺口
  crctl gate    <cr_id> --for <status>           只校验不写；非零退出表示 block
  crctl advance <cr_id> --to <s> --trigger <t>   校验转换+门禁后写入 cr.md 并 commit
                        [--expect <cur>] [--embedded] [--spec-id <id>]
  crctl approve <cr_id> --stage <requirement|tech-design|dev-start|code>
                        [--approver <id>] [--spec-id <id>]   仅限交互式终端（人类在环）；code 审批重核 release-subjects，漂移零写入拒绝（TASK-06）
  crctl approve <cr_id> --stage <stage> --resign <reason>   受控历史审批迁移：仅限交互式终端迁移 via=crctl-approve；server-approve 必须由服务端重签 grant
  crctl validate <file>                          受控产物 schema 校验（validate-doc 代码化）
  crctl attempt <cr_id> --loop <ref>             review-loop 轮次唯一记账点；超限返回 LOOP_EXHAUSTED
  crctl review-loop reset <cr_id> --loop <ref> --reason <text>   人工重置：仅在交互式终端、loop 已耗尽时开启下一 review cycle（current-cycle+1、attempt 归零、保留历史、写审计）
  crctl review-record <cr_id> --stage <requirement|tech-design|code> --from <payload.yml> [--bump-attempt]
                                                schema 校验临时 payload 后写入 review-annotations（tech-design→sdd.yml）；code 阶段机器注入 release-subjects（payload 提供/覆盖 → RELEASE_SUBJECTS_FORGED）
  crctl review-note  <cr_id> [--stage <s>] --note <text>  approval.yml supplemental-reviews[] 追加（不接受 --by，身份 crctl 生成）
  crctl checkpoint <cr_id> [--message <text>]   单一深原语：全仓 source commit → 非 KB lease publish → KB metadata commit 唯一完整批次可见点（非终态）
  crctl owner-set     <cr_id> --role <requirement|development|test> --id <id>   双投影 owners 更新 + 正式移交 commit（非终态）
  crctl version-set   <cr_id> --to <real-version>   版本事实唯一更正入口：unassigned → 真实版本，原子同步 cr.md/_backlog/已存在派生产物，幂等短路，不改 CR status
  crctl backlog-set   <cr_id> --field <prd-path|sdd-path> --value <v>    _backlog 白名单标量字段（硬拒 status 等受控字段）
  crctl inbox-emit   <cr_id> --event <e> [--to <a,b>] [--payload <json>]   _backlog notify-log 事件追加 + notify-pending 合并（非终态）
  crctl register  --registration-key <k> --title <t> --owner-requirement <id> --owner-development <id> --owner-test <id>
                        --target-version <v> --target-spec-id <id> [--summary <s>] [--source <s>] [--origin <CR-ID>] [--year Y]   幂等注册事务：CR-ID+三账本+commit/lease push+worktree ensure（--target-version 必填：真实版本 MAJOR.MINOR[.PATCH] 或 unassigned，禁止 tbd；--target-spec-id 必填：匹配 ^[a-z0-9][a-z0-9._-]*$，禁止 / \\ CR LF）
  crctl workspace inspect <cr_id>                  各 active repo workspace 事实分类（只读）
  crctl workspace ensure  <cr_id> --mode resume    只补齐可证明缺失的 workspace 资源（零删除）
  crctl workspace cleanup <cr_id> --mode partial|archived   只删干净 worktree；dirty/unknown/未合并 ref 保留
  crctl workspace freshness <cr_id>              各仓 CR 分支对 trunk 的新鲜度只读分类（fresh/behind-clean/diverged/unknown）
  crctl workspace sync      <cr_id>              显式 ff-only 同步：仅 behind-clean 仓前移到 preflight 捕获的 trunk SHA（幂等续跑）
  crctl merge <cr_id>                                可恢复跨仓 merge saga：prepare(commit-tree) → 逐仓 lease publish → 全部 confirmed 后 detached Transaction Workspace 单 finalize commit（status=merging + merge-commits.yml + merge-verification.md）→ lease push
  crctl merge status <cr_id>                        只读快照：journal phase + 每仓 intent/observation（零写入、零 fetch）
  crctl writeback-apply <cr_id> --stage <s> --spec-id <id> --target-version <ver>
                                                    内部固定 generator/candidate + journal 前完整 preflight；baseline 与 writing-back 状态同 write-set/commit/push，origin-confirmed 后补 status/audit 投影
  crctl archive <cr_id> [--spec-id <id>]                          单一幂等归档：四账本同批 write-set + archive commit + lease push → cleanup（txws/CR worktree/本地 ref）；cleanup 失败返回 CR_ARCHIVE_CLEANUP_PENDING，重跑只续清理；rejected/withdrawn 未合并远端 ref 保留为 preservedRefs（TASK-09）
  crctl upgrade-check                                         临时只读预检（TASK-11）：origin 权威事实分类新协议激活风险（safe/requiresReapproval/blocksUpgrade/canActivate）；有 blocker 或事实不确定 exit 1，全程零写入；协议切换后随 CUSTOM-TODO-009 整体删除
  crctl report [--period <N>d]                   跨 CR 聚合：状态直方图/SLA（累计口径）+ periodActivity（受 --period 窗口过滤，如 7d/30d；不传则不过滤，只读）
  crctl test    <cr_id> --plan <temp-json>      结构化测试闭环：读 cr-test-plan/v1，shell:false 执行，原子发布机器证据/traceability tests/review-loop
  crctl next    <cr_id>                          输出下一个该跑的节点（blocker 未清空绝不给 human_approval）
  crctl git     <sub> [args...] [--cwd <p>]      controlled-shell 白名单执行（只读/安全面；写路径一律走深原语）
  crctl task init <cr_id> [--count-hint <N>]   从 TASK-NN.md 确定性创建/刷新 tasks/_index.yml（开发启动前，CAS+审计）；--count-hint 写入前校验 TASK 集恰为 {cr}-TASK-01..{pad2(N)}（失败 TASK_COUNT_MISMATCH 零写入）
  crctl task append <cr_id>                     developing 期只追加更大编号 TASK，保留既有 done/done-at（CAS+审计）
  crctl task done <cr_id> --task <task_id>      tasks/_index.yml 标 done（developing 态，CAS+审计）


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
  const CRCTL_FLAGS = ['--cwd', '--workspace']; // crctl 自己的旗标，不透传给 git
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (CRCTL_FLAGS.includes(argv[i])) { flags[argv[i].slice(2)] = argv[++i]; continue; }
    positional.push(argv[i]);
  }
  return { flags, positional };
}

async function main() {
  const wantFault = process.env.CRCTL_FAULT_POINT;
  if (wantFault && !FAULT_POINTS.includes(wantFault))
    fail('UNKNOWN_FAULT_POINT', `未知故障注入点: ${wantFault}（已登记: ${FAULT_POINTS.join(', ')}）`, { known: FAULT_POINTS });
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
    case 'review-loop': {
      if (positional[0] === 'reset') return cmdReviewLoopReset(ws, requireCr(positional.slice(1)), gates, flags);
      fail('BAD_ARGS', 'review-loop 仅支持子命令 reset：crctl review-loop reset <CR-ID> --loop <ref> --reason <text>');
    }
    case 'review-record': return cmdReviewRecord(ws, requireCr(positional), gates, flags);
    case 'review-note': return cmdReviewNote(ws, requireCr(positional), gates, flags);
    case 'checkpoint': return cmdCheckpoint(ws, requireCr(positional), gates, flags);
    case 'owner-set': return cmdOwnerSet(ws, requireCr(positional), gates, flags);
    case 'version-set': return cmdVersionSet(ws, requireCr(positional), gates, flags);
    case 'backlog-set': return cmdBacklogSet(ws, requireCr(positional), gates, flags);
    case 'inbox-emit': return cmdInboxEmit(ws, requireCr(positional), gates, flags);
    case 'register': return cmdRegister(ws, flags);
    case 'workspace': return cmdWorkspace(ws, positional, flags);
    case 'merge': return cmdMerge(ws, positional, flags);
    case 'writeback-apply': return cmdWritebackApply(ws, positional, flags, gates);
    case 'archive': return cmdArchive(ws, positional, flags);
    case 'upgrade-check': return cmdUpgradeCheck(ws, flags);
    case 'report': return cmdReport(ws, gates, flags);
    case 'task': {
      if (positional[0] === 'init') {
        if (positional.length !== 2) fail('BAD_ARGS', 'task init 用法：crctl task init <CR-ID> [--count-hint <N>]');
        return cmdTaskInit(ws, requireCr(positional.slice(1)), flags);
      }
      if (positional[0] === 'append') {
        if (positional.length !== 2) fail('BAD_ARGS', 'task append 用法：crctl task append <CR-ID>');
        return cmdTaskAppend(ws, requireCr(positional.slice(1)));
      }
      if (positional[0] === 'done') return cmdTaskDone(ws, requireCr(positional.slice(1)), gates, flags);
      fail('BAD_ARGS', 'task 仅支持子命令 init/append/done：crctl task init <CR-ID> | crctl task append <CR-ID> | crctl task done <CR-ID> --task <TASK-ID>');
    }

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

main().catch((e) => { fail('INTERNAL_ERROR', e && e.stack ? e.stack : String(e)); });


function cmdUpgradeCheck(ws, flags) {
  // 临时只读预检（TASK-11）：从 origin 权威事实分类新协议激活风险；有 blocker 或事实不确定 exit 1，全程零写入。
  // 全部安装完成协议切换且无旧事务后，按 CUSTOM-TODO-009 连同 dispatch/help/tests 整体删除。
  const ctx = resolveRepositories(ws);
  const result = checkUpgrade(ctx);
  ok({ op: 'upgrade-check', temporary: true, ...result });
  if (!result.canActivate) process.exit(1);
}

async function cmdArchive(ws, positional, flags) {
  const cr = positional[0];
  if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) fail('BAD_ARGS', 'archive 需要 CR-ID');
  let specId = flags['spec-id'] == null ? undefined : String(flags['spec-id']);
  const ctx = resolveRepositories(ws);
  // CR-2026-060 G4（AC-13）：new mode 可省 --spec-id（writing-back 首跑从 strict authority 解析并持久化 payload；清理后重放读 journal）。
  let mode = 'legacy';
  let targetSpecId;
  try {
    mode = resolveTargetSpecMode(ctx, cr, { authority: { path: crWorktreePath(ctx, cr), source: 'cr-worktree' } }).mode;
  } catch (e) {
    if (e instanceof TxError) fail(e.code, e.message, e.extra);
    throw e;
  }
  if (mode === 'new') {
    if (specId == null || specId === '') {
      let strictAuth;
      try {
        strictAuth = resolveWritebackAuthorityStrict(ctx, cr);
      } catch (e) {
        if (e instanceof TxError && e.code === 'WRITEBACK_SPEC_REQUIRED') fail('ARCHIVE_SPEC_REQUIRED', e.message, e.extra);
        if (e instanceof TxError) fail(e.code, e.message, e.extra);
        throw e;
      }
      let m;
      try { m = resolveTargetSpecMode(ctx, cr, { authority: strictAuth }); }
      catch (e) { if (e instanceof TxError) fail(e.code, e.message, e.extra); throw e; }
      specId = m.targetSpecId;
      targetSpecId = m.targetSpecId;
    } else {
      targetSpecId = specId;
    }
  }
  const result = await runTxAsync(archiveCr(ctx, {
    cr, specId, mode, targetSpecId, workspace: ws,
    // FR-03：唯一生产 adapter——schema v1 archive 事件 + 确定性 dedup 文件名；
    // 发送失败由 emitOutboxEvent 返回 null，archiveCr 转为 EMIT_FAILED warning（不阻断归档）。
    emitArchiveEvent: ({ cr, commit }) => emitOutboxEvent(ws, {
      event_kind: 'archive',
      cr_id: cr,
      from_status: 'writing-back',
      to_status: 'archived',
      trigger: 'cr-archive',
      commit_sha: commit,
      actor: identity(ws),
      dedup_name: `archive-${cr}-${commit}.json`,
    }),
    // CR-2026-049 TASK-03：trace pending 前置门补发 adapter（复用 TASK-02 的 journal intent 与 dedupName）；
    // 失败返回 null → archiveCr 抛 ARCHIVE_TRACE_PENDING，零写入保留现场。
    replayTraceEvent: ({ cr, intent }) => emitOutboxEvent(ws, {
      event_kind: 'trace',
      cr_id: cr,
      commit_sha: intent.commit,
      actor: identity(ws),
      payload: intent.payload,
      dedup_name: intent.dedupName,
    }),
  }));
  auditLog(ws, { kind: 'archive', cr, txId: result.txId, phase: result.phase, status: result.status, changed: result.changed, actor: identity(ws) });
  ok({ op: 'archive', ...result });
}
async function cmdWritebackApply(ws, positional, flags, gates) {
  const cr = positional[0];
  if (!/^CR-\d{4}-\d{3,}$/.test(cr || '')) fail('BAD_ARGS', 'writeback-apply 需要 CR-ID');
  const allowedFlags = new Set(['cmdList', 'workspace', 'stage', 'spec-id', 'target-version', 'milestone-name', 'brief', 'milestone-file']);
  const unknownFlags = Object.keys(flags).filter((key) => !allowedFlags.has(key));
  if (unknownFlags.length) fail('BAD_ARGS', `writeback-apply 不接受参数: ${unknownFlags.map((x) => `--${x}`).join(', ')}`);
  const stage = flags.stage;
  if (!['baseline', 'tasks', 'traceability'].includes(stage)) fail('BAD_ARGS', 'writeback-apply 需要 --stage baseline|tasks|traceability');
  if (flags.candidate || flags['candidate-out'] || flags.generator || flags.manifest) fail('BAD_ARGS', 'writeback-apply 不接受 candidate/generator/manifest 路径；由 crctl 按 stage 内部固定');
  const ctx = resolveRepositories(ws);
  // CR-2026-060 G4（SDD §4.4）：mode 唯一裁决——authority 按 §2.2.2 生命周期绑定；
  // 预检用 CR worktree（永不抛）；new 分支的实际 spec/version 权威走 strict txws（无回退）。
  let mode;
  try {
    mode = resolveTargetSpecMode(ctx, cr, { authority: { path: crWorktreePath(ctx, cr), source: 'cr-worktree' } });
  } catch (e) {
    if (e instanceof TxError) fail(e.code, e.message, e.extra);
    throw e;
  }
  let specId = flags['spec-id'];
  let targetVersion = flags['target-version'];
  if (mode.mode === 'legacy') {
    // legacy：现行路径，spec/version 必填=BAD_ARGS；traceability milestone-file 必填=BAD_ARGS；其余 milestone 限制既有。
    if (!specId) fail('BAD_ARGS', 'writeback-apply 需要 --spec-id <id>');
    // B-SDD-003（CR-2026-057）：按 flag 存在性判定——缺 flag → BAD_ARGS；显式 --target-version "" 放行进共用规范化守卫 → WRITEBACK_VERSION_INVALID
    if (!('target-version' in flags)) fail('BAD_ARGS', 'writeback-apply 需要 --target-version <version>');
    if (stage === 'baseline' && flags['milestone-file'] != null) fail('BAD_ARGS', 'baseline 不接受 --milestone-file');
    if (stage === 'tasks' && (flags['milestone-name'] != null || flags.brief != null || flags['milestone-file'] != null)) fail('BAD_ARGS', 'tasks 不接受 milestone 参数');
    if (stage === 'traceability' && !flags['milestone-file']) fail('BAD_ARGS', 'traceability 需要 --milestone-file <workspace-relative-path>');
    if (stage === 'traceability' && (flags['milestone-name'] != null || flags.brief != null)) fail('BAD_ARGS', 'traceability 不接受 --milestone-name/--brief');
  } else {
    // new：milestone 任一 flag 传入 → BAD_ARGS（N/A）；spec/version 可省略，从 strict txws authority 补全；显式只做相等校验。
    if (flags['milestone-file'] != null || flags['milestone-name'] != null || flags.brief != null) fail('BAD_ARGS', 'new mode 不接受 milestone 参数（milestone=N/A）');
    let strictAuth;
    try {
      strictAuth = resolveWritebackAuthorityStrict(ctx, cr);
    } catch (e) {
      if (e instanceof TxError) fail(e.code, e.message, e.extra);
      throw e;
    }
    if (specId == null || specId === '') {
      specId = mode.targetSpecId;
    } else if (String(specId) !== mode.targetSpecId) {
      fail('WRITEBACK_SPEC_MISMATCH', `new mode 显式 --spec-id ${JSON.stringify(specId)} 与 authority target-spec-id ${JSON.stringify(mode.targetSpecId)} 不一致`, { cr, specId, targetSpecId: mode.targetSpecId });
    }
    if (!('target-version' in flags)) {
      const r = readCrMdTargetVersion(strictAuth.path, cr);
      const n = r.ok ? normalizeTargetVersion(r.raw) : { ok: false, reason: r.reason };
      if (!n.ok) fail('WRITEBACK_VERSION_INVALID', `new mode 省略 --target-version 时从 strict authority 读取失败（${n.reason}）`, { cr, reason: n.reason });
      targetVersion = n.value;
    }
  }
  const result = await runTxAsync(applyWriteback(ctx, {
    cr, stage, specId, targetVersion, workspace: ws, mode: mode.mode,
    milestoneName: flags['milestone-name'], brief: flags.brief, milestoneFile: flags['milestone-file'],
    validateBaselineAdvance: ({ workspace, plannedExisting }) => preflightAdvance(workspace, cr, gates, {
      to: 'writing-back', trigger: 'writeback-prd-sdd', expect: 'merging', specId, plannedExisting,
    }),
    emitStatusEvent: ({ from, to, trigger, commit, dedupName }) => {
      const name = emitOutboxEvent(ws, {
        event_kind: 'status', cr_id: cr, from_status: from, to_status: to, trigger,
        commit_sha: commit, actor: identity(ws), dedup_name: dedupName,
      });
      if (!name) throw new Error('status outbox 写入失败');
      return name;
    },
    emitAdvanceAudit: ({ from, to, trigger, commit, dedupKey }) => auditLogOnce(ws, {
      kind: 'advance', cr, from, to, trigger, by: identity(ws), commit, result: 'success',
    }, dedupKey),
    // CR-2026-049 TASK-02：trace 事件发射 adapter（schema v1 + 确定性 dedup 文件名）；
    // 失败返回 null → applyWritebackAtomic 转为 EMIT_FAILED warning 并保持 journal pending。
    emitTraceEvent: ({ cr, commit, dedupName, payload }) => emitOutboxEvent(ws, {
      event_kind: 'trace',
      cr_id: cr,
      commit_sha: commit,
      actor: identity(ws),
      payload,
      dedup_name: dedupName,
    }),
  }));
  auditLog(ws, { kind: 'writeback', cr, txId: result.txId, stage, phase: result.phase, commit: result.commit, changed: result.changed, actor: identity(ws) });
  ok({ op: 'writeback-apply', ...result });
}

// CR-2026-031 TASK-04：durable-tx 原语单元测试（锁矩阵 / journal envelope / recoverable write-set）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireLock, loadOrCreateJournal, saveJournal, applyWriteSet, recoverWriteSet, cleanupTxBlobs,
  pidProbe, _setPidProbe, durableWriteFile, nowIso,
} from '../lib/durable-tx.mjs';
import { TxError } from '../lib/durable-tx.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import crypto from 'node:crypto';
const sha256Hex = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crctl-dtx-'));
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const expectTx = async (p, code) => {
  try { await p; } catch (e) {
    assert.ok(e instanceof TxError, `应为 TxError，实际: ${e}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`期望 ${code}，但没有抛错`);
};
const writeOwner = (root, scope, owner) => {
  const dir = path.join(root, '.crctl', 'locks', scope);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner));
};
const baseOwner = () => ({ v: 1, token: 'deadbeef', pid: 424242, hostname: os.hostname(), startedAt: nowIso(), op: 'merge', cr: 'CR-X' });

test('TASK-04：acquireLock 基本获取/竞争/释放/重获取；token 不匹配拒绝释放（AC-2）', async () => {
  const root = mkRoot();
  try {
    const l1 = await acquireLock({ root, scope: 'merge:CR-1', op: 'merge', cr: 'CR-1' });
    assert.match(l1.token, /^[0-9a-f]{32}$/);
    assert.ok(fs.existsSync(path.join(root, '.crctl', 'locks', 'merge-CR-1', 'owner.json')), 'scope 中 ":" 映射为目录安全字符');
    await expectTx(acquireLock({ root, scope: 'merge:CR-1', op: 'merge', cr: 'CR-1' }), 'TX_LOCK_HELD');
    await l1.release();
    assert.ok(!fs.existsSync(path.join(root, '.crctl', 'locks', 'merge-CR-1')));
    await l1.release(); // 幂等
    const l2 = await acquireLock({ root, scope: 'merge:CR-1', op: 'merge', cr: 'CR-1' });
    // 篡改 owner token 后释放 → TX_LOCK_TOKEN_MISMATCH
    const op = path.join(root, '.crctl', 'locks', 'merge-CR-1', 'owner.json');
    const o = JSON.parse(fs.readFileSync(op, 'utf8'));
    o.token = 'ffffffff';
    fs.writeFileSync(op, JSON.stringify(o));
    await expectTx(l2.release(), 'TX_LOCK_TOKEN_MISMATCH');
    // 非法 scope / op 硬失败
    await expectTx(acquireLock({ root, scope: '../evil', op: 'merge' }), 'TX_LOCK_SCOPE_INVALID');
    await expectTx(acquireLock({ root, scope: 'ok', op: 'nope' }), 'TX_LOCK_OP_INVALID');
  } finally { rm(root); }
});

test('TASK-04：锁竞争矩阵 live PID / EPERM / ESRCH 接管 / foreign host / owner 不完整（AC-2）', async () => {
  const root = mkRoot();
  const realProbe = pidProbe;
  try {
    // live PID（无关活进程 = PID reuse 语义：同机存活即保守阻断）
    writeOwner(root, 's-live', { ...baseOwner(), pid: process.pid });
    await expectTx(acquireLock({ root, scope: 's-live', op: 'merge' }), 'TX_LOCK_HELD');
    // EPERM = 存在
    writeOwner(root, 's-eperm', baseOwner());
    _setPidProbe(() => { const e = new Error('eperm'); e.code = 'EPERM'; throw e; });
    await expectTx(acquireLock({ root, scope: 's-eperm', op: 'merge' }), 'TX_LOCK_HELD');
    // ESRCH = 死亡 → 接管成功并写入新 owner
    writeOwner(root, 's-esrch', baseOwner());
    _setPidProbe(() => { const e = new Error('esrch'); e.code = 'ESRCH'; throw e; });
    const l = await acquireLock({ root, scope: 's-esrch', op: 'merge' });
    const owner = JSON.parse(fs.readFileSync(path.join(root, '.crctl', 'locks', 's-esrch', 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid, '接管后 owner 为本进程');
    assert.notEqual(owner.token, 'deadbeef');
    await l.release();
    _setPidProbe(realProbe);
    // foreign hostname
    writeOwner(root, 's-foreign', { ...baseOwner(), hostname: 'another-host' });
    const ef = await expectTx(acquireLock({ root, scope: 's-foreign', op: 'merge' }), 'TX_LOCK_HELD');
    assert.ok(ef.message.includes('another-host'));
    // owner 不完整（缺 token）
    writeOwner(root, 's-incomplete', { pid: 1, hostname: os.hostname() });
    await expectTx(acquireLock({ root, scope: 's-incomplete', op: 'merge' }), 'TX_LOCK_HELD');
    // owner JSON 非法
    fs.mkdirSync(path.join(root, '.crctl', 'locks', 's-badjson'), { recursive: true });
    fs.writeFileSync(path.join(root, '.crctl', 'locks', 's-badjson', 'owner.json'), '{oops');
    await expectTx(acquireLock({ root, scope: 's-badjson', op: 'merge' }), 'TX_LOCK_HELD');
  } finally { _setPidProbe(realProbe); rm(root); }
});

test('TASK-04：journal 创建/幂等加载/envelope 不变量（AC-3 基础）', async () => {
  const root = mkRoot();
  try {
    const a = await loadOrCreateJournal({ root, op: 'register', key: 'req-tbd-title-x', graphDigest: 'g1', inputDigest: 'i1' });
    assert.equal(a.created, true);
    assert.equal(a.journal.op, 'register');
    assert.equal(a.journal.register, null, '新建 envelope 五 payload 均 null');
    // 幂等加载：同 inputDigest
    const b = await loadOrCreateJournal({ root, op: 'register', key: 'req-tbd-title-x', inputDigest: 'i1' });
    assert.equal(b.created, false);
    assert.equal(b.journal.txId, a.journal.txId);
    // inputDigest 不一致 → 硬阻断
    await expectTx(loadOrCreateJournal({ root, op: 'register', key: 'req-tbd-title-x', inputDigest: 'other' }), 'TX_INPUT_CONFLICT');
    // save：payload 置位后可存；op 对应 payload 为空 → 拒绝
    a.journal.register = { foo: 1 };
    a.journal.phase = 'committed';
    const saved = await saveJournal({ path: a.journalPath, journal: a.journal });
    assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    const re = JSON.parse(fs.readFileSync(a.journalPath, 'utf8'));
    assert.deepEqual(re.register, { foo: 1 });
    await expectTx(saveJournal({ path: a.journalPath, journal: { ...a.journal, register: null } }), 'TX_JOURNAL_INVALID');
    await expectTx(saveJournal({ path: a.journalPath, journal: { ...a.journal, merge: { x: 1 } } }), 'TX_JOURNAL_INVALID');
    // 非法 journal 阻塞后续加载（不静默跳过）
    fs.writeFileSync(a.journalPath, '{broken');
    await expectTx(loadOrCreateJournal({ root, op: 'register', key: 'req-tbd-title-x', inputDigest: 'i1' }), 'TX_JOURNAL_INVALID');
  } finally { rm(root); }
});

test('TASK-04：applyWriteSet 全 redo / 幂等 skip / 第三值冲突零写入（AC-1/AC-3）', async () => {
  const root = mkRoot();
  try {
    const { journal, journalPath } = await loadOrCreateJournal({ root, op: 'merge', cr: 'CR-9', inputDigest: 'x' });
    const fNew = 'change-requests/_backlog.yml';
    const fMod = 'dir-graph.yaml';
    fs.mkdirSync(path.dirname(path.join(root, fMod)), { recursive: true });
    fs.writeFileSync(path.join(root, fMod), 'old-content');
    const afterNew = 'schema: cr-backlog/v2\n';
    const afterMod = 'new-content';
    const entries = [
      { path: fNew, beforeSha256: null, afterSha256: sha256Hex(afterNew), content: afterNew },
      { path: fMod, beforeSha256: sha256Hex('old-content'), afterSha256: sha256Hex(afterMod), content: afterMod },
    ];
    const r1 = await applyWriteSet({ root, txId: journal.txId, entries });
    assert.equal(r1.changed, true);
    assert.equal(fs.readFileSync(path.join(root, fNew), 'utf8'), afterNew);
    assert.equal(fs.readFileSync(path.join(root, fMod), 'utf8'), afterMod);
    // complete 后 blob/manifest 已清理
    const txDir = path.dirname(journalPath);
    assert.ok(!fs.existsSync(path.join(txDir, 'blobs')), 'complete 后 blobs 清理');
    assert.ok(!fs.existsSync(path.join(txDir, 'write-set.json')), 'complete 后 manifest 清理');
    // 幂等重放：全部 skip
    const r2 = await applyWriteSet({ root, txId: journal.txId, entries });
    assert.equal(r2.changed, false);
    // 第三值：先人为改动 fMod → TX_RECOVERY_CONFLICT 且两侧均不覆盖
    fs.writeFileSync(path.join(root, fMod), 'third-party');
    await expectTx(applyWriteSet({ root, txId: journal.txId, entries }), 'TX_RECOVERY_CONFLICT');
    assert.equal(fs.readFileSync(path.join(root, fMod), 'utf8'), 'third-party');
    assert.equal(fs.readFileSync(path.join(root, fNew), 'utf8'), afterNew);
    // path traversal / absolute 拒绝
    await expectTx(applyWriteSet({ root, txId: journal.txId, entries: [{ path: '../evil.txt', beforeSha256: null, afterSha256: sha256Hex('x'), content: 'x' }] }), 'TX_WRITESET_INVALID');
    await expectTx(applyWriteSet({ root, txId: journal.txId, entries: [{ path: 'C:/evil.txt', beforeSha256: null, afterSha256: sha256Hex('x'), content: 'x' }] }), 'TX_WRITESET_INVALID');
    // 未知 txId
    await expectTx(applyWriteSet({ root, txId: 'nonexistent00000000000000000000', entries }), 'TX_NOT_FOUND');
  } finally { rm(root); }
});

test('TASK-04：真实 kill/restart——rename 间隙崩溃后 recover 得 redo/skip，绝不覆盖第三值（AC-1）', async () => {
  const root = mkRoot();
  const childScript = path.join(root, 'crash-apply.mjs');
  try {
    const { journal } = await loadOrCreateJournal({ root, op: 'merge', cr: 'CR-10', inputDigest: 'y' });
    const libDir = path.join(__dirname, '..', 'lib');
    fs.writeFileSync(path.join(root, 'a.txt'), 'A0');
    fs.writeFileSync(path.join(root, 'b.txt'), 'B0');
    fs.writeFileSync(childScript, `
import { applyWriteSet } from ${JSON.stringify(pathToFileURL(path.join(libDir, 'durable-tx.mjs')).href)};
const root = process.argv[2]; const txId = process.argv[3];
const { createHash } = await import('node:crypto');
const h = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
try {
  await applyWriteSet({ root, txId, entries: [
    { path: 'a.txt', beforeSha256: h('A0'), afterSha256: h('A1'), content: 'A1' },
    { path: 'b.txt', beforeSha256: h('B0'), afterSha256: h('B1'), content: 'B1' },
  ] });
  console.log('NO_FAULT');
} catch (e) { console.log('CAUGHT:' + e.code); process.exit(3); }
`);
    const r = spawnSync(process.execPath, [childScript, root, journal.txId], {
      encoding: 'utf8', env: { ...process.env, CRCTL_FAULT_POINT: 'tx-apply-between-rename' },
    });
    assert.equal(r.status, 3, '子进程应被故障注入杀死');
    assert.ok(r.stdout.includes('CAUGHT:FAULT_INJECTED'), r.stdout);
    // 半状态：a.txt 已应用，b.txt 未应用
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'A1');
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'B0');
    // 恢复：b.txt 从 blob redo
    const rec = await recoverWriteSet({ txRoot: root, txId: journal.txId });
    assert.equal(rec.changed, true);
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'B1');
    // 再恢复：全 skip，幂等
    const rec2 = await recoverWriteSet({ txRoot: root, txId: journal.txId });
    assert.equal(rec2.changed, false);
  } finally { rm(root); }
});

test('TASK-04：complete 标记前崩溃 → 恢复全 skip 且收敛到 complete（AC-1）', async () => {
  const root = mkRoot();
  const childScript = path.join(root, 'crash-before-complete.mjs');
  try {
    const { journal } = await loadOrCreateJournal({ root, op: 'writeback', cr: 'CR-11', inputDigest: 'z' });
    const libDir = path.join(__dirname, '..', 'lib');
    fs.writeFileSync(childScript, `
import { applyWriteSet } from ${JSON.stringify(pathToFileURL(path.join(libDir, 'durable-tx.mjs')).href)};
const root = process.argv[2]; const txId = process.argv[3];
const { createHash } = await import('node:crypto');
const h = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
try {
  await applyWriteSet({ root, txId, entries: [
    { path: 'c.txt', beforeSha256: null, afterSha256: h('C1'), content: 'C1' },
  ] });
  console.log('NO_FAULT');
} catch (e) { console.log('CAUGHT:' + e.code); process.exit(3); }
`);
    const r = spawnSync(process.execPath, [childScript, root, journal.txId], {
      encoding: 'utf8', env: { ...process.env, CRCTL_FAULT_POINT: 'tx-apply-before-complete' },
    });
    assert.equal(r.status, 3);
    assert.equal(fs.readFileSync(path.join(root, 'c.txt'), 'utf8'), 'C1', '写入已落盘');
    const txDir = path.join(root, '.crctl', 'transactions', 'writeback', 'CR-11', journal.txId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(txDir, 'write-set.json'), 'utf8')).state, 'prepared', 'complete 标记未写');
    const rec = await recoverWriteSet({ txRoot: root, txId: journal.txId });
    assert.equal(rec.changed, false, '全 skip（内容已到位）');
    assert.ok(!fs.existsSync(path.join(txDir, 'write-set.json')), '恢复后 complete 并清理 manifest');
    assert.equal(fs.readFileSync(path.join(root, 'c.txt'), 'utf8'), 'C1');
  } finally { rm(root); }
});

test('review repair：recoverWriteSet 只恢复指定 txId，并使用 manifest 绑定的 targetRoot', async () => {
  const txRoot = mkRoot();
  const rootA = path.join(txRoot, 'a');
  const rootB = path.join(txRoot, 'b');
  fs.mkdirSync(rootA); fs.mkdirSync(rootB);
  try {
    const a = await loadOrCreateJournal({ root: txRoot, op: 'merge', cr: 'CR-A', inputDigest: 'a' });
    const b = await loadOrCreateJournal({ root: txRoot, op: 'writeback', cr: 'CR-B', inputDigest: 'b' });
    const crash = async (root, txId, text) => {
      process.env.CRCTL_FAULT_POINT = 'tx-apply-before-complete';
      await expectTx(applyWriteSet({ root, txRoot, txId, entries: [
        { path: 'result.txt', beforeSha256: null, afterSha256: sha256Hex(text), content: text },
      ] }), 'FAULT_INJECTED');
      delete process.env.CRCTL_FAULT_POINT;
    };
    await crash(rootA, a.journal.txId, 'A');
    await crash(rootB, b.journal.txId, 'B');
    await recoverWriteSet({ txRoot, txId: a.journal.txId });
    assert.equal(fs.readFileSync(path.join(rootA, 'result.txt'), 'utf8'), 'A');
    assert.ok(fs.existsSync(path.join(path.dirname(b.journalPath), 'write-set.json')), '其他事务仍待恢复');
    assert.equal(fs.readFileSync(path.join(rootB, 'result.txt'), 'utf8'), 'B');
  } finally { delete process.env.CRCTL_FAULT_POINT; rm(txRoot); }
});

test('TASK-04：cleanupTxBlobs 幂等；blob 与 afterSha256 不符 → TX_BLOB_MISMATCH（AC-3）', async () => {
  const root = mkRoot();
  try {
    const { journal } = await loadOrCreateJournal({ root, op: 'archive', cr: 'CR-12', inputDigest: 'w' });
    await cleanupTxBlobs({ txRoot: root, txId: journal.txId }); // 无 blob 也不报错
    await cleanupTxBlobs({ txRoot: root, txId: journal.txId });
    // 预置坏 blob：同 txId 第二次 apply 发现 blob 哈希不符
    const txDir = path.join(root, '.crctl', 'transactions', 'archive', 'CR-12', journal.txId);
    fs.mkdirSync(path.join(txDir, 'blobs'), { recursive: true });
    const after = sha256Hex('good');
    fs.writeFileSync(path.join(txDir, 'blobs', after), 'corrupted');
    await expectTx(applyWriteSet({ root, txId: journal.txId, entries: [{ path: 'd.txt', beforeSha256: null, afterSha256: after, content: 'good' }] }), 'TX_BLOB_MISMATCH');
    // content 与 afterSha256 不符
    await cleanupTxBlobs({ txRoot: root, txId: journal.txId }).then(() => fs.rmSync(path.join(txDir, 'blobs'), { recursive: true, force: true }));
    await expectTx(applyWriteSet({ root, txId: journal.txId, entries: [{ path: 'd.txt', beforeSha256: null, afterSha256: after, content: 'different' }] }), 'TX_BLOB_MISMATCH');
  } finally { rm(root); }
});

test('CR-2026-033 T02：checkpoint op/payload slot generic 校验（不涉及业务字段）', async () => {
  const root = mkRoot();
  try {
    // checkpoint op 可创建 journal，envelope 有 checkpoint:null
    const { journal } = await loadOrCreateJournal({ root, op: 'checkpoint', cr: 'CR-2026-033', graphDigest: 'g', inputDigest: 'd' });
    assert.equal(journal.op, 'checkpoint');
    assert.equal(journal.checkpoint, null);
    // 置位 checkpoint payload 后可 save；op-payload 对应（generic 层）
    journal.checkpoint = { repositories: [], batchId: null, kbSourceSha: null, metadataCommit: null };
    journal.phase = 'init';
    await saveJournal({ path: path.join(root, '.crctl', 'transactions', 'checkpoint', 'CR-2026-033', journal.txId, 'journal.json'), journal });
    // 多个 payload 非空 → generic envelope 拒绝
    journal.ledger = { phase: 'x' };
    await expectTx(saveJournal({ path: path.join(root, '.crctl', 'transactions', 'checkpoint', 'CR-2026-033', journal.txId, 'journal.json'), journal }), 'TX_JOURNAL_INVALID');
  } finally { rm(root); }
});

// check-skill-matrix.mjs 黑盒测试（CR-2026-025 TASK-04，FR-5/D-8）
// 约定（B-14）：node --test + spawnSync，零第三方依赖；fixture 用 mkdtempSync 构造临时假仓，
// 把被测脚本复制进 {tmp}/skills/shared/crctl/scripts/ 使 root 解析落在临时仓内。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SRC = path.resolve(import.meta.dirname, '..', 'check-skill-matrix.mjs');

/** 构造最小合规假仓基线：1 个 active skill（skill-a，dev-agent owns）+ external foo（引用点在 pipeline-templates/p.json）。 */
function makeRepo(overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'csm-test-'));
  const scriptsDir = path.join(dir, 'skills', 'shared', 'crctl', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(SRC, path.join(scriptsDir, 'check-skill-matrix.mjs'));
  mkdirSync(path.join(dir, 'pipeline-templates'), { recursive: true });
  mkdirSync(path.join(dir, 'skills', 'skill-a'), { recursive: true });
  writeFileSync(path.join(dir, 'skills', '_index.yml'), overrides.index ?? [
    'skills:', '  - id: skill-a', '    path: ./skill-a/SKILL.md', '    status: active',
  ].join('\n') + '\n');
  writeFileSync(path.join(dir, 'agent-skill-matrix.yml'), overrides.matrix ?? [
    'actors:', '  dev-agent:', '    owns:', '      - skill-a', '    external:', '      - foo',
  ].join('\n') + '\n');
  writeFileSync(path.join(dir, 'AGENT-SKILL-MATRIX.md'), overrides.md ?? [
    '# AGENT-SKILL-MATRIX', '## 主责矩阵', '| `dev-agent` | `skill-a` |',
  ].join('\n') + '\n');
  writeFileSync(path.join(dir, 'skills', 'skill-a', 'SKILL.md'), overrides.skillRef ?? '# skill-a\nfoo\n');
  writeFileSync(path.join(dir, 'pipeline-templates', 'p.json'), overrides.pipelineRef ?? '{"prompt": "use foo"}\n');
  return { dir, script: path.join(scriptsDir, 'check-skill-matrix.mjs') };
}

function run(script, cwd) {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

test('检查4①：external 有引用点（pipeline-templates/*.json 内）→ 通过（AC-2 判绿侧）', () => {
  const { dir, script } = makeRepo();
  try { const r = run(script, dir); assert.equal(r.status, 0, r.stderr); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('检查4②：external 零引用点 → 退出非 0 且错误含技能名（AC-1）', () => {
  const { dir, script } = makeRepo({ skillRef: '# skill-a\n', pipelineRef: '{"prompt": "no ref"}\n' });
  try {
    const r = run(script, dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /零引用点/);
    assert.match(r.stderr, /"foo"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('检查4③：同一 external 被多 actor 声明且有引用点 → 通过（brainstorming 形态，B-4）', () => {
  const { dir, script } = makeRepo({
    matrix: [
      'actors:', '  dev-agent:', '    owns:', '      - skill-a', '    external:', '      - foo',
      '  qa-agent:', '    owns:', '      - skill-b', '    external:', '      - foo',
    ].join('\n') + '\n',
    index: ['skills:', '  - id: skill-a', '    status: active', '  - id: skill-b', '    status: active'].join('\n') + '\n',
    md: ['# AGENT-SKILL-MATRIX', '## 主责矩阵', '| `dev-agent` | `skill-a` |', '| `qa-agent` | `skill-b` |'].join('\n') + '\n',
  });
  try { const r = run(script, dir); assert.equal(r.status, 0, r.stderr); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('检查4④：多 actor 声明且零引用 → 错误同时列出全部声明 actor（FR-1 文案）', () => {
  const { dir, script } = makeRepo({
    matrix: [
      'actors:', '  dev-agent:', '    owns:', '      - skill-a', '    external:', '      - foo',
      '  qa-agent:', '    owns:', '      - skill-b', '    external:', '      - foo',
    ].join('\n') + '\n',
    index: ['skills:', '  - id: skill-a', '    status: active', '  - id: skill-b', '    status: active'].join('\n') + '\n',
    md: ['# AGENT-SKILL-MATRIX', '## 主责矩阵', '| `dev-agent` | `skill-a` |', '| `qa-agent` | `skill-b` |'].join('\n') + '\n',
    skillRef: '# skill-a\n', pipelineRef: '{"prompt": "no ref"}\n',
  });
  try {
    const r = run(script, dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /dev-agent、qa-agent/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('检查4⑤：CRLF 与 LF 同内容夹具结果一致（FR-3 行尾纪律）', () => {
  const a = makeRepo();
  const b = makeRepo();
  try {
    const norm = (dir) => {
      for (const rel of ['skills/_index.yml', 'agent-skill-matrix.yml', 'AGENT-SKILL-MATRIX.md', 'skills/skill-a/SKILL.md', 'pipeline-templates/p.json']) {
        const p = path.join(dir, rel);
        writeFileSync(p, readFileSync(p, 'utf8').replaceAll('\n', '\r\n'), 'utf8');
      }
    };
    norm(a.dir);
    const ra = run(a.script, a.dir);
    const rb = run(b.script, b.dir);
    assert.equal(ra.status, rb.status);
    assert.equal(ra.stderr.replaceAll('\r', ''), rb.stderr.replaceAll('\r', ''));
  } finally { rmSync(a.dir, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true }); }
});

test('检查4⑥：既有三项检查回归——缺归属 / 目标缺失 / md 漂移各至少一条', () => {
  // 缺归属：active 但无 owns
  {
    const { dir, script } = makeRepo({ matrix: 'actors:\n  dev-agent:\n    owns:\n      - other-a\n    external:\n      - foo\n' });
    try {
      const r = run(script, dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /缺归属/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  // 目标缺失：owns 目标未注册且未声明 external
  {
    const { dir, script } = makeRepo({ matrix: 'actors:\n  dev-agent:\n    owns:\n      - ghost-skill\n    external:\n      - foo\n', md: ['# x', '## 主责矩阵', '| `dev-agent` | `ghost-skill` |'].join('\n') + '\n' });
    try {
      const r = run(script, dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /目标缺失/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  // md 漂移：md 表格缺一行
  {
    const { dir, script } = makeRepo({ md: ['# x', '## 主责矩阵', '| `dev-agent` | `skill-a` |', '| `dev-agent` | `extra-skill` |'].join('\n') + '\n', index: ['skills:', '  - id: skill-a', '    status: active', '  - id: extra-skill', '    status: active'].join('\n') + '\n' });
    try {
      const r = run(script, dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /md 漂移/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('检查4⑦：三段输入各自空结构 → 硬失败退出非 0（TD-BL-2，不静默降级）', () => {
  // _index.yml 无 active
  {
    const { dir, script } = makeRepo({ index: 'skills:\n  - id: skill-a\n    status: archived\n' });
    try {
      const r = run(script, dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /空结构守卫/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  // agent-skill-matrix.yml 无 owns
  {
    const { dir, script } = makeRepo({ matrix: 'actors:\n  dev-agent:\n    external:\n      - foo\n' });
    try {
      const r = run(script, dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /空结构守卫/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  // md 无主责矩阵
  {
    const { dir, script } = makeRepo({ md: '# 没有主责矩阵\n' });
    try {
      const r = run(script, dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /空结构守卫/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('检查4⑧：只在 openwiki/ 下出现的技能名不计为引用点（AC-2 判红侧）', () => {
  const { dir, script } = makeRepo({ skillRef: '# skill-a\n', pipelineRef: '{"prompt": "no ref"}\n' });
  try {
    mkdirSync(path.join(dir, 'openwiki'), { recursive: true });
    writeFileSync(path.join(dir, 'openwiki', 'note.md'), '# foo 出现在 openwiki 不计引用\n');
    const r = run(script, dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /零引用点/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

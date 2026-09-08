/**
 * promotion-bind.test.mjs — CR-2026-061 AC-13 tools 面集成测试（cmd-05）。
 *
 * 用受控夹具（PATH 前置的 fake `multica` 可执行文件）验证
 * requirement-register 绑定步骤的可执行编码（promotion-bind.mjs）：
 * ① promotion 上下文齐备 → 绑定命令被调用且参数为 {cr_id} --run-id {run_id}，且响应
 *    run_id/issue_id 与 promotion 上下文 fail-closed 全等后才报成功（B-CODE-05）；
 * ①b 响应 run_id/issue_id 与请求/promotion 上下文错配 → BIND_RESPONSE_MISMATCH 技术失败停止；
 * ② 绑定失败（404/409/401/500 任一）→ 技术失败停止，输出含 registration_key 幂等重试指引；
 * ③ 无 promotion 上下文 → 不调用绑定（由 SKILL.md 条件性 Step 2.5 文本约束）；
 * ④ SKILL.md 含「绑定完成前不得推进 requirement-reviewing」硬不变量。
 *
 * 夹具说明：node 以 shell:false spawn 时在 PATH 上只按 .exe（Windows）/无扩展名
 * 可执行位（POSIX）解析命令（.cmd/.bat 不会命中），因此 Windows 上用 go build
 * 一个极小的 fake `multica.exe`（go 不可用时给出明确失败）；POSIX 用同名 shell 脚本。
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, "..", "..");
const SKILL_MD = path.join(SKILL_DIR, "SKILL.md");
const BIND_SCRIPT = path.join(SKILL_DIR, "scripts", "promotion-bind.mjs");

const CR_ID = "CR-2026-061";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "22222222-2222-4222-8222-222222222222";

const isWin = process.platform === "win32";

// ─── 夹具：PATH 前置的 fake multica ──────────────────────────────────────
let fakeDir;
let scenarioPath;
let logPath;
let tmpDir;

function buildFakeExe() {
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "promotion-bind-build-"));
  const fakeGo = path.join(buildDir, "main.go");
  const exe = path.join(buildDir, isWin ? "multica.exe" : "multica");
  fs.writeFileSync(path.join(buildDir, "go.mod"), "module promotionbindfake\n\ngo 1.22\n");
  fs.writeFileSync(
    fakeGo,
    [
      "package main",
      "",
      "import (",
      '\t"encoding/json"',
      '\t"fmt"',
      '\t"os"',
      '\t"path/filepath"',
      ")",
      "",
      "type scenario struct {",
      "\tExit   int    `json:\"exit\"`",
      "\tStdout string `json:\"stdout\"`",
      "\tStderr string `json:\"stderr\"`",
      "}",
      "",
      "func main() {",
      "\tlog := os.Getenv(\"FAKE_MULTICA_LOG_PATH\")",
      "\tif log != \"\" {",
      "\t\tf, err := os.OpenFile(log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)",
      "\t\tif err == nil {",
      "\t\t\tenc, _ := json.Marshal(os.Args[1:])",
      "\t\t\tf.Write(append(enc, '\\n'))",
      "\t\t\tf.Close()",
      "\t\t}",
      "\t}",
      "\traw, err := os.ReadFile(os.Getenv(\"FAKE_MULTICA_SCENARIO_PATH\"))",
      "\tif err != nil {",
      "\t\tfmt.Fprintln(os.Stderr, \"FAKE_FIXTURE_ERROR: scenario unreadable:\", err)",
      "\t\tos.Exit(99)",
      "\t}",
      "\tvar sc scenario",
      "\tif err := json.Unmarshal(raw, &sc); err != nil {",
      "\t\tfmt.Fprintln(os.Stderr, \"FAKE_FIXTURE_ERROR: bad scenario json:\", err)",
      "\t\tos.Exit(99)",
      "\t}",
      "\tif sc.Stdout != \"\" {",
      "\t\tfmt.Fprint(os.Stdout, sc.Stdout)",
      "\t}",
      "\tif sc.Stderr != \"\" {",
      "\t\tfmt.Fprint(os.Stderr, sc.Stderr)",
      "\t}",
      "\t_ = filepath.Base(os.Args[0])",
      "\tos.Exit(sc.Exit)",
      "}",
    ].join("\n"),
  );
  const build = spawnSync("go", ["build", "-o", exe, "."], { encoding: "utf8", cwd: buildDir });
  if (build.status !== 0) {
    throw new Error(
      `fake multica.exe 构建失败（需要 go 工具链）: ${build.stderr}\n` +
        `本集成测试在 Windows 上依赖 go build 生成 PATH 可解析的 .exe 夹具。`,
    );
  }
  return { exe, buildDir };
}

function installFake() {
  const { exe, buildDir } = buildFakeExe();
  return { builtExe: exe, buildDir };
}

let builtExe;
let buildRoot;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promotion-bind-"));
  fakeDir = path.join(tmpDir, "bin");
  fs.mkdirSync(fakeDir);
  scenarioPath = path.join(tmpDir, "scenario.json");
  logPath = path.join(tmpDir, "invocations.log");
  if (!builtExe) {
    const built = installFake();
    builtExe = built.builtExe;
    buildRoot = built.buildDir;
  }
  // 每个用例都重新复制进本次用例的 PATH 目录（afterEach 会删除 tmpDir）。
  fs.copyFileSync(builtExe, path.join(fakeDir, isWin ? "multica.exe" : "multica"));
  if (!isWin) fs.chmodSync(path.join(fakeDir, "multica"), 0o755);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

after(() => {
  if (buildRoot) fs.rmSync(buildRoot, { recursive: true, force: true });
});

function setScenario(exit, { stdout = "", stderr = "" } = {}) {
  fs.writeFileSync(scenarioPath, JSON.stringify({ exit, stdout, stderr }));
}

function runBind() {
  const env = {
    ...process.env,
    PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_MULTICA_SCENARIO_PATH: scenarioPath,
    FAKE_MULTICA_LOG_PATH: logPath,
  };
  delete env.PROMOTION_BIND_MULTICA;
  return spawnSync(process.execPath, [BIND_SCRIPT, CR_ID, RUN_ID, ISSUE_ID], { encoding: "utf8", env });
}

function invocations() {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ─── 用例 ────────────────────────────────────────────────────────────────

test("① 有 promotion 上下文：绑定命令被调用且参数为 {cr_id} --run-id {run_id}，响应上下文全等后成功", () => {
  setScenario(0, {
    stdout: JSON.stringify({
      cr_id: CR_ID,
      run_id: RUN_ID,
      issue_id: ISSUE_ID,
      changed: true,
    }),
  });
  const res = runBind();
  assert.equal(res.status, 0, `bind 应成功，stderr: ${res.stderr}`);
  assert.deepEqual(JSON.parse(res.stdout), {
    cr_id: CR_ID,
    run_id: RUN_ID,
    issue_id: ISSUE_ID,
    changed: true,
  });
  // promotion_issue_id 只用于 fail-closed 校验，不传给 multica CLI（CLI 无该参数）。
  assert.deepEqual(invocations(), [["cr", "bind-promotion-run", CR_ID, "--run-id", RUN_ID]]);
});

test("①b 同 run 同 CR 幂等重放：changed=false 且 issue_id 全等，同样视为成功", () => {
  setScenario(0, {
    stdout: JSON.stringify({
      cr_id: CR_ID,
      run_id: RUN_ID,
      issue_id: ISSUE_ID,
      changed: false,
    }),
  });
  const res = runBind();
  assert.equal(res.status, 0, `幂等重放应成功，stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.changed, false);
  assert.equal(out.issue_id, ISSUE_ID);
  assert.equal(invocations().length, 1);
});

test("①c 响应 run_id 与请求 run 错配：BIND_RESPONSE_MISMATCH 技术失败停止（B-CODE-05）", () => {
  setScenario(0, {
    stdout: JSON.stringify({
      cr_id: CR_ID,
      run_id: "99999999-9999-4999-8999-999999999999",
      issue_id: ISSUE_ID,
      changed: true,
    }),
  });
  const res = runBind();
  assert.notEqual(res.status, 0, "run_id 错配必须非零退出");
  assert.ok(res.stderr.includes("BIND_RESPONSE_MISMATCH"), res.stderr);
  assert.ok(res.stderr.includes("run_id 与请求 promotion_run_id 不相等"), res.stderr);
  assert.ok(
    res.stderr.includes("registration_key") && res.stderr.includes("幂等重试"),
    `stderr 应含幂等重试指引: ${res.stderr}`,
  );
});

test("①d 响应 issue_id 与 promotion 上下文错配：BIND_RESPONSE_MISMATCH 技术失败停止（B-CODE-05）", () => {
  setScenario(0, {
    stdout: JSON.stringify({
      cr_id: CR_ID,
      run_id: RUN_ID,
      issue_id: "99999999-9999-4999-8999-999999999999",
      changed: true,
    }),
  });
  const res = runBind();
  assert.notEqual(res.status, 0, "issue_id 错配必须非零退出");
  assert.ok(res.stderr.includes("BIND_RESPONSE_MISMATCH"), res.stderr);
  assert.ok(res.stderr.includes("issue_id 与 promotion_issue_id 不相等"), res.stderr);
  assert.ok(
    res.stderr.includes("registration_key") && res.stderr.includes("幂等重试"),
    `stderr 应含幂等重试指引: ${res.stderr}`,
  );
});

test("①e 响应缺失 issue_id：视为与 promotion 上下文错配，BIND_RESPONSE_MISMATCH 停止", () => {
  setScenario(0, {
    stdout: JSON.stringify({
      cr_id: CR_ID,
      run_id: RUN_ID,
      changed: true,
    }),
  });
  const res = runBind();
  assert.notEqual(res.status, 0, "缺失 issue_id 必须非零退出");
  assert.ok(res.stderr.includes("BIND_RESPONSE_MISMATCH"), res.stderr);
  assert.ok(res.stderr.includes("registration_key"), res.stderr);
});

test("①f 缺 issue_id 位置参数：usage 失败（绑定步骤只应在 promotion 上下文齐备时执行）", () => {
  const env = {
    ...process.env,
    PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  delete env.PROMOTION_BIND_MULTICA;
  const res = spawnSync(process.execPath, [BIND_SCRIPT, CR_ID, RUN_ID], { encoding: "utf8", env });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("usage:"), res.stderr);
});

test("② 绑定失败（404/409/401/500）：技术失败停止且输出含幂等重试指引", async (t) => {
  const cases = [
    { code: "RUN_NOT_FOUND", http: 404 },
    { code: "CR_NOT_FOUND", http: 404 },
    { code: "RUN_CR_CONFLICT", http: 409 },
    { code: "CR_ISSUE_CONFLICT", http: 409 },
    { code: "TASK_CONTEXT_REQUIRED", http: 401 },
    { code: "CR_BIND_FAILED", http: 500 },
  ];
  for (const c of cases) {
    await t.test(`${c.http} ${c.code}`, () => {
      setScenario(1, { stderr: `bind promotion run to ${CR_ID}: ${c.code}: server error` });
      const res = runBind();
      assert.notEqual(res.status, 0, `${c.code} 必须以非零退出`);
      assert.ok(res.stderr.includes(c.code), `stderr 应含服务端错误码 ${c.code}: ${res.stderr}`);
      assert.ok(
        res.stderr.includes("registration_key") && res.stderr.includes("幂等重试"),
        `stderr 应含 registration_key 幂等重试指引: ${res.stderr}`,
      );
      assert.ok(
        res.stderr.includes("绑定完成前该 CR 不得推进到 requirement-reviewing"),
        `stderr 应重申硬不变量: ${res.stderr}`,
      );
    });
  }
});

test("②b multica 可执行文件不可用：技术失败停止", () => {
  // PATH 只含一个没有 multica 的目录：spawn 解析不到可执行文件（ENOENT）。
  const env = { ...process.env, PATH: tmpDir };
  delete env.PROMOTION_BIND_MULTICA;
  const res = spawnSync(process.execPath, [BIND_SCRIPT, CR_ID, RUN_ID, ISSUE_ID], { encoding: "utf8", env });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("MULTICA_UNAVAILABLE"), res.stderr);
});

test("③ 无 promotion 上下文：SKILL.md 声明按普通注册处理、不定位不绑定（行为不变）", () => {
  const skill = fs.readFileSync(SKILL_MD, "utf8").replaceAll("\r\n", "\n");
  assert.ok(
    skill.includes("两者均缺 → 普通注册，不定位不绑定，行为不变"),
    "SKILL.md 应声明 promotion 上下文缺失时按普通注册处理",
  );
  assert.ok(
    skill.includes("当且仅当 promotion 上下文齐备（`promotion_issue_id` 与 `promotion_run_id` 同时提供）时"),
    "SKILL.md 应声明绑定仅在双字段齐备时执行",
  );
  assert.ok(
    skill.includes("仅提供其一 → `PROMOTION_CONTEXT_INCOMPLETE` 技术失败停止"),
    "SKILL.md 应声明半上下文按失败关闭",
  );
  assert.ok(
    skill.includes("BIND_RESPONSE_MISMATCH"),
    "SKILL.md 应声明响应上下文错配按技术失败停止（B-CODE-05）",
  );
});

test("④ SKILL.md 含「绑定完成前不得推进 requirement-reviewing」硬不变量", () => {
  const skill = fs.readFileSync(SKILL_MD, "utf8").replaceAll("\r\n", "\n");
  assert.ok(
    skill.includes("绑定完成前该 CR 不得推进到 `requirement-reviewing`"),
    "SKILL.md 必须含硬不变量：绑定完成前不得推进 requirement-reviewing",
  );
  assert.ok(
    skill.includes("multica cr bind-promotion-run"),
    "SKILL.md 应引用绑定命令",
  );
});

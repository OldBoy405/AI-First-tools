#!/usr/bin/env node
/**
 * promotion-bind.mjs — CR-2026-061 AC-13 消费面（requirement-register 绑定步骤的可执行编码）。
 *
 * 用法：
 *   node promotion-bind.mjs <cr_id> <run_id> [--multica <bin>]
 *
 * 语义（与 requirement-register SKILL.md Step 2.5 一致，SKILL 为权威口径）：
 * - 退出码 0：绑定成功。stdout 为 {cr_id, run_id, changed}——changed=true 新建绑定，
 *   changed=false 为同 run 同 CR 的幂等重放，两者均视为成功。
 * - 退出码 2：绑定失败（含 multica 可执行文件不可用）。stderr 含服务端错误码与
 *   「可经同一 registration_key 幂等重试」指引；调用方必须把注册按技术失败停止。
 * - 本脚本只调用 `multica cr bind-promotion-run` 一条命令，不写任何账本、不推进任何状态。
 */
import { spawnSync } from "node:child_process";

// 绑定端点失败码闭包（与 multica cmd_cr.go bind-promotion-run 帮助文本一致）。
const BIND_FAILURE_CODES = [
  "TASK_CONTEXT_REQUIRED",
  "INVALID_RUN_ID",
  "RUN_NOT_FOUND",
  "CR_NOT_FOUND",
  "RUN_CR_CONFLICT",
  "CR_ISSUE_CONFLICT",
  "CR_BIND_FAILED",
];

function fail(code, detail) {
  const message = `promotion-bind failed: ${code}: ${detail}\n` +
    `绑定完成前该 CR 不得推进到 requirement-reviewing（SKILL Step 2.5 硬不变量）。\n` +
    `注册已落盘可经同一 registration_key 幂等重试（重跑同一条 crctl register 命令续跑）。`;
  process.stderr.write(message + "\n");
  process.exit(2);
}

function usage() {
  process.stderr.write("usage: node promotion-bind.mjs <cr_id> <run_id> [--multica <bin>]\n");
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  let multicaBin = process.env.PROMOTION_BIND_MULTICA ?? "multica";
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--multica") {
      multicaBin = args[++i];
      if (!multicaBin) usage();
    } else {
      positional.push(args[i]);
    }
  }
  const [crId, runId] = positional;
  if (!crId || !runId || positional.length !== 2) usage();
  if (!/^CR-\d{4}-\d{3,}$/.test(crId)) {
    fail("INVALID_CR_ID", `cr_id 形态应为 CR-YYYY-NNN，实际 ${crId}`);
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(runId)) {
    fail("INVALID_RUN_ID", `run_id 应为 UUID，实际 ${runId}`);
  }

  const res = spawnSync(
    multicaBin,
    ["cr", "bind-promotion-run", crId, "--run-id", runId],
    { encoding: "utf8", shell: false },
  );

  if (res.error) {
    fail("MULTICA_UNAVAILABLE", `无法执行 ${multicaBin}: ${res.error.message}`);
  }
  const stderr = (res.stderr ?? "").trim();
  if (res.status !== 0) {
    const code = BIND_FAILURE_CODES.find((c) => stderr.includes(c)) ?? `exit=${res.status}`;
    fail(code, stderr || "multica 绑定命令非零退出且无错误输出");
  }

  let out;
  try {
    out = JSON.parse((res.stdout ?? "").trim());
  } catch {
    fail("BIND_RESPONSE_UNPARSEABLE", `multica stdout 非 JSON: ${(res.stdout ?? "").slice(0, 200)}`);
  }
  if (out.cr_id !== crId || !out.run_id || typeof out.changed !== "boolean") {
    fail("BIND_RESPONSE_MALFORMED", `响应缺 cr_id/run_id/changed: ${JSON.stringify(out)}`);
  }

  process.stdout.write(JSON.stringify({ cr_id: out.cr_id, run_id: out.run_id, changed: out.changed }) + "\n");
  process.exit(0);
}

main();

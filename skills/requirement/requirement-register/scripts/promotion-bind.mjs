#!/usr/bin/env node
/**
 * promotion-bind.mjs — CR-2026-061 AC-13 消费面（requirement-register 绑定步骤的可执行编码）。
 *
 * 用法：
 *   node promotion-bind.mjs <cr_id> <run_id> <issue_id> [--multica <bin>]
 *
 * 语义（与 requirement-register SKILL.md Step 2.5 一致，SKILL 为权威口径）：
 * - 退出码 0：绑定成功。stdout 为 {cr_id, run_id, issue_id, changed}——changed=true 新建绑定，
 *   changed=false 为同 run 同 CR 的幂等重放，两者均视为成功。
 * - 成功前 fail-closed 校验（B-CODE-05）：响应 run_id 必须与请求 run_id 全等、issue_id 必须与
 *   promotion 上下文的 issue_id 全等；任一错配按 BIND_RESPONSE_MISMATCH 技术失败停止。
 * - 退出码 2：绑定失败（含 multica 可执行文件不可用）。stderr 含错误码与
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
  process.stderr.write("usage: node promotion-bind.mjs <cr_id> <run_id> <issue_id> [--multica <bin>]\n");
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
  const [crId, runId, issueId] = positional;
  if (!crId || !runId || !issueId || positional.length !== 3) usage();
  if (!/^CR-\d{4}-\d{3,}$/.test(crId)) {
    fail("INVALID_CR_ID", `cr_id 形态应为 CR-YYYY-NNN，实际 ${crId}`);
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(runId)) {
    fail("INVALID_RUN_ID", `run_id 应为 UUID，实际 ${runId}`);
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(issueId)) {
    fail("INVALID_ISSUE_ID", `issue_id 应为 UUID，实际 ${issueId}`);
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
  if (typeof out !== "object" || out === null || out.cr_id !== crId || typeof out.changed !== "boolean") {
    fail("BIND_RESPONSE_MALFORMED", `响应缺 cr_id/changed 或形态异常: ${JSON.stringify(out)}`);
  }
  // B-CODE-05 fail-closed 上下文校验：成功前 run_id 必须与请求全等、issue_id
  // 必须与 promotion 上下文全等；任一错配即按技术失败停止，不得报告成功。
  if (out.run_id !== runId) {
    fail(
      "BIND_RESPONSE_MISMATCH",
      `响应 run_id 与请求 promotion_run_id 不相等（请求 ${runId}，响应 ${String(out.run_id)}）`,
    );
  }
  if (out.issue_id !== issueId) {
    fail(
      "BIND_RESPONSE_MISMATCH",
      `响应 issue_id 与 promotion_issue_id 不相等（期望 ${issueId}，响应 ${String(out.issue_id)}）`,
    );
  }

  process.stdout.write(
    JSON.stringify({ cr_id: out.cr_id, run_id: out.run_id, issue_id: out.issue_id, changed: out.changed }) + "\n",
  );
  process.exit(0);
}

main();

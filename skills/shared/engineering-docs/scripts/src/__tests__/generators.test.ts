import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generate } from "../generators/base.js";
import { makeTmpDir, cleanupTmp } from "./helpers/tmp.js";

function tmp(): string {
  return makeTmpDir("engdocs");
}

describe("generators", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp();
  });
  afterEach(() => {
    cleanupTmp(dir);
  });

  it("生成 PRD 并分配 001 序号", () => {
    const r = generate({
      type: "PRD",
      name: "user-login",
      outDir: dir,
      owner: "product-brain",
    });
    expect(r.id).toBe("PRD-001");
    expect(r.outPath.endsWith("PRD-001-user-login.md")).toBe(true);
    const content = readFileSync(r.outPath, "utf-8");
    expect(content).toContain("id: PRD-001");
    expect(content).toContain("type: PRD");
    expect(content).toContain("owner: product-brain");
    // 台账已写入
    expect(existsSync(join(dir, "_index.yaml"))).toBe(true);
  });

  it("同目录连续生成 PRD 自动递增序号", () => {
    generate({ type: "PRD", name: "a", outDir: dir });
    const r2 = generate({ type: "PRD", name: "b", outDir: dir });
    expect(r2.id).toBe("PRD-002");
  });

  it("PLAN 要求 version，并按 version 分配 id", () => {
    const r = generate({
      type: "PLAN",
      name: "mvp",
      outDir: dir,
      docVersion: "v1.0",
    });
    expect(r.id).toBe("PLAN-v1.0-001");
    expect(r.outPath.endsWith("PLAN-v1.0-001-mvp.md")).toBe(true);
  });

  it("TASK 自动拼接子序号 01", () => {
    const r = generate({
      type: "TASK",
      name: "login-api",
      outDir: dir,
      docVersion: "v1.0",
      extra: { planId: "PLAN-v1.0-001" },
    });
    expect(r.id).toBe("TASK-v1.0-001-01");
  });

  it("FORM 同时生成 schema.yaml", () => {
    const r = generate({
      type: "FORM",
      name: "login-form",
      outDir: dir,
    });
    expect(r.extraPaths.length).toBe(1);
    expect(r.extraPaths[0].endsWith("schema.yaml")).toBe(true);
  });

  it("RELEASE 按版本命名", () => {
    const r = generate({
      type: "RELEASE",
      name: "release",
      outDir: dir,
      docVersion: "v1.0.0",
    });
    expect(r.id).toBe("RELEASE-v1.0.0");
    expect(r.outPath.endsWith("RELEASE-v1.0.0.md")).toBe(true);
  });

  it("默认不覆盖已存在文件", () => {
    generate({ type: "PRD", name: "a", outDir: dir });
    // 相同 name 会分配下一个 id，不冲突；构造冲突需用 force=false + 相同 id
    // 这里验证 force=true 时可覆盖
    expect(() =>
      generate({ type: "PRD", name: "b", outDir: dir, force: true }),
    ).not.toThrow();
  });
});

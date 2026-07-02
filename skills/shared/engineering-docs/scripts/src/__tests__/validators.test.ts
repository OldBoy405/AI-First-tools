import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateFrontmatter } from "../validators/frontmatter.js";
import { validateNaming } from "../validators/naming.js";
import { generate } from "../generators/base.js";
import { makeTmpDir, cleanupTmp } from "./helpers/tmp.js";

function tmp(): string {
  return makeTmpDir("engdocs-val");
}

describe("validator: frontmatter", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp();
  });
  afterEach(() => cleanupTmp(dir));

  it("生成的 PRD 骸架应通过 schema 校验", () => {
    const r = generate({ type: "PRD", name: "foo", outDir: dir });
    const res = validateFrontmatter(r.outPath);
    expect(res.ok).toBe(true);
    expect(res.type).toBe("PRD");
  });
  
  it("生成的 PLAN 骸架（带版本号 id）应通过 schema 校验", () => {
    const r = generate({
      type: "PLAN",
      name: "mvp",
      outDir: dir,
      docVersion: "v1.0",
      extra: { moduleId: "MODULE-001" },
    });
    const res = validateFrontmatter(r.outPath);
    expect(res.ok).toBe(true);
    expect(res.type).toBe("PLAN");
  });
  
  it("生成的 TASK 骸架（带子序号）应通过 schema 校验", () => {
    const r = generate({
      type: "TASK",
      name: "login-api",
      outDir: dir,
      docVersion: "v1.0",
      extra: { planId: "PLAN-v1.0-001" },
    });
    const res = validateFrontmatter(r.outPath);
    expect(res.ok).toBe(true);
    expect(res.type).toBe("TASK");
  });

  it("frontmatter 缺少 type 字段应报错", () => {
    const file = join(dir, "PRD-001-foo.md");
    writeFileSync(
      file,
      "---\nid: PRD-001\nname: foo\n---\nbody\n",
      "utf-8",
    );
    const res = validateFrontmatter(file);
    expect(res.ok).toBe(false);
    expect(res.issues[0].path).toBe("type");
  });

  it("id 格式不匹配应失败", () => {
    const file = join(dir, "PRD-001-foo.md");
    writeFileSync(
      file,
      [
        "---",
        "id: NOTPRD-001",
        "type: PRD",
        "name: foo",
        "title: Foo",
        "status: draft",
        "owner: x",
        "created: 2026-05-01",
        "updated: 2026-05-01",
        "refs:",
        "  upstream: []",
        "  downstream: []",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );
    const res = validateFrontmatter(file);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.instancePath?.includes("id"))).toBe(true);
  });
});

describe("validator: naming", () => {
  it("合法文件名", () => {
    const res = validateNaming("/tmp/PRD-001-foo-bar.md");
    expect(res.ok).toBe(true);
    expect(res.type).toBe("PRD");
  });

  it("非法文件名", () => {
    const res = validateNaming("/tmp/PRD_001_foo.md");
    expect(res.ok).toBe(false);
  });

  it("TASK 过程类文件名", () => {
    const res = validateNaming("/tmp/TASK-v1.0-001-01-login-api.md");
    expect(res.ok).toBe(true);
    expect(res.type).toBe("TASK");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chainCheck } from "../validators/chain.js";
import { makeTmpDir, cleanupTmp } from "./helpers/tmp.js";

function tmp(): string {
  return makeTmpDir("engdocs-chain");
}

function writeDoc(dir: string, filename: string, fm: Record<string, unknown>): void {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === "object") {
      lines.push(`${k}:`);
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
        if (Array.isArray(iv)) {
          lines.push(`  ${ik}: [${iv.map((x) => JSON.stringify(x)).join(", ")}]`);
        } else {
          lines.push(`  ${ik}: ${iv}`);
        }
      }
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---");
  lines.push("");
  writeFileSync(join(dir, filename), lines.join("\n"), "utf-8");
}

describe("chain-check", () => {
  let dir: string;
  beforeEach(() => (dir = tmp()));
  afterEach(() => cleanupTmp(dir));

  it("PRD 为 draft 时创建 SDD 应被拒", () => {
    writeDoc(dir, "PRD-001-a.md", {
      id: "PRD-001",
      type: "PRD",
      status: "draft",
      refs: { upstream: [], downstream: [] },
    });
    writeDoc(dir, "SDD-001-a.md", {
      id: "SDD-001",
      type: "SDD",
      status: "draft",
      refs: { upstream: ["PRD-001"], downstream: [] },
    });

    const res = chainCheck(dir);
    expect(res.ok).toBe(false);
    const gateIssue = res.issues.find((i) => i.rule === "gate");
    expect(gateIssue).toBeDefined();
    expect(gateIssue!.upstreamId).toBe("PRD-001");
  });

  it("PRD approved 时允许 SDD 存在", () => {
    writeDoc(dir, "PRD-001-a.md", {
      id: "PRD-001",
      type: "PRD",
      status: "approved",
      refs: { upstream: [], downstream: [] },
    });
    writeDoc(dir, "SDD-001-a.md", {
      id: "SDD-001",
      type: "SDD",
      status: "draft",
      refs: { upstream: ["PRD-001"], downstream: [] },
    });
    const res = chainCheck(dir);
    expect(res.ok).toBe(true);
  });

  it("SDD 缺少上游 PRD 应报错", () => {
    writeDoc(dir, "SDD-001-a.md", {
      id: "SDD-001",
      type: "SDD",
      status: "draft",
      refs: { upstream: [], downstream: [] },
    });
    const res = chainCheck(dir);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.rule === "required-upstream")).toBe(true);
  });
});

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import matter from "gray-matter";
import { readFileSync } from "node:fs";
import { loadDocChain, type DocType } from "../registry.js";
import { guessDocTypeFromFilename } from "../utils/id.js";

export interface ChainIssue {
  file: string;
  type: DocType;
  id: string;
  upstreamId?: string;
  rule: string;
  message: string;
}

export interface ChainResult {
  ok: boolean;
  docCount: number;
  issues: ChainIssue[];
}

interface DocInfo {
  id: string;
  type: DocType;
  status: string;
  file: string;
  upstream: string[];
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (entry.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function collectDocs(rootDir: string): Map<string, DocInfo> {
  const docs = new Map<string, DocInfo>();
  for (const file of walk(rootDir)) {
    const name = file.split("/").pop() ?? "";
    const type = guessDocTypeFromFilename(name);
    if (!type || type === "OpenAPI") continue;
    const raw = readFileSync(file, "utf-8");
    const data = matter(raw).data as Record<string, unknown>;
    const id = data.id as string | undefined;
    const status = (data.status as string | undefined) ?? "draft";
    if (!id) continue;
    const refs = (data.refs as { upstream?: string[] } | undefined) ?? {};
    docs.set(id, {
      id,
      type,
      status,
      file,
      upstream: (refs.upstream ?? []).filter(Boolean),
    });
  }
  return docs;
}

/** 评估简化版 gate 表达式：当前仅支持 `from.status in ['x','y']` */
function evaluateGate(expr: string, status: string): boolean {
  const m = /from\.status\s+in\s+\[([^\]]+)\]/.exec(expr);
  if (!m) return true; // 不可识别的表达式默认放行
  const allowed = m[1]
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
  return allowed.includes(status);
}

export function chainCheck(rootDir: string): ChainResult {
  const cfg = loadDocChain();
  const docs = collectDocs(resolve(rootDir));
  const issues: ChainIssue[] = [];

  for (const doc of docs.values()) {
    // 1) required-upstream：按类型需要上游
    const required = cfg.requiredUpstream[doc.type];
    if (required && required.length > 0) {
      const hasValidUpstream = doc.upstream.some((uid) => {
        const up = docs.get(uid);
        return up && required.includes(up.type);
      });
      if (!hasValidUpstream) {
        issues.push({
          file: doc.file,
          type: doc.type,
          id: doc.id,
          rule: "required-upstream",
          message: `${doc.type} 缺少必需上游文档（期望类型之一：${required.join("/")})`,
        });
      }
    }

    // 2) gate 表达式：上游 status 未达标
    for (const uid of doc.upstream) {
      const up = docs.get(uid);
      if (!up) continue;
      const edge = cfg.edges.find((e) => e.from === up.type && e.to === doc.type);
      if (!edge) continue;
      if (!evaluateGate(edge.gate, up.status)) {
        issues.push({
          file: doc.file,
          type: doc.type,
          id: doc.id,
          upstreamId: up.id,
          rule: "gate",
          message: `${edge.message}（上游 ${up.id} 当前 status=${up.status}）`,
        });
      }
    }
  }

  return { ok: issues.length === 0, docCount: docs.size, issues };
}

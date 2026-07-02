import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import matter from "gray-matter";
import { readFileSync } from "node:fs";
import { exists, readYaml, writeYaml } from "../utils/fs.js";
import { today } from "../utils/slug.js";
import { guessDocTypeFromFilename } from "../utils/id.js";

export interface IndexSyncResult {
  ok: boolean;
  indexPath: string;
  added: string[];
  removed: string[];
  updated: string[];
  issues: string[];
}

interface Entry {
  id: string;
  type: string;
  file: string;
  title: string;
  status: string;
  updated: string;
}

interface IndexFile {
  type: string;
  entries: Entry[];
}

export function indexSync(dir: string, options: { write?: boolean } = {}): IndexSyncResult {
  const indexPath = join(dir, "_index.yaml");
  const issues: string[] = [];
  const stats = statSync(dir);
  if (!stats.isDirectory()) throw new Error(`${dir} 不是目录`);

  // 扫描目录
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "_index.md");
  const actualEntries = new Map<string, Entry>();
  for (const f of files) {
    const full = join(dir, f);
    const raw = readFileSync(full, "utf-8");
    const data = matter(raw).data as Record<string, unknown>;
    const id = data.id as string | undefined;
    const type = (data.type as string | undefined) ?? guessDocTypeFromFilename(f) ?? "UNKNOWN";
    const title = (data.title as string | undefined) ?? basename(f, ".md");
    const status = (data.status as string | undefined) ?? "draft";
    const updated = (data.updated as string | undefined) ?? today();
    if (!id) {
      issues.push(`${f} 缺少 frontmatter.id，忽略`);
      continue;
    }
    actualEntries.set(id, { id, type, file: f, title, status, updated });
  }

  // 读现有台账
  let current: IndexFile;
  if (exists(indexPath)) {
    current = readYaml<IndexFile>(indexPath);
    if (!current.entries) current.entries = [];
  } else {
    current = { type: "_mixed", entries: [] };
  }

  const currentMap = new Map(current.entries.map((e) => [e.id, e]));
  const added: string[] = [];
  const updatedIds: string[] = [];
  const removed: string[] = [];

  for (const [id, e] of actualEntries) {
    const prev = currentMap.get(id);
    if (!prev) {
      added.push(id);
    } else if (
      prev.file !== e.file ||
      prev.status !== e.status ||
      prev.title !== e.title ||
      prev.updated !== e.updated
    ) {
      updatedIds.push(id);
    }
  }
  for (const id of currentMap.keys()) {
    if (!actualEntries.has(id)) removed.push(id);
  }

  const nextEntries = Array.from(actualEntries.values()).sort((a, b) => a.id.localeCompare(b.id));
  if (options.write) {
    writeYaml(indexPath, { type: current.type, entries: nextEntries });
  }

  return {
    ok: issues.length === 0,
    indexPath,
    added,
    updated: updatedIds,
    removed,
    issues,
  };
}

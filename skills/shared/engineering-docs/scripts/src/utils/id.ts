import { readdirSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { DocType } from "../registry.js";
import { pad3 } from "./slug.js";

/**
 * 扫描目录，根据文件名匹配某类文档的下一个可用 NNN 序号。
 * filenamePattern 必须包含一个匹配 NNN 的捕获组（3 位数字）。
 */
export function nextIdSerial(dir: string, filenameRegex: RegExp): string {
  if (!existsSync(dir)) return pad3(1);
  const files = readdirSync(dir);
  let max = 0;
  for (const f of files) {
    const m = filenameRegex.exec(f);
    if (!m) continue;
    // 优先取第 1 个 3 位组。若首组是版本号（v...），则取第 2 个。
    const g1 = m[1];
    const g2 = m[2];
    let n: number | null = null;
    if (g1 && /^\d{3}$/.test(g1)) n = parseInt(g1, 10);
    else if (g2 && /^\d{3}$/.test(g2)) n = parseInt(g2, 10);
    if (n !== null && n > max) max = n;
  }
  return pad3(max + 1);
}

/** 确保目录存在 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** 判断文档类型（粗略）：用于 index-sync */
export function guessDocTypeFromFilename(filename: string): DocType | null {
  if (/^PRD-/.test(filename)) return "PRD";
  if (/^SDD-/.test(filename)) return "SDD";
  if (/^MODULE-/.test(filename)) return "MODULE";
  if (/^PLAN-/.test(filename)) return "PLAN";
  if (/^TASK-/.test(filename)) return "TASK";
  if (/^RELEASE-/.test(filename)) return "RELEASE";
  if (/^FORM-/.test(filename)) return "FORM";
  if (/\.yaml$/.test(filename) && /-v\d/.test(filename)) return "OpenAPI";
  return null;
}

export { resolve };

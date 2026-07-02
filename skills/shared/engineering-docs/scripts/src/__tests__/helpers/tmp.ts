import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 解析到 scripts/ 目录（__tests__/helpers 往上两级）
const SCRIPTS_DIR = resolve(__dirname, "..", "..", "..");
const TMP_ROOT = resolve(SCRIPTS_DIR, ".tmp-test");

/**
 * 在 workspace 内创建隔离临时目录，避开 sandbox 对 os.tmpdir() 的权限限制。
 */
export function makeTmpDir(prefix: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const rand = Math.random().toString(36).slice(2, 10);
  const dir = join(TMP_ROOT, `${prefix}-${Date.now()}-${rand}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupTmp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

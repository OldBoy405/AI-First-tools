import { basename } from "node:path";
import { getRegistry } from "../registry.js";
import { guessDocTypeFromFilename } from "../utils/id.js";

export interface NamingResult {
  ok: boolean;
  file: string;
  type: string | null;
  message?: string;
}

export function validateNaming(filePath: string): NamingResult {
  const name = basename(filePath);
  const type = guessDocTypeFromFilename(name);
  if (!type) {
    return {
      ok: false,
      file: filePath,
      type: null,
      message: `无法从文件名识别文档类型：${name}`,
    };
  }
  const spec = getRegistry()[type];
  if (!spec.filenameRegex.test(name)) {
    return {
      ok: false,
      file: filePath,
      type,
      message: `文件名不符合 ${type} 命名规范（${spec.filenameRegex.source}）：${name}`,
    };
  }
  return { ok: true, file: filePath, type };
}

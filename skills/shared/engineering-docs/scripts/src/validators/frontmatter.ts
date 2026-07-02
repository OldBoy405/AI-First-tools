import Ajv, { type ErrorObject } from "ajv";
import matter from "gray-matter";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getRegistry, SCHEMAS_DIR, type DocType } from "../registry.js";

/**
 * gray-matter 底层的 js-yaml 会将 ISO 日期字符串解析为 JS Date 对象，
 * 导致 JSON Schema `type: string` 校验失败。递归将 Date 归一化为 `YYYY-MM-DD`。
 */
function normalizeDates(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeDates);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeDates(v);
    }
    return out;
  }
  return value;
}

export interface FrontmatterIssue {
  path: string;
  message: string;
  keyword?: string;
  instancePath?: string;
}

export interface FrontmatterResult {
  ok: boolean;
  file: string;
  type: DocType | null;
  data: Record<string, unknown> | null;
  issues: FrontmatterIssue[];
}

function buildAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false });
  // 预注册所有 schema，支持 $ref
  const registry = getRegistry();
  const schemaFiles = new Set<string>(["common-defs.schema.json"]);
  for (const spec of Object.values(registry)) {
    if (spec.schema) schemaFiles.add(spec.schema);
  }
  for (const f of schemaFiles) {
    const raw = JSON.parse(readFileSync(resolve(SCHEMAS_DIR, f), "utf-8"));
    // 以文件名作为 key，让 $ref "common-defs.schema.json#/..." 可解析
    ajv.addSchema(raw, f);
  }
  return ajv;
}

const ajv = buildAjv();

export function validateFrontmatter(filePath: string, expectType?: DocType): FrontmatterResult {
  const registry = getRegistry();
  const raw = readFileSync(filePath, "utf-8");
  const parsed = matter(raw);
  const data = normalizeDates(parsed.data) as Record<string, unknown>;
  const type = (data.type as DocType | undefined) ?? null;

  if (!type) {
    return {
      ok: false,
      file: filePath,
      type: null,
      data,
      issues: [{ path: "type", message: "frontmatter 缺少 type 字段" }],
    };
  }
  if (expectType && expectType !== type) {
    return {
      ok: false,
      file: filePath,
      type,
      data,
      issues: [
        {
          path: "type",
          message: `文档 type (${type}) 与期望 (${expectType}) 不一致`,
        },
      ],
    };
  }

  const spec = registry[type];
  if (!spec || !spec.schema) {
    // OpenAPI 或未知类型，视为跳过 frontmatter 校验
    return { ok: true, file: filePath, type, data, issues: [] };
  }

  const validate = ajv.getSchema(spec.schema) ?? ajv.compile(
    JSON.parse(readFileSync(resolve(SCHEMAS_DIR, spec.schema), "utf-8")),
  );
  const ok = validate(data) as boolean;
  const issues: FrontmatterIssue[] = ok
    ? []
    : (validate.errors ?? []).map((e: ErrorObject) => ({
        path: e.instancePath || "(root)",
        message: e.message ?? "unknown error",
        keyword: e.keyword,
        instancePath: e.instancePath,
      }));

  return { ok, file: filePath, type, data, issues };
}

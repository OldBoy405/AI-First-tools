import ejs from "ejs";
import { resolve, join, relative } from "node:path";
import { readFileSync } from "node:fs";
import {
  getRegistry,
  TEMPLATES_DIR,
  type DocType,
  type DocTypeSpec,
} from "../registry.js";
import { ensureDir, nextIdSerial } from "../utils/id.js";
import { today, titleCase, pad3 } from "../utils/slug.js";
import { exists, readYaml, writeText, writeYaml } from "../utils/fs.js";

export interface GenerateInput {
  type: DocType;
  name: string;                     // slug
  title?: string;
  owner?: string;
  outDir: string;                   // 产物输出目录（绝对路径）
  docVersion?: string;              // 过程文档版本（如 v1.0）
  extra?: Record<string, unknown>;  // 其它模板变量
  force?: boolean;                  // 允许覆盖
}

export interface GenerateResult {
  type: DocType;
  outPath: string;                  // 生成的主文档绝对路径
  id: string;                       // 分配的 id
  extraPaths: string[];             // 额外生成文件（如 FORM 同目录 schema.yaml）
}

/** 根据类型和输出目录计算下一个 id */
export function allocateId(spec: DocTypeSpec, outDir: string, opts: { docVersion?: string; sub?: string } = {}): string {
  const { docVersion } = opts;
  switch (spec.type) {
    case "PRD":
    case "SDD":
    case "MODULE":
    case "FORM": {
      const serial = nextIdSerial(outDir, spec.filenameRegex);
      return `${spec.type}-${serial}`;
    }
    case "PLAN": {
      if (!docVersion) throw new Error("PLAN requires --version");
      const serial = nextIdSerial(outDir, spec.filenameRegex);
      return `PLAN-${docVersion}-${serial}`;
    }
    case "TASK": {
      if (!docVersion) throw new Error("TASK requires --version");
      const serial = nextIdSerial(outDir, spec.filenameRegex);
      // TASK 默认子序号 01；后续工具可扩展
      return `TASK-${docVersion}-${serial}-01`;
    }
    case "RELEASE": {
      if (!docVersion) throw new Error("RELEASE requires --version");
      return `RELEASE-${docVersion}`;
    }
    case "OpenAPI": {
      if (!docVersion) throw new Error("OpenAPI requires --version");
      return `OPENAPI-${opts.sub ?? "service"}-${docVersion}`;
    }
    default:
      throw new Error(`Unknown type: ${spec.type}`);
  }
}

/** 根据类型、id、slug 计算输出文件名 */
export function formatFilename(spec: DocTypeSpec, id: string, name: string, docVersion?: string): string {
  switch (spec.type) {
    case "PRD":
    case "SDD":
    case "MODULE":
    case "FORM": {
      const serial = id.split("-").pop();
      return `${spec.type}-${serial}-${name}.md`;
    }
    case "PLAN": {
      const parts = id.split("-"); // PLAN, v1.0, 001
      return `PLAN-${parts[1]}-${parts[2]}-${name}.md`;
    }
    case "TASK": {
      const parts = id.split("-"); // TASK, v1.0, 001, 01
      return `TASK-${parts[1]}-${parts[2]}-${parts[3]}-${name}.md`;
    }
    case "RELEASE": {
      if (!docVersion) throw new Error("RELEASE requires version");
      return `RELEASE-${docVersion}.md`;
    }
    case "OpenAPI": {
      if (!docVersion) throw new Error("OpenAPI requires version");
      return `${name}-${docVersion}.yaml`;
    }
  }
}

/** 核心生成函数 */
export function generate(input: GenerateInput): GenerateResult {
  const registry = getRegistry();
  const spec = registry[input.type];
  if (!spec) throw new Error(`Unknown type: ${input.type}`);

  ensureDir(input.outDir);
  const id = allocateId(spec, input.outDir, { docVersion: input.docVersion, sub: input.name });
  const filename = formatFilename(spec, id, input.name, input.docVersion);
  const outPath = join(input.outDir, filename);

  if (exists(outPath) && !input.force) {
    throw new Error(`File already exists: ${outPath}. Use --force to overwrite.`);
  }

  const title = input.title ?? titleCase(input.name);
  const owner = input.owner ?? "unassigned";
  const templatePath = resolve(TEMPLATES_DIR, spec.template);
  const tpl = readFileSync(templatePath, "utf-8");

  // 所有模板可能引用的可选变量给默认空串，避免 EJS ReferenceError
  const defaults: Record<string, unknown> = {
    prdId: "",
    sddId: "",
    moduleId: "",
    planId: "",
    openapiRef: "",
    branch: "",
    description: "",
    sprint: "",
    formId: "",
  };
  const vars: Record<string, unknown> = {
    ...defaults,
    id,
    name: input.name,
    title,
    owner,
    today: today(),
    docVersion: input.docVersion ?? "v0.1.0",
    version: input.docVersion ?? "v0.1.0",
    ...(input.extra ?? {}),
  };
  // 将 undefined 的 extra 字段转为空串（以防 extra 显式传入 undefined）
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) vars[k] = "";
  }

  const rendered = ejs.render(tpl, vars, { async: false });
  writeText(outPath, rendered);

  const extraPaths: string[] = [];

  // FORM 同时生成 schema.yaml（若不存在）
  if (spec.type === "FORM") {
    const schemaPath = join(input.outDir, "schema.yaml");
    if (!exists(schemaPath) || input.force) {
      const schemaTpl = readFileSync(resolve(TEMPLATES_DIR, "FORM-schema-template.yaml"), "utf-8");
      const schemaRendered = ejs.render(schemaTpl, { ...vars, formId: id }, { async: false });
      writeText(schemaPath, schemaRendered);
      extraPaths.push(schemaPath);
    }
  }

  // 更新 _index.yaml 台账
  updateIndex(input.outDir, spec.type, id, filename, title);

  return { type: spec.type, outPath, id, extraPaths };
}

interface IndexEntry {
  id: string;
  type: string;
  file: string;
  title: string;
  status: string;
  updated: string;
}

interface IndexFile {
  type: string;
  entries: IndexEntry[];
}

function updateIndex(dir: string, type: DocType, id: string, filename: string, title: string): void {
  const indexPath = join(dir, "_index.yaml");
  let data: IndexFile;
  if (exists(indexPath)) {
    data = readYaml<IndexFile>(indexPath);
    if (!data.entries) data.entries = [];
  } else {
    data = { type, entries: [] };
  }
  const existing = data.entries.findIndex((e) => e.id === id);
  const entry: IndexEntry = {
    id,
    type,
    file: filename,
    title,
    status: "draft",
    updated: today(),
  };
  if (existing >= 0) data.entries[existing] = entry;
  else data.entries.push(entry);
  writeYaml(indexPath, data);
}

export { relative };

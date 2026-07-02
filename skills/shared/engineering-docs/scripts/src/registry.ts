import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Skill 根目录（scripts/src 的上两级） */
export const SKILL_ROOT = resolve(__dirname, "..", "..");

export const TEMPLATES_DIR = resolve(SKILL_ROOT, "templates");
export const SCHEMAS_DIR = resolve(SKILL_ROOT, "schemas");
export const CONVENTIONS_DIR = resolve(SKILL_ROOT, "conventions");

export type DocType =
  | "PRD"
  | "SDD"
  | "MODULE"
  | "OpenAPI"
  | "PLAN"
  | "TASK"
  | "RELEASE"
  | "FORM";

export type DocCategory = "baseline" | "process-delivery" | "process-research";

export interface DocTypeSpec {
  type: DocType;
  category: DocCategory;
  template: string;           // templates/ 下的文件名
  schema?: string;            // schemas/ 下的 schema 文件；OpenAPI 不走 frontmatter 校验
  filenameRegex: RegExp;
  idRegex: RegExp;
  upstream: DocType[];        // 允许（期望）的上游类型
  downstream: DocType[];      // 下游类型
  requiresVersion: boolean;   // 是否需要版本号参数
}

function loadNamingYaml(): {
  types: Record<string, { category: string; filename: string; id: string }>;
  slug: { pattern: string; "max-length": number };
} {
  const raw = readFileSync(resolve(CONVENTIONS_DIR, "naming.yaml"), "utf-8");
  return YAML.parse(raw);
}

function buildSpec(
  type: DocType,
  template: string,
  schema: string | undefined,
  upstream: DocType[],
  downstream: DocType[],
  requiresVersion = false,
): DocTypeSpec {
  const naming = loadNamingYaml();
  const t = naming.types[type];
  if (!t) {
    throw new Error(`naming.yaml missing entry for ${type}`);
  }
  return {
    type,
    category: t.category as DocCategory,
    template,
    schema,
    filenameRegex: new RegExp(t.filename),
    idRegex: new RegExp(t.id),
    upstream,
    downstream,
    requiresVersion,
  };
}

/** 八类文档注册表 */
export function getRegistry(): Record<DocType, DocTypeSpec> {
  return {
    PRD: buildSpec("PRD", "PRD-template.md", "prd.schema.json", [], ["SDD", "FORM"]),
    SDD: buildSpec("SDD", "SDD-template.md", "sdd.schema.json", ["PRD"], ["MODULE"]),
    MODULE: buildSpec("MODULE", "MODULE-template.md", "module.schema.json", ["SDD"], [
      "PLAN",
      "OpenAPI",
      "FORM",
    ]),
    OpenAPI: buildSpec("OpenAPI", "OpenAPI-template.yaml", undefined, ["MODULE"], []),
    PLAN: buildSpec("PLAN", "PLAN-template.md", "plan.schema.json", ["MODULE"], ["TASK"], true),
    TASK: buildSpec("TASK", "TASK-template.md", "task.schema.json", ["PLAN"], [], true),
    RELEASE: buildSpec("RELEASE", "RELEASE-template.md", "release.schema.json", [], [], true),
    FORM: buildSpec("FORM", "FORM-template.md", "form.schema.json", ["PRD", "MODULE"], []),
  };
}

export function getSlugRules(): { pattern: RegExp; maxLength: number } {
  const naming = loadNamingYaml();
  return {
    pattern: new RegExp(naming.slug.pattern),
    maxLength: naming.slug["max-length"],
  };
}

export interface DocChainEdge {
  from: DocType;
  to: DocType;
  gate: string;
  message: string;
}

export interface DocChainConfig {
  edges: DocChainEdge[];
  requiredUpstream: Record<string, DocType[]>;
}

export function loadDocChain(): DocChainConfig {
  const raw = readFileSync(resolve(CONVENTIONS_DIR, "doc-chain.yaml"), "utf-8");
  const parsed = YAML.parse(raw);
  return {
    edges: parsed.edges ?? [],
    requiredUpstream: parsed["required-upstream"] ?? {},
  };
}

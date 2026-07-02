#!/usr/bin/env node
/**
 * engineering-docs MCP Server
 *
 * Exposes the 5 engdocs tools as MCP tools so any OpenWork/OpenCode project can
 * consume them by adding a single entry to opencode.jsonc:
 *
 *   "mcp": {
 *     "engineering-docs": {
 *       "type": "local",
 *       "command": ["npx", "@openwork/engineering-docs-mcp"]
 *     }
 *   }
 *
 * OpenCode auto-starts this process on first tool invocation and manages it via stdio.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { generate } from "./generators/base.js";
import { validateFrontmatter } from "./validators/frontmatter.js";
import { validateNaming } from "./validators/naming.js";
import { chainCheck } from "./validators/chain.js";
import { indexSync } from "./validators/index-sync.js";
import { type DocType } from "./registry.js";

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "engineering-docs", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// Tool list
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "engdocs_gen",
      description:
        "按模板生成工程文档骨架（PRD/SDD/MODULE/OpenAPI/PLAN/TASK/RELEASE/FORM），" +
        "自动分配序号、渲染 frontmatter、更新 _index.yaml 台账。返回 JSON：{ type, id, outPath, extraPaths }。",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "文档类型：PRD | SDD | MODULE | OpenAPI | PLAN | TASK | RELEASE | FORM",
          },
          name: { type: "string", description: "文档 slug（kebab-case）" },
          title: { type: "string", description: "可选中文标题，缺省由 slug 推导" },
          owner: { type: "string", description: "owner（agent id 或人名），缺省 unassigned" },
          out: {
            type: "string",
            description: "输出目录（绝对路径或相对 CWD），缺省 '.'",
          },
          version: {
            type: "string",
            description: "过程文档版本号（如 v1.0），PLAN/TASK/RELEASE/OpenAPI 必填",
          },
          prd: { type: "string", description: "上游 PRD id" },
          sdd: { type: "string", description: "上游 SDD id" },
          module: { type: "string", description: "上游 MODULE id" },
          plan: { type: "string", description: "上游 PLAN id" },
          openapiRef: { type: "string", description: "OpenAPI 文件引用路径（仅 MODULE）" },
          branch: { type: "string", description: "Git 分支（仅 TASK）" },
          force: { type: "boolean", description: "允许覆盖已存在文件，缺省 false" },
        },
        required: ["type", "name"],
      },
    },
    {
      name: "engdocs_validate",
      description:
        "校验单个工程文档文件的 frontmatter schema 合规性与文件命名规范。" +
        "返回 JSON：{ ok, naming, frontmatter }。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "文档绝对路径或相对 CWD 的路径" },
        },
        required: ["path"],
      },
    },
    {
      name: "engdocs_validate_dir",
      description:
        "递归批量校验目录下全部受控工程文档（.md / .yaml）。" +
        "返回 JSON：{ ok, results: [{file, naming, frontmatter, ok}] }。",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", description: "目录路径（绝对或相对 CWD）" },
        },
        required: ["dir"],
      },
    },
    {
      name: "engdocs_chain_check",
      description:
        "校验文档链路门禁：上游文档 status 未 approved 时拒绝下游文档存在。" +
        "返回 JSON：{ ok, docCount, issues: [{id, type, rule, message}] }。",
      inputSchema: {
        type: "object",
        properties: {
          dir: {
            type: "string",
            description: "应用/特性根目录（会递归扫描），绝对或相对 CWD",
          },
        },
        required: ["dir"],
      },
    },
    {
      name: "engdocs_index_sync",
      description:
        "对账/重建 _index.yaml 台账。默认 dry-run，传 write:true 才写入。" +
        "返回 JSON：{ indexPath, added, updated, removed }。",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", description: "目录路径（绝对或相对 CWD）" },
          write: {
            type: "boolean",
            description: "true 时写入 _index.yaml，缺省仅 dry-run",
          },
        },
        required: ["dir"],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request: {
  params: { name: string; arguments?: Record<string, unknown> | null };
}) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "engdocs_gen": {
        const outDir = resolve(process.cwd(), String(a.out ?? "."));
        const result = generate({
          type: String(a.type) as DocType,
          name: String(a.name),
          title: a.title ? String(a.title) : undefined,
          owner: a.owner ? String(a.owner) : undefined,
          outDir,
          docVersion: a.version ? String(a.version) : undefined,
          extra: {
            prdId: a.prd ?? "",
            sddId: a.sdd ?? "",
            moduleId: a.module ?? "",
            planId: a.plan ?? "",
            openapiRef: a.openapiRef ?? "",
            branch: a.branch ?? "",
          },
          force: Boolean(a.force),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "engdocs_validate": {
        const full = resolve(process.cwd(), String(a.path));
        const naming = validateNaming(full);
        const fm = full.endsWith(".md")
          ? validateFrontmatter(full)
          : { ok: true, file: full, type: null, data: null, issues: [] };
        const ok = naming.ok && fm.ok;
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok, naming, frontmatter: fm }, null, 2) },
          ],
        };
      }

      case "engdocs_validate_dir": {
        const full = resolve(process.cwd(), String(a.dir));
        const files = walkDir(full);
        const results = files.map((f) => {
          const naming = validateNaming(f);
          const fm = f.endsWith(".md")
            ? validateFrontmatter(f)
            : { ok: true, file: f, type: null, data: null, issues: [] };
          return { file: f, naming, frontmatter: fm, ok: naming.ok && fm.ok };
        });
        const allOk = results.every((r) => r.ok);
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: allOk, results }, null, 2) },
          ],
        };
      }

      case "engdocs_chain_check": {
        const result = chainCheck(resolve(process.cwd(), String(a.dir)));
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "engdocs_index_sync": {
        const result = indexSync(resolve(process.cwd(), String(a.dir)), {
          write: Boolean(a.write),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: msg }) }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkDir(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    const st = statSync(full);
    if (st.isDirectory()) walkDir(full, acc);
    else if (/\.(md|yaml)$/.test(entry)) acc.push(full);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { generate } from "./generators/base.js";
import { validateFrontmatter } from "./validators/frontmatter.js";
import { validateNaming } from "./validators/naming.js";
import { chainCheck } from "./validators/chain.js";
import { indexSync } from "./validators/index-sync.js";
import { getRegistry, type DocType } from "./registry.js";

const program = new Command();

program
  .name("engdocs")
  .description("Engineering docs scaffold & validator (PRD/SDD/MODULE/OpenAPI/PLAN/TASK/RELEASE/FORM)")
  .version("0.1.0");

program
  .command("gen")
  .description("按模板生成骨架文件，自动计算 NNN 序号并渲染 frontmatter")
  .argument("<type>", "文档类型：PRD | SDD | MODULE | OpenAPI | PLAN | TASK | RELEASE | FORM")
  .requiredOption("--name <slug>", "文档短名 slug（kebab-case）")
  .option("--title <title>", "可选的中文标题，缺省由 slug 推导")
  .option("--owner <owner>", "owner（agent id 或人名）", "unassigned")
  .option("--out <dir>", "输出目录（绝对或相对路径）", ".")
  .option("--version <ver>", "过程文档版本号（如 v1.0），对 PLAN/TASK/RELEASE/OpenAPI 必填")
  .option("--prd <id>", "上游 PRD id")
  .option("--sdd <id>", "上游 SDD id")
  .option("--module <id>", "上游 MODULE id")
  .option("--plan <id>", "上游 PLAN id")
  .option("--openapi-ref <path>", "OpenAPI 文件引用路径（仅 MODULE）")
  .option("--branch <branch>", "Git 分支（仅 TASK）")
  .option("--force", "允许覆盖已存在文件")
  .option("--json", "以 JSON 输出结果")
  .action((type: string, opts) => {
    const registry = getRegistry();
    if (!(type in registry)) {
      console.error(`未知文档类型：${type}。支持：${Object.keys(registry).join(", ")}`);
      process.exit(2);
    }
    const outDir = resolve(process.cwd(), opts.out);
    const extra: Record<string, unknown> = {
      prdId: opts.prd,
      sddId: opts.sdd,
      moduleId: opts.module,
      planId: opts.plan,
      openapiRef: opts.openapiRef,
      branch: opts.branch,
    };
    try {
      const result = generate({
        type: type as DocType,
        name: opts.name,
        title: opts.title,
        owner: opts.owner,
        outDir,
        docVersion: opts.version,
        extra,
        force: !!opts.force,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`✓ 生成 ${result.type} (${result.id})`);
        console.log(`  主文件: ${result.outPath}`);
        for (const p of result.extraPaths) console.log(`  附加  : ${p}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
      else console.error(`✗ 生成失败：${msg}`);
      process.exit(1);
    }
  });

program
  .command("validate")
  .description("校验单个文档文件（frontmatter schema + 文件名）")
  .argument("<path>", "文档绝对/相对路径")
  .option("--json", "以 JSON 输出结果")
  .action((filePath: string, opts) => {
    const full = resolve(process.cwd(), filePath);
    const naming = validateNaming(full);
    const fm = full.endsWith(".md") ? validateFrontmatter(full) : { ok: true, file: full, type: null, data: null, issues: [] };
    const ok = naming.ok && fm.ok;
    if (opts.json) {
      console.log(JSON.stringify({ ok, naming, frontmatter: fm }, null, 2));
    } else {
      if (ok) console.log(`✓ ok  ${full}`);
      else {
        console.error(`✗ fail ${full}`);
        if (!naming.ok) console.error(`  naming: ${naming.message}`);
        for (const i of fm.issues) console.error(`  fm: ${i.path} ${i.message}`);
      }
    }
    process.exit(ok ? 0 : 1);
  });

program
  .command("validate-dir")
  .description("批量校验目录下全部受控文档")
  .argument("<dir>", "目录路径")
  .option("--json", "以 JSON 输出结果")
  .action((dir: string, opts) => {
    const full = resolve(process.cwd(), dir);
    const st = statSync(full);
    if (!st.isDirectory()) {
      console.error(`${full} 不是目录`);
      process.exit(2);
    }
    const results: Array<{ file: string; naming: unknown; fm: unknown; ok: boolean }> = [];
    const files = walk(full);
    for (const f of files) {
      const naming = validateNaming(f);
      const fm = f.endsWith(".md") ? validateFrontmatter(f) : { ok: true, file: f, type: null, data: null, issues: [] };
      results.push({ file: f, naming, fm, ok: naming.ok && fm.ok });
    }
    const allOk = results.every((r) => r.ok);
    if (opts.json) {
      console.log(JSON.stringify({ ok: allOk, results }, null, 2));
    } else {
      for (const r of results) {
        if (r.ok) console.log(`✓ ${r.file}`);
        else console.error(`✗ ${r.file}`);
      }
    }
    process.exit(allOk ? 0 : 1);
  });

program
  .command("chain-check")
  .description("校验文档链路门禁（上游 approved 才允许下游）")
  .argument("<dir>", "应用/特性的根目录（会递归扫描）")
  .option("--json", "以 JSON 输出结果")
  .action((dir: string, opts) => {
    const result = chainCheck(resolve(process.cwd(), dir));
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`共扫描 ${result.docCount} 个文档，发现 ${result.issues.length} 条问题`);
      for (const i of result.issues) {
        console.error(`✗ ${i.id} (${i.type}) ${i.rule}: ${i.message}`);
      }
    }
    process.exit(result.ok ? 0 : 1);
  });

program
  .command("index-sync")
  .description("根据目录现状重建/对账 _index.yaml 台账")
  .argument("<dir>", "目录路径")
  .option("--write", "写入 _index.yaml；缺省仅显示差异")
  .option("--json", "以 JSON 输出结果")
  .action((dir: string, opts) => {
    const result = indexSync(resolve(process.cwd(), dir), { write: !!opts.write });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`台账: ${result.indexPath}`);
      if (result.added.length) console.log(`  新增: ${result.added.join(", ")}`);
      if (result.updated.length) console.log(`  更新: ${result.updated.join(", ")}`);
      if (result.removed.length) console.log(`  移除: ${result.removed.join(", ")}`);
      if (!opts.write) console.log(`(dry-run：添加 --write 生效)`);
    }
  });

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(md|yaml)$/.test(entry)) acc.push(full);
  }
  return acc;
}

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

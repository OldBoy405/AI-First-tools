import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";

export function readText(path: string): string {
  return readFileSync(path, "utf-8");
}

export function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

export function readYaml<T = unknown>(path: string): T {
  return YAML.parse(readFileSync(path, "utf-8")) as T;
}

export function writeYaml(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(data), "utf-8");
}

export function exists(path: string): boolean {
  return existsSync(path);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(path.resolve(import.meta.dirname, '..', 'check-agents-contract.mjs'), 'utf8');

test('所有逐行解析先统一 CRLF，再按可选 CR 拆行', () => {
  assert.match(source, /function readLines\(p\)/);
  assert.match(source, /replaceAll\('\\r\\n', '\\n'\)\.split\(\/\\r\?\\n\/\)/);
  assert.doesNotMatch(source, /readFileSync\([^\n]+\)\.split\('\\n'\)/);
});

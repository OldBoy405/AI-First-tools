/* ────────────────────────── YAML 子集解析器 ──────────────────────────
 * 支持：块映射、块序列、flow 映射 {k: v}、flow 序列 [a, b]、引号字符串、
 * 注释、多行块标量 | 与 >（保守处理为拼接文本）。
 * 不支持：锚点、别名、tag、多文档。对本包受控文件足够。
 *
 * 严格模式（parseYaml(text, {strict:true})，CR-2026-054）：可选能力，只服务
 * archive 四候选校验；默认 parseYaml(text) 行为不变。严格模式在读入后先将
 * CRLF 规范化为 LF；诊断通过普通 Error 的自有字段携带（category / line /
 * firstLine / key），不新增错误类：
 *   duplicate-key        block/flow map 的等价键重复（unquote 后比较，大小写不折叠）
 *   unconsumed-line      某层解析未消费属于该层的行
 *   invalid-indentation  tab、根缩进、非法深度或容器切换
 *   invalid-shape        裸 '-' 无子节点、无法解释行、trailing flow 内容
 */

function parseYaml(text, options) {
  const strict = !!(options && options.strict);
  const rawLines = text.replaceAll('\r\n', '\n').split('\n');
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const stripped = stripComment(rawLines[i]);
    if (stripped.trim() === '') continue;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trimEnd(), raw: rawLines[i], no: i + 1 });
  }
  if (lines.length === 0) return null;
  const ctx = { strict, lines, currentLine: 0 };
  if (strict) {
    if (lines[0].indent !== 0) throw strictDiag('invalid-indentation', lines[0].no, '根节点必须自第 0 列开始');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (/^\s*\t/.test(ln.raw)) throw strictDiag('invalid-indentation', ln.no, 'tab 缩进');
      if (ln.text.trimStart() === '-') {
        const nxt = lines[i + 1];
        if (!nxt || nxt.indent <= ln.indent) throw strictDiag('invalid-shape', ln.no, "裸 '-' 必须紧跟实际子节点");
      }
    }
  }
  const [value, nextIdx] = parseBlock(lines, 0, 0, ctx);
  if (strict && nextIdx < lines.length) {
    const ln = lines[nextIdx];
    throw strictDiag('unconsumed-line', ln.no, `未消费行: ${ln.text.trimStart()}`);
  }
  return value;
}

function strictDiag(category, line, detail) {
  const e = new Error(`YAML_STRICT_PARSE_FAILED ${category} @line ${line}${detail ? `: ${detail}` : ''}`);
  e.category = category;
  e.line = line;
  return e;
}

function strictDuplicate(line, firstLine, key) {
  const e = strictDiag('duplicate-key', line, `重复键 "${key}"`);
  e.firstLine = firstLine;
  e.key = key;
  return e;
}

function stripComment(line) {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS && !isEscaped(line, i)) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function isEscaped(text, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function isMapEntry(content) {
  return /^[^\s:]+(\s*):(\s|$)/.test(content) || /^["'][^"']*["']\s*:(\s|$)/.test(content);
}

function parseBlock(lines, idx, minIndent, ctx) {
  if (idx >= lines.length || lines[idx].indent < minIndent) return [null, idx];
  const indent = lines[idx].indent;
  const content = lines[idx].text.trimStart();
  if (content.startsWith('- ') || content === '-') return parseSeq(lines, idx, indent, ctx);
  return parseMap(lines, idx, indent, ctx);
}

function parseSeq(lines, idx, indent, ctx) {
  const arr = [];
  let i = idx;
  while (i < lines.length && lines[i].indent === indent) {
    const content = lines[i].text.trimStart();
    if (!(content.startsWith('- ') || content === '-')) {
      if (ctx.strict) {
        if (isMapEntry(content)) throw strictDiag('invalid-indentation', lines[i].no, `容器切换：序列中出现映射行 "${content}"`);
        throw strictDiag('unconsumed-line', lines[i].no, `序列层未消费行: ${content}`);
      }
      break;
    }
    const rest = content === '-' ? '' : content.slice(2).trim();
    if (rest === '') {
      const [v, ni] = parseBlock(lines, i + 1, indent + 1, ctx);
      arr.push(v); i = ni;
    } else if (rest.startsWith('{') || rest.startsWith('[')) {
      ctx.currentLine = lines[i].no;
      arr.push(parseInline(rest, ctx)); i += 1;
    } else if (isMapEntry(rest)) {
      // 序列项内联映射："- id: x" 后续行以更深缩进续写同一映射
      const virtualIndent = lines[i].indent + (lines[i].text.trimStart().length - rest.length);
      const fake = { indent: virtualIndent, text: ' '.repeat(virtualIndent) + rest, raw: lines[i].raw, no: lines[i].no };
      const sub = [fake];
      let j = i + 1;
      while (j < lines.length && lines[j].indent >= virtualIndent && !(lines[j].indent === indent && /^-(\s|$)/.test(lines[j].text.trimStart()))) {
        sub.push(lines[j]); j++;
      }
      const [v, ni] = parseMap(sub, 0, virtualIndent, ctx);
      if (ctx.strict && ni < sub.length) throw strictDiag('invalid-indentation', sub[ni].no, '非法深度：序列内联映射的孤儿行');
      arr.push(v); i = j;
    } else {
      ctx.currentLine = lines[i].no;
      arr.push(parseScalar(rest)); i += 1;
    }
  }
  return [arr, i];
}

function parseMap(lines, idx, indent, ctx) {
  const obj = {};
  const keyLines = ctx.strict ? new Map() : null;
  let i = idx;
  while (i < lines.length && lines[i].indent === indent) {
    const content = lines[i].text.trimStart();
    if (content.startsWith('- ')) {
      if (ctx.strict) throw strictDiag('invalid-indentation', lines[i].no, `容器切换：映射中出现序列行 "${content}"`);
      break;
    }
    const m = content.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^:\s][^:]*?)\s*:(.*)$/);
    if (!m) {
      if (ctx.strict) throw strictDiag('invalid-shape', lines[i].no, `无法解释的行: ${content}`);
      // CR-2026-049 TASK-01：无法解释的结构硬失败（纪律 #1，禁止静默丢行）
      throw new Error(`YAML_SUBSET_PARSE_FAILED @line ${lines[i].no}: ${content}`);
    }
    const key = unquote(m[1].trim());
    if (ctx.strict && Object.prototype.hasOwnProperty.call(obj, key)) {
      throw strictDuplicate(lines[i].no, keyLines.get(key), key);
    }
    if (ctx.strict) keyLines.set(key, lines[i].no);
    let rest = m[2].trim();
    if (rest === '') {
      const [v, ni] = parseBlock(lines, i + 1, indent + 1, ctx);
      obj[key] = v; i = ni;
    } else if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      const parts = [];
      let j = i + 1;
      while (j < lines.length && lines[j].indent > indent) { parts.push(lines[j].text.trim()); j++; }
      obj[key] = parts.join('\n'); i = j;
    } else {
      ctx.currentLine = lines[i].no;
      obj[key] = parseInline(rest, ctx); i += 1;
    }
  }
  if (ctx.strict && i < lines.length && lines[i].indent > indent) {
    throw strictDiag('invalid-indentation', lines[i].no, '非法深度：超出当前层且无归属的行');
  }
  return [obj, i];
}

function parseInline(s, ctx) {
  s = s.trim();
  const looksLikeFlow = s.startsWith('[') || (s.startsWith('{') && /:/.test(s));
  if (looksLikeFlow) {
    const parsed = parseFlow(s, ctx);
    if (parsed.rest.trim() !== '') {
      if (ctx && ctx.strict) throw strictDiag('invalid-shape', ctx.currentLine, `trailing flow content: ${s}`);
      throw new Error(`YAML_SUBSET_PARSE_FAILED: trailing flow content: ${s}`);
    }
    return parsed.value;
  }
  return parseScalar(s);
}

function parseFlow(s, ctx) {
  const strict = !!(ctx && ctx.strict);
  const lineNo = ctx ? ctx.currentLine : 1;
  let i = 0;
  function ws() { while (i < s.length && /\s/.test(s[i])) i++; }
  function value() {
    ws();
    if (s[i] === '{') {
      i++; const o = {};
      ws();
      if (s[i] === '}') { i++; return o; }
      for (;;) {
        ws();
        const k = flowScalar([':']);
        if (s[i] !== ':') throw new Error(`flow map key missing ':' @${i}: ${s}`);
        i++; // skip ':'
        const key = unquote(k.trim());
        if (strict && Object.prototype.hasOwnProperty.call(o, key)) throw strictDuplicate(lineNo, lineNo, key);
        o[key] = value();
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return o; }
        throw new Error(`flow map 解析失败 @${i}: ${s}`);
      }
    }
    if (s[i] === '[') {
      i++; const a = [];
      ws();
      if (s[i] === ']') { i++; return a; }
      for (;;) {
        a.push(value());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return a; }
        throw new Error(`flow seq 解析失败 @${i}: ${s}`);
      }
    }
    return parseScalar(flowScalar([',', '}', ']']));
  }
  function flowScalar(stops) {
    ws();
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]; let j = i + 1;
      while (j < s.length && s[j] !== q) { if (q === '"' && s[j] === '\\') j++; j++; }
      const out = s.slice(i, j + 1); i = j + 1; ws();
      return out;
    }
    let j = i;
    while (j < s.length && !stops.includes(s[j])) j++;
    const out = s.slice(i, j); i = j;
    return out;
  }
  const v = value();
  return { value: v, rest: s.slice(i) };
}

function unquote(s) {
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1).replace(/\\(.)/g, '$1'); }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

function parseScalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return unquote(s);
}

/** 锚定 "- id: <id>" 条目块（该行到下一个同缩进或更浅的 "- id:" 或 EOF）。
 * 返回 {start,end,text,indent}（start/end 为字符偏移，text 为块内原始文本，indent 为条目缩进）。
 * 定位首个精确 id 命中；未命中返回 null。调用方负责先 CRLF→LF 规范化。
 * 自 crctl.mjs 原样下沉（CR-2026-033 T03a）；旧账本命令与 checkpoint editor 共用，禁止复刻。 */
export function matchEntryBlock(text, id) {
  const lines = text.split('\n');
  let startLine = -1, indent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)- id:\s*["']?([^\s"']+)["']?\s*$/);
    if (m && m[2] === id) { startLine = i; indent = m[1].length; break; }
  }
  if (startLine === -1) return null;
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)- id:\s*["']?([^\s"']+)["']?\s*$/);
    if (m && m[1].length <= indent) { endLine = i; break; }
  }
  let start = 0;
  for (let i = 0; i < startLine; i++) start += lines[i].length + 1;
  let end = start;
  for (let i = startLine; i < endLine; i++) end += lines[i].length + 1;
  if (endLine === lines.length && text.endsWith('\n')) end -= 1;
  return { start, end, text: lines.slice(startLine, endLine).join('\n'), indent };
}

export { parseYaml };

/* ────────────────────────── YAML 子集解析器 ──────────────────────────
 * 支持：块映射、块序列、flow 映射 {k: v}、flow 序列 [a, b]、引号字符串、
 * 注释、多行块标量 | 与 >（保守处理为拼接文本）。
 * 不支持：锚点、别名、tag、多文档。对本包受控文件足够。
 */

function parseYaml(text) {
  const rawLines = text.split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const stripped = stripComment(rawLines[i]);
    if (stripped.trim() === '') continue;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trimEnd(), raw: rawLines[i], no: i + 1 });
  }
  const [value] = parseBlock(lines, 0, 0);
  return value;
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

function parseBlock(lines, idx, minIndent) {
  if (idx >= lines.length || lines[idx].indent < minIndent) return [null, idx];
  const indent = lines[idx].indent;
  const content = lines[idx].text.trimStart();
  if (content.startsWith('- ') || content === '-') return parseSeq(lines, idx, indent);
  return parseMap(lines, idx, indent);
}

function parseSeq(lines, idx, indent) {
  const arr = [];
  let i = idx;
  while (i < lines.length && lines[i].indent === indent) {
    const content = lines[i].text.trimStart();
    if (!(content.startsWith('- ') || content === '-')) break;
    const rest = content === '-' ? '' : content.slice(2).trim();
    if (rest === '') {
      const [v, ni] = parseBlock(lines, i + 1, indent + 1);
      arr.push(v); i = ni;
    } else if (rest.startsWith('{') || rest.startsWith('[')) {
      arr.push(parseInline(rest)); i += 1;
    } else if (/^[^\s:]+(\s*):(\s|$)/.test(rest) || /^["'][^"']*["']\s*:(\s|$)/.test(rest)) {
      // 序列项内联映射："- id: x" 后续行以更深缩进续写同一映射
      const virtualIndent = lines[i].indent + (lines[i].text.trimStart().length - rest.length);
      const fake = { indent: virtualIndent, text: ' '.repeat(virtualIndent) + rest, raw: lines[i].raw, no: lines[i].no };
      const sub = [fake];
      let j = i + 1;
      while (j < lines.length && lines[j].indent >= virtualIndent && !(lines[j].indent === indent && /^-(\s|$)/.test(lines[j].text.trimStart()))) {
        sub.push(lines[j]); j++;
      }
      const [v] = parseMap(sub, 0, virtualIndent);
      arr.push(v); i = j;
    } else {
      arr.push(parseScalar(rest)); i += 1;
    }
  }
  return [arr, i];
}

function parseMap(lines, idx, indent) {
  const obj = {};
  let i = idx;
  while (i < lines.length && lines[i].indent === indent) {
    const content = lines[i].text.trimStart();
    if (content.startsWith('- ')) break;
    const m = content.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^:\s][^:]*?)\s*:(.*)$/);
    if (!m) { i += 1; continue; }
    const key = unquote(m[1].trim());
    let rest = m[2].trim();
    if (rest === '' ) {
      const [v, ni] = parseBlock(lines, i + 1, indent + 1);
      obj[key] = v; i = ni;
    } else if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      const parts = [];
      let j = i + 1;
      while (j < lines.length && lines[j].indent > indent) { parts.push(lines[j].text.trim()); j++; }
      obj[key] = parts.join('\n'); i = j;
    } else {
      obj[key] = parseInline(rest); i += 1;
    }
  }
  return [obj, i];
}

function parseInline(s) {
  s = s.trim();
  if (s.startsWith('{')) return parseFlow(s).value;
  if (s.startsWith('[')) return parseFlow(s).value;
  return parseScalar(s);
}

function parseFlow(s) {
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
        const k = flowScalar([':']); i++; // skip ':'
        o[unquote(k.trim())] = value();
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


export { parseYaml };

function stripTrailingCommas(text) {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === "\\" && text[index + 1] !== undefined) out += text[++index];
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (/\s/.test(text[next] || "")) next++;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    out += char;
  }
  return out;
}

function stripComments(text) {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\" && next !== undefined) out += next, index++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true, out += char;
    else if (char === "/" && next === "/") inLineComment = true, index++;
    else if (char === "/" && next === "*") inBlockComment = true, index++;
    else out += char;
  }
  if (inBlockComment) throw new SyntaxError("unterminated block comment");
  return out;
}

export function parseJsoncObject(text, source = "configuration") {
  let value;
  try {
    value = JSON.parse(stripTrailingCommas(stripComments(String(text))));
  } catch (error) {
    throw new Error(`${source}: JSONC 格式无效（${error?.message || String(error)}）`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: 顶层配置必须是对象`);
  }
  return value;
}

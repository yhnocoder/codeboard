// 一个够用的 Python 词法高亮：逐行输出 token，支持跨行的三引号字符串。
// 真产品里会换成 tree-sitter，这里只求零依赖、颜色对。

export type TokKind = "kw" | "str" | "com" | "num" | "fn" | "call" | "cls" | "self" | "deco" | "builtin" | "op" | "txt";
export type Tok = { k: TokKind; t: string };

const KW = new Set("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False".split(" "));
const BUILTIN = new Set("int float str bool list dict set tuple len range zip min max sum sorted reversed isinstance print super enumerate any all next iter type object".split(" "));

export function tokenizePython(src: string): Tok[][] {
  const lines = src.split("\n");
  const out: Tok[][] = [];
  let openTriple: string | null = null; // 未闭合的三引号
  let afterDef = false;
  let afterClass = false;

  for (const line of lines) {
    const toks: Tok[] = [];
    let i = 0;
    const push = (k: TokKind, t: string) => {
      if (!t) return;
      const last = toks[toks.length - 1];
      if (last && last.k === k && k === "txt") last.t += t;
      else toks.push({ k, t });
    };

    if (openTriple) {
      const end = line.indexOf(openTriple);
      if (end === -1) { push("str", line); out.push(toks); continue; }
      push("str", line.slice(0, end + 3));
      i = end + 3;
      openTriple = null;
    }

    while (i < line.length) {
      const ch = line[i];
      const rest = line.slice(i);
      if (ch === "#") { push("com", rest); break; }
      const strm = /^([rbfuRBFU]{0,2})("""|'''|"|')/.exec(rest);
      if (strm && (strm[1] === "" || /[A-Za-z]/.test(strm[1]))) {
        const q = strm[2];
        const startBody = i + strm[0].length;
        if (q.length === 3) {
          const end = line.indexOf(q, startBody);
          if (end === -1) { push("str", line.slice(i)); openTriple = q; i = line.length; break; }
          push("str", line.slice(i, end + 3)); i = end + 3; continue;
        }
        let j = startBody;
        while (j < line.length && line[j] !== q) { if (line[j] === "\\") j++; j++; }
        push("str", line.slice(i, j + 1)); i = j + 1; continue;
      }
      if (ch === "@" && /^\s*$/.test(line.slice(0, i))) {
        const m = /^@[\w.]+/.exec(rest)!;
        push("deco", m[0]); i += m[0].length; continue;
      }
      const num = /^\d[\d_]*(\.\d+)?(e[+-]?\d+)?/i.exec(rest);
      if (num && !/\w/.test(line[i - 1] ?? "")) { push("num", num[0]); i += num[0].length; continue; }
      const id = /^[A-Za-z_]\w*/.exec(rest);
      if (id) {
        const w = id[0];
        const next = line.slice(i + w.length);
        let k: TokKind = "txt";
        if (afterDef) { k = "fn"; afterDef = false; }
        else if (afterClass) { k = "cls"; afterClass = false; }
        else if (KW.has(w)) { k = "kw"; if (w === "def") afterDef = true; if (w === "class") afterClass = true; }
        else if (w === "self" || w === "cls") k = "self";
        else if (BUILTIN.has(w) && /^\s*\(/.test(next)) k = "builtin";
        else if (/^\(/.test(next)) k = "call";
        else if (/^[A-Z][A-Za-z0-9]*$/.test(w) && /[a-z]/.test(w)) k = "cls";
        push(k, w); i += w.length; continue;
      }
      push(/[=+\-*/%<>!&|^~:]/.test(ch) ? "op" : "txt", ch);
      i++;
    }
    out.push(toks);
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function tokHtml(t: Tok): string {
  return t.k === "txt" ? esc(t.t) : `<span class="t-${t.k}">${esc(t.t)}</span>`;
}

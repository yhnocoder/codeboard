// v0.1.5 的分析实现（JS 逐节点遍历），留作对比测试的基准：新实现的结果必须和它逐字段一致。
import TS from "@vscode/tree-sitter-wasm";
import type { Parser as TSParser, Node } from "@vscode/tree-sitter-wasm";
import { BLANK, COMMENT, DOCSTRING, grammarOf, cleanDoc, languageOf, type FileAnalysis, type Sym, type Param, type Arg, type CallSite } from "../../src/analysis";

type Grammar = "python" | "cpp" | "rust";
const parsers = new Map<Grammar, TSParser>();
function parse(g: Grammar, text: string) {
  let p = parsers.get(g);
  if (!p) { p = new TS.Parser(); p.setLanguage(languageOf(g)!); parsers.set(g, p); }
  return p.parse(text)!;
}

/** 分析一个文件（或一段代码）。不认识的语言只给空行标记 */
export function analyzeOld(lang: string, text: string): FileAnalysis {
  const lines = text.split(/\r?\n/);
  const flags = lines.map((l) => (l.trim() === "" ? BLANK : 0));
  const out: FileAnalysis = { lang, symbols: [], flags, trailing: {}, calls: [], mainBlocks: [], imports: [] };
  const g = grammarOf(lang);
  if (!g || !languageOf(g)) return out;
  const tree = parse(g, text);
  try {
    if (g === "python") python(tree.rootNode, lines, out);
    else cpp(tree.rootNode, lines, out);
    comments(tree.rootNode, lines, out);
    if (g === "cpp") launches(lines, out);
  } finally {
    tree.delete();
  }
  out.symbols.sort((a, b) => a.start - b.start || b.end - a.end);
  return out;
}

// ---------- 通用 ----------

function walk(n: Node, fn: (n: Node) => boolean | void) {
  if (fn(n) === false) return;
  for (const c of n.namedChildren) if (c) walk(c, fn);
}

/** 注释：整行都是注释的标 COMMENT，行尾注释记列号 */
function comments(root: Node, lines: string[], out: FileAnalysis) {
  const cmt: { r0: number; c0: number; r1: number; c1: number }[] = [];
  walk(root, (n) => {
    if (n.type === "comment") cmt.push({ r0: n.startPosition.row, c0: n.startPosition.column, r1: n.endPosition.row, c1: n.endPosition.column });
  });
  for (const c of cmt) {
    for (let r = c.r0; r <= c.r1; r++) {
      const line = lines[r] ?? "";
      const s = r === c.r0 ? c.c0 : 0, e = r === c.r1 ? c.c1 : line.length;
      const before = line.slice(0, s).trim(), after = line.slice(e).trim();
      if (!before && !after) out.flags[r] |= COMMENT;
      else if (before && r === c.r0 && !(r + 1 in out.trailing)) out.trailing[r + 1] = colOfByte(line, s);
    }
  }
}

/** web-tree-sitter 解析 JS 字符串时列号已经是 UTF-16 下标 */
const colOfByte = (_line: string, c: number) => c;
const col = (n: Node, lines: string[]) => colOfByte(lines[n.startPosition.row] ?? "", n.startPosition.column);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// ---------- Python ----------

const PY_LOOP_BODY = new Set(["list_comprehension", "set_comprehension", "dictionary_comprehension", "generator_expression"]);

function python(root: Node, lines: string[], out: FileAnalysis) {
  const docstring = (body: Node | null): string | undefined => {
    const first = body?.namedChildren.find((x) => x?.type !== "comment");
    if (first?.type === "expression_statement" && first.namedChildren.length === 1 && first.namedChildren[0]?.type === "string") {
      for (let r = first.startPosition.row; r <= first.endPosition.row; r++) out.flags[r] |= DOCSTRING;
      return cleanDoc(first.namedChildren[0].text) || undefined;
    }
  };
  out.doc = docstring(root);
  pyImports(root, out);

  const visit = (n: Node, scope: string[], cls: string | undefined) => {
    for (const c of n.namedChildren) {
      if (!c) continue;
      let def: Node = c, start = c.startPosition.row;
      if (c.type === "decorated_definition") { def = c.childForFieldName("definition") ?? c; start = c.startPosition.row; }
      if (def.type === "function_definition" || def.type === "class_definition") {
        const name = def.childForFieldName("name")?.text ?? "?";
        const qual = [...scope, name].join(".");
        const body = def.childForFieldName("body");
        const isClass = def.type === "class_definition";
        const sigEnd = body ? body.startIndex : def.endIndex;
        let sig = oneLine(def.text.slice(0, sigEnd - def.startIndex)).replace(/:\s*$/, "");
        if (sig.startsWith("async ")) sig = sig;
        const sym: Sym = {
          name, qual, kind: isClass ? "class" : "def", start: start + 1, defLine: def.startPosition.row + 1, end: c.endPosition.row + 1,
          sig, params: isClass ? [] : pyParams(def.childForFieldName("parameters"), !!cls), parent: cls,
        };
        out.symbols.push(sym);
        const doc = docstring(body);
        if (doc) sym.doc = doc;
        if (body) visit(body, [...scope, name], isClass ? qual : undefined);
        continue;
      }
      if (c.type === "if_statement" && scope.length === 0 && /__name__\s*==\s*["']__main__["']/.test(c.childForFieldName("condition")?.text ?? ""))
        out.mainBlocks.push({ start: c.startPosition.row + 1, end: c.endPosition.row + 1 });
      // 其他语句里也可能嵌着函数（if 里 def），继续往下找
      if (c.namedChildCount) visit(c, scope, cls);
    }
  };
  visit(root, [], undefined);

  walk(root, (n) => {
    if (n.type !== "call") return;
    let fn = n.childForFieldName("function");
    if (!fn) return;
    let nameNode: Node | null = null, recv: string | undefined;
    // v0.2 起：Triton 的 kernel[grid](…)（照新实现补上）
    let launch: "grid" | undefined;
    if (fn.type === "subscript") { const v = fn.childForFieldName("value"); if (v?.type === "identifier" || v?.type === "attribute") { fn = v; launch = "grid"; } }
    if (fn.type === "identifier") nameNode = fn;
    else if (fn.type === "attribute") { nameNode = fn.childForFieldName("attribute"); recv = fn.childForFieldName("object")?.text; }
    if (!nameNode) return;
    const args = pyArgs(n.childForFieldName("arguments"));
    const name = nameNode.text;
    if (PY_SKIP.has(name) && !recv) return;
    const site: CallSite = {
      line: nameNode.startPosition.row + 1, col: col(nameNode, lines), end: col(nameNode, lines) + name.length, name, recv,
      loop: pyInLoop(n), args, assigned: assignedTo(n, "python"),
    };
    if (launch) site.launch = launch;
    // call("run", …) / getattr(self, "run")：只记下字符串，不猜
    const firstStr = n.childForFieldName("arguments")?.namedChildren[0];
    if (firstStr?.type === "string" && /^(call|dispatch|invoke|run_method|getattr)$/.test(name)) site.dispatch = firstStr.text.replace(/^[rbuf]*["']+|["']+$/g, "");
    out.calls.push(site);
  });
}

function pyImports(root: Node, out: FileAnalysis) {
  walk(root, (n) => {
    if (n.type === "function_definition" || n.type === "class_definition") return false; // 只看模块级（含 if / try 里的）
    const line = n.startPosition.row + 1;
    if (n.type === "import_statement") {
      for (const c of n.namedChildren) {
        if (c?.type === "dotted_name") out.imports.push({ name: c.text.split(".")[0], module: c.text.split(".")[0], line });
        else if (c?.type === "aliased_import") out.imports.push({ name: c.childForFieldName("alias")?.text ?? "", module: c.childForFieldName("name")?.text ?? "", line });
      }
      return false;
    }
    if (n.type === "import_from_statement") {
      const mod = n.childForFieldName("module_name")?.text ?? "";
      for (const c of n.childrenForFieldName("name")) {
        if (c?.type === "dotted_name") out.imports.push({ name: c.text, module: mod, line, from: true });
        else if (c?.type === "aliased_import") out.imports.push({ name: c.childForFieldName("alias")?.text ?? "", module: mod, line, from: true });
      }
      return false;
    }
  });
}

// 内置函数不当成可展开的调用
const PY_SKIP = new Set("print len range zip min max sum sorted list dict set tuple int float str bool type getattr setattr hasattr isinstance issubclass enumerate super iter next map filter any all abs round repr id hash open vars dir callable reversed object divmod pow format chr ord".split(" "));

function pyParams(ps: Node | null, method: boolean): Param[] {
  const out: Param[] = [];
  let kwOnly = false;
  for (const p of ps?.namedChildren ?? []) {
    if (!p) continue;
    let name = "", kind: Param["kind"] = kwOnly ? "kw" : "pos";
    switch (p.type) {
      case "identifier": name = p.text; break;
      case "typed_parameter": name = p.namedChildren.find((x) => x?.type === "identifier")?.text ?? ""; if (p.namedChildren[0]?.type === "list_splat_pattern") { name = p.namedChildren[0].namedChildren[0]?.text ?? ""; kind = "star"; kwOnly = true; } else if (p.namedChildren[0]?.type === "dictionary_splat_pattern") { name = p.namedChildren[0].namedChildren[0]?.text ?? ""; kind = "dstar"; } break;
      case "default_parameter": case "typed_default_parameter": name = p.childForFieldName("name")?.text ?? ""; break;
      case "list_splat_pattern": name = p.namedChildren[0]?.text ?? ""; kind = "star"; kwOnly = true; break;
      case "dictionary_splat_pattern": name = p.namedChildren[0]?.text ?? ""; kind = "dstar"; break;
      case "keyword_separator": kwOnly = true; continue;
      case "positional_separator": continue;
      default: continue;
    }
    if (!name) continue;
    if (method && out.length === 0 && (name === "self" || name === "cls")) kind = "self";
    out.push({ name, kind });
  }
  return out;
}

function pyArgs(al: Node | null): Arg[] {
  const out: Arg[] = [];
  for (const a of al?.namedChildren ?? []) {
    if (!a || a.type === "comment") continue;
    if (a.type === "keyword_argument") {
      const v = a.childForFieldName("value");
      out.push({ kw: a.childForFieldName("name")?.text, text: oneLine(v?.text ?? ""), name: v?.type === "identifier" ? v.text : undefined });
    } else if (a.type === "list_splat" || a.type === "dictionary_splat") out.push({ text: a.text, star: true });
    else out.push({ text: oneLine(a.text), name: a.type === "identifier" ? a.text : undefined });
  }
  return out;
}

function pyInLoop(n: Node): boolean {
  let child: Node = n, p = n.parent;
  while (p) {
    if (p.type === "function_definition" || p.type === "class_definition" || p.type === "lambda") return false;
    if (p.type === "for_statement" && p.childForFieldName("body")?.id === child.id) return true;
    if (p.type === "while_statement") return true;
    if (PY_LOOP_BODY.has(p.type)) return true;
    child = p;
    p = p.parent;
  }
  return false;
}

/** 返回值被谁接住：沿着 .tolist()、x if c else y、await、括号往上，碰到赋值就取左边的名字 */
function assignedTo(n: Node, g: Grammar): string[] | undefined {
  let cur: Node = n, p = n.parent;
  const passThrough = g === "python"
    ? new Set(["attribute", "call", "conditional_expression", "parenthesized_expression", "await", "subscript"])
    : new Set(["field_expression", "call_expression", "conditional_expression", "parenthesized_expression"]);
  while (p && passThrough.has(p.type)) { cur = p; p = p.parent; }
  if (!p) return undefined;
  if (g === "python" && (p.type === "assignment" || p.type === "augmented_assignment") && p.childForFieldName("right")?.id === cur.id) {
    const left = p.childForFieldName("left");
    if (!left) return undefined;
    const names: string[] = [];
    walk(left, (x) => {
      if (x.type === "identifier" || x.type === "attribute" || x.type === "subscript") { names.push(x.text); return false; }
    });
    return names.length ? names : undefined;
  }
  if (g === "cpp") {
    if (p.type === "init_declarator" && p.childForFieldName("value")?.id === cur.id) {
      const d = p.childForFieldName("declarator");
      return d ? [d.text.replace(/^[*&\s]+/, "")] : undefined;
    }
    if (p.type === "assignment_expression" && p.childForFieldName("right")?.id === cur.id) {
      const l = p.childForFieldName("left");
      return l ? [l.text] : undefined;
    }
  }
  return undefined;
}

// ---------- C / C++ / CUDA ----------

const CPP_SKIP = new Set("sizeof static_cast reinterpret_cast const_cast dynamic_cast printf assert".split(" "));

function cpp(root: Node, lines: string[], out: FileAnalysis) {
  const visit = (n: Node, scope: string[], cls: string | undefined) => {
    for (const c of n.namedChildren) {
      if (!c) continue;
      let def = c;
      const start = c.startPosition.row;
      if (c.type === "template_declaration") def = c.namedChildren.find((x) => x && /function_definition|class_specifier|struct_specifier/.test(x.type)) ?? c;
      if (def.type === "function_definition") {
        const decl = funcDeclarator(def.childForFieldName("declarator"));
        const nameNode = decl?.childForFieldName("declarator");
        const full = nameNode?.text ?? "?";
        const name = full.split("::").pop()!;
        const qual = [...scope, full].join("::");
        const body = def.childForFieldName("body");
        const sig = oneLine(def.text.slice(0, (body?.startIndex ?? def.endIndex) - def.startIndex));
        out.symbols.push({ name, qual, kind: "def", start: start + 1, defLine: def.startPosition.row + 1, end: c.endPosition.row + 1, sig, params: cppParams(decl?.childForFieldName("parameters") ?? null), parent: cls });
        continue;
      }
      if ((def.type === "class_specifier" || def.type === "struct_specifier") && def.childForFieldName("body")) {
        const name = def.childForFieldName("name")?.text ?? "?";
        const qual = [...scope, name].join("::");
        out.symbols.push({ name, qual, kind: "class", start: start + 1, defLine: def.startPosition.row + 1, end: c.endPosition.row + 1, sig: oneLine(def.text.slice(0, def.childForFieldName("body")!.startIndex - def.startIndex)), params: [], parent: cls });
        visit(def.childForFieldName("body")!, [...scope, name], qual);
        continue;
      }
      if (c.type === "namespace_definition") {
        const name = c.childForFieldName("name")?.text;
        const body = c.childForFieldName("body");
        if (body) visit(body, name ? [...scope, name] : scope, cls);
        continue;
      }
      if (c.namedChildCount && /declaration_list|field_declaration_list|linkage_specification|preproc_/.test(c.type)) visit(c, scope, cls);
    }
  };
  visit(root, [], undefined);

  walk(root, (n) => {
    if (n.type !== "call_expression") return;
    const fn = n.childForFieldName("function");
    if (!fn) return;
    let nameNode: Node | null = null, recv: string | undefined;
    if (fn.type === "identifier") nameNode = fn;
    else if (fn.type === "field_expression") { nameNode = fn.childForFieldName("field"); recv = fn.childForFieldName("argument")?.text; }
    else if (fn.type === "qualified_identifier") { nameNode = lastName(fn); recv = fn.text.slice(0, fn.text.lastIndexOf("::")); }
    else if (fn.type === "template_function") nameNode = fn.childForFieldName("name");
    if (!nameNode || CPP_SKIP.has(nameNode.text)) return;
    const al = n.childForFieldName("arguments");
    out.calls.push({
      line: nameNode.startPosition.row + 1, col: col(nameNode, lines), end: col(nameNode, lines) + nameNode.text.length, name: nameNode.text, recv,
      loop: cppInLoop(n), args: (al?.namedChildren ?? []).filter((a): a is Node => !!a && a.type !== "comment").map((a) => ({ text: oneLine(a.text), name: a.type === "identifier" ? a.text : undefined })),
      assigned: assignedTo(n, "cpp"),
    });
  });
}

function funcDeclarator(d: Node | null): Node | null {
  while (d && d.type !== "function_declarator") d = d.childForFieldName("declarator");
  return d;
}
function lastName(q: Node): Node | null {
  let n: Node | null = q;
  while (n?.type === "qualified_identifier") n = n.childForFieldName("name");
  return n;
}
function cppParams(ps: Node | null): Param[] {
  const out: Param[] = [];
  for (const p of ps?.namedChildren ?? []) {
    if (!p || !/parameter_declaration/.test(p.type)) continue;
    let d = p.childForFieldName("declarator");
    while (d && d.type !== "identifier") d = d.childForFieldName("declarator") ?? d.namedChildren.find((x) => x?.type === "identifier") ?? null;
    if (d) out.push({ name: d.text, kind: "pos" });
  }
  return out;
}
function cppInLoop(n: Node): boolean {
  let child: Node = n, p = n.parent;
  while (p) {
    if (p.type === "function_definition" || p.type === "lambda_expression") return false;
    if ((p.type === "for_statement" || p.type === "for_range_loop") && p.childForFieldName("body")?.id === child.id) return true;
    if (p.type === "while_statement" || p.type === "do_statement") return true;
    child = p;
    p = p.parent;
  }
  return false;
}


// v0.2 起：CUDA 的 kernel<<<…>>>(…)（照新实现补上）
function launches(lines: string[], out: FileAnalysis) {
  const re = /([A-Za-z_]\w*)\s*(?:<[^<>;]*(?:<[^<>;]*>[^<>;]*)*>)?\s*<<</g;
  lines.forEach((t, r) => {
    if (!t.includes("<<<")) return;
    re.lastIndex = 0;
    for (let m; (m = re.exec(t)); ) {
      const at = out.calls.find((c) => c.line === r + 1 && c.col === m!.index);
      if (at) { at.launch = "<<<"; continue; }
      out.calls.push({ line: r + 1, col: m.index, end: m.index + m[1].length, name: m[1], loop: false, args: [], launch: "<<<" });
    }
  });
  out.calls.sort((a, b) => a.line - b.line || a.col - b.col);
}

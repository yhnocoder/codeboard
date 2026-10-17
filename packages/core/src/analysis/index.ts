// 代码结构分析：用 tree-sitter 解析，得到符号、调用、循环、注释 / docstring / 空行。
// 纯语法判断，不依赖语言服务；「转到定义」由宿主问 VS Code。
// Python 系（含 Triton、TileLang）用 python 语法；C / C++ / CUDA 用 cpp 语法（CUDA 的 <<<>>> 会被当成错误节点跳过）。
import type { Node, QueryCapture } from "@vscode/tree-sitter-wasm";
import { grammarOf, languageOf, query, treeOf, type Edit, type Grammar } from "./tree";
import { F_BLANK, F_COMMENT, F_DOCSTRING } from "../lines";
export { initAnalysis, grammarOf, languageOf, diffEdit, forgetTree, setTreeCacheSize, type Edit } from "./tree";


export type Param = { name: string; kind: "self" | "pos" | "kw" | "star" | "dstar" };

export type Sym = {
  name: string;
  qual: string; // Scheduler.schedule；C++ 里是 ns::Cls::f
  kind: "def" | "class";
  start: number; // 1-based，含装饰器 / template
  defLine: number; // def / class 所在行
  end: number; // 1-based，含
  sig: string; // 一行签名：def schedule(self) -> tuple[list[Sequence], bool]
  params: Param[];
  parent?: string; // 所在类的 qual
  doc?: string; // docstring（去掉引号、公共缩进）
};

export type Arg = { text: string; name?: string; kw?: string; star?: boolean };

export type CallSite = {
  line: number; // 1-based
  col: number; // 被调名字的起始列（0-based，UTF-16）
  end: number;
  name: string;
  recv?: string; // self.scheduler.schedule() 的 self.scheduler
  loop: boolean; // 在同一函数的 for / while / 推导式里
  args: Arg[];
  assigned?: string[]; // 返回值被谁接住：seqs, is_prefill = …
  dispatch?: string; // call("run", …) 这种按字符串转发：记下字符串，但不当成调用 run
};

// 行标记和 lines.ts 的 F_* 是同一套值
export const BLANK = F_BLANK, COMMENT = F_COMMENT, DOCSTRING = F_DOCSTRING;

export type FileAnalysis = {
  lang: string;
  symbols: Sym[];
  /** 每行的标记（下标 = 行号 - 1）：BLANK / COMMENT（整行是注释）/ DOCSTRING */
  flags: number[];
  /** 行尾注释：行号 → 注释开始的列 */
  trailing: Record<number, number>;
  calls: CallSite[];
  /** Python 的 if __name__ == "__main__": 块 */
  mainBlocks: { start: number; end: number }[];
  /** 模块 docstring */
  doc?: string;
  /** import 绑定的名字：import torch.multiprocessing as mp → { name: "mp", module: "torch.multiprocessing" }；相对导入 module 以 . 开头 */
  imports: { name: string; module: string; line: number; from?: true }[]; // from = from X import name（name 不一定是模块）
};

export type AnalyzeOpts = {
  /** 文件的 key（通常是路径）：留着语法树，下次同一个 key 的文本变了就增量解析，没变就不再解析 */
  key?: string;
  /** 上次（同一个 key）的文本 → 这次文本的编辑；不给就按公共前后缀算 */
  edit?: Edit;
  /**
   * 只要这几行（1-based，含两头）：calls、COMMENT / DOCSTRING 标记、trailing 只算这段，symbols 只给和这段相交的；
   * imports、mainBlocks、doc、BLANK 标记仍是整个文件的。结果等于 clipAnalysis(整文件分析, start, end)
   */
  lines?: { start: number; end: number };
};

/** 分析一个文件（或一段代码）。不认识的语言只给空行标记 */
export function analyze(lang: string, text: string, o: AnalyzeOpts = {}): FileAnalysis {
  const lines = text.split(/\r?\n/);
  const flags = lines.map((l) => (l.trim() === "" ? BLANK : 0));
  const out: FileAnalysis = { lang, symbols: [], flags, trailing: {}, calls: [], mainBlocks: [], imports: [] };
  const g = grammarOf(lang);
  if (!g || !languageOf(g)) return out;
  const { tree, owned } = treeOf(g, text, o.key, o.edit);
  const r = o.lines;
  try {
    const cx: Cx = { text, lines, out, r0: r ? r.start - 1 : 0, r1: r ? r.end - 1 : Infinity };
    const root = tree.rootNode;
    if (g === "python") out.doc = docstring(cx, root);
    else cppSymbols(cx, root);
    if (!r) run(g, cx, sorted(query(g, "all", STRUCT[g] + FLOW[g]).captures(root)));
    else {
      // 结构（定义、import）整个文件查，调用、循环、注释只查这几行
      if (STRUCT[g]) run(g, cx, sorted(query(g, "struct", STRUCT[g]).captures(root)));
      if (r.start <= r.end) run(g, cx, sorted(query(g, "flow", FLOW[g]).captures(root, { startPosition: { row: cx.r0, column: 0 }, endPosition: { row: cx.r1 + 1, column: 0 } })));
    }
  } finally {
    if (owned) tree.delete();
  }
  out.symbols.sort((a, b) => a.start - b.start || b.end - a.end);
  return r ? Object.assign(out, clipAnalysis(out, r.start, r.end)) : out;
}

/** 整文件的分析结果裁剪到几行（和 analyze(…, { lines }) 的结果一致） */
export function clipAnalysis(a: FileAnalysis, start: number, end: number): FileAnalysis {
  const inR = (l: number) => l >= start && l <= end;
  const trailing: Record<number, number> = {};
  for (const k in a.trailing) if (inR(+k)) trailing[+k] = a.trailing[k];
  return {
    ...a, symbols: a.symbols.filter((s) => s.start <= end && s.end >= start), calls: a.calls.filter((c) => inR(c.line)),
    flags: a.flags.map((f, i) => (inR(i + 1) ? f : f & BLANK)), trailing,
  };
}

// ---------- 查询 ----------
// 每个语法一个查询，解析完跑一遍拿到要用的全部节点（定义、调用、循环、注释、import），按位置顺序处理：
// 定义、循环 / 函数各压一个栈，处理到某个节点时栈顶就是包着它的最内层定义 / 循环。

const STRUCT: Record<Grammar, string> = {
  python: `
(function_definition) @def
(class_definition) @def
(import_statement) @import
(import_from_statement) @import
(if_statement condition: (_) @main (#match? @main "__main__"))
`,
  cpp: "", // C++ 的定义只在顶层 / 命名空间 / 类里找，走 cppSymbols
};
const FLOW: Record<Grammar, string> = {
  python: `
(function_definition) @fn
(class_definition) @fn
(lambda) @fn
(for_statement body: (_) @loop)
(while_statement) @loop
(list_comprehension) @loop
(set_comprehension) @loop
(dictionary_comprehension) @loop
(generator_expression) @loop
(assignment right: (_) @rhs)
(augmented_assignment right: (_) @rhs)
(call) @call
(comment) @comment
`,
  cpp: `
(function_definition) @fn
(lambda_expression) @fn
(for_statement body: (_) @loop)
(for_range_loop body: (_) @loop)
(while_statement) @loop
(do_statement) @loop
(init_declarator value: (_) @rhs)
(assignment_expression right: (_) @rhs)
(call_expression) @call
(comment) @comment
`,
};

// 范围相同的节点：外层先处理。循环排在函数前（for 的 body 只有一个 lambda 时两者范围相同，lambda 在里面），都在调用前
const RANK: Record<string, number> = { loop: 0, rhs: 0, fn: 1, def: 1 };
type Cap = { name: string; node: Node; s: number; e: number; rank: number };
function sorted(caps: QueryCapture[]): Cap[] {
  const out = caps.map((c) => ({ name: c.name, node: c.node, s: c.node.startIndex, e: c.node.endIndex, rank: RANK[c.name] ?? 2 }));
  return out.sort((a, b) => a.s - b.s || b.e - a.e || a.rank - b.rank);
}

/** text / lines：源码；r0..r1：只要这几行（0-based，含） */
type Cx = { text: string; lines: string[]; out: FileAnalysis; r0: number; r1: number };
/** 外围的定义。visited = 旧的递归能走到（定义在外层定义的 body 里）；bs / be = body 的范围 */
type DefFrame = { e: number; visited: boolean; scope: string[]; qual: string; isClass: boolean; bs: number; be: number };

function run(g: Grammar, cx: Cx, caps: Cap[]) {
  const defs: DefFrame[] = [], flow: { e: number; loop: boolean }[] = [], rhs: number[] = [];
  const cmt: Node[] = [];
  for (const c of caps) {
    while (defs.length && defs[defs.length - 1].e <= c.s) defs.pop();
    while (flow.length && flow[flow.length - 1].e <= c.s) flow.pop();
    while (rhs.length && rhs[rhs.length - 1] <= c.s) rhs.pop();
    switch (c.name) {
      case "def": defs.push(pyDef(cx, c.node, defs[defs.length - 1])); break;
      case "import": if (!defs.length) pyImport(c.node, cx.out); break; // 只看模块级（含 if / try 里的）
      case "main": {
        const n = c.node.parent;
        if (n && !defs.length && /__name__\s*==\s*["']__main__["']/.test(c.node.text)) cx.out.mainBlocks.push({ start: n.startPosition.row + 1, end: n.endPosition.row + 1 });
        break;
      }
      case "fn": flow.push({ e: c.e, loop: false }); break;
      case "loop": flow.push({ e: c.e, loop: true }); break;
      case "rhs": rhs.push(c.e); break; // 赋值右边：只有在这里面的调用才可能有人接住返回值
      case "call": (g === "python" ? pyCall : cppCall)(cx, c.node, !!flow[flow.length - 1]?.loop, rhs.length > 0); break;
      case "comment": cmt.push(c.node); break;
    }
  }
  comments(cmt, cx);
}

// ---------- 通用 ----------

function walk(n: Node, fn: (n: Node) => boolean | void) {
  if (fn(n) === false) return;
  for (const c of n.namedChildren) if (c) walk(c, fn);
}

/** 注释：整行都是注释的标 COMMENT，行尾注释记列号 */
function comments(nodes: Node[], { lines, out, r0, r1 }: Cx) {
  for (const n of nodes) {
    const a = n.startPosition, b = n.endPosition;
    for (let r = Math.max(a.row, r0); r <= b.row && r <= r1; r++) {
      const line = lines[r] ?? "";
      const s = r === a.row ? a.column : 0, e = r === b.row ? b.column : line.length;
      const before = line.slice(0, s).trim(), after = line.slice(e).trim();
      if (!before && !after) out.flags[r] |= COMMENT;
      else if (before && r === a.row && !(r + 1 in out.trailing)) out.trailing[r + 1] = s;
    }
  }
}

// web-tree-sitter 解析 JS 字符串时下标、列号都是 UTF-16 的
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const meets = (cx: Cx, n: Node) => n.startPosition.row <= cx.r1 && n.endPosition.row >= cx.r0;

// ---------- Python ----------

/** body 的第一条语句是字符串：标 DOCSTRING，返回正文 */
function docstring(cx: Cx, body: Node | null): string | undefined {
  let first = body?.firstNamedChild ?? null;
  while (first?.type === "comment") first = first.nextNamedSibling;
  if (first?.type === "expression_statement" && first.namedChildCount === 1 && first.firstNamedChild?.type === "string") {
    for (let r = first.startPosition.row; r <= first.endPosition.row; r++) cx.out.flags[r] |= DOCSTRING;
    return cleanDoc(first.firstNamedChild.text) || undefined;
  }
}

function pyDef(cx: Cx, def: Node, up: DefFrame | undefined): DefFrame {
  const p = def.parent;
  const c = p?.type === "decorated_definition" ? p : def; // 带装饰器的从装饰器那行算起
  const cs = c.startIndex, e = def.endIndex;
  // 外层定义没被走到，或者不在外层定义的 body 里（出错的树）：旧的递归走不到，不算
  if (up && !(up.visited && up.bs <= cs && e <= up.be)) return { e, visited: false, scope: [], qual: "", isClass: false, bs: 0, be: 0 };
  const scope = up?.scope ?? [], cls = up?.isClass ? up.qual : undefined;
  const name = def.childForFieldName("name")?.text ?? "?";
  const qual = [...scope, name].join(".");
  const body = def.childForFieldName("body");
  const isClass = def.type === "class_definition";
  const frame = { e, visited: true, scope: [...scope, name], qual, isClass, bs: body?.startIndex ?? 0, be: body?.endIndex ?? -1 };
  if (!meets(cx, c)) return frame;
  const sig = oneLine(cx.text.slice(def.startIndex, body ? body.startIndex : e)).replace(/:\s*$/, "");
  const sym: Sym = {
    name, qual, kind: isClass ? "class" : "def", start: c.startPosition.row + 1, defLine: def.startPosition.row + 1, end: c.endPosition.row + 1,
    sig, params: isClass ? [] : pyParams(def.childForFieldName("parameters"), !!cls), parent: cls,
  };
  cx.out.symbols.push(sym);
  const doc = docstring(cx, body);
  if (doc) sym.doc = doc;
  return frame;
}

function pyCall(cx: Cx, n: Node, loop: boolean, inRhs: boolean) {
  const fn = n.childForFieldName("function");
  if (!fn) return;
  let nameNode: Node | null = null, recv: string | undefined;
  if (fn.type === "identifier") nameNode = fn;
  else if (fn.type === "attribute") { nameNode = fn.childForFieldName("attribute"); recv = fn.childForFieldName("object")?.text; }
  if (!nameNode) return;
  const name = nameNode.text;
  if (PY_SKIP.has(name) && !recv) return;
  const al = n.childForFieldName("arguments");
  const col = nameNode.startPosition.column;
  const site: CallSite = { line: nameNode.startPosition.row + 1, col, end: col + name.length, name, recv, loop, args: pyArgs(al), assigned: inRhs ? assignedTo(n, "python") : undefined };
  // call("run", …) / getattr(self, "run")：只记下字符串，不猜
  if (/^(call|dispatch|invoke|run_method|getattr)$/.test(name)) {
    const firstStr = al?.firstNamedChild;
    if (firstStr?.type === "string") site.dispatch = firstStr.text.replace(/^[rbuf]*["']+|["']+$/g, "");
  }
  cx.out.calls.push(site);
}

/** 字符串字面量 → docstring 正文（照 inspect.cleandoc） */
export function cleanDoc(lit: string): string {
  const m = /^[rRbBuUfF]*("""|'''|"|')([\s\S]*?)\1$/.exec(lit.trim());
  const lines = (m ? m[2] : lit).replace(/\t/g, "    ").split(/\r?\n/);
  const ind = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  const out = [lines[0].trim(), ...lines.slice(1).map((l) => (Number.isFinite(ind) ? l.slice(ind) : l).trimEnd())];
  while (out.length && !out[0]) out.shift();
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join("\n");
}

function pyImport(n: Node, out: FileAnalysis) {
  const line = n.startPosition.row + 1;
  if (n.type === "import_statement") {
    for (const c of n.namedChildren) {
      if (c?.type === "dotted_name") out.imports.push({ name: c.text.split(".")[0], module: c.text.split(".")[0], line });
      else if (c?.type === "aliased_import") out.imports.push({ name: c.childForFieldName("alias")?.text ?? "", module: c.childForFieldName("name")?.text ?? "", line });
    }
  } else {
    const mod = n.childForFieldName("module_name")?.text ?? "";
    for (const c of n.childrenForFieldName("name")) {
      if (c?.type === "dotted_name") out.imports.push({ name: c.text, module: mod, line, from: true });
      else if (c?.type === "aliased_import") out.imports.push({ name: c.childForFieldName("alias")?.text ?? "", module: mod, line, from: true });
    }
  }
}

/**
 * 调用名字绑到哪个包：沿 recv（或名字本身）的第一个名字找 import，返回顶层包名。
 * 相对导入、本地定义、self.x 都返回 undefined（和当前文件同一个包）。
 */
export function importPkg(a: Pick<FileAnalysis, "imports">, call: { name: string; recv?: string }): string | undefined {
  const root = /^[A-Za-z_]\w*/.exec(call.recv ?? call.name)?.[0];
  if (!root) return undefined;
  const im = a.imports.find((i) => i.name === root);
  if (!im || !im.module || im.module.startsWith(".")) return undefined;
  return im.module.split(".")[0];
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

function cppSymbols({ out }: Cx, root: Node) {
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
}

function cppCall({ out }: Cx, n: Node, loop: boolean, inRhs: boolean) {
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
    line: nameNode.startPosition.row + 1, col: nameNode.startPosition.column, end: nameNode.startPosition.column + nameNode.text.length, name: nameNode.text, recv,
    loop, args: (al?.namedChildren ?? []).filter((a): a is Node => !!a && a.type !== "comment").map((a) => ({ text: oneLine(a.text), name: a.type === "identifier" ? a.text : undefined })),
    assigned: inRhs ? assignedTo(n, "cpp") : undefined,
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

// ---------- 按行查 ----------

/** 含有某一行的最内层符号 */
export function symbolAt(syms: Sym[], line: number, kind?: Sym["kind"]): Sym | undefined {
  return syms.filter((s) => s.start <= line && line <= s.end && (!kind || s.kind === kind)).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
}

/** 某行上的调用 */
export const callsOn = (a: FileAnalysis, line: number) => a.calls.filter((c) => c.line === line);

export * from "./vars";
export * from "./select";
export * from "./entry";
export * from "./peek";

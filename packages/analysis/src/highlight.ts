// C / C++ / CUDA 用 tree-sitter 着色：shiki 的 C++ 语法有两百多个正则，JavaScript 引擎第一次用到时逐个编译，一个会话的第一张 C++ 卡要等一两秒；
// 语法树分析时本来就有（同一个 key 的树直接复用），再跑一个高亮查询只要几毫秒。
// 查询改自 tree-sitter-c / tree-sitter-cpp 的 queries/highlights.scm 和 @yhnocoder/tree-sitter-cuda 的（都是 MIT），
// 捕获名直接对到白板的颜色 class（render.ts 的 kw / fn / str / com / num / self / p），颜色和 shiki 的 css-variables 主题给的一样，主题不用加颜色：
// 关键字、运算符、内建类型（int、size_t…）是 kw，类型名和函数名是 fn（shiki 的 entity.name.type 也是 function 色），常量字面量是 num。
import type { Node } from "@vscode/tree-sitter-wasm";
import { languageOf, query, treeOf, type Grammar } from "./tree";

export type HlTok = { text: string; cls?: string };

// 同一个节点后面的模式盖过前面的，里层节点盖过外层：先写一般的，再写特殊的
const CPP = `
(comment) @com

[(string_literal) (raw_string_literal) (char_literal) (system_lib_string)] @str
(number_literal) @num
[(true) (false) (null)] @num
(this) @self

[(primitive_type) (sized_type_specifier) (auto)] @kw
(type_identifier) @fn

[
 "break" "case" "const" "continue" "default" "do" "else" "enum" "extern" "for" "goto" "if" "inline" "return" "sizeof"
 "static" "struct" "switch" "typedef" "union" "volatile" "while" "register" "restrict" "thread_local" "__thread" "_Atomic" "_Noreturn" "noreturn" "_Nonnull"
 "__restrict__" "__inline" "__inline__" "__forceinline" "__extension__" "__attribute__" "__attribute" "__declspec" "asm" "__asm__" "__asm" "__volatile__"
 "alignas" "_Alignas" "alignof" "_Alignof" "__alignof__" "__alignof" "_alignof" "offsetof" "_Generic" "signed" "unsigned" "long" "short"
 "catch" "class" "co_await" "co_return" "co_yield" "constexpr" "constinit" "consteval" "decltype" "delete" "explicit" "final" "friend"
 "mutable" "namespace" "noexcept" "new" "operator" "override" "private" "protected" "public" "template" "throw" "try" "typename" "using"
 "concept" "requires" "virtual" "static_assert" "export" "module" "import"
 "and" "or" "not" "xor" "bitand" "bitor" "compl" "and_eq" "or_eq" "xor_eq" "not_eq"
] @kw

["#include" "#define" "#if" "#ifdef" "#ifndef" "#else" "#elif" "#elifdef" "#elifndef" "#endif" "defined"] @kw
(preproc_directive) @kw

[
 "=" "+=" "-=" "*=" "/=" "%=" "&=" "|=" "^=" "<<=" ">>=" "==" "!=" "<" ">" "<=" ">=" "<=>"
 "+" "-" "*" "/" "%" "++" "--" "&&" "||" "!" "~" "&" "|" "^" "<<" ">>" "?" ".*" "->*"
] @kw
["," "." "->" "::" ":"] @p
(conditional_expression ":" @kw)
; 模板的尖括号不是运算符
(template_argument_list ["<" ">"] @plain)
(template_parameter_list ["<" ">"] @plain)
(destructor_name "~" @fn)
; 调用的模板实参是类型还是值，语法分不出来（f<kNumRanks>(…)）：不当类型着色
(template_function arguments: (template_argument_list (type_descriptor type: (type_identifier) @plain)))
(template_method arguments: (template_argument_list (type_descriptor type: (type_identifier) @plain)))

; 调用、声明的是 a::b::f、f<T>、x.f 时只给最后的名字上色（JS 里往下找，见 calleeName；一层层写成模式的话每个都要编译）
(call_expression function: (_) @callee)
(function_declarator declarator: (_) @callee)
(template_function name: (identifier) @fn)
(template_method name: (field_identifier) @fn)
(field_initializer (field_identifier) @fn)
(preproc_function_def name: (identifier) @fn)
(preproc_def name: (identifier) @fn)
(preproc_arg) @macro

((identifier) @kw (#any-of? @kw "static_cast" "reinterpret_cast" "const_cast" "dynamic_cast"))
((identifier) @num (#any-of? @num "threadIdx" "blockIdx" "blockDim" "gridDim" "warpSize"))

["__host__" "__device__" "__global__" "__tile__" "__tile_global__" "__forceinline__" "__noinline__" "__shared__" "__local__" "__constant__"
 "__managed__" "__grid_constant__" "__launch_bounds__" "__cluster_dims__" "__maxnreg__" "__align__"] @kw
(macro_modifier) @kw
(pragma_macro) @kw
["<<<" ">>>"] @kw
`;

const SRC: Record<Grammar, string | undefined> = { cpp: CPP, python: undefined, rust: undefined };

type Span = { s: number; e: number; cls: string; pat: number };

/** 每行的 token。key = 文件路径：和分析共用那棵树（同样的文本不再解析）。tree-sitter 没准备好时整行一个 token */
export function highlightLines(g: Grammar, text: string, key?: string): HlTok[][] {
  const lines = text.split(/\r?\n/);
  const src = SRC[g];
  if (!src || !languageOf(g)) return lines.map((l) => [{ text: l }]);
  const { tree, owned } = treeOf(g, text, key);
  try {
    const spans: Span[] = [];
    collect(g, src, tree.rootNode, 0, spans);
    return paint(text, lines, spans);
  } finally {
    if (owned) tree.delete();
  }
}

function collect(g: Grammar, src: string, root: Node, off: number, out: Span[]) {
  for (const c of query(g, "hl", src).captures(root)) {
    let n: Node | null = c.node;
    if (c.name === "macro") {
      // #define 的值是一段没解析的文本：当 C++ 再解析一遍着色，和编辑器里一样（不然整个宏体都没颜色）。
      // 续行的反斜杠解析器当空白，下标和原文一一对应
      const t = n.parent?.type;
      if ((t !== "preproc_def" && t !== "preproc_function_def") || !n.text.trim()) continue;
      const sub = treeOf(g, n.text).tree;
      try { collect(g, src, sub.rootNode, off + n.startIndex, out); } finally { sub.delete(); }
      continue;
    }
    const cls = c.name === "callee" ? "fn" : c.name;
    if (c.name === "callee") n = calleeName(n);
    if (n && n.endIndex > n.startIndex) out.push({ s: n.startIndex + off, e: n.endIndex + off, cls, pat: c.patternIndex });
  }
}

/** a::b::f、f<T>、x.f、~T 里被调用 / 声明的那个名字；别的（(*fp)、lambda…）不上色 */
function calleeName(n: Node | null): Node | null {
  while (n) {
    switch (n.type) {
      case "identifier": case "field_identifier": case "destructor_name": case "operator_name": return n;
      case "qualified_identifier": case "template_function": case "template_method": n = n.childForFieldName("name"); break;
      case "field_expression": n = n.childForFieldName("field"); break;
      default: return null;
    }
  }
  return null;
}

/** 长的（外层）先涂、短的（里层）后涂，一样长的按模式顺序；每个字符留最后一次的 class，再按行切成 token */
function paint(text: string, lines: string[], spans: Span[]): HlTok[][] {
  const cls: (string | undefined)[] = new Array(text.length);
  spans.sort((a, b) => (b.e - b.s) - (a.e - a.s) || a.pat - b.pat);
  for (const sp of spans) {
    const c = sp.cls === "plain" ? undefined : sp.cls;
    for (let i = sp.s; i < sp.e; i++) cls[i] = c;
  }
  let at = 0;
  return lines.map((l) => {
    const base = at;
    at += l.length + (text[at + l.length] === "\r" ? 2 : 1);
    const toks: HlTok[] = [];
    for (let i = 0; i < l.length;) {
      const c = cls[base + i];
      let j = i + 1;
      while (j < l.length && cls[base + j] === c) j++;
      toks.push(c ? { text: l.slice(i, j), cls: c } : { text: l.slice(i, j) });
      i = j;
    }
    return toks.length ? toks : [{ text: l }];
  });
}

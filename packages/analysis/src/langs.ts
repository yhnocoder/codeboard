// 语言表：全应用（白板、宿主）认语言只看这一张。id 是段的 lang（VS Code languageId；Triton、TileLang 单独一个 id，
// 在 VS Code 里还是 python），aliases 是 Markdown 围栏、用户输入里的别名。

/** tree-sitter 语法：有它的语言才分析符号、调用（建名字索引、找定义） */
export type Grammar = "python" | "cpp" | "rust";

/** C / C++ / CUDA 走 tree-sitter：shiki 的 C++ 语法第一次用时编译两百多个正则，会话里第一张 C++ 卡要等一两秒 */
export type Highlight = { by: "shiki"; lang: string } | { by: "tree-sitter" };
const shiki = (lang: string): Highlight => ({ by: "shiki", lang });

export type LangInfo = {
  /** 段的 lang，也是 Markdown 围栏里的正式名字 */
  id: string;
  label: string;
  /** 在代码卡的语言下拉里 */
  pick?: boolean;
  /** 别名（围栏里写的 py、cu、sh…；不分大小写） */
  aliases: string[];
  /** 文件扩展名（不带点）；第一个是新建文件（语言服务的虚拟文档）用的 */
  ext: string[];
  comment: string;
  vscodeId: string;
  /** 导出 Markdown 时围栏写的名字（GitHub 认的）；空串 = 不写 */
  md: string;
  /** 用哪个着色：shiki（它的语法名），或 tree-sitter（grammar 的高亮查询，analysis 的 highlight.ts）；一种语言只走其中一个，没有就不着色 */
  highlight?: Highlight;
  /** 有语言服务（补全、悬停、签名）；别的语言问了也是空，不白发 */
  lsp?: boolean;
  /** 关键字和内建类型名（悬停时不查定义） */
  keywords?: ReadonlySet<string>;
  /** Peek 找不到定义时，括号里说可能的原因（语言服务是哪个扩展）；没有就用通用的一句 */
  noDef?: string;
  /** 用哪个 tree-sitter 语法分析；没有 = 不分析 */
  grammar?: Grammar;
};

const words = (s: string): ReadonlySet<string> => new Set(s.split(" "));
const PY_KW = words("def return for in if else elif while and or not is None True False class break continue del import from as with lambda yield assert pass raise try except finally global nonlocal async await self cls int str float bool list dict tuple set");
const C_KW = words("return for if else while do break continue switch case default goto sizeof typedef struct union enum class template typename namespace using public private protected virtual static const constexpr auto void int char bool float double long short unsigned signed inline extern volatile new delete this nullptr true false");
// C++ 和 CUDA 的限定符（__global__ 这些不是名字，语言服务也找不到定义）
const CPP_KW = words("noexcept override final mutable explicit friend operator static_cast dynamic_cast reinterpret_cast const_cast decltype throw try catch concept requires co_await co_return co_yield thread_local alignas alignof static_assert register restrict export __restrict __restrict__ __inline__ __forceinline__ __noinline__ __attribute__ __global__ __device__ __host__ __shared__ __constant__ __managed__ __grid_constant__ __launch_bounds__");
const RUST_KW = words("as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str");
const py = { comment: "#", vscodeId: "python", md: "python", highlight: shiki("python"), lsp: true, keywords: PY_KW, noDef: "setattr, dispatch by string, or no Python extension", grammar: "python" as const };
const cpp = { comment: "//", highlight: { by: "tree-sitter" } as const, lsp: true, keywords: new Set([...C_KW, ...CPP_KW]), noDef: "a macro, a header it cannot find, or no C/C++ extension: clangd or ms-vscode.cpptools", grammar: "cpp" as const };

export const LANG_TABLE: readonly LangInfo[] = [
  { id: "python", label: "Python", pick: true, aliases: ["py", "python3"], ext: ["py", "pyi"], ...py },
  { id: "triton", label: "Triton", pick: true, aliases: [], ext: [], ...py },
  { id: "tilelang", label: "TileLang", pick: true, aliases: [], ext: [], ...py },
  { id: "cuda-cpp", label: "CUDA", pick: true, aliases: ["cuda", "cu"], ext: ["cu", "cuh"], vscodeId: "cuda-cpp", md: "cuda", ...cpp },
  { id: "cpp", label: "C++", pick: true, aliases: ["c++", "cc", "cxx", "hpp", "objective-cpp"], ext: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "h", "inl"], vscodeId: "cpp", md: "cpp", ...cpp },
  { id: "c", label: "C", pick: true, aliases: ["objective-c"], ext: ["c"], vscodeId: "c", md: "c", ...cpp },
  { id: "rust", label: "Rust", pick: true, aliases: ["rs"], ext: ["rs"], comment: "//", vscodeId: "rust", md: "rust", highlight: shiki("rust"), lsp: true, keywords: RUST_KW, noDef: "a macro, or no rust-analyzer", grammar: "rust" },
  { id: "typescript", label: "TypeScript", pick: true, aliases: ["ts", "tsx"], ext: ["ts", "tsx"], comment: "//", vscodeId: "typescript", md: "typescript", highlight: shiki("typescript"), lsp: true },
  { id: "javascript", label: "JavaScript", pick: true, aliases: ["js", "jsx", "mjs", "cjs"], ext: ["js", "jsx", "mjs", "cjs"], comment: "//", vscodeId: "javascript", md: "javascript", highlight: shiki("javascript"), lsp: true },
  { id: "go", label: "Go", pick: true, aliases: ["golang"], ext: ["go"], comment: "//", vscodeId: "go", md: "go", highlight: shiki("go"), lsp: true },
  { id: "java", label: "Java", aliases: [], ext: ["java"], comment: "//", vscodeId: "java", md: "java", highlight: shiki("java"), lsp: true },
  { id: "shellscript", label: "Shell", pick: true, aliases: ["bash", "sh", "zsh", "shell", "console"], ext: ["sh", "bash", "zsh"], comment: "#", vscodeId: "shellscript", md: "bash", highlight: shiki("shellscript") },
  { id: "json", label: "JSON", aliases: ["jsonc"], ext: ["json"], comment: "//", vscodeId: "json", md: "json", highlight: shiki("json") },
  { id: "yaml", label: "YAML", aliases: ["yml"], ext: ["yaml", "yml"], comment: "#", vscodeId: "yaml", md: "yaml", highlight: shiki("yaml") },
  { id: "toml", label: "TOML", aliases: [], ext: ["toml"], comment: "#", vscodeId: "toml", md: "toml", highlight: shiki("toml") },
  { id: "ini", label: "INI", aliases: ["cfg"], ext: ["ini", "cfg"], comment: ";", vscodeId: "ini", md: "ini", highlight: shiki("ini") },
  { id: "sql", label: "SQL", aliases: [], ext: ["sql"], comment: "--", vscodeId: "sql", md: "sql", highlight: shiki("sql") },
  { id: "lua", label: "Lua", aliases: [], ext: ["lua"], comment: "--", vscodeId: "lua", md: "lua", highlight: shiki("lua") },
  { id: "ruby", label: "Ruby", aliases: ["rb"], ext: ["rb"], comment: "#", vscodeId: "ruby", md: "ruby", highlight: shiki("ruby") },
  { id: "r", label: "R", aliases: [], ext: ["r"], comment: "#", vscodeId: "r", md: "r", highlight: shiki("r") },
  { id: "perl", label: "Perl", aliases: ["pl"], ext: ["pl", "pm"], comment: "#", vscodeId: "perl", md: "perl", highlight: shiki("perl") },
  { id: "haskell", label: "Haskell", aliases: ["hs"], ext: ["hs"], comment: "--", vscodeId: "haskell", md: "haskell", highlight: shiki("haskell") },
  { id: "diff", label: "Diff", aliases: ["patch"], ext: ["diff", "patch"], comment: "#", vscodeId: "diff", md: "diff", highlight: shiki("diff") },
  { id: "css", label: "CSS", aliases: [], ext: ["css"], comment: "//", vscodeId: "css", md: "css", highlight: shiki("css") },
  { id: "html", label: "HTML", aliases: ["xml", "svg"], ext: ["html", "htm"], comment: "//", vscodeId: "html", md: "html", highlight: shiki("html") },
  { id: "plaintext", label: "Plain Text", aliases: ["text", "txt"], ext: ["txt"], comment: "#", vscodeId: "plaintext", md: "" },
];

const byName = new Map<string, LangInfo>();
const byExt = new Map<string, LangInfo>();
for (const l of LANG_TABLE) {
  for (const n of [l.id, ...l.aliases]) byName.set(n, l);
  for (const e of l.ext) if (!byExt.has(e)) byExt.set(e, l);
}

export const langInfo = (name: string | null | undefined): LangInfo | undefined => (name ? byName.get(name.toLowerCase()) : undefined);
export const langOfExt = (file: string): LangInfo | undefined => byExt.get(/\.([^./\\]+)$/.exec(file)?.[1].toLowerCase() ?? "");
export const LANGS: readonly LangInfo[] = LANG_TABLE.filter((l) => l.pick);
export const langLabel = (name: string) => langInfo(name)?.label ?? name;
export const langId = (name: string) => langInfo(name)?.id ?? name;
export const grammarOf = (lang: string): Grammar | null => langInfo(lang)?.grammar ?? null;
export const grammarOfFile = (file: string): Grammar | null => langOfExt(file)?.grammar ?? null;
/** 有语法的语言的扩展名（只这一个语法的，或全部）：建名字索引、找工作区代码的文件 */
export const codeExts = (g?: Grammar): string[] => LANG_TABLE.filter((l) => l.grammar && (!g || l.grammar === g)).flatMap((l) => l.ext);

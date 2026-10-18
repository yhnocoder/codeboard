// 语言表：全应用（白板、宿主）认语言只看这一张。id 是段的 lang（VS Code languageId；Triton、TileLang 单独一个 id，
// 在 VS Code 里还是 python），aliases 是 Markdown 围栏、用户输入里的别名。

export type LangInfo = {
  /** 段的 lang，也是 Markdown 围栏里的正式名字 */
  id: string;
  /** 显示的名字（卡头、语言下拉、按语言分组） */
  label: string;
  /** 在代码卡的语言下拉里 */
  pick?: boolean;
  /** 别名（围栏里写的 py、cu、sh…；不分大小写） */
  aliases: string[];
  /** 文件扩展名（不带点）；第一个是新建文件（语言服务的虚拟文档）用的 */
  ext: string[];
  /** 行注释 */
  comment: string;
  /** VS Code 的 languageId */
  vscodeId: string;
  /** 导出 Markdown 时围栏写的名字（GitHub 认的）；空串 = 不写 */
  md: string;
  /** 着色用的 shiki 语法；没有就不着色 */
  shiki?: string;
  /** 有语言服务（补全、悬停、签名）；别的语言问了也是空，不白发 */
  lsp?: boolean;
  /** 关键字和内建类型名（悬停时不查定义） */
  keywords?: ReadonlySet<string>;
};

const words = (s: string): ReadonlySet<string> => new Set(s.split(" "));
const PY_KW = words("def return for in if else elif while and or not is None True False class break continue del import from as with lambda yield assert pass raise try except finally global nonlocal async await self cls int str float bool list dict tuple set");
const C_KW = words("return for if else while do break continue switch case default goto sizeof typedef struct union enum class template typename namespace using public private protected virtual static const constexpr auto void int char bool float double long short unsigned signed inline extern volatile new delete this nullptr true false");
const py = { comment: "#", vscodeId: "python", md: "python", shiki: "python", lsp: true, keywords: PY_KW };
const cpp = { comment: "//", shiki: "cpp", lsp: true, keywords: C_KW };

export const LANG_TABLE: readonly LangInfo[] = [
  { id: "python", label: "Python", pick: true, aliases: ["py", "python3"], ext: ["py", "pyi"], ...py },
  { id: "triton", label: "Triton", pick: true, aliases: [], ext: [], ...py },
  { id: "tilelang", label: "TileLang", pick: true, aliases: [], ext: [], ...py },
  { id: "cuda-cpp", label: "CUDA", pick: true, aliases: ["cuda", "cu"], ext: ["cu", "cuh"], vscodeId: "cuda-cpp", md: "cuda", ...cpp },
  { id: "cpp", label: "C++", pick: true, aliases: ["c++", "cc", "cxx", "hpp", "objective-cpp"], ext: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "h", "inl"], vscodeId: "cpp", md: "cpp", ...cpp },
  { id: "c", label: "C", aliases: [], ext: ["c"], vscodeId: "c", md: "c", ...cpp, shiki: "c" },
  { id: "rust", label: "Rust", aliases: ["rs"], ext: ["rs"], comment: "//", vscodeId: "rust", md: "rust", shiki: "rust", lsp: true },
  { id: "typescript", label: "TypeScript", aliases: ["ts", "tsx"], ext: ["ts", "tsx"], comment: "//", vscodeId: "typescript", md: "typescript", shiki: "typescript", lsp: true },
  { id: "javascript", label: "JavaScript", aliases: ["js", "jsx", "mjs", "cjs"], ext: ["js", "jsx", "mjs", "cjs"], comment: "//", vscodeId: "javascript", md: "javascript", shiki: "javascript", lsp: true },
  { id: "go", label: "Go", aliases: ["golang"], ext: ["go"], comment: "//", vscodeId: "go", md: "go", shiki: "go", lsp: true },
  { id: "java", label: "Java", aliases: [], ext: ["java"], comment: "//", vscodeId: "java", md: "java", shiki: "java", lsp: true },
  { id: "shellscript", label: "Shell", aliases: ["bash", "sh", "zsh", "shell", "console"], ext: ["sh", "bash", "zsh"], comment: "#", vscodeId: "shellscript", md: "bash", shiki: "shellscript" },
  { id: "json", label: "JSON", aliases: ["jsonc"], ext: ["json"], comment: "//", vscodeId: "json", md: "json", shiki: "json" },
  { id: "yaml", label: "YAML", aliases: ["yml"], ext: ["yaml", "yml"], comment: "#", vscodeId: "yaml", md: "yaml", shiki: "yaml" },
  { id: "toml", label: "TOML", aliases: [], ext: ["toml"], comment: "#", vscodeId: "toml", md: "toml", shiki: "toml" },
  { id: "ini", label: "INI", aliases: ["cfg"], ext: ["ini", "cfg"], comment: ";", vscodeId: "ini", md: "ini", shiki: "ini" },
  { id: "sql", label: "SQL", aliases: [], ext: ["sql"], comment: "--", vscodeId: "sql", md: "sql", shiki: "sql" },
  { id: "lua", label: "Lua", aliases: [], ext: ["lua"], comment: "--", vscodeId: "lua", md: "lua", shiki: "lua" },
  { id: "ruby", label: "Ruby", aliases: ["rb"], ext: ["rb"], comment: "#", vscodeId: "ruby", md: "ruby", shiki: "ruby" },
  { id: "r", label: "R", aliases: [], ext: ["r"], comment: "#", vscodeId: "r", md: "r", shiki: "r" },
  { id: "perl", label: "Perl", aliases: ["pl"], ext: ["pl", "pm"], comment: "#", vscodeId: "perl", md: "perl", shiki: "perl" },
  { id: "haskell", label: "Haskell", aliases: ["hs"], ext: ["hs"], comment: "--", vscodeId: "haskell", md: "haskell", shiki: "haskell" },
  { id: "diff", label: "Diff", aliases: ["patch"], ext: ["diff", "patch"], comment: "#", vscodeId: "diff", md: "diff", shiki: "diff" },
  { id: "css", label: "CSS", aliases: [], ext: ["css"], comment: "//", vscodeId: "css", md: "css", shiki: "css" },
  { id: "html", label: "HTML", aliases: ["xml", "svg"], ext: ["html", "htm"], comment: "//", vscodeId: "html", md: "html", shiki: "html" },
  { id: "plaintext", label: "Plain Text", aliases: ["text", "txt"], ext: ["txt"], comment: "#", vscodeId: "plaintext", md: "" },
];

const byName = new Map<string, LangInfo>();
const byExt = new Map<string, LangInfo>();
for (const l of LANG_TABLE) {
  for (const n of [l.id, ...l.aliases]) byName.set(n, l);
  for (const e of l.ext) if (!byExt.has(e)) byExt.set(e, l);
}

/** 名字（id 或别名，不分大小写）→ 语言；不认识的给 undefined */
export const langInfo = (name: string | null | undefined): LangInfo | undefined => (name ? byName.get(name.toLowerCase()) : undefined);
/** 文件路径 → 语言（按扩展名） */
export const langOfExt = (file: string): LangInfo | undefined => byExt.get(/\.([^./\\]+)$/.exec(file)?.[1].toLowerCase() ?? "");
/** 代码卡语言下拉里的语言 */
export const LANGS: readonly LangInfo[] = LANG_TABLE.filter((l) => l.pick);
/** 显示的名字（不认识的照原样） */
export const langLabel = (name: string) => langInfo(name)?.label ?? name;
/** 名字 → 正式 id（不认识的照原样） */
export const langId = (name: string) => langInfo(name)?.id ?? name;

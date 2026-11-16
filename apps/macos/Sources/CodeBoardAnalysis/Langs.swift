import Foundation

// The language table, as packages/analysis/src/langs.ts has it: the whole app tells languages apart by it alone. `id` is
// a segment's lang (the VS Code languageId; Triton and TileLang have ids of their own and are Python in VS Code),
// `aliases` the other names a Markdown fence or the user may write.

/// The tree-sitter grammar a language is analysed with; only languages with one get symbols and calls
public enum Grammar: String, Hashable, Codable, Sendable, CaseIterable {
  case python, cpp, rust
}

/// Which highlighter colours a language: shiki with its grammar name, or tree-sitter with the grammar's highlight query
public enum Highlight: Hashable, Sendable {
  case shiki(String)
  case treeSitter
}

public struct LangInfo: Hashable, Sendable {
  /// A segment's lang, also the formal name in a Markdown fence
  public let id: String
  public let label: String
  /// In the code card's language menu
  public let pick: Bool
  /// Other names (fences' py, cu, sh…), matched without case
  public let aliases: [String]
  /// File extensions without the dot; the first is the one a new file (a language service's virtual document) gets
  public let ext: [String]
  public let comment: String
  public let vscodeId: String
  /// The fence name a Markdown export writes (one GitHub knows); empty writes none
  public let md: String
  public let highlight: Highlight?
  /// Has a language service (completion, hover, signatures); other languages are not asked
  public let lsp: Bool
  /// Keywords and built-in type names (hover does not look up their definition)
  public let keywords: Set<String>?
  /// When Peek finds no definition, the likely reasons it names (which extension serves the language)
  public let noDef: String?
  public let grammar: Grammar?
}

private func words(_ s: String) -> Set<String> { Set(s.components(separatedBy: " ")) }

private let pyKeywords = words(
  "def return for in if else elif while and or not is None True False class break continue del import from as with"
    + " lambda yield assert pass raise try except finally global nonlocal async await self cls int str float bool"
    + " list dict tuple set")
private let cKeywords = words(
  "return for if else while do break continue switch case default goto sizeof typedef struct union enum class template"
    + " typename namespace using public private protected virtual static const constexpr auto void int char bool float"
    + " double long short unsigned signed inline extern volatile new delete this nullptr true false")
// C++'s and CUDA's qualifiers: __global__ and the like are no names, a language service finds no definition for them
private let cppKeywords = words(
  "noexcept override final mutable explicit friend operator static_cast dynamic_cast reinterpret_cast const_cast"
    + " decltype throw try catch concept requires co_await co_return co_yield thread_local alignas alignof"
    + " static_assert register restrict export __restrict __restrict__ __inline__ __forceinline__ __noinline__"
    + " __attribute__ __global__ __device__ __host__ __shared__ __constant__ __managed__ __grid_constant__"
    + " __launch_bounds__")
private let rustKeywords = words(
  "as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return"
    + " self Self static struct super trait true type unsafe use where while async await dyn i8 i16 i32 i64 i128 isize"
    + " u8 u16 u32 u64 u128 usize f32 f64 bool char str")

private func python(_ id: String, _ label: String, aliases: [String], ext: [String]) -> LangInfo {
  LangInfo(
    id: id, label: label, pick: true, aliases: aliases, ext: ext, comment: "#", vscodeId: "python", md: "python",
    highlight: .shiki("python"), lsp: true, keywords: pyKeywords,
    noDef: "setattr, dispatch by string, or no Python extension", grammar: .python)
}

private func cpp(
  _ id: String, _ label: String, aliases: [String], ext: [String], vscodeId: String, md: String
) -> LangInfo {
  LangInfo(
    id: id, label: label, pick: true, aliases: aliases, ext: ext, comment: "//", vscodeId: vscodeId, md: md,
    highlight: .treeSitter, lsp: true, keywords: cKeywords.union(cppKeywords),
    noDef: "a macro, a header it cannot find, or no C/C++ extension: clangd or ms-vscode.cpptools", grammar: .cpp)
}

private func plain(
  _ id: String, _ label: String, pick: Bool = false, aliases: [String] = [], ext: [String], comment: String,
  md: String? = nil, shiki: String? = nil, lsp: Bool = false
) -> LangInfo {
  LangInfo(
    id: id, label: label, pick: pick, aliases: aliases, ext: ext, comment: comment, vscodeId: id, md: md ?? id,
    highlight: shiki.map { .shiki($0) }, lsp: lsp, keywords: nil, noDef: nil, grammar: nil)
}

public let langTable: [LangInfo] = [
  python("python", "Python", aliases: ["py", "python3"], ext: ["py", "pyi"]),
  python("triton", "Triton", aliases: [], ext: []),
  python("tilelang", "TileLang", aliases: [], ext: []),
  cpp("cuda-cpp", "CUDA", aliases: ["cuda", "cu"], ext: ["cu", "cuh"], vscodeId: "cuda-cpp", md: "cuda"),
  cpp(
    "cpp", "C++", aliases: ["c++", "cc", "cxx", "hpp", "objective-cpp"],
    ext: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "h", "inl", "mm"], vscodeId: "cpp", md: "cpp"),
  cpp("c", "C", aliases: ["objective-c"], ext: ["c"], vscodeId: "c", md: "c"),
  LangInfo(
    id: "rust", label: "Rust", pick: true, aliases: ["rs"], ext: ["rs"], comment: "//", vscodeId: "rust", md: "rust",
    highlight: .shiki("rust"), lsp: true, keywords: rustKeywords, noDef: "a macro, or no rust-analyzer",
    grammar: .rust),
  plain(
    "typescript", "TypeScript", pick: true, aliases: ["ts", "tsx"], ext: ["ts", "tsx"], comment: "//",
    shiki: "typescript", lsp: true),
  plain(
    "javascript", "JavaScript", pick: true, aliases: ["js", "jsx", "mjs", "cjs"], ext: ["js", "jsx", "mjs", "cjs"],
    comment: "//", shiki: "javascript", lsp: true),
  plain("go", "Go", pick: true, aliases: ["golang"], ext: ["go"], comment: "//", shiki: "go", lsp: true),
  plain("java", "Java", ext: ["java"], comment: "//", shiki: "java", lsp: true),
  plain(
    "shellscript", "Shell", pick: true, aliases: ["bash", "sh", "zsh", "shell", "console"], ext: ["sh", "bash", "zsh"],
    comment: "#", md: "bash", shiki: "shellscript"),
  plain("json", "JSON", aliases: ["jsonc"], ext: ["json"], comment: "//", shiki: "json"),
  plain("yaml", "YAML", aliases: ["yml"], ext: ["yaml", "yml"], comment: "#", shiki: "yaml"),
  plain("toml", "TOML", ext: ["toml"], comment: "#", shiki: "toml"),
  plain("ini", "INI", aliases: ["cfg"], ext: ["ini", "cfg"], comment: ";", shiki: "ini"),
  plain("sql", "SQL", ext: ["sql"], comment: "--", shiki: "sql"),
  plain("lua", "Lua", ext: ["lua"], comment: "--", shiki: "lua"),
  plain("ruby", "Ruby", aliases: ["rb"], ext: ["rb"], comment: "#", shiki: "ruby"),
  plain("r", "R", ext: ["r"], comment: "#", shiki: "r"),
  plain("perl", "Perl", aliases: ["pl"], ext: ["pl", "pm"], comment: "#", shiki: "perl"),
  plain("haskell", "Haskell", aliases: ["hs"], ext: ["hs"], comment: "--", shiki: "haskell"),
  plain("diff", "Diff", aliases: ["patch"], ext: ["diff", "patch"], comment: "#", shiki: "diff"),
  plain("css", "CSS", ext: ["css"], comment: "//", shiki: "css"),
  plain("html", "HTML", aliases: ["xml", "svg"], ext: ["html", "htm"], comment: "//", shiki: "html"),
  plain("plaintext", "Plain Text", aliases: ["text", "txt"], ext: ["txt"], comment: "#", md: ""),
]

private let byName: [String: LangInfo] = {
  var out: [String: LangInfo] = [:]
  for l in langTable { for n in [l.id] + l.aliases { out[n] = l } }
  return out
}()

private let byExt: [String: LangInfo] = {
  var out: [String: LangInfo] = [:]
  for l in langTable { for e in l.ext where out[e] == nil { out[e] = l } }
  return out
}()

public func langInfo(_ name: String?) -> LangInfo? {
  guard let name, !name.isEmpty else { return nil }
  return byName[name.lowercased()]
}

/// The language of a file by its extension: what follows the last dot, when no dot or path separator follows it
public func langOfExt(_ file: String) -> LangInfo? {
  let units = Array(file.utf16)
  var i = units.count
  while i > 0, ![unit("."), unit("/"), unit("\\")].contains(units[i - 1]) { i -= 1 }
  guard i > 0, i < units.count, units[i - 1] == unit(".") else { return nil }
  return byExt[String(decoding: units[i...], as: UTF16.self).lowercased()]
}

/// The languages of the code card's menu
public let langs: [LangInfo] = langTable.filter(\.pick)
public func langLabel(_ name: String) -> String { langInfo(name)?.label ?? name }
public func langId(_ name: String) -> String { langInfo(name)?.id ?? name }
public func grammarOf(_ lang: String) -> Grammar? { langInfo(lang)?.grammar }
public func grammarOfFile(_ file: String) -> Grammar? { langOfExt(file)?.grammar }

/// The editor's language ids of every language the analysis reads (the editor shows board marks on their files)
public func analyzedEditorLangs() -> [String] {
  var seen = Set<String>()
  return langTable.filter { $0.grammar != nil }.map(\.vscodeId).filter { seen.insert($0).inserted }
}

/// The extensions of the languages with a grammar (of the one grammar, or of all): the name index and the search for a
/// workspace's code read these files
public func codeExts(_ g: Grammar? = nil) -> [String] {
  langTable.filter { $0.grammar != nil && (g == nil || $0.grammar == g) }.flatMap(\.ext)
}

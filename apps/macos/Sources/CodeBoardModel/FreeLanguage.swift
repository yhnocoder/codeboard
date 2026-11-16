import Foundation

/// The language Free code's text looks like, as the web board guesses it (core paste.ts guessLang, then pythonDialect
/// for Python: commands/code.ts freeLang): nil when it does not look like code. Lines are scored for the families' marks
/// (braces and semicolons, Python's heads and colons, shell commands, CUDA's), then a brace family's line for each
/// language's own (std::, fn, func, =>, : number…). Checked against core's answers (FreeLanguageTests)
public enum FreeLanguage {
  public static func guess(_ text: String) -> String? {
    guard let g = classify(text) else { return nil }
    return g == "python" ? dialect(text) : g
  }

  /// A Python text's finer dialect (pythonDialect)
  static func dialect(_ t: String) -> String {
    if has(#"import\s+triton|@triton\.jit|\btl\.(load|store|program_id|arange)"#, t) { return "triton" }
    if has(#"import\s+tilelang|\bT\.(Kernel|Tensor|alloc_|copy|gemm)"#, t) { return "tilelang" }
    return "python"
  }

  private static func classify(_ text: String) -> String? {
    let lines = text.components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
      .filter { !$0.trimmingCharacters(in: jsSpace).isEmpty }
    guard !lines.isEmpty else { return nil }
    var py = 0.0
    var c = 0.0
    var cu = 0.0
    var sh = 0.0
    var fam: [String: Double] = ["cpp": 0, "c": 0, "javascript": 0, "typescript": 0, "rust": 0, "go": 0]
    for l in lines {
      let s = l.trimmingCharacters(in: jsSpace)
      let braced = has(#"[;{}]\s*(//.*)?$"#, s)
      let pyHead = has(
        #"^(def|class|import|from|return|if|elif|for|while|with|async|await|yield|raise|try|except|@)\b"#, s)
      if (pyHead && !braced) || has(#":\s*(#.*)?$"#, s) { py += 1 }
      if has(#"\b(self|None|True|False|lambda|elif)\b"#, s) || (has(#"^\w+(\s*,\s*\w+)*\s*=\s*\S"#, s) && !braced) {
        py += 0.5
      }
      let cLike =
        braced || has(#"^#(include|define|pragma|if|endif)"#, s)
        || has(#"\b(std::|int|void|auto|const|template|struct|return)\b.*[;{]"#, s)
      let fam0 = fam.values.reduce(0, +)
      if has(#"__global__|__device__|__shared__|threadIdx|blockIdx|<<<|cudaMalloc|cudaMemcpy|__syncthreads"#, s) {
        cu += 2
      }
      if has(#"\b(tl|T)\.\w+\(|program_id|@triton\.jit|tilelang"#, s) { py += 1.5 }
      if !braced
        && (has(#"^(#!.*\b(ba|z)?sh\b|\$ \S)"#, s)
          || has(
            #"^(sudo|apt(-get)?|brew|pip3?|npm|npx|yarn|git|curl|wget|cd|ls|mkdir|rm|cp|mv|chmod|export|echo|source|conda|docker|make|nvcc)\s+[\w./~$"'-]"#,
            s))
      {
        sh += 1
      }
      if has(#"^(fi|done|esac)$|(^|;\s*)(then|do)$|\$\{\w+\}|\$\w+"#, s) && !braced { sh += 0.5 }
      if has(
        #"std::|\btemplate\s*<|\bnamespace\b|\bclass\s+\w+\s*(:\s*public|\{|$)|\b(cout|cin|nullptr|constexpr|typename)\b|^(public|private|protected):|#include\s*<(iostream|vector|string|memory|map|unordered_map|algorithm|utility|functional|thread)>|\bauto\s+\w+\s*=|\w::\w+\("#,
        s)
      {
        fam["cpp"]! += 1
      }
      if has(
        #"#include\s*<\w+\.h>|\b(printf|scanf|malloc|calloc|free|memcpy|memset|sizeof)\s*\(|\btypedef\s+struct\b|\bstruct\s+\w+\s*\*|^(static\s+)?(void|int|char|float|double|long|unsigned|size_t)\b[\w\s*]*\(|\b(int|float|double|char|unsigned|long)\s*\*?\s+\w+\s*[=;\[,)]"#,
        s)
      {
        fam["c"]! += 1
      }
      if has(
        #"\bfunction\b|=>|\b(let|var)\s+[\w$]+\s*=|\bconst\s+([\w$]+\s*=|[{\[])|console\.\w+\(|require\(|module\.exports|\bdocument\.|\bexport\s+(default|const|function|class)\b|^import\s.*\sfrom\s+['"]|===|!=="#,
        s)
      {
        fam["javascript"]! += 1
      }
      if has(
        #"\binterface\s+\w+|\btype\s+\w+(<[^>]*>)?\s*=|:\s*(string|number|boolean|any|unknown|never)\b|\bas\s+const\b|\breadonly\s+\w+|\)\s*:\s*\w+(<[^>]*>)?(\[\])?\s*(=>|\{)"#,
        s)
      {
        fam["typescript"]! += 1
      }
      if has(
        #"\bfn\s+\w+|\blet\s+mut\b|\bimpl\b|^(pub|mod|use)\s+[\w:{]|\w+!\(|&mut\b|::new\(|\b(Vec|Option|Result|Box)<|\b(Some|Ok|Err)\("#,
        s)
      {
        fam["rust"]! += 1
      }
      if has(
        #"^package\s+\w+$|\bfunc\s+(\([^)]*\)\s*)?\w+\(|:=|\bfmt\.\w+\(|\bgo\s+func\b|\bchan\b|\bdefer\b|^import\s+\("#,
        s)
      {
        fam["go"]! += 1
      }
      if cLike || fam.values.reduce(0, +) > fam0 { c += 1 }
    }
    let n = Double(lines.count)
    let best = max(py, c + cu, sh)
    if best < max(1, n * 0.4) {
      // one assignment or call is code too
      if n > 2 || !has(#"[=()\[\]]"#, text) || has("[一-鿿]", text) { return nil }
    }
    if sh > py && sh > c + cu { return "shellscript" }
    if cu > 0 { return "cuda-cpp" }
    if c <= py { return "python" }
    // TypeScript is JavaScript with types, C++ mostly C's: either's own mark counts the other's too
    let ranked: [(String, Double)] = [
      ("rust", fam["rust"]!), ("go", fam["go"]!),
      ("typescript", fam["typescript"]! > 0 ? fam["typescript"]! + fam["javascript"]! : 0),
      ("javascript", fam["javascript"]!), ("cpp", fam["cpp"]! > 0 ? fam["cpp"]! + fam["c"]! : 0), ("c", fam["c"]!),
    ]
    let top = ranked.dropFirst().reduce(ranked[0]) { $1.1 > $0.1 ? $1 : $0 }
    return top.1 > 0 ? top.0 : "cpp"
  }

  /// JavaScript's white space (trim, \s)
  private static let jsSpace = CharacterSet(
    charactersIn: "\t\n\u{0B}\u{0C}\r \u{A0}\u{1680}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
  )
  .union(CharacterSet(charactersIn: "\u{2000}"..."\u{200A}"))

  nonisolated(unsafe) private static var cache: [String: NSRegularExpression] = [:]
  private static let lock = NSLock()

  /// A JavaScript pattern matched as JavaScript does: \w and \b by ASCII word characters, \s by its white space
  private static func has(_ pattern: String, _ s: String) -> Bool {
    let re = lock.withLock {
      if let r = cache[pattern] { return r }
      let js =
        pattern
        .replacingOccurrences(
          of: #"\b"#, with: #"(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))"#
        )
        .replacingOccurrences(of: #"\w"#, with: "[A-Za-z0-9_]")
        .replacingOccurrences(
          of: #"\s"#,
          with: #"[\t\n\x{0B}\x{0C}\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]"#
        )
      let r = try! NSRegularExpression(pattern: js)
      cache[pattern] = r
      return r
    }
    return re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
  }
}

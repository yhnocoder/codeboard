import CodeBoardAnalysis
import Foundation

// The parts of packages/host/src/resolve.ts that need only the analysis, the name index and the files' texts: the
// symbol at a definition, the candidates by name, stubs and their code, the next hop of a peek.

/// How many files with classes classField looks through (CLASS_FILES)
let classFiles = 400

/// The line of a call and the text of the function it is in (CUDA's <<<>>> reads template arguments and constexprs)
struct CallerText: Hashable, Sendable {
  var lang: String
  var line: String
  var fnText: String
}

/// The next hop of a definition line: the expression assigned and the column of its last name
struct Follow: Hashable, Sendable {
  var expr: String
  var col: Int
}

extension CodeLookup {
  /// The function or class defined at d: on its line (of that name), else by qual, else any on its line, else the
  /// innermost of that name holding the line
  public func symAtDef(_ d: Def, name: String? = nil, qual: String? = nil) async -> Target? {
    guard let text = await readText(d.abs) else { return nil }
    let syms = analysis.analysisOf(langOf(d.abs), text).symbols
    let name = name.flatMap { $0.isEmpty ? nil : $0 }
    let qual = qual.flatMap { $0.isEmpty ? nil : $0 }
    let sym =
      syms.first { $0.defLine == d.line && (name == nil || $0.name == name) }
      ?? qual.flatMap { q in syms.first { $0.qual == q } }
      ?? syms.first { $0.defLine == d.line }
      ?? name.flatMap { n in symbolAt(syms.filter { $0.name == n }, line: d.line) }
    return sym.map { Target(abs: d.abs, sym: $0) }
  }

  /// Candidates by name in C++: only C / C++ / CUDA ones; for ns::f(…) those whose qual ends in ns::f; a plain call is
  /// no __global__ kernel (that takes <<<>>> or a launch). A filter that leaves none leaves them as they were
  func cppCands(_ ents: [IndexEntry], _ site: CallSite?) async -> [IndexEntry] {
    func keep(_ xs: [IndexEntry], _ f: (IndexEntry) async -> Bool) async -> [IndexEntry] {
      var k: [IndexEntry] = []
      for e in xs {
        if await f(e) { k.append(e) }
      }
      return k.isEmpty ? xs : k
    }
    var out = await keep(ents) { grammarOfFile($0.abs) == .cpp }
    if let recv = site?.recv, isScopedName(recv) {
      out = await keep(out) { hasUnitSuffix($0.qual, "\(recv)::\($0.name)") }
    }
    if site?.launch == nil {
      out = await keep(out) { e in
        guard let t = await readText(e.abs), !t.isEmpty else { return true }
        return !textContains(arraySlice(splitLines(t), e.start - 1, e.defLine).joined(separator: "\n"), "__global__")
      }
    }
    return out
  }

  /// The line of the call and the function's text
  func callerOf(_ lang: String, _ full: String, _ line: Int) -> CallerText {
    let lines = splitLines(full)
    let fn = symbolAt(analysis.analysisOf(lang, full).symbols.filter { $0.kind == .def }, line: line)
    return CallerText(
      lang: lang, line: line >= 1 && line <= lines.count ? lines[line - 1] : "",
      fnText: fn.map { arraySlice(lines, $0.start - 1, $0.end).joined(separator: "\n") } ?? "")
  }

  /// Where a .pyi stub's definition is in the .py beside it (a typeshed-style stub of Python code); nil for a stub of
  /// compiled code
  func stubImpl(_ d: Def, name: String? = nil) async -> Def? {
    let py = isStub(d) ? String(decoding: d.abs.utf16.dropLast(), as: UTF16.self) : d.abs
    guard let stub = await symAtDef(d, name: name), let text = await readText(py, track: false), !text.isEmpty,
      let sym = analysis.analysisOf("python", text).symbols.first(where: {
        $0.qual == stub.sym.qual && $0.kind == stub.sym.kind
      })
    else { return nil }
    let lines = splitLines(text)
    let col = sym.defLine >= 1 && sym.defLine <= lines.count ? unitIndex(lines[sym.defLine - 1], sym.name) : 0
    return Def(abs: py, line: sym.defLine, col: max(0, col))
  }

  /// Whether d is the kind of definition dispatchOf asks Go to Implementation for: a method of a Python class
  func mayDispatch(_ d: Def, _ name: String) async -> Bool {
    if langOf(d.abs) != "python" { return false }
    return overridable(await symAtDef(d, name: name), name)
  }

  /// A lookup by name that scans no workspace: the current file, then the files read lately whose analysis is kept
  func nearbyEntries(_ name: String, here: String? = nil) async -> [IndexEntry] {
    var out: [IndexEntry] = []
    var seen = Set<String>()
    for abs in (here.map { [$0] } ?? []) + recentFiles where seen.insert(abs).inserted {
      guard let text = await readText(abs) else { continue }
      let a =
        abs == here ? analysis.analysisOf(langOf(abs), text) : analysis.cachedAnalysis(langOf(abs), text)
      for s in a?.symbols ?? [] where s.name == name {
        out.append(
          IndexEntry(
            name: s.name, qual: s.qual, kind: s.kind, abs: abs, start: s.start, end: s.end, defLine: s.defLine,
            sig: s.sig))
      }
    }
    return out
  }

  /// x.field → a class body's field: … = … in the files with classes (the first classFiles of them)
  func classField(_ word: String) async -> Def? {
    guard isIdent(word) else { return nil }
    let re = JSRegex(#"^\s+"# + word + #"\s*(:[^=]*)?=(?!=)"#)
    var n = 0
    for file in await index.indexedFiles() {
      var text: String?
      var ents = file.entries ?? []
      if file.entries == nil {
        // not analysed yet: a text without the word need not be
        text = await readText(file.abs)
        guard let t = text, textContains(t, word) else { continue }
        ents = await index.entriesOf(file.abs)
      }
      if !ents.contains(where: { $0.kind == .class }) { continue }
      n += 1
      if n > classFiles { break }
      if text == nil { text = await readText(file.abs) }
      guard let t = text, textContains(t, word) else { continue }
      let lines = splitLines(t)
      let a = analysis.analysisOf(langOf(file.abs), t)
      for (i, l) in lines.enumerated() where re.test(l) && symbolAt(a.symbols, line: i + 1)?.kind == .class {
        return Def(abs: file.abs, line: i + 1, col: unitIndex(l, word))
      }
    }
    return nil
  }
}

/// An index entry as a symbol: no parameters (calleeOf finds them)
func toSym(_ e: IndexEntry) -> Sym {
  Sym(name: e.name, qual: e.qual, kind: e.kind, start: e.start, defLine: e.defLine, end: e.end, sig: e.sig, params: [])
}

/// The function called: a class's __init__; a symbol from the index has no parameters, so it is found by qual in syms
func calleeOf(_ sym: Sym, _ syms: [Sym]) -> Sym {
  if sym.kind == .class { return syms.first { $0.qual == "\(sym.qual).__init__" } ?? sym }
  if !sym.params.isEmpty { return sym }
  return syms.first { $0.qual == sym.qual && $0.start == sym.start } ?? syms.first { $0.qual == sym.qual } ?? sym
}

private let followRe = JSRegex(
  #"^\s*(?:self\.)?([\w.]+)\s*(?::[^=]+)?=\s*([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)+)\s*(?:#.*)?$"#)

/// self.x = config.max_num_batched_tokens → the next hop is the last name of config.max_num_batched_tokens
func followOf(_ line: String, _ word: String) -> Follow? {
  guard let m = followRe.exec(line), let target = m[1], let expr = m[2] else { return nil }
  if !word.isEmpty && !hasUnitSuffix(target, unitSplit(word, ".").last ?? "") { return nil }
  return Follow(expr: expr, col: unitLastIndex(line, expr) + unitLastIndex(expr, ".") + 1)
}

/// A module's name as shown: torch/multiprocessing/__init__.py → torch/multiprocessing
func modTitle(_ p: String) -> String {
  var t = p
  for s in ["/__init__.py", "/__init__.pyi"] where hasUnitSuffix(t, s) {
    t = String(decoding: t.utf16.dropLast(s.utf16.count), as: UTF16.self)
  }
  for s in [".py", ".pyi"] where hasUnitSuffix(t, s) {
    t = String(decoding: t.utf16.dropLast(s.utf16.count), as: UTF16.self)
  }
  return t
}

func isStub(_ d: Def) -> Bool { hasUnitSuffix(d.abs, ".pyi") }

/// The method called itself: a def in a class of the call's name. One of another name (x.foo landing on __getattr__)
/// has overrides that have nothing to do with the call
func overridable(_ b: Target?, _ name: String) -> Bool {
  guard let b, let parent = b.sym.parent, !parent.isEmpty else { return false }
  return b.sym.kind == .def && b.sym.name == name
}

/// /^[A-Za-z_][\w:]*$/
private func isScopedName(_ s: String) -> Bool {
  let letter = { (c: UInt8) in c == 95 || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) }
  guard let first = s.utf8.first, letter(first) else { return false }
  return s.utf8.allSatisfy { c in letter(c) || c == 58 || (c >= 48 && c <= 57) }
}

// JavaScript's string operations, by UTF-16 code unit

/// split(/\r?\n/)
func splitLines(_ t: String) -> [String] {
  let u = Array(t.utf16)
  var out: [String] = []
  var start = 0
  for i in u.indices where u[i] == 10 {
    out.append(String(decoding: u[start..<(i > start && u[i - 1] == 13 ? i - 1 : i)], as: UTF16.self))
    start = i + 1
  }
  out.append(String(decoding: u[start...], as: UTF16.self))
  return out
}

/// split(sep) on one code unit, empty parts kept
func unitSplit(_ s: String, _ sep: Character) -> [String] {
  let c = sep.utf16.first ?? 0
  return s.utf16.split(separator: c, omittingEmptySubsequences: false).map { String(decoding: $0, as: UTF16.self) }
}

func hasUnitSuffix(_ s: String, _ suffix: String) -> Bool { s.utf16.reversed().starts(with: suffix.utf16.reversed()) }

/// indexOf
func unitIndex(_ s: String, _ part: String) -> Int {
  let h = Array(s.utf16)
  let n = Array(part.utf16)
  if n.isEmpty { return 0 }
  if h.count < n.count { return -1 }
  for i in 0...(h.count - n.count) where h[i..<i + n.count].elementsEqual(n) { return i }
  return -1
}

/// lastIndexOf
func unitLastIndex(_ s: String, _ part: String) -> Int {
  let h = Array(s.utf16)
  let n = Array(part.utf16)
  if n.count > h.count { return -1 }
  for i in stride(from: h.count - n.count, through: 0, by: -1) where h[i..<i + n.count].elementsEqual(n) { return i }
  return -1
}

/// An array's slice(a, b): a negative offset counts from the end, both clamped
private func arraySlice<T>(_ xs: [T], _ a: Int, _ b: Int) -> ArraySlice<T> {
  let at = { (i: Int) in i < 0 ? max(0, xs.count + i) : min(i, xs.count) }
  return xs[at(a)..<max(at(a), at(b))]
}

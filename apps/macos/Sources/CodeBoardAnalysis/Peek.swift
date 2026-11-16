import Foundation

// The source part of a definition's peek, by what the definition is: a field → every field of its class; a function →
// its first lines; a module → no source. Without a language server's hover the signature and docs come from here too
// (docstrings turned into Markdown). As packages/analysis/src/peek.ts.

public enum PeekKind: String, Hashable, Codable, Sendable {
  case field, function, `class`, module, other
}

public struct PeekPlan: Hashable, Codable, Sendable {
  public var kind: PeekKind
  /// The lines to show (not always contiguous); empty for a module
  public var rows: [Int]
  /// A small title above the lines: class Config
  public var head: String?
  /// "⋯ N more lines"
  public var more: Int?
  /// The hover signature when there is no other: (function) def load_model(model, path)
  public var sig: String?
  /// The docs when there are no others (Markdown)
  public var doc: String?

  public init(
    kind: PeekKind, rows: [Int], head: String? = nil, more: Int? = nil, sig: String? = nil, doc: String? = nil
  ) {
    self.kind = kind
    self.rows = rows
    self.head = head
    self.more = more
    self.sig = sig
    self.doc = doc
  }
}

/// A function: how many lines to show after its signature
private let fnRows = 3
private let maxRows = 16

private func indentOf(_ l: String) -> Int { jsLength(l) - jsLength(jsTrimStart(l)) }

/// `x || undefined` for a count
private func nonZero(_ n: Int) -> Int? { n == 0 ? nil : n }

private let nonWordRe = JSRegex(#"[^\w]"#)

/// Whether a definition is a module: the start of a file, with a first line that does not have the name
public func isModuleDef(_ lines: [String], _ line: Int, _ col: Int, _ word: String) -> Bool {
  if line != 1 || col != 0 { return false }
  let w = word.jsSplit(".").last ?? ""
  let name = nonWordRe.replace(w, global: true, with: "")
  return !JSRegex(#"\b"# + name + #"\b"#).test(lines.first ?? "")
}

private let decoratorRe = JSRegex(#"^\s*@"#)
private let passRe = JSRegex(#"^\s*(pass|\.\.\.)\s*$"#)

/// The field lines written straight in a class body (not in a method, not a comment, docstring or decorator)
private func classFields(_ a: FileAnalysis, _ lines: [String], _ cls: Sym) -> [Int] {
  let depth = cls.qual.jsSplit(".").count
  let kids = a.symbols.filter {
    $0.parent == cls.qual
      || ($0.qual.jsStartsWith(cls.qual + ".") && $0.qual.jsSplit(".").count == depth + 1)
  }
  var base = -1
  var out: [Int] = []
  var l = cls.defLine + 1
  while l <= cls.end {
    defer { l += 1 }
    if let k = kids.first(where: { $0.start <= l && l <= $0.end }) {
      l = k.end
      continue
    }
    let t = lineText(lines, l)
    let flags = l - 1 < a.flags.count ? a.flags[l - 1] : 0
    if flags & (LineFlag.blank | LineFlag.comment | LineFlag.docstring) != 0 || jsTrim(t).isEmpty { continue }
    let ind = indentOf(t)
    if base < 0 { base = ind }
    if ind != base || decoratorRe.test(t) || passRe.test(t) { continue }
    // a field over several lines (packed_modules_mapping = { … }) is taken whole
    let e = stmtEnd(lines, l)
    for k in l...max(l, e) where !jsTrim(lineText(lines, k)).isEmpty { out.append(k) }
    l = e
  }
  return out
}

/// `lines[l - 1] ?? ""`
private func lineText(_ lines: [String], _ l: Int) -> String { l >= 1 && l <= lines.count ? lines[l - 1] : "" }

private let stringRe = JSRegex(#"(["'])(?:\\.|(?!\1).)*\1"#)
private let trailingCommentRe = JSRegex("#.*$")

/// The line the statement from line l ends on: unbalanced brackets and a \ at the end go on (at most 40 lines)
private func stmtEnd(_ lines: [String], _ l: Int) -> Int {
  var depth = 0
  var k = l
  while k <= min(lines.count, l + 40) {
    let t = trailingCommentRe.replace(stringRe.replace(lineText(lines, k), global: true, with: ""), with: "")
    for ch in t.utf16 {
      if ch == unit("(") || ch == unit("[") || ch == unit("{") {
        depth += 1
      } else if ch == unit(")") || ch == unit("]") || ch == unit("}") {
        depth -= 1
      }
    }
    if depth <= 0 && !continuedRe.test(t) { return k }
    k += 1
  }
  return l
}

private let continuedRe = JSRegex(#"\\\s*$"#)

private func around(_ rows: [Int], _ line: Int, _ n: Int = maxRows) -> [Int] {
  if rows.count <= n { return rows }
  let i = max(0, rows.firstIndex(of: line) ?? -1)
  let a = max(0, min(rows.count - n, i - (n >> 1)))
  return Array(rows[a..<(a + n)])
}

private func range(_ a: Int, _ b: Int) -> [Int] { b < a ? [] : Array(a...b) }

private let fieldCommentRe = JSRegex(#"\s*#.*$"#)
private let selfAssignRe = JSRegex(#"^\s*self\.\w+\s*(:[^=]*)?=(?!=)"#)
private let assignRe = JSRegex(#"^\s*\w[\w.]*\s*(:[^=]*)?="#)

/// How the source part of a peek at a definition on `line` is taken. `word` is the name looked up; `module` says the
/// definition is a module.
public func peekPlan(_ a: FileAnalysis, _ lines: [String], _ line: Int, word: String? = nil, module: Bool = false)
  -> PeekPlan
{
  let word = (word ?? "").jsSplit(".").last ?? ""
  if module {
    return PeekPlan(kind: .module, rows: [], sig: "(module) \(word)", doc: a.doc.flatMap(mdOf))
  }
  let sym = a.symbols.first { $0.defLine == line }
  if let sym, sym.kind == .def {
    var rows: [Int] = []
    var body = 0
    var l = sym.start
    while l <= sym.end && body < fnRows {
      defer { l += 1 }
      if (l - 1 < a.flags.count ? a.flags[l - 1] : 0) & LineFlag.docstring != 0 { continue }
      if jsTrim(lineText(lines, l)).isEmpty { continue }
      rows.append(l)
      if l > sym.defLine && sigDone(lines, sym, l) { body += 1 }
    }
    let last = rows.last ?? sym.end
    let parent = sym.parent.map { !$0.isEmpty } ?? false
    return PeekPlan(
      kind: .function, rows: rows, more: nonZero(sym.end - last), sig: "(\(parent ? "method" : "function")) \(sym.sig)",
      doc: sym.doc.flatMap(mdOf))
  }
  if let sym, sym.kind == .class {
    var rows = classFields(a, lines, sym)
    if rows.isEmpty { rows = a.symbols.filter { $0.parent == sym.qual }.map(\.defLine) }
    var seen = Set<Int>()
    let shown = around((range(sym.start, sym.defLine) + rows).filter { seen.insert($0).inserted }, line)
    return PeekPlan(
      kind: .class, rows: shown, more: nonZero(rows.count + (sym.defLine - sym.start + 1) - shown.count),
      sig: "(class) \(sym.sig)", doc: sym.doc.flatMap(mdOf))
  }
  let text = lineText(lines, line)
  let field = "(variable) " + fieldCommentRe.replace(jsTrim(text), with: "")
  let inner = symbolAt(a.symbols, line: line)
  // a field in a class body: every field of the class, this one highlighted
  if let inner, inner.kind == .class {
    let rows = classFields(a, lines, inner)
    if rows.contains(line) {
      let shown = around(rows, line)
      return PeekPlan(kind: .field, rows: shown, head: inner.sig, more: nonZero(rows.count - shown.count), sig: field)
    }
  }
  // self.x = … in __init__: every self.x assignment of that method
  if let inner, inner.kind == .def, selfAssignRe.test(text) {
    let rows = range(inner.defLine + 1, inner.end).filter {
      let t = lineText(lines, $0)
      return selfAssignRe.test(t) && indentOf(t) == indentOf(text)
    }
    let shown = around(rows, line)
    return PeekPlan(kind: .field, rows: shown, head: inner.qual, more: nonZero(rows.count - shown.count), sig: field)
  }
  // anything else (a module-level assignment…): the whole statement and a line on each side, cut when too long
  let se = stmtEnd(lines, line)
  let all = range(max(1, line - 1), min(lines.count, se + 1))
  let shown = Array(all.prefix(maxRows))
  return PeekPlan(
    kind: .other, rows: shown, more: nonZero(all.count - shown.count), sig: assignRe.test(text) ? field : nil)
}

/// `doc ? docToMd(doc) : undefined`
private func mdOf(_ doc: String) -> String? { doc.isEmpty ? nil : docToMd(doc) }

private let sigLineEndRe = JSRegex(#":\s*(#.*)?$"#)

/// A signature over several lines: from the def line to the line its colon ends are not the body
private func sigDone(_ lines: [String], _ sym: Sym, _ l: Int) -> Bool {
  var k = sym.defLine
  while k < l {
    if sigLineEndRe.test(lineText(lines, k)) { return true }
    k += 1
  }
  return false
}

private let roleRe = JSRegex(#":[\w:]+:`~?([^`]+)`"#)
private let doubleTickRe = JSRegex(#"``([^`]+)``"#)
private let exampleRe = JSRegex(#"^\s*(>>>|\.\.\.)\s?"#)
private let itemRe = JSRegex(#"^\s*([-*]|\d+[.)])\s"#)
private let headRe = JSRegex(#":\s*$"#)
private let underlineRe = JSRegex(#"^[-=~]{3,}$"#)
private let blankRunRe = JSRegex(#"\n{3,}"#)

/// A docstring → Markdown: reST's :mod:`x` / ``x`` become inline code, a paragraph's wrapped lines are joined into one,
/// indented lines (the parameters under Args:, code examples) stay one per line, >>> examples go into a code block
public func docToMd(_ doc: String) -> String {
  let src = doubleTickRe.replace(roleRe.replace(doc, global: true, with: "`$1`"), global: true, with: "`$1`")
    .jsSplit("\n")
  var out: [String] = []
  var para = false
  var code = false
  for raw in src {
    let l = jsTrimEnd(raw)
    let ex = exampleRe.test(l)
    if ex != code {
      out.append("```")
      code = ex
      para = false
    }
    if code {
      out.append(jsTrim(l))
      continue
    }
    let trimmed = jsTrim(l)
    if trimmed.isEmpty {
      out.append("")
      para = false
      continue
    }
    let ind = indentOf(l) > 0
    let item = itemRe.test(l)
    let underline = underlineRe.test(trimmed)
    let head = headRe.test(l) || underline
    if underline && !out.isEmpty {
      let t = out.removeLast()
      out.append("**\(t)**")
      para = false
      continue
    }
    if para && !ind && !item && !head {
      out[out.count - 1] += " " + trimmed
    } else {
      out.append(item ? trimmed : ind ? "- \(trimmed)" : trimmed)
    }
    para = !ind && !item && !head
  }
  if code { out.append("```") }
  return jsTrim(blankRunRe.replace(out.joined(separator: "\n"), global: true, with: "\n\n"))
}

private let hoverCodeRe = JSRegex(#"^\s*```[\w-]*\n([\s\S]*?)\n```[ \t]*\n?"#)
private let ruleRe = JSRegex(#"^\s*(---|\*\*\*|___)[ \t]*(\n|$)"#)
private let nbspRe = JSRegex("&nbsp;")
private let fenceRe = JSRegex(#"(```[\s\S]*?```)"#)
private let escapedRe = JSRegex(#"\\([\\`*_{}[\]()#+\-.!|<>])"#)

/// A VS Code hover's Markdown → the signature (its first code block) and the docs; the escapes Pylance adds (to _ and
/// the like) are taken out
public func splitHover(_ md: String) -> (sig: String?, doc: String?) {
  var sig: String?
  var rest = md
  if let m = hoverCodeRe.exec(md) {
    sig = jsTrim(m[1] ?? "")
    rest = JSText(md).slice(m.end)
  }
  rest = nbspRe.replace(ruleRe.replace(rest, with: ""), global: true, with: " ")
  // no unescaping inside code blocks
  rest = jsTrim(
    fenceRe.split(rest).enumerated().map { i, p in
      let p = p ?? ""
      return i % 2 == 1 ? p : escapedRe.replace(p, global: true, with: "$1")
    }.joined())
  return (sig.flatMap { $0.isEmpty ? nil : $0 }, rest.isEmpty ? nil : rest)
}

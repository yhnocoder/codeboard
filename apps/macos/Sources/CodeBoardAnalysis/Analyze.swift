import Foundation
import TreeSitterCore

// Code structure by tree-sitter, as packages/analysis/src/index.ts has it: symbols, calls, loops, comment, docstring and
// blank lines. Syntax alone, no language service (the host asks the editor for definitions). Python, Triton and
// TileLang read with the Python grammar, C, C++ and CUDA with tree-sitter-cuda, Rust with Rust's.

public struct AnalyzeOptions {
  /// Where the syntax tree is kept: the next text under the same key is parsed incrementally, the same text not again
  public var tree: TreeAt?
  /// Only these lines (1-based, both ends included): calls, comment and docstring flags and trailing comments only for
  /// them, symbols only those that meet them; imports, main blocks, the module docstring and blank flags still of the
  /// whole file. The result equals `clipAnalysis` of the whole file's.
  public var lines: LineSpan?

  public init(tree: TreeAt? = nil, lines: LineSpan? = nil) {
    self.tree = tree
    self.lines = lines
  }
}

/// The analysis of a file (or a piece of code). A language without a grammar gets only its blank lines.
public func analyze(_ lang: String, _ text: String, _ o: AnalyzeOptions = AnalyzeOptions()) -> FileAnalysis {
  let units = Array(text.utf16)
  let lines = units[...].lines()
  var out = FileAnalysis(lang: lang, flags: lines.map { $0.isBlank ? LineFlag.blank : 0 })
  guard let g = grammarOf(lang) else { return out }
  let tree = treeOf(g, units, o.tree)
  let r = o.lines
  let cx = Context(
    units: units, lines: lines, out: out, r0: r.map { $0.start - 1 } ?? 0, r1: r.map { $0.end - 1 } ?? Int.max)
  let root = tree.root
  switch g {
  case .python: cx.out.doc = docstring(cx, root)
  case .rust: rustSymbols(cx, root)
  case .cpp: cppSymbols(cx, root)
  }
  let q = Queries.of(g)
  if let r {
    // Structure (definitions, imports) is looked for in the whole file, calls, loops and comments in these lines only
    if let structure = q.structure { run(g, cx, sorted(structure.captures(under: root))) }
    if r.start <= r.end { run(g, cx, sorted(q.flow.captures(under: root, rows: cx.r0..<(cx.r1 + 1)))) }
  } else {
    run(g, cx, sorted(q.all.captures(under: root)))
  }
  out = cx.out
  out.symbols = stableSorted(out.symbols) { a, b in a.start != b.start ? a.start < b.start : a.end > b.end }
  return r.map { clipAnalysis(out, start: $0.start, end: $0.end) } ?? out
}

/// The whole file's analysis clipped to some lines, as `analyze` with `lines` gives it
public func clipAnalysis(_ a: FileAnalysis, start: Int, end: Int) -> FileAnalysis {
  let inRange = { (l: Int) in l >= start && l <= end }
  var out = a
  out.symbols = a.symbols.filter { $0.start <= end && $0.end >= start }
  out.calls = a.calls.filter { inRange($0.line) }
  out.flags = a.flags.enumerated().map { i, f in inRange(i + 1) ? f : f & LineFlag.blank }
  out.trailing = a.trailing.filter { inRange($0.key) }
  return out
}

func stableSorted<T>(_ xs: [T], by less: (T, T) -> Bool) -> [T] {
  xs.enumerated().sorted { a, b in less(a.element, b.element) || (!less(b.element, a.element) && a.offset < b.offset) }
    .map(\.element)
}

// One query per grammar, run once over the tree for every node the analysis needs (definitions, calls, loops,
// comments, imports), handled in source order: definitions and loops / functions each keep a stack, whose top holds
// the node at hand.

private let structQueries: [Grammar: String] = [
  .python: """
  (function_definition) @def
  (class_definition) @def
  (import_statement) @import
  (import_from_statement) @import
  (if_statement condition: (_) @main (#match? @main "__main__"))

  """
  // C++'s and Rust's definitions are only looked for at the top, in namespaces and in classes: cppSymbols, rustSymbols
]

private let flowQueries: [Grammar: String] = [
  .python: """
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
  """,
  .cpp: """
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
  """,
  .rust: """
  (function_item) @fn
  (closure_expression) @fn
  (for_expression body: (_) @loop)
  (while_expression) @loop
  (loop_expression) @loop
  (let_declaration value: (_) @rhs)
  (assignment_expression right: (_) @rhs)
  (call_expression) @call
  (line_comment) @comment
  (block_comment) @comment
  """,
]

private struct Queries: Sendable {
  let all: Query
  let structure: Query?
  let flow: Query

  static let python = Queries(.python)
  static let cpp = Queries(.cpp)
  static let rust = Queries(.rust)

  static func of(_ g: Grammar) -> Queries {
    switch g {
    case .python: python
    case .cpp: cpp
    case .rust: rust
    }
  }

  private init(_ g: Grammar) {
    let s = structQueries[g]
    let f = flowQueries[g] ?? ""
    all = Query(g, (s ?? "") + f)
    structure = s.map { Query(g, $0) }
    flow = Query(g, f)
  }
}

// Of nodes with the same span the outer is handled first. Loops come before functions (a for whose body is one lambda
// has the lambda's span, and the lambda is inside), both before calls
private func rank(_ name: String) -> Int {
  switch name {
  case "loop", "rhs": 0
  case "fn", "def": 1
  default: 2
  }
}

private struct Cap {
  let name: String
  let node: Node
  let s: Int
  let e: Int
  let rank: Int
}

private func sorted(_ caps: [QueryCapture]) -> [Cap] {
  stableSorted(
    caps.map { Cap(name: $0.name, node: $0.node, s: $0.node.startIndex, e: $0.node.endIndex, rank: rank($0.name)) }
  ) {
    a, b in
    a.s != b.s ? a.s < b.s : a.e != b.e ? a.e > b.e : a.rank < b.rank
  }
}

/// The source and the result being made; r0...r1 are the lines wanted (0-based, both included)
final class Context {
  let units: [UInt16]
  let lines: [Units]
  var out: FileAnalysis
  let r0: Int
  let r1: Int

  init(units: [UInt16], lines: [Units], out: FileAnalysis, r0: Int, r1: Int) {
    self.units = units
    self.lines = lines
    self.out = out
    self.r0 = r0
    self.r1 = r1
  }

  func text(_ s: Int, _ e: Int) -> Units { jsSlice(units, s, e) }
  func meets(_ n: Node) -> Bool { n.startRow <= r1 && n.endRow >= r0 }
}

/// A definition around the node at hand. visited: it and the definitions around it were all reached, and it lies in the
/// body of the one around it; bs, be: its body's span
struct DefFrame {
  var e: Int
  var visited: Bool
  var scope: [String]
  var qual: String
  var isClass: Bool
  var bs: Int
  var be: Int
}

private func run(_ g: Grammar, _ cx: Context, _ caps: [Cap]) {
  var defs: [DefFrame] = []
  var flow: [(e: Int, loop: Bool)] = []
  var rhs: [Int] = []
  var cmt: [Node] = []
  for c in caps {
    while let d = defs.last, d.e <= c.s { defs.removeLast() }
    while let f = flow.last, f.e <= c.s { flow.removeLast() }
    while let r = rhs.last, r <= c.s { rhs.removeLast() }
    switch c.name {
    case "def": defs.append(pyDef(cx, c.node, defs.last))
    // Module level only (inside an if or try too)
    case "import": if defs.isEmpty { pyImport(c.node, &cx.out) }
    case "main":
      if let n = c.node.parent, defs.isEmpty, isMainTest(c.node.text.units) {
        cx.out.mainBlocks.append(LineSpan(start: n.startRow + 1, end: n.endRow + 1))
      }
    case "fn": flow.append((c.e, false))
    case "loop": flow.append((c.e, true))
    // The right side of an assignment: only a call inside one can have its return value taken
    case "rhs": rhs.append(c.e)
    case "call":
      let loop = flow.last?.loop ?? false
      switch g {
      case .python: pyCall(cx, c.node, loop, !rhs.isEmpty)
      case .rust: rustCall(cx, c.node, loop, !rhs.isEmpty)
      case .cpp: cppCall(cx, c.node, loop, !rhs.isEmpty)
      }
    case "comment": cmt.append(c.node)
    default: preconditionFailure("unknown capture @\(c.name)")
    }
  }
  comments(cmt, cx)
}

/// `/__name__\s*==\s*["']__main__["']/.test(s)`
private func isMainTest(_ s: Units) -> Bool {
  let name = Array("__name__".utf16)
  let main = Array("__main__".utf16)
  var i = s.startIndex
  while i + name.count <= s.endIndex {
    defer { i += 1 }
    guard s[i..<i + name.count].elementsEqual(name) else { continue }
    var k = i + name.count
    while k < s.endIndex && isJSSpace(s[k]) { k += 1 }
    guard k + 1 < s.endIndex, s[k] == unit("="), s[k + 1] == unit("=") else { continue }
    k += 2
    while k < s.endIndex && isJSSpace(s[k]) { k += 1 }
    guard k < s.endIndex, isQuote(s[k]) else { continue }
    k += 1
    guard k + main.count < s.endIndex, s[k..<k + main.count].elementsEqual(main), isQuote(s[k + main.count]) else {
      continue
    }
    return true
  }
  return false
}

func isQuote(_ u: UInt16) -> Bool { u == unit("\"") || u == unit("'") }

func walk(_ n: Node, _ fn: (Node) -> Bool) {
  guard fn(n) else { return }
  for c in n.namedChildren { walk(c, fn) }
}

/// Comments: a line that is all comment gets the comment flag, a comment at a line's end its column
private func comments(_ nodes: [Node], _ cx: Context) {
  for n in nodes {
    let aRow = n.startRow
    let bRow = n.endRow
    var r = max(aRow, cx.r0)
    while r <= bRow && r <= cx.r1 {
      defer { r += 1 }
      let line = r < cx.lines.count ? cx.lines[r] : Units()
      let s = r == aRow ? n.startColumn : 0
      let e = r == bRow ? n.endColumn : line.count
      let before = !jsSlice(line, 0, s).isBlank
      let after = !jsSlice(line, e).isBlank
      if !before && !after {
        cx.out.flags[r] |= LineFlag.comment
      } else if before && r == aRow && cx.out.trailing[r + 1] == nil {
        cx.out.trailing[r + 1] = s
      }
    }
  }
}

private let pyPassThrough: Set<String> = [
  "attribute", "call", "conditional_expression", "parenthesized_expression", "await", "subscript",
]
private let cppPassThrough: Set<String> = [
  "field_expression", "call_expression", "conditional_expression", "parenthesized_expression",
]

/// Who takes the return value: up through .tolist(), x if c else y, await and parentheses to an assignment, whose left
/// side's names are returned
func assignedTo(_ n: Node, _ g: Grammar) -> [String]? {
  var cur = n
  var parent = n.parent
  let passThrough = g == .python ? pyPassThrough : cppPassThrough
  while let p = parent, passThrough.contains(p.type) {
    cur = p
    parent = p.parent
  }
  guard let p = parent else { return nil }
  if g == .python && (p.type == "assignment" || p.type == "augmented_assignment") && cur == p.field("right") {
    guard let left = p.field("left") else { return nil }
    var names: [String] = []
    walk(left) { x in
      guard x.type == "identifier" || x.type == "attribute" || x.type == "subscript" else { return true }
      names.append(x.text)
      return false
    }
    return names.isEmpty ? nil : names
  }
  if g == .cpp {
    if p.type == "init_declarator" && cur == p.field("value") {
      return p.field("declarator").map { [string($0.text.units.drop { isPointerMark($0) })] }
    }
    if p.type == "assignment_expression" && cur == p.field("right") {
      return p.field("left").map { [$0.text] }
    }
  }
  return nil
}

/// `[*&\s]`
private func isPointerMark(_ u: UInt16) -> Bool { u == unit("*") || u == unit("&") || isJSSpace(u) }

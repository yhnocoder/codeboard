import Foundation
import TreeSitter

/// The colour classes of code: one per code colour of the board's themes (the `--k-*` variables of
/// packages/board/src/styles.css and themes.css), named after the board's CSS classes in the comments.
public enum TokenClass: UInt8, Sendable, Hashable, CaseIterable {
  /// `kw`, `--k-kw`. Also C / C++ / CUDA operators and built-in types, as on the VS Code board.
  case keyword
  /// `kw op`: `--k-kw` on a code card, `--nc-op` in a Note's code block.
  case `operator`
  /// `fn`, `--k-fn`: function names, and type names.
  case function
  /// `str`, `--k-str`
  case string
  /// `com`, `--k-com`. Also Python docstrings.
  case comment
  /// `num`, `--k-num`: numbers and constants, and Python decorators (the board's `dec`, drawn in this colour).
  case number
  /// `self`, `--k-self`: self, cls, this.
  case receiver
  /// `p`, `--k-p`
  case punctuation
}

public struct Token: Sendable, Hashable {
  /// UTF-16 columns within the line
  public var columns: Range<Int>
  public var kind: TokenClass

  public init(columns: Range<Int>, kind: TokenClass) {
    self.columns = columns
    self.kind = kind
  }
}

/// Highlights code segments with tree-sitter. Make one and share it: it holds the compiled queries, and every call
/// parses on its own, so calls may run at the same time on any tasks.
public struct Highlighter: Sendable {
  private let python = Query(.python, pythonQuery)
  private let rust = Query(.rust, rustQuery)
  private let cuda = Query(.cuda, cudaQuery)

  public init() {}

  /// The coloured tokens of each line; text between them is plain. `lines` are all of a segment's lines, hidden ones
  /// included: a hidden range can open or close a string. An unknown language gives no tokens.
  public func tokens(lines: [String], language: String) -> [[Token]] {
    guard let grammar = Grammar(language: language) else { return lines.map { _ in [] } }
    let slice = Slice(lines, dedent: grammar == .python)
    guard let (tree, text, offset) = bestParse(grammar, slice.text) else { return lines.map { _ in [] } }
    return color(slice, lines.indices, tree, text, offset, grammar)
  }

  func query(_ grammar: Grammar) -> Query {
    switch grammar {
    case .python: python
    case .rust: rust
    case .cuda: cuda
    }
  }

  /// The tokens of the slice's lines `wanted`, from the parse of `text` (the slice's text from `offset` on): only what
  /// can colour them is looked at
  fileprivate func color(
    _ slice: Slice, _ wanted: Range<Int>, _ tree: Tree, _ text: [UInt16], _ offset: Int, _ grammar: Grammar
  ) -> [[Token]] {
    guard let first = wanted.first.map({ slice.lines[$0] }), let last = wanted.last.map({ slice.lines[$0] }) else {
      return []
    }
    var spans: [Span] = []
    let from = max(0, offset + first.start - 1)
    collect(
      query(grammar), grammar, tree.root, text, at: 0, into: &spans,
      bytes: from..<(offset + last.start + last.count))
    let classes = paint(spans, count: text.count, in: from..<(offset + last.start + last.count))
    return slice.lines[wanted].map { line in
      let start = offset + line.start
      let indent = line.cut > 0 && start > 0 ? classes[start - 1] : nil
      return runs(Array(repeating: indent, count: line.cut) + classes[start..<start + line.count])
    }
  }

  /// A segment is usually cut from the middle of a file, and parsed alone it may start inside a multi-line string or
  /// comment. When the plain parse has errors, try the slice after each opening of one, and keep the parse that places
  /// the most text. Other errors (a slice of statements from a function body) need nothing: the query still colours
  /// the tokens inside ERROR nodes, as the tests check against whole files.
  private func bestParse(_ grammar: Grammar, _ body: [UInt16]) -> (Tree, [UInt16], Int)? {
    Highlighter.best(grammar, body) { text, _ in Tree(grammar, text) }
  }

  /// The plain parse when it has no errors, else the one of it and the parses after each opening that places the most
  /// text; `parse` gives the parse of a text (and the opening's index, -1 for none)
  fileprivate static func best(
    _ grammar: Grammar, _ body: [UInt16], parse: ([UInt16], Int) -> Tree?
  ) -> (Tree, [UInt16], Int)? {
    guard let plain = parse(body, -1) else { return nil }
    guard ts_node_has_error(plain.root) else { return (plain, body, 0) }
    var best = (plain, body, 0)
    var cost = plain.errorCost
    for (k, opening) in openings(grammar).enumerated() {
      let text = Array(opening.utf16) + [newline] + body
      guard let tree = parse(text, k) else { continue }
      let c = tree.errorCost
      if c < cost { (best, cost) = ((tree, text, opening.utf16.count + 1), c) }
    }
    return best
  }

  fileprivate static func openings(_ grammar: Grammar) -> [String] {
    switch grammar {
    case .python: ["\"\"\"", "'''"]
    case .cuda, .rust: ["/*"]
    }
  }
}

/// Highlights one text as it is written: each call parses again only what changed since the one before (tree-sitter's
/// incremental parsing, every parse `Highlighter.tokens` tries kept and edited), and colours only the lines asked
/// for, with the same tokens `Highlighter.tokens` gives them. Calls take turns
public final class HighlightSession: @unchecked Sendable {
  private let highlighter: Highlighter
  private let lock = NSLock()
  private let parser: OpaquePointer = ts_parser_new()!
  private var grammar: Grammar?
  private var body: [UInt16] = []
  /// By opening (-1: none), parsed for `body`
  private var trees: [Int: Tree] = [:]

  public init(_ highlighter: Highlighter) { self.highlighter = highlighter }

  deinit { ts_parser_delete(parser) }

  /// The tokens of `lines[wanted]`
  public func tokens(lines: [String], language: String, wanted: Range<Int>) -> [[Token]] {
    lock.withLock {
      let wanted = wanted.clamped(to: lines.indices)
      guard let g = Grammar(language: language), ts_parser_set_language(parser, g.language) else {
        return wanted.map { _ in [] }
      }
      let slice = Slice(lines, dedent: g == .python)
      if g != grammar {
        (grammar, body, trees) = (g, [], [:])
      } else {
        edit(from: body, to: slice.text)
      }
      body = slice.text
      var kept: [Int: Tree] = [:]
      let best = Highlighter.best(g, slice.text) { text, k in
        let t = Tree(parser, text, old: trees[k])
        kept[k] = t
        return t
      }
      trees = kept
      guard let (tree, text, offset) = best else { return wanted.map { _ in [] } }
      return highlighter.color(slice, wanted, tree, text, offset, g)
    }
  }

  /// Every kept parse edited from the old text to the new: what lies between their common start and end
  private func edit(from a: [UInt16], to b: [UInt16]) {
    var p = 0
    while p < a.count, p < b.count, a[p] == b[p] { p += 1 }
    var q = 0
    while q < a.count - p, q < b.count - p, a[a.count - 1 - q] == b[b.count - 1 - q] { q += 1 }
    if p == a.count && p == b.count { return }
    func point(_ units: [UInt16], _ end: Int, shift: Int) -> TSPoint {
      var row: UInt32 = shift > 0 ? 1 : 0
      var lineStart = 0
      for i in 0..<end where units[i] == newline {
        row += 1
        lineStart = i + 1
      }
      return TSPoint(row: row, column: UInt32((end - lineStart) * 2))
    }
    for (k, tree) in trees {
      let shift = k < 0 ? 0 : Highlighter.openings(grammar!)[k].utf16.count + 1
      var e = TSInputEdit(
        start_byte: UInt32((shift + p) * 2), old_end_byte: UInt32((shift + a.count - q) * 2),
        new_end_byte: UInt32((shift + b.count - q) * 2), start_point: point(b, p, shift: shift),
        old_end_point: point(a, a.count - q, shift: shift), new_end_point: point(b, b.count - q, shift: shift))
      ts_tree_edit(tree.raw, &e)
    }
  }
}

private let newline = unit("\n")
private func unit(_ c: Unicode.Scalar) -> UInt16 { UInt16(c.value) }

/// The lines as one UTF-16 text, joined by newlines, with the indent they all share taken off for Python (whose
/// grammar reads an indented first line as an error).
private struct Slice {
  struct Line {
    /// Where the line starts in `text`, how long it is there, and how many leading code units were taken off
    var start: Int, count: Int, cut: Int
  }
  var text: [UInt16] = []
  var lines: [Line] = []

  init(_ source: [String], dedent: Bool) {
    let units = source.map { Array($0.utf16) }
    let blank = { (u: [UInt16]) in u.allSatisfy(isSpace) }
    var common: ArraySlice<UInt16>?
    if dedent {
      for u in units where !blank(u) {
        let ws = u.prefix(while: isSpace)
        common = common.map { $0.prefix(zip($0, ws).prefix { $0 == $1 }.count) } ?? ws
      }
    }
    let shared = common?.count ?? 0
    for (i, u) in units.enumerated() {
      if i > 0 { text.append(newline) }
      let cut = min(shared, u.prefix(while: isSpace).count)
      lines.append(Line(start: text.count, count: u.count - cut, cut: cut))
      text += u[cut...]
    }
  }
}

private func isSpace(_ u: UInt16) -> Bool { u == unit(" ") || u == unit("\t") }

private struct Span {
  var range: Range<Int>
  var kind: TokenClass?
  var pattern: Int
  /// Painted after all others: a construct that is one colour whatever is inside
  var whole = false
}

/// The query's spans over the tree of `text`, which starts at `base` in the text being painted.
private func collect(
  _ query: Query, _ grammar: Grammar, _ root: TSNode, _ text: [UInt16], at base: Int, into spans: inout [Span],
  bytes: Range<Int>? = nil
) {
  let cursor = ts_query_cursor_new()
  defer { ts_query_cursor_delete(cursor) }
  if let bytes { ts_query_cursor_set_byte_range(cursor, UInt32(bytes.lowerBound * 2), UInt32(bytes.upperBound * 2)) }
  ts_query_cursor_exec(cursor, query.raw, root)
  var match = TSQueryMatch()
  let string = { (n: TSNode) in String(decoding: text[n.range], as: UTF16.self) }
  while ts_query_cursor_next_match(cursor, &match) {
    let captures = UnsafeBufferPointer(start: match.captures, count: Int(match.capture_count))
    let pattern = Int(match.pattern_index)
    guard query.holds(pattern, captures, string) else { continue }
    for capture in captures {
      let node = capture.node
      let range = node.range
      func add(_ r: Range<Int>, _ kind: TokenClass?, whole: Bool = false) {
        if !r.isEmpty {
          spans.append(
            Span(range: base + r.lowerBound..<base + r.upperBound, kind: kind, pattern: pattern, whole: whole))
        }
      }
      switch query.actions[Int(capture.index)] {
      case .paint(let kind): add(range, kind)
      case .callee: if let name = calleeName(node) { add(name.range, .function) }
      case .macro:
        let parent = ts_node_parent(node).type
        let body = Array(text[range])
        guard parent == "preproc_def" || parent == "preproc_function_def", !string(node).allSatisfy(\.isWhitespace),
          let tree = Tree(grammar, body)
        else { break }
        collect(query, grammar, tree.root, body, at: base + range.lowerBound, into: &spans)
      case .stringPrefix:
        let letters = text[range].prefix { $0 != unit("\"") && $0 != unit("'") }.count
        add(range.lowerBound..<range.lowerBound + letters, .keyword)
      case .placeholders:
        let prefix = string(ts_node_child(ts_node_parent(node), 0)).lowercased()
        guard !prefix.contains("f"), !prefix.contains("r") else { break }
        let s = string(node)
        for re in prefix.contains("b") ? [percentPlaceholder] : [percentPlaceholder, bracePlaceholder] {
          for m in re.matches(in: s, range: NSRange(location: 0, length: s.utf16.count)) {
            add(range.lowerBound + m.range.location..<range.lowerBound + m.range.location + m.range.length, .number)
          }
        }
      case .docstring: add(range, .comment, whole: true)
      case .decorator:
        let expression = ts_node_named_child(node, 0)
        let end = expression.type == "call" ? expression.field("function").range.upperBound : range.upperBound
        add(range.lowerBound..<end, .number, whole: true)
      }
    }
  }
}

// MagicPython's placeholders (string-formatting, string-brace-formatting), which the VS Code board colours as constants
private let percentPlaceholder = regex(#"%(\([\w\s]*\))?[- #+0]*(\d+|\*)?(\.(\d+|\*))?[Lhl]?[%EFGXa-giorsux]"#)
private let bracePlaceholder = regex(
  #"\{\{|\}\}|\{\w*(\.[_[:alpha:]]\w*|\[[^\]"']+\])*(![ars])?(:\w?[<=>^]?[- +]?#?\d*,?(\.\d+)?[%EFGXb-gnosx]?)?\}"#)

/// Outer spans first, inner ones over them, equal lengths in pattern order; the last paint of a code unit wins.
private func paint(_ spans: [Span], count: Int, in range: Range<Int>) -> [TokenClass?] {
  var classes = [TokenClass?](repeating: nil, count: count)
  let spans = spans.filter { $0.range.overlaps(range) }
  let ordered = spans.sorted { a, b in
    if a.whole != b.whole { return b.whole }
    if a.range.count != b.range.count { return a.range.count > b.range.count }
    return a.pattern < b.pattern
  }
  for span in ordered {
    for i in span.range.clamped(to: range.clamped(to: 0..<count)) { classes[i] = span.kind }
  }
  return classes
}

private func runs(_ classes: [TokenClass?]) -> [Token] {
  var tokens: [Token] = []
  for (col, kind) in classes.enumerated() {
    guard let kind else { continue }
    if let last = tokens.last, last.kind == kind, last.columns.upperBound == col {
      tokens[tokens.count - 1].columns = last.columns.lowerBound..<col + 1
    } else {
      tokens.append(Token(columns: col..<col + 1, kind: kind))
    }
  }
  return tokens
}

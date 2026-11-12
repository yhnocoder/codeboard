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
    let query =
      switch grammar {
      case .python: python
      case .rust: rust
      case .cuda: cuda
      }
    let slice = Slice(lines, dedent: grammar == .python)
    guard let (tree, text, offset) = bestParse(grammar, slice.text) else { return lines.map { _ in [] } }
    var spans: [Span] = []
    collect(query, grammar, tree.root, text, at: 0, into: &spans)
    let classes = paint(spans, count: text.count)
    return slice.lines.map { line in
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
    guard let plain = Tree(grammar, body) else { return nil }
    guard ts_node_has_error(plain.root) else { return (plain, body, 0) }
    var best = (plain, body, 0)
    var cost = plain.errorCost
    let openings =
      switch grammar {
      case .python: ["\"\"\"", "'''"]
      case .cuda, .rust: ["/*"]
      }
    for opening in openings {
      let text = Array(opening.utf16) + [newline] + body
      guard let tree = Tree(grammar, text) else { continue }
      let c = tree.errorCost
      if c < cost { (best, cost) = ((tree, text, opening.utf16.count + 1), c) }
    }
    return best
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
  _ query: Query, _ grammar: Grammar, _ root: TSNode, _ text: [UInt16], at base: Int, into spans: inout [Span]
) {
  let cursor = ts_query_cursor_new()
  defer { ts_query_cursor_delete(cursor) }
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
private func paint(_ spans: [Span], count: Int) -> [TokenClass?] {
  var classes = [TokenClass?](repeating: nil, count: count)
  let ordered = spans.sorted { a, b in
    if a.whole != b.whole { return b.whole }
    if a.range.count != b.range.count { return a.range.count > b.range.count }
    return a.pattern < b.pattern
  }
  for span in ordered {
    for i in span.range.clamped(to: 0..<count) { classes[i] = span.kind }
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

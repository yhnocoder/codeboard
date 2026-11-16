import Foundation
import TreeSitter
import TreeSitterCUDA
import TreeSitterPython
import TreeSitterRust

// tree-sitter for the analysis, as packages/analysis/src/tree.ts has it. Texts are parsed as UTF-16, so that every
// index and column is a UTF-16 code unit, as JavaScript's strings count them. A TreeCache keeps the last tree of each
// key (usually a file path): when the text changed it is edited and parsed incrementally, when it did not it is reused.

extension Grammar {
  /// C, C++ and CUDA all read with tree-sitter-cuda: C++ with <<<>>>, __global__ and the like, under C++'s node names
  var language: OpaquePointer {
    switch self {
    case .python: tree_sitter_python()
    case .cpp: tree_sitter_cuda()
    case .rust: tree_sitter_rust()
    }
  }
}

/// A parsed text and the code units it was parsed from
final class SyntaxTree {
  let raw: OpaquePointer
  let units: [UInt16]

  init(_ g: Grammar, _ units: [UInt16], old: SyntaxTree? = nil) {
    // A parser is not safe to share between threads, and making one costs little next to a parse
    let parser = ts_parser_new()
    defer { ts_parser_delete(parser) }
    guard ts_parser_set_language(parser, g.language) else {
      preconditionFailure("the \(g) grammar does not fit this tree-sitter")
    }
    let empty: [UInt16] = [0]
    let tree = (units.isEmpty ? empty : units).withUnsafeBytes { bytes in
      ts_parser_parse_string_encoding(
        parser, old?.raw, bytes.baseAddress?.assumingMemoryBound(to: CChar.self), UInt32(units.count * 2),
        TSInputEncodingUTF16LE)
    }
    guard let tree else { preconditionFailure("tree-sitter gave no tree") }
    raw = tree
    self.units = units
  }

  deinit { ts_tree_delete(raw) }

  var root: Node { Node(ts_tree_root_node(raw), units) }

  func edit(_ e: TreeEdit) {
    func point(_ p: TreeEdit.Point) -> TSPoint { TSPoint(row: UInt32(p.row), column: UInt32(p.column * 2)) }
    var input = TSInputEdit(
      start_byte: UInt32(e.startIndex * 2), old_end_byte: UInt32(e.oldEndIndex * 2),
      new_end_byte: UInt32(e.newEndIndex * 2), start_point: point(e.startPosition),
      old_end_point: point(e.oldEndPosition), new_end_point: point(e.newEndPosition))
    ts_tree_edit(raw, &input)
  }
}

/// A syntax node of a tree that lives as long as the analysis that reads it; indexes and columns in UTF-16 code units
struct Node {
  let raw: TSNode
  let units: [UInt16]

  init(_ raw: TSNode, _ units: [UInt16]) {
    self.raw = raw
    self.units = units
  }

  private func wrap(_ n: TSNode) -> Node? { ts_node_is_null(n) ? nil : Node(n, units) }

  var type: String { String(cString: ts_node_type(raw)) }
  var startIndex: Int { Int(ts_node_start_byte(raw)) / 2 }
  var endIndex: Int { Int(ts_node_end_byte(raw)) / 2 }
  var startRow: Int { Int(ts_node_start_point(raw).row) }
  var startColumn: Int { Int(ts_node_start_point(raw).column) / 2 }
  var endRow: Int { Int(ts_node_end_point(raw).row) }
  var endColumn: Int { Int(ts_node_end_point(raw).column) / 2 }
  var text: String { String(decoding: units[startIndex..<endIndex], as: UTF16.self) }

  var parent: Node? { wrap(ts_node_parent(raw)) }
  var namedChildCount: Int { Int(ts_node_named_child_count(raw)) }
  var firstNamedChild: Node? { namedChildCount > 0 ? wrap(ts_node_named_child(raw, 0)) : nil }
  var lastNamedChild: Node? { namedChildCount > 0 ? wrap(ts_node_named_child(raw, UInt32(namedChildCount - 1))) : nil }
  var nextNamedSibling: Node? { wrap(ts_node_next_named_sibling(raw)) }

  func field(_ name: String) -> Node? { wrap(ts_node_child_by_field_name(raw, name, UInt32(name.utf8.count))) }

  /// Every child under the field, named or not
  func fields(_ name: String) -> [Node] {
    let id = ts_language_field_id_for_name(ts_node_language(raw), name, UInt32(name.utf8.count))
    guard id != 0 else { return [] }
    return children { ts_tree_cursor_current_field_id(&$0) == id }
  }

  var namedChildren: [Node] { children { ts_node_is_named(ts_tree_cursor_current_node(&$0)) } }

  // By a cursor: ts_node_named_child(i) walks from the first child each time
  private func children(where keep: (inout TSTreeCursor) -> Bool) -> [Node] {
    var cursor = ts_tree_cursor_new(raw)
    defer { ts_tree_cursor_delete(&cursor) }
    var out: [Node] = []
    guard ts_tree_cursor_goto_first_child(&cursor) else { return out }
    repeat {
      if keep(&cursor) { out.append(Node(ts_tree_cursor_current_node(&cursor), units)) }
    } while ts_tree_cursor_goto_next_sibling(&cursor)
    return out
  }

  func same(_ other: Node?) -> Bool { other.map { ts_node_eq(raw, $0.raw) } ?? false }
}

/// A compiled query, its capture names and its `#match?` predicates. Never changed after it is made, and tree-sitter
/// lets threads share a TSQuery: what a search changes lives in the TSQueryCursor each search makes for itself.
final class Query: @unchecked Sendable {
  let raw: OpaquePointer
  /// By capture id
  let names: [String]
  /// By pattern index: capture id → the pattern its text must match
  let matches: [[(UInt32, NSRegularExpression)]]

  init(_ g: Grammar, _ source: String) {
    var offset: UInt32 = 0
    var error = TSQueryErrorNone
    guard let raw = ts_query_new(g.language, source, UInt32(source.utf8.count), &offset, &error) else {
      preconditionFailure("query for \(g): error \(error.rawValue) at \(offset)")
    }
    self.raw = raw
    func string(_ id: UInt32, _ get: (OpaquePointer, UInt32, UnsafeMutablePointer<UInt32>) -> UnsafePointer<CChar>?)
      -> String
    {
      var length: UInt32 = 0
      return get(raw, id, &length).map { String(cString: $0) } ?? ""
    }
    names = (0..<ts_query_capture_count(raw)).map { string($0, ts_query_capture_name_for_id) }
    matches = (0..<ts_query_pattern_count(raw)).map { pattern in
      var count: UInt32 = 0
      let steps = UnsafeBufferPointer(start: ts_query_predicates_for_pattern(raw, pattern, &count), count: Int(count))
      return steps.split { $0.type == TSQueryPredicateStepTypeDone }.map { p in
        let name = string(p[p.startIndex].value_id, ts_query_string_value_for_id)
        let args = Array(p.dropFirst())
        guard name == "match?", args.count == 2, args[0].type == TSQueryPredicateStepTypeCapture,
          args[1].type == TSQueryPredicateStepTypeString
        else { preconditionFailure("unsupported predicate #\(name)") }
        let pattern = string(args[1].value_id, ts_query_string_value_for_id)
        // The analysis's queries match plain words, which read the same in ICU's regular expressions as in
        // JavaScript's
        guard let re = try? NSRegularExpression(pattern: pattern) else { preconditionFailure("bad pattern \(pattern)") }
        return (args[0].value_id, re)
      }
    }
  }

  deinit { ts_query_delete(raw) }

  /// The captures under node in the order tree-sitter gives them, of the matches that meet their predicates; rows
  /// limits them to the nodes that meet those rows (start inclusive, end exclusive)
  func captures(_ node: Node, rows: Range<Int>? = nil) -> [(name: String, node: Node)] {
    let cursor = ts_query_cursor_new()
    defer { ts_query_cursor_delete(cursor) }
    if let rows {
      // Rows out of range wrap as the TypeScript side's 32-bit marshalling wraps them, instead of trapping
      ts_query_cursor_set_point_range(
        cursor, TSPoint(row: UInt32(truncatingIfNeeded: rows.lowerBound), column: 0),
        TSPoint(row: UInt32(truncatingIfNeeded: rows.upperBound), column: 0))
    }
    ts_query_cursor_exec(cursor, raw, node.raw)
    var match = TSQueryMatch()
    var index: UInt32 = 0
    var out: [(name: String, node: Node)] = []
    while ts_query_cursor_next_capture(cursor, &match, &index) {
      let caps = UnsafeBufferPointer(start: match.captures, count: Int(match.capture_count))
      let holds = matches[Int(match.pattern_index)].allSatisfy { id, re in
        caps.allSatisfy { c in
          guard c.index == id else { return true }
          let s = Node(c.node, node.units).text
          return re.firstMatch(in: s, range: NSRange(location: 0, length: s.utf16.count)) != nil
        }
      }
      if holds { out.append((names[Int(caps[Int(index)].index)], Node(caps[Int(index)].node, node.units))) }
    }
    return out
  }
}

/// A tree-sitter edit: the span that changed, in UTF-16 code units, rows and columns 0-based
public struct TreeEdit: Hashable, Sendable {
  public struct Point: Hashable, Sendable {
    public var row: Int
    public var column: Int

    public init(row: Int, column: Int) {
      self.row = row
      self.column = column
    }
  }

  public var startIndex: Int
  public var oldEndIndex: Int
  public var newEndIndex: Int
  public var startPosition: Point
  public var oldEndPosition: Point
  public var newEndPosition: Point

  public init(
    startIndex: Int, oldEndIndex: Int, newEndIndex: Int, startPosition: Point, oldEndPosition: Point,
    newEndPosition: Point
  ) {
    self.startIndex = startIndex
    self.oldEndIndex = oldEndIndex
    self.newEndIndex = newEndIndex
    self.startPosition = startPosition
    self.oldEndPosition = oldEndPosition
    self.newEndPosition = newEndPosition
  }
}

/// The difference of two texts as one tree-sitter edit: what lies between their common prefix and suffix
public func diffEdit(_ a: String, _ b: String) -> TreeEdit { diffEdit(Array(a.utf16), Array(b.utf16)) }

func diffEdit(_ a: [UInt16], _ b: [UInt16]) -> TreeEdit {
  let n = min(a.count, b.count)
  var s = 0
  while s < n && a[s] == b[s] { s += 1 }
  var e = 0
  while e < n - s && a[a.count - 1 - e] == b[b.count - 1 - e] { e += 1 }
  // Never between the halves of a surrogate pair
  if s > 0 && UTF16.isLeadSurrogate(a[s - 1]) { s -= 1 }
  if e > 0 && UTF16.isTrailSurrogate(a[a.count - e]) { e -= 1 }
  return TreeEdit(
    startIndex: s, oldEndIndex: a.count - e, newEndIndex: b.count - e, startPosition: point(a, s),
    oldEndPosition: point(a, a.count - e), newEndPosition: point(b, b.count - e))
}

private func point(_ t: [UInt16], _ i: Int) -> TreeEdit.Point {
  var row = 0
  var lineStart = 0
  for k in 0..<i where t[k] == 0x0A {
    row += 1
    lineStart = k + 1
  }
  return TreeEdit.Point(row: row, column: i - lineStart)
}

/// Whether an edit can turn a into b (only the lengths and the parts it leaves alone are checked)
private func fits(_ a: [UInt16], _ b: [UInt16], _ e: TreeEdit) -> Bool {
  0 <= e.startIndex && e.startIndex <= e.oldEndIndex && e.oldEndIndex <= a.count && e.startIndex <= e.newEndIndex
    && e.newEndIndex <= b.count && a.count - e.oldEndIndex == b.count - e.newEndIndex
    && a[..<e.startIndex] == b[..<e.startIndex] && a[e.oldEndIndex...] == b[e.newEndIndex...]
}

/// The trees kept between parses of the same key (usually a file path), least recently used first out. Keyed by path,
/// not by content, so each host keeps its own: one host's files must not evict or forget another's.
public final class TreeCache {
  private struct Entry {
    let g: Grammar
    let tree: SyntaxTree
  }

  /// How many trees to keep (each takes a few times the source's memory)
  public let max: Int
  private var trees: [String: Entry] = [:]
  /// Least recently used first
  private var order: [String] = []

  public init(max: Int = 16) { self.max = max }

  /// The tree of a text, kept under key: parsed incrementally when the key's last text differs (by edit, or by the
  /// common prefix and suffix when edit is missing or does not fit)
  func tree(_ g: Grammar, _ units: [UInt16], key: String, edit: TreeEdit?) -> SyntaxTree {
    let tree: SyntaxTree
    if let old = trees[key] {
      remove(key)
      if old.g == g && old.tree.units == units {
        tree = old.tree
      } else if old.g == g {
        old.tree.edit(edit.flatMap { fits(old.tree.units, units, $0) ? $0 : nil } ?? diffEdit(old.tree.units, units))
        tree = SyntaxTree(g, units, old: old.tree)
      } else {
        tree = SyntaxTree(g, units)
      }
    } else {
      tree = SyntaxTree(g, units)
    }
    trees[key] = Entry(g: g, tree: tree)
    order.append(key)
    while order.count > max { remove(order[0]) }
    return tree
  }

  /// Let go of key's tree, or of all of them
  public func forget(_ key: String? = nil) {
    for k in order where key == nil || k == key { remove(k) }
  }

  /// The keys kept, least recently used first
  public var keys: [String] { order }

  private func remove(_ key: String) {
    trees[key] = nil
    order.removeAll { $0 == key }
  }
}

/// Where a parse keeps its tree: the cache, the key, and optionally the edit from the key's last text to this one
public struct TreeAt {
  public var cache: TreeCache
  public var key: String
  public var edit: TreeEdit?

  public init(cache: TreeCache, key: String, edit: TreeEdit? = nil) {
    self.cache = cache
    self.key = key
    self.edit = edit
  }
}

/// The tree of a text: kept in at's cache, or, without one, parsed for this call alone
func treeOf(_ g: Grammar, _ units: [UInt16], _ at: TreeAt?) -> SyntaxTree {
  guard let at, at.cache.max > 0 else { return SyntaxTree(g, units) }
  return at.cache.tree(g, units, key: at.key, edit: at.edit)
}

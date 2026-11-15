import Foundation
import TreeSitter
import TreeSitterCUDA
import TreeSitterPython
import TreeSitterRust

/// A tree-sitter grammar and its highlight query, for the languages it is named by. The highlight query's captures are
/// the colour classes (`kw`, `op`, `fn`, `str`, `com`, `num`, `self`, `p`), `plain`, and the steps the highlighter does
/// in code (`callee`, `macro`, `prefix`, `fmt`, `doc`, `dec`; see `Query.Action`); its predicates `#any-of?` and
/// `#match?`. Python, Rust and C, C++ and CUDA come built in; a host adds others with `Highlighter(grammars:)`.
public struct Grammar: @unchecked Sendable {
  /// The language names it colours
  public let names: [String]
  /// The grammar's TSLanguage, which tree-sitter never changes
  let language: OpaquePointer
  let query: Query
  /// What a piece cut from the middle of a file may start inside (a string or comment over several lines): parsed
  /// after each of these too when the plain parse has errors
  let openings: [String]
  /// The indent all lines share taken off before parsing (Python reads an indented first line as an error)
  let dedent: Bool

  /// `language`: the grammar's `tree_sitter_<name>()`; `highlights`: its highlight query, in the captures above
  public init(
    names: [String], language: OpaquePointer, highlights: String, openings: [String] = [], dedent: Bool = false
  ) {
    self.names = names
    self.language = language
    query = Query(language, highlights, name: names.first ?? "?")
    self.openings = openings
    self.dedent = dedent
  }

  /// Python, and Triton and TileLang, which are Python
  public static let python = Grammar(
    names: ["python", "triton", "tilelang"], language: tree_sitter_python(), highlights: pythonQuery,
    openings: ["\"\"\"", "'''"], dedent: true)
  public static let rust = Grammar(
    names: ["rust"], language: tree_sitter_rust(), highlights: rustQuery, openings: ["/*"])
  /// C, C++ and CUDA, all read with the CUDA grammar (a superset of C++ with the same node names)
  public static let cuda = Grammar(
    names: ["c", "cpp", "cuda-cpp"], language: tree_sitter_cuda(), highlights: cudaQuery, openings: ["/*"])
}

/// A parsed text. Lives only inside one `tokens` call.
final class Tree {
  let raw: OpaquePointer
  var root: TSNode { ts_tree_root_node(raw) }

  /// nil for an empty text, or when the grammar does not fit this runtime (a pin mistake): the code shows as
  /// plain text.
  init?(_ language: OpaquePointer, _ text: [UInt16]) {
    let parser = ts_parser_new()
    defer { ts_parser_delete(parser) }
    guard ts_parser_set_language(parser, language) else { return nil }
    let tree = text.withUnsafeBytes { bytes in
      bytes.baseAddress.flatMap {
        ts_parser_parse_string_encoding(
          parser, nil, $0.assumingMemoryBound(to: CChar.self), UInt32(bytes.count), TSInputEncodingUTF16LE)
      }
    }
    guard let tree else { return nil }
    raw = tree
  }

  /// `text` parsed by `parser`, reusing what of `old` (edited to match the text already) did not change
  init?(_ parser: OpaquePointer, _ text: [UInt16], old: Tree?) {
    let tree = text.withUnsafeBytes { bytes in
      bytes.baseAddress.flatMap {
        ts_parser_parse_string_encoding(
          parser, old?.raw, $0.assumingMemoryBound(to: CChar.self), UInt32(bytes.count), TSInputEncodingUTF16LE)
      }
    }
    guard let tree else { return nil }
    raw = tree
  }

  deinit { ts_tree_delete(raw) }

  /// How much of the text the parse could not place: code units under ERROR nodes, plus one per node it had to invent.
  var errorCost: Int {
    var cursor = ts_tree_cursor_new(root)
    defer { ts_tree_cursor_delete(&cursor) }
    var cost = 0
    while true {
      let node = ts_tree_cursor_current_node(&cursor)
      if ts_node_is_error(node) {
        cost += node.range.count + 1
      } else if ts_node_is_missing(node) {
        cost += 1
      } else if ts_node_has_error(node), ts_tree_cursor_goto_first_child(&cursor) {
        continue
      }
      while !ts_tree_cursor_goto_next_sibling(&cursor) {
        guard ts_tree_cursor_goto_parent(&cursor) else { return cost }
      }
    }
  }
}

extension TSNode {
  /// UTF-16 offsets, since the text is parsed as UTF-16.
  var range: Range<Int> { Int(ts_node_start_byte(self)) / 2..<Int(ts_node_end_byte(self)) / 2 }
  var type: String { String(cString: ts_node_type(self)) }
  func field(_ name: String) -> TSNode { ts_node_child_by_field_name(self, name, UInt32(name.utf8.count)) }
}

/// A compiled highlight query with its captures and predicates resolved.
///
/// The one type that holds a C pointer across tasks. A TSQuery is never changed after `ts_query_new`, and tree-sitter
/// lets threads share one: all per-search state lives in a TSQueryCursor, which each search makes for itself.
final class Query: @unchecked Sendable {
  enum Action {
    case paint(TokenClass?)
    /// The name a call or declaration is about (`f` of `a::b::f<T>`, `x.f`)
    case callee
    /// A C `#define` body: unparsed text, highlighted by parsing it again
    case macro
    /// A Python string's prefix letters (f, r, b) are keywords
    case stringPrefix
    /// %s and {} placeholders in a Python string
    case placeholders
    /// A Python docstring is a comment, whatever is inside
    case docstring
    /// A Python decorator is one colour up to its arguments
    case decorator
  }

  enum Predicate {
    case anyOf(capture: UInt32, Set<String>)
    case match(capture: UInt32, NSRegularExpression)
  }

  let raw: OpaquePointer
  /// By capture id
  let actions: [Action]
  /// By pattern index
  let predicates: [[Predicate]]

  init(_ language: OpaquePointer, _ source: String, name: String) {
    var offset: UInt32 = 0
    var error = TSQueryErrorNone
    guard let raw = ts_query_new(language, source, UInt32(source.utf8.count), &offset, &error) else {
      preconditionFailure("highlight query for \(name): error \(error.rawValue) at \(offset)")
    }
    self.raw = raw
    func string(_ id: UInt32, _ get: (OpaquePointer, UInt32, UnsafeMutablePointer<UInt32>) -> UnsafePointer<CChar>?)
      -> String
    {
      var length: UInt32 = 0
      return get(raw, id, &length).map { String(cString: $0) } ?? ""
    }
    actions = (0..<ts_query_capture_count(raw)).map { id in
      switch string(id, ts_query_capture_name_for_id) {
      case "kw": .paint(.keyword)
      case "op": .paint(.operator)
      case "fn": .paint(.function)
      case "str": .paint(.string)
      case "com": .paint(.comment)
      case "num": .paint(.number)
      case "self": .paint(.receiver)
      case "p": .paint(.punctuation)
      case "plain": .paint(nil)
      case "callee": .callee
      case "macro": .macro
      case "prefix": .stringPrefix
      case "fmt": .placeholders
      case "doc": .docstring
      case "dec": .decorator
      case let name: preconditionFailure("unknown capture @\(name)")
      }
    }
    predicates = (0..<ts_query_pattern_count(raw)).map { pattern in
      var count: UInt32 = 0
      let steps = UnsafeBufferPointer(start: ts_query_predicates_for_pattern(raw, pattern, &count), count: Int(count))
      return steps.split { $0.type == TSQueryPredicateStepTypeDone }.map { p in
        let args = p.dropFirst().filter { $0.type == TSQueryPredicateStepTypeString }
          .map { string($0.value_id, ts_query_string_value_for_id) }
        guard let capture = p.dropFirst().first(where: { $0.type == TSQueryPredicateStepTypeCapture })?.value_id
        else { preconditionFailure("predicate without a capture") }
        switch string(p[p.startIndex].value_id, ts_query_string_value_for_id) {
        case "any-of?": return .anyOf(capture: capture, Set(args))
        case "match?": return .match(capture: capture, regex(args.first ?? ""))
        case let name: preconditionFailure("unsupported predicate #\(name)")
        }
      }
    }
  }

  deinit { ts_query_delete(raw) }

  /// Whether a match of `pattern` meets its predicates; `text` gives a node's text
  func holds(_ pattern: Int, _ captures: UnsafeBufferPointer<TSQueryCapture>, _ text: (TSNode) -> String) -> Bool {
    predicates[pattern].allSatisfy { predicate in
      switch predicate {
      case .anyOf(let id, let words): captures.allSatisfy { $0.index != id || words.contains(text($0.node)) }
      case .match(let id, let re):
        captures.allSatisfy { c in
          guard c.index == id else { return true }
          let s = text(c.node)
          return re.firstMatch(in: s, range: NSRange(location: 0, length: s.utf16.count)) != nil
        }
      }
    }
  }
}

func regex(_ pattern: String) -> NSRegularExpression {
  guard let re = try? NSRegularExpression(pattern: pattern) else { preconditionFailure("bad pattern \(pattern)") }
  return re
}

/// The name node a call or declaration is about; nil for one with no name (`(*fp)(x)`, a lambda).
func calleeName(_ node: TSNode) -> TSNode? {
  var node = node
  while !ts_node_is_null(node) {
    switch node.type {
    case "identifier", "field_identifier", "destructor_name", "operator_name": return node
    case "qualified_identifier", "scoped_identifier", "template_function", "template_method": node = node.field("name")
    case "field_expression": node = node.field("field")
    default: return nil
    }
  }
  return nil
}

import Foundation

/// One piece of Markdown, parsed. A value: build it on any thread, keep it, compare it. Every offset is a UTF-16 offset in
/// `source`, as NSString and the TypeScript package count.
public struct MarkdownDocument: Sendable, Equatable {
  public let source: String
  /// top-level blocks in order; link reference definitions are blocks too (shown as their source)
  public let blocks: [MDBlock]

  /// the inline structure of each inline text, kept for reparse
  let inlineCache: InlineCache

  public init(_ source: String) {
    self.init(source, previous: InlineCache())
  }

  init(_ source: String, previous: InlineCache) {
    self.source = source
    var builder = DocumentBuilder(cache: InlineCache(previous: previous))
    blocks = builder.blocks(BlockLexer.lex(source))
    inlineCache = builder.cache
  }

  /// The document after one edit. Blocks are lexed again (they depend on each other: a paragraph swallows a lazy line, a
  /// list continues), but the inline structure of every block whose text did not change is kept, which is most of the
  /// work. The result is always equal to `MarkdownDocument(newSource)`.
  public func reparse(replacing range: Range<Int>, with text: String) -> MarkdownDocument {
    let ns = source as NSString
    let new = ns.replacingCharacters(in: NSRange(location: range.lowerBound, length: range.count), with: text)
    return MarkdownDocument(new, previous: inlineCache)
  }

  public static func == (a: MarkdownDocument, b: MarkdownDocument) -> Bool {
    a.source == b.source && a.blocks == b.blocks
  }
}

public struct MDBlock: Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    case paragraph
    case heading(level: Int)
    case quote(children: [MDBlock])
    case list(MDList)
    /// body: the code between the fences (or the indented lines)
    case code(language: String?, body: Range<Int>)
    /// a code block whose language is mermaid
    case mermaid(body: Range<Int>)
    case math(latex: String)
    case table(MDTable)
    case rule
    /// an HTML block: not rendered, shown as its source
    case html
  }
  public var kind: Kind
  /// the block's source, without the line breaks after it
  public var range: Range<Int>
  /// a paragraph's or heading's inline structure; empty for other blocks
  public var inlines: [MDInline]
  /// where the inline text is in the source, unit by unit (its lines inside a quote or list item skip their markers)
  public var inlineText: MDText?

  public static func == (a: MDBlock, b: MDBlock) -> Bool {
    a.kind == b.kind && a.range == b.range && a.inlines == b.inlines && a.inlineText == b.inlineText
  }
}

/// An inline text and the source offset of each of its UTF-16 units (one more at the end: where it ends)
public struct MDText: Sendable, Equatable {
  public var string: String
  public var offsets: [Int]
}

public struct MDList: Sendable, Equatable {
  public enum Marker: Sendable, Equatable {
    case bullet(Character)
    case ordered(start: Int, delimiter: Character)
    /// a task list (TipTap's tokenizer: every item is a task)
    case task
  }
  public var marker: Marker
  public var tight: Bool
  public var items: [MDListItem]
}

public struct MDListItem: Sendable, Equatable {
  public var range: Range<Int>
  /// the bullet or number, and a task's [ ] after it
  public var markerRange: Range<Int>
  /// nil: not a task item
  public var checked: Bool?
  public var children: [MDBlock]
}

public struct MDTable: Sendable, Equatable {
  public enum Align: Sendable, Equatable { case none, left, center, right }
  public var align: [Align]
  /// rows[0] is the header
  public var rows: [[MDCell]]
  /// the "Table: …" line right after it, the text after "Table:"
  public var caption: MDCell?
}

public struct MDCell: Sendable, Equatable {
  public var range: Range<Int>
  public var inlines: [MDInline]
  public var text: MDText
}

/// Inline structure (editor/spans.ts's Span): markers hide while the caret is elsewhere; inner is drawn formatted
public struct MDInline: Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    /// an escape (\*: the backslash is its marker) or source shown as written (an HTML comment, no markers)
    case text
    case strong, emphasis, strike, highlight, underline, code
    /// <kbd>, ~sub~, ^sup^: the TypeScript package draws them too
    case kbd, `subscript`, superscript
    case link(url: String)
    case autolink(url: String)
    /// drawn as one piece; the caret steps over it in one step
    case atom(MDAtom)
  }
  public var kind: Kind
  public var range: Range<Int>
  public var markers: [Range<Int>]
  public var inner: Range<Int>?
  public var children: [MDInline]
}

public enum MDAtom: Sendable, Equatable {
  case math(latex: String, display: Bool)
  case image(MDImage)
  case emoji(name: String)
  /// [[label]] or [[label#^target]]
  case ref(label: String, target: String?)
  case html(raw: String)
  case lineBreak
  case annotation(text: String, note: String, color: String, below: Bool)
}

public struct MDImage: Sendable, Equatable {
  public var src: String
  public var alt: String
  /// the title: shown as the caption, inline Markdown
  public var caption: String
  /// share of the body's width (0–1); nil: the full width
  public var width: Double?
  /// an animated image's still frame, from 1
  public var frame: Int?
  public var loops: Bool
  /// the address as written
  public var url: Range<Int>
  /// the {width=… frame=… loop=true} block after it
  public var attributes: Range<Int>?
  /// an address CommonMark does not accept: drawn as an image that failed to load, never loaded
  public var broken: Bool
}

/// Table column widths and row heights, and which code blocks wrap, by position (@yhnocoder/markdown's MdLayout)
public struct MDLayoutInfo: Sendable, Equatable, Codable {
  public struct Table: Sendable, Equatable, Codable {
    public var cols: [Double?]?
    public var rows: [Double?]?
    public init(cols: [Double?]? = nil, rows: [Double?]? = nil) {
      self.cols = cols
      self.rows = rows
    }
  }
  public var tables: [Table?]?
  public var wrap: [Int]?
  public init(tables: [Table?]? = nil, wrap: [Int]? = nil) {
    self.tables = tables
    self.wrap = wrap
  }
}

// MARK: building

/// Inline structure already worked out, by inline text (in inline-text offsets, so it holds wherever the text moved):
/// reparse keeps it for blocks whose text did not change
struct InlineCache: Sendable {
  private var spans: [String: [Span]] = [:]
  private var previous: [String: [Span]] = [:]
  init() {}
  /// a cache that looks in `previous` first, and keeps only what this document uses
  init(previous: InlineCache) { self.previous = previous.spans }
  mutating func spans(_ text: String) -> [Span] {
    if let s = spans[text] { return s }
    let s = previous[text] ?? Spans.of(text)
    spans[text] = s
    return s
  }
}

struct DocumentBuilder {
  var cache: InlineCache

  mutating func blocks(_ toks: [Token]) -> [MDBlock] {
    var out: [MDBlock] = []
    var prevTable: Int?
    for t in toks {
      if t.type == "space" { continue }
      // a "Table: …" paragraph right after a table is that table's caption (schema.ts tableCaptions)
      if t.type == "paragraph", let ti = prevTable, case .table(var table) = out[ti].kind, table.caption == nil,
        let cap = Ext.tableCaption.exec(t.text.ns)
      {
        let text = t.text.dropFirst(cap.range.length)
        table.caption = cell(text)
        out[ti].kind = .table(table)
        out[ti].range = out[ti].range.lowerBound..<range(t.raw).upperBound
        prevTable = nil
        continue
      }
      guard let b = block(t) else { continue }
      prevTable = if case .table = b.kind { out.count } else { nil }
      out.append(b)
    }
    return out
  }

  /// a block's source range without the line breaks after it: up to just after its last unit (a \r\n read as \n maps
  /// its \n to the \n, so the end of the mapping would take the \r in)
  private func range(_ m: Mapped) -> Range<Int> { span(m.trimmingEnd(0x0A)) }

  mutating func block(_ t: Token) -> MDBlock? {
    let r = range(t.raw)
    switch t.type {
    case "paragraph", "text":
      return inlineBlock(.paragraph, t.inlineText ?? t.text, r)
    case "heading":
      return inlineBlock(.heading(level: t.depth), t.text, r)
    case "def":
      // a link reference definition: shown as its source, nothing hidden
      return MDBlock(kind: .paragraph, range: r, inlines: [], inlineText: text(t.raw.trimmingEnd(0x0A)))
    case "blockquote":
      return MDBlock(kind: .quote(children: blocks(t.tokens)), range: r, inlines: [], inlineText: nil)
    case "list":
      return MDBlock(kind: .list(list(t)), range: r, inlines: [], inlineText: nil)
    case "taskList":
      return MDBlock(kind: .list(taskList(t)), range: r, inlines: [], inlineText: nil)
    case "code":
      let body = span(t.text)
      if t.lang == "mermaid" { return MDBlock(kind: .mermaid(body: body), range: r, inlines: [], inlineText: nil) }
      let lang = t.lang.flatMap { l in
        l.isEmpty ? nil : String(l.split(whereSeparator: { $0 == " " || $0 == "\t" }).first ?? "")
      }
      return MDBlock(kind: .code(language: lang, body: body), range: r, inlines: [], inlineText: nil)
    case "blockMath":
      return MDBlock(kind: .math(latex: t.latex), range: r, inlines: [], inlineText: nil)
    case "table":
      var table = MDTable(
        align: t.align.map {
          switch $0 {
          case "left": .left
          case "center": .center
          case "right": .right
          default: .none
          }
        }, rows: [], caption: nil)
      table.rows = [t.header.map { cell($0.text) }] + t.rows.map { $0.map { cell($0.text) } }
      return MDBlock(kind: .table(table), range: r, inlines: [], inlineText: nil)
    case "hr":
      return MDBlock(kind: .rule, range: r, inlines: [], inlineText: nil)
    case "html":
      return MDBlock(kind: .html, range: r, inlines: [], inlineText: nil)
    default:
      return nil
    }
  }

  /// the source range a mapped text spans: from its first unit to just after its last
  private func span(_ m: Mapped) -> Range<Int> {
    guard m.count > 0 else { return m.source.lowerBound..<m.source.lowerBound }
    return m.sourceOffset(0)..<(m.sourceOffset(m.count - 1) + 1)
  }

  private func text(_ m: Mapped) -> MDText { MDText(string: m.string, offsets: m.mapForText) }

  private mutating func inlineBlock(_ kind: MDBlock.Kind, _ m: Mapped, _ r: Range<Int>) -> MDBlock {
    MDBlock(kind: kind, range: r, inlines: inlines(m), inlineText: text(m))
  }

  private mutating func cell(_ m: Mapped) -> MDCell {
    MDCell(range: span(m), inlines: inlines(m), text: text(m))
  }

  mutating func inlines(_ m: Mapped) -> [MDInline] {
    let spans = cache.spans(m.string)
    return spans.map { Self.inline($0, m) }
  }

  /// a span in inline-text offsets, as source ranges
  static func inline(_ s: Span, _ m: Mapped) -> MDInline {
    func r(_ x: Range<Int>) -> Range<Int> {
      if x.isEmpty { return m.sourceOffset(x.lowerBound)..<m.sourceOffset(x.lowerBound) }
      return m.sourceOffset(x.lowerBound)..<(m.sourceOffset(x.upperBound - 1) + 1)
    }
    let kind: MDInline.Kind
    if let a = s.atom {
      switch a {
      case .math(let latex, let display): kind = .atom(.math(latex: latex, display: display))
      case .image(let src, let alt, let title, let width, let frame, let loop, _, let url, let widthAt, let broken):
        kind = .atom(
          .image(
            MDImage(
              src: src, alt: alt, caption: title, width: width.map { $0 / 100 }, frame: frame, loops: loop, url: r(url),
              attributes: widthAt.map(r), broken: broken)))
      case .emoji(let name): kind = .atom(.emoji(name: name))
      case .ref(let label, let target): kind = .atom(.ref(label: label, target: target))
      case .html(let raw): kind = .atom(.html(raw: raw))
      case .br: kind = .atom(.lineBreak)
      case .annot(let note, let color, let below, let text):
        kind = .atom(.annotation(text: text, note: note, color: color, below: below))
      }
    } else {
      switch s.tag {
      case "strong": kind = .strong
      case "em": kind = .emphasis
      case "s": kind = .strike
      case "mark": kind = .highlight
      case "u": kind = .underline
      case "code": kind = .code
      case "kbd": kind = .kbd
      case "sub": kind = .subscript
      case "sup": kind = .superscript
      case "a":
        // <url> and bare addresses have no [ ] markers
        let raw = m.string.utf16
        let first = raw.index(raw.startIndex, offsetBy: s.from)
        kind = raw[first] == 0x5B ? .link(url: s.href ?? "") : .autolink(url: s.href ?? "")
      default: kind = .text
      }
    }
    return MDInline(
      kind: kind, range: r(s.from..<s.to), markers: s.marks.map(r), inner: s.inner.map(r),
      children: s.kids.map { inline($0, m) })
  }

  private mutating func list(_ t: Token) -> MDList {
    let marker: MDList.Marker
    let first = t.items.first.map { Mapped.leadingMarker($0.raw) } ?? "-"
    if t.ordered {
      marker = .ordered(start: t.start ?? 1, delimiter: first.last ?? ".")
    } else {
      marker = .bullet(first.first ?? "-")
    }
    let items = t.items.map { i -> MDListItem in
      let mr = Mapped.markerRange(i.raw, task: i.task)
      return MDListItem(
        range: range(i.raw), markerRange: mr, checked: i.task ? i.checked : nil, children: blocks(i.tokens))
    }
    return MDList(marker: marker, tight: !t.loose, items: items)
  }

  private mutating func taskList(_ t: Token) -> MDList {
    let items = t.items.map { i -> MDListItem in
      let mr = Mapped.markerRange(i.raw, task: true)
      var children: [MDBlock] = [inlineBlock(.paragraph, i.text, span(i.text))]
      children += blocks(i.nested)
      let end = children.last.map { max($0.range.upperBound, i.raw.source.upperBound) } ?? i.raw.source.upperBound
      return MDListItem(range: i.raw.source.lowerBound..<end, markerRange: mr, checked: i.checked, children: children)
    }
    return MDList(marker: .task, tight: true, items: items)
  }
}

extension Mapped {
  /// the units' source offsets plus the end
  var mapForText: [Int] { (0...count).map { sourceOffset($0) } }

  /// a list item's bullet or number as written
  static func leadingMarker(_ raw: Mapped) -> String {
    let s = raw.trimmedStart().string
    if let m = JSRegex(#"^(?:[*+-]|\d{1,9}[.)])"#, flags: "").exec(s as NSString) {
      return (s as NSString).substring(with: m.range)
    }
    return "-"
  }
  /// a list item's marker in the source: the bullet or number, and [ ] after it for a task
  static func markerRange(_ raw: Mapped, task: Bool) -> Range<Int> {
    let s = raw.ns
    let re = task ? taskMarker : itemMarker
    guard let m = re.exec(s) else { return raw.source.lowerBound..<raw.source.lowerBound }
    let g = m.groups[1]!
    return raw.sourceOffset(g.location)..<(raw.sourceOffset(g.upperBound - 1) + 1)
  }
  private static let itemMarker = JSRegex(#"^\s*((?:[*+-]|\d{1,9}[.)]))"#, flags: "")
  private static let taskMarker = JSRegex(#"^\s*((?:[*+-]|\d{1,9}[.)])\s+\[[ xX]\])"#, flags: "")
}

extension Ext {
  static let tableCaption = JSRegex(#"^Table:[ \t]+(?=\S)"#, flags: "")
}

import Foundation

/// One piece of Markdown, parsed. A value: build it on any thread, keep it, compare it. Every offset is a UTF-16 offset in
/// `source`, as NSString and the TypeScript package count.
public struct MarkdownDocument: Sendable, Equatable {
  public let source: String
  /// top-level blocks in order; link reference definitions are blocks too (shown as their source)
  public let blocks: [MDBlock]

  /// the inline structure of each inline text, kept for reparse
  let inlineCache: InlineCache
  /// every link reference definition, by offset, and whether it took its label first: only which labels are defined,
  /// and where, matters to the rest of the document (a later definition of a defined label is no block at all; a
  /// reference link is never resolved, shown as written)
  let definitions: [Definition]

  public init(_ source: String) {
    self.init(source, previous: InlineCache())
  }

  init(_ source: String, previous: InlineCache) {
    self.source = source
    var builder = DocumentBuilder(cache: InlineCache(previous: previous))
    let lexed = BlockLexer.lexing(source)
    blocks = builder.blocks(lexed.tokens)
    builder.cache.seal()
    inlineCache = builder.cache
    definitions = lexed.definitions
  }

  /// A document assembled from blocks already parsed (reparse)
  init(source: String, blocks: [MDBlock], cache: InlineCache, definitions: [Definition]) {
    self.source = source
    self.blocks = blocks
    self.inlineCache = cache
    self.definitions = definitions
  }

  /// The document after one edit, always equal to `MarkdownDocument(newSource)`, at a cost that does not grow with the
  /// document: only a window of whole top-level blocks around the edit is lexed again. Both ends of the window are restart
  /// points, places a parse of the whole document passes through in a state that nothing before them shapes:
  /// - the start of an old top-level block, with a blank line before it that the edit does not touch, and
  /// - the block before that blank line is one a blank line closes: not a list (an item goes on across blank lines, and
  ///   decides whether the list is loose) and not indented code (it goes on across blank lines too).
  /// The start is the nearest such place at or before the edit, from the old parse alone. The end is the nearest one after
  /// it that the new window's own last block also satisfies, and that every fence, `$$` or HTML block opened in the window
  /// closes before; a window that does not end so takes in more blocks, twice as many each time, up to the document's end.
  /// Link reference definitions: the window is lexed knowing the labels defined before it, so a definition in it of one
  /// of those is dropped as in the whole document; when the labels the window defines first are the ones it defined
  /// before, every definition after it keeps its fate (a definition is dropped when an earlier one has its label), so the
  /// rest stands. Otherwise (a definition made, removed or relabelled) the document is parsed whole.
  /// Parsed whole too: an edit whose lines hold a `$$`, and one that adds or removes a `$` in a document holding `$$` (a
  /// `$$` block's body holds no `$` and runs across blank lines, so one `$` or `$$` more or less can pair or unpair others
  /// far away).
  public func reparse(replacing range: Range<Int>, with text: String) -> MarkdownDocument {
    let ns = source as NSString
    let new = ns.replacingCharacters(in: NSRange(location: range.lowerBound, length: range.count), with: text)
    let newNS = new as NSString
    let delta = (text as NSString).length - range.count
    let a = range.lowerBound
    let b = range.upperBound
    let removed = ns.substring(with: NSRange(location: a, length: range.count))
    // a $$ block's body holds no $ at all: one $ more or less anywhere between two $$ lines pairs or unpairs them
    let dollars = (text.holds("$") || removed.holds("$")) && (source.holds("$$") || new.holds("$$"))
    if dollars || Self.linesHoldDoubleDollar(ns, a..<b) || Self.linesHoldDoubleDollar(newNS, a..<(b + delta)) {
      return MarkdownDocument(new, previous: inlineCache)
    }
    let solid = blocks.indices.filter { !blocks[$0].range.isEmpty }
    guard !solid.isEmpty else { return MarkdownDocument(new, previous: inlineCache) }

    // the window's start: solid block `k` (0 = the document's start) before the edit, a restart point. Its first line
    // must have text before the edit: line breaks put in before that, or into the spaces it starts with, lengthen the
    // blank lines before it, which the window must then hold. And it must not be a "Table: …" line, which the table
    // before it may take as its caption
    // block starts rise with the index: the last one before the edit by binary search, then back past any whose text
    // begins at or after it
    var k = max(0, Self.partition(solid.count) { blocks[solid[$0]].range.lowerBound < a } - 1)
    while k > 0 && Self.textStart(ns, blocks[solid[k]].range.lowerBound) >= a { k -= 1 }
    while k > 0 {
      let at = blocks[solid[k]].range.lowerBound
      if restarts(at: k, solid: solid, ns: ns) && !Self.taskListReachesBack(after: blocks[solid[k - 1]], at: at, newNS)
        && !Ext.tableCaption.test(newNS, from: at)
      {
        break
      }
      k -= 1
    }
    let start = k > 0 ? blocks[solid[k]].range.lowerBound : 0
    // the end's candidates, found as far as asked: solid blocks starting after the edit with a blank line before them
    // that the edit leaves be, not a "Table: …" line (which a table before it takes as its caption across blank lines)
    var nextCandidate = max(Self.partition(solid.count) { blocks[solid[$0]].range.lowerBound <= b }, k + 1)
    var ends: [Int] = []
    func end(_ n: Int) -> Int? {
      while ends.count <= n && nextCandidate < solid.count {
        let j = nextCandidate
        nextCandidate += 1
        let at = blocks[solid[j]].range.lowerBound
        if restarts(at: j, solid: solid, ns: ns) && Self.blankLineBefore(ns, at, after: b)
          && !Ext.tableCaption.test(ns, from: at)
        {
          ends.append(j)
        }
      }
      return n < ends.count ? ends[n] : nil
    }
    var step = 0
    var tried = 0
    while true {
      let j = end(tried)
      let endOld = j.map { blocks[solid[$0]].range.lowerBound } ?? ns.length
      let end = j == nil ? newNS.length : endOld + delta
      if start == 0 && j == nil { return MarkdownDocument(new, previous: inlineCache) }
      let window = newNS.substring(with: NSRange(location: start, length: end - start))
      // lexed with the first line of the block at the end as well: the blank lines before it are then between blocks,
      // as in the whole document, not at the end of the text (where TipTap makes an empty paragraph of them); everything
      // from that line on is dropped again
      let lexedEnd = j == nil ? end : NSMaxRange(newNS.lineRange(for: NSRange(location: end, length: 0)))
      let lexed = newNS.substring(with: NSRange(location: start, length: lexedEnd - start))
      // the labels defined before the window, from the old document (nothing before the window changed)
      let before = definitions.prefix { $0.at < start }
      let lexing = BlockLexer.lexing(lexed, defined: Set(before.map(\.tag)))
      // the window's texts are looked up in, and added to, the store this document shares with its versions
      var builder = DocumentBuilder(cache: inlineCache)
      let parsed = builder.blocks(lexing.tokens).map { $0.shifted(start) }.filter { $0.range.lowerBound < end }
      let windowDefinitions = lexing.definitions.map { Definition(tag: $0.tag, at: $0.at + start, first: $0.first) }
        .filter { $0.at < end }
      let lastSolid = parsed.last { !$0.range.isEmpty }
      // a fence, HTML block or container left open in the window runs on into the next block's line: the window's
      // blocks must all end before it
      let staysInside = parsed.allSatisfy { $0.range.upperBound <= end }
      let endsClean =
        staysInside && Self.windowCloses(window) && (lastSolid.map { Self.closedByBlankLine($0, newNS) } ?? true)
        && !(lastSolid.map { Self.taskListReachesBack(after: $0, at: end, newNS) } ?? false)
      if j == nil || endsClean {
        let after = definitions.drop { $0.at < endOld }
        let oldWindow = definitions[before.count..<(definitions.count - after.count)]
        // the window defines other labels first than it did: a definition of one of those after it may change fate
        let was = Set(oldWindow.filter(\.first).map(\.tag))
        let now = Set(windowDefinitions.filter(\.first).map(\.tag))
        if was != now && !was.symmetricDifference(now).isDisjoint(with: after.map(\.tag)) {
          return MarkdownDocument(new, previous: inlineCache)
        }
        let from = k > 0 ? solid[k] : 0
        let to = j.map { solid[$0] } ?? blocks.count
        let prefix = Array(blocks[..<from])
        let suffix = Array(blocks[to...].map { $0.shifted(delta) })
        // the texts of the blocks the window replaced leave the store, unless the window has them again
        let kept = Set(parsed.flatMap(\.inlineTexts))
        inlineCache.forget(Set(blocks[from..<to].flatMap(\.inlineTexts)).subtracting(kept))
        let defs =
          Array(before) + windowDefinitions + after.map { Definition(tag: $0.tag, at: $0.at + delta, first: $0.first) }
        return MarkdownDocument(source: new, blocks: prefix + parsed + suffix, cache: inlineCache, definitions: defs)
      }
      step = max(1, step * 2)
      tried += step
    }
  }

  /// Whether solid block `k` (k ≥ 1) starts a restart point in the old parse: a blank line between it and the block
  /// before, which is a block a blank line closes
  private func restarts(at k: Int, solid: [Int], ns: NSString) -> Bool {
    let prev = blocks[solid[k - 1]]
    let here = blocks[solid[k]].range.lowerBound
    guard Self.closedByBlankLine(prev, ns) else { return false }
    let gap = ns.substring(with: NSRange(location: prev.range.upperBound, length: here - prev.range.upperBound))
    return Self.blankLine.firstMatch(in: gap, range: NSRange(location: 0, length: (gap as NSString).length)) != nil
  }

  private static let blankLine = try! NSRegularExpression(pattern: "\\n[ \\t]*\\n")

  /// Whether a blank line closes this block for good: everything but a list, an indented code block and an HTML block
  /// (which takes in the whitespace-only lines after it, so where it ends depends on what follows)
  static func closedByBlankLine(_ block: MDBlock, _ ns: NSString) -> Bool {
    switch block.kind {
    case .list, .html: return false
    case .code:
      // fenced (``` or ~~~ within its first four columns) or indented
      let head = ns.substring(with: NSRange(location: block.range.lowerBound, length: min(7, block.range.count)))
      let t = head.drop { $0 == " " }
      return t.hasPrefix("```") || t.hasPrefix("~~~")
    default: return true
    }
  }

  /// Whether a task list starting at `at` (in `ns`) would take in the blank lines before it: after a paragraph, the
  /// paragraph ends where the task list's search finds it, and the list's range begins there (TipTap's taskList)
  static func taskListReachesBack(after prev: MDBlock, at: Int, _ ns: NSString) -> Bool {
    guard case .paragraph = prev.kind, at < ns.length else { return false }
    return Ext.taskStart.test(ns, from: at, to: NSMaxRange(ns.lineRange(for: NSRange(location: at, length: 0))))
  }

  /// How many of the indices 0..<n satisfy `below`, which holds for a first run of them and fails for the rest
  static func partition(_ n: Int, _ below: (Int) -> Bool) -> Int {
    var lo = 0
    var hi = n
    while lo < hi {
      let mid = (lo + hi) / 2
      if below(mid) { lo = mid + 1 } else { hi = mid }
    }
    return lo
  }

  /// Where the text of the line starting at `at` begins, past its spaces and tabs
  static func textStart(_ ns: NSString, _ at: Int) -> Int {
    var i = at
    while i < ns.length, ns.character(at: i) == 0x20 || ns.character(at: i) == 0x09 { i += 1 }
    return i
  }

  /// Whether the line before the one starting at `at` is blank and lies wholly at or after `after`
  static func blankLineBefore(_ ns: NSString, _ at: Int, after: Int) -> Bool {
    guard at >= 2, ns.character(at: at - 1) == 0x0A else { return false }
    var i = at - 2
    while i >= 0, ns.character(at: i) == 0x20 || ns.character(at: i) == 0x09 { i -= 1 }
    // the blank line runs from just after the line break at i to at - 1
    return i >= 0 && ns.character(at: i) == 0x0A && i >= after
  }

  /// Whether the whole lines a range touches hold a `$$`
  static func linesHoldDoubleDollar(_ ns: NSString, _ r: Range<Int>) -> Bool {
    let lines = ns.lineRange(for: NSRange(location: r.lowerBound, length: r.count))
    return ns.range(of: "$$", options: .literal, range: lines).location != NSNotFound
  }

  /// Whether every fenced code block, `$$` math block and HTML block the window opens also closes in it. An opener left
  /// open runs to the end of the document in a full parse, which lexing the window alone turns into ordinary text, so
  /// such a window is never accepted on its own; the caller grows it. Conservative: it may say a closed window is open
  /// (then the window just grows), never that an open one is closed.
  static func windowCloses(_ text: String) -> Bool {
    var fence: (char: Character, count: Int)?
    var math = false
    var html = false
    for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
      let line = raw
      let trimmed = line.drop { $0 == " " }
      if let f = fence {
        // a fence closes on a line of at least as many of its own character, nothing else but spaces after
        let run = trimmed.prefix { $0 == f.char }
        if run.count >= f.count && trimmed.dropFirst(run.count).allSatisfy({ $0 == " " }) { fence = nil }
        continue
      }
      if math {
        if trimmed.hasPrefix("$$") { math = false }
        continue
      }
      if html {
        if line.allSatisfy({ $0 == " " }) { html = false }
        continue
      }
      let indent = line.prefix { $0 == " " }.count
      if indent >= 4 { continue }
      if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
        let char = trimmed.first!
        fence = (char, trimmed.prefix { $0 == char }.count)
      } else if trimmed.hasPrefix("$$") {
        // a one-line $$…$$ opens and closes on the same line
        if trimmed.dropFirst(2).contains("$$") { continue }
        math = true
      } else if trimmed.first == "<" {
        // an HTML block closes on a blank line (marked types 1–6 all do, or sooner); treat the window as open until one
        html = true
      }
    }
    return fence == nil && !math && !html
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

  public init(kind: Kind, range: Range<Int>, inlines: [MDInline], inlineText: MDText?) {
    self.kind = kind
    self.range = range
    self.inlines = inlines
    self.inlineText = inlineText
  }

  public static func == (a: MDBlock, b: MDBlock) -> Bool {
    a.kind == b.kind && a.range == b.range && a.inlines == b.inlines && a.inlineText == b.inlineText
  }
}

/// An inline text and the source offset of each of its UTF-16 units (one more at the end: where it ends)
public struct MDText: Sendable, Equatable {
  public var string: String
  public var offsets: [Int]
  public init(string: String, offsets: [Int]) {
    self.string = string
    self.offsets = offsets
  }
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
/// The inline structure of inline texts, by text (a pure function of it), shared by a document and the versions reparse
/// makes of it: a reparse looks up and adds what its window holds and takes out what the blocks it replaced held, so the
/// store stays the size of the document, with no copy and no clearing on any key. A whole parse makes a store of its own
/// holding what the document uses, reading the one it was given for what is already worked out.
final class InlineCache: @unchecked Sendable {
  private var spans: [String: [Span]] = [:]
  /// a whole parse's store reads this while it is built (`seal` lets it go)
  private var previous: InlineCache?
  private let lock = NSLock()

  init() {}
  init(previous: InlineCache) { self.previous = previous }

  func spans(_ text: String) -> [Span] {
    if let s = lock.withLock({ spans[text] }) { return s }
    let s = previous?.lookup(text) ?? Spans.of(text)
    lock.withLock { spans[text] = s }
    return s
  }

  private func lookup(_ text: String) -> [Span]? { lock.withLock { spans[text] } }

  /// built: no longer read from the store it was made from
  func seal() { lock.withLock { previous = nil } }

  /// texts of blocks a reparse replaced, unless the new window holds them too
  func forget(_ texts: Set<String>) { lock.withLock { for t in texts { spans[t] = nil } } }

  var count: Int { lock.withLock { spans.count } }
}

extension MDBlock {
  /// every inline text in it, nested blocks' too
  var inlineTexts: [String] {
    var out = inlineText.map { [$0.string] } ?? []
    switch kind {
    case .quote(let children): out += children.flatMap(\.inlineTexts)
    case .list(let l): out += l.items.flatMap { $0.children.flatMap(\.inlineTexts) }
    case .table(let t):
      out += t.rows.flatMap { $0 }.map(\.text.string)
      if let c = t.caption { out.append(c.text.string) }
    default: break
    }
    return out
  }
}

struct DocumentBuilder {
  let cache: InlineCache

  /// Blocks of a token list. Where TipTap reads blank lines as empty paragraphs (the top level, quotes and list items:
  /// parseBlockChildren), they are blocks too: an empty paragraph the web board shows as a blank line
  mutating func blocks(_ toks: [Token]) -> [MDBlock] {
    var out: [MDBlock] = []
    var prevTable: Int?
    let nonSpace = toks.indices.filter { toks[$0].type != "space" }
    for (i, t) in toks.enumerated() {
      // blank lines a token took in at its end count as a space token after it (TipTap's extractAbsorbedBlankLines)
      let next = i + 1 < toks.count ? toks[i + 1].type : nil
      var absorbed: Mapped?
      if t.type != "space", next != "space", let m = Self.trailingBlankLines.exec(t.raw.ns) {
        absorbed = t.raw.dropFirst(m.range.location)
      }
      // the empty paragraphs this token's own trailing blank lines make: it goes before them, and only them
      var own = 0
      if t.type == "space" || absorbed != nil {
        let raw = absorbed ?? t.raw
        let hasPrev = nonSpace.contains { $0 < i } || absorbed != nil
        let hasNext = nonSpace.contains { $0 > i }
        let made = emptyParagraphs(raw, between: hasPrev && hasNext, afterBlock: hasPrev)
        out += made
        if t.type == "space" { continue }
        own = made.count
      }
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
      // the empty paragraphs of a token's own trailing blank lines come after it; empty paragraphs from blank lines
      // before it stay where they are (moving past them too put a blank line after later blocks)
      out.insert(b, at: out.count - own)
    }
    return out
  }

  private static let trailingBlankLines = JSRegex(#"\n[^\S\n]*(?:\n[^\S\n]*)+$"#, flags: "")

  /// TipTap's createImplicitEmptyParagraphsFromSpace: one empty paragraph per blank line pair in a run of blank lines, less
  /// one between two blocks (that one is the ordinary gap)
  ///
  /// Each sits where the blocks around it leave it (its range is empty, at the end of the text before), but its one caret
  /// place is the start of its own blank line: the line after the gap a block before it keeps, then every second one
  private func emptyParagraphs(_ raw: Mapped, between: Bool, afterBlock: Bool) -> [MDBlock] {
    let n = raw.string.components(separatedBy: "\n\n").count - 1
    let count = max(0, n - (between ? 1 : 0))
    guard count > 0 else { return [] }
    let at = raw.source.lowerBound
    let units = Array(raw.string.utf16)
    let breaks = units.indices.filter { units[$0] == 0x0A }.map { raw.sourceOffset($0) }
    return (0..<count).map { k in
      let i = afterBlock ? 2 * k + 1 : 2 * k - 1
      let place = i < 0 ? at : i < breaks.count ? breaks[i] + 1 : raw.source.upperBound
      return MDBlock(kind: .paragraph, range: at..<at, inlines: [], inlineText: MDText(string: "", offsets: [place]))
    }
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

import Foundation

/// Editing rules on source and selection, free of AppKit: what keys and commands do, where the caret goes and what it
/// reveals (guideline 6.2)
public enum MarkdownEditing {}

/// A selection in source offsets (UTF-16). The anchor stays where it began; the head is the end that moves (the caret)
public struct MDSelection: Sendable, Hashable {
  public var anchor: Int
  public var head: Int
  public init(anchor: Int, head: Int) {
    self.anchor = anchor
    self.head = head
  }
  public init(_ caret: Int) { self.init(anchor: caret, head: caret) }
  public var range: Range<Int> { min(anchor, head)..<max(anchor, head) }
  public var isEmpty: Bool { anchor == head }
}

/// Text the caret moves through: a paragraph's, a heading's or a table cell's inline text, a code block's body, or a
/// block shown as its source. Its positions are the source offsets of its units and its end (a list item's or quote's
/// continuation lines skip their leading markers, which the caret never stands in)
public struct MDTextRun: Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    /// inline Markdown: markers hide away from the caret, atoms are stepped over whole
    case inline
    /// code or a block shown as written: every character is a place
    case plain
  }
  public var kind: Kind
  /// each UTF-16 unit's source offset, then the end
  public var offsets: [Int]
  /// the units
  public var string: String
  public var inlines: [MDInline]
  public var first: Int { offsets[0] }
  public var last: Int { offsets[offsets.count - 1] }
  public func holds(_ offset: Int) -> Bool { offset >= first && offset <= last }
  /// the index of the first position at or after `offset`
  public func index(_ offset: Int) -> Int {
    var lo = 0
    var hi = offsets.count - 1
    while lo < hi {
      let mid = (lo + hi) / 2
      if offsets[mid] < offset { lo = mid + 1 } else { hi = mid }
    }
    return lo
  }
}

/// Source the caret's layout leaves out: markers away from the caret (crossed in one step, counting as nothing) or an
/// atom drawn in place of its source (crossed in one step, counting as one character)
public struct MDHidden: Sendable, Equatable {
  public var range: Range<Int>
  public var atom: Bool
  public init(_ range: Range<Int>, atom: Bool) {
    self.range = range
    self.atom = atom
  }
}

extension MarkdownEditing {
  // MARK: runs

  /// The runs of one top-level block, in order (none in a formula block or a rule: the caret goes past them)
  public static func runs(of block: MDBlock, in document: MarkdownDocument) -> [MDTextRun] {
    var out: [MDTextRun] = []
    collect(block, document.source as NSString, &out)
    return out
  }

  private static func collect(_ b: MDBlock, _ ns: NSString, _ out: inout [MDTextRun]) {
    switch b.kind {
    case .paragraph, .heading:
      if let t = b.inlineText {
        out.append(MDTextRun(kind: .inline, offsets: t.offsets, string: t.string, inlines: b.inlines))
      }
    case .quote(let children):
      for c in children { collect(c, ns, &out) }
    case .list(let l):
      for item in l.items { for c in item.children { collect(c, ns, &out) } }
    case .code(_, let body), .mermaid(let body):
      out.append(plain(body, ns))
    case .table(let t):
      for row in t.rows {
        for cell in row {
          out.append(
            MDTextRun(kind: .inline, offsets: cell.text.offsets, string: cell.text.string, inlines: cell.inlines))
        }
      }
      if let c = t.caption {
        out.append(MDTextRun(kind: .inline, offsets: c.text.offsets, string: c.text.string, inlines: c.inlines))
      }
    case .html:
      // shown as written; a trailing line break is the gap to the next block
      var r = b.range
      while r.upperBound > r.lowerBound, ns.character(at: r.upperBound - 1) == 0x0A {
        r = r.lowerBound..<(r.upperBound - 1)
      }
      out.append(plain(r, ns))
    case .math, .rule:
      break
    }
  }

  private static func plain(_ r: Range<Int>, _ ns: NSString) -> MDTextRun {
    MDTextRun(
      kind: .plain, offsets: Array(r.lowerBound...r.upperBound),
      string: ns.substring(with: NSRange(location: r.lowerBound, length: r.count)), inlines: [])
  }

  /// The index of the top-level block holding `offset`, or the last one starting before it (an offset in the blank lines
  /// between two blocks belongs to the one before)
  public static func blockIndex(_ offset: Int, in document: MarkdownDocument) -> Int? {
    let blocks = document.blocks
    var lo = 0
    var hi = blocks.count
    while lo < hi {
      let mid = (lo + hi) / 2
      if blocks[mid].range.lowerBound <= offset { lo = mid + 1 } else { hi = mid }
    }
    return lo == 0 ? (blocks.isEmpty ? nil : 0) : lo - 1
  }

  /// The index of the top-level block whose text holds `offset` (an empty paragraph's place is not where its range is),
  /// else `blockIndex`
  public static func blockHolding(_ offset: Int, in document: MarkdownDocument) -> Int? {
    guard let bi = blockIndex(offset, in: document) else { return nil }
    var j = bi
    while j >= 0, j == bi || document.blocks[j].range.upperBound >= offset {
      if runs(of: document.blocks[j], in: document).contains(where: { $0.holds(offset) }) { return j }
      j -= 1
    }
    return bi
  }

  /// The run a caret at `offset` stands in: the one holding it, else the nearest (an offset on a heading's `#`, a list
  /// marker or between blocks)
  public static func run(at offset: Int, in document: MarkdownDocument) -> MDTextRun? {
    guard let bi = blockIndex(offset, in: document) else { return nil }
    let here = runs(of: document.blocks[bi], in: document)
    if let r = here.first(where: { $0.holds(offset) }) { return r }
    // an empty paragraph's range is the end of the text before it (its place is its own blank line): an offset there is
    // that text's, or another empty paragraph's
    var j = bi - 1
    while j >= 0, document.blocks[j].range.upperBound >= offset {
      if let r = runs(of: document.blocks[j], in: document).first(where: { $0.holds(offset) }) { return r }
      j -= 1
    }
    if let r = here.last(where: { $0.first <= offset }) { return r }
    if let r = here.first { return r }
    // a block without runs: the nearest run after it, else before
    return nextRun(after: bi, in: document) ?? previousRun(before: bi, in: document)
  }

  static func nextRun(after bi: Int, in document: MarkdownDocument) -> MDTextRun? {
    var i = bi + 1
    while i < document.blocks.count {
      if let r = runs(of: document.blocks[i], in: document).first { return r }
      i += 1
    }
    return nil
  }

  static func previousRun(before bi: Int, in document: MarkdownDocument) -> MDTextRun? {
    var i = bi - 1
    while i >= 0 {
      if let r = runs(of: document.blocks[i], in: document).last { return r }
      i -= 1
    }
    return nil
  }

  /// A caret place for any offset: the offset itself when it is one, else the nearest place in its run
  public static func snap(_ offset: Int, in document: MarkdownDocument) -> Int {
    guard let r = run(at: offset, in: document) else { return 0 }
    if offset <= r.first { return r.first }
    if offset >= r.last { return r.last }
    return r.offsets[r.index(offset)]
  }

  /// The first and last caret places of the document
  public static func start(of document: MarkdownDocument) -> Int {
    document.blocks.indices.lazy.compactMap { runs(of: document.blocks[$0], in: document).first?.first }.first ?? 0
  }
  public static func end(of document: MarkdownDocument) -> Int {
    document.blocks.indices.reversed().lazy.compactMap { runs(of: document.blocks[$0], in: document).last?.last }.first
      ?? (document.source as NSString).length
  }

  // MARK: what the caret reveals

  /// Whether a construct shows its source with the caret at `head`: anywhere in it, its edges included, except an image,
  /// which opens only with the caret inside its source (beside it, the caret steps over it whole). editor/inline.ts
  /// `act`
  public static func active(_ i: MDInline, head: Int?) -> Bool {
    guard let h = head else { return false }
    if case .atom(.image) = i.kind { return h > i.range.lowerBound && h < i.range.upperBound }
    return h >= i.range.lowerBound && h <= i.range.upperBound
  }

  /// What a run's layout leaves out with the caret at `head` (nil: nowhere), in order
  public static func hidden(_ inlines: [MDInline], head: Int?) -> [MDHidden] {
    var out: [MDHidden] = []
    hide(inlines, head, &out)
    return out.sorted { $0.range.lowerBound < $1.range.lowerBound }
  }

  private static func hide(_ ins: [MDInline], _ head: Int?, _ out: inout [MDHidden]) {
    for i in ins {
      // source shown as written (an HTML comment): never hidden
      if case .text = i.kind, i.inner == nil, i.markers.isEmpty { continue }
      let act = active(i, head: head)
      if case .atom = i.kind {
        if !act {
          out.append(MDHidden(i.range, atom: true))
          continue
        }
      }
      if !act { for m in i.markers where !m.isEmpty { out.append(MDHidden(m, atom: false)) } }
      hide(i.children, head, &out)
    }
  }

  /// The constructs that show their source with the caret at `offset` (their ranges, outermost first): a layout made
  /// with the caret there differs from the static one exactly when this is not empty
  public static func openings(at offset: Int, in document: MarkdownDocument) -> [Range<Int>] {
    guard let r = run(at: offset, in: document), r.kind == .inline, r.holds(offset) else { return [] }
    var out: [Range<Int>] = []
    func walk(_ ins: [MDInline]) {
      for i in ins where active(i, head: offset) {
        if case .text = i.kind, i.inner == nil, i.markers.isEmpty { continue }
        out.append(i.range)
        walk(i.children)
      }
    }
    walk(r.inlines)
    return out
  }

  /// The inline construct whose source is exactly `range` in the run at it (an atom a click landed on)
  public static func inline(_ range: Range<Int>, in document: MarkdownDocument) -> MDInline? {
    guard let r = run(at: range.lowerBound, in: document) else { return nil }
    func find(_ ins: [MDInline]) -> MDInline? {
      for i in ins {
        if i.range == range { return i }
        if let f = find(i.children) { return f }
      }
      return nil
    }
    return find(r.inlines)
  }

  /// Where a press on a drawn atom puts the caret (editor/inline.ts caretIn): a formula's at the end of its TeX, before
  /// the closing $; a reference's after its [[; an HTML tag's after it; anything else's after its first character
  public static func caretIn(_ i: MDInline) -> Int {
    switch i.kind {
    case .atom(.math): return i.markers.count > 1 ? i.markers[i.markers.count - 1].lowerBound : i.range.upperBound - 1
    case .atom(.ref): return i.range.lowerBound + 2
    case .atom(.html): return i.range.upperBound
    default: return i.range.lowerBound + 1
    }
  }

  /// The formula whose source the caret is in (open with the caret there): its range, TeX and whether it is display
  public static func formula(at offset: Int, in document: MarkdownDocument) -> (
    range: Range<Int>, latex: String, display: Bool
  )? {
    guard let r = run(at: offset, in: document), r.kind == .inline else { return nil }
    func find(_ ins: [MDInline]) -> (Range<Int>, String, Bool)? {
      for i in ins where offset >= i.range.lowerBound && offset <= i.range.upperBound {
        if case .atom(.math(let latex, let display)) = i.kind { return (i.range, latex, display) }
        if let f = find(i.children) { return f }
      }
      return nil
    }
    return find(r.inlines).map { (range: $0.0, latex: $0.1, display: $0.2) }
  }

  /// The source offsets of the markers shown with the caret at `offset`
  public static func revealed(at offset: Int, in document: MarkdownDocument) -> IndexSet {
    var out = IndexSet()
    guard let r = run(at: offset, in: document), r.kind == .inline else { return out }
    func walk(_ ins: [MDInline]) {
      for i in ins {
        guard active(i, head: offset) else { continue }
        if case .atom = i.kind {
          // an open atom shows all of its source; its markers are what is not its inner text
          for m in i.markers { out.insert(integersIn: m) }
          walk(i.children)
          continue
        }
        for m in i.markers { out.insert(integersIn: m) }
        walk(i.children)
      }
    }
    walk(r.inlines)
    return out
  }

  // MARK: moving

  /// Where a caret at `offset` lands one character on (editor/inline.ts moveH): a run of hidden markers is crossed with
  /// the next character, a hidden atom is one character, and at a run's end the caret goes to the next run. `head` is
  /// where the layout shows markers (the caret itself unless the layout is held still)
  public static func caretStep(from offset: Int, forward: Bool, in document: MarkdownDocument) -> Int {
    caretStep(from: offset, forward: forward, in: document, head: offset)
  }

  public static func caretStep(from offset: Int, forward: Bool, in document: MarkdownDocument, head: Int?) -> Int {
    guard let bi = blockHolding(offset, in: document), let r = run(at: offset, in: document) else { return offset }
    // a place outside the run (an empty paragraph the editor shows, between blocks): to the run on that side
    if offset > r.last {
      if !forward { return r.last }
      return nextRun(after: bi, in: document)?.first ?? offset
    }
    if offset < r.first {
      if forward { return r.first }
      return previousRun(before: bi, in: document)?.last ?? offset
    }
    let q = offset
    if let n = step(r, q, forward: forward, head: head) { return n }
    let rs = runs(of: document.blocks[bi], in: document)
    if let k = rs.firstIndex(where: { $0.first == r.first }) {
      if forward, k + 1 < rs.count { return rs[k + 1].first }
      if !forward, k > 0 { return rs[k - 1].last }
    }
    let other = forward ? nextRun(after: bi, in: document) : previousRun(before: bi, in: document)
    guard let o = other else { return offset }
    return forward ? o.first : o.last
  }

  /// One step inside a run; nil at its edge
  static func step(_ r: MDTextRun, _ q: Int, forward: Bool, head: Int?) -> Int? {
    let hid = r.kind == .inline ? hidden(r.inlines, head: head) : []
    let ns = r.string as NSString
    var i = r.index(q)
    let n = r.offsets.count - 1
    while true {
      if forward ? i >= n : i <= 0 { return i == r.index(q) ? nil : r.offsets[i] }
      let pos = r.offsets[i]
      if let h = hid.first(where: {
        forward
          ? pos >= $0.range.lowerBound && pos < $0.range.upperBound
          : pos > $0.range.lowerBound && pos <= $0.range.upperBound
      }) {
        i = r.index(forward ? h.range.upperBound : h.range.lowerBound)
        if h.atom { return r.offsets[i] }
        continue
      }
      // a character is whole: a surrogate pair, an emoji sequence, a letter and its accents
      i =
        forward
        ? NSMaxRange(ns.rangeOfComposedCharacterSequence(at: i))
        : ns.rangeOfComposedCharacterSequence(at: i - 1).location
      return r.offsets[i]
    }
  }

  // MARK: words

  /// A run's text as the layout shows it with the caret at `head`: hidden markers left out, an atom one U+FFFC; and each
  /// unit's source offset, then the end
  public static func visible(_ r: MDTextRun, head: Int?) -> (text: String, offsets: [Int]) {
    let hid = r.kind == .inline ? hidden(r.inlines, head: head) : []
    var units: [UInt16] = []
    var offs: [Int] = []
    let u = Array(r.string.utf16)
    var i = 0
    var h = 0
    while i < u.count {
      let pos = r.offsets[i]
      while h < hid.count, hid[h].range.upperBound <= pos { h += 1 }
      if h < hid.count, hid[h].range.contains(pos) {
        let x = hid[h]
        if x.atom {
          units.append(0xFFFC)
          offs.append(x.range.lowerBound)
        }
        i = r.index(x.range.upperBound)
        h += 1
        continue
      }
      units.append(u[i])
      offs.append(pos)
      i += 1
    }
    offs.append(r.last)
    return (String(decoding: units, as: UTF16.self), offs)
  }

  /// The words of a text (letters, digits, a Chinese word as the system's tokenizer cuts it), as UTF-16 ranges
  static func words(_ text: String) -> [Range<Int>] {
    let ns = text as NSString
    guard ns.length > 0 else { return [] }
    let tok = CFStringTokenizerCreate(
      nil, text as CFString, CFRange(location: 0, length: ns.length), kCFStringTokenizerUnitWordBoundary, nil)
    var out: [Range<Int>] = []
    while CFStringTokenizerAdvanceToNextToken(tok) != [] {
      let r = CFStringTokenizerGetCurrentTokenRange(tok)
      let piece = ns.substring(with: NSRange(location: r.location, length: r.length))
      if piece.unicodeScalars.contains(where: { CharacterSet.alphanumerics.contains($0) }) {
        out.append(r.location..<(r.location + r.length))
      }
    }
    return out
  }

  /// ⌥→ / ⌥←: to the end of this or the next word, or the start of this or the previous one; past a run's edge into the
  /// next run's first word (or the previous one's last)
  public static func wordStep(from offset: Int, forward: Bool, in document: MarkdownDocument, head: Int?) -> Int {
    guard let r = run(at: offset, in: document) else { return offset }
    let (text, offs) = visible(r, head: head)
    let at = offs.firstIndex { $0 >= offset } ?? offs.count - 1
    let ws = words(text)
    if forward {
      if let w = ws.first(where: { $0.upperBound > at }) { return offs[w.upperBound] }
      if offset < r.last { return r.last }
    } else {
      if let w = ws.last(where: { $0.lowerBound < at }) { return offs[w.lowerBound] }
      if offset > r.first { return r.first }
    }
    let next = caretStep(from: offset, forward: forward, in: document, head: head)
    if next == offset { return offset }
    guard let nr = run(at: next, in: document) else { return next }
    let (nt, no) = visible(nr, head: head)
    let nws = words(nt)
    if forward { return nws.first.map { no[$0.upperBound] } ?? next }
    return nws.last.map { no[$0.lowerBound] } ?? next
  }

  /// The word at a caret place (a double-click): the word it is in or touches, else the character after it
  public static func word(at offset: Int, in document: MarkdownDocument, head: Int?) -> Range<Int> {
    guard let r = run(at: offset, in: document) else { return offset..<offset }
    let (text, offs) = visible(r, head: head)
    let at = offs.firstIndex { $0 >= offset } ?? offs.count - 1
    let ws = words(text)
    if let w = ws.first(where: { $0.contains(at) }) ?? ws.first(where: { $0.upperBound == at }) {
      return offs[w.lowerBound]..<offs[w.upperBound]
    }
    if at < offs.count - 1 {
      let end = NSMaxRange((text as NSString).rangeOfComposedCharacterSequence(at: at))
      return offs[at]..<offs[end]
    }
    return offset..<offset
  }

  /// The whole run at a caret place (a triple-click: a paragraph, a heading's text, a cell, a code block)
  public static func paragraph(at offset: Int, in document: MarkdownDocument) -> Range<Int> {
    guard let r = run(at: offset, in: document) else { return offset..<offset }
    return r.first..<r.last
  }
}

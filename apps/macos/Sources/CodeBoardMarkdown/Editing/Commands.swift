import Foundation

/// A formatting command (a shortcut, a toolbar button)
public enum MDCommand: Sendable, Equatable {
  case toggle(MDMarkKind)
  /// 0 is body text
  case heading(Int)
  /// ⌘= is -1 (a level up), ⌘- is +1
  case headingStep(Int)
  /// ⌘↵ a table row below, ⌘⇧↵ above; ⌘⇧⌫ the row deleted
  case addRow(below: Bool)
  case deleteRow
}

public enum MDMarkKind: Sendable, Equatable {
  case strong, emphasis, underline, code, strike, highlight
  /// the markers it writes (editor/typora.ts: ⌘B **, ⌘I *, ⌘U <u></u>, ⌘E `, ⌘⇧S ~~, ⌘⇧H ==)
  public var markers: (open: String, close: String) {
    switch self {
    case .strong: ("**", "**")
    case .emphasis: ("*", "*")
    case .underline: ("<u>", "</u>")
    case .code: ("`", "`")
    case .strike: ("~~", "~~")
    case .highlight: ("==", "==")
    }
  }
}

extension MarkdownEditing {
  /// What a command does here; nil: nothing
  public static func command(_ c: MDCommand, in state: MDEditState, document: MarkdownDocument) -> MDEdit? {
    switch c {
    case .toggle(let kind): return toggle(kind.markers.open, kind.markers.close, state, document)
    case .heading(let level): return heading(to: { _ in level }, state, document)
    case .addRow(let below): return tableRow(add: below, in: state, document: document)
    case .deleteRow: return tableRow(add: nil, in: state, document: document)
    case .headingStep(let d):
      // ⌘= a level up (body text to 6, 1 stays 1), ⌘- a level down (6 to body text): editor/typora.ts
      return heading(
        to: { c in d < 0 ? ((c == 0 ? 6 : c - 1) == 0 ? 1 : (c == 0 ? 6 : c - 1)) : (c > 0 && c < 6 ? c + 1 : 0) },
        state, document)
    }
  }

  // MARK: headings

  private static func heading(to level: (Int) -> Int, _ state: MDEditState, _ d: MarkdownDocument) -> MDEdit? {
    let ns = state.source as NSString
    let q = state.selection.head
    let c = context(at: q, in: d)
    let current: Int
    switch c.leaf {
    case .paragraph: current = 0
    case .heading(let l): current = l
    default: return nil
    }
    // the #s go at the start of the paragraph's first line, after a quote's or list item's marker
    let start = c.block.lowerBound
    let prefix = current > 0 ? headingPrefix(ns, c.block) : 0
    let n = level(current)
    guard n != current, (0...6).contains(n) else { return nil }
    let write = n == 0 ? "" : String(repeating: "#", count: n) + " "
    let delta = (write as NSString).length - prefix
    let s = state.selection
    let move = { (x: Int) in x >= start + prefix ? x + delta : start + (write as NSString).length }
    return MDEdit(
      range: start..<(start + prefix), replacement: write,
      selection: MDSelection(anchor: move(s.anchor), head: move(s.head)),
      undo: .command)
  }

  // MARK: marks

  /// ⌘B and friends (editor/inline.ts toggleWrap): the selection wrapped in the markers, or unwrapped when they are
  /// around it or at its edges; with nothing selected, the pair put in with the caret between, or, right before the
  /// closing marker of a span the pair makes (⌘B, the text, ⌘B), the caret stepping out over it. A selection over
  /// several runs wraps each run's part on its own
  private static func toggle(_ open: String, _ close: String, _ state: MDEditState, _ d: MarkdownDocument) -> MDEdit? {
    let ns = state.source as NSString
    let sel = state.selection.range
    let nOpen = (open as NSString).length
    let nClose = (close as NSString).length
    func text(_ a: Int, _ b: Int) -> String {
      guard a >= 0, b <= ns.length, a <= b else { return "" }
      return ns.substring(with: NSRange(location: a, length: b - a))
    }
    guard let r = run(at: sel.lowerBound, in: d), r.kind == .inline else { return nil }
    if !r.holds(sel.upperBound) { return wrapEach(open, close, state, d) }
    let a = sel.lowerBound
    let b = sel.upperBound
    if a == b {
      // stepping out of the span the pair closes
      if text(b, b + nClose) == close,
        spans(r.inlines).contains(where: { $0.inner?.upperBound == a && $0.range.upperBound == a + nClose })
      {
        return MDEdit(range: a..<a, replacement: "", selection: MDSelection(a + nClose), undo: .command)
      }
      return MDEdit(range: a..<a, replacement: open + close, selection: MDSelection(a + nOpen), undo: .command)
    }
    if text(a - nOpen, a) == open, text(b, b + nClose) == close {
      let inner = text(a, b)
      return MDEdit(
        range: (a - nOpen)..<(b + nClose), replacement: inner,
        selection: MDSelection(anchor: a - nOpen, head: a - nOpen + (inner as NSString).length), undo: .command)
    }
    if b - a > nOpen + nClose, text(a, a + nOpen) == open, text(b - nClose, b) == close {
      let inner = text(a + nOpen, b - nClose)
      return MDEdit(
        range: a..<b, replacement: inner, selection: MDSelection(anchor: a, head: a + (inner as NSString).length),
        undo: .command)
    }
    // spans the selection only partly covers are taken in whole, so the new markers never interleave with theirs
    var x = a
    var y = b
    var moved = true
    let all = spans(r.inlines)
    while moved {
      moved = false
      for sp in all where sp.inner != nil || isAtom(sp) {
        let whole = isAtom(sp)
        if x > sp.range.lowerBound, x < sp.range.upperBound, y > sp.range.upperBound || whole {
          x = sp.range.lowerBound
          moved = true
        }
        if y > sp.range.lowerBound, y < sp.range.upperBound, x < sp.range.lowerBound || whole {
          y = sp.range.upperBound
          moved = true
        }
      }
    }
    let inner = text(x, y)
    return MDEdit(
      range: x..<y, replacement: open + inner + close,
      selection: MDSelection(anchor: x + nOpen, head: x + nOpen + (inner as NSString).length), undo: .command)
  }

  /// each run's selected words wrapped on their own (spaces at the ends left outside); all unwrapped when every part is
  /// wrapped already
  private static func wrapEach(_ open: String, _ close: String, _ state: MDEditState, _ d: MarkdownDocument) -> MDEdit?
  {
    let ns = state.source as NSString
    let sel = state.selection.range
    let nOpen = (open as NSString).length
    let nClose = (close as NSString).length
    var parts: [Range<Int>] = []
    var q = sel.lowerBound
    while q < sel.upperBound, let r = run(at: q, in: d) {
      let a = max(q, r.first)
      let b = min(sel.upperBound, r.last)
      if r.kind == .inline, a < b {
        var x = a
        var y = b
        while x < y, ns.character(at: x) == 0x20 { x += 1 }
        while y > x, ns.character(at: y - 1) == 0x20 { y -= 1 }
        if x < y { parts.append(x..<y) }
      }
      let next = caretStep(from: r.last, forward: true, in: d, head: nil)
      if next <= q || next <= r.last { break }
      q = next
    }
    guard !parts.isEmpty else { return nil }
    func sub(_ a: Int, _ b: Int) -> String { ns.substring(with: NSRange(location: a, length: b - a)) }
    let wrapped = parts.allSatisfy {
      $0.count > nOpen + nClose && sub($0.lowerBound, $0.lowerBound + nOpen) == open
        && sub($0.upperBound - nClose, $0.upperBound) == close
    }
    var out = ""
    var at = sel.lowerBound
    for p in parts {
      out += sub(at, p.lowerBound)
      out += wrapped ? sub(p.lowerBound + nOpen, p.upperBound - nClose) : open + sub(p.lowerBound, p.upperBound) + close
      at = p.upperBound
    }
    out += sub(at, sel.upperBound)
    let end = sel.lowerBound + (out as NSString).length
    return MDEdit(
      range: sel, replacement: out, selection: MDSelection(anchor: sel.lowerBound, head: end), undo: .command)
  }

  private static func spans(_ ins: [MDInline]) -> [MDInline] { ins.flatMap { [$0] + spans($0.children) } }
  private static func isAtom(_ i: MDInline) -> Bool {
    if case .atom(.annotation) = i.kind { return false }
    if case .atom = i.kind { return true }
    return false
  }

  // MARK: brackets and quotes

  static let pairs: [UInt16: UInt16] = [0x28: 0x29, 0x5B: 0x5D, 0x7B: 0x7D, 0x22: 0x22, 0x27: 0x27]

  /// A typed bracket or quote (editor/pairs.ts, Typora's defaults; Markdown markers * _ ` $ ~ never pair): around a
  /// selection, the pair; at a caret, the pair with the caret between when what follows is nothing, a space or a closing
  /// mark (next to a word a quote is an apostrophe). Not in code. Stepping over a closer the pair put in is the editor's
  /// (EditorCore), which knows which closers it put in
  static func paired(_ s: String, _ state: MDEditState, _ d: MarkdownDocument) -> MDEdit? {
    let u = Array(s.utf16)
    guard u.count == 1, let r = run(at: state.selection.head, in: d), r.kind == .inline,
      !inCode(state.selection.head, r.inlines)
    else { return nil }
    let ns = state.source as NSString
    let ch = u[0]
    let sel = state.selection.range
    let next: UInt16? = sel.upperBound < r.last ? ns.character(at: sel.upperBound) : nil
    let prev: UInt16? = sel.lowerBound > r.first ? ns.character(at: sel.lowerBound - 1) : nil
    guard let close = pairs[ch] else { return nil }
    let open = String(utf16CodeUnits: [ch], count: 1)
    let closing = String(utf16CodeUnits: [close], count: 1)
    if !sel.isEmpty {
      let inner = ns.substring(with: NSRange(location: sel.lowerBound, length: sel.count))
      return MDEdit(
        range: sel, replacement: open + inner + closing,
        selection: MDSelection(anchor: sel.lowerBound + 1, head: sel.upperBound + 1))
    }
    let isWord = { (c: UInt16?) -> Bool in
      guard let c, let sc = Unicode.Scalar(c) else { return false }
      return CharacterSet.alphanumerics.contains(sc) || c == 0x5F
    }
    if close == ch, isWord(prev) || isWord(next) { return nil }
    if let n = next, let sc = Unicode.Scalar(n), !CharacterSet.whitespaces.contains(sc),
      !")]}.,;:!?'\"".unicodeScalars.contains(sc)
    {
      return nil
    }
    return MDEdit(range: sel, replacement: open + closing, selection: MDSelection(sel.lowerBound + 1))
  }

  /// ⌫ between a pair with nothing in it takes both
  static func unpair(_ state: MDEditState, _ d: MarkdownDocument) -> MDEdit? {
    let q = state.selection.head
    guard state.selection.isEmpty, let r = run(at: q, in: d), r.kind == .inline, q > r.first, q < r.last else {
      return nil
    }
    let ns = state.source as NSString
    guard let close = pairs[ns.character(at: q - 1)], ns.character(at: q) == close else { return nil }
    return MDEdit(range: (q - 1)..<(q + 1), replacement: "", selection: MDSelection(q - 1))
  }

  private static func inCode(_ q: Int, _ ins: [MDInline]) -> Bool {
    spans(ins).contains {
      if case .code = $0.kind, let i = $0.inner { return q > i.lowerBound && q < i.upperBound }
      return false
    }
  }
}

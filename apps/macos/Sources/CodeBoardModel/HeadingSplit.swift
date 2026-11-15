import Foundation

// Split by Headings (core split.ts splitHeadings, headingTree; edit/notes.ts splitNoteByHeadings): a Note cut at its
// ATX headings (not in code fences or $$ blocks). The first heading's level L: headings of level ≤ L+1 each start a card,
// deeper ones stay in theirs; the text before the first stays in the Note (with none before, the first part does). Each
// part goes under the one it is under, linked by an arrow from it, laid out as a tree going down.

/// A Note's Markdown cut at its headings
public struct HeadingSplit: Equatable, Sendable {
  public struct Part: Equatable, Sendable {
    public var level: Int
    public var title: String
    public var md: String
    /// The part it is under; -1: the Note itself
    public var parent: Int
  }

  /// What the Note keeps
  public var pre: String
  public var parts: [Part]
  public var cut: Int

  // swift-format-ignore
  nonisolated(unsafe) private static let heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
  nonisolated(unsafe) private static let fence = /^ {0,3}(`{3,}|~{3,})/

  /// nil: no heading to cut at, or the cut leaves only the Note
  public init?(_ md: String) {
    let lines = md.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
      .split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var heads: [(line: Int, level: Int, title: String)] = []
    var open: Substring?
    var math = false
    for (i, l) in lines.enumerated() {
      if let f = open {
        // closed by a run of the same mark at least as long, and nothing after it but white space
        let t = l.drop { $0 == " " }
        if l.count - t.count <= 3, t.hasPrefix(String(repeating: f.first!, count: f.count)),
          t.drop(while: { $0 == f.first! }).allSatisfy(\.isWhitespace)
        {
          open = nil
        }
        continue
      }
      if let m = l.prefixMatch(of: Self.fence) {
        open = m.1
        continue
      }
      if l.trimmingCharacters(in: .whitespaces) == "$$" {
        math.toggle()
        continue
      }
      if math { continue }
      if let m = l.wholeMatch(of: Self.heading) {
        heads.append((i, m.1.count, (m.2.map(String.init) ?? "").trimmingCharacters(in: .whitespaces)))
      }
    }
    guard let first = heads.first else { return nil }
    let cut = first.level + 1
    let split = heads.filter { $0.level <= cut }
    func text(_ a: Int, _ e: Int) -> String {
      var s = lines[a..<e].joined(separator: "\n")
      // leading blank lines and trailing white space (/^\s*\n|\s+$/g)
      var k = s.startIndex
      var last: String.Index?
      while k < s.endIndex, s[k].isWhitespace {
        if s[k] == "\n" { last = k }
        k = s.index(after: k)
      }
      if let last { s = String(s[s.index(after: last)...]) }
      while let c = s.last, c.isWhitespace { s.removeLast() }
      return s
    }
    var parts: [Part] = []
    var stack: [Int] = []
    for (k, h) in split.enumerated() {
      while let top = stack.last, parts[top].level >= h.level { stack.removeLast() }
      parts.append(
        Part(
          level: h.level, title: h.title, md: text(h.line, k + 1 < split.count ? split[k + 1].line : lines.count),
          parent: stack.last ?? -1))
      stack.append(k)
    }
    var pre = text(0, split[0].line)
    // nothing before the first heading: the Note keeps the first part, and what hung under it hangs under the Note
    if pre.isEmpty {
      pre = parts.removeFirst().md
      for i in parts.indices { parts[i].parent = parts[i].parent <= 0 ? -1 : parts[i].parent - 1 }
      if parts.isEmpty { return nil }
    }
    self.pre = pre
    self.parts = parts
    self.cut = cut
  }

  /// Where each part goes (headingTree): under its parent in a row centred on it, a level's tops in line (the row as tall
  /// as its tallest), every card as wide as the Note, which stays. All moved down together until clear of `others` (12
  /// apart), up to 4000
  public static func tree(
    root: (x: Double, y: Double, w: Double, h: Double), heights: [Double], parents: [Int],
    others: [(x: Double, y: Double, w: Double, h: Double)] = [], gx: Double = 28, gy: Double = 56
  ) -> [(x: Double, y: Double)] {
    let w = root.w
    func kids(_ i: Int) -> [Int] { parents.indices.filter { parents[$0] == i } }
    func h(_ i: Int) -> Double { i < 0 ? root.h : heights[i] }
    var rowH: [Double] = []
    var depth: [Int: Int] = [:]
    func walk(_ i: Int, _ d: Int) {
      depth[i] = d
      if rowH.count <= d { rowH.append(0) }
      rowH[d] = max(rowH[d], h(i))
      for k in kids(i) { walk(k, d + 1) }
    }
    walk(-1, 0)
    var rowY = [0.0]
    for d in rowH.indices.dropFirst() { rowY.append(rowY[d - 1] + rowH[d - 1] + gy) }
    var widths: [Int: Double] = [:]
    func wid(_ i: Int) -> Double {
      if let v = widths[i] { return v }
      let ks = kids(i)
      let v = max(w, ks.reduce(0) { $0 + wid($1) } + gx * Double(max(0, ks.count - 1)))
      widths[i] = v
      return v
    }
    var xs: [Int: Double] = [:]
    func put(_ i: Int, _ left: Double) {
      let ks = kids(i)
      xs[i] = left + (wid(i) - w) / 2
      let span = ks.reduce(0) { $0 + wid($1) } + gx * Double(max(0, ks.count - 1))
      var x = left + (wid(i) - span) / 2
      for k in ks {
        put(k, x)
        x += wid(k) + gx
      }
    }
    put(-1, 0)
    let dx = root.x - xs[-1]!
    // JS Math.round: halves up
    func round(_ v: Double) -> Double { (v + 0.5).rounded(.down) }
    let at = parents.indices.map { k in (x: round(xs[k]! + dx), y: round(root.y + rowY[depth[k]!])) }
    func overlaps(_ a: (x: Double, y: Double, w: Double, h: Double), _ b: (x: Double, y: Double, w: Double, h: Double))
      -> Bool
    {
      a.x < b.x + b.w + 12 && b.x < a.x + a.w + 12 && a.y < b.y + b.h + 12 && b.y < a.y + a.h + 12
    }
    var dy = 0.0
    let top = at.map(\.y).min() ?? 0
    for _ in 0..<100 {
      let hit = others.filter { r in at.indices.contains { overlaps((at[$0].x, at[$0].y + dy, w, heights[$0]), r) } }
      if hit.isEmpty { return at.map { ($0.x, $0.y + dy) } }
      dy = max(dy + 1, hit.map { $0.y + $0.h + gy - top }.max()!)
      if dy > 4000 { break }
    }
    return at
  }
}

extension Board {
  /// Split by Headings: each part a new Note as wide as this one and in its Section, linked from the card above it in
  /// the tree, this one keeping the text before; its stored height goes (it has less now). `heights`: the Note's and each
  /// part's, as drawn (else guessed from their lines); `others`: the cards to keep clear of. The new cards' ids, in order;
  /// nil when it is no Note or has nothing to cut
  @discardableResult
  public mutating func splitNoteByHeadings(
    _ id: CardID, heights: (root: Double, parts: [Double])? = nil,
    others: [(x: Double, y: Double, w: Double, h: Double)] = []
  ) -> [CardID]? {
    guard let i = cards.firstIndex(where: { $0.id == id }), case .own(var c) = cards[i].content,
      case .note(var note) = c.body, let sp = HeadingSplit(note.text)
    else { return nil }
    let n = cards[i]
    func est(_ md: String) -> Double {
      Double(60 + md.split(separator: "\n", omittingEmptySubsequences: false).count * 21)
    }
    let hs = sp.parts.indices.map { heights?.parts[$0] ?? est(sp.parts[$0].md) }
    let at = HeadingSplit.tree(
      root: (n.x, n.y, n.width, heights?.root ?? est(sp.pre)), heights: hs, parents: sp.parts.map(\.parent),
      others: others)
    let ids = sp.parts.map { _ in CardID(rawValue: Board.newID("n")) }
    note.text = sp.pre
    c.body = .note(note)
    cards[i].content = .own(c)
    cards[i].height = nil
    for (k, p) in sp.parts.enumerated() {
      cards.append(
        Card(
          id: ids[k], x: at[k].x, y: at[k].y, width: n.width, section: n.section,
          content: .own(CardContent(body: .note(Note(text: p.md))))))
    }
    for (k, p) in sp.parts.enumerated() {
      addArrow(
        ArrowID(rawValue: Board.newID("l")), from: Endpoint(card: p.parent < 0 ? id : ids[p.parent]),
        to: Endpoint(card: ids[k]))
    }
    return ids
  }
}

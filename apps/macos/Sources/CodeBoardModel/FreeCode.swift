import Foundation

// Free code written by hand (core commands/code.ts writeFreeCode): the card's one segment takes the new text, and what
// points at its lines follows them by content (core edit/lines.ts rebaseSegment): hidden lines, Highlights and
// annotations on the segment, arrow ends, sidenotes and stickers on its lines. A line that is gone takes its arrow end
// to the card's header (lost), its sidenote to the whole card (lineRemoved), its sticker to the card's corner.

/// Old line → new line; nil: the line is gone
public typealias LineMap = (Int) -> Int?

extension Board {
  /// Whether a card is Free code: a code card of its own with one segment pinned to no source
  public func isFreeCode(_ id: CardID) -> Bool {
    guard case .own(let c)? = card(id)?.content, case .code(let code) = c.body else { return false }
    return code.segments.count == 1 && code.segments[0].source == nil
  }

  /// Writes a Free code card's text (trailing white space dropped, as the board does)
  public mutating func writeFreeCode(_ id: CardID, text: String) {
    guard isFreeCode(id), let i = cards.firstIndex(where: { $0.id == id }), case .own(var c) = cards[i].content,
      case .code(var code) = c.body
    else { return }
    let old = code.segments[0]
    var trimmed = text
    while let last = trimmed.last, last.isWhitespace { trimmed.removeLast() }
    let lines = trimmed.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    guard lines != old.lines else { return }
    var ns = old
    ns.lines = lines
    let map = Board.lineMap(old.lines, old.firstLine, lines, ns.firstLine)
    ns.hidden = old.hidden.compactMap { Board.mapRange(map, $0) }
    ns.highlights = Board.union(old.highlights.compactMap { Board.mapRange(map, $0) })
    ns.annotations = old.annotations.compactMap { a in
      guard let line = map(a.line), a.line - old.firstLine < old.lines.count else { return nil }
      let was = Array(old.lines[a.line - old.firstLine].utf16)
      let now = Array(lines[line - ns.firstLine].utf16)
      guard a.from >= 0, a.to <= was.count, a.from < a.to else { return nil }
      let words = Array(was[a.from..<a.to])
      // the words where they were, else their first place in the new line
      var from: Int?
      if a.to <= now.count, Array(now[a.from..<a.to]) == words {
        from = a.from
      } else if words.count <= now.count {
        from = (0...(now.count - words.count)).first { Array(now[$0..<($0 + words.count)]) == words }
      }
      guard let f = from else { return nil }
      var b = a
      b.line = line
      b.from = f
      b.to = f + words.count
      return b
    }
    code.segments[0] = ns
    c.body = .code(code)
    cards[i].content = .own(c)
    moveLineRefs(id, ns.id, map)
  }

  /// Arrow ends, sidenotes and stickers on a segment's lines follow `map`
  mutating func moveLineRefs(_ id: CardID, _ seg: SegmentID, _ map: LineMap) {
    for k in arrows.indices {
      for end in [\Arrow.from, \Arrow.to] {
        let e = arrows[k][keyPath: end]
        guard e.card == id, e.segment == seg, let l = e.line else { continue }
        if let m = map(l) {
          arrows[k][keyPath: end].line = m
        } else {
          arrows[k][keyPath: end].segment = nil
          arrows[k][keyPath: end].line = nil
          arrows[k][keyPath: end].lost = true
        }
      }
    }
    for k in sidenotes.indices {
      guard case .card(let c, let s?, let r?, _) = sidenotes[k].anchor, c == id, s == seg else { continue }
      if let to = Board.mapRange(map, r) {
        sidenotes[k].anchor = .card(id, segment: seg, lines: to)
      } else {
        sidenotes[k].anchor = .card(id)
        sidenotes[k].lineRemoved = true
      }
    }
    let width = card(id)?.width ?? 320
    for k in stickers.indices {
      guard case .line(let c, let s, let l) = stickers[k].anchor, c == id, s == seg else { continue }
      // gone: the card's top right corner (core model.ts cornerAt)
      stickers[k].anchor =
        map(l).map { .line(id, segment: seg, line: $0) } ?? .card(id, x: width - 56, y: -11, size: 22)
    }
  }

  /// A range of old lines in the new text: from the first to the last of them that are still there
  static func mapRange(_ map: LineMap, _ r: ClosedRange<Int>) -> ClosedRange<Int>? {
    let now = r.compactMap(map)
    guard let lo = now.min(), let hi = now.max() else { return nil }
    return lo...hi
  }

  /// Lines aligned by content (core diff.ts mapLines, fuzzy): the same lines follow, and a changed line follows the new
  /// line it pairs with (a run of removed and added lines paired in order, similar lines first, the rest side by side)
  public static func lineMap(_ a: [String], _ aStart: Int, _ b: [String], _ bStart: Int) -> LineMap {
    var map: [Int: Int] = [:]
    let diff = b.difference(from: a)
    var removed = Set<Int>()
    var inserted = Set<Int>()
    for c in diff {
      switch c {
      case .remove(let o, _, _): removed.insert(o)
      case .insert(let o, _, _): inserted.insert(o)
      }
    }
    var i = 0
    var j = 0
    while i < a.count || j < b.count {
      if i < a.count, j < b.count, !removed.contains(i), !inserted.contains(j) {
        map[aStart + i] = bStart + j
        i += 1
        j += 1
        continue
      }
      var dels: [Int] = []
      var adds: [Int] = []
      while i < a.count, removed.contains(i) {
        dels.append(i)
        i += 1
      }
      while j < b.count, inserted.contains(j) {
        adds.append(j)
        j += 1
      }
      if dels.isEmpty && adds.isEmpty { break }
      // in order: similar lines paired first, never crossing; those between them side by side
      var p = 0
      var q = 0
      func side(_ pe: Int, _ qe: Int) {
        while p < pe && q < qe {
          map[aStart + dels[p]] = bStart + adds[q]
          p += 1
          q += 1
        }
        p = max(p, pe)
        q = max(q, qe)
      }
      for d in dels.indices where d >= p {
        guard let t = (q..<min(adds.count, q + 12)).first(where: { similar(a[dels[d]], b[adds[$0]]) }) else { continue }
        side(d, t)
        map[aStart + dels[p]] = bStart + adds[q]
        p += 1
        q += 1
      }
      side(dels.count, adds.count)
    }
    return { map[$0] }
  }

  /// Two lines share at least a third of their words (core diff.ts similar)
  static func similar(_ x: String, _ y: String) -> Bool {
    func words(_ s: String) -> [Substring] {
      s.split { !($0.isLetter || $0.isNumber || $0 == "_") }
    }
    let tx = Set(words(x))
    let ty = words(y)
    if tx.isEmpty || ty.isEmpty {
      return x.trimmingCharacters(in: .whitespaces).isEmpty && y.trimmingCharacters(in: .whitespaces).isEmpty
    }
    let common = ty.filter { tx.contains($0) }.count
    return Double(common) / Double(max(tx.count, ty.count)) >= 0.34
  }
}

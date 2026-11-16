import CodeCore
import Foundation

// Free code written by hand (core commands/code.ts writeFreeCode): the card's one segment takes the new text, and what
// points at its lines follows them by content (core edit/lines.ts rebaseSegment; CodeCore's LineAnchors): hidden lines,
// Highlights and annotations on the segment, arrow ends, sidenotes and stickers on its lines. A line that is gone takes its arrow end
// to the card's header (lost), its sidenote to the whole card (lineRemoved), its sticker to the card's corner.

extension Board {
  /// Whether a card is Free code: a code card of its own with one segment pinned to no source
  public func isFreeCode(_ id: CardID) -> Bool {
    guard case .own(let c)? = card(id)?.content, case .code(let code) = c.body else { return false }
    return code.segments.count == 1 && code.segments[0].source == nil
  }

  /// Writes a Free code card's text (trailing white space dropped, as the board does); its language becomes `guessed`,
  /// what the text looks like, unless it was picked by hand or nothing was guessed
  public mutating func writeFreeCode(_ id: CardID, text: String, guessed: String? = nil) {
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
    if old.languagePicked != true, let guessed { ns.language = guessed }
    let map = LineAnchors(from: old.lines, start: old.firstLine, to: lines, start: ns.firstLine)
    ns.hidden = old.hidden.compactMap(map.range)
    ns.highlights = Board.union(old.highlights.compactMap(map.range))
    ns.annotations = old.annotations.compactMap { a in
      guard let line = map.line(a.line), a.line - old.firstLine < old.lines.count else { return nil }
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
  mutating func moveLineRefs(_ id: CardID, _ seg: SegmentID, _ map: LineAnchors) {
    for k in arrows.indices {
      for end in [\Arrow.from, \Arrow.to] {
        let e = arrows[k][keyPath: end]
        guard e.card == id, e.segment == seg, let l = e.line else { continue }
        if let m = map.line(l) {
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
      if let to = map.range(r) {
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
        map.line(l).map { .line(id, segment: seg, line: $0) } ?? .card(id, x: width - 56, y: -11, size: 22)
    }
  }
}

extension Board {
  /// A Free code card's one segment
  public func freeCodeSegment(_ id: CardID) -> Segment? {
    guard isFreeCode(id), case .own(let c)? = card(id)?.content, case .code(let code) = c.body else { return nil }
    return code.segments.first
  }

  /// A Free code card's language picked by hand, or (nil) following its text again: `guessed`, what its text looks like,
  /// else as it was (core commands/code.ts setCodeLang)
  public mutating func setFreeCodeLanguage(_ id: CardID, _ lang: String?, guessed: String? = nil) {
    guard isFreeCode(id), let i = cards.firstIndex(where: { $0.id == id }), case .own(var c) = cards[i].content,
      case .code(var code) = c.body
    else { return }
    code.segments[0].languagePicked = lang == nil ? nil : true
    code.segments[0].language = lang ?? guessed ?? code.segments[0].language
    c.body = .code(code)
    cards[i].content = .own(c)
  }
}

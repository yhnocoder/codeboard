import Foundation

// A segment's lines moved to another version (core edit/lines.ts, edit/highlights.ts fixHighlights): everything pointing
// at its lines follows them by content. And what a version check found of the cards' segments, card by card (core
// commands/versions.ts cardStale, staleCount, nextToReview), which the canvas draws and the shell acts on.

/// What a version check found of a segment that is not as it was (the protocol's Stale less ok, moved, which the board
/// follows by itself, and missing, which shows nothing)
public enum VersionState: Equatable, Sendable {
  /// A newer version has other lines; hiddenOnly: only lines hidden by hand changed; label: the version's
  case changed(hiddenOnly: Bool, label: String)
  /// Its symbol is not there any more (deleted or renamed)
  case lost
  /// A snippet found in several places
  case many
  /// Pinned to HEAD, and the working tree has changes not committed in its lines
  case uncommitted
}

/// A code card's version as its header shows it (core CardStale less missing)
public enum CardVersion: Equatable, Sendable {
  /// A yellow dot: a segment has a newer version
  case changed
  /// A hollow dot: only hidden lines changed
  case hidden
  /// Struck through: a segment's code is not found
  case lost
}

extension CodeCard {
  /// core cardStale: changed before lost, lost before hidden
  public func version(_ states: [SegmentID: VersionState]) -> CardVersion? {
    var hidden = false
    for s in segments {
      switch states[s.id] {
      case .changed(let only, _)?:
        if !only { return .changed }
        hidden = true
      case .lost?, .many?: return .lost
      case .uncommitted?, nil: break
      }
    }
    return hidden ? .hidden : nil
  }

  /// "+ uncommitted": a segment pinned to the working tree, or HEAD's with changes not committed
  public func uncommitted(_ states: [SegmentID: VersionState]) -> Bool {
    segments.contains { s in
      if case .git(_, _, _, true, _)? = s.source { return true }
      return states[s.id] == .uncommitted
    }
  }
}

extension Board {
  /// The board's own code cards (a shared one read in included)
  public var codeCards: [(id: CardID, code: CodeCard)] {
    cards.compactMap { c in
      guard case .own(let k) = c.content, case .code(let code) = k.body else { return nil }
      return (c.id, code)
    }
  }

  /// How many cards have a newer version (the banner's)
  public func staleCount(_ states: [SegmentID: VersionState]) -> Int {
    codeCards.count { $0.code.version(states) == .changed }
  }

  /// The next card Review One by One opens: one with a newer version, or with changes only in hidden lines
  public func nextToReview(_ states: [SegmentID: VersionState]) -> CardID? {
    codeCards.first { [.changed, .hidden].contains($0.code.version(states)) }?.id
  }

  // MARK: Following lines

  /// core lineMapOf's result: an old line's new line, nil when it is not in the new version
  public typealias LineMap = (Int) -> Int?

  /// The first and last new lines of old lines a…e still there
  static func mapRange(_ map: LineMap, _ r: ClosedRange<Int>) -> ClosedRange<Int>? {
    let ls = r.compactMap(map)
    guard let lo = ls.min(), let hi = ls.max() else { return nil }
    return lo...hi
  }

  /// core rebaseSegment: the card's segment of `ns`'s id becomes `ns` (Update to a new version, a move followed), with
  /// its hidden lines, Highlights and annotations moved by `map` (those whose lines are gone dropped); arrow ends,
  /// sidenotes and stickers on its lines follow, and what was on a removed line goes to the card (an arrow end lost, a
  /// sidenote on the whole card marked lineRemoved, a sticker to the card's top right corner). `review`: the sidenotes
  /// whose lines changed are marked for a second look with it (an Update's version label). Then the card's Highlights
  /// and the sidenotes on them are brought back in step
  public mutating func rebaseSegment(_ card: CardID, _ ns: Segment, map: LineMap, review: String? = nil) {
    guard let i = cards.firstIndex(where: { $0.id == card }), case .own(var k) = cards[i].content,
      case .code(var code) = k.body, let si = code.segments.firstIndex(where: { $0.id == ns.id })
    else { return }
    let old = code.segments[si]
    code.segments[si] = Self.remapMarks(ns, old, map)
    k.body = .code(code)
    cards[i].content = .own(k)
    moveLineRefs(card, old, code.segments[si], map, review: review)
    fixHighlights(card)
    selfCheck()
  }

  /// core remapSegMarks: `ns` with the old segment's hidden lines, Highlights and annotations moved by `map`. An
  /// annotation keeps its words: where they were on its line, else their first place on the new line, else it goes
  public static func remapMarks(_ ns: Segment, _ old: Segment, _ map: LineMap) -> Segment {
    var out = ns
    out.hidden = old.hidden.compactMap { mapRange(map, $0) }
    out.highlights = union(old.highlights.compactMap { mapRange(map, $0) })
    out.annotations = old.annotations.compactMap { a in
      let was = Array(lineText(old, a.line).utf16)
      guard let line = map(a.line), a.from >= 0, a.from < a.to, a.to <= was.count,
        line >= ns.firstLine, line <= ns.lastLine
      else { return nil }
      let words = Array(was[a.from..<a.to])
      let t = Array(ns.lines[line - ns.firstLine].utf16)
      let from: Int
      if a.to <= t.count, Array(t[a.from..<a.to]) == words {
        from = a.from
      } else if let at = firstIndex(of: words, in: t) {
        from = at
      } else {
        return nil
      }
      var m = a
      m.line = line
      m.from = from
      m.to = from + words.count
      return m
    }
    return out
  }

  private static func lineText(_ s: Segment, _ line: Int) -> String {
    let k = line - s.firstLine
    return s.lines.indices.contains(k) ? s.lines[k] : ""
  }

  private static func firstIndex(of w: [UInt16], in t: [UInt16]) -> Int? {
    guard !w.isEmpty, w.count <= t.count else { return nil }
    return (0...(t.count - w.count)).first { t[$0..<($0 + w.count)].elementsEqual(w) }
  }

  /// core moveLineRefs: arrow ends, sidenotes and stickers on the segment's lines follow `map`
  mutating func moveLineRefs(_ card: CardID, _ old: Segment, _ ns: Segment, _ map: LineMap, review: String?) {
    func move(_ e: inout Endpoint) {
      guard e.card == card, e.segment == ns.id, let l = e.line else { return }
      if let m = map(l) {
        e.line = m
      } else {
        e.segment = nil
        e.line = nil
        e.lost = true
      }
    }
    for i in arrows.indices {
      move(&arrows[i].from)
      move(&arrows[i].to)
    }
    for i in sidenotes.indices {
      guard case .card(let c, let s?, let lines?, _) = sidenotes[i].anchor, c == card, s == ns.id else { continue }
      if let review, Self.linesChanged(old, ns, map, lines) { sidenotes[i].review = review }
      if let r = Self.mapRange(map, lines) {
        sidenotes[i].anchor = .card(card, segment: s, lines: r)
      } else {
        sidenotes[i].anchor = .card(card)
        sidenotes[i].lineRemoved = true
      }
    }
    let width = self.card(card)?.width ?? 320
    for i in stickers.indices {
      guard case .line(let c, let s, let l) = stickers[i].anchor, c == card, s == ns.id else { continue }
      // core cornerOf: the card's top right corner
      stickers[i].anchor =
        map(l).map { .line(card, segment: s, line: $0) } ?? .card(card, x: width - 56, y: -11, size: 22)
    }
  }

  /// Old lines a…e are not all in the new segment as they were
  static func linesChanged(_ old: Segment, _ ns: Segment, _ map: LineMap, _ r: ClosedRange<Int>) -> Bool {
    r.contains { l in map(l).map { lineText(old, l) != lineText(ns, $0) } ?? true }
  }

  /// core fixHighlights for one card: each segment's Highlights and line sidenotes cut to its lines; a sidenote that goes
  /// along with the card makes its lines a Highlight, overlapping ones merge, and its sidenotes move to the merged one
  /// (marked "widened" for a second look when that grew their lines). Board-only sidenotes keep their own lines
  mutating func fixHighlights(_ card: CardID) {
    guard let i = cards.firstIndex(where: { $0.id == card }), case .own(var k) = cards[i].content,
      case .code(var code) = k.body
    else { return }
    for si in code.segments.indices {
      let s = code.segments[si]
      func clamp(_ r: ClosedRange<Int>) -> ClosedRange<Int> {
        let p = min(max(r.lowerBound, s.firstLine), s.lastLine)
        return p...max(p, min(r.upperBound, s.lastLine))
      }
      let notes = sidenotes.indices.filter { n in
        guard case .card(let c, let sg?, _?, _) = sidenotes[n].anchor else { return false }
        return c == card && sg == s.id
      }
      for n in notes {
        if let l = sidenotes[n].anchor.lines?.range, clamp(l) != l {
          sidenotes[n].anchor = .card(card, segment: s.id, lines: clamp(l))
        }
      }
      let shared = notes.filter { !sidenotes[$0].boardOnly }
      let own = s.highlights.filter { $0.upperBound >= s.firstLine && $0.lowerBound <= s.lastLine }.map(clamp)
      let rs = Self.union(own + shared.compactMap { sidenotes[$0].anchor.lines?.range })
      code.segments[si].highlights = rs
      for n in shared {
        guard let l = sidenotes[n].anchor.lines?.range,
          let r = rs.first(where: { $0.contains(l.lowerBound) && $0.contains(l.upperBound) }), r != l
        else { continue }
        sidenotes[n].review = "widened"
        sidenotes[n].anchor = .card(card, segment: s.id, lines: r)
      }
    }
    k.body = .code(code)
    cards[i].content = .own(k)
  }
}

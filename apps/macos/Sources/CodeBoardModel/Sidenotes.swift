import Foundation

// Sidenotes as commands (core commands/notes.ts, edit/highlights.ts, edit/notes.ts): added on a spot (a whole card, a
// Note's block, a Section, a point) or on lines of a code card, where they make or grow a Highlight; written, deleted,
// moved when free; questions resolved and answered. Text and code sidenotes only (stage 5); "why" lines, Always Show,
// variants and review marks are kept in the file as they are.

/// Where a sidenote's marker sits: a whole card, a Note's block, a Section or a point (core spotKey). Sidenotes on lines
/// have none: they are on a code card's Highlight
public enum Spot: Hashable, Sendable {
  case card(CardID)
  case block(CardID, BlockRef)
  case section(SectionID)
  case point(x: Double, y: Double)

  /// What a new sidenote here is anchored to
  public var anchor: Anchor {
    switch self {
    case .card(let c): .card(c)
    case .block(let c, let b): .card(c, block: b)
    case .section(let s): .section(s)
    case .point(let x, let y): .point(x: x, y: y)
    }
  }
}

/// Lines of one segment of a code card: a Highlight, or lines selected
public struct Lines: Hashable, Sendable {
  public var card: CardID
  public var segment: SegmentID
  public var range: ClosedRange<Int>

  public init(card: CardID, segment: SegmentID, range: ClosedRange<Int>) {
    self.card = card
    self.segment = segment
    self.range = range
  }
}

extension Anchor {
  /// The spot its marker sits at; nil on lines
  public var spot: Spot? {
    switch self {
    case .card(_, _, .some, _): nil
    case .card(let c, _, nil, let b?): .block(c, b)
    case .card(let c, _, nil, nil): .card(c)
    case .section(let s): .section(s)
    case .point(let x, let y): .point(x: x, y: y)
    }
  }

  /// The lines it is on, when it is on lines
  public var lines: Lines? {
    if case .card(let c, let s?, let l?, _) = self { Lines(card: c, segment: s, range: l) } else { nil }
  }
}

extension Sidenote {
  /// Its question, if it is one
  public var question: Question? {
    if case .text(let t) = body { t.question } else { nil }
  }

  /// A question not resolved yet
  public var isOpenQuestion: Bool { question.map { !$0.done } ?? false }
}

extension Board {
  public func sidenote(_ id: SidenoteID) -> Sidenote? { sidenotes.first { $0.id == id } }

  /// The sidenotes at a spot, in the board's order
  public func sidenotes(at spot: Spot) -> [Sidenote] { sidenotes.filter { $0.anchor.spot == spot } }

  /// The sidenotes on lines inside these
  public func sidenotes(on l: Lines) -> [Sidenote] {
    sidenotes.filter { n in
      guard let m = n.anchor.lines else { return false }
      return m.card == l.card && m.segment == l.segment && l.range.contains(m.range.lowerBound)
        && l.range.contains(m.range.upperBound)
    }
  }

  /// A code card's own segment (a shared card's lines are in its shared file, not here)
  func segment(_ card: CardID, _ seg: SegmentID) -> Segment? {
    guard case .own(let c)? = self.card(card)?.content, case .code(let code) = c.body else { return nil }
    return code.segments.first { $0.id == seg }
  }

  private mutating func updateSegment(_ card: CardID, _ seg: SegmentID, _ f: (inout Segment) -> Void) {
    guard let i = cards.firstIndex(where: { $0.id == card }), case .own(var c) = cards[i].content,
      case .code(var code) = c.body, let k = code.segments.firstIndex(where: { $0.id == seg })
    else { return }
    f(&code.segments[k])
    c.body = .code(code)
    cards[i].content = .own(c)
  }

  /// The Highlights the board shows on a segment (core shownRanges): the segment's own, and the lines of the sidenotes
  /// this board keeps for itself (board-only), ones that overlap or nest shown as one
  public func highlights(_ card: CardID, _ seg: SegmentID, own: [ClosedRange<Int>]? = nil) -> [ClosedRange<Int>] {
    let base = own ?? segment(card, seg)?.highlights ?? []
    let local = sidenotes.compactMap { n -> ClosedRange<Int>? in
      guard n.boardOnly, let l = n.anchor.lines, l.card == card, l.segment == seg else { return nil }
      return l.range
    }
    return local.isEmpty ? base : Board.union(base + local)
  }

  /// Ranges that overlap or nest, as one each; sorted
  static func union(_ rs: [ClosedRange<Int>]) -> [ClosedRange<Int>] {
    var out: [ClosedRange<Int>] = []
    for r in rs.sorted(by: { $0.lowerBound < $1.lowerBound }) {
      if let last = out.last, r.lowerBound <= last.upperBound {
        out[out.count - 1] = last.lowerBound...max(last.upperBound, r.upperBound)
      } else {
        out.append(r)
      }
    }
    return out
  }

  /// The Highlight shown on a segment that holds these lines, else the lines themselves
  public func highlight(holding l: Lines) -> ClosedRange<Int> {
    highlights(l.card, l.segment).first { $0.contains(l.range.lowerBound) && $0.contains(l.range.upperBound) }
      ?? l.range
  }

  // MARK: Commands

  /// A text sidenote added (a question when `question` is given: when it was asked, ms since 1970). On lines it goes on
  /// the Highlight of those lines, made, or grown over the ones they overlap (core addHighlight, with the sidenotes on
  /// them); on a shared card it is this board's own (its lines are this board's Highlight). False when its anchor is
  /// not there or the text is blank
  @discardableResult
  public mutating func addSidenote(_ id: SidenoteID, text: String, at anchor: Anchor, question: Double? = nil) -> Bool {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, holds(anchor) else { return false }
    var n = Sidenote(
      id: id, anchor: anchor, body: .text(TextNote(text: t, question: question.map { Question(at: $0) })))
    if let l = anchor.lines {
      if case .shared? = card(l.card)?.content {
        n.boardOnly = true
      } else if let s = segment(l.card, l.segment) {
        let a = max(s.firstLine, min(l.range.lowerBound, s.lastLine))
        let r = addHighlight(l.card, l.segment, a...max(a, min(l.range.upperBound, s.lastLine)))
        n.anchor = .card(l.card, segment: l.segment, lines: r)
      }
    }
    sidenotes.append(n)
    selfCheck()
    return true
  }

  /// Whether what a sidenote would be on is there
  func holds(_ a: Anchor) -> Bool {
    switch a {
    case .card(let c, let s, let lines, _):
      guard let card = card(c) else { return false }
      guard let s else { return lines == nil }
      if case .shared = card.content { return lines != nil }
      return segment(c, s) != nil && lines != nil
    case .section(let s): return section(s) != nil
    case .point: return true
    }
  }

  /// Lines a…z of a segment highlighted: the segment's own Highlights they overlap merge with them into one, and the
  /// sidenotes that go along with the card on those move to it. The Highlight they are in now
  mutating func addHighlight(_ card: CardID, _ seg: SegmentID, _ lines: ClosedRange<Int>) -> ClosedRange<Int> {
    let own = segment(card, seg)?.highlights ?? []
    let hit = own.filter { $0.overlaps(lines) }
    let r =
      min(
        lines.lowerBound, hit.map(\.lowerBound).min() ?? .max)...max(
        lines.upperBound, hit.map(\.upperBound).max() ?? .min)
    if hit.count == 1, hit[0] == r { return r }
    updateSegment(card, seg) { s in s.highlights = Board.union(s.highlights.filter { !hit.contains($0) } + [r]) }
    for i in sidenotes.indices where !sidenotes[i].boardOnly {
      guard let l = sidenotes[i].anchor.lines, l.card == card, l.segment == seg,
        hit.contains(where: { $0.contains(l.range.lowerBound) && $0.contains(l.range.upperBound) })
      else { continue }
      sidenotes[i].anchor = .card(card, segment: seg, lines: r)
    }
    return r
  }

  /// A text sidenote's Markdown; written blank it goes (a text sidenote is only its text). Unchanged: nothing
  public mutating func writeSidenote(_ id: SidenoteID, _ text: String) {
    guard let i = sidenotes.firstIndex(where: { $0.id == id }), case .text(var t) = sidenotes[i].body else { return }
    let v = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if v.isEmpty { return deleteSidenotes([id]) }
    guard t.text != v else { return }
    t.text = v
    sidenotes[i].body = .text(t)
    selfCheck()
  }

  /// Sidenotes deleted; a Highlight they leave stays (it takes no room)
  public mutating func deleteSidenotes(_ ids: Set<SidenoteID>) {
    sidenotes.removeAll { ids.contains($0.id) }
    selfCheck()
  }

  /// Remove Highlight (a lines popup's delete): the segment's own Highlights inside these lines, and every sidenote on
  /// them, this board's own ones too (core removeHighlights)
  public mutating func removeHighlight(_ l: Lines) {
    let inside = { (r: ClosedRange<Int>) in l.range.contains(r.lowerBound) && l.range.contains(r.upperBound) }
    updateSegment(l.card, l.segment) { s in s.highlights.removeAll(where: inside) }
    deleteSidenotes(Set(sidenotes(on: l).map(\.id)))
  }

  /// A question resolved, or opened again; only the user's check does this (an answer leaves it open)
  public mutating func setQuestionDone(_ id: SidenoteID, _ done: Bool) {
    updateQuestion(id) { $0.done = done }
  }

  /// An answer under a question, its newest (oldest first); blank: none. False when there was none to add
  @discardableResult
  public mutating func addAnswer(_ id: SidenoteID, answer: String, text: String, at: Double) -> Bool {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, sidenote(id)?.question != nil else { return false }
    updateQuestion(id) { $0.answers.append(Question.Answer(id: answer, text: t, at: at)) }
    return true
  }

  /// An answer's Markdown; written blank it goes
  public mutating func writeAnswer(_ id: SidenoteID, answer: String, text: String) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    updateQuestion(id) { q in
      guard let k = q.answers.firstIndex(where: { $0.id == answer }) else { return }
      if t.isEmpty { q.answers.remove(at: k) } else { q.answers[k].text = t }
    }
  }

  private mutating func updateQuestion(_ id: SidenoteID, _ f: (inout Question) -> Void) {
    guard let i = sidenotes.firstIndex(where: { $0.id == id }), case .text(var t) = sidenotes[i].body,
      var q = t.question
    else { return }
    f(&q)
    t.question = q
    sidenotes[i].body = .text(t)
    selfCheck()
  }

  /// Free sidenotes moved: to another point, or onto a card or a Note's block, which they are then on. Ones not free stay
  public mutating func moveFreeSidenotes(_ ids: Set<SidenoteID>, to spot: Spot) {
    guard holds(spot.anchor) else { return }
    var to = spot
    if case .point(let x, let y) = spot { to = .point(x: x.rounded(), y: y.rounded()) }
    for i in sidenotes.indices where ids.contains(sidenotes[i].id) {
      if case .point = sidenotes[i].anchor { sidenotes[i].anchor = to.anchor }
    }
    selfCheck()
  }
}

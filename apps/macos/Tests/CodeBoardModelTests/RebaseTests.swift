import Foundation
import Testing

@testable import CodeBoardModel

// A segment moved to another version (core edit/lines.ts rebaseSegment, packages/core/test/edit.test.ts and
// highlights.test.ts), and what a version check found, card by card (core commands/versions.ts cardStale, staleCount,
// nextToReview). The line maps are the ones core's lineMapOf gives for these texts (AlignTests checks the first)

private func cid(_ s: String) -> CardID { CardID(rawValue: s) }
private func nid(_ s: String) -> SidenoteID { SidenoteID(rawValue: s) }
private let s1 = SegmentID(rawValue: "s1")

private func seg(_ start: Int, _ lines: [String], commit: String = "x") -> Segment {
  Segment(
    id: s1, source: .git(repository: nil, commit: commit, path: "a.py", uncommitted: false, checkout: nil),
    language: "python", firstLine: start, lines: lines)
}

private func code(_ id: String, _ s: Segment) -> Card {
  Card(id: cid(id), x: 0, y: 0, width: 400, content: .own(CardContent(body: .code(CodeCard(segments: [s])))))
}

private func note(_ id: String, _ lines: ClosedRange<Int>, card: String = "a") -> Sidenote {
  Sidenote(id: nid(id), anchor: .card(cid(card), segment: s1, lines: lines), body: .text(TextNote(text: id)))
}

private func star(_ id: String, line: Int) -> Sticker {
  Sticker(id: StickerID(rawValue: id), glyph: .builtin(.star), anchor: .line(cid("a"), segment: s1, line: line))
}

extension Board {
  fileprivate func s(_ card: String = "a") -> Segment { segment(cid(card), s1)! }
}

private let old = seg(10, ["def f():", "    x = 1", "    y = 2", "    return x + y"])

private func board() -> Board {
  var a = old
  a.hidden = [11...11]
  a.highlights = [11...11, 12...13]
  return Board(
    id: BoardID(rawValue: "b"), cards: [code("a", a), code("z", seg(1, ["pass"]))],
    arrows: [
      Arrow(
        id: ArrowID(rawValue: "l1"), from: Endpoint(card: cid("a"), segment: s1, line: 13), to: Endpoint(card: cid("z"))
      ),
      Arrow(
        id: ArrowID(rawValue: "l2"), from: Endpoint(card: cid("z")), to: Endpoint(card: cid("a"), segment: s1, line: 12)
      ),
    ],
    sidenotes: [note("n1", 12...13), note("n2", 11...11)], stickers: [star("k1", line: 13), star("k2", line: 11)])
}

@Suite struct RebaseSegmentTests {
  @Test func movesHiddenRangesHighlightsBothArrowEndsAndSidenotesWithTheContent() {
    var b = board()
    // two lines added at the top, x = 1 removed
    let map = [10: 22, 12: 23, 13: 24]
    b.rebaseSegment(
      cid("a"), seg(20, ["import os", "", "def f():", "    y = 2", "    return x + y"], commit: "y"), map: { map[$0] })
    let s = b.s()
    #expect(s.firstLine == 20 && s.lastLine == 24)
    #expect(s.hidden.isEmpty, "the hidden line is gone")
    #expect(s.highlights == [23...24])
    #expect(b.arrows[0].from == Endpoint(card: cid("a"), segment: s1, line: 24))
    #expect(b.arrows[1].to == Endpoint(card: cid("a"), segment: s1, line: 23))
    #expect(!b.arrows.contains { $0.from.lost || $0.to.lost })
    #expect(b.sidenotes[0].anchor == .card(cid("a"), segment: s1, lines: 23...24))
    #expect(b.sidenotes[1].anchor == .card(cid("a")) && b.sidenotes[1].lineRemoved)
    #expect(b.stickers[0].anchor == .line(cid("a"), segment: s1, line: 24))
    #expect(b.stickers[1].anchor == .card(cid("a"), x: 344, y: -11, size: 22), "its line gone: the card's top right")
    #expect(b.sidenotes.allSatisfy { $0.review == nil }, "no review asked")
  }

  @Test func shiftsEverythingWhenOnlyThePositionChanged() {
    var b = board()
    var moved = old
    moved.firstLine = 15
    b.rebaseSegment(cid("a"), moved, map: { $0 + 5 })
    let s = b.s()
    #expect(s.hidden == [16...16] && s.highlights == [16...16, 17...18])
    #expect(b.arrows[0].from.line == 18)
    #expect(b.sidenotes[1].anchor.lines?.range == 16...16)
  }

  @Test func anEndWhoseLineIsGoneStaysOnTheCardMarkedLostAndOtherEndsFollowTheDiff() {
    let o = seg(10, ["def f():", "    x = 1", "    return x"])
    var b = Board(
      id: BoardID(rawValue: "b"), cards: [code("a", o), code("z", seg(1, ["pass"]))],
      arrows: [
        Arrow(
          id: ArrowID(rawValue: "l1"), from: Endpoint(card: cid("a"), segment: s1, line: 11),
          to: Endpoint(card: cid("z"))),
        Arrow(
          id: ArrowID(rawValue: "l2"), from: Endpoint(card: cid("z")),
          to: Endpoint(card: cid("a"), segment: s1, line: 11)),
        Arrow(
          id: ArrowID(rawValue: "l3"), from: Endpoint(card: cid("z")),
          to: Endpoint(card: cid("a"), segment: s1, line: 12)),
      ])
    let map = [10: 20, 12: 21]
    b.rebaseSegment(cid("a"), seg(20, ["def f():", "    return x"]), map: { map[$0] })
    #expect(b.arrows[0].from == Endpoint(card: cid("a"), lost: true))
    #expect(b.arrows[1].to == Endpoint(card: cid("a"), lost: true))
    #expect(b.arrows[2].to == Endpoint(card: cid("a"), segment: s1, line: 21), "followed by the diff, not the number")
  }

  @Test func withAReviewLabelTheSidenotesOnChangedLinesAreMarked() {
    var b = Board(
      id: BoardID(rawValue: "b"), cards: [code("a", seg(1, ["def f():", "    g()"]))],
      sidenotes: [note("n1", 2...2), note("n2", 1...1)])
    b.rebaseSegment(cid("a"), seg(1, ["def f():", "    g(1)"], commit: "y"), map: { $0 }, review: "y")
    #expect(b.sidenotes.map(\.review) == ["y", nil])
  }

  @Test func whenLinesMoveAHighlightAndItsNotesMoveWithThem() {
    let text = (1...10).map { "line \($0)" }
    var o = seg(1, text)
    o.highlights = [3...4, 8...9]
    var b = Board(
      id: BoardID(rawValue: "b"), cards: [code("k", o)],
      sidenotes: [note("a", 3...4, card: "k"), note("b", 8...9, card: "k")])
    // lines 5–7 deleted: 8–9 become 5–6, next to 3–4, still apart
    let now = text.enumerated().filter { $0.offset < 4 || $0.offset > 6 }.map(\.element)
    b.rebaseSegment(cid("k"), seg(1, now), map: { l in (5...7).contains(l) ? nil : l > 7 ? l - 3 : l })
    #expect(b.s("k").highlights == [3...4, 5...6])
    #expect(b.sidenotes.map { $0.anchor.lines?.range } == [3...4, 5...6])
  }

  @Test func anAnnotationKeepsItsWordsWhereverTheyAreOnItsLine() {
    var o = seg(1, ["x = compute(a)", "y = other(b)"])
    o.annotations = [
      Annotation(line: 1, from: 4, to: 11, text: "the call"), Annotation(line: 2, from: 4, to: 9, text: "gone"),
    ]
    var b = Board(id: BoardID(rawValue: "b"), cards: [code("a", o)])
    b.rebaseSegment(cid("a"), seg(1, ["result = compute(a)", "y = changed(b)"]), map: { $0 })
    #expect(b.s().annotations.map(\.from) == [9] && b.s().annotations.map(\.text) == ["the call"])
  }
}

@Suite struct CardVersionTests {
  private func two() -> CodeCard {
    var b = seg(30, ["b"])
    b.id = SegmentID(rawValue: "s2")
    return CodeCard(segments: [seg(1, ["a"]), b])
  }

  @Test func aCardShowsChangedBeforeLostAndLostBeforeHiddenOnlyChanges() {
    let s2 = SegmentID(rawValue: "s2")
    let c = two()
    #expect(c.version([:]) == nil)
    #expect(c.version([s1: .changed(hiddenOnly: true, label: "y")]) == .hidden)
    #expect(c.version([s1: .changed(hiddenOnly: true, label: "y"), s2: .lost]) == .lost)
    #expect(c.version([s1: .many]) == .lost)
    #expect(c.version([s1: .lost, s2: .changed(hiddenOnly: false, label: "y")]) == .lost, "in the segments' order")
    #expect(c.version([s1: .changed(hiddenOnly: false, label: "y"), s2: .lost]) == .changed)
    #expect(c.version([s1: .uncommitted]) == nil && c.uncommitted([s1: .uncommitted]))
    var pinned = c
    pinned.segments[1].source = .git(repository: nil, commit: "x", path: "a.py", uncommitted: true, checkout: nil)
    #expect(pinned.uncommitted([:]) && !c.uncommitted([:]))
  }

  @Test func theBannerCountsCardsWithANewVersionAndReviewGoesToTheFirstOne() {
    let b = Board(id: BoardID(rawValue: "b"), cards: [code("a", seg(1, ["a"])), code("z", seg(1, ["z"]))])
    #expect(b.staleCount([s1: .changed(hiddenOnly: false, label: "y")]) == 2, "one segment on two cards")
    #expect(b.staleCount([s1: .changed(hiddenOnly: true, label: "y")]) == 0)
    #expect(b.nextToReview([s1: .changed(hiddenOnly: true, label: "y")]) == cid("a"))
    #expect(b.nextToReview([s1: .lost]) == nil)
  }
}

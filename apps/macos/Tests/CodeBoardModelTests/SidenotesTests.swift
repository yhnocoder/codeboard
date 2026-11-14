import Foundation
import Testing

@testable import CodeBoardModel

// Sidenotes as commands (core commands/notes.ts, edit/highlights.ts): on each kind of anchor, Highlights made and grown by
// sidenotes on lines, questions and their answers, free ones moved, and what goes with a Section or a card

private func cid(_ s: String) -> CardID { CardID(rawValue: s) }
private func nid(_ s: String) -> SidenoteID { SidenoteID(rawValue: s) }
private let s1 = SegmentID(rawValue: "s1")

private func board() -> Board {
  let seg = Segment(
    id: s1, source: nil, language: "python", firstLine: 10, lines: (10...30).map { "x\($0) = \($0)" },
    highlights: [12...14, 20...22])
  return Board(
    id: BoardID(rawValue: "b"),
    cards: [
      Card(
        id: cid("c1"), x: 0, y: 0, width: 400, section: SectionID(rawValue: "g1"),
        content: .own(CardContent(body: .code(CodeCard(segments: [seg]))))),
      Card(id: cid("n1"), x: 500, y: 0, width: 300, content: .own(CardContent(body: .note(Note(text: "# A\n\nB"))))),
      Card(id: cid("sh"), x: 900, y: 0, width: 300, content: .shared),
    ],
    sections: [Section(id: SectionID(rawValue: "g1"), title: "调度", x: -20, y: -40, width: 500, height: 600)])
}

/// A mutating command's answer, for #expect (which takes no mutation)
private enum Ok {
  static func it(_ b: inout Board, _ f: (inout Board) -> Bool) -> Bool { f(&b) }
}

private func lines(_ r: ClosedRange<Int>, _ card: String = "c1") -> Anchor { .card(cid(card), segment: s1, lines: r) }

@Test func aSidenoteGoesOnEachKindOfAnchor() {
  var b = board()
  let block = BlockRef(index: 1, hash: BlockRef.sig("B"))
  let anchors: [Anchor] = [
    .card(cid("n1")), .card(cid("n1"), block: block), .section(SectionID(rawValue: "g1")), .point(x: 40, y: -300),
  ]
  for (i, a) in anchors.enumerated() { #expect(Ok.it(&b) { $0.addSidenote(nid("n\(i)"), text: " 第\(i)条 \n", at: a) }) }
  #expect(b.sidenotes.map(\.anchor) == anchors)
  #expect(b.sidenote(nid("n0"))?.body == .text(TextNote(text: "第0条")), "trimmed")
  #expect(b.sidenotes(at: .card(cid("n1"))).map(\.id) == [nid("n0")])
  #expect(b.sidenotes(at: .block(cid("n1"), block)).map(\.id) == [nid("n1")])
  #expect(b.sidenotes(at: .section(SectionID(rawValue: "g1"))).map(\.id) == [nid("n2")])
  #expect(b.sidenotes(at: .point(x: 40, y: -300)).map(\.id) == [nid("n3")])
  // nothing written, or on what is not there: none
  #expect(!Ok.it(&b) { $0.addSidenote(nid("x"), text: "  ", at: .card(cid("n1"))) })
  #expect(!Ok.it(&b) { $0.addSidenote(nid("x"), text: "x", at: .card(cid("gone"))) })
  #expect(!Ok.it(&b) { $0.addSidenote(nid("x"), text: "x", at: .section(SectionID(rawValue: "gone"))) })
  #expect(b.sidenotes.count == 4 && b.brokenReference == nil)
}

@Test func aSidenoteOnLinesMakesOrGrowsTheirHighlightAndTakesItsLines() {
  var b = board()
  // inside a Highlight: on it, with its lines
  #expect(Ok.it(&b) { $0.addSidenote(nid("a"), text: "a", at: lines(13...13)) })
  #expect(b.sidenote(nid("a"))?.anchor == lines(12...14))
  // lines with none: a new one
  #expect(Ok.it(&b) { $0.addSidenote(nid("b"), text: "b", at: lines(16...17)) })
  #expect(b.segment(cid("c1"), s1)?.highlights == [12...14, 16...17, 20...22])
  // over two: they become one, and the sidenotes on them move to it
  #expect(Ok.it(&b) { $0.addSidenote(nid("c"), text: "c", at: lines(14...20)) })
  #expect(b.segment(cid("c1"), s1)?.highlights == [12...22])
  #expect(b.sidenotes.map(\.anchor) == [lines(12...22), lines(12...22), lines(12...22)])
  #expect(b.sidenotes(on: Lines(card: cid("c1"), segment: s1, range: 12...22)).count == 3)
  // past the segment's end: cut to it
  #expect(Ok.it(&b) { $0.addSidenote(nid("d"), text: "d", at: lines(29...40)) })
  #expect(b.sidenote(nid("d"))?.anchor == lines(29...30))
  #expect(b.brokenReference == nil)
}

@Test func onASharedCardsLinesASidenoteIsThisBoardsOwnHighlight() {
  var b = board()
  #expect(Ok.it(&b) { $0.addSidenote(nid("a"), text: "a", at: lines(3...4, "sh")) })
  #expect(b.sidenote(nid("a"))?.boardOnly == true)
  #expect(b.highlights(cid("sh"), s1) == [3...4])
  // and a board-only one shows with the segment's own ones, overlapping ones as one
  b.sidenotes.append(
    Sidenote(id: nid("l"), anchor: lines(13...16), body: .text(TextNote(text: "l")), boardOnly: true))
  #expect(b.highlights(cid("c1"), s1) == [12...16, 20...22])
}

@Test func removeHighlightTakesItsLinesAndEverySidenoteOnThem() {
  var b = board()
  b.addSidenote(nid("a"), text: "a", at: lines(12...12))
  b.addSidenote(nid("b"), text: "b", at: lines(21...21))
  b.removeHighlight(Lines(card: cid("c1"), segment: s1, range: 12...14))
  #expect(b.segment(cid("c1"), s1)?.highlights == [20...22] && b.sidenotes.map(\.id) == [nid("b")])
}

@Test func writtenBlankASidenoteGoes() {
  var b = board()
  b.addSidenote(nid("a"), text: "a", at: .card(cid("n1")))
  b.writeSidenote(nid("a"), "  新的 [[调度]] \n")
  #expect(b.sidenote(nid("a"))?.body == .text(TextNote(text: "新的 [[调度]]")))
  b.writeSidenote(nid("a"), " \n ")
  #expect(b.sidenotes.isEmpty)
}

@Test func aQuestionIsResolvedOnlyByTheUserAndItsAnswersGoOldestFirst() {
  var b = board()
  #expect(Ok.it(&b) { $0.addSidenote(nid("q"), text: "为什么?", at: .card(cid("c1")), question: 1000) })
  #expect(b.sidenote(nid("q"))?.question == Question(at: 1000) && b.sidenote(nid("q"))?.isOpenQuestion == true)
  #expect(Ok.it(&b) { $0.addAnswer(nid("q"), answer: "a1", text: " 因为 ", at: 2000) })
  #expect(Ok.it(&b) { $0.addAnswer(nid("q"), answer: "a2", text: "还有 [[n1]]", at: 3000) })
  #expect(!Ok.it(&b) { $0.addAnswer(nid("q"), answer: "a3", text: "  ", at: 4000) })
  #expect(b.sidenote(nid("q"))?.question?.answers.map(\.text) == ["因为", "还有 [[n1]]"])
  #expect(b.sidenote(nid("q"))?.isOpenQuestion == true, "an answer leaves it open")
  b.setQuestionDone(nid("q"), true)
  #expect(b.sidenote(nid("q"))?.question?.done == true && b.sidenote(nid("q"))?.isOpenQuestion == false)
  b.setQuestionDone(nid("q"), false)
  #expect(b.sidenote(nid("q"))?.isOpenQuestion == true)
  b.writeAnswer(nid("q"), answer: "a1", text: "因为它等")
  b.writeAnswer(nid("q"), answer: "a2", text: "")
  #expect(b.sidenote(nid("q"))?.question?.answers.map(\.text) == ["因为它等"])
  // a sidenote that is not a question takes no answer
  b.addSidenote(nid("t"), text: "t", at: .card(cid("c1")))
  #expect(!Ok.it(&b) { $0.addAnswer(nid("t"), answer: "x", text: "x", at: 1) })
}

@Test func aFreeSidenoteMovesToAPointOrOntoACardOrBlockAndOnlyFreeOnesMove() {
  var b = board()
  b.addSidenote(nid("f"), text: "f", at: .point(x: 10, y: 10))
  b.addSidenote(nid("c"), text: "c", at: .card(cid("c1")))
  b.moveFreeSidenotes([nid("f"), nid("c")], to: .point(x: 30.4, y: 49.6))
  #expect(b.sidenote(nid("f"))?.anchor == .point(x: 30, y: 50) && b.sidenote(nid("c"))?.anchor == .card(cid("c1")))
  let block = BlockRef(index: 0, hash: BlockRef.sig("# A"))
  b.moveFreeSidenotes([nid("f")], to: .block(cid("n1"), block))
  #expect(b.sidenote(nid("f"))?.anchor == .card(cid("n1"), block: block))
  b.moveFreeSidenotes([nid("f")], to: .point(x: 0, y: 0))
  #expect(b.sidenote(nid("f"))?.anchor == .card(cid("n1"), block: block), "it is not free now")
}

@Test func deletingASectionOrACardDeletesTheirSidenotes() {
  var b = board()
  b.addSidenote(nid("s"), text: "s", at: .section(SectionID(rawValue: "g1")))
  b.addSidenote(nid("c"), text: "c", at: lines(12...12))
  b.addSidenote(nid("f"), text: "f", at: .point(x: 0, y: 0))
  b.delete([.section(SectionID(rawValue: "g1"))])
  #expect(b.sidenotes.map(\.id) == [nid("c"), nid("f")] && b.card(cid("c1"))?.section == nil, "its card stays")
  b.delete([.card(cid("c1"))])
  #expect(b.sidenotes.map(\.id) == [nid("f")])
}

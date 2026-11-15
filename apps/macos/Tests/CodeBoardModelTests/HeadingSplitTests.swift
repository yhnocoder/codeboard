import Foundation
import Testing

@testable import CodeBoardModel

// Split by Headings as main's (core test/split.test.ts): where a Note is cut, how the parts are laid out, and the change

private func titles(_ md: String) -> [String]? {
  HeadingSplit(md)?.parts.map { "\(String(repeating: "#", count: $0.level)) \($0.title) <\($0.parent)" }
}

@Test func startingAtTwoItSplitsTwoAndThreeAndKeepsFourInside() throws {
  let md = "intro\n\n## A\n\na text\n\n### A1\n\n#### deep\n\nstill A1\n\n## B\n\nb text"
  let sp = try #require(HeadingSplit(md))
  #expect(sp.pre == "intro")
  #expect(titles(md) == ["## A <-1", "### A1 <0", "## B <-1"])
  #expect(sp.parts[1].md == "### A1\n\n#### deep\n\nstill A1")
  #expect(sp.parts[0].md == "## A\n\na text")
  #expect(
    titles("x\n\n### A\n\n#### A1\n\n##### keep\n\n#### A2\n\n### B") == [
      "### A <-1", "#### A1 <0", "#### A2 <0", "### B <-1",
    ])
  // a shallower heading later is split too, a top card
  #expect(
    titles("x\n\n### A\n\n#### A1\n\n## Summary\n\n### C") == ["### A <-1", "#### A1 <0", "## Summary <-1", "### C <2"])
}

@Test func headingsInCodeAndMathBlocksAreNotCutAt() {
  #expect(HeadingSplit("just text\n\nmore") == nil)
  #expect(HeadingSplit("x\n\n```py\n# comment\n## two\n```\n\n$$\n# not\n$$") == nil)
  #expect(HeadingSplit("x\n\n~~~~\n## a\n~~~\n## b\n~~~~") == nil)
  #expect(titles("x\n\n```\n# c\n```\n\n## real") == ["## real <-1"])
  #expect(titles("x\n\n## A ##\n\n##") == ["## A <-1", "##  <-1"])
}

@Test func aNoteStartingWithItsHeadingKeepsTheFirstPart() throws {
  let sp = try #require(HeadingSplit("# Title\n\nintro\n\n## A\n\n## B\n\n### B1"))
  #expect(sp.pre == "# Title\n\nintro")
  #expect(sp.parts.map(\.title) == ["A", "B"] && sp.parts.map(\.parent) == [-1, -1])
  #expect(sp.parts[1].md == "## B\n\n### B1")
  #expect(
    HeadingSplit("## Only\n\ntext\n\n### deeper is split\n\n#### but not this")?.parts.map(\.title) == [
      "deeper is split"
    ])
  #expect(HeadingSplit("## Only\n\ntext") == nil)
  let same = try #require(HeadingSplit("## A\n\na\n\n## B\n\n### B1\n\n## C"))
  #expect(same.pre == "## A\n\na")
  #expect(same.parts.map(\.title) == ["B", "B1", "C"] && same.parts.map(\.parent) == [-1, 0, -1])
}

@Test func thePartsMakeATreeGoingDownClearOfOtherCards() {
  let at = HeadingSplit.tree(root: (100, 0, 300, 100), heights: [200, 80, 90, 150], parents: [-1, 0, 0, -1])
  #expect(at[0].y == 156 && at[3].y == 156)
  #expect(at[1].y == 156 + 200 + 56 && at[2].y == at[1].y)
  #expect(at[2].x - at[1].x == 328)
  #expect(at[0].x + 150 == (at[1].x + at[2].x + 300) / 2)
  #expect((at[1].x + at[3].x + 300) / 2 == 250)
  let clear = HeadingSplit.tree(root: (0, 0, 300, 100), heights: [100], parents: [-1], others: [(0, 150, 300, 200)])
  #expect(clear[0].y >= 350)
}

@Test func splittingANoteAddsANotePerPartLinkedDown() throws {
  func board(_ md: String) -> Board {
    Board(
      id: BoardID(rawValue: "b"),
      cards: [
        Card(
          id: CardID(rawValue: "n"), x: 0, y: 0, width: 381, height: 500, section: SectionID(rawValue: "s"),
          content: .own(CardContent(body: .note(Note(text: md)))))
      ],
      sections: [Section(id: SectionID(rawValue: "s"), title: "S", x: -50, y: -50, width: 100, height: 100)])
  }
  func text(_ c: Card?) -> String? {
    if case .own(let k)? = c?.content, case .note(let n) = k.body { n.text } else { nil }
  }
  var b = board("intro\n\n## A\n\na\n\n### A1\n\n## B")
  let made = b.splitNoteByHeadings(CardID(rawValue: "n"))
  let ids = try #require(made)
  #expect(ids.count == 3)
  #expect(text(b.card(CardID(rawValue: "n"))) == "intro" && b.card(CardID(rawValue: "n"))?.height == nil)
  #expect(ids.map { text(b.card($0)) } == ["## A\n\na", "### A1", "## B"])
  let (a, a1, bb) = (ids[0].rawValue, ids[1].rawValue, ids[2].rawValue)
  #expect(b.arrows.map { "\($0.from.card.rawValue)→\($0.to.card.rawValue)" } == ["n→\(a)", "\(a)→\(a1)", "n→\(bb)"])
  #expect(ids.allSatisfy { b.card($0)?.width == 381 && b.card($0)?.section == SectionID(rawValue: "s") })
  #expect(b.card(ids[1])!.y > b.card(ids[0])!.y)
  var none = board("no headings")
  let nothing = none.splitNoteByHeadings(CardID(rawValue: "n"))
  #expect(nothing == nil)
  #expect(none.cards.count == 1 && none.cards[0].height == 500)
}

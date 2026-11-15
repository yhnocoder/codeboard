import Foundation
import Testing

@testable import CodeBoardModel

// Putting on the Shelf and back (core edit/shelf.ts): a Section takes what is in it, arrows touching its cards and the
// stickers on them go along, a card with no height keeps the one it was drawn at, and back in place everything is
// where it was, in front of the other cards
@Suite struct ShelfTests {
  func c(_ s: String) -> CardID { CardID(rawValue: s) }
  func g(_ s: String) -> SectionID { SectionID(rawValue: s) }

  func board() -> Board {
    func note(_ id: String, _ x: Double, _ y: Double, h: Double? = 100, in s: String? = nil) -> Card {
      Card(
        id: c(id), x: x, y: y, width: 200, height: h, section: s.map(g),
        content: .own(CardContent(body: .note(Note(text: id)))))
    }
    return Board(
      id: BoardID(rawValue: "b"),
      cards: [
        note("a", 0, 0, h: nil), note("b", 300, 0), note("m", 20, 420, in: "in"), note("o", 600, 600, in: "out"),
      ],
      arrows: [
        Arrow(id: ArrowID(rawValue: "ab"), from: Endpoint(card: c("a")), to: Endpoint(card: c("b"))),
        Arrow(id: ArrowID(rawValue: "mb"), from: Endpoint(card: c("m")), to: Endpoint(card: c("b"))),
      ],
      sections: [
        Section(id: g("out"), title: "Out", x: 0, y: 300, width: 900, height: 500),
        Section(id: g("in"), title: "In", x: 10, y: 380, width: 300, height: 200, parent: g("out")),
      ],
      sidenotes: [Sidenote(id: SidenoteID(rawValue: "n"), anchor: .card(c("a")), body: .text(TextNote(text: "x")))],
      stickers: [
        Sticker(id: StickerID(rawValue: "k"), glyph: .builtin(.star), anchor: .card(c("a"), x: 4, y: 4, size: nil))
      ]
    )
  }

  @Test func aSectionGoesWithWhatIsInItAndComesBackWhereItWas() throws {
    var b = board()
    let start = b
    let put = b.shelve(cards: [], sections: [g("out")], id: "sh1", at: 1, heights: [:])
    #expect(put)
    let e = try #require(b.shelf.first)
    #expect(e.sections.map(\.id) == [g("out"), g("in")] && Set(e.cards.map(\.id)) == [c("m"), c("o")])
    #expect(e.arrows.map(\.id.rawValue) == ["mb"] && b.arrows.map(\.id.rawValue) == ["ab"])
    #expect(b.sections.isEmpty && b.cards.map(\.id) == [c("a"), c("b")])
    // nothing on the canvas: nothing shelved
    let none = b.shelve(cards: [c("zz")], sections: [], id: "sh2", at: 2)
    #expect(!none)
    let back0 = b.unshelve("sh1")
    let back = try #require(back0)
    #expect(Set(back.cards) == [c("m"), c("o")] && back.sections == [g("out"), g("in")])
    #expect(b.shelf.isEmpty && b.sections == start.sections && Set(b.arrows.map(\.id)) == Set(start.arrows.map(\.id)))
    // in front: last in the stacking order, where they were, in their Sections
    #expect(b.cards.suffix(2).map(\.id) == [c("m"), c("o")])
    #expect(b.card(c("m")) == start.card(c("m")) && b.card(c("o")) == start.card(c("o")))
  }

  @Test func cardsTakeTheirArrowsStickersAndDrawnHeightAndAnArrowToACardStillAwayStaysAway() throws {
    var b = board()
    let one = b.shelve(cards: [c("a")], sections: [], id: "sh1", at: 1, heights: [c("a"): 133, c("b"): 99])
    #expect(one)
    let e = try #require(b.shelf.first)
    #expect(e.cards.first?.measuredHeight == 133 && e.stickers.count == 1 && b.stickers.isEmpty)
    // its sidenote stays with the board, pointing at the card on the Shelf
    #expect(b.sidenotes.count == 1 && b.brokenReference == nil)
    let two = b.shelve(cards: [c("b")], sections: [], id: "sh2", at: 2)
    #expect(two)
    #expect(b.shelf[1].arrows.map(\.id.rawValue) == ["mb"])
    // a back while b is away: their arrow goes to b's entry
    b.unshelve("sh1")
    #expect(b.shelf.count == 1 && b.shelf[0].arrows.map(\.id.rawValue).sorted() == ["ab", "mb"])
    #expect(b.stickers.count == 1 && b.brokenReference == nil)
  }

  @Test func letGoElsewhereItIsInTheSectionItLandsInOrNone() throws {
    var b = board()
    b.shelve(cards: [c("m")], sections: [], id: "sh1", at: 1)
    // moved: not back into its old Section, unless given one where it lands
    b.unshelve("sh1", dx: 1000, dy: 0)
    #expect(b.card(c("m"))?.section == nil && b.card(c("m"))?.x == 1020)
    b.shelve(cards: [c("m")], sections: [], id: "sh2", at: 2)
    b.unshelve("sh2", dx: -1000, dy: 10, into: ["m": g("out")])
    #expect(b.card(c("m"))?.section == g("out") && b.card(c("m"))?.y == 430)
  }

  @Test func removingAnEntryDeletesWhatIsInItAndWhatPointsAtIt() {
    var b = board()
    b.shelve(cards: [c("a")], sections: [], id: "sh1", at: 1)
    b.removeShelfEntry("sh1")
    #expect(b.shelf.isEmpty && b.sidenotes.isEmpty && b.card(c("a")) == nil && b.brokenReference == nil)
  }
}

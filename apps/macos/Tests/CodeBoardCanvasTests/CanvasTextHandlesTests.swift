import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// A Text's and a Box's handles as main's (styles.css .card.text.sel .hw, .mkgrip; .card.text.sel.solo z-index 7): every
// selected one shows its side pills and corner square, none when locked; one selected alone comes up over the cards
// round it, so it and its handles are drawn and pressed over a neighbour it overlaps.

@MainActor @Suite(.serialized) struct CanvasTextHandlesTests {
  static func board() -> Board {
    func box(_ id: String, x: Double, y: Double) -> Card {
      Card(
        id: cid(id), x: x, y: y, width: 130,
        content: .own(CardContent(body: .text(TextCard(text: id, look: .box, wrap: true)))))
    }
    return Board(
      id: BoardID(rawValue: "text-handles"),
      cards: [
        box("a", x: 0, y: 0),
        // over a's right part, after it: drawn over it until a is selected alone
        box("b", x: 100, y: 0),
        Card(
          id: cid("t"), x: 0, y: 300, width: 200,
          content: .own(CardContent(body: .text(TextCard(text: "A note to self", wrap: true))))),
      ])
  }

  @Test func everySelectedTextShowsItsHandlesAndOneAloneComesUpOverItsNeighbours() async throws {
    let r = try await Rig(Self.board(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    func box(_ id: String) throws -> CALayer { c.items[try #require(c.index(of: .card(cid(id))))].box }
    // a alone: its handles, and it over b
    r.doc.select([.card(cid("a"))])
    await r.settle()
    #expect(c.textHandleCards == [cid("a")])
    let (a, b) = (try box("a"), try box("b"))
    #expect(a.superlayer === b.superlayer && a.zPosition > b.zPosition, "a \(a.zPosition), b \(b.zPosition)")
    let overlap = CGPoint(x: 115, y: 15)
    #expect(c.hitCard(overlap) == cid("a"))
    // two selected: each shows its handles, neither comes up
    r.doc.select([.card(cid("a")), .card(cid("t"))])
    await r.settle()
    #expect(c.textHandleCards == [cid("a"), cid("t")])
    #expect(c.hitCard(overlap) == cid("b"))
    // locked: none
    r.doc.edit("Lock") { $0.setLocked([.card(cid("t"))], true) }
    await r.settle()
    #expect(c.textHandleCards == [cid("a")])
  }

  /// Once a card dropped beside it has landed, a Text or Box selected alone is over it again (main: .landing 10 until
  /// landed, .sel.solo 7)
  @Test func aLoneSelectedTextIsOverItsNeighboursOnceTheDropHasLanded() async throws {
    let r = try await Rig(Self.board(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    func z(_ id: String) -> CGFloat { c.index(of: .card(cid(id))).map { c.items[$0].box.zPosition } ?? -9 }
    r.drag(CGPoint(x: 200, y: 15), CGPoint(x: 195, y: 15))
    await r.until("b landed") { z("b") == 0 }
    r.doc.select([.card(cid("a"))])
    await r.settle()
    #expect(z("a") > z("b"), "a \(z("a")), b \(z("b"))")
  }
}

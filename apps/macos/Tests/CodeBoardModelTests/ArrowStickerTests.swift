import Foundation
import Testing

@testable import CodeBoardModel

// Stickers on arrows (the extension's StickerAt `on: {link, t}`): written and read strictly, on an arrow of their own
// scope (the board's, or their shelf entry's); gone with their arrow, and on the shelf and back with it. And a sub-board
// card's preview in two columns.
@Suite struct ArrowStickerTests {
  let file = URL(filePath: "/vault/A.board/board.json")
  func c(_ s: String) -> CardID { CardID(rawValue: s) }
  func a(_ s: String) -> ArrowID { ArrowID(rawValue: s) }
  func k(_ s: String) -> StickerID { StickerID(rawValue: s) }

  func board() -> Board {
    func note(_ id: String, _ x: Double) -> Card {
      Card(id: c(id), x: x, y: 0, width: 200, height: 100, content: .own(CardContent(body: .note(Note(text: id)))))
    }
    return Board(
      id: BoardID(rawValue: "b"), cards: [note("x", 0), note("y", 400), note("z", 800)],
      arrows: [
        Arrow(id: a("xy"), from: Endpoint(card: c("x")), to: Endpoint(card: c("y"))),
        Arrow(id: a("yz"), from: Endpoint(card: c("y")), to: Endpoint(card: c("z"))),
      ],
      stickers: [
        Sticker(id: k("k1"), glyph: .builtin(.zap), anchor: .arrow(a("xy"), position: 0.42, x: -16, y: -40, size: 24)),
        Sticker(id: k("k2"), glyph: .builtin(.bug), anchor: .arrow(a("yz"), position: 1, x: 0, y: 0, size: nil)),
      ])
  }

  @Test func aStickerOnAnArrowRoundTripsAsTheFormatWritesIt() throws {
    let b = board()
    let data = try b.encoded()
    #expect(try Board(decoding: data, file: file) == b)
    #expect(
      String(decoding: data, as: UTF8.self).contains(
        """
              "anchor": {
                "arrow": {
                  "arrow": "xy",
                  "position": 0.42,
                  "size": 24,
                  "x": -16,
                  "y": -40
                }
              },
        """))
    #expect(b.stickers[0].anchor.arrow == a("xy") && b.stickers[0].anchor.card == nil)
    #expect(b.stickers[0].size == 24 && b.stickers[1].size == Sticker.defaultSize)
  }

  @Test func aStickerOnAnArrowIsRefusedOffItsScopeOrOutOfBounds() throws {
    func problem(_ change: (inout Board) -> Void) throws -> String? {
      var b = board()
      change(&b)
      do {
        _ = try Board(decoding: try b.encoded(), file: file)
        return nil
      } catch VaultError.malformed(_, let why) {
        return why
      }
    }
    let cases: [(String, (inout Board) -> Void)] = [
      ("sticker k1: no arrow gone", { $0.stickers[0].anchor = .arrow(a("gone"), position: 0, x: 0, y: 0, size: nil) }),
      (
        "sticker k1: position 1.5 on its arrow",
        { $0.stickers[0].anchor = .arrow(a("xy"), position: 1.5, x: 0, y: 0, size: nil) }
      ),
      ("sticker k1: size 0.0", { $0.stickers[0].anchor = .arrow(a("xy"), position: 0, x: 0, y: 0, size: 0) }),
      // the board's sticker on a shelf entry's arrow, and a shelf entry's on the board's
      ("sticker k2: no arrow yz", { $0.shelf = [ShelfEntry(id: "e", at: 1, arrows: [$0.arrows.removeLast()])] }),
      ("sticker k2: no arrow yz", { $0.shelf = [ShelfEntry(id: "e", at: 1, stickers: [$0.stickers.removeLast()])] }),
    ]
    for (message, change) in cases {
      let why = try problem(change)
      #expect(why == message)
    }
  }

  /// Deleting an arrow, or a card with its arrows, takes the stickers on them, in the same step
  @Test func anArrowsStickersGoWithIt() throws {
    var b = board()
    var h = History()
    let start = b
    b.delete([.arrow(a("xy"))])
    h.record("Delete", from: start, to: b, selection: ([], []))
    #expect(b.stickers.map(\.id) == [k("k2")] && b.brokenReference == nil)
    _ = h.undo(&b)
    #expect(b == start)
    b.delete([.card(c("z"))])
    #expect(b.arrows.map(\.id) == [a("xy")] && b.stickers.map(\.id) == [k("k1")] && b.brokenReference == nil)
  }

  /// On the shelf with its arrow and back; an arrow that goes to another entry when it comes back takes its sticker
  @Test func anArrowsStickersGoOntoTheShelfAndBackWithIt() throws {
    var b = board()
    let put1 = b.shelve(cards: [c("x")], sections: [], id: "e1", at: 1)
    #expect(put1)
    #expect(b.shelf[0].arrows.map(\.id) == [a("xy")] && b.shelf[0].stickers.map(\.id) == [k("k1")])
    #expect(b.stickers.map(\.id) == [k("k2")] && b.brokenReference == nil)
    let put2 = b.shelve(cards: [c("y")], sections: [], id: "e2", at: 2)
    #expect(put2)
    // x back while y is away: xy waits with y, its sticker with it
    b.unshelve("e1")
    #expect(b.shelf.map(\.id) == ["e2"] && Set(b.shelf[0].arrows.map(\.id)) == [a("xy"), a("yz")])
    #expect(Set(b.shelf[0].stickers.map(\.id)) == [k("k1"), k("k2")] && b.stickers.isEmpty)
    #expect(b.brokenReference == nil)
    b.unshelve("e2")
    #expect(Set(b.stickers.map(\.id)) == [k("k1"), k("k2")] && b.shelf.isEmpty && b.brokenReference == nil)
  }

  /// A sticker put on an arrow here that the other writer deleted keeps the arrow
  @Test func aStickerAddedHereKeepsItsArrowInAMerge() throws {
    var base = board()
    base.stickers = []
    var disk = base
    disk.delete([.arrow(a("xy"))])
    var mine = base
    mine.stickers = [board().stickers[0]]
    let out = Board.merge(base: base, mine: mine, disk: disk)
    #expect(out.arrows.map(\.id).contains(a("xy")) && out.stickers.map(\.id) == [k("k1")] && out.brokenReference == nil)
  }

  /// Resized it stays at its place on its arrow; moved it goes where it is put
  @Test func aStickerOnAnArrowIsResizedInPlaceAndMoved() {
    var b = board()
    b.setStickerSize(k("k1"), 300)
    #expect(b.stickers[0].anchor == .arrow(a("xy"), position: 0.42, x: -16, y: -40, size: 240))
    b.moveSticker(k("k1"), to: .arrow(a("yz"), position: 0.1, x: 4, y: 5, size: nil))
    #expect(b.stickers[0].anchor == .arrow(a("yz"), position: 0.1, x: 4, y: 5, size: nil) && b.brokenReference == nil)
  }

  @Test func aSubBoardsTwoColumnPreviewIsKeptAndOnlyTwoIsWritten() throws {
    let cards = [
      SubBoard(board: BoardID(rawValue: "b2"), twoColumnPreview: true),
      SubBoard(folder: "Kernels", twoColumnPreview: true),
      SubBoard(board: BoardID(rawValue: "b3")),
    ].enumerated().map { i, s in
      Card(id: c("s\(i)"), x: 0, y: 0, width: 400, content: .own(CardContent(body: .board(s))))
    }
    let b = Board(id: BoardID(rawValue: "b"), cards: cards)
    let data = try b.encoded()
    #expect(try Board(decoding: data, file: file) == b)
    let text = String(decoding: data, as: UTF8.self)
    #expect(text.contains(#""board": "b2","#) && text.components(separatedBy: #""previewColumns": 2"#).count == 3)
    for columns in [1, 3] {
      var json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
      var list = json["cards"] as? [[String: Any]] ?? []
      list[2]["content"] = ["board": ["board": "b3", "previewColumns": columns]]
      json["cards"] = list
      #expect(
        throws: VaultError.malformed(file, "cards[2].content.board.previewColumns: \(columns): written only as 2")
      ) {
        try Board(decoding: try JSONSerialization.data(withJSONObject: json), file: file)
      }
    }
  }
}

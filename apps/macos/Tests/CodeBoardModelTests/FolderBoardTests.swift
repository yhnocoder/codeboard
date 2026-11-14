import Foundation
import Testing

@testable import CodeBoardModel

// Folder boards and the vault's file operations: the automatic cards kept in step with the folder, the user's own
// content and positions kept, renames either way, moves that never write over anything, Turn into Board.

private func bid(_ s: String) -> BoardID { BoardID(rawValue: s) }
private func cid(_ s: String) -> CardID { CardID(rawValue: s) }

private func note(_ id: String, x: Double, y: Double, section: String? = nil) -> Card {
  Card(
    id: cid(id), x: x, y: y, width: 200, height: 100, section: section.map { SectionID(rawValue: $0) },
    content: .own(CardContent(body: .note(Note(text: "# \(id)")))))
}

/// What the automatic cards are for, in board order
private func targets(_ b: Board) -> [SubBoard.Target] { b.autoCards.map(\.target) }

@Test func autoCardsComeAndGoWithTheFolderAndTheUsersContentStays() throws {
  var b = Board(
    id: bid("fb"), cards: [note("mine", x: 0, y: 0)],
    arrows: [Arrow(id: ArrowID(rawValue: "a"), from: Endpoint(card: cid("mine")), to: Endpoint(card: cid("mine")))])
  // first: below what the board has, then in rows of four
  var changed = b.keepUp(with: [.board(bid("b1")), .board(bid("b2")), .folder("Sub")])
  #expect(changed)
  #expect(targets(b) == [.board(bid("b1")), .board(bid("b2")), .folder("Sub")])
  let first = b.autoCards[0].card
  #expect(first.x == 0 && first.y == 100 + Board.autoRowGap)
  #expect(b.autoCards[1].card.x == Board.autoWidth + Board.autoGap && b.autoCards[1].card.y == first.y)
  changed = b.keepUp(with: [.board(bid("b1")), .board(bid("b2")), .folder("Sub")])
  #expect(!changed, "nothing to change")
  // the user moves one; one goes: its place is not filled, a new one comes after the last
  let moved = b.autoCards[2].card.id
  if let i = b.cards.firstIndex(where: { $0.id == moved }) { b.cards[i].x = 2000 }
  changed = b.keepUp(with: [.board(bid("b1")), .folder("Sub"), .board(bid("b3"))])
  #expect(changed)
  #expect(targets(b) == [.board(bid("b1")), .folder("Sub"), .board(bid("b3"))])
  #expect(b.card(moved)?.x == 2000, "where the user put it")
  // after the last: its row is past four cards' width, so under it from the first one's left; the gap left as it is
  let sub = try #require(b.card(moved))
  #expect(b.autoCards[2].card.x == 0 && b.autoCards[2].card.y == sub.y + Board.autoHeight + Board.autoRowGap)
  #expect(b.autoCards[0].card.x == 0 && !b.cards.contains { $0.x == Board.autoWidth + Board.autoGap })
  #expect(b.card(cid("mine")) != nil && b.arrows.count == 1, "the user's own")
  // a row is full at four: the next starts a row under the first
  var r = Board(id: bid("r"))
  r.keepUp(with: (1...5).map { .board(bid("x\($0)")) })
  let cards = r.autoCards.map(\.card)
  #expect(cards.map(\.x) == [0, 480, 960, 1440, 0] && cards[4].y == Board.autoHeight + Board.autoRowGap)
  // an automatic card's arrows go with it
  r.arrows.append(Arrow(id: ArrowID(rawValue: "z"), from: Endpoint(card: cards[0].id), to: Endpoint(card: cards[1].id)))
  r.keepUp(with: (2...5).map { .board(bid("x\($0)")) })
  #expect(r.arrows.isEmpty && r.autoCards.count == 4)
}

@Test func aPlainSubBoardCardIsTheUsersAndASecondAutoCardForTheSameGoes() {
  var b = Board(
    id: bid("fb"),
    cards: [
      Card(
        id: cid("plain"), x: 0, y: 0, width: 300, content: .own(CardContent(body: .board(SubBoard(board: bid("b1"))))))
    ])
  b.keepUp(with: [.board(bid("b1"))])
  #expect(b.card(cid("plain")) != nil && b.autoCards.count == 1)
  // two automatic cards for one board (a merge of two writers): one stays
  var twice = b
  twice.cards.append(
    Card(
      id: cid("dup"), x: 0, y: 900, width: 400,
      content: .own(CardContent(body: .board(SubBoard(board: bid("b1"), auto: true))))))
  let dropped = twice.keepUp(with: [.board(bid("b1"))])
  #expect(dropped && twice.autoCards.count == 1)
  // a subfolder renamed in the app keeps its card and place
  var f = Board(id: bid("f"))
  f.keepUp(with: [.folder("Old")])
  let at = f.autoCards[0].card
  let renamed = f.renameFolderCard("Old", to: "New")
  let again = f.keepUp(with: [.folder("New")])
  #expect(
    renamed && !again
      && f.autoCards[0].card
        == Card(
          id: at.id, x: at.x, y: at.y, width: at.width, height: at.height,
          content: .own(CardContent(body: .board(SubBoard(folder: "New")))))
  )
  // one dropped where the pointer was let go stays there
  var d = Board(id: bid("d"))
  d.placeAutoCard(for: .board(bid("in")), x: 700.4, y: -20)
  let moved2 = d.keepUp(with: [.board(bid("in"))])
  #expect(!moved2 && d.autoCards[0].card.x == 700 && d.autoCards[0].card.y == -20)
}

@Test func subBoardCardsRoundTripInTheFile() throws {
  let b = Board(
    id: bid("fb"),
    cards: [
      Card(id: cid("a"), x: 0, y: 0, width: 400, content: .own(CardContent(body: .board(SubBoard(board: bid("x")))))),
      Card(
        id: cid("b"), x: 0, y: 0, width: 400,
        content: .own(CardContent(body: .board(SubBoard(board: bid("y"), auto: true))))),
      Card(id: cid("c"), x: 0, y: 0, width: 400, content: .own(CardContent(body: .board(SubBoard(folder: "Sub"))))),
    ])
  let data = try b.encoded()
  let text = String(decoding: data, as: UTF8.self)
  // a plain card has no `auto`
  #expect(text.contains(#/"board"\s*:\s*\{\s*"board"\s*:\s*"x"\s*\}/#), Comment(rawValue: text))
  #expect(try Board(decoding: data, file: URL(filePath: "/x")) == b)
  // a folder card is always automatic; a card with neither or both is refused
  for bad in [#"{"folder":"Sub"}"#, #"{}"#, #"{"board":"x","folder":"y","auto":true}"#] {
    let json = text.replacing(#/\{\s*"auto"\s*:\s*true\s*,\s*"folder"\s*:\s*"Sub"\s*\}/#, with: bad)
    #expect(json != text)
    #expect(throws: (any Error).self) { try Board(decoding: Data(json.utf8), file: URL(filePath: "/x")) }
  }
}

@Test func folderBoardsAreInTheTreeTitledWithTheirFolder() throws {
  let v = Vault(root: try scratch())
  try v.newFolder(in: "", name: "Engine")
  try v.newBoard(in: "Engine", title: "Step")
  let fb = try v.newFolderBoard(in: "Engine")
  // an ordinary board named like the folder stays ordinary
  try v.newBoard(in: "Engine", title: "Engine")
  let t = try v.tree()
  let engine = try #require(t.folder(at: "Engine"))
  #expect(
    engine.folderBoard == VaultBoard(id: fb.id, title: "Engine", path: "Engine/.folder.board", isFolderBoard: true))
  #expect(engine.boards.map(\.title) == ["Engine", "Step"] && engine.boards.allSatisfy { !$0.isFolderBoard })
  #expect(t.allBoards.contains { $0.id == fb.id })
  #expect(engine.entries == engine.boards.map { .board($0.id) })
  // renaming the folder renames its board
  try v.rename(folder: "Engine", to: "Runtime")
  let r = try #require(try v.tree().folder(at: "Runtime"))
  #expect(r.folderBoard?.title == "Runtime" && r.folderBoard?.id == fb.id)
  #expect(try v.board(at: "Runtime/.folder.board").id == fb.id)
}

@Test func renamesAndMovesNeverWriteOverAnything() throws {
  let v = Vault(root: try scratch())
  let a = try v.newBoard(in: "", title: "Alpha")
  let b = try v.newBoard(in: "", title: "Beta")
  try v.newFolder(in: "", name: "Box")
  let inBox = try v.newBoard(in: "Box", title: "Alpha")
  let before = try files(under: v.root)
  // onto a name in use: refused, nothing changed
  #expect(throws: VaultError.exists(v.url(of: "Beta.board"))) { try v.rename(board: a, to: "Beta") }
  #expect(throws: VaultError.self) { try v.rename(board: a, to: "beta") }
  #expect(throws: VaultError.exists(v.url(of: "Box/Alpha.board"))) { try v.move(a.path, into: "Box") }
  #expect(throws: VaultError.exists(v.url(of: "box"))) { try v.newFolder(in: "", name: "box") }
  #expect(throws: VaultError.exists(v.url(of: "Alpha.board"))) { try v.newBoard(in: "", title: "Alpha") }
  #expect(throws: VaultError.self) { try v.move("Box", into: "Box") }
  #expect(try files(under: v.root) == before)
  // a free name is offered
  #expect(v.freeName(in: "", "alpha", package: true) == "alpha 2")
  #expect(v.freeName(in: "", "Gamma", package: true) == "Gamma")
  #expect(v.freeName(in: "", "BOX", package: false) == "BOX 2")
  // a change of case alone goes through
  let p = try v.rename(board: b, to: "beta")
  let titles = try v.tree().boards.map(\.title)
  #expect(p == "beta.board" && titles.contains("beta"))
  // moved in and out, the id and content kept
  let moved = try v.move(p, into: "Box")
  let movedID = try v.board(at: moved).id
  #expect(moved == "Box/beta.board" && movedID == b.id)
  #expect(throws: VaultError.exists(v.url(of: "Alpha.board"))) { try v.move(inBox.path, into: "") }
  // no hidden leftovers
  let names = try FileManager.default.contentsOfDirectory(atPath: v.root.path)
  #expect(!names.contains { $0.hasPrefix(".") }, "\(names)")
}

@Test func turningCardsIntoABoardTakesWhatIsOnThemAndLeavesAFrame() throws {
  let s = SectionID(rawValue: "s")
  var b = Board(
    id: bid("p"),
    cards: [
      note("a", x: 100, y: 100, section: "s"), note("b", x: 400, y: 100, section: "s"), note("c", x: 1000, y: 0),
    ],
    arrows: [
      Arrow(id: ArrowID(rawValue: "in"), from: Endpoint(card: cid("a")), to: Endpoint(card: cid("b"))),
      Arrow(id: ArrowID(rawValue: "out"), from: Endpoint(card: cid("c")), to: Endpoint(card: cid("a"))),
    ],
    sections: [Section(id: s, title: "S", x: 80, y: 60, width: 560, height: 200)],
    sidenotes: [
      Sidenote(id: SidenoteID(rawValue: "on"), anchor: .card(cid("a")), body: .text(TextNote(text: "x"))),
      Sidenote(id: SidenoteID(rawValue: "free"), anchor: .point(x: 0, y: 0), body: .text(TextNote(text: "y"))),
    ])
  let rects: (CardID) -> Rect? = { id in
    b.card(id).map { Rect(x: $0.x, y: $0.y, width: $0.width, height: $0.height ?? 100) }
  }
  var p = b
  let made = p.extract([cid("a"), cid("b")], rects: rects, child: bid("kid"), frame: cid("f"))
  let child = try #require(made)
  #expect(child.id == bid("kid"))
  #expect(child.cards.map(\.id) == [cid("a"), cid("b")] && child.cards[0].x == 80 && child.cards[0].y == 80)
  #expect(child.arrows.map(\.id.rawValue) == ["in"] && child.sections.map(\.id) == [s])
  #expect(child.sections[0].x == 60 && child.sections[0].y == 40)
  #expect(child.sidenotes.map(\.id.rawValue) == ["on"], "free sidenotes stay")
  #expect(p.cards.map(\.id) == [cid("f"), cid("c")], "the frame where the first was")
  let f = try #require(p.card(cid("f")))
  #expect(f.x == 100 && f.y == 100 && f.width == 360 && f.section == nil)
  #expect(p.arrows.map { "\($0.from.card.rawValue)>\($0.to.card.rawValue)" } == ["c>f"])
  #expect(p.sections.isEmpty && p.sidenotes.map(\.id.rawValue) == ["free"])
  b = p
  // nothing selected that is here: nothing
  #expect(b.extract([cid("zz")], rects: rects, child: bid("k2"), frame: cid("f2")) == nil)
}

@Test func theFirstAutomaticCardGoesBelowTheUsersSectionsToo() {
  var b = Board(
    id: bid("fb"), cards: [note("mine", x: 0, y: 0)],
    sections: [Section(id: SectionID(rawValue: "s"), title: "S", x: -40, y: -20, width: 300, height: 400)])
  b.keepUp(with: [.board(bid("b1"))])
  let first = b.autoCards[0].card
  #expect(first.x == -40 && first.y == 380 + Board.autoRowGap)
}

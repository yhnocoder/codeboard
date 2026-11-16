import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas

/// The previews of a sub-board's cards beside its sub-board card (subboards.ts pvLayout, togglePreview;
/// SubPreviews.tsx; the subboardPreview* scenarios)
extension CanvasSubBoardTests {
  /// pvLayout's numbers for one column and two, title rows under the card or, with a card under it, on the right
  @Test func previewsAreLaidOutAsTheWebBoardLaysThemOut() {
    let f = CGRect(x: 100, y: 100, width: 400, height: 300)
    let hs: [CardID: CGFloat] = [cid("a"): 100, cid("b"): 150, cid("c"): 120, cid("d"): 80]
    let exp = [cid("a"), cid("b"), cid("c")]
    let tit = [cid("d"), cid("e")]
    let one = SubPreview.layout(f, exp: exp, tit: tit, columns: 1, height: { hs[$0] ?? 120 })
    #expect(one.boxes[cid("a")] == CGRect(x: 514, y: 100, width: 260, height: 100))
    #expect(one.boxes[cid("b")] == CGRect(x: 514, y: 210, width: 260, height: 150))
    #expect(one.boxes[cid("c")] == CGRect(x: 514, y: 370, width: 260, height: 120))
    #expect(!one.side && one.per == 1 && one.titles == CGRect(x: 100, y: 414, width: 400, height: 66))
    #expect(one.boxes[cid("d")] == CGRect(x: 100, y: 414, width: 200, height: 30))
    #expect(one.boxes[cid("e")] == CGRect(x: 100, y: 450, width: 200, height: 30))
    #expect(one.right == CGRect(x: 514, y: 100, width: 260, height: 390))
    // two columns, each into the shorter; a card under the frame sends the title rows right, under the expanded ones
    let under = [CGRect(x: 100, y: 450, width: 100, height: 100)]
    let two = SubPreview.layout(
      f, exp: exp, tit: tit, columns: 2, height: { hs[$0] ?? 120 }, peek: cid("d"), obstacles: under)
    #expect(two.boxes[cid("a")] == CGRect(x: 514, y: 100, width: 260, height: 100))
    #expect(two.boxes[cid("b")] == CGRect(x: 784, y: 100, width: 260, height: 150))
    #expect(two.boxes[cid("c")] == CGRect(x: 514, y: 210, width: 260, height: 120))
    #expect(two.side && two.per == 2 && two.titles == CGRect(x: 514, y: 344, width: 530, height: 30))
    // the title row peeked opens where it is, as wide as an expanded one
    #expect(two.boxes[cid("d")] == CGRect(x: 514, y: 344, width: 260, height: 80))
    #expect(two.boxes[cid("e")] == CGRect(x: 724, y: 344, width: 200, height: 30))
    #expect(two.right == CGRect(x: 514, y: 100, width: 530, height: 230))
    // a fourth opened goes to the title rows; one closed leaves them
    var pv = SubPreview()
    for id in ["a", "b", "c", "d"] { pv.toggle(cid(id)) }
    #expect(pv.exp == exp && pv.tit == [cid("d")])
    pv.toggle(cid("b"))
    #expect(pv.open == [cid("a"), cid("c"), cid("d")] && pv.exp == [cid("a"), cid("c")] && pv.tit == [cid("d")])
  }

  /// A vault with a board Kid of `n` Notes (k1, k2… two to a row) and a board showing it on a sub-board card f
  func previewRig(_ n: Int = 2) async throws -> (Rig, VaultBoard) {
    let root = FileManager.default.temporaryDirectory.appending(path: "canvas-edit-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let cards = (0..<n).map { note("k\($0 + 1)", x: Double($0 % 2) * 400, y: Double($0 / 2) * 300) }
    let kid = try Vault(root: root).newBoard(
      in: "", title: "Kid", board: Board(id: BoardID(rawValue: "kid"), cards: cards))
    let frame = Card(
      id: cid("f"), x: 100, y: 100, width: 560, height: 360,
      content: .own(CardContent(body: .board(SubBoard(board: kid.id)))))
    let r = try await Rig(Board(id: BoardID(rawValue: "here"), cards: [frame]), zoom: 1, root: root)
    await r.until("the map drawn") { block(r, "k\(n)") != nil }
    return (r, kid)
  }

  /// Where a card of Kid is drawn in f's map
  func block(_ r: Rig, _ id: String) -> CGPoint? {
    guard case .board(let d)? = r.canvas.scene?.parts[cid("f")]?.drawing, let map = d.map,
      let rect = r.canvas.scene?.placed[cid("f")]?.rect, let b = Drawing.block(cid(id), in: map, rect)
    else { return nil }
    return CGPoint(x: b.midX, y: b.midY)
  }

  /// A click on a block opens its card's preview on the card's right, numbered, its name in its header; the same block
  /// clicked again closes it, as its × does. A double-click still enters the board at that card (its first click opens
  /// the preview, as on the web board). None of it touches the board, its file or its undo steps
  @Test func aClickOnAMapsCardTogglesItsPreviewAndADoubleClickEntersThere() async throws {
    let (r, kid) = try await previewRig()
    defer { r.close() }
    let c = r.canvas
    let f = cid("f")
    let before = try Data(contentsOf: r.file)
    r.click(try #require(block(r, "k2")))
    #expect(c.subPreviews.open[f]?.open == [cid("k2")])
    await r.until("its card drawn") { c.subPreviews.drawn[f]?[cid("k2")] != nil }
    #expect(c.subPreviews.drawn[f]?[cid("k2")]?.name == "步骤 k2")
    let lay = try #require(c.previewLayout(f))
    let box = try #require(lay.boxes[cid("k2")])
    #expect(box.minX == 100 + 560 + 14 && box.minY == 100 && box.width == 260)
    // drawn in the sub-board card's own layer, where the layout puts it
    let shown = try #require(c.subPreviews.shown[f]?.cards[cid("k2")]?.layer)
    #expect(!shown.isHidden && shown.frame == box.offsetBy(dx: -100, dy: -100))
    #expect(c.previewPart(at: CGPoint(x: box.midX, y: box.maxY - 4)) == .preview(f, cid("k2")))
    // a second block: number 2
    r.click(try #require(block(r, "k1")))
    #expect(c.subPreviews.open[f]?.open == [cid("k2"), cid("k1")])
    // its block again closes it; the other one's × too
    r.click(try #require(block(r, "k2")))
    #expect(c.subPreviews.open[f]?.open == [cid("k1")])
    await r.until("its card drawn") { c.subPreviews.drawn[f]?[cid("k1")] != nil }
    let x = PreviewArt.close(in: try #require(c.previewLayout(f)?.boxes[cid("k1")]))
    r.click(CGPoint(x: x.midX, y: x.midY))
    #expect(c.subPreviews.open[f] == nil)
    await r.until("its layers gone") { c.subPreviews.shown[f] == nil }
    #expect(r.doc.history.undoSteps.isEmpty && r.doc.board.cards.count == 1)
    r.doc.flush()
    #expect(try Data(contentsOf: r.file) == before)
    // a double-click: the first click opens the preview, the second enters at the card
    var entered: BoardEntry?
    c.onEnterBoard = { entered = $0 }
    let p = try #require(block(r, "k2"))
    r.send(r.mouse(.leftMouseDown, p))
    r.send(r.mouse(.leftMouseUp, p))
    r.send(r.mouse(.leftMouseDown, p, clicks: 2))
    r.send(r.mouse(.leftMouseUp, p, clicks: 2))
    await r.until("the shell asked") { entered != nil }
    #expect(entered?.board == kid.id && entered?.reveal == cid("k2"))
    #expect(c.subPreviews.open[f]?.open == [cid("k2")])
  }

  /// Which previews are open is the view's: another board shown, they are gone, and back on this board none are open
  @Test func previewsAreGoneWithABoardSwitch() async throws {
    let (r, _) = try await previewRig()
    defer { r.close() }
    let c = r.canvas
    let vault = Vault(root: r.root)
    r.click(try #require(block(r, "k1")))
    #expect(c.subPreviews.open[cid("f")] != nil)
    let other = try vault.newBoard(in: "", title: "Other", board: Board(id: BoardID(rawValue: "other")))
    let doc = try BoardDocument { vault.url(of: other.path).appending(path: Vault.boardFileName) }
    try await c.show(doc, at: other, in: vault, theme: .warmInk)
    #expect(c.subPreviews.open.isEmpty && c.subPreviews.shown.isEmpty)
    try await c.show(
      r.doc, at: VaultBoard(id: r.doc.board.id, title: "B", path: "here.board"), in: vault, theme: .warmInk)
    #expect(c.subPreviews.open.isEmpty)
  }

  /// A preview closes when its card leaves the sub-board; all of a sub-board card go with it, and with its board
  @Test func aPreviewClosesWhenItsCardIsGoneFromTheSubBoard() async throws {
    let (r, kid) = try await previewRig()
    defer { r.close() }
    let c = r.canvas
    let f = cid("f")
    let vault = Vault(root: r.root)
    r.click(try #require(block(r, "k1")))
    r.click(try #require(block(r, "k2")))
    #expect(c.subPreviews.open[f]?.open == [cid("k1"), cid("k2")])
    // k2 taken off Kid, elsewhere
    var b = try vault.board(at: kid.path)
    b.cards.removeAll { $0.id == cid("k2") }
    try b.encoded().write(to: vault.url(of: kid.path).appending(path: Vault.boardFileName))
    c.vaultChanged()
    await r.until("k2's preview closed") { c.subPreviews.open[f]?.open == [cid("k1")] }
    #expect(c.subPreviews.open[f]?.exp == [cid("k1")])
    // Kid deleted: its card shows it is gone, and no previews
    try FileManager.default.removeItem(at: vault.url(of: kid.path))
    c.vaultChanged()
    await r.until("the previews gone") { c.subPreviews.open[f] == nil }
    // the sub-board card deleted
    try FileManager.default.createDirectory(at: vault.url(of: kid.path), withIntermediateDirectories: true)
    try b.encoded().write(to: vault.url(of: kid.path).appending(path: Vault.boardFileName))
    c.vaultChanged()
    await r.until("the map drawn again") { block(r, "k1") != nil }
    r.click(try #require(block(r, "k1")))
    #expect(c.subPreviews.open[f] != nil)
    r.doc.edit("Delete") { $0.delete([.card(f)]) }
    await r.settle()
    #expect(c.subPreviews.open[f] == nil && c.subPreviews.shown[f] == nil)
  }

  /// The sub-board card dragged: its previews go with it, in its own layer, none drawn again; let go, they are where the
  /// card now is
  @Test func previewsFollowTheDraggedSubBoardCardWithoutBeingDrawnAgain() async throws {
    let (r, _) = try await previewRig()
    defer { r.close() }
    let c = r.canvas
    let f = cid("f")
    r.click(try #require(block(r, "k1")))
    await r.until("its card drawn") { c.subPreviews.drawn[f]?[cid("k1")] != nil }
    let draws = c.subPreviews.draws
    let box = try #require(c.previewLayout(f)?.boxes[cid("k1")])
    let layer = try #require(c.subPreviews.shown[f]?.cards[cid("k1")]?.layer)
    // in board units (the kept layer, where sub-board cards are, as the card level)
    let onBoard = { layer.convert(layer.bounds, to: c.kept) }
    #expect(onBoard() == box)
    let card = try #require(c.index(of: .card(f)).map { c.items[$0].box })
    let at = card.position
    // by its name above it: the card's box moves, the previews in it (lifted, they grow with it)
    r.drag(CGPoint(x: 140, y: 70), CGPoint(x: 200, y: 110)) {
      #expect(
        c.subPreviews.shown[f]?.group.superlayer === card
          && layer.superlayer?.superlayer === c.subPreviews.shown[f]?.group)
      #expect(card.position == CGPoint(x: at.x + 60, y: at.y + 40))
      #expect(c.subPreviews.draws == draws)
    }
    await r.settle()
    #expect(r.card("f").x == 160 && r.card("f").y == 140)
    #expect(c.previewLayout(f)?.boxes[cid("k1")] == box.offsetBy(dx: 60, dy: 40))
    #expect(onBoard() == box.offsetBy(dx: 60, dy: 40))
    #expect(c.subPreviews.draws == draws && c.subPreviews.open[f]?.open == [cid("k1")])
  }
}

extension CanvasSubBoardTests {
  /// The row above the card (.sbacts): one column or two, the card's own setting, saved and not an undo step; Hide and
  /// Show; Clear. The preview under the pointer is ringed with its line to its block, its × says what it does
  @Test func theRowAboveTheCardSetsColumnsHidesShowsAndClears() async throws {
    let (r, _) = try await previewRig()
    defer { r.close() }
    let c = r.canvas
    let f = cid("f")
    r.click(try #require(block(r, "k1")))
    r.click(try #require(block(r, "k2")))
    await r.until("both drawn") { c.subPreviews.drawn[f]?.count == 2 }
    func press(_ part: PreviewPart) throws {
      let b = try #require(c.previewActs(f).first { $0.0 == part }?.1)
      r.click(CGPoint(x: b.midX, y: b.midY))
    }
    func columns() -> Bool? {
      if case .own(let k) = r.card("f").content, case .board(let s) = k.body { s.twoColumnPreview } else { nil }
    }
    func saved() throws -> Bool {
      r.doc.flush()
      return try String(decoding: Data(contentsOf: r.file), as: UTF8.self).contains("previewColumns")
    }
    #expect(columns() == false)
    // two columns: side by side, kept with the card, no undo step
    try press(.columns(f, 2))
    await r.settle()
    #expect(try columns() == true && saved())
    #expect(r.doc.history.undoSteps.isEmpty)
    var lay = try #require(c.previewLayout(f))
    #expect(lay.boxes[cid("k2")]?.minX == lay.boxes[cid("k1")]!.maxX + 10)
    #expect(lay.boxes[cid("k2")]?.minY == lay.boxes[cid("k1")]?.minY)
    try press(.columns(f, 1))
    await r.settle()
    #expect(try columns() == false && !saved() && r.doc.history.undoSteps.isEmpty)
    lay = try #require(c.previewLayout(f))
    #expect(lay.boxes[cid("k2")]?.minX == lay.boxes[cid("k1")]?.minX)
    // the pointer over a preview: ringed, its line drawn; over its ×, the tip
    let box = try #require(lay.boxes[cid("k2")])
    r.send(r.mouse(.mouseMoved, CGPoint(x: box.midX, y: box.maxY - 4)))
    #expect(c.subPreviews.hover == .preview(f, cid("k2")))
    #expect(c.subPreviews.shown[f]?.line.path != nil)
    let x = PreviewArt.close(in: box)
    r.send(r.mouse(.mouseMoved, CGPoint(x: x.midX, y: x.midY)))
    #expect(c.previewTip()?.0 == Tip("Close"))
    r.send(r.mouse(.mouseMoved, CGPoint(x: 50, y: 600)))
    #expect(c.subPreviews.hover == nil && c.subPreviews.shown[f]?.line.path == nil)
    // Hide: the previews go, the badges and the row stay; Show brings them back
    try press(.fold(f))
    #expect(c.subPreviews.open[f]?.fold == true && c.subPreviews.shown[f]?.previews.isHidden == true)
    #expect(c.previewPart(at: CGPoint(x: box.midX, y: box.maxY - 4)) == nil)
    #expect(c.subPreviews.shown[f]?.picks.sublayers?.isEmpty == false)
    try press(.fold(f))
    #expect(c.subPreviews.open[f]?.fold == false && c.subPreviews.shown[f]?.previews.isHidden == false)
    // a block clicked while hidden shows them again
    try press(.fold(f))
    r.click(try #require(block(r, "k2")))
    #expect(c.subPreviews.open[f]?.open == [cid("k1")] && c.subPreviews.open[f]?.fold == true)
    r.click(try #require(block(r, "k2")))
    #expect(c.subPreviews.open[f]?.open == [cid("k1"), cid("k2")] && c.subPreviews.open[f]?.fold == false)
    // Clear: all close, the row and the badges go
    try press(.clear(f))
    #expect(c.subPreviews.open[f] == nil && c.subPreviews.shown[f] == nil && c.previewActs(f).isEmpty)
    #expect(r.doc.history.undoSteps.isEmpty)
  }
}

extension CanvasSubBoardTests {
  /// On a shared sub-board card the columns are the shared card's, as on the web board, where pcols is a field of the
  /// card and the whole card is what the card library keeps (patch.ts sharedOf): two columns go into its own file, not
  /// the board's, and another board showing it takes them in
  @Test func aSharedSubBoardCardsColumnsGoWithTheSharedCard() async throws {
    let root = FileManager.default.temporaryDirectory.appending(path: "canvas-edit-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    let kid = try vault.newBoard(
      in: "", title: "Kid",
      board: Board(id: BoardID(rawValue: "kid"), cards: [note("k1", x: 0, y: 0), note("k2", x: 400, y: 0)]))
    let f = cid("f")
    try FileManager.default.createDirectory(at: vault.sharedFolderURL, withIntermediateDirectories: true)
    try SharedCard(id: f, content: CardContent(body: .board(SubBoard(board: kid.id)))).encoded()
      .write(to: vault.sharedFolderURL.appending(path: "f.json"))
    let ref = Card(id: f, x: 100, y: 100, width: 560, height: 360, content: .shared)
    let other = try vault.newBoard(in: "", title: "Other", board: Board(id: BoardID(rawValue: "other"), cards: [ref]))
    let r = try await Rig(Board(id: BoardID(rawValue: "here"), cards: [ref]), zoom: 1, root: root)
    defer { r.close() }
    let c = r.canvas
    let doc = try BoardDocument(file: { r.file }, vault: vault)
    try await c.show(doc, at: VaultBoard(id: doc.board.id, title: "B", path: "here.board"), in: vault, theme: .warmInk)
    await r.until("the map drawn") { block(r, "k2") != nil }
    let docB = try BoardDocument(file: { vault.url(of: other.path).appending(path: Vault.boardFileName) }, vault: vault)
    func columns(_ d: BoardDocument) -> Bool? {
      if case .own(let k) = d.board.card(f)?.content, case .board(let s) = k.body { s.twoColumnPreview } else { nil }
    }
    r.click(try #require(block(r, "k1")))
    r.click(try #require(block(r, "k2")))
    await r.until("both drawn") { c.subPreviews.drawn[f]?.count == 2 }
    let b = try #require(c.previewActs(f).first { $0.0 == .columns(f, 2) }?.1)
    r.click(CGPoint(x: b.midX, y: b.midY))
    await r.until("the change drawn") { c.shownBoard == doc.board }
    doc.flush()
    #expect(columns(doc) == true && doc.history.undoSteps.isEmpty)
    let lay = try #require(c.previewLayout(f))
    #expect(lay.boxes[cid("k2")]?.minY == lay.boxes[cid("k1")]?.minY)
    // in the shared card's file; the board file keeps only the reference
    #expect(try vault.sharedCard(f).content.body == .board(SubBoard(board: kid.id, twoColumnPreview: true)))
    #expect(!(try String(decoding: Data(contentsOf: r.file), as: UTF8.self).contains("previewColumns")))
    // the other board showing it follows
    #expect(columns(docB) == false)
    docB.diskChanged()
    #expect(columns(docB) == true && !docB.isDirty)
  }

  /// dropRight and dropTitles:before the first expanded one whose middle is below where it is let go, the lowest of
  /// four then first in the title rows; into the title rows at the line and place let go on
  @Test func aPreviewLetGoOnTheRightOrTheTitleRowsGoesWhereTheWebBoardPutsIt() {
    let f = CGRect(x: 0, y: 0, width: 100, height: 100)
    var pv = SubPreview(open: [], exp: [cid("a"), cid("b"), cid("c")], tit: [cid("d"), cid("e")])
    let at = { (exp: [CardID]) in SubPreview.layout(f, exp: exp, tit: [], columns: 1, height: { _ in 100 }).boxes }
    pv.dropRight(cid("d"), y: 120, layout: at)
    #expect(pv.exp == [cid("a"), cid("d"), cid("b")] && pv.tit == [cid("c"), cid("e")])
    pv.dropTitles(cid("a"), row: 0, col: 1, per: 2)
    #expect(pv.exp == [cid("d"), cid("b")] && pv.tit == [cid("c"), cid("a"), cid("e")])
    pv.dropTitles(cid("d"), row: 5, col: 0, per: 2)
    #expect(pv.tit.last == cid("d"))
  }

  /// A title row dragged by its header onto the top of the right expands first there, the lowest there going to the
  /// title rows; an expanded one dragged onto the title rows is the first of them. Let go where it was pressed, a title
  /// row opens in place over the rows below it, and a press elsewhere folds it back
  @Test func previewsAreDraggedBetweenTheRightAndTheTitleRowsAndATitleRowOpensInPlace() async throws {
    let (r, _) = try await previewRig(5)
    defer { r.close() }
    let c = r.canvas
    let f = cid("f")
    for k in 1...5 { r.click(try #require(block(r, "k\(k)"))) }
    await r.until("all drawn") { c.subPreviews.drawn[f]?.count == 5 }
    #expect(c.subPreviews.open[f]?.exp == [cid("k1"), cid("k2"), cid("k3")])
    #expect(c.subPreviews.open[f]?.tit == [cid("k4"), cid("k5")])
    var lay = try #require(c.previewLayout(f))
    // the title rows under the card, two to a line
    #expect(lay.titles.minY == 100 + 360 + 14 && lay.per == 2)
    let k1 = try #require(lay.boxes[cid("k1")])
    let k5 = try #require(lay.boxes[cid("k5")])
    let press = CGPoint(x: k5.midX, y: k5.minY + 15)
    var zone: PreviewDrag.Zone?
    var drops = 0
    r.drag(press, CGPoint(x: k1.minX + 100, y: k1.minY + 15)) {
      if case .preview(let d)? = c.gesture?.kind { zone = d.zone }
      drops = c.subPreviews.shown[f]?.drops.sublayers?.count ?? 0
    }
    #expect(zone == .right && drops == 1 && c.subPreviews.shown[f]?.drops.sublayers?.isEmpty != false)
    #expect(c.subPreviews.open[f]?.exp == [cid("k5"), cid("k1"), cid("k2")])
    #expect(c.subPreviews.open[f]?.tit == [cid("k3"), cid("k4")])
    // numbered as opened, wherever they are
    #expect(c.subPreviews.open[f]?.open == (1...5).map { cid("k\($0)") })
    // k5 onto the first title row
    lay = try #require(c.previewLayout(f))
    let top = try #require(lay.boxes[cid("k5")])
    let row = try #require(lay.boxes[cid("k3")])
    r.drag(CGPoint(x: top.midX, y: top.minY + 15), CGPoint(x: row.minX + 30, y: row.minY + 10)) {
      if case .preview(let d)? = c.gesture?.kind { zone = d.zone }
      drops = c.subPreviews.shown[f]?.drops.sublayers?.count ?? 0
    }
    #expect(zone == .titles && drops == 2)
    #expect(c.subPreviews.open[f]?.exp == [cid("k1"), cid("k2")])
    #expect(c.subPreviews.open[f]?.tit == [cid("k5"), cid("k3"), cid("k4")])
    #expect(r.doc.history.undoSteps.isEmpty)
    // a title row clicked opens in place, as wide as an expanded one and over the rows below; a press elsewhere folds it
    lay = try #require(c.previewLayout(f))
    let k4 = try #require(lay.boxes[cid("k4")])
    r.click(CGPoint(x: k4.midX, y: k4.minY + 15))
    #expect(c.subPreviews.peek.map { $0 == (f, cid("k4")) } == true)
    let open = try #require(c.previewLayout(f)?.boxes[cid("k4")])
    #expect(open.origin == k4.origin && open.width == 260 && open.height == c.previewHeight(f, cid("k4")))
    #expect(c.subPreviews.shown[f]?.cards[cid("k4")]?.layer.zPosition == 1)
    r.click(CGPoint(x: 1200, y: 650))
    #expect(c.subPreviews.peek == nil && c.previewLayout(f)?.boxes[cid("k4")] == k4)
  }
}

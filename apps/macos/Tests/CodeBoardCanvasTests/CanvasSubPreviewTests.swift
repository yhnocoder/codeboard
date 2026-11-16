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

  /// A vault with a board Kid of two Notes and a board showing it on a sub-board card f
  func previewRig() async throws -> (Rig, VaultBoard) {
    let root = FileManager.default.temporaryDirectory.appending(path: "canvas-edit-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let kid = try Vault(root: root).newBoard(
      in: "", title: "Kid",
      board: Board(id: BoardID(rawValue: "kid"), cards: [note("k1", x: 0, y: 0), note("k2", x: 400, y: 0)]))
    let frame = Card(
      id: cid("f"), x: 100, y: 100, width: 560, height: 360,
      content: .own(CardContent(body: .board(SubBoard(board: kid.id)))))
    let r = try await Rig(Board(id: BoardID(rawValue: "here"), cards: [frame]), zoom: 1, root: root)
    await r.until("the map drawn") { block(r, "k2") != nil }
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

import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// Stickers on the real canvas (as CanvasEditTests: a window of its own far off screen, events straight to the canvas,
// frames ticked by the test): where each kind is drawn, the palette, placing, dragging, resizing, the menu, and a card
// deleted with its stickers.

private func kid(_ s: String) -> StickerID { StickerID(rawValue: s) }

/// A code card with a Highlight that has a sidenote, a Note, and a sticker of each kind: free, on the Note, on a code
/// line, on the Highlight's first line (a dot by its count), an emoji on the board
func stickerBoard() -> Board {
  let seg = Segment(
    id: s1, source: nil, language: "python", firstLine: 10,
    lines: ["def schedule(queue):", "    batch = queue.take(8)", "    run(batch)", "    return batch"],
    highlights: [12...13])
  return Board(
    id: BoardID(rawValue: "stickers"),
    cards: [
      Card(id: cid("c1"), x: 0, y: 0, width: 420, content: .own(CardContent(body: .code(CodeCard(segments: [seg]))))),
      Card(id: cid("n1"), x: 600, y: 0, width: 300, content: .own(CardContent(body: .note(Note(text: "# 调度\n\n一批"))))),
    ],
    sidenotes: [
      Sidenote(
        id: SidenoteID(rawValue: "l1"), anchor: .card(cid("c1"), segment: s1, lines: 12...13),
        body: .text(TextNote(text: "取一批")))
    ],
    stickers: [
      Sticker(id: kid("k1"), glyph: .builtin(.star), color: "#4C8BF5", anchor: .canvas(x: 300, y: 500, size: nil)),
      Sticker(id: kid("k2"), glyph: .builtin(.todoText), anchor: .card(cid("n1"), x: 20, y: 30, size: 40)),
      Sticker(id: kid("k3"), glyph: .builtin(.check), anchor: .line(cid("c1"), segment: s1, line: 11)),
      Sticker(id: kid("k4"), glyph: .builtin(.flag), anchor: .line(cid("c1"), segment: s1, line: 12)),
      Sticker(id: kid("k5"), glyph: .emoji("🔥"), anchor: .canvas(x: 500, y: 600, size: 48)),
    ])
}

@MainActor @Suite(.serialized) struct CanvasStickerTests {
  func spot(_ c: CanvasView, _ id: String) throws -> StickerSpot {
    try #require(c.stickerSpots.first { $0.id == kid(id) }, "\(id)")
  }

  func sticker(_ r: Rig, _ id: String) -> Sticker? { r.doc.board.sticker(kid(id)) }

  func centre(_ s: StickerSpot) -> CGPoint { CGPoint(x: s.board.midX, y: s.board.midY) }

  @Test(arguments: [0.5, 1, 2] as [CGFloat])
  func eachKindIsDrawnWhereTheWebBoardPutsItAsVectorLayers(zoom: CGFloat) async throws {
    let r = try await Rig(stickerBoard(), zoom: zoom)
    defer { r.close() }
    let c = r.canvas
    #expect(c.stickerSpots.count == 5 && c.stickerLayers.count == 5)
    // free: at its point, 32 by default, over the cards
    let k1 = try spot(c, "k1")
    #expect(k1.board == CGRect(x: 300, y: 500, width: 32, height: 32) && k1.owner == nil)
    #expect(c.stickerLayers[0].superlayer === c.freeStickers)
    // on a card: from its top left, in the card's own layer (it moves with it); the TODO tag is wider than tall
    let k2 = try spot(c, "k2")
    let n1 = r.rect("n1")
    #expect(k2.board.origin == CGPoint(x: n1.minX + 20, y: n1.minY + 30) && k2.board.height == 40)
    #expect(k2.board.width > 60)
    let box = c.items[try #require(c.index(of: .card(cid("n1"))))].box
    #expect(c.stickerLayers[1].superlayer === box)
    // on a line: a 14 chip in the line numbers, level with its line
    let k3 = try spot(c, "k3")
    let code = try #require(c.scene?.placed[cid("c1")]?.code)
    let row = try #require(code.layout.row(segment: 0, line: 11))
    let c1 = r.rect("c1")
    #expect(k3.line && !k3.dot && k3.board.height == 14)
    #expect(abs(k3.board.minX - (c1.minX + code.layout.gutter - 18)) < 0.01)
    #expect(abs(k3.board.minY - (c1.minY + code.top + row.y + 3)) < 0.01)
    // by a Highlight's count: a dot
    let k4 = try spot(c, "k4")
    #expect(k4.dot && k4.board.height == 7)
    // a size is a transform of the 24-unit glyph, never a bitmap
    let art = c.stickerLayers[0]
    #expect(art.contents == nil && abs(art.sublayerTransform.m11 - 32.0 / 24) < 1e-9)
    #expect(art.sublayers?.allSatisfy { $0 is CAShapeLayer } == true)
    // the pointer is taken inside its glyph's shape, not at its box's corner
    #expect(c.stickerAt(centre(k1)) == 0)
    #expect(c.stickerAt(CGPoint(x: 300.5, y: 500.5)) == nil)
  }

  @Test func thePaletteOffersTheGlyphsAndAnEmojiAndAPickedOneFollowsThePointerUntilAClickPutsItDown() async throws {
    let r = try await Rig(stickerBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    var tools: [Tool?] = []
    c.onMode = { tools.append($0) }
    let button = CGRect(x: 480, y: 640, width: 30, height: 28)
    c.toggleStickerPalette(above: button)
    let p = try #require(c.stickerPalette)
    // eleven glyphs (no ?), the TODO tag two slots wide, and the emoji button: two rows of eight
    #expect(StickerPalette.slots.count == 12 && StickerPalette.slots.compactMap(\.glyph).count == 11)
    #expect(StickerPalette.slots.reduce(0) { $0 + $1.span } == 13)
    #expect(p.frame.maxY == button.minY - 8 && abs(p.frame.midX - button.midX) < 0.01)
    #expect(tools.last == .sticker)
    // the toolbar's button again closes it
    c.toggleStickerPalette(above: button)
    #expect(c.stickerPalette == nil && tools.last == .some(nil))

    // picked: it follows the pointer, nothing is put down yet
    c.toggleStickerPalette(above: button)
    c.stickerPalette?.press(0)
    #expect(c.stickerPalette == nil && c.placing == .builtin(.star) && tools.last == .sticker)
    let free = CGPoint(x: 260, y: 420)
    c.mouseMoved(with: r.mouse(.mouseMoved, free))
    let ghost = c.stickerGhost
    #expect(!ghost.isHidden && ghost.opacity == 0.85)
    #expect(abs(ghost.position.x + ghost.bounds.width / 2 - c.camera.view(free).x) < 0.01)
    #expect(r.doc.board.stickers.count == 5)
    // a click on the board: free there, centred on the click, one step, not selected
    r.click(free)
    let added = try #require(r.doc.board.stickers.last)
    #expect(added.glyph == .builtin(.star) && added.anchor == .canvas(x: 244, y: 404, size: nil))
    #expect(r.doc.undoName == "Add Sticker" && r.doc.selection.isEmpty && c.placing == nil && ghost.isHidden)

    // on a card: on it, from its top left
    c.beginPlacing(.builtin(.heart))
    let n1 = r.rect("n1")
    r.click(CGPoint(x: n1.minX + 100, y: n1.minY + 50))
    #expect(r.doc.board.stickers.last?.anchor == .card(cid("n1"), x: 84, y: 34, size: nil))
    // beside one, within 40 points: on it too; ⌥: free
    c.beginPlacing(.builtin(.heart))
    r.click(CGPoint(x: n1.maxX + 30, y: n1.minY + 50))
    #expect(r.doc.board.stickers.last?.anchor.card == cid("n1"))
    c.beginPlacing(.builtin(.heart))
    r.click(CGPoint(x: n1.maxX + 30, y: n1.minY + 50), .option)
    #expect(r.doc.board.stickers.last?.anchor.card == nil)
    // on a line's number: on that line
    c.beginPlacing(.builtin(.bug))
    let code = try #require(c.scene?.placed[cid("c1")]?.code)
    let row = try #require(code.layout.row(segment: 0, line: 13))
    let c1 = r.rect("c1")
    r.click(CGPoint(x: c1.minX + code.layout.gutter / 2, y: c1.minY + code.top + row.y + row.height / 2))
    #expect(r.doc.board.stickers.last?.anchor == .line(cid("c1"), segment: s1, line: 13))
    #expect(r.doc.selection.isEmpty, "no lines are selected either")
    // Esc: nothing put down
    let count = r.doc.board.stickers.count
    c.beginPlacing(.emoji("🎯"))
    r.key(53)
    #expect(c.placing == nil && r.doc.board.stickers.count == count)
    r.click(CGPoint(x: 260, y: 700))
    #expect(r.doc.board.stickers.count == count)
    // the emoji button's picker types an emoji: that is the sticker placed
    c.toggleStickerPalette(above: button)
    c.stickerPalette?.typed("🎯")
    #expect(c.placing == .emoji("🎯"))
    c.cancelPlacing()
  }

  @Test(arguments: [0.5, 1, 2] as [CGFloat])
  func aDragIsOneStepThatOnlyMovesItsLayerAndLetGoOnACardItGoesOnIt(zoom: CGFloat) async throws {
    let r = try await Rig(stickerBoard(), zoom: zoom)
    defer { r.close() }
    let c = r.canvas
    let start = r.bytes
    let breaks = r.breaks
    let k1 = try spot(c, "k1")
    let n1 = r.rect("n1")
    let to = CGPoint(x: n1.minX + 60, y: n1.minY + 80)
    r.drag(centre(k1), to) {
      #expect(r.breaks == breaks, "nothing is drawn, decoded, requested or swapped during the drag")
      #expect(c.dropAim != nil, "the card it would go on is ringed")
    }
    #expect(sticker(r, "k1")?.anchor == .card(cid("n1"), x: 44, y: 64, size: nil))
    #expect(r.doc.undoName == "Move Sticker" && r.doc.history.undoSteps.count == 1)
    #expect(r.doc.selection == [.sticker(kid("k1"))] && c.dropAim == nil)
    await r.settle()
    // with ⌥ off the card: free again
    let moved = try spot(c, "k1")
    r.drag(centre(moved), CGPoint(x: centre(moved).x + 10, y: centre(moved).y + 10), .option)
    #expect(sticker(r, "k1")?.anchor == .canvas(x: n1.minX + 54, y: n1.minY + 74, size: nil))
    // a line's chip is selected, not moved
    await r.settle()
    let k3 = try spot(c, "k3")
    r.drag(centre(k3), CGPoint(x: centre(k3).x + 200, y: centre(k3).y))
    #expect(sticker(r, "k3")?.anchor == .line(cid("c1"), segment: s1, line: 11))
    #expect(r.doc.selection == [.sticker(kid("k3"))] && r.doc.history.undoSteps.count == 2)
    r.doc.undo()
    r.doc.undo()
    #expect(r.bytes == start)
  }

  @Test(arguments: [0.5, 1, 2] as [CGFloat])
  func theSelectedOnesGripResizesItFromItsTopLeftWithinItsSizes(zoom: CGFloat) async throws {
    let r = try await Rig(stickerBoard(), zoom: zoom)
    defer { r.close() }
    let c = r.canvas
    let k1 = try spot(c, "k1")
    r.click(centre(k1))
    #expect(r.doc.selection == [.sticker(kid("k1"))])
    // its ring and grip are drawn, the grip on the disc at 45°
    let i = try #require(c.selectedSticker)
    let grip = c.stickerGrip(i)
    #expect(abs(grip.x - (k1.board.maxX - 32 * 0.146)) < 0.01)
    #expect(c.chrome.sublayers?.count == 2)
    let breaks = r.breaks
    r.drag(grip, CGPoint(x: grip.x + 20, y: grip.y + 8)) {
      #expect(r.breaks == breaks)
      #expect(abs(c.stickerLayers[i].sublayerTransform.m11 - 52.0 / 24) < 1e-9)
    }
    #expect(sticker(r, "k1")?.anchor == .canvas(x: 300, y: 500, size: 52))
    #expect(r.doc.undoName == "Resize Sticker")
    await r.settle()
    let g2 = c.stickerGrip(try #require(c.selectedSticker))
    r.drag(g2, CGPoint(x: g2.x + 900, y: g2.y + 900))
    #expect(sticker(r, "k1")?.anchor == .canvas(x: 300, y: 500, size: 240))
    // a line's chip has no grip
    await r.settle()
    r.click(centre(try spot(c, "k3")))
    #expect(c.hitStickerGrip(c.camera.view(c.stickerGrip(try #require(c.selectedSticker)))) == nil)
  }

  @Test func aGlyphPickedWithOneSelectedSwapsItsGlyphAndItsColourGoesBack() async throws {
    let r = try await Rig(stickerBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    r.click(centre(try spot(c, "k1")))
    c.toggleStickerPalette(above: CGRect(x: 480, y: 640, width: 30, height: 28))
    #expect(c.stickerPalette?.chosen == .builtin(.star))
    let heart = try #require(StickerPalette.slots.firstIndex { $0.glyph == .builtin(.heart) })
    c.stickerPalette?.press(heart)
    #expect(sticker(r, "k1")?.glyph == .builtin(.heart) && sticker(r, "k1")?.color == nil)
    #expect(r.doc.undoName == "Change Sticker" && c.placing == nil)
    r.doc.undo()
    #expect(sticker(r, "k1")?.glyph == .builtin(.star) && sticker(r, "k1")?.color == "#4C8BF5")
  }

  @Test func itsMenuIsItsColoursAndDeleteAndAnEmojiHasNoColours() async throws {
    let r = try await Rig(stickerBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let menu = try #require(c.menu(for: r.mouse(.rightMouseDown, centre(try spot(c, "k1")))))
    #expect(r.doc.selection == [.sticker(kid("k1"))])
    let row = try #require(menu.items.first?.view as? StickerSwatches)
    #expect(menu.items.count == 3 && menu.items[1].isSeparatorItem && menu.items[2].title == "Delete")
    #expect(row.colors == Sticker.palette)
    row.onPick?("#3FA36B")
    #expect(sticker(r, "k1")?.color == "#3FA36B" && r.doc.undoName == "Sticker Color")
    // the glyph's own colour is kept as none
    row.onPick?(BuiltinSticker.star.color)
    #expect(sticker(r, "k1")?.color == nil)
    // a glyph whose own colour the palette lacks: it comes first
    let bug = StickerSwatches(theme: c.theme, own: BuiltinSticker.bug.color, current: BuiltinSticker.bug.color)
    #expect(bug.colors.first == BuiltinSticker.bug.color && bug.colors.count == 9)
    // an emoji: Delete alone
    await r.settle()
    let emoji = try #require(c.menu(for: r.mouse(.rightMouseDown, centre(try spot(c, "k5")))))
    #expect(emoji.items.map(\.title) == ["Delete"])
    (emoji.items[0].representedObject as? MenuAction)?.run()
    #expect(sticker(r, "k5") == nil && r.doc.undoName == "Delete")
    // ⌫ deletes the selected one too
    await r.settle()
    r.click(centre(try spot(c, "k1")))
    r.key(51)
    #expect(sticker(r, "k1") == nil)
  }

  @Test func deletingACardTakesItsStickersAndUndoBringsThemBack() async throws {
    let r = try await Rig(stickerBoard(), zoom: 1)
    defer { r.close() }
    let start = r.bytes
    r.doc.select([.card(cid("c1")), .card(cid("n1"))])
    r.key(51)
    #expect(r.doc.board.stickers.map(\.id) == [kid("k1"), kid("k5")])
    await r.settle()
    #expect(r.canvas.stickerSpots.count == 2)
    r.doc.undo()
    #expect(r.bytes == start)
    await r.settle()
    #expect(r.canvas.stickerSpots.count == 5)
  }
}

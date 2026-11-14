import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// The Shelf on the real canvas (as CanvasEditTests: a window of its own far off screen, events straight to the canvas,
// frames ticked by the test): its button and panel, what goes in and how it shows, the large picture, putting back
// with the camera, a drag out, and cards dragged onto the button.

private func sid(_ s: String) -> SectionID { SectionID(rawValue: s) }

/// Two Notes side by side, the second with no height of its own, and a Section with a Note in it and an arrow to it
func shelfBoard() -> Board {
  func note(_ id: String, _ x: Double, _ y: Double, h: Double? = 160, in s: String? = nil) -> Card {
    Card(
      id: cid(id), x: x, y: y, width: 240, height: h, section: s.map(sid),
      content: .own(CardContent(body: .note(Note(text: "# \(id)\n\nA plan in a few words.")))))
  }
  return Board(
    id: BoardID(rawValue: "shelf"),
    cards: [note("n1", 0, 0), note("n2", 400, 0, h: nil), note("m1", 40, 460, in: "g1")],
    arrows: [Arrow(id: ArrowID(rawValue: "a1"), from: Endpoint(card: cid("n1")), to: Endpoint(card: cid("m1")))],
    sections: [Section(id: sid("g1"), title: "Group", x: 0, y: 400, width: 600, height: 340)])
}

@MainActor @Suite(.serialized) struct CanvasShelfTests {
  func entry(_ r: Rig, holding id: String) -> String? {
    r.doc.board.shelf.first { $0.cards.contains { $0.id == cid(id) } }?.id
  }

  /// Nothing in flight, every picture in the panel drawn
  func drawn(_ r: Rig) async {
    await r.until("the pictures are drawn") {
      guard let p = r.canvas.shelfPanel else { return true }
      return p.ids.allSatisfy { p.thumbs[$0]?.image != nil }
    }
  }

  @Test func theButtonCountsTheEntriesAndOnlyItOrTheXOpensAndClosesThePanel() async throws {
    let r = try await Rig(shelfBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let dock = try #require(c.shelfDock)
    #expect(dock.count == 0 && c.shelfPanel == nil)
    // at the bottom right
    #expect(dock.frame.maxX == c.bounds.width - 12 && dock.frame.maxY == c.bounds.height - 12)
    c.toggleShelf()
    let p = try #require(c.shelfPanel)
    #expect(p.frame.maxX == c.bounds.width - 12 && p.frame.minY == 12 && p.frame.width == 300)
    #expect(p.ids.isEmpty && ShelfPanel.empty == "⌥S or drag to the Shelf button")
    // Esc and a click on the board leave it open
    r.key(53)
    r.click(CGPoint(x: 900, y: 900))
    #expect(c.shelfPanel != nil)
    // its X closes it, and so does the button
    p.onClose?()
    #expect(c.shelfPanel == nil)
    c.toggleShelf()
    c.toggleShelf()
    #expect(c.shelfPanel == nil)
  }

  @Test func optionSPutsTheSelectionInAsOneEntryFlyingToItsPictureAndUndoBringsItBack() async throws {
    let r = try await Rig(shelfBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let start = r.bytes
    c.toggleShelf()
    let drawnHeight = r.rect("n2").height
    r.doc.select([.card(cid("n2"))])
    r.key(1, .option)
    #expect(r.doc.undoName == "Move to Shelf" && r.doc.selection.isEmpty)
    let e = try #require(r.doc.board.shelf.first)
    // a card with no height keeps the one it was drawn at, so its place is known after a reload
    #expect(e.cards.first?.measuredHeight == Double(drawnHeight))
    #expect(c.shelfDock?.count == 1)
    // it flies into the panel, over it
    let fly = try #require(c.shelfFlights.first)
    let p = try #require(c.shelfPanel)
    #expect(p.frame.contains(CGPoint(x: fly.frame.midX, y: fly.frame.midY)) && fly.zPosition > 0)
    await drawn(r)
    #expect(p.ids == [e.id])
    // a Section and what is in it: one entry
    r.doc.select([.section(sid("g1"))])
    r.key(1, .option)
    #expect(r.doc.board.shelf.count == 2 && r.doc.board.shelf[1].cards.map(\.id) == [cid("m1")])
    // the panel in the board's order: the Section (lower) after n2 (higher)
    await drawn(r)
    #expect(p.ids == [e.id, r.doc.board.shelf[1].id])
    // n1 to the left of n2 in the same row comes first
    r.doc.select([.card(cid("n1"))])
    r.key(1, .option)
    await drawn(r)
    #expect(p.ids.first == entry(r, holding: "n1"))
    r.doc.undo()
    r.doc.undo()
    r.doc.undo()
    #expect(r.bytes == start)
  }

  @Test func aPictureClickedShowsItLargeBesideThePanelUntilClickedAgainEscOrAClickElsewhere() async throws {
    let r = try await Rig(shelfBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    c.toggleShelf()
    r.doc.select([.section(sid("g1"))])
    r.key(1, .option)
    await drawn(r)
    let id = try #require(r.doc.board.shelf.first?.id)
    let board = r.bytes
    let p = try #require(c.shelfPanel)
    c.togglePreview(id)
    let v = try #require(c.shelfPreview)
    let thumb = p.convert(try #require(p.thumbRect(id)), to: c)
    // left of the panel, level with the thumbnail, clear of the bottom toolbar; one button
    #expect(v.frame.maxX <= p.frame.minX - 10 + 0.01 && abs(v.frame.minY - thumb.minY) < 0.01)
    #expect(v.frame.maxY <= c.bounds.height - c.toolbarBand)
    #expect(!v.frame.intersects(p.frame) && v.buttonRect.width == 26)
    await r.until("its own picture") { v.image != nil }
    #expect(r.bytes == board, "showing it changes nothing")
    // clicked again: closed; Esc: closed and the panel stays; a click on the board: closed
    c.togglePreview(id)
    #expect(c.shelfPreview == nil)
    c.togglePreview(id)
    r.key(53)
    #expect(c.shelfPreview == nil && c.shelfPanel != nil)
    c.togglePreview(id)
    r.click(CGPoint(x: 900, y: 900))
    #expect(c.shelfPreview == nil && c.shelfPanel != nil)
    // a narrow window: under the panel when it is larger there
    r.window.setContentSize(CGSize(width: 420, height: 900))
    c.setFrameSize(CGSize(width: 420, height: 900))
    c.togglePreview(id)
    let narrow = try #require(c.shelfPreview)
    #expect(narrow.frame.minY >= p.frame.maxY + 10 - 0.01 && !narrow.frame.intersects(p.frame))
  }

  @Test(arguments: [0.5, 1] as [CGFloat])
  func putBackComesBackOnTopSelectedAndTheCameraPansOnlyAsFarAsNeeded(zoom: CGFloat) async throws {
    let r = try await Rig(shelfBoard(), zoom: zoom)
    defer { r.close() }
    let c = r.canvas
    c.toggleShelf()
    r.doc.select([.card(cid("n1"))])
    r.key(1, .option)
    await r.settle()
    let id = try #require(entry(r, holding: "n1"))
    // seen whole: nothing moves
    let box = CGRect(x: 0, y: 0, width: 240, height: 160)
    c.place(zoom: zoom, centre: CGPoint(x: box.midX, y: box.midY + 100))
    await r.idle()
    let before = c.camera
    #expect(c.seenArea.contains(box))
    c.putBack(id)
    #expect(r.doc.undoName == "Put Back" && r.doc.selection == [.card(cid("n1"))])
    #expect(r.doc.board.cards.last?.id == cid("n1"), "in front of every card")
    #expect(c.camera == before && c.motion.isResting)
    // seen in part: the camera pans, its zoom kept, just far enough for 24 points round it
    r.doc.select([.card(cid("n1"))])
    r.key(1, .option)
    c.place(zoom: zoom, centre: CGPoint(x: 1200, y: 80))
    await r.idle()
    c.putBack(try #require(entry(r, holding: "n1")))
    await r.idle()
    #expect(c.camera.zoom == zoom)
    let seen = c.seenArea
    let m = 24 / zoom
    #expect(abs(seen.minX + m - box.minX) < 0.5, "its left edge 24 points in")
    #expect(seen.insetBy(dx: m - 0.5, dy: 0).minY <= box.minY)
  }

  @Test func hoveringAPictureOutlinesWhereItReturnsWhenThatIsSeen() async throws {
    let r = try await Rig(shelfBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    c.toggleShelf()
    r.doc.select([.section(sid("g1"))])
    r.key(1, .option)
    let id = try #require(r.doc.board.shelf.first?.id)
    c.place(zoom: 1, centre: CGPoint(x: 300, y: 500))
    await r.idle()
    c.showHome(id)
    // the Section's frame and its card, at their real size
    let ls = try #require(c.shelfHome.sublayers as? [CAShapeLayer])
    #expect(ls.count == 2)
    let boxes = ls.compactMap { $0.path?.boundingBox }
    #expect(boxes.contains(CGRect(x: 0, y: 400, width: 600, height: 340)))
    c.showHome(nil)
    #expect(c.shelfHome.sublayers.isNilOrEmpty)
    // its place out of sight: no outline
    c.place(zoom: 1, centre: CGPoint(x: 5000, y: 5000))
    await r.idle()
    c.showHome(id)
    #expect(c.shelfHome.sublayers.isNilOrEmpty)
  }

  @Test func aPictureDraggedOutLandsWhereItIsLetGoAndTheCameraStays() async throws {
    let r = try await Rig(shelfBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    c.toggleShelf()
    r.doc.select([.card(cid("n2"))])
    r.key(1, .option)
    let id = try #require(r.doc.board.shelf.first?.id)
    await r.settle()
    let before = c.camera
    // over the Section, grabbed by the picture's top left
    let drop = CGPoint(x: 200, y: 500)
    let window = c.convert(c.camera.view(drop), to: nil)
    c.dragOut(id, .moved, at: window, grab: .zero)
    #expect(c.shelfDrag.sublayers?.count == 2, "a dashed outline round it and round its card")
    c.dragOut(id, .ended, at: window, grab: .zero)
    let n2 = try #require(r.doc.board.card(cid("n2")))
    #expect(n2.x == 200 && n2.y == 500 && n2.section == sid("g1"))
    #expect(r.doc.selection == [.card(cid("n2"))] && r.doc.undoName == "Put Back")
    #expect(c.camera == before && c.motion.isResting && c.shelfDrag.sublayers.isNilOrEmpty)
    // let go over the panel: nothing
    r.doc.select([.card(cid("n2"))])
    r.key(1, .option)
    let id2 = try #require(r.doc.board.shelf.first?.id)
    let p = try #require(c.shelfPanel)
    let over = c.convert(CGPoint(x: p.frame.midX, y: p.frame.midY), to: nil)
    c.dragOut(id2, .ended, at: over, grab: .zero)
    #expect(r.doc.board.shelf.count == 1)
  }

  @Test func cardsDraggedOntoTheButtonGoOntoTheShelfInOneStep() async throws {
    let r = try await Rig(shelfBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let dock = try #require(c.shelfDock)
    let target = c.camera.board(CGPoint(x: dock.frame.midX, y: dock.frame.midY))
    var armed = false
    r.drag(r.centre("n1"), target) { armed = dock.armed && dock.hot }
    #expect(armed, "the button is lit under the pointer")
    #expect(entry(r, holding: "n1") != nil && r.doc.history.undoSteps.map(\.name) == ["Move to Shelf"])
    #expect(!dock.armed && dock.count == 1)
    // where it was is kept, not where it was dragged to
    #expect(r.doc.board.shelf.first?.cards.first?.x == 0)
  }
}

import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// Every button acts as main's <button> does: on a click, a press and a release over it. Pressed and let go off it, it
// does nothing; pressed off it and let go over it, nothing either. A mouse click leaves no focus ring on any of them
// (main's button:focus-visible shows none for a mouse click).

/// A press at `down` and a release at `up`, through `via` when given (a drag over a point between), in `view`'s points
@MainActor func pressIn(_ view: NSView, _ down: CGPoint, up: CGPoint? = nil, via: CGPoint? = nil) {
  func ev(_ type: NSEvent.EventType, _ p: CGPoint) -> NSEvent {
    NSEvent.mouseEvent(
      with: type, location: view.convert(p, to: nil), modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: view.window?.windowNumber ?? 0, context: nil,
      eventNumber: 0, clickCount: 1, pressure: 1)!
  }
  view.mouseDown(with: ev(.leftMouseDown, down))
  for p in [via, up].compactMap({ $0 }) { view.mouseDragged(with: ev(.leftMouseDragged, p)) }
  view.mouseUp(with: ev(.leftMouseUp, up ?? down))
}

extension CGRect {
  var centre: CGPoint { CGPoint(x: midX, y: midY) }
}

@MainActor @Suite(.serialized) struct ButtonReleaseTests {
  /// The buttons drawn on the board (a Section's chevron and Lock, a sidenote's marker) act on the release over them
  @Test func buttonsOnTheBoardActOnTheReleaseOverThem() async throws {
    var b = sample()
    b.sidenotes = [
      Sidenote(id: SidenoteID(rawValue: "w1"), anchor: .card(cid("n1")), body: .text(TextNote(text: "a sidenote")))
    ]
    let r = try await Rig(b, zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let g = SectionID(rawValue: "g1")
    func act(_ a: SectionAct) throws -> CGPoint {
      try #require(c.actsLayout(g).first { $0.0 == a }?.1.centre, "\(a)")
    }
    let off = CGPoint(x: 780, y: 340)
    // the chevron, faded before any hover: let go off it, nothing; pressed off it and let go over it, nothing
    let chevron = try act(.fold)
    r.drag(chevron, off)
    #expect(r.doc.board.section(g)?.collapsed == false, "let go off it")
    r.drag(off, chevron)
    #expect(r.doc.board.section(g)?.collapsed == false, "pressed off it")
    r.send(r.mouse(.leftMouseDown, chevron))
    #expect(r.doc.board.section(g)?.collapsed == false, "the press alone does nothing")
    r.send(r.mouse(.leftMouseUp, chevron))
    #expect(r.doc.board.section(g)?.collapsed == true, "a click folds it")
    await r.settle()
    // folded, its chevron after the count
    r.click(try act(.fold))
    #expect(r.doc.board.section(g)?.collapsed == false, "a click opens it again")
    await r.settle()
    // the selected Section's Lock
    r.doc.select([.section(g)])
    let lock = try act(.lock)
    r.drag(lock, off)
    #expect(r.doc.board.section(g)?.locked == false, "let go off it")
    r.doc.select([.section(g)])
    r.click(try act(.lock))
    #expect(r.doc.board.section(g)?.locked == true, "a click locks it")
    // a card's sidenote marker
    let at = PopAt.spot(.card(cid("n1")))
    let marker = try #require(c.marks.first { $0.at == at }?.hit.centre)
    r.drag(marker, off)
    #expect(c.openPop == nil, "let go off it")
    r.send(r.mouse(.leftMouseDown, marker))
    #expect(c.openPop == nil, "the press alone does nothing")
    r.send(r.mouse(.leftMouseUp, marker))
    #expect(c.openPop == at, "a click opens its popup")
  }

  /// The sticker palette's slots: a slot acts on the release over the slot pressed
  @Test func theStickerPalettesSlotsActOnTheReleaseOverThem() async throws {
    let r = try await Rig(stickerBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let button = CGRect(x: 480, y: 640, width: 30, height: 28)
    c.toggleStickerPalette(above: button)
    var p = try #require(c.stickerPalette)
    let slots = StickerPalette.rects()
    pressIn(p, slots[0].centre, up: CGPoint(x: slots[0].midX, y: -40))
    #expect(c.placing == nil && c.stickerPalette != nil, "let go off it")
    pressIn(p, slots[0].centre, up: slots[1].centre)
    #expect(c.placing == nil && c.stickerPalette != nil, "let go over another")
    pressIn(p, CGPoint(x: -20, y: -20), up: slots[0].centre)
    #expect(c.placing == nil && c.stickerPalette != nil, "pressed off them")
    p = try #require(c.stickerPalette)
    pressIn(p, slots[0].centre, up: slots[0].centre, via: CGPoint(x: slots[0].midX, y: -40))
    #expect(c.placing == StickerPalette.slots[0].glyph, "let go over it again: picked")
  }

  /// The X of the shortcut list and of the Shelf, the large picture's Put Back
  @Test func theXsAndPutBackActOnTheReleaseOverThem() async throws {
    let r = try await Rig(shelfBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    // the shortcut list
    c.toggleKeys()
    let keys = try #require(c.keysPanel)
    pressIn(keys, keys.closeRect.centre, up: CGPoint(x: 10, y: 200))
    #expect(c.keysPanel != nil, "let go off its X")
    pressIn(keys, CGPoint(x: 10, y: 200), up: keys.closeRect.centre)
    #expect(c.keysPanel != nil, "pressed off its X")
    pressIn(keys, keys.closeRect.centre)
    #expect(c.keysPanel == nil, "a click on its X")
    // the Shelf's panel
    c.toggleShelf()
    let panel = try #require(c.shelfPanel)
    pressIn(panel, panel.closeRect.centre, up: CGPoint(x: 20, y: 200))
    #expect(c.shelfPanel != nil, "let go off its X")
    pressIn(panel, CGPoint(x: 20, y: 200), up: panel.closeRect.centre)
    #expect(c.shelfPanel != nil, "pressed off its X")
    // the large picture's Put Back
    r.doc.select([.card(cid("n1"))])
    r.key(1, .option)
    let id = try #require(r.doc.board.shelf.first?.id)
    c.togglePreview(id)
    let v = try #require(c.shelfPreview)
    pressIn(v, v.buttonRect.centre, up: CGPoint(x: v.buttonRect.midX, y: v.buttonRect.minY - 60))
    #expect(r.doc.board.shelf.count == 1, "let go off Put Back")
    pressIn(v, v.buttonRect.centre)
    #expect(r.doc.board.shelf.isEmpty && r.doc.board.card(cid("n1")) != nil, "a click puts it back")
    pressIn(panel, panel.closeRect.centre)
    #expect(c.shelfPanel == nil, "a click on its X")
  }

  /// The toolbar's tools and the dock's parts were already so: pressed on one and let go off it or over another,
  /// nothing
  @Test func theToolbarAndTheDockActOnTheReleaseOverThePartPressed() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let bar = CanvasToolbar(frame: CGRect(x: 0, y: 0, width: 900, height: 80))
    r.window.contentView?.addSubview(bar)
    var tools: [Tool] = []
    bar.onTool = { tools.append($0) }
    let rs = bar.buttonRects()
    pressIn(bar, rs[0].centre, up: CGPoint(x: rs[0].midX, y: -60))
    pressIn(bar, rs[0].centre, up: rs[1].centre)
    #expect(tools.isEmpty)
    pressIn(bar, rs[1].centre)
    #expect(tools == [bar.tools[1]])
    let dock = r.canvas.dock
    var parts: [CanvasDock.Part] = []
    dock.onPart = { parts.append($0) }
    let ps = dock.layoutParts().parts
    let fit = try #require(ps[.fit])
    let zoomIn = try #require(ps[.zoomIn])
    pressIn(dock, fit.centre, up: CGPoint(x: fit.midX, y: -60))
    pressIn(dock, fit.centre, up: zoomIn.centre)
    #expect(parts.isEmpty)
    pressIn(dock, fit.centre)
    #expect(parts == [.fit])
  }

  /// None of them takes the keyboard focus from a click, and the canvas, which does, draws no ring
  @Test func aClickLeavesNoFocusRing() async throws {
    let r = try await Rig(stickerBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    c.toggleStickerPalette(above: CGRect(x: 480, y: 640, width: 30, height: 28))
    c.toggleKeys()
    c.toggleShelf()
    let views: [NSView] = [
      CanvasToolbar(), c.dock, try #require(c.stickerPalette), try #require(c.keysPanel), try #require(c.shelfPanel),
    ]
    for v in views { #expect(!v.acceptsFirstResponder, "\(type(of: v))") }
    r.click(CGPoint(x: 900, y: 900))
    #expect(r.window.firstResponder === c && c.focusRingMaskBounds == .zero)
  }
}

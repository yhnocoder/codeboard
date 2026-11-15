import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// Scrolling and pinching over what is being written on the board (main panKeepsGoingOverCards): over a Note, Text or
// Box in its editor, a summary in its editor, a label's or a title's field, the board moves as over any card; a gesture
// the board took keeps going over them, its momentum too. The events are the system's kind and go through the window,
// which sends each to the view under the pointer: the web view or field there would keep it if it did not hand the
// board's gestures back. The pointer stays where it is in the window while the board moves under it.

extension Rig {
  /// A trackpad scroll or pinch event at a window point, as the system makes it
  func gesture(
    at w: CGPoint, dy: CGFloat = 0, phase: Int64 = 0, momentum: Int64 = 0, pinch: Double? = nil, t: TimeInterval
  ) -> NSEvent {
    let screenH = NSScreen.screens.first?.frame.height ?? 0
    let e: CGEvent
    if let pinch {
      e = CGEvent(source: nil)!
      e.type = CGEventType(rawValue: 29)!
      e.setIntegerValueField(CGEventField(rawValue: 110)!, value: 8)
      e.setDoubleValueField(CGEventField(rawValue: 113)!, value: pinch)
      e.setIntegerValueField(CGEventField(rawValue: 132)!, value: phase)
    } else {
      e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: 0, wheel3: 0)!
      e.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
      e.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
      e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    }
    // posted, not from the window server: an event without a window, its location the window's own (as the Accept
    // driver sends them), which the window hit-tests
    e.location = CGPoint(x: w.x, y: screenH - w.y)
    e.timestamp = UInt64(t * 1e9)
    e.setIntegerValueField(CGEventField(rawValue: 91)!, value: Int64(window.windowNumber))
    e.setIntegerValueField(CGEventField(rawValue: 92)!, value: Int64(window.windowNumber))
    return NSEvent(cgEvent: e)!
  }

  /// The view under a board point
  func hit(_ p: CGPoint) -> NSView? {
    guard let frame = window.contentView?.superview else { return nil }
    return frame.hitTest(frame.convert(at(p), from: nil))
  }

  /// As the app gets it: the window sends it to the view under the pointer (the app's event monitor, which sees only
  /// what NSApp sends, is not in the way)
  func deliver(_ e: NSEvent) {
    window.sendEvent(e)
  }

  /// A two-finger scroll of 10 steps of `dy`, its first event where the board point `from` is when it begins, the
  /// pointer moving in the window to where `to` was then; the fingers rest before lifting (no glide), then `momentum`
  /// events follow. How far the camera moved (view points)
  func scrollGesture(from: CGPoint, to: CGPoint? = nil, dy: CGFloat = -12, momentum: Int = 0) -> CGFloat {
    let c0 = canvas.currentCamera
    let a = at(from)
    let b = at(to ?? from)
    func along(_ k: CGFloat) -> CGPoint { CGPoint(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k) }
    deliver(gesture(at: a, phase: 1, t: next(1.0 / 120)))
    for i in 1...10 {
      deliver(gesture(at: along(CGFloat(i) / 10), dy: dy, phase: 2, t: next(1.0 / 120)))
    }
    deliver(gesture(at: b, phase: 4, t: next(0.1)))
    for i in 0..<momentum {
      deliver(gesture(at: b, dy: dy, momentum: i == 0 ? 1 : i == momentum - 1 ? 3 : 2, t: next(1.0 / 120)))
    }
    return (c0.origin.y - canvas.currentCamera.origin.y) * canvas.currentCamera.zoom
  }

  func pinchGesture(at p: CGPoint) -> CGFloat {
    let z0 = canvas.currentCamera.zoom
    let w = at(p)
    deliver(gesture(at: w, phase: 1, pinch: 0, t: next(1.0 / 120)))
    for _ in 0..<5 {
      deliver(gesture(at: w, phase: 2, pinch: 0.04, t: next(1.0 / 120)))
    }
    deliver(gesture(at: w, phase: 4, pinch: 0, t: next(0.01)))
    return canvas.currentCamera.zoom / z0
  }
}

@MainActor @Suite(.serialized) struct CanvasWheelTests {
  /// Far from every card: what a gesture does on the bare board
  let bare = CGPoint(x: 760, y: 340)

  /// The cards in view, from their tops
  let view = CGPoint(x: 450, y: 250)

  /// What a scroll does on the bare board, the camera then put back
  func baseline(_ r: Rig, dy: CGFloat = -12, momentum: Int = 0) async -> CGFloat {
    r.canvas.place(zoom: 1, centre: view)
    await r.idle()
    let want = r.scrollGesture(from: bare, dy: dy, momentum: momentum)
    await r.idle()
    r.canvas.place(zoom: 1, centre: view)
    await r.idle()
    return want
  }

  /// The pointer at rest while the board changes under it: the card under it deleted, another card moved there, each
  /// undone, the Section it is in folded; on the next frame what is under it is hovered, and nothing gone stays hovered
  @Test func whatABoardChangeBringsUnderARestingPointerIsHovered() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    c.place(zoom: 1, centre: view)
    await r.idle()
    let p = r.centre("b1")
    c.mouseMoved(with: r.mouse(.mouseMoved, p))
    #expect(c.hoveredCard == cid("b1"))
    func now() -> CardID? {
      r.tick()
      return c.hoveredCard
    }
    r.doc.select([.card(cid("b1"))])
    r.key(51)
    await r.settle()
    #expect(
      c.hitCard(p) == nil,
      "\(String(describing: c.hitCard(p))) \(r.doc.board.card(cid("b1")) == nil) \(String(describing: r.window.firstResponder))"
    )
    #expect(now() == nil, "b1 deleted: nothing hovered")
    // t1 moved under the pointer
    let t = r.centre("t1")
    r.doc.edit("Move") { $0.move([.card(cid("t1"))], dx: p.x - t.x, dy: p.y - t.y) }
    await r.settle()
    #expect(c.hitCard(p) == cid("t1"), "\(String(describing: c.hitCard(p))) t1 at \(r.rect("t1")) p \(p)")
    #expect(now() == cid("t1"), "t1 moved there: hovered")
    r.doc.undo()
    await r.settle()
    #expect(now() == nil, "the move undone")
    r.doc.undo()
    await r.settle()
    #expect(now() == cid("b1"), "the delete undone: b1 again")
    // m1, in Group: the Section folded, nothing of it there to hover
    let m = r.centre("m1")
    c.mouseMoved(with: r.mouse(.mouseMoved, m))
    #expect(c.hoveredCard == cid("m1"))
    c.press(.fold, of: SectionID(rawValue: "g1"))
    await r.settle()
    await r.idle()
    #expect(now() != cid("m1"), "folded: \(String(describing: c.hoveredCard)) hit \(String(describing: c.hitCard(m)))")
  }

  /// The pointer at rest while the board moves under it: what is under it now is hovered, the card it was over is not
  /// (stale-hover.txt), by a scroll there and by a camera jump (⇧1, Fit All)
  @Test func whatTheBoardBringsUnderARestingPointerIsHovered() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    c.place(zoom: 1, centre: view)
    await r.idle()
    let p = r.centre("t1")
    c.mouseMoved(with: r.mouse(.mouseMoved, p))
    #expect(c.hoveredCard == cid("t1"))
    let w = r.at(p)
    func under() -> CardID? { c.hitCard(c.camera.board(c.convert(w, from: nil))) }
    // the scroll's events where the pointer rests, in the window
    func here() -> CGPoint { c.camera.board(c.convert(w, from: nil)) }
    for _ in 0..<20 where under() != cid("b1") { _ = r.scrollGesture(from: here(), dy: -4) }
    try #require(under() == cid("b1"), "the scroll brought b1 under the pointer")
    #expect(c.hoveredCard == cid("b1"), "hovered: \(String(describing: c.hoveredCard))")
    c.place(zoom: 1, centre: r.centre("n1"))
    let now = under()
    #expect(
      now != cid("b1") && c.hoveredCard == now,
      "after the jump: \(String(describing: c.hoveredCard)) over \(String(describing: now))")
  }

  @Test(arguments: ["n1", "t1", "b1"])
  func aScrollOverACardBeingWrittenInMovesTheBoard(id: String) async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let want = await baseline(r)
    #expect(abs(want) > 100, "the bare board moves: \(want)")
    let p = id == "n1" ? CGPoint(x: 40, y: 40) : r.centre(id)
    #expect(r.hit(p) === r.canvas, "the card is in view")
    r.doubleClick(p)
    await r.editorReady()
    // the editor is what is under the pointer there
    let v = try #require(r.canvas.writingView)
    let hit = r.hit(p)
    #expect(
      hit.map { $0 === v || $0.isDescendant(of: v) } == true,
      "under the pointer: \(hit.map { String(describing: type(of: $0)) } ?? "nothing"), editor at \(v.frame)")
    let moved = r.scrollGesture(from: p)
    #expect(abs(moved - want) < 0.01, "over the editor: \(moved), on the bare board: \(want)")
    #expect(r.canvas.isEditing, "still writing")
  }

  @Test func aScrollThatBeganOnTheBoardKeepsGoingOverTheEditorWithItsMomentum() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let want = await baseline(r, momentum: 6)
    r.doubleClick(CGPoint(x: 40, y: 40))
    await r.editorReady()
    let over = CGPoint(x: 60, y: 60)
    let moved = r.scrollGesture(from: bare, to: over, dy: -12, momentum: 6)
    #expect(
      abs(moved - want) < 0.01, "moved \(moved), want \(want): the momentum is the board's own glide, not the page's")
  }

  @Test(arguments: [0, 6])
  func aScrollThatBeganBesideTheCardBeingWrittenKeepsGoingWhenTheCardComesUnderThePointer(momentum: Int) async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let want = await baseline(r, dy: 12, momentum: momentum)
    r.doubleClick(CGPoint(x: 40, y: 40))
    await r.editorReady()
    // just below the card: the board moving down brings the card under the still pointer
    let card = r.rect("n1")
    let p = CGPoint(x: card.midX, y: card.maxY + 20)
    #expect(r.hit(p) === r.canvas, "beside the card: the board")
    let w = r.at(p)
    let moved = r.scrollGesture(from: p, dy: 12, momentum: momentum)
    let now = r.canvas.camera.board(r.canvas.convert(w, from: nil))
    #expect(card.contains(now), "the card came under the pointer: \(now) in \(card)")
    #expect(abs(moved - want) < 0.01, "moved \(moved), on the bare board \(want)")
    #expect(r.canvas.isEditing, "still writing")
  }

  @Test func aPinchOverTheEditorZoomsTheBoard() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.canvas.place(zoom: 1, centre: view)
    await r.idle()
    let want = r.pinchGesture(at: bare)
    #expect(want > 1.1, "the bare board zooms")
    await r.idle()
    r.canvas.place(zoom: 1, centre: view)
    await r.idle()
    r.doubleClick(CGPoint(x: 40, y: 40))
    await r.editorReady()
    let k = r.pinchGesture(at: CGPoint(x: 60, y: 60))
    #expect(abs(k - want) < 0.001, "over the editor ×\(k), on the bare board ×\(want)")
  }

  @Test func aScrollOverATitleBeingWrittenMovesTheBoard() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let want = await baseline(r)
    #expect(abs(want) > 100, "\(want)")
    r.canvas.editTitle(SectionID(rawValue: "g1"))
    let field = try #require(r.canvas.inPlace?.field)
    let p = r.canvas.camera.board(
      r.canvas.convert(CGPoint(x: field.frame.midX, y: field.frame.midY), from: field.superview))
    let hit = r.hit(p)
    #expect(hit.map { $0 === field || $0.isDescendant(of: field) } == true)
    let moved = r.scrollGesture(from: p)
    #expect(abs(moved - want) < 0.01, "over the field: \(moved), on the bare board: \(want)")
  }

  func take(_ w: inout WheelOwner, began: Bool, phased: Bool, momentum: Bool, ended: Bool, over: Bool, at t: Double)
    -> Bool
  { w.scroll(began: began, phased: phased, momentum: momentum, ended: ended, over: over, at: t) }

  @Test func aScrollThatBeganOverChromeStaysThere() {
    var w = WheelOwner()
    #expect(!take(&w, began: true, phased: true, momentum: false, ended: false, over: false, at: 1))
    #expect(!take(&w, began: false, phased: true, momentum: false, ended: false, over: true, at: 1.01))
    #expect(!take(&w, began: false, phased: false, momentum: true, ended: false, over: true, at: 1.05))
    // the board's own: kept while its events come, momentum to its end
    #expect(take(&w, began: true, phased: true, momentum: false, ended: false, over: true, at: 2))
    #expect(take(&w, began: false, phased: true, momentum: false, ended: false, over: false, at: 2.01))
    #expect(take(&w, began: false, phased: false, momentum: true, ended: false, over: false, at: 2.1))
    #expect(take(&w, began: false, phased: false, momentum: true, ended: true, over: false, at: 2.2))
    #expect(!take(&w, began: false, phased: false, momentum: true, ended: false, over: false, at: 2.21))
    // a mouse wheel: one gesture while its notches come within the gap
    #expect(take(&w, began: false, phased: false, momentum: false, ended: false, over: true, at: 3))
    #expect(take(&w, began: false, phased: false, momentum: false, ended: false, over: false, at: 3.15))
    #expect(!take(&w, began: false, phased: false, momentum: false, ended: false, over: false, at: 3.5))
  }
}

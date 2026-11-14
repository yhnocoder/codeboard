import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// Scrolling and pinching over what is being written on the board (main panKeepsGoingOverCards): over a Note, Text or
// Box in its editor, a summary in its editor, a label's or a title's field, the board moves as over any card; a gesture
// the board took keeps going over them, its momentum too. The events are the system's kind, so the web view or field under the pointer would take them if nothing routed them: `deliver` does what the app does
// with one (its event monitor, then the view under the pointer), at a point given, as an off-screen window's events
// cannot carry where they are.

extension Rig {
  /// A trackpad scroll or pinch event at a board point, as the system makes it
  func gesture(
    at p: CGPoint, dy: CGFloat = 0, phase: Int64 = 0, momentum: Int64 = 0, pinch: Double? = nil, t: TimeInterval
  ) -> NSEvent {
    let w = window.convertPoint(toScreen: at(p))
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
    e.location = CGPoint(x: w.x, y: screenH - w.y)
    e.timestamp = UInt64(t * 1e9)
    e.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(window.windowNumber))
    e.setIntegerValueField(CGEventField(rawValue: 91)!, value: Int64(window.windowNumber))
    e.setIntegerValueField(CGEventField(rawValue: 92)!, value: Int64(window.windowNumber))
    return NSEvent(cgEvent: e)!
  }

  /// The view under a board point
  func hit(_ p: CGPoint) -> NSView? {
    guard let frame = window.contentView?.superview else { return nil }
    return frame.hitTest(frame.convert(at(p), from: nil))
  }

  /// What the app does with a scroll or pinch at a board point: the board's router first, else the view under it
  func deliver(_ e: NSEvent, at p: CGPoint) {
    if canvas.route(e, at: at(p)) { return }
    guard let hit = hit(p) else { return }
    if e.type == .magnify { hit.magnify(with: e) } else { hit.scrollWheel(with: e) }
  }

  /// A two-finger scroll of 10 steps of `dy`, its first event at `from`, the pointer moving to `to` on the way; the
  /// fingers rest before lifting (no glide), then `momentum` events follow. How far the camera moved (view points)
  func scrollGesture(from: CGPoint, to: CGPoint? = nil, dy: CGFloat = -12, momentum: Int = 0) -> CGFloat {
    let c0 = canvas.currentCamera
    var t = 5000.0 + Double(Int.random(in: 0..<1000))
    let to = to ?? from
    func at(_ k: CGFloat) -> CGPoint { CGPoint(x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k) }
    deliver(gesture(at: from, phase: 1, t: t), at: from)
    for i in 1...10 {
      t += 1.0 / 120
      deliver(gesture(at: at(CGFloat(i) / 10), dy: dy, phase: 2, t: t), at: at(CGFloat(i) / 10))
    }
    t += 0.1
    deliver(gesture(at: to, phase: 4, t: t), at: to)
    for i in 0..<momentum {
      t += 1.0 / 120
      deliver(gesture(at: to, dy: dy, momentum: i == 0 ? 1 : i == momentum - 1 ? 3 : 2, t: t), at: to)
    }
    return (c0.origin.y - canvas.currentCamera.origin.y) * canvas.currentCamera.zoom
  }

  func pinchGesture(at p: CGPoint) -> CGFloat {
    let z0 = canvas.currentCamera.zoom
    var t = 9000.0
    deliver(gesture(at: p, phase: 1, pinch: 0, t: t), at: p)
    for _ in 0..<5 {
      t += 1.0 / 120
      deliver(gesture(at: p, phase: 2, pinch: 0.04, t: t), at: p)
    }
    deliver(gesture(at: p, phase: 4, pinch: 0, t: t + 0.01), at: p)
    return canvas.currentCamera.zoom / z0
  }
}

@MainActor @Suite(.serialized) struct CanvasWheelTests {
  /// Far from every card: what a gesture does on the bare board
  let bare = CGPoint(x: 760, y: 340)

  /// The cards in view, from their tops
  let view = CGPoint(x: 450, y: 250)

  /// What a scroll does on the bare board, the camera then put back
  func baseline(_ r: Rig, momentum: Int = 0) async -> CGFloat {
    r.canvas.place(zoom: 1, centre: view)
    await r.idle()
    let want = r.scrollGesture(from: bare, momentum: momentum)
    await r.idle()
    r.canvas.place(zoom: 1, centre: view)
    await r.idle()
    return want
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
    // the editor's web view is what is under the pointer there
    let hit = r.hit(p)
    #expect(
      hit.map { $0 === r.canvas.noteEditor.view || $0.isDescendant(of: r.canvas.noteEditor.view) } == true,
      "under the pointer: \(hit.map { String(describing: type(of: $0)) } ?? "nothing"), editor at \(r.canvas.noteEditor.view.frame), point \(r.at(p))"
    )
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

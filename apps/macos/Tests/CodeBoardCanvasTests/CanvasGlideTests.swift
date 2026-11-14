import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// The app's own glide after a two-finger swipe (Motion's glide, started by the gesture's end; the system's momentum
// events are dropped): how far it goes, that it comes to rest, what stops it at once, and the hover under a pointer
// at rest following the board as it glides. Every event's time and every frame is the rig's clock.

@MainActor @Suite(.serialized) struct CanvasGlideTests {
  /// The cards in view, from their tops; a point between t1 and b1, on no card, away from their ports (a card's
  /// hover stays on its port just outside it)
  let view = CGPoint(x: 450, y: 250)
  let between = CGPoint(x: 560, y: 120)

  /// A swipe of `n` steps of `dy` at 120 Hz where the board point `p` is, lifted at once (no rest before the end, so
  /// it glides). The speed Motion takes from it: each step's move as the camera made it, through Motion's average
  func swipe(_ r: Rig, at p: CGPoint, dy: CGFloat = -12, steps n: Int = 10) -> CGVector {
    let c = r.canvas
    let w = r.at(p)
    let dt = 1.0 / 120
    let a = 1 - exp(-dt / 0.04)
    var v = CGVector.zero
    r.deliver(r.gesture(at: w, phase: 1, t: r.next(dt)))
    for _ in 0..<n {
      let o = c.camera.origin
      r.deliver(r.gesture(at: w, dy: dy, phase: 2, t: r.next(dt)))
      // the content moved by d view points: the camera's origin by -d / zoom
      let d = CGVector(dx: (o.x - c.camera.origin.x) * c.camera.zoom, dy: (o.y - c.camera.origin.y) * c.camera.zoom)
      v.dx += (d.dx / dt - v.dx) * a
      v.dy += (d.dy / dt - v.dy) * a
    }
    r.deliver(r.gesture(at: w, phase: 4, t: r.next(dt)))
    return v
  }

  func gliding(_ c: CanvasView) -> Bool {
    if case .glide = c.motion.phase { true } else { false }
  }

  func rig() async throws -> Rig {
    let r = try await Rig(zoom: 1)
    r.canvas.place(zoom: 1, centre: view)
    await r.idle()
    return r
  }

  /// Let go: the board goes on over the next frames, as far as Motion's glide takes it (glideTau × (v0 − glideStop),
  /// give or take its last frame), then rests and stays
  @Test func aSwipeLetGoGlidesAsFarAsMotionSaysThenRests() async throws {
    let r = try await rig()
    defer { r.close() }
    let c = r.canvas
    let v0 = swipe(r, at: between)
    let speed = hypot(v0.dx, v0.dy)
    #expect(gliding(c), "it glides: v0 \(speed) pt/s")
    let start = c.camera.origin
    r.tick()
    #expect(c.camera.origin != start, "the first frame after letting go moves the board")
    var frames = 1
    while gliding(c) && frames < 600 {
      r.tick()
      frames += 1
    }
    #expect(!gliding(c), "the glide ends within \(frames) frames")
    let moved = CGVector(
      dx: (start.x - c.camera.origin.x) * c.camera.zoom, dy: (start.y - c.camera.origin.y) * c.camera.zoom)
    let want = Motion.glideTau * (speed - Motion.glideStop)
    #expect(abs(hypot(moved.dx, moved.dy) - want) < 0.5, "glided \(hypot(moved.dx, moved.dy)) pt, Motion's \(want)")
    // along the swipe
    #expect(abs(moved.dx * v0.dy - moved.dy * v0.dx) < 0.5 * speed && moved.dx * v0.dx + moved.dy * v0.dy > 0)
    // at rest: later frames leave it where it is
    let rest = c.camera
    for _ in 0..<30 { r.tick() }
    #expect(c.camera == rest && c.motion.isResting)
  }

  enum Stop: String, CaseIterable {
    case press, rightPress, otherPress, scroll, mayBegin, pinch
  }

  /// Mid-glide a press of any button on the board (a right press before its menu is built), fingers on the trackpad
  /// again (moving or not yet), or a pinch beginning stops it where it is: the next frames move nothing
  @Test(arguments: Stop.allCases) func aGlideStopsAtOnce(by stop: Stop) async throws {
    let r = try await rig()
    defer { r.close() }
    let c = r.canvas
    _ = swipe(r, at: between)
    for _ in 0..<3 { r.tick() }
    try #require(gliding(c), "mid-glide")
    let w = r.at(between)
    let p = c.camera.board(c.convert(w, from: nil))
    switch stop {
    case .press: r.send(r.mouse(.leftMouseDown, p))
    // what AppKit's right press asks first; the menu is never shown here
    case .rightPress: _ = c.menu(for: r.mouse(.rightMouseDown, p))
    case .otherPress: c.otherMouseDown(with: r.mouse(.otherMouseDown, p))
    case .scroll: r.deliver(r.gesture(at: w, phase: 1, t: r.next(1.0 / 120)))
    case .mayBegin: r.deliver(r.gesture(at: w, phase: 128, t: r.next(1.0 / 120)))
    case .pinch: r.deliver(r.gesture(at: w, phase: 1, pinch: 0, t: r.next(1.0 / 120)))
    }
    let there = c.camera
    #expect(!gliding(c), "\(stop.rawValue): still gliding after it")
    for _ in 0..<3 { r.tick() }
    #expect(c.camera == there, "\(stop.rawValue): moved on to \(c.camera.origin) from \(there.origin)")
    if stop == .press { r.send(r.mouse(.leftMouseUp, p)) }
  }

  /// At the stop the hover is worked out again for the camera there: the card under the resting pointer is hovered
  @Test func aPressMidGlideHoversWhatIsUnderThePointerThen() async throws {
    let r = try await rig()
    defer { r.close() }
    let c = r.canvas
    c.mouseMoved(with: r.mouse(.mouseMoved, between))
    let w = r.at(between)
    func under() -> CardID? { c.hitCard(c.camera.board(c.convert(w, from: nil))) }
    _ = swipe(r, at: between, steps: 4)
    var frames = 0
    while under() == nil && gliding(c) && frames < 600 {
      r.tick()
      frames += 1
    }
    try #require(gliding(c) && under() != nil, "a card under the pointer mid-glide")
    // the hover as nothing had set it: the stop alone must set it again
    c.hoveredCard = nil
    _ = c.menu(for: r.mouse(.rightMouseDown, c.camera.board(c.convert(w, from: nil))))
    #expect(
      c.hoveredCard == under(), "hovered \(String(describing: c.hoveredCard)), under \(String(describing: under()))")
  }

  /// Mid-glide a press on a card and a drag: the card follows the pointer, the camera stays where the press
  /// stopped it, frames between the drag's steps included
  @Test func aCardPressedAndDraggedMidGlideFollowsThePointerOnAStillBoard() async throws {
    let r = try await rig()
    defer { r.close() }
    let c = r.canvas
    _ = swipe(r, at: between)
    for _ in 0..<3 { r.tick() }
    try #require(gliding(c), "mid-glide")
    let card = r.rect("b1")
    let from = r.centre("b1")
    let start = r.at(from)
    r.send(r.mouse(.leftMouseDown, from))
    let there = c.camera
    let by = CGVector(dx: 60, dy: 40)
    for k in 1...6 {
      r.tick()
      let f = CGFloat(k) / 6
      r.send(r.mouse(.leftMouseDragged, CGPoint(x: from.x + by.dx * f, y: from.y + by.dy * f)))
      #expect(c.camera == there, "step \(k): the camera moved to \(c.camera.origin) from \(there.origin)")
    }
    r.send(r.mouse(.leftMouseUp, CGPoint(x: from.x + by.dx, y: from.y + by.dy)))
    r.tick()
    #expect(c.camera == there)
    let moved = r.card("b1")
    #expect(moved.x == card.minX + by.dx && moved.y == card.minY + by.dy, "b1 at \(moved.x), \(moved.y)")
    // under the pointer still: the press point moved with it in the window
    let end = r.at(CGPoint(x: from.x + by.dx, y: from.y + by.dy))
    #expect(abs(end.x - start.x - by.dx) < 0.01 && abs(abs(end.y - start.y) - by.dy) < 0.01)
  }

  enum Key: String, CaseIterable {
    case fitWindow, fitAll, fitSelection, zoom100, zoomIn, zoomOut
  }

  /// Mid-glide a camera key takes over at once: the camera ends exactly where the key puts it from where the glide
  /// was when it was pressed, with nothing of the glide added
  @Test(arguments: Key.allCases) func aCameraKeyMidGlideTakesOverFromIt(_ key: Key) async throws {
    let r = try await rig()
    defer { r.close() }
    let c = r.canvas
    r.window.makeFirstResponder(c)
    r.doc.select([.card(cid("t1"))])
    _ = swipe(r, at: between)
    for _ in 0..<3 { r.tick() }
    try #require(gliding(c), "mid-glide")
    let there = c.camera
    let mid = CGPoint(x: c.bounds.midX, y: c.bounds.midY)
    func zoomed(_ f: CGFloat) -> Camera {
      var z = there
      z.zoom(to: c.limits.clamp(there.zoom * f), at: mid)
      return z
    }
    let all = try #require(c.scene?.bounds)
    let (code, flags, want): (UInt16, NSEvent.ModifierFlags, Camera) =
      switch key {
      case .fitWindow: (18, .shift, c.fitRect(all, maxZoom: 1))
      case .fitAll: (29, .command, c.fitRect(all, maxZoom: 1))
      case .fitSelection: (19, .shift, c.fitRect(r.rect("t1"), maxZoom: 1.4))
      case .zoom100: (18, .command, zoomed(1 / there.zoom))
      case .zoomIn: (24, .command, zoomed(1.25))
      case .zoomOut: (27, .command, zoomed(0.8))
      }
    let e = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: flags, timestamp: r.next(0.016),
      windowNumber: r.window.windowNumber, context: nil, characters: "", charactersIgnoringModifiers: "",
      isARepeat: false, keyCode: code)!
    if flags.contains(.command) { #expect(c.performKeyEquivalent(with: e)) } else { c.keyDown(with: e) }
    #expect(!gliding(c), "\(key.rawValue): still gliding")
    var frames = 0
    while !c.motion.isResting && frames < 600 {
      r.tick()
      frames += 1
    }
    #expect(c.camera == want, "\(key.rawValue): at \(c.camera), the key's \(want)")
  }

  /// Mid-glide the pointer rests where it is in the window: whatever card the board brings under it is hovered on that
  /// frame (applyCamera's rehover)
  @Test func theHoverFollowsTheGlidingBoardUnderARestingPointer() async throws {
    let r = try await rig()
    defer { r.close() }
    let c = r.canvas
    c.mouseMoved(with: r.mouse(.mouseMoved, between))
    let w = r.at(between)
    func under() -> CardID? { c.hitCard(c.camera.board(c.convert(w, from: nil))) }
    try #require(under() == nil && c.hoveredCard == nil, "on no card at first")
    // a short swipe (48 pt): no card under the pointer yet; its glide (about 190 pt) brings t1 or b1 under it
    _ = swipe(r, at: between, steps: 4)
    try #require(under() == nil, "still on no card when let go")
    var came: CardID?
    var frames = 0
    while gliding(c) && frames < 600 {
      r.tick()
      frames += 1
      #expect(
        c.hoveredCard == under(),
        "frame \(frames): hovered \(String(describing: c.hoveredCard)), under \(String(describing: under()))")
      if came == nil, let u = under() { came = u }
    }
    #expect(came != nil, "a card came under the pointer while it glided")
  }
}

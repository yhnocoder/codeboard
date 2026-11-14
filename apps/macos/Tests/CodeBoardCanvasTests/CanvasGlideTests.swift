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
    case press, scroll, pinch
  }

  /// Mid-glide a press on the board, fingers on the trackpad again, or a pinch beginning stops it where it is: the
  /// next frame moves nothing
  @Test(arguments: Stop.allCases) func aGlideStopsAtOnce(by stop: Stop) async throws {
    let r = try await rig()
    defer { r.close() }
    let c = r.canvas
    _ = swipe(r, at: between)
    for _ in 0..<3 { r.tick() }
    try #require(gliding(c), "mid-glide")
    let w = r.at(between)
    switch stop {
    case .press: r.send(r.mouse(.leftMouseDown, c.camera.board(c.convert(w, from: nil))))
    case .scroll: r.deliver(r.gesture(at: w, phase: 1, t: r.next(1.0 / 120)))
    case .pinch: r.deliver(r.gesture(at: w, phase: 1, pinch: 0, t: r.next(1.0 / 120)))
    }
    let there = c.camera
    r.tick()
    let still = {
      #expect(c.camera == there && !gliding(c), "\(stop.rawValue): moved on to \(c.camera.origin) from \(there.origin)")
    }
    if stop == .press {
      withKnownIssue("a press does not stop a glide yet: nothing on the mouse path touches Motion") { still() }
    } else {
      still()
    }
    if stop == .press { r.send(r.mouse(.leftMouseUp, c.camera.board(c.convert(w, from: nil)))) }
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

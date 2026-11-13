import CoreGraphics
import Foundation

/// How the camera moves: trackpad scrolls and pinches, ⌘-scroll, and the app's own glide and spring back. It is the one
/// place that says whether a gesture is running; everything else asks `isResting`. Time is passed in (seconds, any clock
/// that only goes forward), so it runs the same in tests.
struct Motion {
  enum Phase: Equatable {
    case resting
    /// Moved by input; at rest once no input came for `restDelay` and nothing else moves it
    case input
    case glide(Glide)
    case spring(Spring)
  }

  struct Glide: Equatable {
    /// View points per second
    var v0: CGVector
    var start: TimeInterval
    var done = CGVector.zero
  }

  /// Back inside the zoom limits after a pinch that went past them
  struct Spring: Equatable {
    var target: CGFloat
    var anchor: CGPoint
    /// When it last moved the zoom
    var at: TimeInterval
  }

  static let restDelay: TimeInterval = 0.15
  /// Finger speed (view pt/s) up to which movement is 1:1; above it, compressed towards 1.6 times this
  static let knee: CGFloat = 2500
  static let glideTau: TimeInterval = 0.24
  static let glideStop: CGFloat = 15
  /// Matches the prototype's spring (a quarter of the way per frame at 120 Hz), but per second, not per frame
  static let springTau: TimeInterval = 0.03

  private(set) var phase = Phase.resting
  private var lastInput: TimeInterval = -.infinity
  private var lastScroll: TimeInterval?
  private var lastMove: TimeInterval = -.infinity
  /// Of the shaped movement, view pt/s, averaged over about 40 ms
  private var velocity = CGVector.zero
  /// The zoom the fingers ask for, before the rubber band
  private var pinchRaw: CGFloat?

  var isResting: Bool { phase == .resting }

  /// A scroll event that pans (trackpad or mouse wheel). `began`: fingers touched (stops a glide at once); `ended`: they
  /// lifted (starts the glide)
  mutating func scroll(_ d: CGVector, at t: TimeInterval, began: Bool, ended: Bool, camera: inout Camera) {
    if began {
      velocity = .zero
      lastScroll = t
    }
    let dt = max(t - (lastScroll ?? t - 1.0 / 120), 1.0 / 240)
    lastScroll = t
    phase = .input
    lastInput = t
    if d.dx != 0 || d.dy != 0 {
      let s = Motion.shaped(d, dt: dt)
      let a = 1 - exp(-dt / 0.04)
      velocity.dx += (s.dx / dt - velocity.dx) * a
      velocity.dy += (s.dy / dt - velocity.dy) * a
      camera.pan(s)
      lastMove = t
    }
    if ended {
      // fingers that stopped before lifting don't glide
      if t - lastMove > 0.05 { velocity = .zero }
      if hypot(velocity.dx, velocity.dy) > 50 { phase = .glide(Glide(v0: velocity, start: t)) }
      velocity = .zero
      lastScroll = nil
    }
  }

  /// A pinch step: the zoom is multiplied by `factor` around `p`, with the rubber band past the limits; when the fingers
  /// lift past a limit the zoom springs back
  mutating func pinch(
    by factor: CGFloat, at p: CGPoint, time t: TimeInterval, began: Bool, ended: Bool, limits: ZoomLimits,
    camera: inout Camera
  ) {
    if began || pinchRaw == nil { pinchRaw = camera.zoom }
    let raw = (pinchRaw ?? camera.zoom) * factor
    pinchRaw = raw
    camera.zoom(to: limits.rubber(raw), at: p)
    phase = .input
    lastInput = t
    if ended {
      pinchRaw = nil
      let target = limits.clamp(camera.zoom)
      if abs(target - camera.zoom) > 1e-6 { phase = .spring(Spring(target: target, anchor: p, at: t)) }
    }
  }

  /// ⌘-scroll: zooms within the limits, no rubber band
  mutating func wheelZoom(
    by factor: CGFloat, at p: CGPoint, time t: TimeInterval, limits: ZoomLimits, camera: inout Camera
  ) {
    camera.zoom(to: limits.clamp(camera.zoom * factor), at: p)
    phase = .input
    lastInput = t
  }

  /// A frame: plays the glide or spring. Returns true on the frame the motion comes to rest
  mutating func step(at t: TimeInterval, camera: inout Camera) -> Bool {
    switch phase {
    case .resting:
      return false
    case .glide(var g):
      let age = t - g.start
      let f = Motion.glideTau * (1 - exp(-age / Motion.glideTau))
      let total = CGVector(dx: g.v0.dx * f, dy: g.v0.dy * f)
      camera.pan(CGVector(dx: total.dx - g.done.dx, dy: total.dy - g.done.dy))
      g.done = total
      phase = hypot(g.v0.dx, g.v0.dy) * exp(-age / Motion.glideTau) < Motion.glideStop ? .input : .glide(g)
    case .spring(var s):
      let z = camera.zoom
      let k = exp(-(t - s.at) / Motion.springTau)
      let next = abs(log(z / s.target)) < 1e-3 ? s.target : s.target * pow(z / s.target, k)
      camera.zoom(to: next, at: s.anchor)
      s.at = t
      phase = next == s.target ? .input : .spring(s)
    case .input:
      break
    }
    guard phase == .input, t - lastInput >= Motion.restDelay else { return false }
    phase = .resting
    return true
  }

  /// 1:1 up to the knee, then compressed softly (tanh), with no buffering and so no added latency
  static func shaped(_ d: CGVector, dt: TimeInterval) -> CGVector {
    let v = hypot(d.dx, d.dy) / dt
    guard v > knee else { return d }
    let soft = knee * 0.6
    let k = (knee + soft * tanh((v - knee) / soft)) / v
    return CGVector(dx: d.dx * k, dy: d.dy * k)
  }
}

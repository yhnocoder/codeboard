import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardCanvas

/// The accepted prototype's motion (explore/macos-canvas on proto/canvas, Canvas.swift: pan, startGlide, playGlide,
/// zoom, rubber, playSpring), transcribed with the view y-down, against which `Motion` must give the same camera
private struct PrototypeMotion {
  var camX: CGFloat = 0
  var camY: CGFloat = 0
  var z: CGFloat = 1
  var lastScrollTs = 0.0
  var fingerVel = CGPoint.zero
  var glide: (v0: CGPoint, start: Double, done: CGPoint)?
  var lastMoveTs = 0.0
  var pinchRaw: CGFloat = 0
  var spring: CGFloat?
  var springAnchor = CGPoint.zero
  let knee: CGFloat = 2500
  let tau = 0.24
  let top: CGFloat = 2
  let bottom: CGFloat

  init(fit: CGFloat) { bottom = fit * 0.5 }

  var camera: Camera { Camera(origin: CGPoint(x: camX, y: camY), zoom: z) }

  mutating func scroll(_ sx: CGFloat, _ sy: CGFloat, ts: Double, began: Bool, ended: Bool) {
    if began {
      glide = nil
      fingerVel = .zero
      lastScrollTs = ts
    }
    let dt = lastScrollTs > 0 ? ts - lastScrollTs : 1.0 / 120
    lastScrollTs = ts
    if sx != 0 || sy != 0 {
      lastMoveTs = ts
      pan(-sx, -sy, dt: dt)
    }
    if ended {
      if ts - lastMoveTs > 0.05 { fingerVel = .zero }
      let v = fingerVel
      fingerVel = .zero
      if hypot(v.x, v.y) > 50 { glide = (v, ts, .zero) }
    }
  }

  mutating func pan(_ dx: CGFloat, _ dy: CGFloat, dt: Double) {
    var dx = dx
    var dy = dy
    let dt = max(dt, 1.0 / 240)
    let v = hypot(dx, dy) / CGFloat(dt)
    let soft = knee * 0.6
    if v > knee {
      let out = knee + soft * tanh((v - knee) / soft)
      dx *= out / v
      dy *= out / v
    }
    let a = CGFloat(1 - exp(-dt / 0.04))
    fingerVel = CGPoint(
      x: fingerVel.x + (dx / CGFloat(dt) - fingerVel.x) * a, y: fingerVel.y + (dy / CGFloat(dt) - fingerVel.y) * a)
    camX += dx / z
    camY += dy / z
  }

  /// Returns whether the glide ended on this frame
  mutating func playGlide(_ now: Double) -> Bool {
    guard let g = glide else { return false }
    let t = now - g.start
    let f = CGFloat(tau * (1 - exp(-t / tau)))
    let total = CGPoint(x: g.v0.x * f, y: g.v0.y * f)
    camX += (total.x - g.done.x) / z
    camY += (total.y - g.done.y) / z
    glide?.done = total
    if hypot(g.v0.x, g.v0.y) * CGFloat(exp(-t / tau)) < 15 {
      glide = nil
      return true
    }
    return false
  }

  func rubber(_ raw: CGFloat) -> CGFloat {
    if raw > top { return top * (1 + 0.15 * tanh(log(raw / top) / 0.15 / 2)) }
    if raw < bottom { return bottom / (1 + 0.15 * tanh(log(bottom / raw) / 0.15 / 2)) }
    return raw
  }

  mutating func pinch(_ m: CGFloat, at p: CGPoint, began: Bool, ended: Bool) {
    if began { pinchRaw = z }
    if pinchRaw == 0 { pinchRaw = z }
    pinchRaw *= 1 + m
    zoom(to: rubber(pinchRaw), at: p)
    springAnchor = p
    if ended {
      let clamped = min(max(z, bottom), top)
      if abs(clamped - z) > 1e-4 { spring = clamped }
      pinchRaw = 0
    }
  }

  mutating func zoom(to nz: CGFloat, at p: CGPoint) {
    let b = CGPoint(x: camX + p.x / z, y: camY + p.y / z)
    z = nz
    camX = b.x - p.x / z
    camY = b.y - p.y / z
  }

  mutating func playSpring() {
    guard let target = spring else { return }
    zoom(to: abs(target - z) < 0.002 ? target : z + (target - z) * 0.25, at: springAnchor)
    if z == target { spring = nil }
  }
}

@Suite struct PrototypeMotionTests {
  /// Trackpad events at uneven intervals (4–12 ms, as AppKit delivers them), slow and past the knee, then a lift; the
  /// glide played at 120 Hz. Camera after every event and every frame
  @Test func panAndGlideFollowThePrototype() {
    for (speed, seed) in [(400.0, 1), (1800.0, 2), (2600.0, 3), (5200.0, 4), (9000.0, 5)] {
      var rng = SplitMix(seed: UInt64(seed))
      var p = PrototypeMotion(fit: 0.5)
      var m = Motion()
      var c = Camera(origin: .zero, zoom: 0.8)
      p.z = 0.8
      var t = 100.0
      p.scroll(0, 0, ts: t, began: true, ended: false)
      m.scroll(.zero, at: t, began: true, ended: false, camera: &c)
      for i in 0..<30 {
        let dt = 0.004 + 0.008 * rng.unit()
        t += dt
        // a ramp up, as fingers accelerate
        let v = speed * min(1, Double(i + 1) / 8)
        let d = CGVector(dx: -v * dt * 0.8, dy: v * dt * 0.6)
        p.scroll(d.dx, d.dy, ts: t, began: false, ended: false)
        m.scroll(d, at: t, began: false, ended: false, camera: &c)
        #expect(close(c, p.camera), "speed \(speed) event \(i)")
      }
      t += 0.003
      p.scroll(0, 0, ts: t, began: false, ended: true)
      m.scroll(.zero, at: t, began: false, ended: true, camera: &c)
      var frame = t
      var frames = 0
      while frames < 400 {
        frame += 1.0 / 120
        frames += 1
        let ended = p.playGlide(frame)
        _ = m.step(at: frame, camera: &c)
        #expect(close(c, p.camera), "speed \(speed) glide frame \(frames)")
        let gliding = if case .glide = m.phase { true } else { false }
        #expect(gliding == !ended, "speed \(speed) glide frame \(frames)")
        if ended { break }
      }
      #expect(frames < 400)
    }
  }

  /// A pinch past the top, as AppKit's magnification steps; the spring back is per second here, per frame there, so
  /// only its end and length are compared
  @Test func pinchAndSpringFollowThePrototype() {
    var p = PrototypeMotion(fit: 0.5)
    var m = Motion()
    var c = Camera(origin: CGPoint(x: 300, y: 200), zoom: 0.6)
    p.camX = 300
    p.camY = 200
    p.z = 0.6
    let limits = ZoomLimits(fit: 0.5)
    let at = CGPoint(x: 512, y: 380)
    var t = 5.0
    for i in 0..<60 {
      let mag: CGFloat = i == 0 ? 0 : 0.035
      p.pinch(mag, at: at, began: i == 0, ended: i == 59)
      m.pinch(by: 1 + mag, at: at, time: t, began: i == 0, ended: i == 59, limits: limits, camera: &c)
      #expect(close(c, p.camera), "pinch step \(i)")
      t += 1.0 / 120
    }
    #expect(c.zoom > 2)
    var a = 0
    var b = 0
    while p.spring != nil && a < 200 {
      p.playSpring()
      a += 1
    }
    while case .spring = m.phase, b < 200 {
      t += 1.0 / 120
      _ = m.step(at: t, camera: &c)
      b += 1
    }
    #expect(close(c, p.camera))
    #expect(abs(a - b) <= 2)
  }

  private func close(_ a: Camera, _ b: Camera) -> Bool {
    abs(a.zoom - b.zoom) < 1e-9 && abs(a.origin.x - b.origin.x) < 1e-6 && abs(a.origin.y - b.origin.y) < 1e-6
  }
}

/// Repeatable jitter for the event intervals
private struct SplitMix {
  var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func unit() -> Double {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return Double((z ^ (z >> 31)) >> 11) / Double(1 << 53)
  }
}

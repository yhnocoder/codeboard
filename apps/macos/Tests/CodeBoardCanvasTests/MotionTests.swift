import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardCanvas

@Suite struct CameraTests {
  @Test func zoomKeepsThePointUnderThePointer() {
    var c = Camera(origin: CGPoint(x: 100, y: 50), zoom: 0.5)
    let p = CGPoint(x: 300, y: 200)
    let before = c.board(p)
    c.zoom(to: 1.7, at: p)
    #expect(abs(c.board(p).x - before.x) < 1e-9 && abs(c.board(p).y - before.y) < 1e-9)
  }

  @Test func panMovesTheBoardWithTheFingers() {
    var c = Camera(origin: .zero, zoom: 2)
    c.pan(CGVector(dx: 40, dy: -20))
    #expect(c.origin == CGPoint(x: -20, y: 10))
  }

  @Test func fitCentresTheBoardAndNeverZoomsIn() {
    let c = Camera.fit(CGRect(x: 0, y: 0, width: 4000, height: 2000), in: CGSize(width: 1000, height: 1000))
    #expect(abs(c.zoom - 1000.0 / 4080) < 1e-9)
    #expect(abs(c.visible(CGSize(width: 1000, height: 1000)).midX - 2000) < 1e-9)
    #expect(Camera.fit(CGRect(x: 0, y: 0, width: 100, height: 100), in: CGSize(width: 1000, height: 1000)).zoom == 1)
  }

  @Test func limitsReachTenPercentAndHalfTheFit() {
    #expect(ZoomLimits(fit: 0.08).min == 0.04)
    #expect(ZoomLimits(fit: 1).min == 0.1)
    #expect(ZoomLimits(fit: 1).max == 2)
  }

  @Test func rubberBandStretchesAtMostFifteenPercent() {
    let l = ZoomLimits(fit: 1)
    #expect(l.rubber(1.5) == 1.5)
    #expect(l.rubber(2.4) > 2 && l.rubber(2.4) < l.rubber(4))
    #expect(l.rubber(100) < 2.3 + 1e-9)
    #expect(l.rubber(0.05) < 0.1 && l.rubber(0.05) > 0.1 / 1.15)
  }
}

@Suite struct MotionTests {
  let limits = ZoomLimits(fit: 0.5)

  @Test func speedIsOneToOneUpToTheKneeThenCompressed() {
    let dt = 1.0 / 120
    let slow = CGVector(dx: 2000 * dt, dy: 0)
    #expect(Motion.shaped(slow, dt: dt) == slow)
    let fast = Motion.shaped(CGVector(dx: 0, dy: 6000 * dt), dt: dt)
    #expect(fast.dy / dt > 2500 && fast.dy / dt < 4000)
    #expect(Motion.shaped(CGVector(dx: 0, dy: 1e6 * dt), dt: dt).dy / dt <= 4000)
  }

  /// Fingers at `speed` pt/s for 0.15 s at 120 Hz from t = 0, then lift
  func flick(_ m: inout Motion, _ c: inout Camera, speed: CGFloat) -> TimeInterval {
    var t = 0.0
    m.scroll(.zero, at: t, began: true, ended: false, camera: &c)
    while t < 0.15 {
      t += 1.0 / 120
      m.scroll(CGVector(dx: speed / 120, dy: 0), at: t, began: false, ended: false, camera: &c)
    }
    m.scroll(.zero, at: t + 0.001, began: false, ended: true, camera: &c)
    return t + 0.001
  }

  @Test func liftGlidesAboutVTauAndStopsBelowFifteenPointsPerSecond() {
    var m = Motion()
    var c = Camera(origin: .zero, zoom: 1)
    var t = flick(&m, &c, speed: 1000)
    guard case .glide(let g) = m.phase else {
      Issue.record("no glide")
      return
    }
    let start = c.origin.x
    while case .glide = m.phase {
      t += 1.0 / 120
      _ = m.step(at: t, camera: &c)
    }
    let travelled = start - c.origin.x
    #expect(abs(travelled - g.v0.dx * 0.24) < g.v0.dx * 0.24 * 0.02)
    // it stopped where the speed fell below 15 pt/s
    #expect(abs(g.v0.dx * exp(-(t - g.start) / 0.24) - 15) < 2)
  }

  @Test func aNewTouchStopsTheGlideAtOnce() {
    var m = Motion()
    var c = Camera(origin: .zero, zoom: 1)
    let t = flick(&m, &c, speed: 1500)
    _ = m.step(at: t + 0.05, camera: &c)
    let x = c.origin.x
    m.scroll(.zero, at: t + 0.06, began: true, ended: false, camera: &c)
    _ = m.step(at: t + 0.07, camera: &c)
    #expect(m.phase == .input)
    #expect(c.origin.x == x)
  }

  @Test func fingersThatStoppedBeforeLiftingDoNotGlide() {
    var m = Motion()
    var c = Camera(origin: .zero, zoom: 1)
    m.scroll(CGVector(dx: 20, dy: 0), at: 0, began: true, ended: false, camera: &c)
    m.scroll(CGVector(dx: 20, dy: 0), at: 0.01, began: false, ended: false, camera: &c)
    m.scroll(.zero, at: 0.2, began: false, ended: true, camera: &c)
    #expect(m.phase == .input)
  }

  @Test func restComesOneHundredFiftyMillisecondsAfterTheLastInput() {
    var m = Motion()
    var c = Camera(origin: .zero, zoom: 1)
    m.scroll(CGVector(dx: 1, dy: 0), at: 10, began: true, ended: false, camera: &c)
    #expect(!m.isResting)
    #expect(!m.step(at: 10.149, camera: &c))
    #expect(m.step(at: 10.15, camera: &c))
    #expect(m.isResting)
    #expect(!m.step(at: 10.2, camera: &c))
  }

  @Test func pinchPastTheLimitRubberBandsAndSpringsBack() {
    var m = Motion()
    var c = Camera(origin: .zero, zoom: 1.8)
    let p = CGPoint(x: 400, y: 300)
    let anchor = c.board(p)
    m.pinch(by: 1, at: p, time: 0, began: true, ended: false, limits: limits, camera: &c)
    m.pinch(by: 1.6, at: p, time: 0.1, began: false, ended: false, limits: limits, camera: &c)
    #expect(c.zoom > 2 && c.zoom < 2.3)
    m.pinch(by: 1, at: p, time: 0.2, began: false, ended: true, limits: limits, camera: &c)
    guard case .spring = m.phase else {
      Issue.record("no spring")
      return
    }
    var t = 0.2
    while !m.isResting && t < 2 {
      t += 1.0 / 120
      _ = m.step(at: t, camera: &c)
    }
    #expect(c.zoom == 2)
    #expect(abs(c.board(p).x - anchor.x) < 1e-6)
    #expect(t < 0.6)
  }

  @Test func commandScrollZoomsWithinTheLimits() {
    var m = Motion()
    var c = Camera(origin: .zero, zoom: 1.9)
    m.wheelZoom(by: 3, at: .zero, time: 0, limits: limits, camera: &c)
    #expect(c.zoom == 2)
    m.wheelZoom(by: 1e-4, at: .zero, time: 0, limits: limits, camera: &c)
    #expect(c.zoom == limits.min)
  }
}

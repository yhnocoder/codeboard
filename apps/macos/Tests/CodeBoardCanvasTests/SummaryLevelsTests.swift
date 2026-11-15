import CodeBoardModel
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardCanvas

// The switch between cards and Section summaries on its own, frame by frame (120 Hz, time passed in): where a gesture
// stops, how the push thins the level being left and drains, the cross-fade's timing, 连续's hysteresis, a zoom the app
// makes, and a board opened at its level

@Suite struct SummaryLevelsTests {
  static let frame = 1.0 / 120

  func levels(_ mode: SummarySwitch = .inPlace) -> SummaryLevels {
    var l = SummaryLevels()
    l.mode = mode
    l.cut = 0.3
    l.show(zoom: 1)
    return l
  }

  /// Steps adding up to `total` of |ln| from `z` towards (sign < 0: out) the summaries, one per frame from `t`; the zoom
  /// each step got
  func pinch(_ l: inout SummaryLevels, from z: CGFloat, by total: CGFloat, steps: Int = 6, t: inout TimeInterval)
    -> [CGFloat]
  {
    var got: [CGFloat] = []
    var at = z
    for _ in 0..<steps {
      let to = at * exp(total / CGFloat(steps))
      at = l.step(from: at, to: to, wheelNotch: false, at: t)
      got.append(at)
      _ = l.frame(at: t)
      t += Self.frame
    }
    return got
  }

  @Test func aGestureStopsAtTheCutAndPushesFromThere() {
    var l = levels()
    #expect(l.step(from: 0.4, to: 0.32, wheelNotch: false, at: 10) == 0.32)
    #expect(l.step(from: 0.32, to: 0.31, wheelNotch: false, at: 10) == 0.31)
    #expect(l.step(from: 0.31, to: 0.29, wheelNotch: false, at: 10) == 0.3, "held at the cut")
    #expect(abs(l.push - abs(log(0.29 / 0.31)) / 0.6) < 1e-9, "the whole step counts, as main's")
    #expect(l.step(from: 0.3, to: 0.29, wheelNotch: false, at: 10) == 0.3)
    #expect(l.level == .cards)
  }

  @Test func thePushThinsTheCardsLinearlyAndDrainsWhenLetGo() {
    var l = levels()
    var t = 10.0
    _ = pinch(&l, from: 0.3, by: -0.3, t: &t)
    #expect(abs(l.push - 0.5) < 1e-9)
    let o = l.frame(at: t)
    #expect(abs(o.cards - 0.65) < 1e-6 && o.summaries == 0)
    // let go: held for 80 ms, then 1.2 pushes a second
    let let0 = t - Self.frame
    while t < let0 + 0.079 {
      #expect(abs(l.frame(at: t).cards - 0.65) < 1e-6)
      t += Self.frame
    }
    while l.push > 0, t < let0 + 1 {
      _ = l.frame(at: t)
      t += Self.frame
    }
    #expect(abs(t - (let0 + 0.08 + 0.5 / 1.2)) < 0.02, "\(t - let0)")
    #expect(l.frame(at: t).cards == 1 && !l.isAnimating && l.level == .cards)
  }

  @Test func aStepBackDropsThePushAtOnce() {
    var l = levels()
    var t = 10.0
    _ = pinch(&l, from: 0.3, by: -0.3, t: &t)
    #expect(l.step(from: 0.3, to: 0.31, wheelNotch: false, at: t) == 0.31)
    #expect(l.push == 0 && l.frame(at: t + Self.frame).cards == 1)
  }

  @Test func pushedThroughTheLayersCrossFadeWithTheCameraStill() {
    var l = levels()
    var t = 10.0
    let got = pinch(&l, from: 0.3, by: -0.6, steps: 6, t: &t)
    #expect(got.allSatisfy { $0 == 0.3 }, "no jump")
    #expect(l.level == .summaries && l.fade != nil)
    // the fade starts on the frame after the step that went through
    let start = t - Self.frame
    func at(_ ms: Double) -> (cards: CGFloat, summaries: CGFloat) {
      var m = l
      _ = m.frame(at: start)
      return m.frame(at: start + ms / 1000)
    }
    #expect(abs(at(0).cards - 0.3) < 1e-6 && at(0).summaries == 0)
    #expect(at(130).cards < 0.03 && at(130).summaries < 0.06)
    #expect(at(156).cards < 1e-6)
    #expect(at(260).summaries == 1)
    // held while fading
    #expect(l.step(from: 0.3, to: 0.25, wheelNotch: false, at: start + 0.1) == 0.3)
    #expect(l.step(from: 0.3, to: 0.35, wheelNotch: false, at: start + 0.1) == 0.3)
    while l.fade != nil {
      _ = l.frame(at: t)
      t += Self.frame
    }
    #expect(t - start < 0.28 && l.frame(at: t) == (0, 1))
  }

  @Test func oneMouseWheelNotchGoesThroughAndAPreciseWheelAddsUp() {
    var l = levels()
    #expect(l.step(from: 0.35, to: 0.317, wheelNotch: true, at: 10) == 0.317, "above the cut: untouched")
    #expect(l.step(from: 0.31, to: 0.31 * exp(-0.1), wheelNotch: true, at: 10) == 0.3)
    #expect(l.level == .summaries)
    var p = levels()
    _ = p.step(from: 0.31, to: 0.31 * exp(-0.1), wheelNotch: false, at: 10)
    #expect(abs(p.push - 0.1 / 0.6) < 1e-9 && p.level == .cards)
    var q = levels()
    var z: CGFloat = 0.3
    for i in 0..<10 {
      z = q.step(from: z, to: z * exp(-0.06), wheelNotch: false, at: 10 + Double(i) * 0.01)
      #expect(q.level == (i < 9 ? .cards : .summaries), "\(i)")
    }
  }

  @Test func backToCardsThinsTheSummariesThenCrossFades() {
    var l = levels()
    l.show(zoom: 0.2)
    var t = 10.0
    #expect(l.step(from: 0.2, to: 0.25, wheelNotch: false, at: t) == 0.25, "away from the cut: free")
    _ = pinch(&l, from: 0.3, by: 0.3, t: &t)
    let o = l.frame(at: t)
    #expect(o.cards == 0 && abs(o.summaries - 0.65) < 1e-6)
    _ = pinch(&l, from: 0.3, by: 0.3, t: &t)
    #expect(l.level == .cards)
    let start = t - Self.frame
    var m = l
    _ = m.frame(at: start)
    var n = m
    #expect(m.frame(at: start + 0.156).summaries < 1e-6)
    #expect(n.frame(at: start + 0.26).cards == 1)
  }

  @Test func continuousCrossesOnceAndComesBackOnlyPastHysteresis() {
    var l = levels(.continuous)
    var t = 10.0
    #expect(l.step(from: 0.32, to: 0.29, wheelNotch: false, at: t) == 0.29, "no stop")
    #expect(l.level == .summaries)
    #expect(l.step(from: 0.29, to: 0.33, wheelNotch: false, at: t) == 0.33)
    #expect(l.level == .summaries, "1.1 times: still summaries")
    #expect(l.step(from: 0.33, to: 0.337, wheelNotch: false, at: t) == 0.337)
    #expect(l.level == .cards)
    // to and fro near the point for two seconds: one fade, no flapping
    var m = levels(.continuous)
    var fades = 0
    var z: CGFloat = 0.32
    var was = m.level
    for i in 0..<240 {
      let to: CGFloat = i % 2 == 0 ? 0.29 : 0.33
      z = m.step(from: z, to: to, wheelNotch: false, at: t)
      if m.level != was { fades += 1 }
      was = m.level
      _ = m.frame(at: t)
      t += Self.frame
    }
    #expect(fades == 1 && m.level == .summaries)
  }

  @Test func aFadeTurnedAroundMidwayDoesNotJump() {
    var l = levels(.continuous)
    var t = 10.0
    _ = l.step(from: 0.32, to: 0.29, wheelNotch: false, at: t)
    var prev = l.frame(at: t)
    var biggest: CGFloat = 0
    for i in 1..<60 {
      t += Self.frame
      if i == 12 { _ = l.step(from: 0.29, to: 0.34, wheelNotch: false, at: t) }
      let o = l.frame(at: t)
      biggest = max(biggest, abs(o.cards - prev.cards), abs(o.summaries - prev.summaries))
      prev = o
    }
    #expect(l.level == .cards && prev == (1, 0))
    // no frame changes more than the fade itself does at its steepest (3 / 156 ms over 8.3 ms ≈ 0.16)
    #expect(biggest < 0.17, "\(biggest)")
  }

  @Test func aZoomTheAppMakesCrossFadesAtOnceAndFastTowardsTheCards() {
    var l = levels()
    l.moved(from: 0.35, to: 0.25)
    #expect(l.level == .summaries && l.fade?.fast == false && l.push == 0)
    var t = 10.0
    while l.fade != nil {
      _ = l.frame(at: t)
      t += Self.frame
    }
    l.moved(from: 0.25, to: 1)
    let start = t
    _ = l.frame(at: start)
    var a = l
    #expect(a.frame(at: start + 0.07).summaries < 0.05)
    var b = l
    #expect(b.frame(at: start + 0.078).summaries < 1e-6)
    var c = l
    #expect(c.frame(at: start + 0.26).cards == 1)
  }

  @Test func aBoardOpensAtItsLevelWithNoFade() {
    var l = levels()
    l.show(zoom: 0.2)
    #expect(l.frame(at: 10) == (0, 1) && !l.isAnimating)
    var none = SummaryLevels()
    none.show(zoom: 0.01)
    #expect(none.level == .cards, "no cut: no summaries")
  }
}

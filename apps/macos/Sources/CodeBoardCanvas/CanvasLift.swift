import AppKit
import CodeBoardModel

// A card picked up by the pointer (styles.css .card.lift, themes.css): it grows a little, about a point 18 below its
// top left corner (its centre when tilted), and a deeper shadow comes under it; let go, it settles back (.landing). In
// Warm Ink it grows to 1.01 on a spring that overshoots a little (260 ms) and lands with a bounce (420 ms); elsewhere
// to 1.008 on --lift-in (200 ms), landing on --lift-out (240 ms). Only scale and the shadow change, on the card's own
// layer, so what is part of the card (its selected look) goes with it. A move by the keys lifts nothing.

extension CanvasView {
  /// How much a picked-up card grows
  var liftScale: CGFloat { theme.id == .warmInk ? 1.01 : 1.008 }

  /// The springs as main writes them (linear() stops): Warm Ink's up and down, else none
  static let springUp: [CGFloat] = [0, 0.16, 0.45, 0.72, 0.9, 1.01, 1.05, 1.05, 1.04, 1.02, 1]
  static let springDown: [CGFloat] = [0, 0.19, 0.59, 0.98, 1.22, 1.28, 1.22, 1.11, 1, 0.94, 0.92, 0.94, 0.97, 1, 1]

  /// The card's transform grown by `k` about where main grows it, turned by its tilt
  static func grown(_ box: CALayer, tilt: CGFloat, k: CGFloat) -> CATransform3D {
    let q = tilt == 0 ? CGPoint(x: -box.bounds.width / 2, y: 18 - box.bounds.height / 2) : .zero
    var t = CATransform3DMakeRotation(tilt, 0, 0, 1)
    t = CATransform3DTranslate(t, q.x, q.y, 0)
    t = CATransform3DScale(t, k, k, 1)
    return CATransform3DTranslate(t, -q.x, -q.y, 0)
  }

  /// The shadows under a picked-up card (--sh-lift; Ink Wash's own): (y, blur, spread, colour)
  var liftShadows: [(CGFloat, CGFloat, CGFloat, CGColor)] {
    if theme.id == .inkWash {
      return [
        (
          26, 38, -24,
          CGColor(
            srgbRed: theme.dark ? 0 : 30 / 255, green: theme.dark ? 0 : 25 / 255, blue: theme.dark ? 0 : 15 / 255,
            alpha: theme.dark ? 0.85 : 0.4)
        )
      ]
    }
    let dark = theme.dark
    let c = { (a: CGFloat) in
      dark ? CGColor(gray: 0, alpha: a) : CGColor(srgbRed: 50 / 255, green: 35 / 255, blue: 10 / 255, alpha: a)
    }
    return [(4, 10, -2, c(theme.dark ? 0.4 : 0.1)), (30, 60, -18, c(theme.dark ? 0.75 : 0.3))]
  }

  /// The moved cards picked up, the first time a pointer drag moves them
  func lift(_ m: Move) {
    guard case .move? = gesture?.kind, let s = scene else { return }
    for i in m.items {
      guard case .card(let id)? = s.items[i].owner, !lifted.contains(id) else { continue }
      lifted.insert(id)
      landings[id] = nil
      let box = items[i].box
      let tilt = s.items[i].tilt
      let k = liftScale
      let warm = theme.id == .warmInk
      // the grow animation only, no implicit one of the transform with it
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      defer { CATransaction.commit() }
      box.add(
        Self.grow(box, tilt: tilt, from: 1, to: k, stops: warm ? Self.springUp : nil, duration: warm ? 0.26 : 0.2),
        forKey: "lift")
      box.transform = Self.grown(box, tilt: tilt, k: k)
      if s.items[i].drawing.framed, !isText(id) {
        for (n, (y, blur, spread, color)) in liftShadows.enumerated() {
          let l = CALayer()
          l.name = "lift"
          l.frame = box.bounds
          l.shadowPath = Drawing.squircle(box.bounds.insetBy(dx: -spread, dy: -spread), theme.cardRadius + spread)
          l.shadowColor = color
          l.shadowOpacity = 1
          l.shadowRadius = blur / 2
          l.shadowOffset = CGSize(width: 0, height: y)
          l.zPosition = -1
          let a = CABasicAnimation(keyPath: "opacity")
          a.fromValue = 0
          a.toValue = 1
          a.duration = 0.2
          a.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
          l.add(a, forKey: "in")
          box.insertSublayer(l, at: UInt32(n))
        }
      }
    }
  }

  /// The picked-up cards let go: they settle back where they are now, and keep settling in the layers the board is
  /// drawn in again with (`relanding`)
  func land() {
    guard !lifted.isEmpty, let s = scene else { return }
    let now = CACurrentMediaTime()
    for id in lifted {
      guard let i = index(of: .card(id)) else { continue }
      landings[id] = now
      settle(items[i].box, tilt: s.items[i].tilt, since: now)
    }
    lifted = []
  }

  /// A card's layer drawn anew while it lands: it goes on landing, from where it is in that
  func relanding() {
    guard let s = scene else { return }
    let now = CACurrentMediaTime()
    for (id, at) in landings {
      guard now - at < 0.42 else {
        landings[id] = nil
        continue
      }
      guard let i = index(of: .card(id)) else { continue }
      settle(items[i].box, tilt: s.items[i].tilt, since: at)
    }
  }

  /// Back to its size and its shadow out, from `since`; over the others until it has landed
  private func settle(_ box: CALayer, tilt: CGFloat, since: CFTimeInterval) {
    let warm = theme.id == .warmInk
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    CATransaction.setCompletionBlock {
      MainActor.assumeIsolated {
        if box.animation(forKey: "lift") == nil { box.zPosition = 0 }
        for l in box.sublayers ?? [] where l.name == "lift" && l.opacity == 0 { l.removeFromSuperlayer() }
      }
    }
    let a = Self.grow(
      box, tilt: tilt, from: liftScale, to: 1, stops: warm ? Self.springDown : nil, duration: warm ? 0.42 : 0.24)
    a.beginTime = box.convertTime(since, from: nil)
    a.fillMode = .backwards
    box.add(a, forKey: "lift")
    box.transform = Self.grown(box, tilt: tilt, k: 1)
    box.zPosition = 1
    for l in box.sublayers ?? [] where l.name == "lift" {
      let o = CABasicAnimation(keyPath: "opacity")
      o.fromValue = 1
      o.toValue = 0
      o.duration = 0.24
      o.beginTime = l.convertTime(since, from: nil)
      o.fillMode = .backwards
      o.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0.6, 0.3, 1)
      l.opacity = 0
      l.add(o, forKey: "out")
    }
    CATransaction.commit()
  }

  /// `from` → `to` on the card's grow transform: through `stops` (a spring, as linear()) or on --lift-in / --lift-out
  static func grow(
    _ box: CALayer, tilt: CGFloat, from: CGFloat, to: CGFloat, stops: [CGFloat]?, duration: CFTimeInterval
  ) -> CAAnimation {
    let a = CAKeyframeAnimation(keyPath: "transform")
    let ps = stops ?? [0, 1]
    a.values = ps.map { NSValue(caTransform3D: grown(box, tilt: tilt, k: from + (to - from) * $0)) }
    a.keyTimes = ps.indices.map { NSNumber(value: Double($0) / Double(ps.count - 1)) }
    a.duration = duration
    if stops == nil {
      a.timingFunction =
        to > from
        ? CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
        : CAMediaTimingFunction(controlPoints: 0.3, 0.6, 0.3, 1)
    }
    return a
  }
}

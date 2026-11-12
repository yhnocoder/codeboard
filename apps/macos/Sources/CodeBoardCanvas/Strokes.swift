import CoreGraphics
import Foundation

// The board's drawn strokes, ported from the web board so a card, arrow or Section looks the same in both: arrows as filled
// outlines (packages/core/src/canvas taper.ts, Warm Ink; brush.ts, Ink Wash), Ink Wash's torn rice paper
// (packages/board/src/state/ink.ts paperSheet) and its brush-stroke Section frames (state/inkframe.ts). Every random choice
// comes from the same seeded generators as the web's, so a card, arrow or Section looks the same at every zoom, after every
// redraw and in both apps. Board units, y-down.

/// The web board's seeded numbers, bit for bit
enum Seeded {
  /// FNV-1a of a string's UTF-16 units (core brush.ts fnv)
  static func fnv(_ s: String) -> UInt32 {
    var h: UInt32 = 2_166_136_261
    for u in s.utf16 { h = (h ^ UInt32(u)) &* 16_777_619 }
    return h
  }

  /// mulberry32 as state/ink.ts rng writes it: numbers in [0, 1). The seed is multiplied as a JS number (a double), so the
  /// product is rounded the way JavaScript rounds it before it is cut to 32 bits
  static func rng(_ seed: Int) -> () -> Double {
    var a = UInt32(truncatingIfNeeded: Int64((Double(seed) * 2_654_435_761).rounded(.towardZero)))
    return {
      a = a &+ 0x6d2b_79f5
      var t = (a ^ (a >> 15)) &* (1 | a)
      t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
      return Double(t ^ (t >> 14)) / 4_294_967_296
    }
  }

  /// state/inkframe.ts hash: noise in [0, 1) for sample i of stroke k
  static func hash(_ k: Int, _ i: Int) -> Double {
    var t = (UInt32(truncatingIfNeeded: k) ^ (UInt32(truncatingIfNeeded: i + 1) &* 0x9e37_79b1)) &* 0x85eb_ca6b
    t ^= t >> 13
    t = t &* 0xc2b2_ae35
    t ^= t >> 16
    return Double(t) / 4_294_967_296
  }
}

enum Strokes {
  // MARK: Routes as polylines

  /// A route as points (brush.ts flatten): curves stepped by their control polygon's length, repeated points dropped
  static func flatten(_ ops: [PathOp]) -> [CGPoint] {
    var out: [CGPoint] = []
    func push(_ p: CGPoint) {
      if let l = out.last, abs(l.x - p.x) <= 1e-6, abs(l.y - p.y) <= 1e-6 { return }
      out.append(p)
    }
    var at = CGPoint.zero
    for op in ops {
      switch op {
      case .move(let p), .line(let p):
        push(p)
        at = p
      case .quad, .curve:
        let pts: [CGPoint]
        switch op {
        case .curve(let c1, let c2, let e): pts = [at, c1, c2, e]
        case .quad(let c, let e): pts = [at, c, e]
        case .move(let e), .line(let e): pts = [at, e]
        }
        let b = pts[pts.count - 1]
        var poly: CGFloat = 0
        for k in 1..<pts.count { poly += hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y) }
        let steps = max(pts.count == 3 ? 8 : 4, min(64, Int((poly / 8).rounded(.toNearestOrAwayFromZero))))
        for s in 1...steps {
          let t = CGFloat(s) / CGFloat(steps)
          let u = 1 - t
          if pts.count == 4 {
            let (a, bb, cc, e) = (u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t)
            push(
              CGPoint(
                x: a * pts[0].x + bb * pts[1].x + cc * pts[2].x + e * pts[3].x,
                y: a * pts[0].y + bb * pts[1].y + cc * pts[2].y + e * pts[3].y))
          } else {
            push(
              CGPoint(
                x: u * u * pts[0].x + 2 * u * t * pts[1].x + t * t * pts[2].x,
                y: u * u * pts[0].y + 2 * u * t * pts[1].y + t * t * pts[2].y))
          }
        }
        at = b
      }
    }
    return out
  }

  // MARK: Ink Wash's brush line

  /// The width envelope over the stroke (t = share of its length): 0.75 to 1.3 over the first 7 %, then thinning to 0.45
  private static func headAt(_ t: CGFloat) -> CGFloat {
    t < 0.07 ? 0.75 + (t / 0.07) * 0.55 : 1.3 - 0.85 * pow((t - 0.07) / 0.93, 0.8)
  }

  /// A link's id → its wobble phase, 0..2π (brush.ts brushSeed)
  static func brushSeed(_ id: String) -> CGFloat { CGFloat(Double(Seeded.fnv(id)) / 4_294_967_296 * 6.283) }

  /// brush.ts brushLine: the filled outline of a brush stroke along the route (w: half the brush width), and the dry brush's
  /// three hairlines (empty on a short line)
  static func brush(_ ops: [PathOp], seed: CGFloat, w: CGFloat) -> (outline: CGPath, dry: CGPath) {
    let pl = flatten(ops)
    let n = pl.count
    let outline = CGMutablePath()
    let dry = CGMutablePath()
    guard n >= 2 else { return (outline, dry) }
    var acc: [CGFloat] = [0]
    for k in 1..<n { acc.append(acc[k - 1] + hypot(pl[k].x - pl[k - 1].x, pl[k].y - pl[k - 1].y)) }
    let length = acc[n - 1] == 0 ? 1 : acc[n - 1]
    func dir(_ k: Int) -> CGVector {
      let dx = pl[k + 1].x - pl[k].x
      let dy = pl[k + 1].y - pl[k].y
      let l = hypot(dx, dy) == 0 ? 1 : hypot(dx, dy)
      return CGVector(dx: dx / l, dy: dy / l)
    }
    var tan: [CGVector] = []
    for k in 0..<n {
      let a = dir(max(0, k - 1))
      let b = dir(min(n - 2, k))
      let mx = a.dx + b.dx
      let my = a.dy + b.dy
      let ml = hypot(mx, my)
      tan.append(ml > 1e-6 ? CGVector(dx: mx / ml, dy: my / ml) : b)
    }
    var j = 0
    func at(_ s: CGFloat) -> (p: CGPoint, t: CGVector) {
      if s < acc[j] { j = 0 }
      while j < n - 2 && acc[j + 1] < s { j += 1 }
      let seg = acc[j + 1] - acc[j] == 0 ? 1 : acc[j + 1] - acc[j]
      let k = min(1, max(0, (s - acc[j]) / seg))
      let a = tan[j]
      let b = tan[j + 1]
      let tx = a.dx + (b.dx - a.dx) * k
      let ty = a.dy + (b.dy - a.dy) * k
      let tl = hypot(tx, ty) == 0 ? 1 : hypot(tx, ty)
      return (
        CGPoint(x: pl[j].x + (pl[j + 1].x - pl[j].x) * k, y: pl[j].y + (pl[j + 1].y - pl[j].y) * k),
        CGVector(dx: tx / tl, dy: ty / tl)
      )
    }
    let steps = max(12, min(80, Int((length / 7).rounded(.toNearestOrAwayFromZero))))
    var ss = (0...steps).map { CGFloat($0) / CGFloat(steps) * length }
    if n > 2 {
      for k in 1..<(n - 1) {
        let a = dir(k - 1)
        let b = dir(k)
        if a.dx * b.dx + a.dy * b.dy < 0.9995 { ss.append(acc[k]) }
      }
    }
    ss.sort()
    var left: [CGPoint] = []
    var right: [CGPoint] = []
    for s in ss {
      let (p, t) = at(s)
      let f = s / length
      let h = w * headAt(f) * (1 + 0.07 * sin(f * 19 + seed) + 0.04 * sin(f * 47 + seed * 2))
      left.append(CGPoint(x: p.x - t.dy * h, y: p.y + t.dx * h))
      right.append(CGPoint(x: p.x + t.dy * h, y: p.y - t.dx * h))
    }
    outline.addLines(between: left + right.reversed())
    // the rounded start: an arc from the start of one side back to the other
    arc(outline, from: right[0], to: left[0], radius: w * 0.9, sweep: true)
    outline.closeSubpath()
    if length >= 60 {
      for (o, a, b) in [(-0.35, 0.32, 0.62), (0.3, 0.42, 0.78), (0.05, 0.55, 0.7)] as [(CGFloat, CGFloat, CGFloat)] {
        j = 0
        for i in 0...12 {
          let t = a + (b - a) * CGFloat(i) / 12
          let (p, tg) = at(t * length)
          let off = o * w * headAt(t) * 2
          let q = CGPoint(x: p.x - tg.dy * off, y: p.y + tg.dx * off)
          if i == 0 { dry.move(to: q) } else { dry.addLine(to: q) }
        }
      }
    }
    return (outline, dry)
  }

  // MARK: Warm Ink's tapered line

  /// taper.ts taperLine, whole: the route's outline from w0 wide at its start to w1 at its end, each piece offset by its own
  /// control points, a round cap at the start
  static func taper(_ ops: [PathOp], w0: CGFloat, w1: CGFloat) -> CGPath {
    typealias Seg = [CGPoint]
    var segs: [Seg] = []
    var at = CGPoint.zero
    for op in ops {
      switch op {
      case .move(let p): at = p
      case .line(let b):
        if hypot(b.x - at.x, b.y - at.y) > 1e-6 { segs.append([at, b]) }
        at = b
      case .curve(let c1, let c2, let b):
        if hypot(b.x - at.x, b.y - at.y) + hypot(c1.x - at.x, c1.y - at.y) > 1e-6 {
          segs += bendy([at, c1, c2, b], depth: 2)
        }
        at = b
      case .quad(let q, let b):
        segs += bendy(
          [
            at, CGPoint(x: at.x + (q.x - at.x) * 2 / 3, y: at.y + (q.y - at.y) * 2 / 3),
            CGPoint(x: b.x + (q.x - b.x) * 2 / 3, y: b.y + (q.y - b.y) * 2 / 3), b,
          ], depth: 2)
        at = b
      }
    }
    let path = CGMutablePath()
    guard !segs.isEmpty else { return path }
    func dist(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(b.x - a.x, b.y - a.y) }
    let lens = segs.map {
      $0.count == 2
        ? dist($0[0], $0[1]) : (dist($0[0], $0[3]) + dist($0[0], $0[1]) + dist($0[1], $0[2]) + dist($0[2], $0[3])) / 2
    }
    let total = lens.reduce(0, +)
    let length = total == 0 ? 1 : total
    func half(_ s: CGFloat) -> CGFloat { (w0 + (w1 - w0) * s / length) / 2 }
    func off(_ p: CGPoint, _ n: CGPoint, _ h: CGFloat, _ side: CGFloat) -> CGPoint {
      CGPoint(x: p.x - n.y * h * side, y: p.y + n.x * h * side)
    }
    // the outline's left side forwards, then its right side backwards: each as a list of drawing steps
    var lt: [PathOp] = []
    var rt: [PathOp] = []
    var s0: CGFloat = 0
    var first = CGPoint.zero
    for (k, g) in segs.enumerated() {
      let len = lens[k]
      let a = g[0]
      let b = g[g.count - 1]
      let na = g.count == 2 ? unitDir(a, [b]) : unitDir(a, [g[1], g[2], b])
      let back = g.count == 2 ? na : unitDir(b, [g[2], g[1], a])
      let n1 = g.count == 2 ? na : CGPoint(x: -back.x, y: -back.y)
      let ha = half(s0)
      let hb = half(s0 + len)
      let start = off(a, na, ha, 1)
      if k == 0 { first = start } else { lt.append(.line(start)) }
      if g.count == 2 {
        lt.append(.line(off(b, na, hb, 1)))
        rt.insert(.line(off(a, na, ha, -1)), at: 0)
        rt.insert(.line(off(b, na, hb, -1)), at: 0)
      } else {
        let h1 = half(s0 + len / 3)
        let h2 = half(s0 + 2 * len / 3)
        lt.append(.curve(off(g[1], na, h1, 1), off(g[2], n1, h2, 1), off(b, n1, hb, 1)))
        rt.insert(
          contentsOf: [
            .line(off(b, n1, hb, -1)), .curve(off(g[2], n1, h2, -1), off(g[1], na, h1, -1), off(a, na, ha, -1)),
          ], at: 0)
      }
      s0 += len
    }
    path.move(to: first)
    for op in lt + rt {
      switch op {
      case .move(let p), .line(let p): path.addLine(to: p)
      case .curve(let c1, let c2, let p): path.addCurve(to: p, control1: c1, control2: c2)
      case .quad(let c, let p): path.addQuadCurve(to: p, control: c)
      }
    }
    arc(path, from: path.currentPoint, to: first, radius: w0 / 2, sweep: false)
    path.closeSubpath()
    return path
  }

  private static func unitDir(_ a: CGPoint, _ bs: [CGPoint]) -> CGPoint {
    for b in bs {
      let l = hypot(b.x - a.x, b.y - a.y)
      if l > 1e-6 { return CGPoint(x: (b.x - a.x) / l, y: (b.y - a.y) / l) }
    }
    return CGPoint(x: 1, y: 0)
  }

  /// A cubic cut in halves until no piece turns more than ~35° (taper.ts bendy)
  private static func bendy(_ g: [CGPoint], depth: Int) -> [[CGPoint]] {
    let (a, b, c, e) = (g[0], g[1], g[2], g[3])
    let s = unitDir(a, [b, c, e])
    let t = unitDir(c, [e])
    let m = unitDir(CGPoint(x: a.x + b.x, y: a.y + b.y), [CGPoint(x: c.x + e.x, y: c.y + e.y)])
    func dot(_ p: CGPoint, _ q: CGPoint) -> CGFloat { p.x * q.x + p.y * q.y }
    if depth == 0 || (dot(s, m) > 0.82 && dot(m, t) > 0.82) { return [g] }
    func mid(_ p: CGPoint, _ q: CGPoint) -> CGPoint { CGPoint(x: (p.x + q.x) / 2, y: (p.y + q.y) / 2) }
    let ab = mid(a, b)
    let bc = mid(b, c)
    let ce = mid(c, e)
    let abc = mid(ab, bc)
    let bce = mid(bc, ce)
    let mm = mid(abc, bce)
    return bendy([a, ab, abc, mm], depth: depth - 1) + bendy([mm, bce, ce, e], depth: depth - 1)
  }

  /// An SVG circular arc (large-arc 0) from `a` to `b`: sweep true is SVG's sweep-flag 1 (clockwise on a y-down page)
  static func arc(_ p: CGMutablePath, from a: CGPoint, to b: CGPoint, radius r0: CGFloat, sweep: Bool) {
    let mx = (a.x + b.x) / 2
    let my = (a.y + b.y) / 2
    let dx = b.x - a.x
    let dy = b.y - a.y
    let chord = hypot(dx, dy)
    guard chord > 1e-9 else { return }
    // a radius too small for the chord grows to half of it, as SVG does
    let r = max(r0, chord / 2)
    let h = (max(0, r * r - chord * chord / 4)).squareRoot()
    // large-arc 0: the centre on the side the sweep turns towards
    let s: CGFloat = sweep ? 1 : -1
    let c = CGPoint(x: mx - s * dy / chord * h, y: my + s * dx / chord * h)
    let a0 = atan2(a.y - c.y, a.x - c.x)
    let a1 = atan2(b.y - c.y, b.x - c.x)
    p.addArc(center: c, radius: r, startAngle: a0, endAngle: a1, clockwise: !sweep)
  }
}

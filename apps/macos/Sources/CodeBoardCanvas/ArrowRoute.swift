import CoreGraphics

// Arrow geometry, ported from packages/core/src/canvas (geom.ts, route.ts, labelpos.ts): the curve route of Warm Ink and
// Ink Wash only (the elbow route belongs to other looks), without the side-switch slide (an animation for editing).
// Board units, y-down.

/// A drawn path: move, line, quadratic and cubic segments
enum PathOp: Equatable {
  case move(CGPoint)
  case line(CGPoint)
  case quad(CGPoint, CGPoint)
  case curve(CGPoint, CGPoint, CGPoint)
}

/// One end of an arrow on a card's edge, with the outward direction
struct Anchor: Equatable {
  var x: CGFloat
  var y: CGFloat
  var nx: CGFloat
  var ny: CGFloat
}

struct ArrowShape: Equatable {
  var path: [PathOp]
  /// The cubic Bézier [start, c1, c2, end] that labels ride on
  var pts: [CGPoint]
  var mid: CGPoint
  /// At the end: the line's direction into the end (unit)
  var inDir: CGVector
  /// At the start: from the line back towards the start (unit)
  var outDir: CGVector
}

enum ArrowRoute {
  enum Side: String, CaseIterable {
    case left, right, top, bottom
  }

  /// How two cards sit (seen from the start): sepR / sepL apart left-right (the end right / left); stackR / stackL stacked
  /// with a line end, C shape on the right / left; down / up stacked card to card, the end below / above
  enum Mode: Equatable {
    case sepR, sepL, stackR, stackL, down, up
  }

  /// How far the detour runs outside a card's edge
  static let clear: CGFloat = 24
  /// The narrowest gap that still faces left-right
  static let face: CGFloat = 8
  /// Distance before an end switches sides (the board's sideBuffer default)
  static let sideBuffer: CGFloat = 16
  static let maxTilt = CGFloat.pi / 4

  static func chooseMode(_ a: CGRect, _ b: CGRect, cards: Bool, prev: Mode?, buffer h: CGFloat) -> Mode {
    let gapR = b.minX - a.maxX
    let gapL = a.minX - b.maxX
    if gapR >= max(face, prev == .sepR ? 0 : h) { return .sepR }
    if gapL >= max(face, prev == .sepL ? 0 : h) { return .sepL }
    if cards {
      // side by side and only close: still facing left-right (top / bottom ends would run through the cards)
      let vgap = max(b.minY - a.maxY, a.minY - b.maxY)
      let vert = prev == .down || prev == .up
      if vgap < (vert ? -h : 0) {
        if gapR >= face { return .sepR }
        if gapL >= face { return .sepL }
      }
      if vgap >= face || max(gapR, gapL) >= 0 {
        let d = b.midY - a.midY
        if prev == .down && d > -h { return .down }
        if prev == .up && d < h { return .up }
        return d >= 0 ? .down : .up
      }
    }
    let d = b.midX - a.midX
    if prev == .stackR && d > -h { return .stackR }
    if prev == .stackL && d < h { return .stackL }
    return d >= 0 ? .stackR : .stackL
  }

  static func sides(_ m: Mode) -> (Side, Side) {
    switch m {
    case .sepR: (.right, .left)
    case .sepL: (.left, .right)
    case .stackR: (.right, .right)
    case .stackL: (.left, .left)
    case .down: (.bottom, .top)
    case .up: (.top, .bottom)
    }
  }

  /// A line end sits on its row's left / right edge; a card end on the left / right at the header row, on the top /
  /// bottom in the middle of the edge
  static func anchor(_ b: CGRect, _ side: Side, rowY: CGFloat) -> Anchor {
    switch side {
    case .left: Anchor(x: b.minX, y: rowY, nx: -1, ny: 0)
    case .right: Anchor(x: b.maxX, y: rowY, nx: 1, ny: 0)
    case .top: Anchor(x: b.midX, y: b.minY, nx: 0, ny: -1)
    case .bottom: Anchor(x: b.midX, y: b.maxY, nx: 0, ny: 1)
    }
  }

  /// A tilted card (turned by `rad` about its centre): the end turns with the edge
  static func turn(_ a: Anchor, _ b: CGRect, _ rad: CGFloat) -> Anchor {
    let c = cos(rad)
    let s = sin(rad)
    let dx = a.x - b.midX
    let dy = a.y - b.midY
    return Anchor(
      x: b.midX + dx * c - dy * s, y: b.midY + dx * s + dy * c, nx: a.nx * c - a.ny * s, ny: a.nx * s + a.ny * c)
  }

  /// Short room in front of an end and far to the side: the end leans towards the other one, at most 45°, back to
  /// straight once there is room (≥ 160 ahead). The signed angle
  static func tiltAngle(_ p: Anchor, _ q: CGPoint) -> CGFloat {
    let dx = q.x - p.x
    let dy = q.y - p.y
    let fwd = dx * p.nx + dy * p.ny
    let lat = dx * -p.ny + dy * p.nx
    if fwd <= 0 { return 0 }
    let fade = clamp((160 - fwd) / 80, 0, 1)
    if fade == 0 { return 0 }
    let a = min(maxTilt, 0.7 * atan2(abs(lat), fwd)) * fade
    return lat >= 0 ? a : -a
  }

  /// The line between two ends: a cubic whose handles grow with the distance when the ends face each other, leaning in when
  /// they are offset; outside both cards when both ends are on the same side. When that would run through a card (cards
  /// close together, or a pinned side facing the other card) it takes a detour around them with rounded corners instead
  static func connect(
    _ p: Anchor, _ q: Anchor, tilt: (start: Bool, end: Bool) = (true, true), a: CGRect? = nil, b: CGRect? = nil,
    clear: CGFloat = clear
  ) -> ArrowShape {
    let sh = direct(p, q, tilt: tilt, a: a, b: b, clear: clear)
    let obs = [a, b].compactMap { $0 }
    if obs.isEmpty || !pathHits(sh.path, obs, 4) { return sh }
    return detour(p, q, obs, clear: clear).map { rounded(p, q, $0) } ?? sh
  }

  private static func direct(
    _ p: Anchor, _ q: Anchor, tilt: (start: Bool, end: Bool), a: CGRect?, b: CGRect?, clear: CGFloat
  ) -> ArrowShape {
    let dot = p.nx * q.nx + p.ny * q.ny
    // same side, but the start inside the end card's side (or the reverse): round the card below / above
    if dot > 0.5 && p.ny == 0 {
      if let b, crosses(p, q, b) { return around(p, q, b, rev: false, clear: clear) }
      if let a, crosses(q, p, a) { return around(q, p, a, rev: true, clear: clear) }
    }
    let dx = q.x - p.x
    let dy = q.y - p.y
    let dist = hypot(dx, dy)
    var d1 = CGPoint(x: p.nx, y: p.ny)
    var d2 = CGPoint(x: q.nx, y: q.ny)
    let k1: CGFloat
    let k2: CGFloat
    if dot < -0.5 {
      // facing: how far ahead along p's direction, how far to the side
      let fwd = dx * p.nx + dy * p.ny
      let lat = abs(dx * -p.ny + dy * p.nx)
      let base =
        fwd > 0 ? clamp(abs(fwd) * 0.45 + lat * 0.3, 24, 180) : clamp(abs(fwd) * 0.6 + lat * 0.3 + 40, 40, 240)
      let t1 = tilt.start ? tiltAngle(p, CGPoint(x: q.x, y: q.y)) : 0
      let t2 = tilt.end ? tiltAngle(q, CGPoint(x: p.x, y: p.y)) : 0
      d1 = rot(d1, t1)
      d2 = rot(d2, t2)
      k1 = base + (dist * 0.35 - base) * abs(t1) / maxTilt
      k2 = base + (dist * 0.35 - base) * abs(t2) / maxTilt
    } else if dot > 0.5 {
      // same side (C shape): the handles go beyond the outer of the two ends
      let along = dx * p.nx + dy * p.ny
      let lat = abs(dx * -p.ny + dy * p.nx)
      let out = clamp(28 + lat * 0.15, 28, 120)
      k1 = max(0, along) + out
      k2 = max(0, -along) + out
    } else {
      // perpendicular ends (one side pinned): a handle no longer than the other end is away in its direction, or the
      // line overshoots and hooks back before the end (#134)
      let base = clamp(dist * 0.5, 30, 180)
      let f1 = dx * p.nx + dy * p.ny
      let f2 = -(dx * q.nx + dy * q.ny)
      k1 = f1 > 0 ? min(base, max(16, f1 * 0.6)) : base
      k2 = f2 > 0 ? min(base, max(16, f2 * 0.6)) : base
    }
    let c1 = CGPoint(x: p.x + d1.x * k1, y: p.y + d1.y * k1)
    let c2 = CGPoint(x: q.x + d2.x * k2, y: q.y + d2.y * k2)
    let pp = CGPoint(x: p.x, y: p.y)
    let qq = CGPoint(x: q.x, y: q.y)
    return ArrowShape(
      path: [.move(pp), .curve(c1, c2, qq)], pts: [pp, c1, c2, qq],
      mid: CGPoint(x: (p.x + 3 * c1.x + 3 * c2.x + q.x) / 8, y: (p.y + 3 * c1.y + 3 * c2.y + q.y) / 8),
      inDir: unit(q.x - c2.x, q.y - c2.y, -q.nx, -q.ny), outDir: unit(p.x - c1.x, p.y - c1.y, -p.nx, -p.ny))
  }

  /// A loop out of one side and back, for an arrow within one card
  static func selfArc(_ p: Anchor, _ q: Anchor) -> ArrowShape {
    let k = clamp(abs(q.y - p.y) * 0.5 + abs(q.x - p.x) * 0.5, 28, 90)
    let c1 = CGPoint(x: p.x + p.nx * k, y: p.y)
    let c2 = CGPoint(x: q.x + q.nx * k, y: q.y)
    let pp = CGPoint(x: p.x, y: p.y)
    let qq = CGPoint(x: q.x, y: q.y)
    return ArrowShape(
      path: [.move(pp), .curve(c1, c2, qq)], pts: [pp, c1, c2, qq],
      mid: CGPoint(x: (p.x + 3 * c1.x + 3 * c2.x + q.x) / 8, y: (p.y + 3 * c1.y + 3 * c2.y + q.y) / 8),
      inDir: unit(q.x - c2.x, q.y - c2.y, -q.nx, -q.ny), outDir: unit(p.x - c1.x, p.y - c1.y, -p.nx, -p.ny))
  }

  /// Warm Ink's dart: a small filled head, its tail notched a little. `tip` is the point, `u` the direction it points
  /// (unit), `s` the scale of the arrow's width
  static func dart(tip t: CGPoint, _ u: CGVector, scale s: CGFloat) -> [PathOp] {
    let b = CGPoint(x: t.x - 6.5 * s * u.dx, y: t.y - 6.5 * s * u.dy)
    let w = 3 * s
    return [
      .move(t), .line(CGPoint(x: b.x - w * u.dy, y: b.y + w * u.dx)),
      .line(CGPoint(x: t.x - 4.6 * s * u.dx, y: t.y - 4.6 * s * u.dy)),
      .line(CGPoint(x: b.x + w * u.dy, y: b.y - w * u.dx)),
    ]
  }

  // MARK: Curves

  static func clamp(_ v: CGFloat, _ a: CGFloat, _ b: CGFloat) -> CGFloat { max(a, min(b, v)) }

  static func bezAt(_ p: [CGPoint], _ t: CGFloat) -> CGPoint {
    let u = 1 - t
    let a = u * u * u
    let b = 3 * u * u * t
    let c = 3 * u * t * t
    let d = t * t * t
    return CGPoint(
      x: a * p[0].x + b * p[1].x + c * p[2].x + d * p[3].x, y: a * p[0].y + b * p[1].y + c * p[2].y + d * p[3].y)
  }

  /// The box a curve really covers (its control points can stick out much further): the ends plus where x or y turns
  static func bezBox(_ p: [CGPoint]) -> CGRect {
    var lo = [min(p[0].x, p[3].x), min(p[0].y, p[3].y)]
    var hi = [max(p[0].x, p[3].x), max(p[0].y, p[3].y)]
    for k in 0..<2 {
      let v = p.map { k == 0 ? $0.x : $0.y }
      // B'(t) / 3 = a t² + b t + c
      let a = -v[0] + 3 * v[1] - 3 * v[2] + v[3]
      let b = 2 * (v[0] - 2 * v[1] + v[2])
      let c = v[1] - v[0]
      let d = b * b - 4 * a * c
      let ts: [CGFloat] =
        abs(a) < 1e-9
        ? (abs(b) < 1e-9 ? [] : [-c / b])
        : d < 0 ? [] : [(-b + d.squareRoot()) / (2 * a), (-b - d.squareRoot()) / (2 * a)]
      for t in ts where t > 0 && t < 1 {
        let u = 1 - t
        let x = u * u * u * v[0] + 3 * u * u * t * v[1] + 3 * u * t * t * v[2] + t * t * t * v[3]
        lo[k] = min(lo[k], x)
        hi[k] = max(hi[k], x)
      }
    }
    return CGRect(x: lo[0], y: lo[1], width: hi[0] - lo[0], height: hi[1] - lo[1])
  }

  // MARK: Detours

  private static func rot(_ n: CGPoint, _ ang: CGFloat) -> CGPoint {
    CGPoint(x: n.x * cos(ang) - n.y * sin(ang), y: n.x * sin(ang) + n.y * cos(ang))
  }

  private static func unit(_ x: CGFloat, _ y: CGFloat, _ fx: CGFloat, _ fy: CGFloat) -> CGVector {
    let l = hypot(x, y)
    return l > 1e-6 ? CGVector(dx: x / l, dy: y / l) : CGVector(dx: fx, dy: fy)
  }

  /// Going out of p horizontally to the outer side of q's card b, would the line cross b
  private static func crosses(_ p: Anchor, _ q: Anchor, _ b: CGRect) -> Bool {
    if p.y <= b.minY + 4 || p.y >= b.maxY - 4 { return false }
    return p.nx > 0 ? p.x < b.minX + 4 && q.x >= b.maxX - 1 : p.x > b.maxX - 4 && q.x <= b.minX + 1
  }

  /// Around card b to its side: out of p, under (or over) the card, into q. rev: p is the end
  private static func around(_ p: Anchor, _ q: Anchor, _ b: CGRect, rev: Bool, clear: CGFloat) -> ArrowShape {
    let below = p.y >= b.midY
    let yd = below ? b.maxY + max(36, clear) : b.minY - max(36, clear)
    let s: CGFloat = p.nx > 0 ? 1 : -1
    let near = s > 0 ? b.minX : b.maxX
    let c = CGPoint(x: near, y: yd)
    let k1 = clamp(abs(near - p.x) * 0.5 + 20, 24, 80)
    let k2 = clamp(abs(yd - p.y) * 0.6, 20, 80)
    let a1 = CGPoint(x: p.x + s * k1, y: p.y)
    let a2 = CGPoint(x: near - s * k2, y: yd)
    // straight along under the card to the other corner f, then up into q
    let f = CGPoint(x: s > 0 ? b.maxX : b.minX, y: yd)
    let kq = clamp(abs(yd - q.y) * 0.45, 24, 70)
    let b1 = CGPoint(x: f.x + s * kq, y: yd)
    let b2 = CGPoint(x: max(q.x * s, f.x * s) * s + s * kq, y: q.y)
    let mid = CGPoint(x: (near + f.x) / 2, y: yd)
    let pp = CGPoint(x: p.x, y: p.y)
    let qq = CGPoint(x: q.x, y: q.y)
    let end = rev ? p : q
    let start = rev ? q : p
    let path: [PathOp]
    let pts: [CGPoint]
    if !rev {
      path = [.move(pp), .curve(a1, a2, c), .line(f), .curve(b1, b2, qq)]
      pts = [pp, CGPoint(x: a1.x, y: yd), CGPoint(x: b2.x, y: yd), qq]
    } else {
      path = [.move(qq), .curve(b2, b1, f), .line(c), .curve(a2, a1, pp)]
      pts = [qq, CGPoint(x: b2.x, y: yd), CGPoint(x: a1.x, y: yd), pp]
    }
    return ArrowShape(
      path: path, pts: pts, mid: mid, inDir: CGVector(dx: -end.nx, dy: -end.ny),
      outDir: CGVector(dx: -start.nx, dy: -start.ny))
  }

  /// The end's direction when it is straight along an axis (not on a tilted card)
  private static func axis(_ a: Anchor) -> (Int, Int)? {
    if abs(a.nx) > 0.999 { return (a.nx > 0 ? 1 : -1, 0) }
    if abs(a.ny) > 0.999 { return (0, a.ny > 0 ? 1 : -1) }
    return nil
  }

  /// Does a segment enter the card (shrunk by e): clipped to the card, is anything left
  private static func lineHits(_ p: CGPoint, _ q: CGPoint, _ b: CGRect, _ e: CGFloat) -> Bool {
    var t0: CGFloat = 0
    var t1: CGFloat = 1
    let dx = q.x - p.x
    let dy = q.y - p.y
    for (pp, qq) in [
      (-dx, p.x - (b.minX + e)), (dx, b.maxX - e - p.x), (-dy, p.y - (b.minY + e)), (dy, b.maxY - e - p.y),
    ] {
      if pp == 0 {
        if qq <= 0 { return false }
        continue
      }
      let t = qq / pp
      if pp < 0 { t0 = max(t0, t) } else { t1 = min(t1, t) }
      if t0 >= t1 { return false }
    }
    return true
  }

  /// Does the path enter a card: lines exactly, curves sampled in 16 pieces. e: how deep counts (4: a curve grazing a
  /// corner keeps its route)
  static func pathHits(_ path: [PathOp], _ obs: [CGRect], _ e: CGFloat) -> Bool {
    var at = CGPoint.zero
    for op in path {
      switch op {
      case .move(let p):
        at = p
      case .line(let p):
        if obs.contains(where: { lineHits(at, p, $0, e) }) { return true }
        at = p
      case .quad(let c, let p):
        let c3 = [
          at, CGPoint(x: at.x + 2 / 3 * (c.x - at.x), y: at.y + 2 / 3 * (c.y - at.y)),
          CGPoint(x: p.x + 2 / 3 * (c.x - p.x), y: p.y + 2 / 3 * (c.y - p.y)), p,
        ]
        if sampledHits(c3, obs, e) { return true }
        at = p
      case .curve(let c1, let c2, let p):
        if sampledHits([at, c1, c2, p], obs, e) { return true }
        at = p
      }
    }
    return false
  }

  private static func sampledHits(_ c: [CGPoint], _ obs: [CGRect], _ e: CGFloat) -> Bool {
    var u = c[0]
    for k in 1...16 {
      let v = bezAt(c, CGFloat(k) / 16)
      if obs.contains(where: { lineHits(u, v, $0, e) }) { return true }
      u = v
    }
    return false
  }

  private static let dirs = [(1, 0), (0, 1), (-1, 0), (0, -1)]

  /// Corners of a path around the cards made of horizontal and vertical runs: out of p along its direction, the last run
  /// into q's card from outside, entering neither card. The grid: both ends, `clear` outside each card, the middle of
  /// the gap between the cards; the cheapest path by length plus 24 per bend. nil when there is none (a card over an end)
  private static func detour(_ p: Anchor, _ q: Anchor, _ obs: [CGRect], clear: CGFloat) -> [CGPoint]? {
    guard let dp = axis(p), let dq = axis(q) else { return nil }
    var xs = [p.x, q.x]
    var ys = [p.y, q.y]
    for b in obs {
      xs += [b.minX - clear, b.maxX + clear]
      ys += [b.minY - clear, b.maxY + clear]
    }
    for a in obs {
      for b in obs {
        if a.maxX <= b.minX { xs.append((a.maxX + b.minX) / 2) }
        if a.maxY <= b.minY { ys.append((a.maxY + b.minY) / 2) }
      }
    }
    let gx = Array(Set(xs)).sorted()
    let gy = Array(Set(ys)).sorted()
    let ny = gy.count
    let count = gx.count * ny * 4
    func node(_ i: Int, _ j: Int) -> Int { i * ny + j }
    guard let pi = gx.firstIndex(of: p.x), let pj = gy.firstIndex(of: p.y), let qi = gx.firstIndex(of: q.x),
      let qj = gy.firstIndex(of: q.y),
      let start = dirs.firstIndex(where: { $0 == dp }), let arrive = dirs.firstIndex(where: { $0 == (-dq.0, -dq.1) })
    else { return nil }
    let s0 = node(pi, pj)
    let goal = node(qi, qj)
    var cost = [CGFloat](repeating: .infinity, count: count)
    var from = [Int](repeating: -1, count: count)
    var done = [Bool](repeating: false, count: count)
    cost[s0 * 4 + start] = 0
    // state = (grid point, direction it came in); under a hundred points, so a linear pick of the cheapest is enough
    while true {
      var st = -1
      var best = CGFloat.infinity
      for k in 0..<count where !done[k] && cost[k] < best {
        best = cost[k]
        st = k
      }
      if st < 0 { return nil }
      let n = st >> 2
      let dir = st & 3
      if n == goal && dir == arrive { break }
      done[st] = true
      let i = n / ny
      let j = n % ny
      for d in 0..<4 {
        if d == (dir + 2) & 3 || (st == s0 * 4 + start && d != start) { continue }
        let i2 = i + dirs[d].0
        let j2 = j + dirs[d].1
        if i2 < 0 || i2 >= gx.count || j2 < 0 || j2 >= ny { continue }
        let a = CGPoint(x: gx[i], y: gy[j])
        let b = CGPoint(x: gx[i2], y: gy[j2])
        // running along a card's edge does not count as entering it
        if obs.contains(where: { lineHits(a, b, $0, 0.5) }) { continue }
        let t = node(i2, j2) * 4 + d
        let c = best + abs(b.x - a.x) + abs(b.y - a.y) + (d == dir ? 0 : 24)
        if c < cost[t] {
          cost[t] = c
          from[t] = st
        }
      }
    }
    // walk back, keeping only the corners
    var way: [CGPoint] = []
    var st = goal * 4 + arrive
    while from[st] >= 0 {
      let prev = from[st]
      if prev & 3 != st & 3 {
        let n = prev >> 2
        way.insert(CGPoint(x: gx[n / ny], y: gy[n % ny]), at: 0)
      }
      st = prev
    }
    return way.isEmpty ? [CGPoint(x: (p.x + q.x) / 2, y: (p.y + q.y) / 2)] : way
  }

  /// The detour for the curve looks: its corners rounded (quadratic), the rest straight
  private static func rounded(_ p: Anchor, _ q: Anchor, _ way: [CGPoint]) -> ArrowShape {
    let all = [CGPoint(x: p.x, y: p.y)] + way + [CGPoint(x: q.x, y: q.y)]
    var path: [PathOp] = [.move(all[0])]
    for i in 1..<(all.count - 1) {
      let a = all[i - 1]
      let c = all[i]
      let b = all[i + 1]
      let la = hypot(c.x - a.x, c.y - a.y)
      let lb = hypot(b.x - c.x, b.y - c.y)
      let k = min(14, la / 2, lb / 2)
      let u = CGPoint(x: c.x - (c.x - a.x) / (la == 0 ? 1 : la) * k, y: c.y - (c.y - a.y) / (la == 0 ? 1 : la) * k)
      let v = CGPoint(x: c.x + (b.x - c.x) / (lb == 0 ? 1 : lb) * k, y: c.y + (b.y - c.y) / (lb == 0 ? 1 : lb) * k)
      path += [.line(u), .quad(c, v)]
    }
    path.append(.line(all[all.count - 1]))
    let f = way[0]
    let l = way[way.count - 1]
    // the middle: the middle point, or the middle of the middle run
    let n = all.count - 1
    let mi = n / 2
    let mid = n % 2 == 0 ? all[mi] : CGPoint(x: (all[mi].x + all[mi + 1].x) / 2, y: (all[mi].y + all[mi + 1].y) / 2)
    return ArrowShape(
      path: path, pts: [all[0], f, l, all[n]], mid: mid, inDir: unit(q.x - l.x, q.y - l.y, -q.nx, -q.ny),
      outDir: unit(p.x - f.x, p.y - f.y, -p.nx, -p.ny))
  }

  // MARK: Labels

  /// The gap a label box keeps to the cards at the arrow's ends
  static let labelGap: CGFloat = 6

  /// Does a box centred on `p` keep clear of these rects (with the gap)
  static func boxClear(_ p: CGPoint, _ box: CGSize, _ rs: [CGRect], gap: CGFloat = labelGap) -> Bool {
    let hw = box.width / 2 + gap
    let hh = box.height / 2 + gap
    return !rs.contains { p.x + hw > $0.minX && p.x - hw < $0.maxX && p.y + hh > $0.minY && p.y - hh < $0.maxY }
  }

  /// Where a label stored at `t` along the curve is drawn: where it is, or, when its box would cover an end's card (the
  /// cards moved closer), moved towards the middle to the first place it fits; the middle when nowhere fits
  static func placeT(_ pts: [CGPoint], _ t: CGFloat, _ box: CGSize, _ rs: [CGRect], gap: CGFloat = labelGap) -> CGFloat
  {
    let step: CGFloat = t < 0.5 ? 0.02 : -0.02
    for i in 0..<26 {
      let u = i == 0 ? t : t + step * CGFloat(i)
      if (step > 0 && u > 0.5) || (step < 0 && u < 0.5) { break }
      if boxClear(bezAt(pts, u), box, rs, gap: gap) { return u }
    }
    return 0.5
  }
}

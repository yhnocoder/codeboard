import CoreGraphics
import Foundation

/// Ink Wash's torn rice paper (state/ink.ts): one sheet per edge pattern, picked by the card's id, laid on the card as the
/// web lays its image, a nine-slice border image with round tiling (corners as drawn, edges and middle repeated a whole
/// number of times). Drawn here as vectors at the card's size, so it is as sharp at 200 % as at 50 %.
enum Deckle {
  /// How far the paper reaches outside the card
  static let margin: CGFloat = 14
  private static let slice: CGFloat = 30
  private static let tile: CGFloat = 240
  private static let step: CGFloat = 4
  private static let seeds = 4

  /// One edge of the sheet: per point (every 4 px from the edge's start) the jitter along the outward normal and the fibre
  /// sticking out there, as (along, out) offsets
  struct Edge: Sendable {
    var jitter: [CGFloat] = []
    var fibres: [Int: CGVector] = [:]
  }

  struct Sheet: Sendable {
    /// top, right, bottom, left, each run clockwise
    var edges: [Edge]
    /// Faint fibres inside, in the tiled middle: start and the relative quadratic's control and end
    var inner: [(start: CGPoint, control: CGVector, end: CGVector)]
  }

  /// The sheet with this edge pattern (paperSheet's shapes, with its random numbers)
  static func sheet(_ seed: Int) -> Sheet {
    let r = Seeded.rng(seed)
    let size = 2 * slice + tile
    let lines: [CGFloat] = [slice - margin, size - slice - margin]
    var edges: [Edge] = []
    for k in 0..<4 {
      var e = Edge()
      let n = Int(((size - 2 * margin) / step).rounded())
      for i in 0..<n {
        let d = CGFloat(i) * step
        var j: CGFloat = 0
        if i != 0 && !lines.contains(d) {
          let a = (r() - 0.5) * 1.0
          j = CGFloat(a + (r() < 0.03 ? -0.9 : 0))
        }
        e.jitter.append(j)
        if r() < 0.06 && !lines.contains(where: { abs(d - $0) < 6 }) {
          let l = 1 + r() * 2
          let a = (r() - 0.5) * 1.2
          // the web's (nx·l + ny·a·l, ny·l + nx·a·l) as (along the clockwise edge, outwards)
          e.fibres[i] = CGVector(dx: CGFloat(a * l) * (k % 2 == 0 ? -1 : 1), dy: CGFloat(l))
        }
      }
      edges.append(e)
    }
    var inner: [(CGPoint, CGVector, CGVector)] = []
    let lo = slice + 6
    let hi = size - slice - 6
    for _ in 0..<6 {
      let l = 20 + r() * 60
      let a = r() * Double.pi
      let dx = CGFloat(cos(a) * l)
      let dy = CGFloat(sin(a) * l)
      let x = lo + CGFloat(r()) * (hi - lo - abs(dx)) + max(0, -dx)
      let y = lo + CGFloat(r()) * (hi - lo - dy)
      inner.append((CGPoint(x: x, y: y), CGVector(dx: dx / 2 + 6, dy: dy / 2 - 4), CGVector(dx: dx, dy: dy)))
    }
    return Sheet(edges: edges, inner: inner)
  }

  static let sheets: [Sheet] = (1...seeds).map(sheet)

  /// Which sheet the card with this id gets (ink.ts paperSeed, 1-based there)
  static func sheet(for id: String) -> Sheet { sheets[Int(Seeded.fnv(id) % UInt32(seeds))] }

  /// The paper of a card of `size`, in the card's units (its top left at 0, 0; the paper reaches `margin` beyond):
  /// the torn outline, the fibres sticking out of it and the faint fibres inside
  static func paper(_ s: Sheet, size: CGSize) -> (outline: CGPath, fibres: CGPath, inner: CGPath) {
    let sheetSize = 2 * slice + tile
    let edgeLength = sheetSize - 2 * margin
    let target = CGSize(width: size.width + 2 * margin, height: size.height + 2 * margin)
    // the card's corners on the outline, clockwise from the top left, and each edge's direction and outward normal
    let w = size.width
    let h = size.height
    let starts = [CGPoint(x: 0, y: 0), CGPoint(x: w, y: 0), CGPoint(x: w, y: h), CGPoint(x: 0, y: h)]
    let dirs = [CGVector(dx: 1, dy: 0), CGVector(dx: 0, dy: 1), CGVector(dx: -1, dy: 0), CGVector(dx: 0, dy: -1)]
    let normals = [CGVector(dx: 0, dy: -1), CGVector(dx: 1, dy: 0), CGVector(dx: 0, dy: 1), CGVector(dx: -1, dy: 0)]
    let outline = CGMutablePath()
    let fibres = CGMutablePath()
    for k in 0..<4 {
      let e = s.edges[k]
      let along = k % 2 == 0 ? target.width : target.height
      let room = along - 2 * slice
      let n = max(1, Int((room / tile).rounded()))
      let scale = room / (CGFloat(n) * tile)
      // where each of the sheet's points falls along this edge of the card: corners as they are, the middle tiled
      var placed: [(i: Int, d: CGFloat, scale: CGFloat)] = []
      let first = Int((slice - margin) / step)
      let last = Int((sheetSize - slice - margin) / step)
      for i in 0..<first { placed.append((i, CGFloat(i) * step, 1)) }
      for t in 0..<n {
        for i in first..<last {
          placed.append(
            (i, slice - margin + (CGFloat(t) * tile + (CGFloat(i) * step - (slice - margin))) * scale, scale))
        }
      }
      for i in last..<e.jitter.count {
        placed.append((i, along - 2 * margin - (edgeLength - CGFloat(i) * step), 1))
      }
      let o = starts[k]
      let u = dirs[k]
      let nn = normals[k]
      for (i, d, sc) in placed {
        let j = e.jitter[i]
        let p = CGPoint(x: o.x + u.dx * d + nn.dx * j, y: o.y + u.dy * d + nn.dy * j)
        if k == 0 && i == 0 { outline.move(to: p) } else { outline.addLine(to: p) }
        if let f = e.fibres[i] {
          fibres.move(to: p)
          fibres.addLine(
            to: CGPoint(x: p.x + u.dx * f.dx * sc + nn.dx * f.dy, y: p.y + u.dy * f.dx * sc + nn.dy * f.dy))
        }
      }
    }
    outline.closeSubpath()
    // the middle, tiled both ways
    let inner = CGMutablePath()
    let room = CGSize(width: target.width - 2 * slice, height: target.height - 2 * slice)
    let nx = max(1, Int((room.width / tile).rounded()))
    let ny = max(1, Int((room.height / tile).rounded()))
    let sx = room.width / (CGFloat(nx) * tile)
    let sy = room.height / (CGFloat(ny) * tile)
    for tx in 0..<nx {
      for ty in 0..<ny {
        let ox = slice - margin + CGFloat(tx) * tile * sx
        let oy = slice - margin + CGFloat(ty) * tile * sy
        for f in s.inner {
          let a = CGPoint(x: ox + (f.start.x - slice) * sx, y: oy + (f.start.y - slice) * sy)
          inner.move(to: a)
          inner.addQuadCurve(
            to: CGPoint(x: a.x + f.end.dx * sx, y: a.y + f.end.dy * sy),
            control: CGPoint(x: a.x + f.control.dx * sx, y: a.y + f.control.dy * sy))
        }
      }
    }
    return (outline, fibres, inner)
  }
}

/// Ink Wash's Section frame (state/inkframe.ts): four dry brush strokes, the top one leaving a gap for the title
enum InkFrame {
  /// How far the strokes reach outside the Section
  static let margin: CGFloat = 12
  private static let brush: CGFloat = 2.5
  private static let step: CGFloat = 4
  private static let gapIn: CGFloat = 8
  private static let gapOut: CGFloat = 20

  /// The frame of the Section with this id, w × h, in the Section's units; gap: the title's width (0: no gap)
  static func path(id: String, size: CGSize, gap: CGFloat) -> CGPath {
    let w = max(2, (size.width / 2).rounded() * 2)
    let h = max(2, (size.height / 2).rounded() * 2)
    let g = (gap / 2).rounded() * 2
    let k = Int(Seeded.fnv(id) & 0xffffff) * 8
    let out = CGMutablePath()
    // the web draws in an image `margin` outside the Section: here the Section's top left is 0, 0
    let x0: CGFloat = 0
    let y0: CGFloat = 0
    let x1 = w
    let y1 = h
    if g > 0 {
      let ga = x0 + gapIn
      let gb = min(x1 - 30, ga + g + gapOut)
      stroke(out, k, CGPoint(x: x0 - 4, y: y0 + 0.5), CGPoint(x: ga, y: y0 - 0.3), brush * 0.9, breaks: false)
      if x1 + 5 - gb > 12 {
        stroke(out, k + 1, CGPoint(x: gb, y: y0 - 0.5), CGPoint(x: x1 + 5, y: y0 + 0.6), brush, breaks: true)
      }
    } else {
      stroke(out, k + 1, CGPoint(x: x0 - 4, y: y0 + 0.5), CGPoint(x: x1 + 5, y: y0 + 0.6), brush, breaks: true)
    }
    stroke(out, k + 2, CGPoint(x: x1 + 0.3, y: y0 - 5), CGPoint(x: x1 - 0.5, y: y1 + 4), brush * 1.05, breaks: true)
    stroke(out, k + 3, CGPoint(x: x0 - 0.5, y: y0 - 3), CGPoint(x: x0 + 0.6, y: y1 + 6), brush * 1.1, breaks: true)
    stroke(out, k + 4, CGPoint(x: x0 - 5, y: y1 + 0.4), CGPoint(x: x1 + 6, y: y1 - 0.6), brush, breaks: true)
    return out
  }

  private static func smooth(_ x: CGFloat) -> CGFloat { x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x) }

  /// One brush stroke from a to b (inkframe.ts stroke): closed pieces, all wound the same way
  private static func stroke(_ out: CGMutablePath, _ key: Int, _ a: CGPoint, _ b: CGPoint, _ w: CGFloat, breaks: Bool) {
    let length = hypot(b.x - a.x, b.y - a.y)
    if length < 1 { return }
    let ux = (b.x - a.x) / length
    let uy = (b.y - a.y) / length
    let nx = -uy
    let ny = ux
    let n = max(4, Int((length / step).rounded(.up)))
    let r = Seeded.rng(key)
    let ph = CGFloat(r() * 6)
    let bow = CGFloat((r() - 0.5) * 1.4)
    let wantBreak = r() < 0.75
    let lift = r() < 0.18
    let at = CGFloat(0.3 + r() * 0.4)
    let dryLen = CGFloat(28 + r() * 16)
    let wantSplit = r() < 0.6
    let splitAt = CGFloat(0.5 + r() * 0.15)
    let splitLen = CGFloat(25 + r() * 30)
    let splitO = CGFloat((r() - 0.5) * 0.4)
    let pointA = CGFloat((r() - 0.5) * 0.3)
    let pointB = CGFloat((r() - 0.5) * 0.3)
    let strands = (0..<5).map { _ in (0..<5).map { _ in CGFloat(r()) } }
    let nStrands = 3 + Int((r() * 2.99).rounded(.down))
    func idx(_ d: CGFloat) -> Int { max(0, min(n, Int((d / length * CGFloat(n)).rounded(.toNearestOrAwayFromZero)))) }
    let brk = breaks && wantBreak && length > 140
    let b0 = idx(at * length - (lift ? 0 : dryLen / 2))
    let b1 = lift ? b0 : idx(at * length + dryLen / 2)
    let dip0 = CGFloat(b0 - 3) * (length / CGFloat(n))
    let dip1 = CGFloat(b1 + 3) * (length / CGFloat(n))
    let pl = min(0.1 * length, 16)
    let tl = min(0.22 * length, 56)
    var cx = [CGFloat](repeating: 0, count: n + 1)
    var cy = cx
    var ww = cx
    for i in 0...n {
      let t = CGFloat(i) / CGFloat(n)
      let d = t * length
      let press = d < pl ? 1 + 0.55 * (1 - d / pl) : 1
      let taper = d > length - tl ? max(0.3, 1 - ((d - (length - tl)) / tl) * 0.7) : 1
      let dip = brk && !lift && d > dip0 && d < dip1 ? 1 - 0.2 * sin(.pi * (d - dip0) / (dip1 - dip0)) : 1
      ww[i] = w * (0.8 + 0.2 * sin(d / 55 + ph) + CGFloat(Seeded.hash(key, i) - 0.5) * 0.2) * press * taper * dip
      let off = bow * sin(.pi * t) + CGFloat(Seeded.hash(key + 7, i) - 0.5) * 0.3
      cx[i] = a.x + ux * d + nx * off
      cy[i] = a.y + uy * d + ny * off
    }
    typealias U = (Int) -> CGFloat
    func pt(_ i: Int, _ u: CGFloat) -> CGPoint { CGPoint(x: cx[i] + nx * ww[i] * u, y: cy[i] + ny * ww[i] * u) }
    func cap(_ i: Int, _ lo: CGFloat, _ hi: CGFloat, _ dir: CGFloat) -> [CGPoint] {
      let m = (lo + hi) / 2
      let rad = ww[i] * (hi - lo) / 2
      return [CGFloat.pi / 4, .pi / 2, 3 * .pi / 4].map { ang in
        let c = cos(ang) * dir
        let s = sin(ang) * dir
        return CGPoint(
          x: cx[i] + nx * (ww[i] * m + rad * c) + ux * rad * s, y: cy[i] + ny * (ww[i] * m + rad * c) + uy * rad * s)
      }
    }
    func piece(_ i0: Int, _ i1: Int, _ lo: U, _ hi: U, _ capStart: Bool, _ capEnd: Bool) {
      if i1 <= i0 { return }
      var pts = (i0...i1).map { pt($0, hi($0)) }
      if capEnd { pts += cap(i1, lo(i1), hi(i1), 1) }
      pts += (i0...i1).reversed().map { pt($0, lo($0)) }
      if capStart { pts += cap(i0, lo(i0), hi(i0), -1) }
      out.addLines(between: pts)
      out.closeSubpath()
    }
    func run(
      _ i0: Int, _ i1: Int, _ lo: @escaping U, _ hi: @escaping U, _ capStart: Bool, _ capEnd: Bool, _ split: (Int, Int)?
    ) {
      guard let (s0, s1) = split else { return piece(i0, i1, lo, hi, capStart, capEnd) }
      func gap(_ i: Int) -> CGFloat {
        i <= s0 || i >= s1 ? 0 : 0.24 * sin(.pi * CGFloat(i - s0) / CGFloat(s1 - s0))
      }
      piece(i0, s0, lo, hi, capStart, false)
      piece(s0 - 1, s1 + 1, { min(hi($0), splitO + gap($0) / 2) }, hi, false, false)
      piece(s0 - 1, s1 + 1, lo, { max(lo($0), splitO - gap($0) / 2) }, false, false)
      piece(s1, i1, lo, hi, false, capEnd)
    }
    let low: U = { _ in -0.5 }
    let high: U = { _ in 0.5 }
    let sp0 = idx(splitAt * length)
    let sp1 = idx(splitAt * length + splitLen)
    let splitOk = breaks && wantSplit && length > 90 && sp1 < idx(length - tl * 0.6) && sp1 - sp0 >= 4
    func clear(_ a: Int, _ b: Int) -> (Int, Int)? { splitOk && sp0 > a + 2 && sp1 < b - 2 ? (sp0, sp1) : nil }
    if !brk { return run(0, n, low, high, true, true, clear(0, n)) }
    if lift {
      let shrink: U = { 1 - 0.75 * smooth(CGFloat($0 - (b0 - 4)) / 5) }
      let press: U = { 1 + 0.35 * (1 - smooth(CGFloat($0 - (b0 - 1)) / 3)) }
      let dv = CGFloat(Seeded.hash(key, 999) - 0.5) * 0.5
      piece(0, b0 + 1, { -0.5 * shrink($0) }, { 0.5 * shrink($0) }, true, true)
      return run(b0 - 1, n, { -0.5 * press($0) + dv }, { 0.5 * press($0) + dv }, true, true, clear(b0 + 3, n))
    }
    let reach = max(1, Int((0.45 * CGFloat(b1 - b0)).rounded(.toNearestOrAwayFromZero)))
    let aEnd = b0 + reach
    let bStart = b1 - reach
    let into: U = { smooth(CGFloat($0 - (b0 - 2)) / CGFloat(aEnd - (b0 - 2))) }
    let outOf: U = { 1 - smooth(CGFloat($0 - bStart) / CGFloat(b1 + 2 - bStart)) }
    piece(0, aEnd, { -0.5 + into($0) * (0.5 + pointA) }, { 0.5 - into($0) * (0.5 - pointA) }, true, false)
    for k in 0..<nStrands {
      let q = strands[k]
      let u = w * (-0.8 + 1.6 * (CGFloat(k) + 0.5 + (q[0] - 0.5) * 0.4) / CGFloat(nStrands))
      let hw = 0.2 + q[1] * 0.16
      let outer = k == 0 || k == nStrands - 1
      let s0 = b0 - 2 + (outer ? 0 : Int((q[2] * 0.35 * CGFloat(b1 - b0)).rounded(.down)))
      let s1 = b1 + 2 - (outer ? 0 : Int((q[3] * 0.35 * CGFloat(b1 - b0)).rounded(.down)))
      let qq: U = { max(0, min(1, CGFloat($0 - s0) / 2, CGFloat(s1 - $0) / 2)) }
      let c: U = {
        u * (0.4 + 0.6 * sin(.pi * CGFloat($0 - s0) / CGFloat(s1 - s0))) + 0.12 * sin(CGFloat($0) * 0.9 + q[4] * 6)
      }
      piece(s0, s1, { (c($0) - hw * qq($0)) / ww[$0] }, { (c($0) + hw * qq($0)) / ww[$0] }, false, false)
    }
    run(
      bStart, n, { -0.5 + outOf($0) * (0.5 + pointB) }, { 0.5 - outOf($0) * (0.5 - pointB) }, false, true,
      clear(b1 + 3, n))
  }
}

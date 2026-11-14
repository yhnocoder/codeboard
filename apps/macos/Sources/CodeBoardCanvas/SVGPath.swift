import CoreGraphics
import Foundation

/// SVG path data (`d`) as a CGPath, in the units it is written in: M L H V C S Q T A Z, absolute and relative; what it
/// cannot read ends the path there. For the glyphs and icons main draws from Lucide's paths.
enum SVGPath {
  static func parse(_ d: String) -> CGPath {
    let p = CGMutablePath()
    var s = Scanner(Array(d.utf8))
    var cur = CGPoint.zero
    var start = CGPoint.zero
    // the last control point, for S and T
    var lastC: CGPoint?
    var lastQ: CGPoint?
    var cmd: UInt8 = 0
    while true {
      s.skipSpace()
      guard let c = s.peek() else { break }
      if Scanner.isCommand(c) {
        cmd = c
        s.i += 1
      } else if cmd == 0 {
        break
      }
      let rel = cmd >= 97
      func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y) }
      switch cmd | 0x20 {
      case UInt8(ascii: "m"):
        guard let x = s.number(), let y = s.number() else { return p }
        cur = pt(x, y)
        start = cur
        p.move(to: cur)
        // further pairs are lines
        cmd = rel ? UInt8(ascii: "l") : UInt8(ascii: "L")
        lastC = nil
        lastQ = nil
      case UInt8(ascii: "l"):
        guard let x = s.number(), let y = s.number() else { return p }
        cur = pt(x, y)
        p.addLine(to: cur)
        lastC = nil
        lastQ = nil
      case UInt8(ascii: "h"):
        guard let x = s.number() else { return p }
        cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y)
        p.addLine(to: cur)
        lastC = nil
        lastQ = nil
      case UInt8(ascii: "v"):
        guard let y = s.number() else { return p }
        cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y)
        p.addLine(to: cur)
        lastC = nil
        lastQ = nil
      case UInt8(ascii: "c"):
        guard let x1 = s.number(), let y1 = s.number(), let x2 = s.number(), let y2 = s.number(), let x = s.number(),
          let y = s.number()
        else { return p }
        let c1 = pt(x1, y1)
        let c2 = pt(x2, y2)
        cur = pt(x, y)
        p.addCurve(to: cur, control1: c1, control2: c2)
        lastC = c2
        lastQ = nil
      case UInt8(ascii: "s"):
        guard let x2 = s.number(), let y2 = s.number(), let x = s.number(), let y = s.number() else { return p }
        let c1 = lastC.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
        let c2 = pt(x2, y2)
        cur = pt(x, y)
        p.addCurve(to: cur, control1: c1, control2: c2)
        lastC = c2
        lastQ = nil
      case UInt8(ascii: "q"):
        guard let x1 = s.number(), let y1 = s.number(), let x = s.number(), let y = s.number() else { return p }
        let c = pt(x1, y1)
        cur = pt(x, y)
        p.addQuadCurve(to: cur, control: c)
        lastQ = c
        lastC = nil
      case UInt8(ascii: "t"):
        guard let x = s.number(), let y = s.number() else { return p }
        let c = lastQ.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
        cur = pt(x, y)
        p.addQuadCurve(to: cur, control: c)
        lastQ = c
        lastC = nil
      case UInt8(ascii: "a"):
        guard let rx = s.number(), let ry = s.number(), let rot = s.number(), let large = s.flag(),
          let sweep = s.flag(), let x = s.number(), let y = s.number()
        else { return p }
        let to = pt(x, y)
        arc(p, from: cur, to: to, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep)
        cur = to
        lastC = nil
        lastQ = nil
      case UInt8(ascii: "z"):
        p.closeSubpath()
        cur = start
        lastC = nil
        lastQ = nil
        // a Z takes no numbers: the next must be a command
        cmd = 0
      default:
        return p
      }
    }
    return p
  }

  /// An elliptical arc in endpoint form (SVG 1.1 F.6.5), drawn as Core Graphics' arc of a transformed unit circle
  static func arc(
    _ p: CGMutablePath, from a: CGPoint, to b: CGPoint, rx rx0: CGFloat, ry ry0: CGFloat, rotation: CGFloat,
    large: Bool, sweep: Bool
  ) {
    var rx = abs(rx0)
    var ry = abs(ry0)
    guard rx > 0, ry > 0, a != b else {
      p.addLine(to: b)
      return
    }
    let phi = rotation * .pi / 180
    let cosP = cos(phi)
    let sinP = sin(phi)
    let dx = (a.x - b.x) / 2
    let dy = (a.y - b.y) / 2
    let x1 = cosP * dx + sinP * dy
    let y1 = -sinP * dx + cosP * dy
    let l = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry)
    if l > 1 {
      rx *= sqrt(l)
      ry *= sqrt(l)
    }
    let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
    var k = sqrt(max(0, num / den))
    if large == sweep { k = -k }
    let cx1 = k * rx * y1 / ry
    let cy1 = -k * ry * x1 / rx
    let cx = cosP * cx1 - sinP * cy1 + (a.x + b.x) / 2
    let cy = sinP * cx1 + cosP * cy1 + (a.y + b.y) / 2
    func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
      let sign: CGFloat = ux * vy - uy * vx < 0 ? -1 : 1
      let dot = (ux * vx + uy * vy) / (hypot(ux, uy) * hypot(vx, vy))
      return sign * acos(min(1, max(-1, dot)))
    }
    let t1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
    var dt = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
    if !sweep && dt > 0 { dt -= 2 * .pi }
    if sweep && dt < 0 { dt += 2 * .pi }
    let t = CGAffineTransform(translationX: cx, y: cy).rotated(by: phi).scaledBy(x: rx, y: ry)
    p.addRelativeArc(center: .zero, radius: 1, startAngle: t1, delta: dt, transform: t)
  }

  private struct Scanner {
    let b: [UInt8]
    var i = 0

    init(_ b: [UInt8]) { self.b = b }

    func peek() -> UInt8? { i < b.count ? b[i] : nil }

    static func isCommand(_ c: UInt8) -> Bool { "MmLlHhVvCcSsQqTtAaZz".utf8.contains(c) }

    mutating func skipSpace() {
      while let c = peek(), c == 32 || c == 44 || c == 9 || c == 10 || c == 13 { i += 1 }
    }

    /// An arc's flag: one 0 or 1, which may run into what follows
    mutating func flag() -> Bool? {
      skipSpace()
      guard let c = peek(), c == 48 || c == 49 else { return nil }
      i += 1
      return c == 49
    }

    mutating func number() -> CGFloat? {
      skipSpace()
      let s = i
      if let c = peek(), c == 43 || c == 45 { i += 1 }
      var dot = false
      var digits = false
      while let c = peek() {
        if c >= 48 && c <= 57 {
          digits = true
          i += 1
        } else if c == 46 && !dot {
          dot = true
          i += 1
        } else {
          break
        }
      }
      if digits, let c = peek(), c == 101 || c == 69 {
        i += 1
        if let c = peek(), c == 43 || c == 45 { i += 1 }
        while let c = peek(), c >= 48 && c <= 57 { i += 1 }
      }
      guard digits, let v = Double(String(decoding: b[s..<i], as: UTF8.self)) else {
        i = s
        return nil
      }
      return CGFloat(v)
    }
  }
}

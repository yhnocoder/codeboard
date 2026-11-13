import CoreGraphics
import CoreText
import Foundation

/// Draws the SVG subset formulas and Mermaid diagrams come as (MDPath, MDGlyphText): paths from SVG path data, painted with
/// the theme's colours at draw time
enum SVGShapes {
  private static let paths = Cache<String, CGPath>(limit: 20_000)

  static func path(_ data: String) -> CGPath { paths.get(data) { parse(data) } }

  /// draws shapes and texts whose units are `scale` points each (a formula: an em of its font size)
  static func draw(
    _ shapes: [MDPath], _ texts: [MDGlyphText], _ ctx: CGContext, scale: CGFloat, ink: MDColor, theme: MarkdownTheme,
    textFont: [String]? = nil
  ) {
    for p in shapes {
      let cg = path(p.data)
      ctx.saveGState()
      ctx.scaleBy(x: scale, y: scale)
      ctx.concatenate(p.transform)
      if let fill = color(p.fill, ink, theme) {
        ctx.setFillColor(fill.cg)
        ctx.addPath(cg)
        ctx.fillPath()
      }
      if let stroke = color(p.stroke, ink, theme), p.strokeWidth > 0 {
        ctx.setStrokeColor(stroke.cg)
        // the width is in the path's own units, which the context's transform already maps
        ctx.setLineWidth(p.strokeWidth)
        ctx.addPath(cg)
        ctx.strokePath()
      }
      ctx.restoreGState()
    }
    // texts at their real size, not drawn tiny under a scaled context
    for t in texts {
      guard let c = color(t.fill, ink, theme) else { continue }
      let font = FontBook.font(textFont ?? theme.fonts.body, size: CGFloat(t.size) * scale, weight: t.bold ? 600 : 400)
      let attr = NSAttributedString(
        string: t.text,
        attributes: [
          NSAttributedString.Key(kCTFontAttributeName as String): font,
          NSAttributedString.Key(kCTForegroundColorAttributeName as String): c.cg,
        ])
      let line = CTLineCreateWithAttributedString(attr)
      let w = t.anchor == 0 ? 0 : CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)) * CGFloat(t.anchor)
      ctx.saveGState()
      ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
      ctx.textPosition = CGPoint(x: t.origin.x * scale - w, y: t.origin.y * scale)
      CTLineDraw(line, ctx)
      ctx.restoreGState()
    }
  }

  static func color(_ p: MDPath.Paint, _ ink: MDColor, _ theme: MarkdownTheme) -> MDColor? {
    switch p {
    case .none: return nil
    case .ink: return ink
    case .color(let c): return c
    case .role(let role):
      guard let d = theme.diagrams else { return ink }
      switch role {
      case "background", "bg": return d.background
      case "fg": return d.foreground
      case "surfaceAlt": return d.surfaceAlt
      case "foreground": return d.foreground
      case "muted": return d.muted
      case "line": return d.line
      case "surface": return d.surface
      case "surface-alt": return d.surfaceAlt
      case "border": return d.border
      case "accent": return d.accent
      default:
        if role.hasPrefix("series-"), let n = Int(role.dropFirst(7)), n >= 1, n <= d.series.count {
          return d.series[n - 1]
        }
        return ink
      }
    }
  }

  // MARK: path data

  /// SVG path data → CGPath: M L H V C S Q T A Z, absolute and relative
  static func parse(_ d: String) -> CGPath {
    let p = CGMutablePath()
    var s = Scanner(d)
    var cur = CGPoint.zero
    var start = CGPoint.zero
    var lastCtrl: CGPoint?
    var lastCmd: Character = " "
    var cmd: Character = " "
    while true {
      s.skipSeparators()
      guard let c = s.peek else { break }
      if c.isLetter {
        cmd = c
        s.advance()
      } else if cmd == " " {
        break
      }
      let rel = cmd.isLowercase
      let base = rel ? cur : .zero
      func pt() -> CGPoint? {
        guard let x = s.number(), let y = s.number() else { return nil }
        return CGPoint(x: base.x + x, y: base.y + y)
      }
      switch cmd.uppercased().first! {
      case "M":
        guard let q = pt() else { return p }
        p.move(to: q)
        cur = q
        start = q
        // further pairs after a moveto are linetos
        cmd = rel ? "l" : "L"
        lastCtrl = nil
      case "L":
        guard let q = pt() else { return p }
        p.addLine(to: q)
        cur = q
        lastCtrl = nil
      case "H":
        guard let x = s.number() else { return p }
        cur = CGPoint(x: (rel ? cur.x : 0) + x, y: cur.y)
        p.addLine(to: cur)
        lastCtrl = nil
      case "V":
        guard let y = s.number() else { return p }
        cur = CGPoint(x: cur.x, y: (rel ? cur.y : 0) + y)
        p.addLine(to: cur)
        lastCtrl = nil
      case "C":
        guard let c1 = pt(), let c2 = pt(), let q = pt() else { return p }
        p.addCurve(to: q, control1: c1, control2: c2)
        lastCtrl = c2
        cur = q
      case "S":
        guard let c2 = pt(), let q = pt() else { return p }
        let c1 =
          "CScs".contains(lastCmd) && lastCtrl != nil
          ? CGPoint(x: 2 * cur.x - lastCtrl!.x, y: 2 * cur.y - lastCtrl!.y) : cur
        p.addCurve(to: q, control1: c1, control2: c2)
        lastCtrl = c2
        cur = q
      case "Q":
        guard let c1 = pt(), let q = pt() else { return p }
        p.addQuadCurve(to: q, control: c1)
        lastCtrl = c1
        cur = q
      case "T":
        guard let q = pt() else { return p }
        let c1 =
          "QTqt".contains(lastCmd) && lastCtrl != nil
          ? CGPoint(x: 2 * cur.x - lastCtrl!.x, y: 2 * cur.y - lastCtrl!.y) : cur
        p.addQuadCurve(to: q, control: c1)
        lastCtrl = c1
        cur = q
      case "A":
        guard let rx = s.number(), let ry = s.number(), let rot = s.number(), let large = s.flag(),
          let sweep = s.flag(),
          let q = pt()
        else { return p }
        arc(p, from: cur, to: q, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep)
        cur = q
        lastCtrl = nil
      case "Z":
        p.closeSubpath()
        cur = start
        lastCtrl = nil
      default:
        return p
      }
      lastCmd = cmd
    }
    return p
  }

  /// an SVG elliptical arc as cubic curves (the endpoint-to-centre conversion of the SVG spec, F.6.5)
  private static func arc(
    _ p: CGMutablePath, from a: CGPoint, to b: CGPoint, rx rx0: CGFloat, ry ry0: CGFloat, rotation: CGFloat,
    large: Bool,
    sweep: Bool
  ) {
    var rx = abs(rx0)
    var ry = abs(ry0)
    if rx == 0 || ry == 0 || a == b {
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
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
    if lambda > 1 {
      rx *= sqrt(lambda)
      ry *= sqrt(lambda)
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
      let d = (ux * vx + uy * vy) / (sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy))
      let s: CGFloat = ux * vy - uy * vx < 0 ? -1 : 1
      return s * acos(min(1, max(-1, d)))
    }
    let t1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
    var dt = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
    if !sweep && dt > 0 { dt -= 2 * .pi }
    if sweep && dt < 0 { dt += 2 * .pi }
    let segs = Int(ceil(abs(dt) / (.pi / 2)))
    let step = dt / CGFloat(segs)
    let kappa = 4 / 3 * tan(step / 4)
    var t = t1
    func point(_ t: CGFloat) -> CGPoint {
      CGPoint(x: cx + rx * cos(t) * cosP - ry * sin(t) * sinP, y: cy + rx * cos(t) * sinP + ry * sin(t) * cosP)
    }
    func deriv(_ t: CGFloat) -> CGPoint {
      CGPoint(x: -rx * sin(t) * cosP - ry * cos(t) * sinP, y: -rx * sin(t) * sinP + ry * cos(t) * cosP)
    }
    for _ in 0..<segs {
      let p0 = point(t)
      let p3 = point(t + step)
      let d0 = deriv(t)
      let d3 = deriv(t + step)
      p.addCurve(
        to: p3, control1: CGPoint(x: p0.x + kappa * d0.x, y: p0.y + kappa * d0.y),
        control2: CGPoint(x: p3.x - kappa * d3.x, y: p3.y - kappa * d3.y))
      t += step
    }
  }

  /// numbers and flags of path data, as SVG writes them (1.5e-3, -.5.5, 0 1 run together)
  struct Scanner {
    let u: [UInt8]
    var i = 0
    init(_ s: String) { u = Array(s.utf8) }
    var peek: Character? { i < u.count ? Character(UnicodeScalar(u[i])) : nil }
    mutating func advance() { i += 1 }
    mutating func skipSeparators() {
      while i < u.count, u[i] == 0x20 || u[i] == 0x2C || u[i] == 0x0A || u[i] == 0x09 || u[i] == 0x0D { i += 1 }
    }
    mutating func flag() -> Bool? {
      skipSeparators()
      guard i < u.count, u[i] == 0x30 || u[i] == 0x31 else { return nil }
      defer { i += 1 }
      return u[i] == 0x31
    }
    mutating func number() -> CGFloat? {
      skipSeparators()
      let start = i
      if i < u.count, u[i] == 0x2B || u[i] == 0x2D { i += 1 }
      var dot = false
      var digits = false
      while i < u.count {
        let c = u[i]
        if c >= 0x30 && c <= 0x39 {
          digits = true
          i += 1
        } else if c == 0x2E && !dot {
          dot = true
          i += 1
        } else {
          break
        }
      }
      if digits, i < u.count, u[i] == 0x65 || u[i] == 0x45 {
        var j = i + 1
        if j < u.count, u[j] == 0x2B || u[j] == 0x2D { j += 1 }
        if j < u.count, u[j] >= 0x30, u[j] <= 0x39 {
          i = j
          while i < u.count, u[i] >= 0x30, u[i] <= 0x39 { i += 1 }
        }
      }
      guard digits, let v = Double(String(decoding: u[start..<i], as: UTF8.self)) else {
        i = start
        return nil
      }
      return CGFloat(v)
    }
  }
}

import CoreGraphics
import CoreText
import Foundation

/// A [[reference]] as the web editor draws it (markdown.css .md-ref): an inline block 1.32em tall with a line along its
/// bottom; before the title an arrow, or the target's seal, or ⚠ when its place is gone; after it a badge
final class RefBox: @unchecked Sendable {
  enum Mark {
    case arrow
    case warn
    case seal(MarkdownSeal, CTLine, color: MDColor, size: CGSize, outer: Outer?)
  }
  /// a two-part seal's first half: its letters in its colour, and how wide that half is
  struct Outer {
    let line: CTLine
    let color: MDColor
    let width: CGFloat
  }
  let mark: Mark
  let title: CTLine?
  let badge: CTLine?
  let color: MDColor
  let lineColor: MDColor?
  /// its line turns solid in the link colour under the pointer (.md-ref:hover): a reference that finds its target
  let solidOnHover: Bool
  let strike: MDColor?
  /// the badge struck through (the place it names is gone: .md-ref.gone > .bd)
  let badgeStruck: Bool
  let fontSize: CGFloat
  let width: CGFloat
  let ascent: CGFloat
  let descent: CGFloat
  /// the x of the title and the badge inside the box, and the mark's width
  let titleX: CGFloat
  let badgeX: CGFloat
  let surface: MDColor
  /// what it was written as, and whether it found what it names (a host takes a press on it: not .missing, not .gone)
  let label: String
  let target: String?
  let found: Bool

  init(label: String, target: String? = nil, hit: MarkdownRefHit?, style: InlineStyle, theme: MarkdownTheme) {
    self.label = label
    self.target = target
    if case .found = hit { found = true } else { found = false }
    let c = theme.colors
    let size = style.size
    fontSize = size
    surface = c.surface
    var color = c.link
    var line: MDColor? = c.link.alpha(0.34)
    var strike: MDColor?
    var text = label
    var badgeText: String?
    var mark = Mark.arrow
    switch hit {
    case .found(let title, let seal):
      text = title
      if let seal {
        let fs = size * 0.72
        let f = FontBook.font(theme.fonts.body, size: fs, weight: 600)
        func letters(_ s: String, _ color: MDColor) -> CTLine {
          CTLineCreateWithAttributedString(
            NSAttributedString(
              string: s,
              attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): f,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): color.cg,
              ]))
        }
        let l = letters(seal.text, c.surface)
        let tw = CGFloat(CTLineGetTypographicBounds(l, nil, nil, nil))
        let h = 1.36 * fs
        let sc = theme.marks.seals[seal.color] ?? c.accent
        // two halves pad their letters 0.4em each and leave the box's own padding out (.md-seal.two > span)
        let outer = seal.outer.map { o in
          let oc = theme.marks.seals[o.color] ?? c.accent
          let ol = letters(o.text, oc)
          return Outer(line: ol, color: oc, width: CGFloat(CTLineGetTypographicBounds(ol, nil, nil, nil)) + 0.8 * fs)
        }
        let w = outer.map { $0.width + tw + 0.8 * fs } ?? max(h, tw + 2 * 0.34 * fs)
        mark = .seal(seal, l, color: sc, size: CGSize(width: w, height: h), outer: outer)
        if seal.alone { line = nil }
      }
    case .broken(let place, let title, let badge):
      text = title.isEmpty ? label : title
      badgeText = badge
      if place {
        color = c.warn
        line = c.warn.alpha(0.45)
        mark = .warn
      } else {
        color = c.ink3
        line = c.hair
        strike = c.ink3.alpha(0.5)
      }
    case nil:
      color = c.ink3
      line = c.hair
      strike = c.ink3.alpha(0.5)
    }
    self.color = color
    lineColor = line
    if case .found = hit { solidOnHover = line != nil } else { solidOnHover = false }
    self.strike = strike
    if case .broken(true, _, _) = hit { badgeStruck = true } else { badgeStruck = false }
    self.mark = mark
    let font = FontBook.font(style.families, size: size, weight: style.weight, italic: style.italic)
    let attrs: [NSAttributedString.Key: Any] = [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): color.cg,
    ]
    let alone = {
      if case .seal(let s, _, _, _, _) = mark { return s.alone }
      return false
    }()
    title = alone ? nil : CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
    badge = badgeText.map { b in
      let f = FontBook.font(style.families, size: size * 0.74, weight: style.weight)
      return CTLineCreateWithAttributedString(
        NSAttributedString(
          string: "· " + b,
          attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): f,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color.alpha(0.62).cg,
          ]))
    }
    // margin 2, padding 1 (none around a lone seal), then the mark, the title, the badge
    let edge: CGFloat = alone ? 2 : 3
    var x = edge
    switch mark {
    case .arrow: x += 0.9 * size + 0.28 * size
    case .warn:
      let w = CTLineCreateWithAttributedString(NSAttributedString(string: "⚠ ", attributes: attrs))
      x += CGFloat(CTLineGetTypographicBounds(w, nil, nil, nil))
    case .seal(_, _, _, let s, _): x += s.width + (alone ? 0 : 0.4 * size)
    }
    titleX = x
    if let t = title { x += CGFloat(CTLineGetTypographicBounds(t, nil, nil, nil)) }
    badgeX = x + 4
    if let b = badge { x += 4 + CGFloat(CTLineGetTypographicBounds(b, nil, nil, nil)) }
    width = x + edge
    let lh = 1.32 * size
    ascent = FontBook.baseline(font, lineHeight: lh)
    descent = lh - ascent
  }

  /// draws the box with its baseline starting at `o`
  func draw(at o: CGPoint, _ ctx: CGContext) {
    let alone = {
      if case .seal(let s, _, _, _, _) = mark { return s.alone }
      return false
    }()
    let edge: CGFloat = alone ? 2 : 3
    if let lc = lineColor {
      ctx.setFillColor(lc.cg)
      ctx.fill(CGRect(x: o.x + 2, y: o.y + descent - 1, width: width - 4, height: 1))
    }
    let size = fontSize
    switch mark {
    case .arrow:
      // a 1.5 wide arrow drawn on a 16 grid, 0.9em square, 0.08em below the baseline, at 75 % of the text colour
      let s = 0.9 * size / 16
      ctx.saveGState()
      ctx.translateBy(x: o.x + edge, y: o.y + 0.08 * size - 0.9 * size)
      ctx.scaleBy(x: s, y: s)
      ctx.setStrokeColor(color.alpha(0.75).cg)
      ctx.setLineWidth(1.5)
      ctx.setLineCap(.round)
      ctx.setLineJoin(.round)
      ctx.move(to: CGPoint(x: 5, y: 11))
      ctx.addLine(to: CGPoint(x: 11, y: 5))
      ctx.move(to: CGPoint(x: 6, y: 5))
      ctx.addLine(to: CGPoint(x: 11, y: 5))
      ctx.addLine(to: CGPoint(x: 11, y: 10))
      ctx.strokePath()
      ctx.restoreGState()
    case .warn:
      let f = CTLineCreateWithAttributedString(
        NSAttributedString(
          string: "⚠",
          attributes: [NSAttributedString.Key(kCTForegroundColorAttributeName as String): color.alpha(0.9).cg]))
      line(f, CGPoint(x: o.x + edge, y: o.y), ctx)
    case .seal(_, let l, let c, let s, let outer):
      // raised .12em, centred on the cap height
      let r = CGRect(x: o.x + edge, y: o.y - 0.12 * size * 0.72 - s.height * 0.78, width: s.width, height: s.height)
      let rounded = CGPath(roundedRect: r, cornerWidth: 3, cornerHeight: 3, transform: nil)
      var own = r
      if let ou = outer {
        // the first half: its letters in its colour on a 13 % tint, the whole seal ringed in it (an inset shadow, which
        // the second half's fill covers)
        ctx.saveGState()
        ctx.addPath(rounded)
        ctx.clip()
        ctx.setFillColor(ou.color.alpha(0.13).cg)
        ctx.fill(r)
        ctx.setStrokeColor(ou.color.cg)
        ctx.setLineWidth(2)
        ctx.addPath(rounded)
        ctx.strokePath()
        own = CGRect(x: r.minX + ou.width, y: r.minY, width: r.width - ou.width, height: r.height)
        ctx.setFillColor(c.cg)
        ctx.fill(own)
        ctx.restoreGState()
        sealLetters(ou.line, in: CGRect(x: r.minX, y: r.minY, width: ou.width, height: r.height), ctx)
      } else {
        ctx.setFillColor(c.cg)
        ctx.addPath(rounded)
        ctx.fillPath()
      }
      sealLetters(l, in: own, ctx)
    }
    if let t = title {
      line(t, CGPoint(x: o.x + titleX, y: o.y), ctx)
      if let st = strike {
        let w = CGFloat(CTLineGetTypographicBounds(t, nil, nil, nil))
        ctx.setStrokeColor(st.cg)
        ctx.setLineWidth(1)
        let y = o.y - size * 0.28
        ctx.move(to: CGPoint(x: o.x + titleX, y: y))
        ctx.addLine(to: CGPoint(x: o.x + titleX + w, y: y))
        ctx.strokePath()
      }
    }
    if let b = badge {
      line(b, CGPoint(x: o.x + badgeX, y: o.y), ctx)
      if badgeStruck {
        let w = CGFloat(CTLineGetTypographicBounds(b, nil, nil, nil))
        ctx.setStrokeColor(color.alpha(0.62).cg)
        ctx.setLineWidth(1)
        let y = o.y - size * 0.74 * 0.28
        ctx.move(to: CGPoint(x: o.x + badgeX, y: y))
        ctx.addLine(to: CGPoint(x: o.x + badgeX + w, y: y))
        ctx.strokePath()
      }
    }
  }

  /// a seal's letters centred in `r` on their cap height, a little low (.md-seal-t: trim to cap and alphabetic, .03em down)
  private func sealLetters(_ l: CTLine, in r: CGRect, _ ctx: CGContext) {
    let tw = CGFloat(CTLineGetTypographicBounds(l, nil, nil, nil))
    let font =
      (CTRunGetAttributes((CTLineGetGlyphRuns(l) as! [CTRun])[0]) as NSDictionary)[kCTFontAttributeName] as! CTFont
    let cap = CTFontGetCapHeight(font)
    line(l, CGPoint(x: r.midX - tw / 2, y: r.midY + cap / 2 + 0.03 * fontSize * 0.72), ctx)
  }

  private func line(_ l: CTLine, _ at: CGPoint, _ ctx: CGContext) {
    ctx.saveGState()
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    ctx.textPosition = at
    CTLineDraw(l, ctx)
    ctx.restoreGState()
  }
}

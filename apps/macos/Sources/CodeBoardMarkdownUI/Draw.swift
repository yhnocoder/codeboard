import CoreGraphics
import CoreText
import Foundation

extension MarkdownLayout {
  /// Draws into ctx. ctx's user space is the layout's own (points, y growing downwards, the layout's top left at 0,0);
  /// `scale` is how many device pixels a point is there; only what meets `clip` is drawn. `image` gives the decoded
  /// picture for a slot (nil leaves it empty): nothing is decoded or read here. Safe on any thread.
  public func draw(in ctx: CGContext, scale: CGFloat, clip: CGRect, image: (MarkdownImageSlot) -> CGImage?) {
    ctx.saveGState()
    defer { ctx.restoreGState() }
    // glyph positions stay the same at every scale (experiment 1): no snapping glyph origins to device pixels
    ctx.setShouldSubpixelQuantizeFonts(false)
    ctx.setAllowsFontSubpixelQuantization(false)
    // no stem darkening: the Note page's text is not smoothed either, and smoothed text reads a weight heavier
    ctx.setShouldSmoothFonts(false)
    ctx.clip(to: clip)
    draw(items, ctx, clip, image)
  }

  private func draw(_ list: [Item], _ ctx: CGContext, _ clip: CGRect, _ image: (MarkdownImageSlot) -> CGImage?) {
    for item in list where item.bounds.intersects(clip) {
      switch item {
      case .text(let t): drawText(t, ctx, clip)
      case .fill(let r, let radius, let c):
        ctx.setFillColor(c.cg)
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil))
        ctx.fillPath()
      case .stroke(let r, let radius, let c, let w):
        ctx.setStrokeColor(c.cg)
        ctx.setLineWidth(w)
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil))
        ctx.strokePath()
      case .line(let a, let b, let c, let w):
        ctx.setStrokeColor(c.cg)
        ctx.setLineWidth(w)
        ctx.move(to: a)
        ctx.addLine(to: b)
        ctx.strokePath()
      case .header(let r, let radius, let c):
        // only the top corners are round: the frame's
        let p = CGMutablePath()
        p.move(to: CGPoint(x: r.minX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.minY + radius))
        p.addArc(
          tangent1End: CGPoint(x: r.minX, y: r.minY), tangent2End: CGPoint(x: r.minX + radius, y: r.minY),
          radius: radius)
        p.addLine(to: CGPoint(x: r.maxX - radius, y: r.minY))
        p.addArc(
          tangent1End: CGPoint(x: r.maxX, y: r.minY), tangent2End: CGPoint(x: r.maxX, y: r.minY + radius),
          radius: radius)
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
        p.closeSubpath()
        ctx.setFillColor(c.cg)
        ctx.addPath(p)
        ctx.fillPath()
      case .checkbox(let r, let checked, let radius):
        drawCheckbox(r, checked, radius, ctx)
      case .clip(let r, let inner):
        ctx.saveGState()
        ctx.clip(to: r)
        draw(inner, ctx, clip.intersection(r), image)
        ctx.restoreGState()
      case .image(let slot):
        drawImage(slot, image(slot), ctx)
      case .figure(let f, let r):
        if f.broken != nil {
          f.drawBroken(r, ink3: theme.colors.ink3, hair: theme.colors.hair, ctx)
        } else if let cap = f.caption {
          cap.draw(at: CGPoint(x: r.minX + f.captionX, y: r.minY + f.captionTop), ctx)
        }
      case .annot(let box, let o):
        box.draw(at: o, ctx)
      case .diagram(let paths, let texts, let r):
        ctx.saveGState()
        ctx.translateBy(x: r.minX, y: r.minY)
        SVGShapes.draw(paths, texts, ctx, scale: 1, ink: theme.colors.ink, theme: theme)
        ctx.restoreGState()
      case .ref(let box, let o):
        box.draw(at: o, ctx)
      case .bullet(let r, let kind, let c):
        switch kind {
        case 0:
          ctx.setFillColor(c.cg)
          ctx.fillEllipse(in: r)
        case 1:
          ctx.setStrokeColor(c.cg)
          ctx.setLineWidth(1)
          ctx.strokeEllipse(in: r.insetBy(dx: 0.5, dy: 0.5))
        default:
          ctx.setFillColor(c.cg)
          ctx.fill(r)
        }
      case .math(let pic, let size, let origin, let color):
        drawMath(pic, size: size, origin: origin, color: color, ctx)
      }
    }
  }

  private func drawCheckbox(_ r: CGRect, _ checked: Bool, _ radius: CGFloat, _ ctx: CGContext) {
    let c = theme.colors
    let path = CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)
    if checked {
      ctx.setFillColor(c.accent.cg)
      ctx.addPath(path)
      ctx.fillPath()
      // the tick: a 6×3 corner turned -45°, 1.5 wide (markdown.css input:checked::after)
      ctx.saveGState()
      ctx.translateBy(x: r.midX, y: r.midY - 1)
      ctx.rotate(by: -.pi / 4)
      ctx.setStrokeColor(c.accentInk.cg)
      ctx.setLineWidth(1.5)
      ctx.move(to: CGPoint(x: -3, y: -1.5))
      ctx.addLine(to: CGPoint(x: -3, y: 1.5))
      ctx.addLine(to: CGPoint(x: 3, y: 1.5))
      ctx.strokePath()
      ctx.restoreGState()
    } else {
      ctx.setFillColor(c.surface.cg)
      ctx.addPath(path)
      ctx.fillPath()
      // an inset ring 1.25 wide
      ctx.setStrokeColor(c.ink3.cg)
      ctx.setLineWidth(1.25)
      ctx.addPath(
        CGPath(
          roundedRect: r.insetBy(dx: 0.625, dy: 0.625), cornerWidth: radius - 0.6, cornerHeight: radius - 0.6,
          transform: nil))
      ctx.strokePath()
    }
  }

  private func drawImage(_ slot: MarkdownImageSlot, _ img: CGImage?, _ ctx: CGContext) {
    let r = slot.frame
    let radius = CGFloat(theme.metrics.imageRadius)
    ctx.saveGState()
    ctx.addPath(CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil))
    ctx.clip()
    if let img {
      // CGContext draws images y up: flip around the slot
      ctx.translateBy(x: r.minX, y: r.maxY)
      ctx.scaleBy(x: 1, y: -1)
      ctx.interpolationQuality = .high
      ctx.draw(img, in: CGRect(origin: .zero, size: r.size))
    } else if slot.broken {
      ctx.setFillColor(theme.colors.fill.cg)
      ctx.fill(r)
    }
    ctx.restoreGState()
  }

  private func drawMath(_ pic: MathPicture, size: CGFloat, origin: CGPoint, color: MDColor, _ ctx: CGContext) {
    ctx.saveGState()
    // the picture is in em with its baseline at `baseline` from the top
    ctx.translateBy(x: origin.x, y: origin.y - CGFloat(pic.baseline) * size)
    SVGShapes.draw(pic.paths, pic.texts, ctx, scale: size, ink: color, theme: theme, textFont: mathTextFont)
    ctx.restoreGState()
  }

  private func drawText(_ t: TextBlock, _ ctx: CGContext, _ clip: CGRect) {
    for l in t.lines where l.top < clip.maxY && l.top + l.height > clip.minY {
      decorations(l, ctx, under: true)
      ctx.saveGState()
      ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
      ctx.textPosition = l.origin
      CTLineDraw(l.line, ctx)
      ctx.restoreGState()
      decorations(l, ctx, under: false)
    }
  }

  /// what CoreText does not draw: inline code and kbd boxes and highlights under the text, strike lines over it
  private func decorations(_ l: TextBlock.Line, _ ctx: CGContext, under: Bool) {
    var boxes: [Int: (CGFloat, CGFloat, InlineBox, CTFont)] = [:]
    for run in CTLineGetGlyphRuns(l.line) as! [CTRun] {
      let attrs = CTRunGetAttributes(run) as NSDictionary
      let r = CTRunGetStringRange(run)
      let x0 = l.origin.x + CTLineGetOffsetForStringIndex(l.line, r.location, nil)
      let x1 = l.origin.x + CTLineGetOffsetForStringIndex(l.line, r.location + r.length, nil)
      let font = attrs[kCTFontAttributeName] as! CTFont
      let a = CTFontGetAscent(font)
      let d = CTFontGetDescent(font)
      if under {
        if let id = attrs[Attr.boxID] as? Int, let box = attrs[Attr.box] as? InlineBox {
          let was = boxes[id]
          boxes[id] = (min(was?.0 ?? x0, x0), max(was?.1 ?? x1, x1), box, was?.3 ?? font)
        }
        if let c = attrs[Attr.highlight] as? MDColor {
          let size = CTFontGetSize(font)
          let top = l.origin.y - a
          let h = a + d + 0.12 * size
          switch theme.marks.highlightStyle {
          case .band:
            // the lower 42 % of the text box and .12em below it (markdown.css mark)
            ctx.setFillColor(c.cg)
            ctx.fill(
              CGRect(
                x: x0, y: top + h * CGFloat(theme.metrics.highlightFrom), width: x1 - x0,
                height: h * (1 - CGFloat(theme.metrics.highlightFrom))))
          case .brush(let em):
            brush(CGRect(x: x0, y: top + h - CGFloat(em) * size, width: x1 - x0, height: CGFloat(em) * size), c, ctx)
          }
        }
      } else {
        if let c = attrs[Attr.underline] as? MDColor {
          let y = l.origin.y + CGFloat(theme.metrics.linkUnderlineOffset) + 0.5
          ctx.setStrokeColor(c.cg)
          ctx.setLineWidth(1)
          ctx.move(to: CGPoint(x: x0, y: y))
          ctx.addLine(to: CGPoint(x: x1, y: y))
          ctx.strokePath()
        }
        guard let c = attrs[Attr.strike] as? MDColor else { continue }
        let y = l.origin.y - CTFontGetXHeight(font) / 2
        ctx.setStrokeColor(c.cg)
        ctx.setLineWidth(max(1, CTFontGetUnderlineThickness(font)))
        ctx.move(to: CGPoint(x: x0, y: y))
        ctx.addLine(to: CGPoint(x: x1, y: y))
        ctx.strokePath()
      }
    }
    for (_, (x0, x1, box, font)) in boxes {
      let r = CGRect(
        x: x0, y: l.origin.y - CTFontGetAscent(font), width: x1 - x0,
        height: CTFontGetAscent(font) + CTFontGetDescent(font))
      let p = CGPath(roundedRect: r, cornerWidth: box.radius, cornerHeight: box.radius, transform: nil)
      if let f = box.fill {
        ctx.setFillColor(f.cg)
        ctx.addPath(p)
        ctx.fillPath()
      }
      if let s = box.stroke {
        ctx.setStrokeColor(s.cg)
        ctx.setLineWidth(0.5)
        ctx.addPath(
          CGPath(
            roundedRect: r.insetBy(dx: 0.25, dy: 0.25), cornerWidth: box.radius, cornerHeight: box.radius,
            transform: nil))
        ctx.strokePath()
        // kbd's key shadow: a line along the bottom
        ctx.setFillColor(s.cg)
        ctx.fill(CGRect(x: r.minX + box.radius / 2, y: r.maxY, width: r.width - box.radius, height: 1))
      }
    }
  }

  /// Ink Wash's highlight: a thin vermilion stroke of uneven weight along the bottom of the box, thicker in the middle,
  /// its ends tapered (themes.css --hl-brush)
  private func brush(_ r: CGRect, _ c: MDColor, _ ctx: CGContext) {
    guard r.width > 1 else { return }
    let t = r.height * 0.32
    let mid = r.maxY - r.height * 0.42
    let p = CGMutablePath()
    p.move(to: CGPoint(x: r.minX, y: mid))
    p.addCurve(
      to: CGPoint(x: r.maxX, y: mid - t * 0.2), control1: CGPoint(x: r.minX + r.width * 0.3, y: mid - t * 0.6),
      control2: CGPoint(x: r.minX + r.width * 0.7, y: mid - t * 0.5))
    p.addCurve(
      to: CGPoint(x: r.minX, y: mid), control1: CGPoint(x: r.minX + r.width * 0.7, y: mid + t * 0.6),
      control2: CGPoint(x: r.minX + r.width * 0.3, y: mid + t * 0.7))
    p.closeSubpath()
    ctx.setFillColor(c.cg)
    ctx.addPath(p)
    ctx.fillPath()
  }

  /// Where a point lands: a link, a reference, a task box, an image, or the source offset of the nearest character
  public func hit(_ point: CGPoint) -> MarkdownHit {
    var best: (TextBlock, TextBlock.Line)?
    var bestD = CGFloat.infinity
    func scan(_ list: [Item]) {
      for item in list {
        switch item {
        case .image(let s) where s.frame.contains(point): bestD = -1
        case .text(let t):
          for l in t.lines {
            let d = point.y < l.top ? l.top - point.y : point.y > l.top + l.height ? point.y - l.top - l.height : 0
            let dx =
              point.x < t.frame.minX ? t.frame.minX - point.x : point.x > t.frame.maxX ? point.x - t.frame.maxX : 0
            if d * 1000 + dx < bestD {
              bestD = d * 1000 + dx
              best = (t, l)
            }
          }
        case .clip(_, let inner): scan(inner)
        default: break
        }
      }
    }
    for item in items {
      if case .image(let s) = item, s.frame.contains(point) { return .image(src: s.src, nth: s.nth) }
    }
    var task = 0
    for item in items {
      if case .checkbox(let r, _, _) = item {
        if r.insetBy(dx: -3, dy: -3).contains(point) { return .task(nth: task) }
        task += 1
      }
    }
    scan(items)
    guard let (t, l) = best else { return .text(offset: 0) }
    var i = CTLineGetStringIndexForPosition(l.line, CGPoint(x: point.x - l.origin.x, y: 0))
    if i == kCFNotFound { i = l.range.location }
    i = min(max(i, l.range.location), l.range.location + l.range.length)
    if let link = t.display.links.first(where: { NSLocationInRange(i, $0.0) }) { return .link(url: link.1) }
    if let ref = t.display.refs.first(where: { NSLocationInRange(i, $0.0) }) {
      return .ref(label: ref.1, target: ref.2)
    }
    let map = t.display.toSource
    return .text(offset: i < map.count ? map[i] : t.display.endSource)
  }
}

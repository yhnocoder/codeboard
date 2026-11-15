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
    // no stem darkening: the web board's text is not smoothed either, and smoothed text reads a weight heavier
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
          // with its formulas, references and marks, as body text (drawn as bare lines a formula left a gap)
          drawText(cap, at: CGPoint(x: r.minX + f.captionX, y: r.minY + f.captionTop), ctx)
        }
      case .annot(let box, let o):
        drawAnnot(box, o, ctx)
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
      decorations(l.line, l.origin, ctx, under: true)
      drawLine(l.line, at: l.origin, ctx)
      decorations(l.line, l.origin, ctx, under: false)
    }
  }

  /// {text|note}: its tint, then its text drawn as body text is (highlights, code boxes, strike and link lines, references
  /// and formulas), then the note and arrow
  private func drawAnnot(_ box: AnnotBox, _ o: CGPoint, _ ctx: CGContext) {
    box.drawTint(at: o, ctx)
    drawText(box.text, at: box.textOrigin(at: o), ctx)
    box.drawNote(at: o, ctx)
  }

  /// lines set in a box (an annotated phrase, a caption) as body text is drawn: marks and code boxes under the glyphs,
  /// strike and link lines over them, references and formulas in their places
  private func drawText(_ text: BoxText, at t: CGPoint, _ ctx: CGContext) {
    for l in text.lines {
      let origin = CGPoint(x: t.x + l.origin.x, y: t.y + l.origin.y)
      decorations(l.line, origin, ctx, under: true)
      drawLine(l.line, at: origin, ctx)
      decorations(l.line, origin, ctx, under: false)
      for run in CTLineGetGlyphRuns(l.line) as! [CTRun] {
        let attrs = CTRunGetAttributes(run) as NSDictionary
        guard let a = attrs[Attr.atom] as? AtomBox else { continue }
        let x = origin.x + CTLineGetOffsetForStringIndex(l.line, CTRunGetStringRange(run).location, nil)
        switch a.content {
        case .ref(let r): r.draw(at: CGPoint(x: x, y: origin.y), ctx)
        case .math(let pic, let size):
          let color = LayoutBuilder.mdColor(attrs[kCTForegroundColorAttributeName] as! CGColor)
          drawMath(pic, size: size, origin: CGPoint(x: x, y: origin.y), color: color, ctx)
        case .image, .annot, .spacer: break
        }
      }
    }
  }

  /// what CoreText does not draw: inline code and kbd boxes and highlights under the text, strike lines over it
  private func decorations(_ line: CTLine, _ origin: CGPoint, _ ctx: CGContext, under: Bool) {
    let spans = Self.decorationSpans(line, under: under)
    // boxes last: a code span's background lies over the highlight around it, as the inner element's does on the page
    for (kind, s) in spans.filter({ $0.1.box == nil }) + spans.filter({ $0.1.box != nil }) {
      let font = s.face
      // an inline element's background covers its font's ascent and descent each rounded to whole points, as Blink
      // measures a font (SimpleFontData): JetBrains Mono at 11 is 11 + 3 tall there, not 11.2 + 3.3
      let a = CTFontGetAscent(font).rounded()
      let d = CTFontGetDescent(font).rounded()
      let size = CTFontGetSize(font)
      let x0 = origin.x + s.x0
      let x1 = origin.x + s.x1
      switch kind {
      case .highlight(let c):
        // the mark's box: its font's ascent and descent and .12em below (markdown.css mark)
        let top = origin.y - a
        let h = a + d + 0.12 * size
        switch theme.marks.highlightStyle {
        case .band:
          ctx.setFillColor(c.cg)
          ctx.fill(
            CGRect(
              x: x0, y: top + h * CGFloat(theme.metrics.highlightFrom), width: x1 - x0,
              height: h * (1 - CGFloat(theme.metrics.highlightFrom))))
        case .brush(let em):
          brush(CGRect(x: x0, y: top + h - CGFloat(em) * size, width: x1 - x0, height: CGFloat(em) * size), c, ctx)
        }
      case .underline(let c):
        let y = origin.y + CGFloat(theme.metrics.linkUnderlineOffset) + 0.5
        ctx.setStrokeColor(c.cg)
        ctx.setLineWidth(1)
        ctx.move(to: CGPoint(x: x0, y: y))
        ctx.addLine(to: CGPoint(x: x1, y: y))
        ctx.strokePath()
      case .strike(let c):
        let y = origin.y - CTFontGetXHeight(font) / 2
        ctx.setStrokeColor(c.cg)
        ctx.setLineWidth(max(1, CTFontGetUnderlineThickness(font)))
        ctx.move(to: CGPoint(x: x0, y: y))
        ctx.addLine(to: CGPoint(x: x1, y: y))
        ctx.strokePath()
      case .box:
        guard let box = s.box else { continue }
        let r = CGRect(x: x0, y: origin.y - a, width: x1 - x0, height: a + d)
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
  }

  private enum Decoration: Hashable {
    case highlight(MDColor)
    case underline(MDColor)
    case strike(MDColor)
    /// an inline code or kbd box, by its id
    case box(Int)
  }

  private struct DecorationSpan {
    var x0: CGFloat, x1: CGFloat
    var face: CTFont
    /// the face is the text's own, not an inline box's that the span started on
    var settled: Bool
    /// where the next run must start to carry on this span
    var end: Int
    var box: InlineBox?
  }

  /// One span per decoration and stretch of text on a line, however many runs the typesetter cut it into (each script
  /// falls back to its own font, an atom is a run of its own): a highlight or line drawn per run breaks up at each one,
  /// as the page's never does. Boxes join by their id, the rest while their runs follow on with the same colour; the
  /// span is placed by the style's own font, never a fallback's, so it keeps one height along the line.
  private static func decorationSpans(_ line: CTLine, under: Bool) -> [(Decoration, DecorationSpan)] {
    var out: [(Decoration, DecorationSpan)] = []
    var open: [Decoration: Int] = [:]
    for run in CTLineGetGlyphRuns(line) as! [CTRun] {
      let attrs = CTRunGetAttributes(run) as NSDictionary
      let r = CTRunGetStringRange(run)
      guard r.length > 0 else { continue }
      let x0 = CTLineGetOffsetForStringIndex(line, r.location, nil)
      let x1 = CTLineGetOffsetForStringIndex(line, r.location + r.length, nil)
      let face = (attrs[Attr.face] ?? attrs[kCTFontAttributeName]) as! CTFont
      let box = attrs[Attr.box] as? InlineBox
      var kinds: [Decoration] = []
      if under {
        if let id = attrs[Attr.boxID] as? Int, box != nil { kinds.append(.box(id)) }
        if let c = attrs[Attr.highlight] as? MDColor { kinds.append(.highlight(c)) }
      } else {
        if let c = attrs[Attr.underline] as? MDColor { kinds.append(.underline(c)) }
        if let c = attrs[Attr.strike] as? MDColor { kinds.append(.strike(c)) }
      }
      for k in kinds {
        let isBox = if case .box = k { true } else { false }
        if let i = open[k], isBox || out[i].1.end == r.location {
          out[i].1.x0 = min(out[i].1.x0, x0, x1)
          out[i].1.x1 = max(out[i].1.x1, x0, x1)
          out[i].1.end = r.location + r.length
          // a highlight or strike that starts on a code span sits by the text around it
          if !out[i].1.settled, box == nil {
            out[i].1.face = face
            out[i].1.settled = true
          }
        } else {
          open[k] = out.count
          let span = DecorationSpan(
            x0: min(x0, x1), x1: max(x0, x1), face: face, settled: isBox || box == nil, end: r.location + r.length,
            box: isBox ? box : nil)
          out.append((k, span))
        }
      }
    }
    return out
  }

  /// Ink Wash's highlight: a thin vermilion stroke of uneven weight, its ends tapered, stretched over the box
  /// (themes.css --hl-brush: this path on a 120 × 8 grid)
  private func brush(_ r: CGRect, _ c: MDColor, _ ctx: CGContext) {
    guard r.width > 1 else { return }
    ctx.saveGState()
    ctx.translateBy(x: r.minX, y: r.minY)
    ctx.scaleBy(x: r.width / 120, y: r.height / 8)
    ctx.setFillColor(c.cg)
    ctx.addPath(SVGShapes.path(Self.brushPath))
    ctx.fillPath()
    ctx.restoreGState()
  }
  static let brushPath = "M1 5.2C18 3.6 34 4.6 52 4.1S88 3.2 119 4.4L118.6 5.6C96 6.2 72 5.4 54 6.1S20 6.8 1.4 6.4Z"

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

/// A line of text at `origin` (its baseline's left) in a y-down context. A synthetic oblique (FontBook.slant) is in its
/// font's matrix, which CTLineDraw leaves out: a line with one is drawn run by run, those with the skew in the text
/// matrix
func drawLine(_ line: CTLine, at origin: CGPoint, _ ctx: CGContext) {
  ctx.saveGState()
  defer { ctx.restoreGState() }
  ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
  ctx.textPosition = origin
  let runs = CTLineGetGlyphRuns(line) as! [CTRun]
  let slant = runs.map { run -> CGFloat in
    let f = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
    return CTFontGetMatrix(f).c
  }
  guard slant.contains(where: { $0 != 0 }) else { return CTLineDraw(line, ctx) }
  for (run, c) in zip(runs, slant) {
    ctx.textMatrix = CGAffineTransform(a: 1, b: 0, c: c, d: -1, tx: 0, ty: 0)
    ctx.textPosition = origin
    CTRunDraw(run, ctx, CFRange())
  }
}

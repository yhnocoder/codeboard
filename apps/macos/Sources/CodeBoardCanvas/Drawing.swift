import CodeBoardModel
import CoreText
import IOSurface

/// What one item's bitmap shows. Drawn off the main thread at any scale: a producer gets the item's size, a scale and
/// the theme and draws into a context. Note content will be another producer (the web renderer's snapshot).
enum Drawing: Sendable {
  case code(Code)
  case note(Note)
  case image(Picture)
  case label(Label)

  struct Code: Sendable {
    var title: String
    var path: String?
    var layout: CodeLayout
    var framed: Bool
  }

  struct Note: Sendable {
    var title: String
    var style: NoteStyle
  }

  struct Picture: Sendable {
    /// nil: not drawable here (a web address, or a missing file)
    var url: URL?
    var fileSize: CGSize
    var frame: Int
    var framed: Bool
  }

  struct Label: Sendable {
    var text: String
    /// An arrow's label sits on a paper box; a section's title is bare
    var boxed: Bool
  }

  var framed: Bool {
    switch self {
    case .code(let c): c.framed
    case .note(let n): n.style == .note
    case .image(let p): p.framed
    case .label: false
    }
  }

  /// Draws the item in board units, y-down from its top-left. Returns how many pictures had to be decoded
  func draw(in ctx: CGContext, size: CGSize, scale: CGFloat, theme t: Theme, images: DecodeCache) -> Int {
    let r = CGRect(origin: .zero, size: size)
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    var decodes = 0
    switch self {
    case .code(let c):
      if c.framed { Drawing.paper(ctx, r, t, headerLine: false) }
      Drawing.code(ctx, c, r, t)
      if c.framed { Drawing.edge(ctx, r, t) }
    case .note(let n):
      switch n.style {
      case .note:
        Drawing.paper(ctx, r, t, headerLine: true)
        Drawing.text(ctx, n.title, t.noteTitle.ct, t.ink, x: 10, midY: t.headerHeight / 2, width: size.width - 20)
        Drawing.edge(ctx, r, t)
      case .box(let fill):
        let p = Drawing.squircle(r.insetBy(dx: 0.625, dy: 0.625), t.cardRadius)
        ctx.addPath(p)
        ctx.setFillColor(t.boxFills[fill] ?? t.surface)
        ctx.fillPath()
        ctx.addPath(p)
        ctx.setStrokeColor(t.boxEdge)
        ctx.setLineWidth(1.25)
        ctx.strokePath()
      case .text, .mark, .freeText:
        break
      }
    case .image(let p):
      let shape = Drawing.squircle(r, t.cardRadius)
      ctx.saveGState()
      ctx.addPath(shape)
      ctx.clip()
      // a gesture started: no decode
      let got =
        Task.isCancelled
        ? nil
        : p.url.map {
          images.image($0, frame: p.frame, width: Int((size.width * scale).rounded(.up)), fileSize: p.fileSize)
        }
      if got?.decoded == true { decodes += 1 }
      if let img = got?.image {
        if p.framed {
          ctx.setFillColor(t.surface)
          ctx.fill(r)
        }
        ctx.interpolationQuality = .high
        ctx.translateBy(x: 0, y: size.height)
        ctx.scaleBy(x: 1, y: -1)
        ctx.draw(img, in: r)
      } else {
        ctx.setFillColor(t.hiddenRow)
        ctx.fill(r)
      }
      ctx.restoreGState()
      if p.framed { Drawing.edge(ctx, r, t) }
    case .label(let l):
      if l.boxed {
        let p = CGPath(
          roundedRect: r.insetBy(dx: 0.25, dy: 0.25), cornerWidth: t.labelRadius, cornerHeight: t.labelRadius,
          transform: nil)
        ctx.addPath(p)
        ctx.setFillColor(t.surface)
        ctx.fillPath()
        ctx.addPath(p)
        ctx.setStrokeColor(t.hair)
        ctx.setLineWidth(0.5)
        ctx.strokePath()
        Drawing.text(ctx, l.text, t.arrowLabel.ct, t.ink, x: 6, midY: size.height / 2, width: size.width - 12)
      } else {
        Drawing.text(ctx, l.text, t.sectionTitle.ct, t.ink2, x: 6, midY: size.height / 2, width: size.width - 8)
      }
    }
    return decodes
  }

  // MARK: Parts

  /// The card's paper and its title bar
  private static func paper(_ ctx: CGContext, _ r: CGRect, _ t: Theme, headerLine: Bool) {
    let p = squircle(r, t.cardRadius)
    ctx.addPath(p)
    ctx.setFillColor(t.surface)
    ctx.fillPath()
    ctx.saveGState()
    ctx.addPath(p)
    ctx.clip()
    ctx.setFillColor(t.head)
    ctx.fill(CGRect(x: 0, y: 0, width: r.width, height: t.headerHeight))
    if headerLine {
      ctx.setFillColor(t.line)
      ctx.fill(CGRect(x: 0, y: t.headerHeight - 1, width: r.width, height: 1))
    }
    ctx.restoreGState()
  }

  /// Warm Ink's card edge: a hairline, a light line inside the top and a warm one inside the bottom
  private static func edge(_ ctx: CGContext, _ r: CGRect, _ t: Theme) {
    let p = squircle(r, t.cardRadius)
    ctx.saveGState()
    ctx.addPath(p)
    ctx.clip()
    for (dy, color) in [(CGFloat(1), t.edgeTop), (-1.5, t.edgeBottom)] {
      ctx.addPath(p)
      ctx.addPath(squircle(r.offsetBy(dx: 0, dy: dy), t.cardRadius))
      ctx.setFillColor(color)
      ctx.fillPath(using: .evenOdd)
    }
    ctx.restoreGState()
    ctx.addPath(squircle(r.insetBy(dx: 0.25, dy: 0.25), t.cardRadius))
    ctx.setStrokeColor(t.hair)
    ctx.setLineWidth(0.5)
    ctx.strokePath()
  }

  private static func code(_ ctx: CGContext, _ c: Code, _ r: CGRect, _ t: Theme) {
    let m = t.metrics
    let top = c.framed ? t.headerHeight : 0
    if c.framed {
      let pathWidth = c.path.map { min(width($0, t.codePath.ct), r.width * 0.3) } ?? 0
      let titleRoom = r.width - 16 - (pathWidth > 0 ? pathWidth + 7 : 0)
      let titleWidth = min(width(c.title, t.codeTitle.ct), titleRoom)
      text(ctx, c.title, t.codeTitle.ct, t.ink, x: 10, midY: top / 2, width: titleWidth)
      if let p = c.path { text(ctx, p, t.codePath.ct, t.ink3, x: 10 + titleWidth + 7, midY: top / 2, width: pathWidth) }
    }
    ctx.saveGState()
    ctx.clip(to: CGRect(x: 0, y: top, width: r.width, height: r.height - top))
    ctx.translateBy(x: 0, y: top)
    let l = c.layout
    for b in l.bands {
      let band = CGRect(
        x: l.gutter - 4, y: b.lowerBound + 2, width: r.width - 14 - (l.gutter - 4),
        height: b.upperBound - b.lowerBound - 4)
      ctx.addPath(CGPath(roundedRect: band, cornerWidth: 6, cornerHeight: 6, transform: nil))
      ctx.setFillColor(t.highlight)
      ctx.fillPath()
    }
    let numbers = t.ink3.copy(alpha: t.ink3.alpha * 0.65) ?? t.ink3
    let numberRight = l.gutter - m.numberGap
    for p in l.rows {
      let mid = p.y + p.height / 2
      switch p.row {
      case .line(_, let n, let s):
        if let n {
          let ns = String(n)
          text(ctx, ns, t.code.ct, numbers, x: numberRight - width(ns, t.code.ct), midY: mid, width: .infinity)
        }
        text(ctx, s, t.code.ct, t.ink, x: l.gutter, midY: mid, width: .infinity)
      case .gap(let a, let b):
        let row = CGRect(x: 0, y: p.y + 1, width: r.width, height: p.height - 2)
        ctx.setFillColor(t.hiddenRow)
        ctx.fill(row)
        ctx.setStrokeColor(t.hair)
        ctx.setLineWidth(1)
        ctx.setLineDash(phase: 0, lengths: [3, 3])
        ctx.strokeLineSegments(between: [
          CGPoint(x: 0, y: row.minY + 0.5), CGPoint(x: r.width, y: row.minY + 0.5), CGPoint(x: 0, y: row.maxY - 0.5),
          CGPoint(x: r.width, y: row.maxY - 0.5),
        ])
        ctx.setLineDash(phase: 0, lengths: [])
        let n = b - a + 1
        let what = "⋯ \(n) line\(n > 1 ? "s" : "") hidden (\(a == b ? "\(a)" : "\(a)–\(b)"))"
        text(ctx, what, t.small.ct, t.ink3, x: l.gutter + 8, midY: mid, width: r.width - l.gutter - 16)
      case .file(let path):
        let x0 = max(0, l.gutter - 58)
        let bar = CGRect(x: x0, y: p.y + 2, width: r.width - 12 - x0, height: p.height - 4)
        ctx.setFillColor(t.head)
        ctx.fill(bar)
        ctx.setFillColor(t.line)
        ctx.fill(CGRect(x: bar.minX, y: bar.minY, width: bar.width, height: 1))
        ctx.fill(CGRect(x: bar.minX, y: bar.maxY - 1, width: bar.width, height: 1))
        text(ctx, path, t.code.ct, t.ink2, x: x0 + 14, midY: mid, width: bar.width - 20)
      case .function(let name):
        text(ctx, name, t.codePath.ct, t.ink3, x: l.gutter, midY: mid, width: r.width - l.gutter - m.padRight)
      }
    }
    ctx.restoreGState()
  }

  /// One line of text with its middle at midY, cut with an ellipsis to `width`
  private static func text(
    _ ctx: CGContext, _ s: String, _ font: CTFont, _ color: CGColor, x: CGFloat, midY: CGFloat, width w: CGFloat
  ) {
    guard !s.isEmpty, w > 0 else { return }
    let attrs = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: color] as CFDictionary
    var line = CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, s as CFString, attrs))
    if w.isFinite, CTLineGetTypographicBounds(line, nil, nil, nil) > w {
      let dots = CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, "…" as CFString, attrs))
      line = CTLineCreateTruncatedLine(line, w, .end, dots) ?? line
    }
    ctx.textPosition = CGPoint(x: x, y: midY + (CTFontGetAscent(font) - CTFontGetDescent(font)) / 2)
    CTLineDraw(line, ctx)
  }

  static func width(_ s: String, _ font: CTFont) -> CGFloat {
    let attrs = [kCTFontAttributeName: font] as CFDictionary
    return CTLineGetTypographicBounds(
      CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, s as CFString, attrs)), nil, nil, nil)
  }

  /// A rounded rectangle with the board's squircle corners (CSS corner-shape: squircle, a superellipse of exponent 4)
  static func squircle(_ r: CGRect, _ radius: CGFloat) -> CGPath {
    let k = min(radius, r.width / 2, r.height / 2)
    let centres = [
      CGPoint(x: r.maxX - k, y: r.minY + k), CGPoint(x: r.maxX - k, y: r.maxY - k),
      CGPoint(x: r.minX + k, y: r.maxY - k), CGPoint(x: r.minX + k, y: r.minY + k),
    ]
    var pts: [CGPoint] = []
    for (i, c) in centres.enumerated() {
      for s in 0...12 {
        let a = (CGFloat(i) - 1 + CGFloat(s) / 12) * .pi / 2
        let cx = cos(a)
        let sy = sin(a)
        pts.append(
          CGPoint(
            x: c.x + k * (cx < 0 ? -1 : 1) * abs(cx).squareRoot(), y: c.y + k * (sy < 0 ? -1 : 1) * abs(sy).squareRoot()
          ))
      }
    }
    let p = CGMutablePath()
    p.addLines(between: pts)
    p.closeSubpath()
    return p
  }
}

enum Raster {
  /// A bitmap of `size` board units at `scale` device pixels per unit, drawn y-down, as an IOSurface Core Animation shows
  /// without a copy
  static func surface(size: CGSize, scale: CGFloat, _ draw: (CGContext) -> Void) -> IOSurface? {
    let w = max(1, Int((size.width * scale).rounded(.up)))
    let h = max(1, Int((size.height * scale).rounded(.up)))
    guard
      let s = IOSurface(properties: [
        .width: w, .height: h, .bytesPerElement: 4, .pixelFormat: 0x4247_5241,  // 'BGRA'
      ]),
      let space = CGColorSpace(name: CGColorSpace.sRGB)
    else { return nil }
    // tagged, or Core Animation shows the pixels in the display's colour space
    if let plist = space.copyPropertyList() { IOSurfaceSetValue(s as IOSurfaceRef, kIOSurfaceColorSpace, plist) }
    s.lock(options: [], seed: nil)
    defer { s.unlock(options: [], seed: nil) }
    guard
      let ctx = CGContext(
        data: s.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: s.bytesPerRow, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    ctx.clear(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.setShouldSmoothFonts(false)
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: scale, y: -scale)
    draw(ctx)
    return s
  }
}

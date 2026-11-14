import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import CoreText
import IOSurface

/// What one item's bitmap shows. Drawn off the main thread at any scale: a producer gets the item's size, a scale and
/// the theme and draws into a context whose origin is the item's top left; it may draw `bleed(theme)` past each side
/// (paper, rings), and the bitmap has room for that. The Note renderer is the other producer: a Note's content and an SVG
/// picture are its pictures, drawn over the paper drawn here (`picture`, `CanvasView.compose`).
enum Drawing: Sendable {
  case code(Code)
  case note(Note)
  case image(Picture)
  case label(Label)
  /// A sub-board card (SubBoardMap.swift)
  case board(SubBoard)
  /// A Web card and a Link List (WebDrawing.swift)
  case web(Web)
  case links(Links)

  struct Code: Sendable {
    /// The card's id: picks its paper
    var id: String
    var title: String
    var path: String?
    /// The card's kind before its title (ƒ, C, ⋮…), when the theme shows it
    var glyph: String?
    /// Its source's version (a commit, a package version, a file's fingerprint)
    var version: String?
    /// Arrows ending on the card
    var linkedIn: Int
    /// Rows arrows start from: segment index and line
    var linked: Set<[Int]>
    var layout: CodeLayout
    var framed: Bool
  }

  struct Note: Sendable {
    var id: String
    /// nil: untitled, shown as "Note"
    var title: String?
    var content: NoteBody
    /// Where its images are: the board package or the vault's shared folder
    var folder: URL
    /// The stored height, as the renderer is asked for it; nil: as tall as its content
    var height: Double?
    /// What its [[refs]] point at now
    var refs: [NoteRef]

    /// A Box's fill; nil for a Note or a Text
    var boxFill: BoxFill? {
      if case .text(let t) = content, t.look == .box { t.fill } else { nil }
    }
  }

  struct Picture: Sendable {
    var id: String
    /// nil: not drawable here (a web address, or a missing file)
    var url: URL?
    var fileSize: CGSize
    var frame: Int
    var framed: Bool

    /// Drawn by the Note renderer (WebKit), as the web board's <img> draws it
    var svg: Bool { url?.pathExtension.lowercased() == "svg" }
  }

  struct Label: Sendable {
    enum Kind: Sendable {
      case arrow, section
    }

    var text: String
    var kind: Kind
    /// A folded Section's: how many cards are in it ("Title · N cards", then the chevron)
    var count: Int? = nil
  }

  /// A folded Section's title: `.slabel.collapsed` (its padding, the title, "· N cards" 5 after it, the chevron 16
  /// wide, 2 between each)
  static func foldedTitleWidth(_ title: String, count: Int, _ t: Theme) -> CGFloat {
    let pad: CGFloat = t.frame == .tray ? 8 : 2
    return pad + width(title, t.sectionTitleFont) + 2 + 5 + width(foldedCount(count), t.sectionCount) + 2 + 16
  }

  static func foldedCount(_ n: Int) -> String { "· \(n) card\(n == 1 ? "" : "s")" }

  /// Its picture comes from the Note renderer: until then it shows its paper
  var byRenderer: Bool {
    switch self {
    case .note: true
    case .image(let p): p.svg
    case .code, .label, .board, .web, .links: false
    }
  }

  var framed: Bool {
    switch self {
    case .code(let c): c.framed
    case .note(let n): if case .note = n.content { true } else { false }
    case .image(let p): p.framed
    case .board, .web, .links: true
    case .label: false
    }
  }

  /// How far it draws past its rect on each side
  func bleed(_ t: Theme) -> CGFloat {
    // its name and count above it
    if case .board = self { return Drawing.subHead + 2 }
    if framed { return t.bleed }
    // a box's ring and its shadow lie outside it, and an arrow label's box's
    switch self {
    case .note(let n): if n.boxFill != nil { return 3 }
    case .label(let l): if l.kind == .arrow && t.label == .box { return 3 }
    default: break
    }
    return 0
  }

  /// Draws the item in board units, y-down from its top-left, with the Note renderer's `picture` at `scale` when it is
  /// drawn by it (without one: its paper). Returns how many pictures had to be decoded
  func draw(
    in ctx: CGContext, size: CGSize, scale: CGFloat, theme t: Theme, images: DecodeCache, picture: IOSurface? = nil
  ) -> Int {
    let r = CGRect(origin: .zero, size: size)
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    var decodes = 0
    switch self {
    case .code(let c):
      if c.framed { Drawing.paper(ctx, r, t, id: c.id, rule: false) }
      Drawing.code(ctx, c, r, t)
      if c.framed { Drawing.edge(ctx, r, t) }
    case .note(let n):
      switch n.content {
      case .note:
        Drawing.paper(ctx, r, t, id: n.id, rule: true)
        var x = t.headerPad
        if let g = t.kindGlyph {
          Drawing.text(
            ctx, "¶", g, t.ink3, x: x + (10 - Drawing.width("¶", g)) / 2, midY: t.headerHeight / 2, width: 10)
          x += 10 + t.headerGap
        }
        Drawing.text(
          ctx, n.title ?? "Note", t.noteTitle, n.title == nil ? t.ink3 : t.ink, x: x, midY: t.headerHeight / 2,
          width: size.width - x - t.headerPadRight)
        Drawing.edge(ctx, r, t)
      case .text(let text) where text.look == .box:
        let p = Drawing.squircle(r, t.cardRadius)
        ctx.saveGState()
        ctx.setShadow(
          offset: CGSize(width: 0, height: -1 * scale), blur: 2 * scale,
          color: CGColor(srgbRed: 50 / 255, green: 35 / 255, blue: 10 / 255, alpha: 0.06))
        ctx.addPath(p)
        ctx.setFillColor(t.boxFills[text.fill] ?? t.surface)
        ctx.fillPath()
        ctx.restoreGState()
        // a ring wholly outside the box (box-shadow 0 0 0 1.25px)
        ctx.addPath(Drawing.squircle(r.insetBy(dx: -0.625, dy: -0.625), t.cardRadius + 0.625))
        ctx.setStrokeColor(t.boxEdge)
        ctx.setLineWidth(1.25)
        ctx.strokePath()
      case .text:
        break
      }
      // transparent around the content, pixel for pixel from the top left
      if let px = picture {
        Raster.draw(
          px, in: CGRect(x: 0, y: 0, width: CGFloat(px.width) / scale, height: CGFloat(px.height) / scale), of: ctx)
      }
    case .image(let p):
      if p.framed { Drawing.paper(ctx, r, t, id: p.id, rule: nil) }
      let shape = Drawing.squircle(r, t.cardRadius)
      ctx.saveGState()
      ctx.addPath(shape)
      ctx.clip()
      if let px = picture {
        // as wide as the card and as tall as its proportions (.imgb img)
        Raster.draw(
          px, in: CGRect(x: 0, y: 0, width: CGFloat(px.width) / scale, height: CGFloat(px.height) / scale), of: ctx)
      } else if !p.svg {
        // a gesture started: no decode
        let got =
          Task.isCancelled
          ? nil
          : p.url.map {
            images.image($0, frame: p.frame, width: Int((size.width * scale).rounded(.up)), fileSize: p.fileSize)
          }
        if got?.decoded == true { decodes += 1 }
        if let img = got?.image {
          ctx.interpolationQuality = .high
          ctx.translateBy(x: 0, y: size.height)
          ctx.scaleBy(x: 1, y: -1)
          ctx.draw(img, in: r)
        } else {
          ctx.setFillColor(t.hiddenRow)
          ctx.fill(r)
        }
      }
      ctx.restoreGState()
      if p.framed { Drawing.edge(ctx, r, t) }
    case .board(let b):
      decodes += Drawing.subBoard(ctx, b, r, t, scale: scale)
    case .web(let w):
      decodes += Drawing.web(ctx, w, r, t, images: images, scale: scale)
    case .links(let l):
      decodes += Drawing.links(ctx, l, r, t, images: images, scale: scale)
    case .label(let l):
      switch (l.kind, t.label) {
      case (.arrow, .box):
        // a box of card paper in a hairline ring and a faint shadow (.vcard)
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -scale), blur: 2 * scale, color: CGColor(gray: 0, alpha: 0.05))
        ctx.addPath(Drawing.squircle(r, t.labelRadius))
        ctx.setFillColor(t.surface)
        ctx.fillPath()
        ctx.restoreGState()
        ctx.addPath(Drawing.squircle(r.insetBy(dx: -0.25, dy: -0.25), t.labelRadius + 0.25))
        ctx.setStrokeColor(t.hair)
        ctx.setLineWidth(0.5)
        ctx.strokePath()
        Drawing.text(ctx, l.text, t.arrowLabel, t.ink, x: 6, midY: size.height / 2, width: size.width - 12)
      case (.arrow, .halo):
        // radial-gradient(closest-side, canvas 62%, transparent): an ellipse filling the box
        ctx.saveGState()
        ctx.translateBy(x: size.width / 2, y: size.height / 2)
        ctx.scaleBy(x: size.width / size.height, y: 1)
        let clear = t.canvas.copy(alpha: 0) ?? t.canvas
        if let g = CGGradient(
          colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [t.canvas, t.canvas, clear] as CFArray,
          locations: [0, 0.62, 1])
        {
          ctx.drawRadialGradient(
            g, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: size.height / 2, options: [])
        }
        ctx.restoreGState()
        Drawing.text(ctx, l.text, t.arrowLabel, t.ink2, x: 16, midY: size.height / 2, width: size.width - 32)
      case (.section, _):
        let x: CGFloat = t.frame == .tray ? 6 : 0
        guard let n = l.count else {
          Drawing.text(
            ctx, l.text, t.sectionTitleFont, t.sectionTitle, x: x, midY: size.height / 2, width: size.width - x)
          break
        }
        // folded: the title, its card count, the chevron pointing right
        let tw = Drawing.width(l.text, t.sectionTitleFont)
        Drawing.text(ctx, l.text, t.sectionTitleFont, t.sectionTitle, x: x, midY: size.height / 2, width: tw)
        let count = Drawing.foldedCount(n)
        let cx = x + tw + 2 + 5
        let cw = Drawing.width(count, t.sectionCount)
        Drawing.text(ctx, count, t.sectionCount, t.ink3, x: cx, midY: size.height / 2, width: cw)
        // icons.tsx chevR (M6 12l4-4-4-4) at 10 px in a 16 px box, its stroke 2 of 16
        let k: CGFloat = 10 / 16
        let ox = cx + cw + 2 + 3
        let oy = size.height / 2 - 5
        let chev = CGMutablePath()
        chev.move(to: CGPoint(x: ox + 6 * k, y: oy + 12 * k))
        chev.addLine(to: CGPoint(x: ox + 10 * k, y: oy + 8 * k))
        chev.addLine(to: CGPoint(x: ox + 6 * k, y: oy + 4 * k))
        ctx.addPath(chev)
        ctx.setStrokeColor(t.ink3)
        ctx.setLineWidth(2 * k)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        ctx.strokePath()
      }
    }
    return decodes
  }

  // MARK: Parts

  /// The card's paper and its title bar (rule: whether the bar has a rule under it, where the theme draws one; nil: no bar)
  static func paper(_ ctx: CGContext, _ r: CGRect, _ t: Theme, id: String, rule: Bool?) {
    switch t.paper {
    case .sheet:
      ctx.addPath(squircle(r, t.cardRadius))
      ctx.setFillColor(t.surface)
      ctx.fillPath()
    case .deckle:
      let p = Deckle.paper(Deckle.sheet(for: id), size: r.size)
      ctx.addPath(p.outline)
      ctx.setFillColor(t.surface)
      ctx.fillPath()
      ctx.saveGState()
      ctx.setLineCap(.butt)
      ctx.setLineWidth(0.5)
      ctx.setStrokeColor(t.fibreInner)
      ctx.addPath(p.inner)
      ctx.strokePath()
      ctx.setLineCap(.round)
      ctx.setLineWidth(0.7)
      ctx.setStrokeColor(t.surface)
      ctx.addPath(p.fibres)
      ctx.strokePath()
      ctx.setLineCap(.butt)
      ctx.setLineWidth(0.5)
      ctx.setStrokeColor(t.fibreEdge)
      ctx.addPath(p.outline)
      ctx.strokePath()
      ctx.restoreGState()
    }
    guard let rule else { return }
    let bar = CGRect(x: 0, y: 0, width: r.width, height: t.headerHeight)
    ctx.saveGState()
    // the bar's pixels first: clipped to the card's shape alone, Core Graphics would mask all of the card (`strips`)
    ctx.clip(to: ctx.convertToUserSpace(ctx.convertToDeviceSpace(bar).integral))
    ctx.addPath(squircle(r, t.cardRadius))
    ctx.clip()
    switch t.header {
    case .band:
      ctx.setFillColor(t.head)
      ctx.fill(bar)
      if rule {
        ctx.setFillColor(t.line)
        ctx.fill(CGRect(x: 0, y: t.headerHeight - 1, width: r.width, height: 1))
      }
    case .wash:
      let ink = { (a: CGFloat) in t.ink.copy(alpha: a) ?? t.ink }
      if let g = CGGradient(
        colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [ink(0.06), ink(0.035), ink(0)] as CFArray,
        locations: [0, 0.45, 0.85])
      {
        ctx.clip(to: bar)
        ctx.drawLinearGradient(
          g, start: .zero, end: CGPoint(x: r.width, y: 0), options: [.drawsAfterEndLocation])
      }
    }
    ctx.restoreGState()
  }

  /// `Paper.sheet`'s card edge: a hairline, a light line inside the top and a warm one inside the bottom
  static func edge(_ ctx: CGContext, _ r: CGRect, _ t: Theme) {
    guard t.paper == .sheet else { return }
    let p = squircle(r, t.cardRadius)
    // the two lines through strips along the top and bottom, where they are
    for strip in strips(ctx, r, depth: t.cardRadius + 2) {
      ctx.saveGState()
      ctx.clip(to: strip)
      ctx.addPath(p)
      ctx.clip()
      for (dy, color) in [(CGFloat(1), t.edgeTop), (-1.5, t.edgeBottom)] {
        ctx.addPath(p)
        ctx.addPath(squircle(r.offsetBy(dx: 0, dy: dy), t.cardRadius))
        ctx.setFillColor(color)
        ctx.fillPath(using: .evenOdd)
      }
      ctx.restoreGState()
    }
    ctx.addPath(squircle(r.insetBy(dx: -0.25, dy: -0.25), t.cardRadius + 0.25))
    ctx.setStrokeColor(t.hair)
    ctx.setLineWidth(0.5)
    ctx.strokePath()
  }

  /// Strips along the top and bottom of `r`, from `depth` inside it to a unit past it, on whole device pixels and not
  /// overlapping, so what is drawn through both is drawn once and looks the same. Clipped to the card's shape over all of
  /// it, Core Graphics takes a mask the size of the card for every bitmap drawn, and the allocator keeps such blocks once
  /// freed, in the footprint. (Fills and strokes of the whole shape take one too, but come out a level different on
  /// some edge pixels when clipped, so they are left whole.)
  private static func strips(_ ctx: CGContext, _ r: CGRect, depth: CGFloat) -> [CGRect] {
    let outer = ctx.convertToDeviceSpace(r.insetBy(dx: -1, dy: -1)).integral
    let inner = ctx.convertToDeviceSpace(r.insetBy(dx: 0, dy: depth))
    let (low, high) = (inner.minY.rounded(.up), inner.maxY.rounded(.down))
    guard low < high else { return [ctx.convertToUserSpace(outer)] }
    return [
      CGRect(x: outer.minX, y: outer.minY, width: outer.width, height: low - outer.minY),
      CGRect(x: outer.minX, y: high, width: outer.width, height: outer.maxY - high),
    ].map(ctx.convertToUserSpace)
  }

  private static func code(_ ctx: CGContext, _ c: Code, _ r: CGRect, _ t: Theme) {
    let m = t.metrics
    let top = c.framed ? t.headerHeight : 0
    if c.framed { header(ctx, c, r, t) }
    ctx.saveGState()
    ctx.clip(to: CGRect(x: 0, y: top, width: r.width, height: r.height - top))
    ctx.translateBy(x: 0, y: top)
    let l = c.layout
    for p in l.rows {
      if case .line(let s, let n?, _, _) = p.row, c.linked.contains([s, n]) {
        ctx.setFillColor(t.linkedRow)
        ctx.fill(CGRect(x: 0, y: p.y, width: r.width, height: p.height))
      }
    }
    for b in l.bands {
      let band = CGRect(
        x: l.gutter - 4, y: b.lowerBound + 2, width: r.width - 14 - (l.gutter - 4),
        height: b.upperBound - b.lowerBound - 4)
      ctx.addPath(CGPath(roundedRect: band, cornerWidth: 6, cornerHeight: 6, transform: nil))
      ctx.setFillColor(t.highlight)
      ctx.fillPath()
    }
    let numberRight = l.gutter - m.numberGap
    for p in l.rows {
      let mid = p.y + p.height / 2
      switch p.row {
      case .line(let si, let n, let s, let tokens):
        if let n {
          let ns = String(n)
          let color = c.linked.contains([si, n]) ? t.linkedNumber : t.number
          text(ctx, ns, t.code, color, x: numberRight - width(ns, t.code), midY: mid, width: .infinity)
        }
        codeLine(ctx, s, tokens, t, x: l.gutter + l.shift, midY: mid)
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
        let what = "··· \(n) line\(n > 1 ? "s" : "") hidden (\(a == b ? "\(a)" : "\(a)–\(b)")) · "
        let x = l.gutter + 8
        text(ctx, what, t.small, t.ink3, x: x, midY: mid, width: r.width - x - 8)
        let shown = x + width(what, t.small) + 5
        text(ctx, "Show", t.smallStrong, t.ink2, x: shown, midY: mid, width: r.width - shown - 8)
      case .file(let path):
        let x0 = max(0, l.gutter - 58)
        let bar = CGRect(x: x0, y: p.y + 2, width: r.width - 12 - x0, height: p.height - 4)
        ctx.setFillColor(t.head)
        ctx.fill(bar)
        ctx.setFillColor(t.line)
        ctx.fill(CGRect(x: bar.minX, y: bar.minY, width: bar.width, height: 1))
        ctx.fill(CGRect(x: bar.minX, y: bar.maxY - 1, width: bar.width, height: 1))
        text(ctx, path, t.code, t.ink2, x: x0 + 14, midY: mid, width: bar.width - 20)
      case .function(let name):
        text(ctx, name, t.codePath, t.ink3, x: l.gutter, midY: mid, width: r.width - l.gutter - m.padRight)
      }
    }
    if l.dedent > 0 { dedentMark(ctx, levels: min(4, max(1, Int((CGFloat(l.dedent) / 4).rounded()))), l, r, t) }
    ctx.restoreGState()
  }

  /// Hidden indentation: a hairline per level hidden, dashed, down the left of the code (styles.css .dedm)
  private static func dedentMark(_ ctx: CGContext, levels: Int, _ l: CodeLayout, _ r: CGRect, _ t: Theme) {
    let bottom = l.height - 4
    ctx.saveGState()
    ctx.setFillColor(t.hair.copy(alpha: t.hair.alpha * 0.7) ?? t.hair)
    for k in 0..<levels {
      var y: CGFloat = 4
      while y < bottom {
        ctx.fill(CGRect(x: l.gutter + 1 + CGFloat(k) * 3, y: y, width: 0.5, height: min(2, bottom - y)))
        y += 4
      }
    }
    ctx.restoreGState()
  }

  /// A code card's title bar: kind, title and path from the left; the arrows ending on it and its version from the right
  private static func header(_ ctx: CGContext, _ c: Code, _ r: CGRect, _ t: Theme) {
    let mid = t.headerHeight / 2
    var right = r.width - t.headerPadRight
    if let v = c.version {
      // the chip's own padding
      let w = width(v, t.codePath)
      text(ctx, v, t.codePath, t.ink3, x: right - 5 - w, midY: mid, width: w)
      right -= w + 10 + t.headerGap
    }
    if c.linkedIn > 0 {
      let s = "← \(c.linkedIn)"
      let w = width(s, t.linkedIn)
      text(ctx, s, t.linkedIn, t.ink3, x: right - 4 - w, midY: mid, width: w)
      right -= w + 8 + t.headerGap
    }
    var x = t.headerPad
    if let g = c.glyph, let font = g == "ƒ" ? t.kindGlyph : t.kindGlyphMono {
      text(ctx, g, font, t.ink3, x: x + (10 - width(g, font)) / 2, midY: mid, width: .infinity)
      x += 10 + t.headerGap
    }
    let pathWidth = c.path.map { min(width($0, t.codePath), max(0, right - x - 60)) } ?? 0
    let titleWidth = min(width(c.title, t.codeTitle), right - x - (pathWidth > 0 ? pathWidth + 6 + t.headerGap : 0))
    text(ctx, c.title, t.codeTitle, t.ink, x: x, midY: mid, width: titleWidth)
    if let p = c.path, pathWidth > 0 {
      text(ctx, p, t.codePath, t.ink3, x: x + titleWidth + t.headerGap + 3, midY: mid, width: pathWidth)
    }
  }

  /// A row of code in its token colours, with its middle at midY (the body's clip cuts it)
  private static func codeLine(
    _ ctx: CGContext, _ s: String, _ tokens: [Token], _ t: Theme, x: CGFloat, midY: CGFloat
  ) {
    guard !s.isEmpty else { return }
    let font = NSAttributedString.Key(kCTFontAttributeName as String)
    let color = NSAttributedString.Key(kCTForegroundColorAttributeName as String)
    let a = NSMutableAttributedString(string: s, attributes: [font: t.code.ct, color: t.ink])
    let units = a.length
    for tok in tokens {
      let r = tok.columns.clamped(to: 0..<units)
      guard !r.isEmpty else { continue }
      let range = NSRange(location: r.lowerBound, length: r.count)
      a.addAttribute(color, value: t.syntax[tok.kind] ?? t.ink, range: range)
      switch tok.kind {
      case .comment: a.addAttribute(font, value: t.codeComment.ct, range: range)
      case .keyword, .operator: a.addAttribute(font, value: t.codeKeyword.ct, range: range)
      default: break
      }
    }
    let f = t.code.ct
    ctx.textPosition = CGPoint(x: x, y: midY + (CTFontGetAscent(f) - CTFontGetDescent(f)) / 2)
    CTLineDraw(CTLineCreateWithAttributedString(a), ctx)
  }

  private static func line(_ s: String, _ font: Font, _ color: CGColor? = nil) -> CTLine {
    var attrs: [CFString: Any] = [kCTFontAttributeName: font.ct]
    if let color { attrs[kCTForegroundColorAttributeName] = color }
    if font.tracking != 0 { attrs[kCTKernAttributeName] = font.tracking }
    return CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, s as CFString, attrs as CFDictionary))
  }

  /// One line of text with its middle at midY, cut with an ellipsis to `width`
  static func text(
    _ ctx: CGContext, _ s: String, _ font: Font, _ color: CGColor, x: CGFloat, midY: CGFloat, width w: CGFloat
  ) {
    guard !s.isEmpty, w > 0 else { return }
    var l = line(s, font, color)
    if w.isFinite, CTLineGetTypographicBounds(l, nil, nil, nil) > w + 0.5 {
      l = CTLineCreateTruncatedLine(l, w, .end, line("…", font, color)) ?? l
    }
    let f = font.ct
    ctx.textPosition = CGPoint(x: x, y: midY + (CTFontGetAscent(f) - CTFontGetDescent(f)) / 2)
    CTLineDraw(l, ctx)
  }

  static func width(_ s: String, _ font: Font) -> CGFloat {
    CTLineGetTypographicBounds(line(s, font), nil, nil, nil)
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
  /// Draws a BGRA, premultiplied, sRGB surface pixel for pixel into `rect` of a y-down context, without copying it
  static func draw(_ s: IOSurface, in rect: CGRect, of ctx: CGContext) {
    s.lock(options: .readOnly, seed: nil)
    defer { s.unlock(options: .readOnly, seed: nil) }
    guard
      let provider = CGDataProvider(
        dataInfo: nil, data: s.baseAddress, size: s.bytesPerRow * s.height, releaseData: { _, _, _ in }),
      let space = CGColorSpace(name: CGColorSpace.sRGB),
      let image = CGImage(
        width: s.width, height: s.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: s.bytesPerRow,
        space: space,
        bitmapInfo: CGBitmapInfo(
          rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { return }
    ctx.saveGState()
    ctx.interpolationQuality = .none
    ctx.translateBy(x: rect.minX, y: rect.maxY)
    ctx.scaleBy(x: 1, y: -1)
    ctx.draw(image, in: CGRect(origin: .zero, size: rect.size))
    ctx.restoreGState()
  }

  /// A bitmap of `size` board units and `bleed` more on each side at `scale` device pixels per unit, drawn y-down with the
  /// origin at the size's top left, as an IOSurface Core Animation shows without a copy
  static func surface(size: CGSize, scale: CGFloat, bleed: CGFloat = 0, _ draw: (CGContext) -> Void) -> IOSurface? {
    let w = max(1, Int(((size.width + 2 * bleed) * scale).rounded(.up)))
    let h = max(1, Int(((size.height + 2 * bleed) * scale).rounded(.up)))
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
    ctx.translateBy(x: bleed, y: bleed)
    draw(ctx)
    return s
  }
}

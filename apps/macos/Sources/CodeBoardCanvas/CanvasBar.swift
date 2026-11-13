import AppKit
import CodeBoardModel
import CodeBoardNotes

// The bar over a Text or Box selected alone (NoteBody.tsx WritingToolbar, styles.css .ttb.tbar): S M L XL | Text Box,
// and on a Box | its five fills. In board units 46 above the card's top left, so it scales with the zoom as the web
// board's does; its sizes and colours are the web board's computed styles in each look (measured in Chromium). It is
// one bitmap, drawn again only when what it shows or the resting zoom changes.

/// What a button of the bar does
enum BarButton: Equatable {
  case size(Double)
  case look(TextCard.Look)
  case fill(BoxFill)
}

/// The bar's colours in a look and appearance (themes.css --glass, --hlrow, --ink, --ink-2, --hair, --sh-float)
struct BarLook {
  var glass: CGColor
  var radius: CGFloat
  /// A hairline around it, then CSS box-shadow layers (offset y, blur, spread, colour)
  var ring: CGColor
  var shadows: [(y: CGFloat, blur: CGFloat, spread: CGFloat, color: CGColor)]
  var on: CGColor
  var ink: CGColor
  var ink2: CGColor
  var sep: CGColor
  var font: Font

  static func of(_ t: Theme) -> BarLook {
    func c(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
      CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
    }
    switch (t.id, t.dark) {
    case (.warmInk, false):
      return BarLook(
        glass: c(253, 252, 250, 0.94), radius: 14, ring: c(60, 45, 20, 0.16),
        shadows: [(2, 6, -1, c(50, 35, 10, 0.08)), (10, 28, -8, c(50, 35, 10, 0.18))], on: c(60, 45, 20, 0.07),
        ink: c(33, 31, 27), ink2: c(98, 94, 86), sep: c(60, 45, 20, 0.16), font: sys)
    case (.warmInk, true):
      return BarLook(
        glass: c(42, 41, 38, 0.94), radius: 14, ring: c(255, 240, 220, 0.11),
        shadows: [(2, 6, -1, c(0, 0, 0, 0.35)), (10, 28, -8, c(0, 0, 0, 0.55))], on: c(255, 240, 220, 0.07),
        ink: c(236, 232, 224), ink2: c(172, 167, 157), sep: c(255, 240, 220, 0.11), font: sys)
    case (.inkWash, false):
      return BarLook(
        glass: c(253, 253, 251), radius: 2, ring: c(29, 28, 26, 0.16),
        shadows: [(1, 2, 0, c(60, 40, 10, 0.12)), (12, 22, -12, c(0, 0, 0, 0.35))], on: c(29, 28, 26, 0.06),
        ink: c(29, 28, 26), ink2: c(76, 73, 67), sep: c(29, 28, 26, 0.16), font: serif)
    case (.inkWash, true):
      return BarLook(
        glass: c(28, 27, 25), radius: 2, ring: c(233, 229, 218, 0.14),
        shadows: [(1, 2, 0, c(0, 0, 0, 0.5)), (12, 22, -12, c(0, 0, 0, 0.6))], on: c(233, 229, 218, 0.07),
        ink: c(233, 229, 218), ink2: c(185, 180, 168), sep: c(233, 229, 218, 0.14), font: serif)
    }
  }

  private static let sys = Font(NSFont.systemFont(ofSize: 12, weight: .semibold))
  private static let serif =
    Font.board("SourceSerif4-400-600", size: 12, weight: 600, opticalSize: true)
    ?? Font(NSFont(name: "Georgia-Bold", size: 12) ?? NSFont.boldSystemFont(ofSize: 12))
}

/// The toolbar's icons (ui/icons.tsx), on a 16-unit square, drawn with a 1-unit line moved half a unit up and left
enum Icons {
  static func text() -> CGPath {
    let p = CGMutablePath()
    p.move(to: CGPoint(x: 8, y: 3))
    p.addLine(to: CGPoint(x: 8, y: 13))
    p.move(to: CGPoint(x: 6, y: 13))
    p.addLine(to: CGPoint(x: 10, y: 13))
    p.move(to: CGPoint(x: 3, y: 5))
    p.addArc(tangent1End: CGPoint(x: 3, y: 3), tangent2End: CGPoint(x: 13, y: 3), radius: 0.5)
    p.addArc(tangent1End: CGPoint(x: 13, y: 3), tangent2End: CGPoint(x: 13, y: 5), radius: 0.5)
    p.addLine(to: CGPoint(x: 13, y: 5))
    return p
  }

  static func box() -> CGPath {
    CGPath(roundedRect: CGRect(x: 2, y: 4, width: 12, height: 8), cornerWidth: 2, cornerHeight: 2, transform: nil)
  }

  static func note() -> CGPath {
    let p = CGMutablePath()
    p.move(to: CGPoint(x: 10, y: 2))
    p.addLine(to: CGPoint(x: 14, y: 6))
    p.addArc(tangent1End: CGPoint(x: 14, y: 14), tangent2End: CGPoint(x: 2, y: 14), radius: 0.5)
    p.addArc(tangent1End: CGPoint(x: 2, y: 14), tangent2End: CGPoint(x: 2, y: 2), radius: 0.5)
    p.addArc(tangent1End: CGPoint(x: 2, y: 2), tangent2End: CGPoint(x: 10, y: 2), radius: 0.5)
    p.closeSubpath()
    p.move(to: CGPoint(x: 10, y: 2))
    p.addArc(tangent1End: CGPoint(x: 10, y: 6), tangent2End: CGPoint(x: 14, y: 6), radius: 0.5)
    p.addLine(to: CGPoint(x: 14, y: 6))
    return p
  }

  /// `path` stroked as the board draws an icon (`.ico`), its square's top left at `at`, in a y-down context
  static func stroke(_ path: CGPath, at: CGPoint, color: CGColor, in ctx: CGContext) {
    ctx.saveGState()
    ctx.translateBy(x: at.x - 0.5, y: at.y - 0.5)
    ctx.addPath(path)
    ctx.setStrokeColor(color)
    ctx.setLineWidth(1)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.strokePath()
    ctx.restoreGState()
  }
}

enum WritingBar {
  /// Where the bar is from its card's top left (.ttb.tbar top -46px), and its height
  static let offset: CGFloat = -46
  static let height: CGFloat = 30
  /// Room around it in its bitmap for its shadow
  static let margin: CGFloat = 32
  static let sizes: [(String, Double)] = [("S", 20), ("M", 24), ("L", 30), ("XL", 40)]

  /// Its buttons and separators from its top left, and its width (padding 5 6, gap 4; buttons 24 × 20; a separator 1
  /// wide with 2 on each side, 18 tall; a fill 16 across with 2 on each side)
  static func layout(box: Bool) -> (buttons: [(BarButton, CGRect)], seps: [CGRect], width: CGFloat) {
    var x: CGFloat = 6
    var buttons: [(BarButton, CGRect)] = []
    var seps: [CGRect] = []
    func button(_ b: BarButton) {
      buttons.append((b, CGRect(x: x, y: 5, width: 24, height: 20)))
      x += 28
    }
    func sep() {
      seps.append(CGRect(x: x + 2, y: 6, width: 1, height: 18))
      x += 9
    }
    for (_, fs) in sizes { button(.size(fs)) }
    sep()
    button(.look(.text))
    button(.look(.box))
    if box {
      sep()
      for f in BoxFill.allCases {
        buttons.append((.fill(f), CGRect(x: x + 2, y: 7, width: 16, height: 16)))
        x += 24
      }
    }
    return (buttons, seps, x - 4 + 6)
  }

  /// The bar for this Text or Box, `scale` pixels per unit, its shadow's room around it
  static func image(_ t: TextCard, theme: Theme, scale: CGFloat) -> CGImage? {
    let l = layout(box: t.look == .box)
    let look = BarLook.of(theme)
    let size = CGSize(width: l.width + 2 * margin, height: height + 2 * margin)
    let w = Int((size.width * scale).rounded(.up))
    let h = Int((size.height * scale).rounded(.up))
    guard
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
    else { return nil }
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: scale, y: -scale)
    ctx.translateBy(x: margin, y: margin)
    let bar = CGRect(x: 0, y: 0, width: l.width, height: height)
    float(bar, radius: look.radius, look: look, glass: look.glass, scale: scale, in: ctx)
    for s in l.seps {
      ctx.setFillColor(look.sep)
      ctx.fill(s)
    }
    for (b, r) in l.buttons {
      let lit = isOn(b, t)
      switch b {
      case .size(let fs):
        if lit { roundedFill(r, 5, look.on, ctx) }
        let name = sizes.first { $0.1 == fs }!.0
        label(name, in: r, font: look.font, color: lit ? look.ink : look.ink2, ctx)
      case .look(let k):
        if lit { roundedFill(r, 5, look.on, ctx) }
        Icons.stroke(
          k == .box ? Icons.box() : Icons.text(), at: CGPoint(x: r.minX + 4, y: r.minY + 2),
          color: lit ? look.ink : look.ink2, in: ctx)
      case .fill(let f):
        // .bdot: its fill, a 1 ring of ink at 30 %, a glass halo of 2 (2.5 when chosen) and then 1.5 of ink
        let dot = CGPath(ellipseIn: r, transform: nil)
        if lit { ring(r, out: 4, color: look.ink, ctx) }
        ring(r, out: lit ? 2.5 : 2, color: look.glass, ctx)
        ring(r, out: 1, color: look.ink.copy(alpha: 0.3)!, ctx)
        ctx.addPath(dot)
        ctx.setFillColor(theme.boxFills[f] ?? theme.surface)
        ctx.fillPath()
      }
    }
    return ctx.makeImage()
  }

  /// A floating panel (`.pill`): its CSS shadows only outside it (its glass may be see-through), its glass and a 0.5
  /// hairline around it; `scale`: device pixels per unit, as CoreGraphics offsets shadows in device space (y up)
  static func float(_ bar: CGRect, radius: CGFloat, look: BarLook, glass: CGColor, scale: CGFloat, in ctx: CGContext) {
    let shape = CGPath(roundedRect: bar, cornerWidth: radius, cornerHeight: radius, transform: nil)
    ctx.saveGState()
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    // each shadow's shape is drawn this far to the side and its shadow moved back: only the shadow lands
    let away = bar.maxX + 200
    for s in look.shadows {
      ctx.saveGState()
      ctx.setShadow(offset: CGSize(width: -away * scale, height: -s.y * scale), blur: s.blur * scale, color: s.color)
      let r = bar.insetBy(dx: -s.spread, dy: -s.spread).offsetBy(dx: away, dy: 0)
      let k = max(0, radius + s.spread)
      ctx.addPath(
        CGPath(roundedRect: r, cornerWidth: min(k, r.width / 2), cornerHeight: min(k, r.height / 2), transform: nil))
      ctx.setFillColor(CGColor(gray: 0, alpha: 1))
      ctx.fillPath()
      ctx.restoreGState()
    }
    ctx.setBlendMode(.clear)
    ctx.addPath(shape)
    ctx.fillPath()
    ctx.endTransparencyLayer()
    ctx.restoreGState()
    ctx.addPath(shape)
    ctx.setFillColor(glass)
    ctx.fillPath()
    ctx.addPath(
      CGPath(
        roundedRect: bar.insetBy(dx: -0.25, dy: -0.25), cornerWidth: radius + 0.25, cornerHeight: radius + 0.25,
        transform: nil))
    ctx.setStrokeColor(look.ring)
    ctx.setLineWidth(0.5)
    ctx.strokePath()
  }

  /// Whether a button shows lit: the size the text is at (none at a size of its own), its look, a Box's fill
  static func isOn(_ b: BarButton, _ t: TextCard) -> Bool {
    switch b {
    case .size(let fs): t.fontSize == fs
    case .look(let k): t.look == k
    case .fill(let f): t.fill == f
    }
  }

  private static func roundedFill(_ r: CGRect, _ radius: CGFloat, _ c: CGColor, _ ctx: CGContext) {
    ctx.addPath(CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil))
    ctx.setFillColor(c)
    ctx.fillPath()
  }

  /// A solid disc `out` past a dot's edge (CSS 0 0 0 <out>px), drawn under it
  private static func ring(_ r: CGRect, out: CGFloat, color: CGColor, _ ctx: CGContext) {
    ctx.addPath(CGPath(ellipseIn: r.insetBy(dx: -out, dy: -out), transform: nil))
    ctx.setFillColor(color)
    ctx.fillPath()
  }

  /// A label centred in its button as CSS centres a 12 px line box (line-height 1)
  private static func label(_ s: String, in r: CGRect, font: Font, color: CGColor, _ ctx: CGContext) {
    let str = NSAttributedString(
      string: s, attributes: [.font: font.ct, .foregroundColor: color])
    let line = CTLineCreateWithAttributedString(str)
    let width = CTLineGetTypographicBounds(line, nil, nil, nil)
    let asc = CTFontGetAscent(font.ct)
    let desc = CTFontGetDescent(font.ct)
    let baseline = r.midY - 6 + (12 - (asc + desc)) / 2 + asc
    ctx.saveGState()
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    ctx.textPosition = CGPoint(x: r.midX - width / 2, y: baseline)
    CTLineDraw(line, ctx)
    ctx.restoreGState()
  }
}

extension CanvasView {
  /// The Text or Box the bar is over: selected alone, not locked, not being written in, nothing being moved
  var barCard: (CardID, TextCard)? {
    guard let doc = document, doc.selection.count == 1, case .card(let id)? = doc.selection.first,
      !doc.board.isLocked(.card(id)), editing?.id != id, let t = doc.board.card(id)?.textCard,
      index(of: .card(id)) != nil
    else { return nil }
    switch gesture?.kind {
    case .move?, .nudge?, .marquee?: return nil
    default: return (id, t)
    }
  }

  /// Where the bar is on the board
  func barRect(_ id: CardID, _ t: TextCard) -> CGRect? {
    guard let r = liveRect(.card(id)) else { return nil }
    return CGRect(
      x: r.minX, y: r.minY + WritingBar.offset, width: WritingBar.layout(box: t.look == .box).width,
      height: WritingBar.height)
  }

  /// The bar as a chrome layer (board units), its bitmap drawn again only when it shows something else or the zoom at
  /// rest changed
  func barLayer() -> CALayer? {
    guard let (id, t) = barCard, let r = barRect(id, t) else { return nil }
    let scale = (restZoom ?? camera.zoom) * backing
    let key = "\(t.look) \(t.fontSize) \(t.fill) \(theme.id) \(theme.dark) \(scale)"
    if barImage?.key != key, let img = WritingBar.image(t, theme: theme, scale: scale) {
      barImage = (key, img)
    }
    let l = CALayer()
    let m = WritingBar.margin
    l.frame = r.insetBy(dx: -m, dy: -m)
    l.contents = barImage?.image
    l.contentsGravity = .resize
    return l
  }

  /// The bar's button under a board point
  func barButton(at p: CGPoint) -> BarButton? {
    guard let (id, t) = barCard, let r = barRect(id, t), r.contains(p) else { return nil }
    let local = CGPoint(x: p.x - r.minX, y: p.y - r.minY)
    return WritingBar.layout(box: t.look == .box).buttons.first { $0.1.insetBy(dx: -2, dy: -5).contains(local) }?.0
  }

  /// What a button of the bar does: one step each
  func press(_ b: BarButton) {
    guard let doc = document, let (id, t) = barCard, !WritingBar.isOn(b, t) else { return }
    switch b {
    case .size(let fs): doc.edit("Text Size") { $0.setTextSize(id, fs) }
    case .fill(let f): doc.edit("Fill") { $0.setBoxFill(id, f) }
    case .look(let k): Task { await switchLook(id, to: k) }
    }
  }

  /// Text ↔ Box with its first line where it was (notes.ts keptAt): the Note page lays it out in both looks and finds
  /// its first glyph in each; one that wraps keeps the width its text wraps at (a Box's sides are 20 wider)
  public func switchLook(_ id: CardID, to look: TextCard.Look) async {
    guard let doc = document, let card = doc.board.card(id), let t = card.textCard, t.look != look,
      let i = index(of: .card(id)), case .note(let n) = scene!.items[i].drawing
    else { return }
    var other = t
    other.look = look
    let width = t.wrap ? card.width + (look == .box ? 20 : -20) : card.width
    func req(_ t: TextCard, _ w: Double) -> NoteRenderer.SizeRequest {
      .init(note: .text(t), width: w, folder: n.folder, look: theme.id.rawValue, dark: theme.dark, refs: n.refs)
    }
    let m = try? await notes.firstGlyphs(of: [req(t, card.width), req(other, width)])
    var at = CGPoint(x: card.x, y: card.y)
    if let a = m?[0]?.first, let b = m?[1]?.first {
      at = CGPoint(x: card.x + a.x - b.x, y: card.y + a.y - b.y)
    }
    guard document === doc, doc.board.card(id)?.textCard?.look == t.look else { return }
    doc.edit(look == .box ? "Box" : "Text") {
      $0.setTextLook(id, look, x: at.x, y: at.y, width: t.wrap ? width : nil)
    }
  }

  /// A Text or Box selected alone floats over the cards around it (styles.css .card.text.sel.solo:not(.editing)), so
  /// its bar is not covered; what was raised goes back when the selection changes
  func raiseText() {
    let want = barCard.flatMap { index(of: .card($0.0)) }
    if let r = raised, r != want, r < items.count, items[r].box.zPosition == 0.5 { items[r].box.zPosition = 0 }
    if let w = want, items[w].box.zPosition == 0 { items[w].box.zPosition = 0.5 }
    raised = want
  }
}

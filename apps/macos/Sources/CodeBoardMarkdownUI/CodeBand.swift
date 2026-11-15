import AppKit
import CodeBoardMarkdown

/// A block's tool band (editor/band.ts, markdown.css .md-band): a 30 pt strip in the block's own colour (opaque, over the
/// paper) that grows upward out of the block's top edge over whatever is above it, the block and the Note never
/// resizing for it. Over text, the sliver of the covered line above it fades out; a soft shadow lifts it; two corner
/// squares turn the block's rounded top corners square, so band and block read as one shape. A code block's band
/// (its language, Copy, Wrap, ⋯) spans the block; a table's (its size, then as many actions as fit, the rest in ⋯)
/// spans the table, hanging past its right edge when the table is narrower than the size and ⋯. Only the inner strip
/// slides, clipped at the band's bottom edge, each time the band comes up for a block (a table's band then a code
/// block's both slide). It scales with the editor's zoom, as the block does
@MainActor
final class CodeBand: NSView {
  /// one control: an icon button, the language picker (its name and a chevron), or a table's size (a grid and R × C)
  struct Part: Equatable {
    enum Kind: Equatable {
      case icon(String)
      case language(String)
      case size(String)
      var isLanguage: Bool {
        if case .language = self { true } else { false }
      }
    }
    var id: String
    var kind: Kind
    var tip = ""
    var on = false
    /// a group gap before it (the table's action groups)
    var gapBefore = false
  }
  static let height: CGFloat = 30

  /// The row's text: the look's own UI family (.md-band-row: 12px var(--sys); Ink Wash's is its serif); `tabular`, a
  /// table's size, its digits all as wide (.md-tsize: tabular-nums)
  static func font(_ theme: MarkdownTheme?, size: CGFloat, tabular: Bool = false) -> NSFont {
    let font = theme.map { FontBook.font($0.fonts.body, size: size) as NSFont } ?? .systemFont(ofSize: size)
    guard tabular else { return font }
    let d = font.fontDescriptor.addingAttributes([
      .featureSettings: [
        [
          NSFontDescriptor.FeatureKey.typeIdentifier: kNumberSpacingType,
          NSFontDescriptor.FeatureKey.selectorIdentifier: kMonospacedNumbersSelector,
        ]
      ]
    ])
    return NSFont(descriptor: d, size: size) ?? font
  }
  /// the room around the band for its shadow and the fade above it (.md-band-clip's inset)
  static let margin: CGFloat = 18

  /// clips the sliding strip at the band's bottom edge; flipped like the band, so the strip's y counts from the top
  private let clip = Flipped()
  private let strip = Strip()
  private let corners = [CALayer(), CALayer()]
  /// a table's frame on each corner square (.md-band-table .md-band-cnr's borders): its top and its outer side, so the
  /// frame runs on unbroken from the band down past the table's rounded corner the square covers
  private let cornerLines = [CAShapeLayer(), CAShapeLayer()]
  var block: EditorCore.CodeBlock?
  /// What the band covers above its block (band.ts data-over): the block before it, a code block (a deeper shadow), or
  /// nothing (the first block: no fade)
  enum Above { case none, code, text }
  /// the table it is for, when it is a table's
  var table: Range<Int>?
  var shown = false
  /// which block it was last put over (a new one slides in again)
  private var key: AnyHashable?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    clip.wantsLayer = true
    clip.layer?.masksToBounds = true
    addSubview(clip)
    strip.wantsLayer = true
    clip.addSubview(strip)
    for (c, l) in zip(corners, cornerLines) {
      c.opacity = 0
      l.fillColor = nil
      c.addSublayer(l)
      layer?.addSublayer(c)
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }

  /// only its controls take presses; its blank part and the margin around it let them through
  override func hitTest(_ p: NSPoint) -> NSView? {
    guard shown else { return nil }
    let local = strip.convert(p, from: superview)
    return strip.part(at: local) == nil ? nil : strip
  }

  /// the strip's frame in the editor view's points (tests, checks)
  var stripFrame: CGRect {
    convert(strip.frame.insetBy(dx: strip.pad, dy: 0), from: clip).offsetBy(dx: frame.minX, dy: frame.minY)
  }

  /// a control's box in the band's own points, by its id
  func partRect(_ id: String) -> (Part, CGRect)? {
    strip.rects().first { $0.0.id == id }.map { ($0.0, convert($0.1, from: strip)) }
  }

  /// what it covers above its block, as last placed (tests)
  var above: Above { strip.above }

  /// the frame lines a table's band puts on its corner squares, each line's box (the middle of its stroke) in the editor
  /// view's points; none for a code block's or a corner not shown (tests)
  var cornerEdges: [CGRect] {
    zip(corners, cornerLines).compactMap { c, l in
      guard !c.isHidden, !l.isHidden, let p = l.path else { return nil }
      return p.boundingBox.offsetBy(dx: frame.minX + c.frame.minX, dy: frame.minY + c.frame.minY)
    }
  }

  /// the band's own box in the editor view's points (without the margin)
  var bandFrame: CGRect {
    CGRect(
      x: frame.minX + Self.margin * strip.zoom, y: frame.minY + Self.margin * strip.zoom,
      width: strip.frame.width - 2 * strip.pad,
      height: Self.height * strip.zoom)
  }

  /// Puts the band over `over` (the block's, or the table's, top edge and width in the editor view's points), scaled by
  /// `zoom`. `table`: a table's band (its header colour, a frame, 6 pt corners); `key` says which block it is for
  func place(
    over: CGRect, above: Above, key: AnyHashable, zoom: CGFloat, theme: MarkdownTheme, parts: [Part], fill: MDColor,
    table: Bool, radius: CGFloat
  ) {
    let m = Self.margin * zoom
    let h = Self.height * zoom
    strip.zoom = zoom
    strip.theme = theme
    strip.parts = parts
    strip.table = table
    strip.above = above
    strip.radius = radius * zoom
    // the band's colour over the paper: opaque, nothing shows through it
    strip.fill = theme.colors.surface.over(fill)
    // as wide as its block; a table's at least as wide as its size and ⋯, hanging past the table's right edge then
    let need = strip.leastWidth()
    let w = max(over.width, need)
    strip.hangs = table && w > over.width + 0.5
    strip.overWidth = over.width
    let fadeH = 10 * zoom
    // frames change at once: the strip's frame once moved by an animator (and the band's geometry under it) slid the
    // strip in from a stale place on the band's first show; the only motion is the slide's own translation
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    frame = CGRect(x: over.minX - m, y: over.minY - h - m, width: w + 2 * m, height: h + m + strip.radius)
    clip.frame = CGRect(x: 0, y: 0, width: frame.width, height: h + m)
    // the strip always stands in its place; hidden or sliding, it is offset only by the slide
    // with the margin on either side, where its shadow spreads (a view's drawing is cut at its own bounds: the shadow
    // stopped hard at the block's edges)
    strip.pad = m
    strip.frame = CGRect(x: 0, y: m - fadeH, width: w + 2 * m, height: h + fadeH)
    CATransaction.commit()
    if key != self.key {
      // a new block: the strip starts from below its edge, so it slides in for this one too
      self.key = key
      if shown {
        shown = false
        strip.layer?.removeAnimation(forKey: Self.slideKey)
        for c in corners { c.opacity = 0 }
        strip.showRow(false, animated: false)
      }
    }
    let face = strip.fill.cg
    let r = strip.radius
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    // the table's hairline, 1 pt at 100 % as the layout strokes it, its middle half a line in from the edge
    let lw = zoom
    for (i, c) in corners.enumerated() {
      c.frame = CGRect(x: i == 0 ? m : m + over.width - r, y: h + m, width: r, height: r)
      c.backgroundColor = face
      c.isHidden = i == 1 && strip.hangs
      let line = cornerLines[i]
      line.isHidden = !table
      guard table else { continue }
      line.frame = c.bounds
      let side = i == 0 ? lw / 2 : r - lw / 2
      let p = CGMutablePath()
      p.move(to: CGPoint(x: side, y: r))
      p.addLine(to: CGPoint(x: side, y: lw / 2))
      p.addLine(to: CGPoint(x: i == 0 ? r : 0, y: lw / 2))
      line.path = p
      line.lineWidth = lw
      line.strokeColor = theme.colors.hair.cg
    }
    CATransaction.commit()
    strip.needsDisplay = true
  }

  /// how many times it has slid in (tests)
  private(set) var slidesIn = 0

  static let slideKey = "slide"
  /// the strip's last slide (tests): up from below the band's bottom edge and back, along y only (.md-band-slide's
  /// translateY)
  private(set) var lastSlide: CABasicAnimation?

  func show(_ on: Bool) {
    guard on != shown else { return }
    shown = on
    if on { slidesIn += 1 } else { pointerIn = false }
    let below = (Self.height + 16) * strip.zoom
    // where nobody sees it (a window off screen or covered), it is simply in place: no slide left half done
    guard window.map({ $0.occlusionState.contains(.visible) }) ?? true else {
      strip.layer?.removeAnimation(forKey: Self.slideKey)
      for c in corners { c.opacity = on ? 1 : 0 }
      strip.showRow(on, animated: false)
      isHidden = !on
      return
    }
    strip.showRow(on, animated: true)
    // a slide under way turns back from where it has the strip
    let running = !isHidden && strip.layer?.animation(forKey: Self.slideKey) != nil
    let now = strip.layer?.presentation()?.value(forKeyPath: "transform.translation.y") as? CGFloat
    let from = running ? (now ?? (on ? below : 0)) : (on ? below : 0)
    isHidden = false
    let slide = CABasicAnimation(keyPath: "transform.translation.y")
    slide.fromValue = from
    slide.toValue = on ? 0 : below
    slide.duration = on ? MarkdownTiming.bandShow : MarkdownTiming.bandHide
    // .md-band-slide: in cubic-bezier(.33, 1, .68, 1), out (.32, 0, .67, 0)
    slide.timingFunction =
      on
      ? CAMediaTimingFunction(controlPoints: 0.33, 1, 0.68, 1)
      : CAMediaTimingFunction(controlPoints: 0.32, 0, 0.67, 0)
    slide.fillMode = .both
    // gone, the strip stays below until the band hides
    slide.isRemovedOnCompletion = on
    lastSlide = slide
    CATransaction.begin()
    CATransaction.setCompletionBlock {
      MainActor.assumeIsolated {
        guard !self.shown, self.lastSlide === slide else { return }
        self.isHidden = true
        self.strip.layer?.removeAnimation(forKey: Self.slideKey)
      }
    }
    strip.layer?.add(slide, forKey: Self.slideKey)
    CATransaction.commit()
    // the corner squares come after the strip has reached the block, and go first
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.duration = on ? 0.05 : 0.06
    fade.beginTime = CACurrentMediaTime() + (on ? MarkdownTiming.bandShow * 0.6 : 0)
    fade.fromValue = on ? 0 : 1
    fade.toValue = on ? 1 : 0
    fade.fillMode = .backwards
    for c in corners {
      c.opacity = on ? 1 : 0
      c.add(fade, forKey: "opacity")
    }
  }

  var onPart: (String, NSView, CGRect) -> Void = { _, _, _ in }
  /// the pointer is on the band: it stays up while it is, though the band may float past the Note's edge where the
  /// editor gets no moves (band.ts pointerenter "hover")
  private(set) var pointerIn = false
  var onPointer: () -> Void = {}
  fileprivate func pointer(_ inside: Bool) {
    guard inside != pointerIn else { return }
    pointerIn = inside
    onPointer()
  }

  /// what the band shows, drawn at the zoom: the fade above it, its face and its controls
  final class Strip: HoverControls {
    var zoom: CGFloat = 1
    var theme: MarkdownTheme?
    var parts: [Part] = []
    override func controls() -> [(id: String, box: CGRect, tip: String)] { rects().map { ($0.0.id, $0.1, $0.0.tip) } }
    /// how much its controls show: they fade in once the strip is on its way up and out at once as it goes
    /// (.md-band-row's opacity), the face sliding alone
    var row = Transition()
    override func easing(at now: Double) -> Bool { row.running(at: now) }
    func showRow(_ on: Bool, animated: Bool) {
      if animated {
        row.go(
          to: on ? 1 : 0, at: clock(), over: on ? MarkdownTiming.bandRowIn : MarkdownTiming.bandRowOut,
          delay: on ? MarkdownTiming.bandRowInDelay : 0)
      } else {
        row = Transition(on ? 1 : 0)
      }
      ease()
    }
    /// the delete actions: hovered in the warning colour (.md-bb.danger:hover)
    static let danger: Set<String> = ["delRow", "delCol"]
    // main's .md-bb has no :active; Luna asked for the board buttons' press here too (2026-11-15)
    override var pressInk: Double? { 0.12 }
    var fill = MDColor(0.95, 0.95, 0.95, 1)
    var radius: CGFloat = 12
    var table = false
    var above = Above.text
    var hangs = false
    var overWidth: CGFloat = 0
    override var isFlipped: Bool { true }

    private var fadeH: CGFloat { 10 * zoom }
    /// the room on either side of the face, for its shadow
    var pad: CGFloat = 0
    private var face: CGRect {
      CGRect(x: 0, y: fadeH, width: bounds.width - 2 * pad, height: CodeBand.height * zoom)
    }
    private var font: NSFont { CodeBand.font(theme, size: 12 * zoom) }
    private var mono: NSFont { CodeBand.font(theme, size: 12 * zoom, tabular: true) }
    private func width(_ s: String, _ f: NSFont) -> CGFloat { (s as NSString).size(withAttributes: [.font: f]).width }

    /// a control's width (unzoomed: .md-bb 26 + 1 between, the size and language buttons by their text)
    private func w(_ p: Part) -> CGFloat {
      switch p.kind {
      case .icon: 27 * zoom
      case .language(let name): min(160 * zoom, width(name, font) + 5 * zoom + 9 * zoom + 12 * zoom)
      case .size(let n): 6 * zoom + 14 * zoom + 6 * zoom + width(n, mono) + 8 * zoom
      }
    }

    /// the least width that holds the left control, the spacer and ⋯ (and the row's padding)
    func leastWidth() -> CGFloat {
      let left = parts.first { if case .icon = $0.kind { false } else { true } }
      let more = parts.last { $0.id == "more" }
      // a table's counts a group gap too (tableview.ts fit's fixed part)
      return (table ? 8 + 7 + 6 : 22 + 14) * zoom + (left.map(w) ?? 0) + 8 * zoom + (more.map(w) ?? 0)
    }

    /// where each control is: the size or language at the left, the buttons from the right edge back
    func rects() -> [(Part, CGRect)] { innerRects().map { ($0.0, $0.1.offsetBy(dx: pad, dy: 0)) } }

    /// the controls in the face's own points (its left edge at 0)
    private func innerRects() -> [(Part, CGRect)] {
      let y = face.minY + (face.height - 24 * zoom) / 2
      var out: [(Part, CGRect)] = []
      // a table's row starts after its frame's 1 pt line (.md-band-table: border-box, padding-left 8)
      var x = (table ? 9 : 22) * zoom
      // the last button at the row's right padding (a table's after its frame's line too); each one 1 pt from the one
      // before it (.md-bb + .md-bb), a group gap's 6 pt in place of that
      var right = face.width - (table ? 8 : 14) * zoom
      for p in parts.reversed() {
        if case .icon = p.kind {
          out.append((p, CGRect(x: right - 26 * zoom, y: y, width: 26 * zoom, height: 24 * zoom)))
          right -= (26 + (p.gapBefore ? 6 : 1)) * zoom
        }
      }
      for p in parts {
        if case .icon = p.kind { continue }
        let h: CGFloat = p.kind == .language("") || { if case .language = p.kind { true } else { false } }() ? 22 : 24
        x -= { if case .language = p.kind { 6 * zoom } else { 0 } }()
        out.append((p, CGRect(x: x, y: face.minY + (face.height - h * zoom) / 2, width: w(p), height: h * zoom)))
        x += w(p)
      }
      return out
    }

    func part(at p: CGPoint) -> Part? { rects().first { $0.1.contains(p) }?.0 }

    override func draw(_ dirtyRect: NSRect) {
      guard let theme, let ctx = NSGraphicsContext.current?.cgContext else { return }
      // its text as the Note's (BlockLayout.draw) and the page's: no smoothing, which drew light text on the dark looks
      // a weight heavier
      ctx.setShouldSmoothFonts(false)
      ctx.translateBy(x: pad, y: 0)
      let f = face
      // over text, the covered line's sliver above the band fades into the paper
      if above == .text,
        let fade = CGGradient(
          colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
          colors: [theme.colors.surface.alpha(0).cg, theme.colors.surface.cg] as CFArray, locations: [0, 1])
      {
        ctx.saveGState()
        ctx.clip(to: CGRect(x: 0, y: 0, width: f.width, height: fadeH))
        ctx.drawLinearGradient(
          fade, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: fadeH), options: [])
        ctx.restoreGState()
      }
      let r = radius
      let path = CGMutablePath()
      path.move(to: CGPoint(x: 0, y: f.maxY))
      path.addArc(tangent1End: CGPoint(x: 0, y: f.minY), tangent2End: CGPoint(x: r, y: f.minY), radius: r)
      path.addArc(
        tangent1End: CGPoint(x: f.maxX, y: f.minY), tangent2End: CGPoint(x: f.maxX, y: f.minY + r), radius: r)
      if hangs {
        path.addArc(
          tangent1End: CGPoint(x: f.maxX, y: f.maxY), tangent2End: CGPoint(x: f.maxX - r, y: f.maxY), radius: r)
        path.addLine(to: CGPoint(x: overWidth, y: f.maxY))
      } else {
        path.addLine(to: CGPoint(x: f.maxX, y: f.maxY))
      }
      path.addLine(to: CGPoint(x: 0, y: f.maxY))
      // one soft, wide shadow upward (no hairline on top, except a table's frame); over code a deeper one (.09 for .07)
      ctx.saveGState()
      let alpha = (table ? 0.10 : 0.13) * (above == .code ? 9 / 7 : 1)
      ctx.setShadow(
        offset: CGSize(width: 0, height: 4 * zoom), blur: 12 * zoom,
        color: CGColor(srgbRed: 50 / 255, green: 35 / 255, blue: 10 / 255, alpha: alpha))
      ctx.addPath(path)
      ctx.setFillColor(fill.cg)
      ctx.fillPath()
      ctx.restoreGState()
      if table {
        // the table's frame drawn on up around the band: its hairline (1 pt at 100 %, scaled as the table's is), on the
        // same lines as the table's sides, half a line in from its edges (box-sizing: border-box)
        let lw = zoom
        let h = lw / 2
        let edge = CGMutablePath()
        edge.move(to: CGPoint(x: h, y: f.maxY))
        edge.addArc(
          tangent1End: CGPoint(x: h, y: f.minY + h), tangent2End: CGPoint(x: r, y: f.minY + h), radius: r - h)
        edge.addArc(
          tangent1End: CGPoint(x: f.maxX - h, y: f.minY + h), tangent2End: CGPoint(x: f.maxX - h, y: f.minY + r),
          radius: r - h)
        edge.addLine(to: CGPoint(x: f.maxX - h, y: f.maxY))
        ctx.addPath(edge)
        ctx.setStrokeColor(theme.colors.hair.cg)
        ctx.setLineWidth(lw)
        ctx.strokePath()
      }
      let ink = theme.colors.ink.cg
      let ink2 = theme.colors.ink2.cg
      let ink3 = theme.colors.ink3.cg
      let shown = row.value(at: clock())
      guard shown > 0 else { return }
      ctx.beginTransparencyLayer(auxiliaryInfo: nil)
      defer { ctx.endTransparencyLayer() }
      ctx.setAlpha(CGFloat(shown))
      for (p, box) in innerRects() {
        let held = pressed == p.id
        let over = hovered == p.id || held
        let danger = over && Self.danger.contains(p.id)
        ctx.saveGState()
        defer { ctx.restoreGState() }
        if held {
          ctx.translateBy(x: box.midX, y: box.midY)
          ctx.scaleBy(x: Self.pressScale, y: Self.pressScale)
          ctx.translateBy(x: -box.midX, y: -box.midY)
        }
        if p.on || over {
          // .md-bb.on and :hover: the ink at 6.5 % behind it (the language picker 6 %), a delete in the warning's 14 %;
          // held, the board's pressed step (.tbtn:active 12 %), a delete's warning as much deeper
          let chip =
            danger
            ? theme.colors.warn.alpha(held ? 0.24 : 0.14)
            : theme.colors.ink.alpha(held ? 0.12 : p.kind.isLanguage ? 0.06 : 0.065)
          let k: CGFloat = p.kind.isLanguage ? 6 : 6.5
          ctx.addPath(CGPath(roundedRect: box, cornerWidth: k * zoom, cornerHeight: k * zoom, transform: nil))
          ctx.setFillColor(chip.cg)
          ctx.fillPath()
        }
        switch p.kind {
        case .icon(let name):
          icon(
            name, in: ctx, at: CGPoint(x: box.midX - 8 * zoom, y: box.midY - 8 * zoom), size: 16,
            color: danger ? theme.colors.warn.cg : p.on || over ? ink : ink3,
            width: name == "dots" ? 2 : 1.3)
        case .language(let name):
          text(name, font, over ? ink : ink2, at: CGPoint(x: box.minX + 6 * zoom, y: box.midY))
          icon(
            "down", in: ctx, at: CGPoint(x: box.maxX - 6 * zoom - 9 * zoom, y: box.midY - 4.5 * zoom), size: 9,
            color: ink3.copy(alpha: 0.8 * (ink3.alpha)) ?? ink3, width: 1.3)
        case .size(let n):
          icon(
            "grid", in: ctx, at: CGPoint(x: box.minX + 6 * zoom, y: box.midY - 7 * zoom), size: 14, color: ink3,
            width: 1.2)
          text(n, mono, over ? ink : ink2, at: CGPoint(x: box.minX + 26 * zoom, y: box.midY))
        }
      }
    }

    private func text(_ s: String, _ f: NSFont, _ c: CGColor, at p: CGPoint) {
      let a: [NSAttributedString.Key: Any] = [.font: f, .foregroundColor: NSColor(cgColor: c) ?? .secondaryLabelColor]
      let sz = (s as NSString).size(withAttributes: a)
      (s as NSString).draw(at: CGPoint(x: p.x, y: p.y - sz.height / 2), withAttributes: a)
    }

    /// an icon of the web's set at `size` points (its 16 grid scaled), stroked `width` thick on that grid
    private func icon(_ name: String, in ctx: CGContext, at o: CGPoint, size: CGFloat, color: CGColor, width: CGFloat) {
      guard let path = MarkdownIcons.path(name) else { return }
      let k = size / 16 * zoom
      ctx.saveGState()
      ctx.translateBy(x: o.x, y: o.y)
      ctx.scaleBy(x: k, y: k)
      ctx.addPath(path)
      ctx.setStrokeColor(color)
      ctx.setLineWidth(width)
      ctx.setLineCap(.round)
      ctx.setLineJoin(.round)
      ctx.strokePath()
      ctx.restoreGState()
    }

    override func mouseEntered(with e: NSEvent) {
      super.mouseEntered(with: e)
      (superview?.superview as? CodeBand)?.pointer(true)
    }
    override func mouseExited(with e: NSEvent) {
      super.mouseExited(with: e)
      (superview?.superview as? CodeBand)?.pointer(false)
    }

    override func activate(_ id: String, box: CGRect) {
      (superview?.superview as? CodeBand)?.onPart(id, self, box)
    }
  }
}

/// a plain view whose y counts from the top
final class Flipped: NSView {
  override var isFlipped: Bool { true }
}

extension MDColor {
  /// this colour with `top` laid over it (the band's colour over the paper)
  func over(_ top: MDColor) -> MDColor {
    let a = top.a
    return MDColor(r * (1 - a) + top.r * a, g * (1 - a) + top.g * a, b * (1 - a) + top.b * a, 1)
  }
}

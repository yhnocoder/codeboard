import AppKit
import CodeBoardModel

// The toolbar at the bottom of the board (Chrome.tsx .bbar), as the web board draws it in each look (its computed
// styles measured in Chromium): in Warm Ink a glass pill over the board, blurred under it; in Ink Wash one pale stroke
// of ink with a brush resting at its end (state/ink.ts barSvg). Its buttons are 30 × 28 with a 16-unit icon. The tools
// are laid out in the web board's order; those not made here yet are left out.

/// A tool of the toolbar, in its order
public enum Tool: CaseIterable, Sendable {
  case note, text, box, image, web, section, arrow, sticker

  /// What can be made from the Mac app's toolbar now
  public static let made: [Tool] = [.note, .text, .box]

  var name: String {
    switch self {
    case .note: "Note"
    case .text: "Text"
    case .box: "Box"
    case .image: "Image"
    case .web: "Web"
    case .section: "Section"
    case .arrow: "Arrow"
    case .sticker: "Sticker"
    }
  }

  var icon: CGPath? {
    switch self {
    case .note: Icons.note()
    case .text: Icons.text()
    case .box: Icons.box()
    default: nil
    }
  }
}

@MainActor
public final class CanvasToolbar: NSView {
  public var onTool: ((Tool) -> Void)?
  public private(set) var tools: [Tool] = Tool.made
  public var theme: Theme = .warmInk {
    didSet { if !theme.same(as: oldValue) { restyle() } }
  }
  private var hover: Int? {
    didSet { if hover != oldValue { draw() } }
  }
  private var pressed: Int? {
    didSet { if pressed != oldValue { draw() } }
  }
  /// The board blurred under the glass (Warm Ink's backdrop-filter)
  private let glass = NSVisualEffectView()
  private let face = CALayer()
  /// Room around the bar in the view for its shadow and Ink Wash's brush
  public static let margin: CGFloat = 32

  public override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    glass.blendingMode = .withinWindow
    glass.material = .underWindowBackground
    glass.state = .active
    glass.wantsLayer = true
    addSubview(glass)
    layer?.addSublayer(face)
    restyle()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("CanvasToolbar is not loaded from nibs") }

  /// The bar's own size (without the room around it)
  var barSize: CGSize {
    let n = CGFloat(tools.count)
    return theme.id == .inkWash
      ? CGSize(width: 22 + n * 30 + (n - 1) * 1 + 34, height: 46) : CGSize(width: 8 + n * 30 + (n - 1) * 2, height: 36)
  }

  public override var intrinsicContentSize: NSSize {
    CGSize(width: barSize.width + 2 * Self.margin, height: barSize.height + 2 * Self.margin)
  }

  /// Where the bar is in the view (flipped: from the top left)
  var barRect: CGRect { CGRect(origin: CGPoint(x: Self.margin, y: Self.margin), size: barSize) }

  public override var isFlipped: Bool { true }

  /// Each button's rect in the view
  func buttonRects() -> [CGRect] {
    let b = barRect
    return tools.indices.map { i in
      theme.id == .inkWash
        ? CGRect(x: b.minX + 22 + CGFloat(i) * 31, y: b.minY + 9, width: 30, height: 28)
        : CGRect(x: b.minX + 4 + CGFloat(i) * 32, y: b.minY + 4, width: 30, height: 28)
    }
  }

  private func restyle() {
    invalidateIntrinsicContentSize()
    glass.isHidden = theme.id == .inkWash
    appearance = NSAppearance(named: theme.dark ? .darkAqua : .aqua)
    needsLayout = true
    draw()
  }

  public override func layout() {
    super.layout()
    glass.frame = barRect
    glass.layer?.cornerRadius = 14
    glass.layer?.masksToBounds = true
    draw()
  }

  public override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    draw()
  }

  private func draw() {
    let scale = window?.backingScaleFactor ?? 2
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    face.frame = bounds
    face.contentsScale = scale
    face.contents = Self.image(
      size: bounds.size, bar: barRect, buttons: buttonRects(), tools: tools, theme: theme, hover: hover,
      pressed: pressed, scale: scale)
    CATransaction.commit()
  }

  // MARK: Drawing

  /// The toolbar as one bitmap: its shadow and glass tint (Warm Ink) or its stroke of ink and brush (Ink Wash), and
  /// its buttons
  static func image(
    size: CGSize, bar: CGRect, buttons: [CGRect], tools: [Tool], theme: Theme, hover: Int?, pressed: Int?,
    scale: CGFloat
  ) -> CGImage? {
    let w = Int((size.width * scale).rounded(.up))
    let h = Int((size.height * scale).rounded(.up))
    guard w > 0, h > 0,
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
    else { return nil }
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: scale, y: -scale)
    let look = BarLook.of(theme)
    let ink = look.ink
    if theme.id == .inkWash {
      inkStroke(bar, dark: theme.dark, in: ctx)
    } else {
      // themes.css: --wi-glass over the blur, the float shadow, a hairline and a light line inside the top
      let glass =
        theme.dark
        ? CGColor(srgbRed: 40 / 255, green: 39 / 255, blue: 36 / 255, alpha: 0.6)
        : CGColor(srgbRed: 250 / 255, green: 248 / 255, blue: 244 / 255, alpha: 0.62)
      let top =
        theme.dark
        ? CGColor(srgbRed: 1, green: 245 / 255, blue: 230 / 255, alpha: 0.13) : CGColor(gray: 1, alpha: 1)
      WritingBar.float(bar, radius: 14, look: look, glass: glass, scale: scale, in: ctx)
      ctx.saveGState()
      ctx.addPath(CGPath(roundedRect: bar, cornerWidth: 14, cornerHeight: 14, transform: nil))
      ctx.clip()
      ctx.setFillColor(top)
      ctx.fill(CGRect(x: bar.minX, y: bar.minY, width: bar.width, height: 0.5))
      ctx.restoreGState()
    }
    for (i, r) in buttons.enumerated() {
      let lit = hover == i || pressed == i
      if lit {
        if theme.id == .inkWash {
          // a small blot of ink spreading under the icon
          let blot = r.insetBy(dx: 2, dy: 1)
          ctx.saveGState()
          ctx.addEllipse(in: blot)
          ctx.clip()
          let g = CGGradient(
            colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
            colors: [ink.copy(alpha: 0.13)!, ink.copy(alpha: 0)!]
              as CFArray, locations: [0, 1])!
          ctx.translateBy(x: blot.midX, y: blot.midY)
          ctx.scaleBy(x: blot.width / blot.height, y: 1)
          ctx.drawRadialGradient(
            g, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: blot.height / 2, options: [])
          ctx.restoreGState()
        } else {
          ctx.addPath(CGPath(roundedRect: r, cornerWidth: 8.5, cornerHeight: 8.5, transform: nil))
          ctx.setFillColor(ink.copy(alpha: pressed == i ? 0.12 : 0.07)!)
          ctx.fillPath()
        }
      }
      let color = theme.id == .inkWash || lit ? ink : look.ink2
      if let icon = tools[i].icon {
        Icons.stroke(icon, at: CGPoint(x: r.minX + 7, y: r.minY + 6), color: color, in: ctx)
      }
    }
    return ctx.makeImage()
  }

  /// Ink Wash's bar: one pale stroke of ink over a veil of paper, its edges rising and falling a little, a round darker
  /// start, a dry tail (state/ink.ts barSvg, drawn on a 400 × 46 square stretched to the bar), and the brush at its end
  static func inkStroke(_ bar: CGRect, dark: Bool, in ctx: CGContext) {
    let paper =
      dark
      ? CGColor(srgbRed: 28 / 255, green: 27 / 255, blue: 25 / 255, alpha: 0.55)
      : CGColor(srgbRed: 253 / 255, green: 253 / 255, blue: 251 / 255, alpha: 0.55)
    let ink =
      dark
      ? CGColor(srgbRed: 233 / 255, green: 229 / 255, blue: 218 / 255, alpha: 1)
      : CGColor(srgbRed: 29 / 255, green: 28 / 255, blue: 26 / 255, alpha: 1)
    let shape = strokePath()
    ctx.saveGState()
    ctx.translateBy(x: bar.minX, y: bar.minY)
    ctx.scaleBy(x: bar.width / 400, y: bar.height / 46)
    ctx.addPath(shape)
    ctx.setFillColor(paper)
    ctx.fillPath()
    // the stroke, its dry streaks cut out of it
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    let o: CGFloat = dark ? 0.11 : 0.1
    ctx.saveGState()
    ctx.addPath(shape)
    ctx.clip()
    let g = CGGradient(
      colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
      colors: [ink.copy(alpha: o * 1.6)!, ink.copy(alpha: o)!, ink.copy(alpha: o * 0.8)!] as CFArray,
      locations: [0, 0.25, 1])!
    let b = shape.boundingBox
    ctx.drawLinearGradient(g, start: CGPoint(x: b.minX, y: 0), end: CGPoint(x: b.maxX, y: 0), options: [])
    ctx.restoreGState()
    ctx.setBlendMode(.destinationOut)
    ctx.setLineCap(.round)
    for i in 0..<9 {
      let fi = CGFloat(i)
      let y = 11 + fi * 3.1 + CGFloat(i % 2) * 0.7
      let a = CGFloat(262 + (i * 53) % 90)
      let e = CGFloat(400 - 4 - (i * 29) % 40)
      let p = CGMutablePath()
      p.move(to: CGPoint(x: a, y: y))
      p.addQuadCurve(
        to: CGPoint(x: e, y: y + 0.3), control: CGPoint(x: (a + e) / 2, y: y + (i % 2 == 1 ? 0.8 : -0.6)))
      ctx.addPath(p)
      ctx.setLineWidth(0.35 + CGFloat(i % 3) * 0.35)
      ctx.setStrokeColor(CGColor(gray: 0, alpha: 1))
      ctx.strokePath()
    }
    ctx.endTransparencyLayer()
    ctx.restoreGState()
    // the brush: right -4, top 6, 10 × 46, turned 72°, with a soft shadow
    if let pen = brush {
      ctx.saveGState()
      let c = CGPoint(x: bar.maxX + 4 - 5, y: bar.minY + 6 + 23)
      ctx.translateBy(x: c.x, y: c.y)
      ctx.rotate(by: 72 * .pi / 180)
      ctx.setShadow(offset: CGSize(width: 1, height: -2), blur: 1.5, color: CGColor(gray: 0, alpha: 0.25))
      // the picture is 16 × 84, contained in 10 × 46
      let k = min(10 / 16, 46 / 84.0)
      let r = CGRect(x: -16 * k / 2, y: -84 * k / 2, width: 16 * k, height: 84 * k)
      ctx.translateBy(x: 0, y: r.midY * 2)
      ctx.scaleBy(x: 1, y: -1)
      ctx.draw(pen, in: r)
      ctx.restoreGState()
    }
  }

  static func strokePath() -> CGPath {
    func r1(_ v: CGFloat) -> CGFloat { (v * 10).rounded() / 10 }
    var top: [CGPoint] = []
    var bot: [CGPoint] = []
    var x: CGFloat = 14
    while x <= 372 {
      top.append(CGPoint(x: x, y: r1(8.5 + 1.1 * sin(x * 0.045) + 0.6 * sin(x * 0.17 + 1))))
      bot.append(CGPoint(x: x, y: r1(37.5 + 1.2 * sin(x * 0.038 + 2) + 0.5 * sin(x * 0.21))))
      x += 6
    }
    let tail: [CGPoint] = [(380, 10), (392, 13.5), (384, 17), (396, 22), (386, 27), (394, 31.5), (378, 36.5)].map {
      CGPoint(x: $0.0, y: $0.1)
    }
    let p = CGMutablePath()
    p.move(to: top[0])
    for q in top.dropFirst() + tail + bot.reversed() { p.addLine(to: q) }
    p.addCurve(to: CGPoint(x: 14, y: 8.5), control1: CGPoint(x: 4, y: 38), control2: CGPoint(x: 2, y: 9))
    p.closeSubpath()
    return p
  }

  /// The brush resting on the bar (themes.css .bbar .pill::after), drawn once
  static let brush: CGImage? = {
    let svg = """
      <svg xmlns='http://www.w3.org/2000/svg' width='64' height='336' viewBox='0 0 16 84'><defs>\
      <linearGradient id='h' x1='0' x2='1'><stop offset='0' stop-color='#6b4a26'/><stop offset='.45' \
      stop-color='#c79a5c'/><stop offset='1' stop-color='#5a3c1c'/></linearGradient><linearGradient id='t' x1='0' \
      x2='1'><stop offset='0' stop-color='#111'/><stop offset='.45' stop-color='#444'/><stop offset='1' \
      stop-color='#0b0b0b'/></linearGradient></defs><path d='M8 1.5a1.6 1.6 0 0 1 0 3.2' fill='none' \
      stroke='#b0322a' stroke-width='1'/><rect x='5' y='4' width='6' height='50' rx='2.6' fill='url(#h)'/><path \
      d='M5.4 22h5.2M5.4 40h5.2' stroke='#5a3c1c' stroke-width='.7' opacity='.7'/><rect x='4.6' y='52' \
      width='6.8' height='5' rx='1.2' fill='#222'/><path d='M4.8 57c0 8 1.6 16 3.2 25 1.6-9 3.2-17 3.2-25z' \
      fill='url(#t)'/></svg>
      """
    guard let image = NSImage(data: Data(svg.utf8)) else { return nil }
    var r = CGRect(x: 0, y: 0, width: 64, height: 336)
    return image.cgImage(forProposedRect: &r, context: nil, hints: nil)
  }()

  // MARK: Pointer

  public override func hitTest(_ point: NSPoint) -> NSView? {
    guard let sv = superview else { return nil }
    return barRect.contains(convert(point, from: sv)) ? self : nil
  }

  public override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas { removeTrackingArea(t) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
        owner: self))
  }

  func button(at p: CGPoint) -> Int? { buttonRects().firstIndex { $0.contains(p) } }

  public override func mouseMoved(with e: NSEvent) { hover = button(at: convert(e.locationInWindow, from: nil)) }
  public override func mouseExited(with e: NSEvent) { hover = nil }
  public override func mouseDown(with e: NSEvent) { pressed = button(at: convert(e.locationInWindow, from: nil)) }

  public override func mouseUp(with e: NSEvent) {
    let at = button(at: convert(e.locationInWindow, from: nil))
    defer { pressed = nil }
    guard let at, at == pressed else { return }
    onTool?(tools[at])
  }

  public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

extension CanvasView {
  /// A tool of the toolbar: a new Note, Text or Box in the middle of the view, written in at once
  public func use(_ tool: Tool) {
    switch tool {
    case .note: createInView(.note)
    case .text: createInView(.text(.text))
    case .box: createInView(.text(.box))
    default: break
    }
  }
}

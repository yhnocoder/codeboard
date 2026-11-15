import AppKit

// The group at the bottom right (Chrome.tsx Dock): the Shelf, Zoom Out, the zoom figure, Zoom In, Fit to Window and,
// while any are open, the questions, in a pill as the bottom toolbar's (Ink Wash: its stroke, without the brush). Call
// Tree and Arrow Legend are not made here yet.

/// The bottom right group of the board
@MainActor
package final class CanvasDock: NSView {
  package enum Part: CaseIterable {
    case shelf, zoomOut, zoom, zoomIn, fit, questions

    var name: String {
      switch self {
      case .shelf: "shelf"
      case .zoomOut: "zoomout"
      case .zoom: "zoom"
      case .zoomIn: "zoomin"
      case .fit: "fit"
      case .questions: "questions"
      }
    }

    var label: String {
      switch self {
      case .shelf: "Shelf"
      case .zoomOut: "Zoom Out"
      case .zoom: "Zoom to 100%"
      case .zoomIn: "Zoom In"
      case .fit: "Fit to Window"
      case .questions: "Questions"
      }
    }
  }

  /// icons.tsx minus, plus, fit
  private static let icons: [Part: CGPath] = [
    .zoomOut: SVGPath.parse("M3 8h10"), .zoomIn: SVGPath.parse("M8 3v10M3 8h10"),
    .fit: SVGPath.parse(
      "M2 5V2.5A.5 .5 0 0 1 2.5 2H5M11 2H13.5A.5 .5 0 0 1 14 2.5V5M14 11V13.5A.5 .5 0 0 1 13.5 14H11M5 14H2.5A.5 .5 0 0 1 2 13.5V11"
    ),
  ]

  package var onPart: ((Part) -> Void)?
  package var theme: Theme {
    didSet { if !theme.same(as: oldValue) { restyle() } }
  }
  /// How many entries the Shelf holds: on its badge
  package var count = 0 {
    didSet { if count != oldValue { draw() } }
  }
  /// The Shelf's panel is open
  var open = false {
    didSet { if open != oldValue { draw() } }
  }
  /// Cards are being dragged: the Shelf would take them; the pointer is over it
  var armed = false {
    didSet { if armed != oldValue { draw() } }
  }
  var hot = false {
    didSet { if hot != oldValue { draw() } }
  }
  /// The camera's zoom, shown as a whole percentage
  package var zoom: CGFloat = 1 {
    didSet { if Self.percent(zoom) != Self.percent(oldValue) { draw() } }
  }
  /// How many of this board's questions are open: their button shows while there are any, or while the list is open
  /// (ui/QuestionList.tsx)
  package var questions = 0 {
    didSet { if questions != oldValue { restyle() } }
  }
  package var listOpen = false {
    didSet { if listOpen != oldValue { restyle() } }
  }
  private var hover: Part? {
    didSet { if hover != oldValue { draw() } }
  }
  private var pressed: Part? {
    didSet { if pressed != oldValue { draw() } }
  }
  let glass = CanvasToolbar.makeGlass()
  private var masked = ""
  /// The pill, its zoom figure and other buttons, drawn; the Shelf's button over it in layers of its own, which bump
  private let faceView = LayerView()
  private var face: CALayer { faceView.layer! }
  private let over = CALayer()
  private let shelf = CALayer()
  private let shelfIcon: CAShapeLayer
  private let badge = CATextLayer()
  /// Room around the pill in the face for its shadow
  private static let margin: CGFloat = 32

  package init(theme: Theme) {
    self.theme = theme
    shelfIcon = ShelfLook.icon(ShelfLook.shelf, size: 16, color: theme.ink2)
    super.init(frame: .zero)
    wantsLayer = true
    addSubview(glass)
    faceView.wantsLayer = true
    addSubview(faceView)
    // the Shelf's button laid out y-down, as the bitmap under it is drawn (AppKit keeps the face's own geometry)
    over.isGeometryFlipped = true
    face.addSublayer(over)
    over.addSublayer(shelf)
    shelf.addSublayer(shelfIcon)
    badge.alignmentMode = .center
    badge.font = NSFont.systemFont(ofSize: 9, weight: .semibold)
    badge.fontSize = 9
    badge.contentsScale = 2
    over.addSublayer(badge)
    restyle()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("CanvasDock is not loaded from nibs") }

  package override var isFlipped: Bool { true }

  static func percent(_ z: CGFloat) -> String { "\(Int((z * 100).rounded()))%" }
  static let zoomFont = Font.board("JetBrainsMono-400-600", size: 11.5, weight: 400) ?? Font.mono(11.5, .regular)
  static let countFont = Font(NSFont.systemFont(ofSize: 12, weight: .semibold))
  static let askFont = Font(NSFont.systemFont(ofSize: 11, weight: .bold))

  var showsQuestions: Bool { questions > 0 || listOpen }

  /// Where each part is, the separators and the pill's size: .pill's padding 4 and gap 2, buttons (.ib) 26 square, the
  /// zoom figure 44 wide, separators 0.5 with 4 each side, the questions button 2 in on each side (.qlist-btn: 4 + the
  /// 16 ? + 5 + the count + 8); Ink Wash 46 tall with 18 before, 26 after and a gap of 1
  func layoutParts() -> (parts: [Part: CGRect], seps: [CGRect], size: CGSize) {
    let ink = theme.id == .inkWash
    let gap: CGFloat = ink ? 1 : 2
    let h: CGFloat = ink ? 46 : 34
    let mid = h / 2
    var x: CGFloat = ink ? 18 : 4
    var parts: [Part: CGRect] = [:]
    var seps: [CGRect] = []
    func put(_ p: Part, _ w: CGFloat, _ ph: CGFloat) {
      parts[p] = CGRect(x: x, y: mid - ph / 2, width: w, height: ph)
      x += w + gap
    }
    func sep() {
      seps.append(CanvasToolbar.sep(x: x, midY: mid))
      x += 8.5 + gap
    }
    put(.shelf, 26, 26)
    sep()
    put(.zoomOut, 26, 26)
    put(.zoom, 44, 19)
    put(.zoomIn, 26, 26)
    sep()
    put(.fit, 26, 26)
    if showsQuestions {
      sep()
      x += 2
      put(.questions, 33 + Drawing.width("\(questions)", Self.countFont).rounded(.up), 24)
      x += 2
    }
    return (parts, seps, CGSize(width: x - gap + (ink ? 26 : 4), height: h))
  }

  /// The pill's size
  package var size: CGSize { layoutParts().size }

  /// A part's rect in this view, while it shows
  package func rect(_ p: Part) -> CGRect? { layoutParts().parts[p] }

  private func restyle() {
    appearance = NSAppearance(named: theme.dark ? .darkAqua : .aqua)
    // a new size: the board puts it back at its corner
    if frame.size != size { (superview as? CanvasView)?.placeShelf() }
    needsLayout = true
    draw()
  }

  package override func layout() {
    super.layout()
    glass.frame = bounds
    CanvasToolbar.mask(glass, theme, &masked)
    draw()
  }

  package override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    draw()
  }

  private func draw() {
    let t = theme
    let ink = t.id == .inkWash
    let scale = window?.backingScaleFactor ?? 2
    let m = Self.margin
    let l = layoutParts()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    faceView.frame = bounds.insetBy(dx: -m, dy: -m)
    face.contentsScale = scale
    over.frame = face.bounds
    face.contents = CanvasToolbar.bitmap(faceView.frame.size, scale: scale) { ctx in
      ctx.translateBy(x: m, y: m)
      self.drawPill(l, in: ctx)
    }
    // the Shelf's button (.shelf-btn): open as the pressed buttons (Warm Ink the row tint and the accent, Ink Wash a
    // vermilion dot under it), ringed in the accent while cards are dragged, filled with it under the pointer
    if let r = l.parts[.shelf] {
      shelf.frame = r.offsetBy(dx: m, dy: m)
      shelf.cornerRadius = ink ? 2 : 8.5
      shelf.backgroundColor =
        hot ? t.accent : ink ? nil : open ? t.hlrow : hover == .shelf ? t.ink.copy(alpha: 0.07) : nil
      shelf.borderWidth = armed && !hot ? 1 : 0
      shelf.borderColor = t.accent.copy(alpha: 0.55)
      shelfIcon.position = CGPoint(x: 13, y: 13)
      shelfIcon.strokeColor =
        hot ? t.accentInk : ink ? t.ink : armed || open ? t.accent : hover == .shelf ? t.ink : t.ink2
      shelf.setAffineTransform(hot ? CGAffineTransform(scaleX: 1.15, y: 1.15) : .identity)
      badge.isHidden = count == 0
      badge.string = "\(count)"
      let w = max(
        13,
        (("\(count)" as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 9, weight: .semibold)]).width
          + 6).rounded(.up))
      badge.frame = CGRect(x: shelf.frame.maxX + 2 - w, y: shelf.frame.minY - 2, width: w, height: 13)
      badge.cornerRadius = 6.5
      badge.backgroundColor = hot ? t.accentInk : t.accent
      badge.foregroundColor = hot ? t.accent : t.accentInk
    }
    CATransaction.commit()
  }

  /// The pill and every part but the Shelf's button, in a y-down context with the pill's top left at the origin
  private func drawPill(_ l: (parts: [Part: CGRect], seps: [CGRect], size: CGSize), in ctx: CGContext) {
    let t = theme
    let ink = t.id == .inkWash
    let look = BarLook.of(t)
    let scale = window?.backingScaleFactor ?? 2
    CanvasToolbar.pill(CGRect(origin: .zero, size: l.size), theme: t, scale: scale, brush: false, in: ctx)
    for s in l.seps { CanvasToolbar.drawSep(s, theme: t, look: look, in: ctx) }
    // the bitmap is drawn y-down: its text upright
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    for (p, r) in l.parts {
      let lit = hover == p || pressed == p
      switch p {
      case .shelf:
        if ink && lit && !hot { CanvasToolbar.lit(r, theme: t, ink: look.ink, pressed: false, in: ctx) }
        if ink && open {
          ctx.addEllipse(in: CGRect(x: r.midX - 2, y: r.maxY + 1 - 4, width: 4, height: 4))
          ctx.setFillColor(t.accent)
          ctx.fillPath()
        }
      case .zoomOut, .zoomIn, .fit:
        if lit { CanvasToolbar.lit(r, theme: t, ink: look.ink, pressed: pressed == p, in: ctx) }
        if let icon = Self.icons[p] {
          Icons.stroke(
            icon, at: CGPoint(x: r.minX + 5, y: r.minY + 5), color: ink || lit ? look.ink : look.ink2, in: ctx)
        }
      case .zoom:
        // .zoom: 11.5 mono in --ink-2, the row tint under the pointer
        if hover == .zoom {
          ctx.addPath(
            CGPath(roundedRect: r, cornerWidth: ink ? 2 : 7, cornerHeight: ink ? 2 : 7, transform: nil))
          ctx.setFillColor(t.hlrow)
          ctx.fillPath()
        }
        let text = Self.percent(zoom)
        let w = Drawing.width(text, Self.zoomFont)
        Drawing.text(ctx, text, Self.zoomFont, look.ink2, x: r.midX - w / 2, midY: r.midY, width: .infinity)
      case .questions:
        // .qlist-btn: the amber at 14 % under an amber ? and the count; 24 % under the pointer or open; grey with
        // none open
        let none = questions == 0
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: r.height / 2, cornerHeight: r.height / 2, transform: nil))
        ctx.setFillColor(none ? t.hlrow : t.ask.copy(alpha: lit || listOpen ? 0.24 : 0.14) ?? t.ask)
        ctx.fillPath()
        let dot = CGRect(x: r.minX + 4, y: r.midY - 8, width: 16, height: 16)
        ctx.addEllipse(in: dot)
        ctx.setFillColor(none ? t.ink3 : t.ask)
        ctx.fillPath()
        let qw = Drawing.width("?", Self.askFont)
        Drawing.text(ctx, "?", Self.askFont, t.askInk, x: dot.midX - qw / 2, midY: dot.midY, width: .infinity)
        Drawing.text(
          ctx, "\(questions)", Self.countFont, none ? t.ink3 : CanvasView.mix(t.ask, 0.8, t.ink), x: dot.maxX + 5,
          midY: r.midY, width: .infinity)
      }
    }
  }

  /// What flew in arrives: the Shelf's button bumps (scale 1.2, 260 ms)
  func bump(after delay: CFTimeInterval) {
    let a = CAKeyframeAnimation(keyPath: "transform.scale")
    a.values = [1, 1.2, 1]
    a.keyTimes = [0, 0.4, 1]
    a.duration = 0.26
    a.beginTime = CACurrentMediaTime() + delay
    shelf.add(a, forKey: "bump")
  }

  // MARK: Pointer

  func part(at p: CGPoint) -> Part? { layoutParts().parts.first { $0.value.contains(p) }?.key }

  package override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas where t.owner === self { removeTrackingArea(t) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
  }

  package override func mouseMoved(with e: NSEvent) { hover = part(at: convert(e.locationInWindow, from: nil)) }
  package override func mouseExited(with e: NSEvent) { hover = nil }
  package override func mouseDown(with e: NSEvent) {
    pressed = part(at: convert(e.locationInWindow, from: nil))
  }
  package override func mouseUp(with e: NSEvent) {
    let at = part(at: convert(e.locationInWindow, from: nil))
    defer { pressed = nil }
    guard let at, at == pressed else { return }
    onPart?(at)
  }
  package override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  // the parts as accessibility elements (ui-dock, ui-shelf…), which the acceptance tool measures
  package override func isAccessibilityElement() -> Bool { true }
  package override func accessibilityRole() -> NSAccessibility.Role? { .group }
  package override func accessibilityIdentifier() -> String { "ui-dock" }
  package override func accessibilityChildren() -> [Any]? {
    let b = bounds
    return layoutParts().parts.map { uiElement($0.key.name, $0.value, label: $0.key.label, in: self) } + [
      uiElement("dockink", theme.id == .inkWash ? CanvasToolbar.inkBody(b) : b, in: self),
      uiElement("dockblur", glass.isHidden ? CGRect(origin: b.origin, size: .zero) : glass.frame, in: self),
    ]
  }
}

extension CanvasView {
  /// A part of the dock clicked
  package func useDock(_ p: CanvasDock.Part) {
    switch p {
    case .shelf: toggleShelf()
    case .zoomOut: zoom(by: 0.8)
    case .zoom: zoomTo100()
    case .zoomIn: zoom(by: 1.25)
    case .fit: fitAll()
    case .questions:
      if let r = dock.rect(.questions) { toggleQuestionList(under: dock.convert(r, to: self)) }
    }
  }
}

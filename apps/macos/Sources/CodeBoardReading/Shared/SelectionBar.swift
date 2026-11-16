import AppKit

// What PDF and web tabs share: the bar over a selection and where it goes. Nothing here knows how a tab shows its
// text; a tab gives the bar its buttons and the selection's lines.

/// A button of a selection bar: its SF Symbol, its name (the tooltip), its accessibility identifier, what it does
public struct SelectionAction {
  public var icon: String
  public var name: String
  public var id: String
  public var run: @MainActor () -> Void

  public init(icon: String, name: String, id: String, run: @escaping @MainActor () -> Void) {
    self.icon = icon
    self.name = name
    self.id = id
    self.run = run
  }
}

/// The small floating bar over a selection: its buttons in order, in the look of the board's bars in its theme
/// (ReadingBarLook)
public final class SelectionBar: NSView {
  public let buttons: [NSButton]
  private let actions: [SelectionAction]
  public var look: ReadingBarLook {
    didSet {
      setFrameSize(size)
      needsLayout = true
    }
  }
  private let glass = NSVisualEffectView()
  private let tint = NSView()

  /// `id`: the bar's accessibility identifier
  public init(
    _ actions: [SelectionAction], id: String = "ui-selectionbar", look: ReadingBarLook = .warmInk(dark: false)
  ) {
    self.actions = actions
    self.look = look
    buttons = actions.map { a in
      let b = BarButton(radius: look.buttonRadius)
      b.image = NSImage(systemSymbolName: a.icon, accessibilityDescription: a.name)
      b.toolTip = a.name
      b.setAccessibilityIdentifier(a.id)
      b.setAccessibilityLabel(a.name)
      return b
    }
    super.init(frame: .zero)
    setAccessibilityIdentifier(id)
    setAccessibilityElement(true)
    setAccessibilityRole(.toolbar)
    wantsLayer = true
    for v in [glass, tint] + buttons { addSubview(v) }
    for (i, b) in buttons.enumerated() {
      b.target = self
      b.action = #selector(pressed(_:))
      b.tag = i
    }
    setFrameSize(size)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("SelectionBar is not loaded from nibs") }

  public override var isFlipped: Bool { true }

  /// Its buttons shown, side by side, 4 in and 2 apart, as the board toolbar's
  public var size: CGSize {
    let n = CGFloat(buttons.count { !$0.isHidden })
    return CGSize(width: 8 + n * look.button.width + max(0, n - 1) * 2, height: look.height)
  }

  @objc private func pressed(_ sender: NSButton) { actions[sender.tag].run() }

  public override func layout() {
    super.layout()
    let y = ((bounds.height - look.button.height) / 2).rounded()
    for (i, b) in buttons.filter({ !$0.isHidden }).enumerated() {
      b.frame = CGRect(
        x: 4 + CGFloat(i) * (look.button.width + 2), y: y, width: look.button.width, height: look.button.height)
    }
    Self.paint(self, glass: glass, tint: tint, look: look)
    for case let b as BarButton in buttons { b.ink(look) }
  }

  /// CanvasToolbar.pill's glass, hairline and float shadow, in the look's theme, over the whole of `bar` (its glass
  /// and tint views under everything else in it): what every floating bar of a tab is drawn on
  static func paint(_ bar: NSView, glass: NSVisualEffectView, tint: NSView, look: ReadingBarLook) {
    let r = bar.bounds
    glass.state = .active
    glass.frame = r
    glass.material = look.material
    glass.blendingMode = look.blending
    glass.maskImage = NSImage(size: r.size, flipped: true) { b in
      NSBezierPath(roundedRect: b, xRadius: look.radius, yRadius: look.radius).fill()
      return true
    }
    tint.frame = r
    tint.wantsLayer = true
    bar.wantsLayer = true
    bar.appearance = NSAppearance(named: look.dark ? .darkAqua : .aqua)
    guard let t = tint.layer, let me = bar.layer else { return }
    t.cornerRadius = look.radius
    t.cornerCurve = .continuous
    t.backgroundColor = look.glass
    t.borderWidth = 0.5
    t.borderColor = look.ring
    me.shadowPath = CGPath(
      roundedRect: r.insetBy(dx: 8, dy: 8).offsetBy(dx: 0, dy: 10), cornerWidth: look.radius,
      cornerHeight: look.radius, transform: nil)
    me.shadowColor = CGColor(gray: 0, alpha: 1)
    me.shadowOpacity = look.dark ? 0.55 : 0.18
    me.shadowRadius = 14
    me.shadowOffset = .zero
  }

  /// Where the bar goes over a selection whose lines are `lines` in reading order (y-down, the view's units), in the
  /// part of the view shown, `visible`: `gap` above the first line, starting where that line starts; below the last
  /// line only when there is no room above; near the edges shifted sideways only, to stay inside. The first and last
  /// lines are the reading order's, not the highest and lowest: a selection from low in a left column to high in the
  /// right one has its bar over where it starts. A selection down one column is never under the bar, though the bar
  /// may cover the text around it
  public static func origin(size: CGSize, lines: [CGRect], visible: CGRect, gap: CGFloat = 6) -> CGPoint {
    guard let first = lines.first, let last = lines.last else { return visible.origin }
    let x = max(visible.minX, min(first.minX, visible.maxX - size.width))
    let above = first.minY - gap - size.height
    return CGPoint(x: x, y: above >= visible.minY ? above : last.maxY + gap)
  }
}

/// A bar's button: its icon (or title) in the bar's ink, and the toolbar's soft tint under it while the pointer is on
/// it, or while it is `on` (the version a tab shows)
final class BarButton: NSButton {
  var lit = CGColor(gray: 0, alpha: 0.07)
  var on = false {
    didSet { shade() }
  }
  /// Its fill when neither on nor hovered (a failed job's red)
  var base: CGColor? {
    didSet { shade() }
  }
  private var hovered = false {
    didSet { shade() }
  }

  private func shade() { layer?.backgroundColor = hovered || on ? (on ? lit.copy(alpha: 0.12) : lit) : base }

  /// In the bar's ink
  func ink(_ look: ReadingBarLook) {
    contentTintColor = NSColor(cgColor: look.ink) ?? .labelColor
    lit = look.ink.copy(alpha: 0.07) ?? look.ink
    shade()
  }

  init(radius: CGFloat) {
    super.init(frame: .zero)
    isBordered = false
    imagePosition = .imageOnly
    imageScaling = .scaleNone
    symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
    wantsLayer = true
    layer?.cornerRadius = radius
    focusRingType = .none
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("BarButton is not loaded from nibs") }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas { removeTrackingArea(t) }
    addTrackingArea(
      NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp], owner: self))
  }

  override func mouseEntered(with event: NSEvent) { hovered = true }
  override func mouseExited(with event: NSEvent) { hovered = false }
}

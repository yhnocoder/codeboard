import AppKit

/// The board toolbar's glass (CanvasToolbar.makeGlass and .pill in Warm Ink): the page blurred under a tint, in a
/// continuous rounded rect with a hairline round it and the float shadow under it. What sits on it goes in `content`
class WebGlass: NSView {
  let content = NSView()
  private let blur = NSVisualEffectView()
  private let tint = NSView()
  private let radius: CGFloat

  init(radius: CGFloat) {
    self.radius = radius
    super.init(frame: .zero)
    wantsLayer = true
    for v in [blur, tint, content] {
      v.wantsLayer = true
      v.autoresizingMask = [.width, .height]
      v.layer?.cornerRadius = radius
      v.layer?.cornerCurve = .continuous
      v.layer?.masksToBounds = true
      addSubview(v)
    }
    blur.blendingMode = .withinWindow
    blur.material = .underWindowBackground
    blur.state = .active
    layer?.shadowOpacity = 1
    layer?.shadowRadius = 10
    layer?.shadowOffset = CGSize(width: 0, height: -5)
    restyle()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("WebGlass is not loaded from nibs") }

  override func layout() {
    super.layout()
    layer?.shadowPath = CGPath(
      roundedRect: bounds, cornerWidth: min(radius, bounds.height / 2), cornerHeight: min(radius, bounds.height / 2),
      transform: nil)
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    restyle()
  }

  /// themes.css --wi-glass over the blur, the hairline and the lower of the float shadows, light and dark
  private func restyle() {
    let dark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    func c(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat) -> CGColor {
      CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
    }
    tint.layer?.backgroundColor = dark ? c(40, 39, 36, 0.6) : c(250, 248, 244, 0.62)
    content.layer?.borderWidth = 0.5
    content.layer?.borderColor = dark ? c(255, 240, 220, 0.11) : c(60, 45, 20, 0.16)
    layer?.shadowColor = dark ? c(0, 0, 0, 0.55) : c(50, 35, 10, 0.18)
  }
}

/// The bar floating over a web page: back and forward through the page's history, the address, saving, and what is to
/// come, shown but not working yet: body or full page, original, side by side or translation
final class WebBar: WebGlass {
  let back = WebBar.button("chevron.backward", "Back", "ui-web-back")
  let forward = WebBar.button("chevron.forward", "Forward", "ui-web-forward")
  let address = WebAddressField()
  let extract = WebBar.segments([("doc.plaintext", "Body"), ("doc.richtext", "Full Page")], "ui-web-extract")
  let translate = WebBar.segments(
    [("character", "Original"), ("rectangle.split.2x1", "Side by Side"), ("translate", "Translation")],
    "ui-web-translate")
  let save = WebBar.button("square.and.arrow.down", "Save", "ui-web-save")
  /// Over the save button while a saving is under way
  private let saving = NSProgressIndicator()
  /// The address keeps this much before what is to come gives way, the translation first
  static let addressMinWidth: CGFloat = 96

  override init(radius: CGFloat) {
    super.init(radius: radius)
    setAccessibilityIdentifier("ui-web-bar")
    for c in [extract, translate, save] { c.isEnabled = false }
    for v in [back, forward, address, extract, translate, save] { content.addSubview(v) }
    saving.style = .spinning
    saving.controlSize = .small
    saving.isDisplayedWhenStopped = false
    save.addSubview(saving)
  }

  /// What the save button says
  enum Save: Equatable {
    /// Nothing to save here, and why
    case off(String)
    case saved(WebReading.Saved)
    /// Under way, at the capture script's stage
    case saving(stage: String)
    case failed(String)
  }

  func show(_ state: Save) {
    let (symbol, tip): (String?, String) =
      switch state {
      case .off(let why): ("square.and.arrow.down", why)
      case .saved(.unsaved): ("square.and.arrow.down", "Save")
      case .saved(.link): ("link", "Saved as a Link")
      case .saved(.page): ("square.and.arrow.down.fill", "Saved as a Full Page")
      case .saving(let stage): (nil, "Saving: \(Self.stageName(stage)). Click or press Escape to stop")
      case .failed(let why): ("exclamationmark.triangle", why)
      }
    save.image = symbol.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: tip) }
    save.toolTip = tip
    save.setAccessibilityValue(tip)
    save.isEnabled = if case .off = state { false } else { true }
    save.contentTintColor =
      switch state {
      case .saved(.link), .saved(.page): .controlAccentColor
      case .failed: .systemRed
      default: .secondaryLabelColor
      }
    if case .saving = state { saving.startAnimation(nil) } else { saving.stopAnimation(nil) }
  }

  static func stageName(_ stage: String) -> String {
    switch stage {
    case "prepare": "getting the page ready"
    case "scroll": "loading all of the page"
    case "serialize": "writing it out"
    case "check": "checking it"
    default: "starting"
    }
  }

  override func layout() {
    super.layout()
    let h = bounds.height
    func place(_ v: NSView, x: CGFloat, width: CGFloat, height: CGFloat = 28) {
      v.frame = CGRect(x: x, y: ((h - height) / 2).rounded(), width: width, height: height)
    }
    place(back, x: 4, width: 30)
    place(forward, x: 36, width: 30)
    var right = bounds.width - 4
    place(save, x: right - 30, width: 30)
    saving.frame = save.bounds.insetBy(dx: (save.bounds.width - 16) / 2, dy: (save.bounds.height - 16) / 2)
    right -= 30 + 4
    for s in [extract, translate] { s.sizeToFit() }
    let start = forward.frame.maxX + 6
    let fit = right - start - Self.addressMinWidth
    let both = fit >= extract.frame.width + translate.frame.width + 12
    let segments = both ? [extract, translate] : fit >= extract.frame.width + 6 ? [extract] : []
    translate.isHidden = !both
    extract.isHidden = segments.isEmpty
    for s in segments.reversed() {
      place(s, x: right - s.frame.width, width: s.frame.width, height: s.frame.height)
      right -= s.frame.width + 6
    }
    place(address, x: start, width: max(0, right - start), height: address.intrinsicContentSize.height)
  }

  private static func button(_ symbol: String, _ name: String, _ id: String) -> NSButton {
    let b = NSButton(
      image: NSImage(systemSymbolName: symbol, accessibilityDescription: name) ?? NSImage(), target: nil, action: nil)
    b.isBordered = false
    b.contentTintColor = .secondaryLabelColor
    b.toolTip = name
    b.setAccessibilityLabel(name)
    b.setAccessibilityIdentifier(id)
    return b
  }

  private static func segments(_ items: [(symbol: String, name: String)], _ id: String) -> NSSegmentedControl {
    let s = NSSegmentedControl(
      images: items.map { NSImage(systemSymbolName: $0.symbol, accessibilityDescription: $0.name) ?? NSImage() },
      trackingMode: .selectOne, target: nil, action: nil)
    s.controlSize = .small
    s.selectedSegment = 0
    for (i, item) in items.enumerated() { s.setToolTip(item.name, forSegment: i) }
    s.setAccessibilityLabel(items.map(\.name).joined(separator: ", "))
    s.setAccessibilityIdentifier(id)
    return s
  }
}

/// The address: the page's host while it is not being edited, its whole address while it is. A click selects all of
/// it, as ⌘L does
final class WebAddressField: NSTextField {
  /// Editing starts: the field is told what to hold first
  var onEdit: (() -> Void)?

  init() {
    super.init(frame: .zero)
    isBordered = false
    drawsBackground = false
    focusRingType = .none
    font = .systemFont(ofSize: 12)
    alignment = .center
    lineBreakMode = .byTruncatingMiddle
    cell?.usesSingleLineMode = true
    cell?.isScrollable = true
    wantsLayer = true
    layer?.cornerRadius = 7
    layer?.cornerCurve = .continuous
    placeholderString = "Address"
    setAccessibilityLabel("Address")
    setAccessibilityIdentifier("ui-web-address")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("WebAddressField is not loaded from nibs") }

  var isEditing: Bool { currentEditor() != nil }

  override func mouseDown(with event: NSEvent) {
    if isEditing { return super.mouseDown(with: event) }
    window?.makeFirstResponder(self)
  }

  override func becomeFirstResponder() -> Bool {
    onEdit?()
    alignment = .natural
    layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.07).cgColor
    guard super.becomeFirstResponder() else { return false }
    currentEditor()?.selectAll(nil)
    return true
  }

  /// Back to showing the page's host
  func show(_ text: String) {
    alignment = .center
    layer?.backgroundColor = nil
    stringValue = text
  }
}

/// The addresses the history suggests for what is typed, opening upward from the bar, the best nearest it: the arrow
/// keys move through them, a click goes to one
final class WebSuggestions: WebGlass {
  var onChoose: ((URL) -> Void)?
  private(set) var entries: [WebHistory.Entry] = []
  private(set) var selected: Int?
  private var rows: [NSButton] = []
  static let rowHeight: CGFloat = 26

  override init(radius: CGFloat) {
    super.init(radius: radius)
    setAccessibilityIdentifier("ui-web-suggestions")
    setAccessibilityRole(.list)
  }

  var height: CGFloat { CGFloat(entries.count) * Self.rowHeight + 8 }

  func show(_ entries: [WebHistory.Entry]) {
    self.entries = entries
    selected = nil
    for r in rows { r.removeFromSuperview() }
    rows = entries.enumerated().map { i, e in
      let title = NSMutableAttributedString(
        string: e.title.isEmpty ? WebAddress.shown(e.url) : e.title,
        attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.labelColor])
      title.append(
        NSAttributedString(
          string: "  " + WebAddress.shown(e.url),
          attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]))
      let b = NSButton(title: "", target: self, action: #selector(chose(_:)))
      b.attributedTitle = title
      b.isBordered = false
      b.alignment = .left
      b.lineBreakMode = .byTruncatingTail
      b.tag = i
      b.wantsLayer = true
      b.layer?.cornerRadius = 7
      b.setAccessibilityIdentifier("ui-web-suggestion-\(i)")
      content.addSubview(b)
      return b
    }
    isHidden = entries.isEmpty
    needsLayout = true
  }

  /// `step` rows further from the bar (nearer when negative); nil back at the address or past the last
  func move(by step: Int) -> WebHistory.Entry? {
    let next = (selected ?? -1) + step
    selected = entries.indices.contains(next) ? next : nil
    for (i, r) in rows.enumerated() {
      r.layer?.backgroundColor = i == selected ? NSColor.labelColor.withAlphaComponent(0.08).cgColor : nil
    }
    return selected.map { entries[$0] }
  }

  override func layout() {
    super.layout()
    for (i, r) in rows.enumerated() {
      r.frame = CGRect(x: 4, y: 4 + CGFloat(i) * Self.rowHeight, width: bounds.width - 8, height: Self.rowHeight)
    }
  }

  @objc private func chose(_ sender: NSButton) { onChoose?(entries[sender.tag].url) }
}

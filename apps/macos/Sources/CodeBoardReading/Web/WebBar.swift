import AppKit

/// The board toolbar's glass in the board's theme (ReadingBarLook): the page blurred under a tint, in a continuous
/// rounded rect with a hairline round it and the float shadow under it. What sits on it goes in `content`
class WebGlass: NSView {
  let content = NSView()
  private let blur = NSVisualEffectView()
  private let tint = NSView()
  var look: ReadingBarLook {
    didSet { restyle() }
  }

  init(look: ReadingBarLook) {
    self.look = look
    super.init(frame: .zero)
    wantsLayer = true
    for v in [blur, tint, content] {
      v.wantsLayer = true
      v.autoresizingMask = [.width, .height]
      v.layer?.cornerCurve = .continuous
      v.layer?.masksToBounds = true
      addSubview(v)
    }
    blur.state = .active
    layer?.shadowColor = CGColor(gray: 0, alpha: 1)
    layer?.shadowRadius = 10
    layer?.shadowOffset = CGSize(width: 0, height: -5)
    restyle()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("WebGlass is not loaded from nibs") }

  override func layout() {
    super.layout()
    let r = min(look.radius, bounds.height / 2)
    layer?.shadowPath = CGPath(roundedRect: bounds, cornerWidth: r, cornerHeight: r, transform: nil)
  }

  /// The look's glass over the blur, its hairline and the float shadow; the controls on it in its appearance
  func restyle() {
    appearance = NSAppearance(named: look.dark ? .darkAqua : .aqua)
    blur.material = look.material
    blur.blendingMode = look.blending
    for v in [blur, tint, content] { v.layer?.cornerRadius = look.radius }
    tint.layer?.backgroundColor = look.glass
    content.layer?.borderWidth = 0.5
    content.layer?.borderColor = look.ring
    layer?.shadowOpacity = look.dark ? 0.55 : 0.18
    needsLayout = true
  }
}

/// The bar floating over a web page: back and forward through the page's history, the address, saving, and what is to
/// come, shown but not working yet: body or full page, original, side by side or translation
final class WebBar: WebGlass {
  let back = WebBar.button("chevron.backward", "Back", "ui-webback")
  let forward = WebBar.button("chevron.forward", "Forward", "ui-webforward")
  let address = WebAddressField()
  let extract = WebBar.segments([("doc.plaintext", "Body"), ("doc.richtext", "Full Page")], "ui-webextract")
  let translate = WebBar.segments(
    [("character", "Original"), ("rectangle.split.2x1", "Side by Side"), ("translate", "Translation")],
    "ui-webtranslate")
  let save = WebBar.button("square.and.arrow.down", "Save", "ui-websave")
  /// Over the save button while a saving is under way
  private let saving = NSProgressIndicator()
  /// The address keeps this much before what is to come gives way, the translation first
  static let addressMinWidth: CGFloat = 96

  /// What the save button says now
  private var state = Save.off("")

  override init(look: ReadingBarLook) {
    super.init(look: look)
    setAccessibilityIdentifier("ui-webbar")
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
    self.state = state
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
      case .saved(.link), .saved(.page): NSColor(cgColor: look.accent)
      case .failed: .systemRed
      default: NSColor(cgColor: look.ink)
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

  /// The buttons in the look's ink, the saved state in its accent
  override func restyle() {
    super.restyle()
    for b in [back, forward] { b.contentTintColor = NSColor(cgColor: look.ink) }
    address.lit = look.ink.copy(alpha: 0.07)
    address.textColor = NSColor(cgColor: look.ink)
    show(state)
  }

  /// The buttons the size of the board toolbar's, 4 in and 2 apart as there
  override func layout() {
    super.layout()
    let h = bounds.height
    let button = look.button
    func place(_ v: NSView, x: CGFloat, width: CGFloat, height: CGFloat) {
      v.frame = CGRect(x: x, y: ((h - height) / 2).rounded(), width: width, height: height)
    }
    place(back, x: 4, width: button.width, height: button.height)
    place(forward, x: 4 + button.width + 2, width: button.width, height: button.height)
    var right = bounds.width - 4
    place(save, x: right - button.width, width: button.width, height: button.height)
    saving.frame = save.bounds.insetBy(dx: (save.bounds.width - 16) / 2, dy: (save.bounds.height - 16) / 2)
    right -= button.width + 4
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
  /// Under the address while it is edited
  var lit: CGColor?

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
    setAccessibilityIdentifier("ui-webaddress")
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
    layer?.backgroundColor = lit
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

  override init(look: ReadingBarLook) {
    super.init(look: look)
    setAccessibilityIdentifier("ui-websuggestions")
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
      b.setAccessibilityIdentifier("ui-websuggestion\(i)")
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
      r.layer?.backgroundColor = i == selected ? look.ink.copy(alpha: 0.08) : nil
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

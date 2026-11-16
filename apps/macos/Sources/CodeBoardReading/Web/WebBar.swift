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

  /// Its own cursor, the arrow, not the one the page under it set: as cursor rects, which WebKit leaves alone while
  /// the pointer is in one (a tracking area's cursor it sets over again at the page's next move under the glass). The
  /// address being edited has its text cursor in its own
  var cursorRects: [(CGRect, NSCursor)] { [(bounds, .arrow)] }

  override func resetCursorRects() {
    for (r, c) in cursorRects { addCursorRect(r, cursor: c) }
  }

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

/// The bar floating over a web page: back and forward through the page's history, the address, body or full page,
/// saving, and what is to come, shown but not working yet: original, side by side or translation. Its buttons are the
/// board toolbar's: flat icons in the look's ink, groups apart by its hairline separator
final class WebBar: WebGlass {
  let back = WebBarButton("chevron.backward", "Back", "ui-webback")
  let forward = WebBarButton("chevron.forward", "Forward", "ui-webforward")
  let address = WebAddressField()
  let extract = WebChoice([("doc.plaintext", "Body"), ("doc.richtext", "Full Page")], "ui-webextract")
  let translate = WebChoice(
    [("character", "Original"), ("rectangle.split.2x1", "Side by Side"), ("translate", "Translation")],
    "ui-webtranslate")
  let save = WebBarButton("square.and.arrow.down", "Save", "ui-websave")
  /// Between the groups at the right: the toolbar's .sep
  let separators = [NSView(), NSView()]
  /// Over the save button while a saving is under way
  private let saving = NSProgressIndicator()
  /// The address keeps this much before what is to come gives way, the translation first
  static let addressMinWidth: CGFloat = 96

  /// What the save button says now
  private var state = Save.off("")

  /// Where the address starts: after back and forward, 6 from them
  static func addressX(_ look: ReadingBarLook) -> CGFloat { 4 + 2 * look.button.width + 2 + 6 }

  override init(look: ReadingBarLook) {
    super.init(look: look)
    setAccessibilityIdentifier("ui-webbar")
    for c in [extract, translate, save] { c.isEnabled = false }
    for s in separators { s.wantsLayer = true }
    for v in [back, forward, address.tint, address, extract, translate, save] + separators { content.addSubview(v) }
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
    save.tone =
      switch state {
      case .saved(.link), .saved(.page): look.accent
      case .failed: NSColor.systemRed.cgColor
      default: nil
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

  /// The buttons in the look's ink, the saved state and the chosen of a group in its accent
  override func restyle() {
    super.restyle()
    for b in [back, forward, save] + extract.buttons + translate.buttons { b.restyle(look) }
    for c in [extract, translate] { c.restyle(look) }
    for s in separators { s.layer?.backgroundColor = look.ring }
    address.tint.layer?.backgroundColor = look.ink.copy(alpha: 0.07)
    address.tint.layer?.cornerRadius = look.buttonRadius
    address.textColor = NSColor(cgColor: look.ink)
    show(state)
  }

  /// The buttons the size of the board toolbar's, 4 in and 2 apart as there; a group the toolbar's separator (0.5 ×
  /// 16 with 4 on each side) and its gap of 2 from the next
  override func layout() {
    super.layout()
    let h = bounds.height
    let button = look.button
    func place(_ v: NSView, x: CGFloat, width: CGFloat, height: CGFloat) {
      v.frame = CGRect(x: x, y: ((h - height) / 2).rounded(), width: width, height: height)
    }
    place(back, x: 4, width: button.width, height: button.height)
    place(forward, x: 4 + button.width + 2, width: button.width, height: button.height)
    var right = bounds.width - 4 - button.width
    place(save, x: right, width: button.width, height: button.height)
    saving.frame = save.bounds.insetBy(dx: (save.bounds.width - 16) / 2, dy: (save.bounds.height - 16) / 2)
    let start = Self.addressX(look)
    let step: CGFloat = 2 + 8.5 + 2
    func width(_ groups: [WebChoice]) -> CGFloat { groups.reduce(0) { $0 + $1.width(look) + step } }
    let shown =
      [[extract, translate], [extract]].first { right - 6 - start - width($0) >= Self.addressMinWidth } ?? []
    for c in [extract, translate] { c.isHidden = !shown.contains(c) }
    for s in separators { s.isHidden = true }
    for (c, s) in zip(shown.reversed(), separators) {
      right -= step
      s.isHidden = false
      place(s, x: right + 2 + 4, width: 0.5, height: 16)
      right -= c.width(look)
      place(c, x: right, width: c.width(look), height: button.height)
    }
    place(address, x: start, width: max(0, right - 6 - start), height: address.intrinsicContentSize.height)
    address.tint.frame = CGRect(
      x: start - 2, y: ((h - button.height) / 2).rounded(), width: address.frame.width + 4,
      height: button.height)
  }
}

/// A button on the bar: its icon in the look's ink, the toolbar's soft tint under it while the pointer is on it, as the
/// selection bar's; dimmed when off, as AppKit dims a button's image
final class WebBarButton: NSButton {
  private var lit = CGColor(gray: 0, alpha: 0.07)
  /// The toolbar's pill for the tool in use, under the chosen button of a group
  private var pill = CGColor(gray: 0, alpha: 0.075)
  private var accent = CGColor(gray: 0, alpha: 1)
  private var ink = CGColor(gray: 0, alpha: 1)
  var chosen = false {
    didSet { paint() }
  }
  /// The icon's colour when it is not the ink: what the save button says
  var tone: CGColor? {
    didSet { paint() }
  }
  private var hovered = false {
    didSet { paint() }
  }

  init(_ symbol: String, _ name: String, _ id: String) {
    super.init(frame: .zero)
    image = NSImage(systemSymbolName: symbol, accessibilityDescription: name)
    isBordered = false
    imagePosition = .imageOnly
    imageScaling = .scaleNone
    symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
    focusRingType = .none
    wantsLayer = true
    layer?.cornerCurve = .continuous
    toolTip = name
    setAccessibilityLabel(name)
    setAccessibilityIdentifier(id)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("WebBarButton is not loaded from nibs") }

  /// Warm Ink's toolbar pill under a tool in use is its hairline's colour, faint (CanvasToolbar.image)
  func restyle(_ look: ReadingBarLook) {
    lit = look.ink.copy(alpha: 0.07) ?? lit
    pill = look.ring.copy(alpha: look.dark ? 0.09 : 0.075) ?? pill
    (ink, accent) = (look.ink, look.accent)
    layer?.cornerRadius = look.buttonRadius
    paint()
  }

  override var isEnabled: Bool {
    didSet { paint() }
  }

  /// Under the pointer the tint, chosen the pill and the icon in the accent, as the toolbar's tool in use
  private func paint() {
    layer?.backgroundColor = hovered && isEnabled ? lit : chosen ? pill : nil
    contentTintColor = NSColor(cgColor: chosen ? accent : tone ?? ink)
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas where t.owner === self { removeTrackingArea(t) }
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp], owner: self))
  }

  override func mouseEntered(with event: NSEvent) { hovered = true }
  override func mouseExited(with event: NSEvent) { hovered = false }
}

/// One of a few, as the toolbar's buttons side by side: the chosen one marked as the tool in use; a radio group to
/// accessibility. Read and set as a segmented control is (`selectedSegment`), and sends its action when another is
/// chosen
final class WebChoice: NSControl {
  let buttons: [WebBarButton]
  private let names: [String]

  init(_ items: [(symbol: String, name: String)], _ id: String) {
    names = items.map(\.name)
    buttons = items.enumerated().map { i, item in WebBarButton(item.symbol, item.name, "\(id)\(i)") }
    super.init(frame: .zero)
    cell = NSActionCell()
    for (i, b) in buttons.enumerated() {
      b.tag = i
      b.target = self
      b.action = #selector(pressed(_:))
      b.setAccessibilityRole(.radioButton)
      addSubview(b)
    }
    setAccessibilityElement(true)
    setAccessibilityRole(.radioGroup)
    setAccessibilityLabel(names.joined(separator: ", "))
    setAccessibilityIdentifier(id)
    mark()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("WebChoice is not loaded from nibs") }

  var segmentCount: Int { buttons.count }

  var selectedSegment = 0 {
    didSet { mark() }
  }

  private func mark() {
    for (i, b) in buttons.enumerated() {
      b.chosen = i == selectedSegment
      b.setAccessibilityValue(i == selectedSegment)
    }
    setAccessibilityValue(names[selectedSegment])
  }

  override var isEnabled: Bool {
    didSet { for b in buttons { b.isEnabled = isEnabled } }
  }

  /// Why it is off, over every button; on, each says its own name
  override var toolTip: String? {
    didSet { for (b, name) in zip(buttons, names) { b.toolTip = toolTip ?? name } }
  }

  func width(_ look: ReadingBarLook) -> CGFloat {
    CGFloat(buttons.count) * look.button.width + CGFloat(buttons.count - 1) * 2
  }

  private var buttonSize = CGSize(width: 30, height: 28)

  func restyle(_ look: ReadingBarLook) {
    buttonSize = look.button
    needsLayout = true
  }

  override func layout() {
    super.layout()
    for (i, b) in buttons.enumerated() {
      b.frame = CGRect(
        x: CGFloat(i) * (buttonSize.width + 2), y: 0, width: buttonSize.width, height: buttonSize.height)
    }
  }

  @objc private func pressed(_ sender: NSButton) {
    guard sender.tag != selectedSegment else { return }
    selectedSegment = sender.tag
    sendAction(action, to: target)
  }
}

/// The address: the page's host while it is not being edited, its whole address while it is. A click selects all of
/// it, as ⌘L does. Plain text on the bar, as the toolbar's own; while it is edited a faint tint under it, `tint`, which
/// the bar places
final class WebAddressField: NSTextField {
  /// Editing starts: the field is told what to hold first
  var onEdit: (() -> Void)?
  /// Under the address while it is edited, the button's height
  let tint = NSView()

  init() {
    super.init(frame: .zero)
    isBordered = false
    isBezeled = false
    drawsBackground = false
    focusRingType = .none
    font = .systemFont(ofSize: 12)
    alignment = .center
    lineBreakMode = .byTruncatingMiddle
    cell?.usesSingleLineMode = true
    cell?.isScrollable = true
    tint.wantsLayer = true
    tint.layer?.cornerCurve = .continuous
    tint.isHidden = true
    placeholderString = "Address"
    setAccessibilityLabel("Address")
    setAccessibilityIdentifier("ui-webaddress")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("WebAddressField is not loaded from nibs") }

  var isEditing: Bool { currentEditor() != nil }

  /// The press that began the editing: the window makes a field it is pressed on first responder before handing it
  /// the press, which would put the caret where it was pressed
  private var pressedIn: NSEvent?

  override func mouseDown(with event: NSEvent) {
    defer { pressedIn = nil }
    if isEditing, event !== pressedIn { return super.mouseDown(with: event) }
    window?.makeFirstResponder(self)
  }

  override func becomeFirstResponder() -> Bool {
    pressedIn = NSApp.currentEvent.flatMap { $0.type == .leftMouseDown ? $0 : nil }
    onEdit?()
    alignment = .natural
    tint.isHidden = false
    guard super.becomeFirstResponder() else { return false }
    currentEditor()?.selectAll(nil)
    window?.invalidateCursorRects(for: self)
    return true
  }

  /// A click selects all of it, as a button would: the text cursor only once it is edited
  override func resetCursorRects() {
    if isEditing { super.resetCursorRects() }
  }

  /// Back to showing the page's host
  func show(_ text: String) {
    alignment = .center
    tint.isHidden = true
    stringValue = text
    window?.invalidateCursorRects(for: self)
  }
}

/// The addresses the history suggests for what is typed, opening upward from the bar, the best nearest it: the arrow
/// keys move through them, a click goes to one
final class WebSuggestions: WebGlass {
  var onChoose: ((URL) -> Void)?
  private(set) var entries: [WebHistory.Entry] = []
  private(set) var selected: Int?
  private(set) var rows: [WebSuggestionRow] = []
  /// Where a row's label starts, so that its text is under the address's in the bar: the address field's x
  var textX: CGFloat = 72 {
    didSet { needsLayout = true }
  }

  override init(look: ReadingBarLook) {
    super.init(look: look)
    setAccessibilityIdentifier("ui-websuggestions")
    setAccessibilityRole(.list)
  }

  /// Rows the bar's buttons' height, 4 in as its buttons are
  var height: CGFloat { CGFloat(entries.count) * look.button.height + 8 }

  func show(_ entries: [WebHistory.Entry]) {
    self.entries = entries
    selected = nil
    for r in rows { r.removeFromSuperview() }
    rows = entries.enumerated().map { i, e in
      let r = WebSuggestionRow(e)
      r.tag = i
      r.target = self
      r.action = #selector(chose(_:))
      r.setAccessibilityIdentifier("ui-websuggestion\(i)")
      content.addSubview(r)
      return r
    }
    restyle()
    isHidden = entries.isEmpty
    needsLayout = true
  }

  override func restyle() {
    super.restyle()
    for r in rows { r.restyle(look) }
  }

  /// `step` rows further from the bar (nearer when negative); nil back at the address or past the last
  func move(by step: Int) -> WebHistory.Entry? {
    let next = (selected ?? -1) + step
    selected = entries.indices.contains(next) ? next : nil
    for (i, r) in rows.enumerated() { r.chosen = i == selected }
    return selected.map { entries[$0] }
  }

  override func layout() {
    super.layout()
    let h = look.button.height
    for (i, r) in rows.enumerated() {
      r.frame = CGRect(x: 4, y: 4 + CGFloat(i) * h, width: bounds.width - 8, height: h)
      r.textX = textX - 4
    }
  }

  @objc private func chose(_ sender: NSButton) { onChoose?(entries[sender.tag].url) }
}

/// A suggestion on one line: the page's title in the look's ink, then its address without the scheme, lighter, cut
/// in the middle when it is long, so that two pages of a site are told apart. The toolbar's tint under the pointer,
/// darker (its pressed tint) on the row the arrows chose
final class WebSuggestionRow: NSButton {
  let titleLabel: NSTextField
  let addressLabel: NSTextField
  private var lit = CGColor(gray: 0, alpha: 0.07)
  private var held = CGColor(gray: 0, alpha: 0.12)
  /// Where the labels start in the row
  var textX: CGFloat = 8 {
    didSet { needsLayout = true }
  }
  var chosen = false {
    didSet { paint() }
  }
  private var hovered = false {
    didSet { paint() }
  }

  init(_ entry: WebHistory.Entry) {
    let address = WebAddress.withPath(entry.url)
    titleLabel = NSTextField(labelWithString: entry.title.isEmpty ? address : entry.title)
    addressLabel = NSTextField(labelWithString: entry.title.isEmpty ? "" : address)
    super.init(frame: .zero)
    title = ""
    setButtonType(.momentaryChange)
    isBordered = false
    focusRingType = .none
    wantsLayer = true
    layer?.cornerCurve = .continuous
    for (l, cut) in [(titleLabel, NSLineBreakMode.byTruncatingTail), (addressLabel, .byTruncatingMiddle)] {
      l.font = .systemFont(ofSize: 12)
      l.lineBreakMode = cut
      l.maximumNumberOfLines = 1
      l.cell?.usesSingleLineMode = true
      addSubview(l)
    }
    setAccessibilityLabel(
      [titleLabel.stringValue, addressLabel.stringValue].filter { !$0.isEmpty }.joined(separator: ", "))
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("WebSuggestionRow is not loaded from nibs") }

  func restyle(_ look: ReadingBarLook) {
    lit = look.ink.copy(alpha: 0.07) ?? lit
    held = look.ink.copy(alpha: 0.12) ?? held
    layer?.cornerRadius = look.buttonRadius
    titleLabel.textColor = NSColor(cgColor: look.ink)
    addressLabel.textColor = NSColor(cgColor: look.ink.copy(alpha: 0.55) ?? look.ink)
    paint()
  }

  private func paint() { layer?.backgroundColor = chosen ? held : hovered ? lit : nil }

  /// The title its own width, or what the address leaves of the line, but no less than three fifths of it; the
  /// address the rest
  override func layout() {
    super.layout()
    let gap: CGFloat = 6
    let room = max(0, bounds.width - textX - 6)
    // a truncating label's intrinsic width is short of its text's by a few points: its cell's is not
    func width(_ l: NSTextField) -> CGFloat { (l.cell?.cellSize.width ?? 0).rounded(.up) }
    let address = addressLabel.stringValue.isEmpty ? 0 : width(addressLabel) + gap
    let t = min(width(titleLabel), max(room * 0.6, room - address))
    let lh = titleLabel.intrinsicContentSize.height
    let y = ((bounds.height - lh) / 2).rounded()
    titleLabel.frame = CGRect(x: textX, y: y, width: t, height: lh)
    addressLabel.frame = CGRect(x: textX + t + gap, y: y, width: max(0, room - t - gap), height: lh)
  }

  /// The labels take no clicks: the row is pressed wherever it is
  override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas where t.owner === self { removeTrackingArea(t) }
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp], owner: self))
  }

  override func mouseEntered(with event: NSEvent) { hovered = true }
  override func mouseExited(with event: NSEvent) { hovered = false }
}

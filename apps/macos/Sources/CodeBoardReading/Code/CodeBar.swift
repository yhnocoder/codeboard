import AppKit

/// The bar floating over a code tab: back and forward through the places gone to, where the view is (the repository,
/// its folders, the file, the function at the top of the view; clicked, the file finder, whose query takes its place),
/// the outline, and the commit the file is read at. Its buttons are the web bar's, the board toolbar's
final class CodeBar: WebGlass {
  let back = WebBarButton("chevron.backward", "Back", "ui-codeback")
  let forward = WebBarButton("chevron.forward", "Forward", "ui-codeforward")
  let path = CodePath()
  /// The file finder's query, where the path is while it is open
  let field = NSTextField()
  let outline = WebBarButton("list.bullet.indent", "Outline", "ui-codeoutline")
  let commit = NSTextField(labelWithString: "")
  /// Under the query while the finder is open, the button's height (the address's tint)
  private let fieldTint = NSView()

  /// Where the view is: the repository, its folders, the file, and the function at the top of the view
  var place = Place(repository: "", folders: [], file: "", function: nil) {
    didSet { if place != oldValue { needsLayout = true } }
  }

  struct Place: Equatable {
    var repository: String
    var folders: [String]
    var file: String
    var function: String?
  }

  var finding = false {
    didSet {
      path.isHidden = finding
      field.isHidden = !finding
      fieldTint.isHidden = !finding
    }
  }

  override init(look: ReadingBarLook) {
    super.init(look: look)
    setAccessibilityIdentifier("ui-codebar")
    field.isBordered = false
    field.isBezeled = false
    field.drawsBackground = false
    field.focusRingType = .none
    field.font = .systemFont(ofSize: 12)
    field.cell?.usesSingleLineMode = true
    field.cell?.isScrollable = true
    field.placeholderString = "Go to File"
    field.setAccessibilityLabel("Go to File")
    field.setAccessibilityIdentifier("ui-codefind")
    fieldTint.wantsLayer = true
    fieldTint.layer?.cornerCurve = .continuous
    commit.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
    commit.toolTip = "The commit the repository is at (HEAD)"
    commit.setAccessibilityIdentifier("ui-codecommit")
    for v in [back, forward, fieldTint, path, field, outline, commit] { content.addSubview(v) }
    field.isHidden = true
    fieldTint.isHidden = true
  }

  override func restyle() {
    super.restyle()
    for b in [back, forward, outline] { b.restyle(look) }
    path.restyle(look)
    fieldTint.layer?.backgroundColor = look.ink.copy(alpha: 0.07)
    fieldTint.layer?.cornerRadius = look.buttonRadius
    field.textColor = NSColor(cgColor: look.ink)
    commit.textColor = NSColor(cgColor: look.ink.copy(alpha: 0.45) ?? look.ink)
    needsLayout = true
  }

  /// Back and forward as the web bar's; the commit 10 from the right end, the outline before it; the path, or the
  /// query, in what is left, elided to fit
  override func layout() {
    super.layout()
    let h = bounds.height
    let button = look.button
    func place(_ v: NSView, x: CGFloat, width: CGFloat, height: CGFloat) {
      v.frame = CGRect(x: x, y: ((h - height) / 2).rounded(), width: max(0, width), height: height)
    }
    place(back, x: 4, width: button.width, height: button.height)
    place(forward, x: 4 + button.width + 2, width: button.width, height: button.height)
    // the commit gives way when the repository and the file do not fit beside it
    for withCommit in [!commit.stringValue.isEmpty, false] {
      var right = bounds.width - 4
      if withCommit {
        let w = (commit.cell?.cellSize.width ?? 0).rounded(.up)
        right -= 6 + w
        place(commit, x: right, width: w, height: commit.intrinsicContentSize.height)
        right -= 4
      }
      commit.isHidden = !withCommit
      right -= button.width
      place(outline, x: right, width: button.width, height: button.height)
      let start = WebBar.addressX(look)
      let width = right - 6 - start
      place(path, x: start - 2, width: width + 4, height: button.height)
      place(field, x: start + 4, width: width - 8, height: field.intrinsicContentSize.height)
      place(fieldTint, x: start - 2, width: width + 4, height: button.height)
      if path.show(self.place, width: width - 8) || !withCommit { break }
    }
  }
}

/// Where the view is, as one line on the bar: the repository, folders lighter, the file, the function after it; a
/// click opens the file finder (its action). The toolbar's tint under the pointer
final class CodePath: NSControl {
  let label = NSTextField(labelWithString: "")
  private var look = ReadingBarLook.warmInk(dark: false)
  private var hovered = false {
    didSet { paint() }
  }
  /// What the label shows now, as its parts
  private(set) var shown: [String] = []

  init() {
    super.init(frame: .zero)
    cell = NSActionCell()
    wantsLayer = true
    layer?.cornerCurve = .continuous
    label.lineBreakMode = .byTruncatingHead
    label.cell?.usesSingleLineMode = true
    addSubview(label)
    toolTip = "Go to File (⌘L)"
    setAccessibilityElement(true)
    setAccessibilityRole(.button)
    setAccessibilityIdentifier("ui-codepath")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("CodePath is not loaded from nibs") }

  func restyle(_ look: ReadingBarLook) {
    self.look = look
    layer?.cornerRadius = look.buttonRadius
    paint()
  }

  private func paint() { layer?.backgroundColor = hovered ? look.ink.copy(alpha: 0.07) : nil }

  /// The place in `width`, its middle folders and then its function given up when it does not fit; whether it fits
  @discardableResult func show(_ p: CodeBar.Place, width: CGFloat) -> Bool {
    func function(_ parts: [String]) -> Bool { p.function != nil && parts.last == p.function && parts.count > 2 }
    let parts = CodeReading.elide(repository: p.repository, folders: p.folders, file: p.file, function: p.function) {
      text($0, function: function($0)).size().width <= width
    }
    shown = parts
    let shownText = text(parts, function: function(parts))
    label.attributedStringValue = shownText
    setAccessibilityLabel(parts.joined(separator: ", "))
    let lh = label.intrinsicContentSize.height
    label.frame = CGRect(x: 6, y: ((bounds.height - lh) / 2).rounded(), width: max(0, bounds.width - 12), height: lh)
    return shownText.size().width <= width
  }

  /// The repository in the ink, folders lighter, the file in the ink and bold, the function after it lighter; the
  /// separators lightest
  private func text(_ parts: [String], function: Bool) -> NSAttributedString {
    let s = NSMutableAttributedString()
    let ink = look.ink
    // when nothing more can give way, the repository's name is cut, not the file's
    let cut = NSMutableParagraphStyle()
    cut.lineBreakMode = .byTruncatingHead
    func add(_ t: String, _ weight: NSFont.Weight, _ alpha: CGFloat) {
      s.append(
        NSAttributedString(
          string: t,
          attributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: weight),
            .foregroundColor: NSColor(cgColor: ink.copy(alpha: alpha) ?? ink) ?? .labelColor,
            .paragraphStyle: cut,
          ]))
    }
    let file = parts.count - (function ? 2 : 1)
    for (i, part) in parts.enumerated() {
      if i > 0 { add("  ›  ", .regular, 0.3) }
      switch i {
      case 0: add(part, .medium, 0.85)
      case file: add(part, .semibold, 1)
      case file + 1: add(part, .regular, 0.7)
      default: add(part, .regular, 0.55)
      }
    }
    return s
  }

  override func mouseDown(with event: NSEvent) {}
  override func mouseUp(with event: NSEvent) {
    if bounds.contains(convert(event.locationInWindow, from: nil)) { sendAction(action, to: target) }
  }

  override func accessibilityPerformPress() -> Bool { sendAction(action, to: target) }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas where t.owner === self { removeTrackingArea(t) }
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp], owner: self))
  }

  override func mouseEntered(with event: NSEvent) { hovered = true }
  override func mouseExited(with event: NSEvent) { hovered = false }
}

/// A list opening upward from the bar, on its glass: the file finder's files, the best nearest the bar, or the
/// outline's classes and functions in order. Its rows are the web address's suggestions; the arrow keys move through
/// them, a click chooses one. Taller than the room, it scrolls
final class CodeList: WebGlass {
  struct Item: Equatable {
    var title: String
    var detail: String
    var indent: CGFloat = 0
    var strong = false
  }

  var onChoose: ((Int) -> Void)?
  private(set) var items: [Item] = []
  private(set) var rows: [WebSuggestionRow] = []
  private(set) var selected: Int?
  /// The first item nearest the bar
  private(set) var bottomUp = false
  private let scroll = NSScrollView()
  private let stack = CodeFlipped()

  override init(look: ReadingBarLook) {
    super.init(look: look)
    setAccessibilityIdentifier("ui-codelist")
    setAccessibilityRole(.list)
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.documentView = stack
    content.addSubview(scroll)
  }

  /// Rows the bar's buttons' height, 4 in as its buttons are
  var height: CGFloat { CGFloat(items.count) * look.button.height + 8 }

  func show(_ items: [Item], bottomUp: Bool, id: String) {
    self.items = items
    self.bottomUp = bottomUp
    selected = nil
    for r in rows { r.removeFromSuperview() }
    rows = items.enumerated().map { i, item in
      let r = WebSuggestionRow(title: item.title, detail: item.detail)
      if item.strong { r.titleLabel.font = .systemFont(ofSize: 12, weight: .semibold) }
      r.textX = 8 + item.indent
      r.tag = i
      r.target = self
      r.action = #selector(chose(_:))
      r.setAccessibilityIdentifier("\(id)\(i)")
      stack.addSubview(r)
      return r
    }
    restyle()
    isHidden = items.isEmpty
    needsLayout = true
  }

  override func restyle() {
    super.restyle()
    for r in rows { r.restyle(look) }
  }

  /// `step` rows further from the bar (nearer when negative), within the list
  @discardableResult func move(by step: Int) -> Int? {
    guard !items.isEmpty else { return nil }
    let away = bottomUp ? step : -step
    select(max(0, min(items.count - 1, (selected ?? (bottomUp ? -1 : items.count)) + away)))
    return selected
  }

  /// The row chosen, brought into view
  func select(_ i: Int?) {
    selected = i
    for (k, r) in rows.enumerated() { r.chosen = k == i }
    layoutSubtreeIfNeeded()
    if let i, rows.indices.contains(i) { stack.scrollToVisible(rows[i].frame) }
  }

  override func layout() {
    super.layout()
    let h = look.button.height
    scroll.frame = bounds.insetBy(dx: 4, dy: 4)
    let w = scroll.contentSize.width
    stack.frame = CGRect(x: 0, y: 0, width: w, height: CGFloat(rows.count) * h)
    for (i, r) in rows.enumerated() {
      let at = bottomUp ? rows.count - 1 - i : i
      r.frame = CGRect(x: 0, y: CGFloat(at) * h, width: w, height: h)
    }
  }

  @objc private func chose(_ sender: NSButton) { onChoose?(sender.tag) }
}

final class CodeFlipped: NSView {
  override var isFlipped: Bool { true }
}

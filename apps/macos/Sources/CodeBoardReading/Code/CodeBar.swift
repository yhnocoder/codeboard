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
  /// A quiet line before the commit: the commit a card opened here is from, when it is not the file's
  let noteLabel = NSTextField(labelWithString: "")
  var note: String {
    get { noteLabel.stringValue }
    set {
      noteLabel.stringValue = newValue
      noteLabel.toolTip = newValue.isEmpty ? nil : newValue
      needsLayout = true
    }
  }
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
    noteLabel.font = .systemFont(ofSize: 11.5)
    noteLabel.lineBreakMode = .byTruncatingTail
    noteLabel.setAccessibilityIdentifier("ui-codenote")
    for v in [back, forward, fieldTint, path, field, outline, noteLabel, commit] { content.addSubview(v) }
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
    noteLabel.textColor = commit.textColor
    needsLayout = true
  }

  /// Back and forward as the web bar's; the commit 10 from the right end, the note before it, the outline before them;
  /// the path, or the query, in what is left, elided to fit
  override func layout() {
    super.layout()
    let h = bounds.height
    let button = look.button
    func place(_ v: NSView, x: CGFloat, width: CGFloat, height: CGFloat) {
      v.frame = CGRect(x: x, y: ((h - height) / 2).rounded(), width: max(0, width), height: height)
    }
    place(back, x: 4, width: button.width, height: button.height)
    place(forward, x: 4 + button.width + 2, width: button.width, height: button.height)
    // the commit and the note give way when the repository and the file do not fit beside them
    for withCommit in [!commit.stringValue.isEmpty || !note.isEmpty, false] {
      var right = bounds.width - 4
      if withCommit {
        for l in [commit, noteLabel] where !l.stringValue.isEmpty {
          let w = min((l.cell?.cellSize.width ?? 0).rounded(.up), 220)
          right -= 6 + w
          place(l, x: right, width: w, height: l.intrinsicContentSize.height)
        }
        right -= 4
      }
      commit.isHidden = !withCommit
      noteLabel.isHidden = !withCommit || note.isEmpty
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

/// A list on the bar's glass: opening upward from the bar, the file finder's files, the best nearest the bar, or the
/// outline's classes and functions in order; at a ⌘-click, the definitions to choose from. Its rows are the web
/// address's suggestions; the arrow keys move through them, a click chooses one. Taller than the room, it scrolls. An
/// outline row ends in how many cards of the board show its lines and a button that adds it whole
final class CodeList: WebGlass {
  struct Item: Equatable {
    var title: String
    var detail: String
    var indent: CGFloat = 0
    var strong = false
    /// Cards of the board in front showing its lines; 0: none said
    var count = 0
    /// It ends in an add button
    var adds = false
    /// A group's name over its rows: not chosen
    var heading = false
  }

  var onChoose: ((Int) -> Void)?
  /// A row's add button pressed
  var onAdd: ((Int) -> Void)?
  /// Whether the add buttons do anything (a board is in front)
  var addsEnabled = true {
    didSet { for b in adders { paint(b) } }
  }
  private(set) var items: [Item] = []
  private(set) var rows: [WebSuggestionRow] = []
  /// Over each row's end, by row: nil where the row has none
  private(set) var adders: [BarButton?] = []
  private(set) var counts: [NSTextField?] = []
  /// Over each heading's row, which is hidden
  private(set) var headings: [NSTextField?] = []
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
    for v in rows as [NSView] + adders.compactMap({ $0 }) + counts.compactMap({ $0?.superview })
      + headings.compactMap({ $0 })
    {
      v.removeFromSuperview()
    }
    rows = items.enumerated().map { i, item in
      let r = WebSuggestionRow(title: item.title, detail: item.detail)
      if item.strong { r.titleLabel.font = .systemFont(ofSize: 12, weight: .semibold) }
      r.textX = 8 + item.indent
      r.tag = i
      r.target = self
      r.action = #selector(chose(_:))
      r.setAccessibilityIdentifier("\(id)\(i)")
      r.isHidden = item.heading
      stack.addSubview(r)
      return r
    }
    headings = items.map { item in
      guard item.heading else { return nil }
      let l = NSTextField(labelWithString: item.title)
      l.font = .systemFont(ofSize: 11, weight: .semibold)
      l.lineBreakMode = .byTruncatingTail
      stack.addSubview(l)
      return l
    }
    // over the rows, which take every press in them
    counts = items.enumerated().map { i, item in
      guard item.count > 0 else { return nil }
      let l = NSTextField(labelWithString: "\(item.count)")
      l.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .medium)
      l.alignment = .center
      l.toolTip = item.count == 1 ? "On 1 card of this board" : "On \(item.count) cards of this board"
      l.setAccessibilityIdentifier("\(id)count\(i)")
      // the pill apart from the label, so that the digits sit in its middle, not the label's line
      let pill = NSView()
      pill.wantsLayer = true
      pill.addSubview(l)
      stack.addSubview(pill)
      return l
    }
    adders = items.enumerated().map { i, item in
      guard item.adds else { return nil }
      let b = BarButton(radius: 6)
      b.image = NSImage(systemSymbolName: "plus", accessibilityDescription: "Add to Board")
      b.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
      b.setAccessibilityIdentifier("\(id)add\(i)")
      b.setAccessibilityLabel("Add \(item.title) to the Board")
      b.setAccessibilityHelp(item.strong ? "Add the whole class to the Board" : "Add the whole function to the Board")
      b.tag = i
      b.target = self
      b.action = #selector(added(_:))
      stack.addSubview(b)
      return b
    }
    restyle()
    isHidden = items.isEmpty
    needsLayout = true
  }

  override func restyle() {
    super.restyle()
    for r in rows { r.restyle(look) }
    for l in headings.compactMap({ $0 }) { l.textColor = NSColor(cgColor: look.ink.copy(alpha: 0.5) ?? look.ink) }
    for l in counts.compactMap({ $0 }) {
      l.textColor = NSColor(cgColor: look.ink.copy(alpha: 0.6) ?? look.ink)
      l.superview?.layer?.backgroundColor = look.ink.copy(alpha: 0.07)
    }
    for b in adders.compactMap({ $0 }) { paint(b) }
  }

  private func paint(_ b: BarButton?) {
    guard let b else { return }
    b.ink(look)
    b.alphaValue = addsEnabled ? 1 : 0.35
    b.toolTip = addsEnabled ? b.accessibilityHelp() : Self.noBoard
  }

  /// Why an add does nothing
  static let noBoard = "Open a board beside the pane to add code to it"

  @objc private func added(_ sender: NSButton) {
    if addsEnabled { onAdd?(sender.tag) }
  }

  /// `step` rows further from the bar (nearer when negative), within the list
  @discardableResult func move(by step: Int) -> Int? {
    guard !items.isEmpty else { return nil }
    let away = bottomUp ? step : -step
    var i = max(0, min(items.count - 1, (selected ?? (bottomUp ? -1 : items.count)) + away))
    // over headings
    while items[i].heading, items.indices.contains(i + away.signum()) { i += away.signum() }
    if !items[i].heading { select(i) }
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
      if let l = headings[i] {
        let lh = l.intrinsicContentSize.height
        l.frame = CGRect(x: 8, y: r.frame.minY + ((h - lh) / 2).rounded() + 2, width: w - 16, height: lh)
      }
      // the add button at the row's end, 4 in; the count before it
      var right = w - 4
      if let b = adders[i] {
        b.frame = CGRect(x: right - 22, y: r.frame.minY + (h - 22) / 2, width: 22, height: 22)
        right -= 22 + 4
      }
      if let l = counts[i], let pill = l.superview, let font = l.font {
        // the digits' middle (half the cap height over the baseline) in the pill's middle
        let ph: CGFloat = 16
        let size = l.intrinsicContentSize
        let pw = max(ph + 2, size.width.rounded(.up) + 8)
        pill.frame = CGRect(x: right - pw, y: (r.frame.minY + (h - ph) / 2).rounded(), width: pw, height: ph)
        pill.layer?.cornerRadius = ph / 2
        let baseline = (ph - font.capHeight) / 2
        l.frame = CGRect(x: 0, y: baseline + l.firstBaselineOffsetFromTop - size.height, width: pw, height: size.height)
      }
    }
  }

  @objc private func chose(_ sender: NSButton) { onChoose?(sender.tag) }
}

final class CodeFlipped: NSView {
  override var isFlipped: Bool { true }
}

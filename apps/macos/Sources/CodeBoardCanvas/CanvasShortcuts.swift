import AppKit

// The shortcut list (BoardView.tsx Keys, keymap.ts helpRows, Settings.tsx Shortcuts' filter): ? or the toolbar's ⋯
// opens it at the board's top right; its rows are the key table's (BoardKey.all), by group, never a list of its own.

extension CanvasView {
  /// ? and ⋯ Keyboard Shortcuts: the list opens, or closes
  package func toggleKeys() {
    if let k = keysPanel {
      k.removeFromSuperview()
      keysPanel = nil
      return
    }
    let k = KeysPanel(theme: theme, groups: KeysPanel.rows())
    k.onClose = { [weak self] in self?.toggleKeys() }
    // .keys: 12 from the right, 56 from the top, 60 from the bottom, 380 wide
    k.frame = CGRect(x: bounds.width - 12 - 380, y: 56, width: 380, height: max(120, bounds.height - 56 - 60))
    k.autoresizingMask = [.minXMargin, .height]
    addSubview(k)
    keysPanel = k
  }
}

/// The list itself (.keys): "Keyboard Shortcuts", the filter and the X, then each group's heading and its rows, key and
/// what it does, on the theme's paper (opaque) in its fonts
package final class KeysPanel: NSView, NSSearchFieldDelegate {
  package typealias Group = (name: String, rows: [(key: String, label: String)])
  var onClose: (() -> Void)?
  package let groups: [Group]
  /// What the filter keeps
  private(set) var shown: [Group]
  private let theme: Theme
  let face = CALayer()
  let title: NSTextField
  let search = NSSearchField()
  /// No shortcut matches: its sentence
  let empty = NSTextField(labelWithString: "")
  private let close = CAShapeLayer()
  private let scroll = NSScrollView()
  private static let header: CGFloat = 36

  init(theme: Theme, groups: [Group]) {
    self.theme = theme
    self.groups = groups
    shown = groups
    title = NSTextField(labelWithString: "Keyboard Shortcuts")
    super.init(frame: .zero)
    wantsLayer = true
    layer?.addSublayer(face)
    ShelfLook.glass(face, theme, radius: 14)
    // the paper itself: nothing of the board shows through
    face.backgroundColor = theme.surface
    title.font = font(13, weight: 600)
    title.textColor = NSColor(cgColor: theme.ink)
    title.frame = CGRect(x: 14, y: 9, width: 150, height: 18)
    addSubview(title)
    search.placeholderString = "Filter shortcuts…"
    search.font = font(12, weight: 400)
    search.controlSize = .small
    search.focusRingType = .none
    search.delegate = self
    addSubview(search)
    empty.font = font(12, weight: 400)
    empty.textColor = NSColor(cgColor: theme.ink3)
    empty.isHidden = true
    addSubview(empty)
    close.strokeColor = theme.ink2
    close.lineWidth = 1.3
    close.lineCap = .round
    layer?.addSublayer(close)
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.documentView = FlippedView()
    addSubview(scroll)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("KeysPanel is not loaded from nibs") }

  package override var isFlipped: Bool { true }

  /// The theme's --sys: the system's in Warm Ink, Source Serif 4 in Ink Wash
  private func font(_ size: CGFloat, weight: CGFloat) -> NSFont {
    guard theme.id == .inkWash else { return .systemFont(ofSize: size, weight: weight >= 600 ? .semibold : .regular) }
    return (Font.board("SourceSerif4-400-600", size: size, weight: weight, opticalSize: true)?.ct as NSFont?)
      ?? NSFont(name: "Georgia", size: size) ?? .systemFont(ofSize: size)
  }

  /// What each row's words are drawn in
  var labelFont: NSFont { font(12, weight: 400) }

  /// The key table by group, in its order
  static func rows() -> [Group] {
    var out: [Group] = []
    for g in BoardKey.groups {
      var rows: [(key: String, label: String)] = []
      for k in BoardKey.all where k.group == g { rows.append((k.show, k.label)) }
      if !rows.isEmpty { out.append((g, rows)) }
    }
    return out
  }

  /// helpRows(q): a group whose name has `q` keeps all its rows, else the rows whose words or keys have it; groups left
  /// empty go
  static func filter(_ groups: [Group], _ q: String) -> [Group] {
    let t = q.trimmingCharacters(in: .whitespaces).lowercased()
    guard !t.isEmpty else { return groups }
    var out: [Group] = []
    for g in groups {
      var rows: [(key: String, label: String)] = []
      for r in g.rows
      where g.name.lowercased().contains(t) || r.label.lowercased().contains(t)
        || r.key.lowercased().contains(t)
      {
        rows.append(r)
      }
      if !rows.isEmpty { out.append((g.name, rows)) }
    }
    return out
  }

  package func controlTextDidChange(_ obj: Notification) {
    shown = Self.filter(groups, search.stringValue)
    empty.stringValue = "No shortcut matches “\(search.stringValue)”."
    empty.isHidden = !shown.isEmpty
    filled = -1
    fill(width: scroll.contentSize.width)
  }

  /// A menu item's key as the menu shows it: ⌃⌥⇧⌘ then the key
  static func keyText(_ i: NSMenuItem) -> String {
    let k = i.keyEquivalent
    guard !k.isEmpty else { return "" }
    var m = i.keyEquivalentModifierMask
    if k.count == 1, k.first!.isUppercase { m.insert(.shift) }
    let special: [String: String] = [
      "\u{8}": "⌫", "\u{7f}": "⌫", "\r": "↵", "\u{1b}": "Esc", " ": "Space", "\t": "⇥",
      String(UnicodeScalar(NSLeftArrowFunctionKey)!): "←", String(UnicodeScalar(NSRightArrowFunctionKey)!): "→",
      String(UnicodeScalar(NSUpArrowFunctionKey)!): "↑", String(UnicodeScalar(NSDownArrowFunctionKey)!): "↓",
    ]
    var s = ""
    for (f, g) in [(NSEvent.ModifierFlags.control, "⌃"), (.option, "⌥"), (.shift, "⇧"), (.command, "⌘")]
    where m.contains(f) {
      s += g
    }
    return s + (special[k] ?? k.uppercased())
  }

  package override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    face.frame = bounds
    let x = CGMutablePath()
    let c = CGPoint(x: bounds.width - 4 - 11 - 6, y: Self.header / 2)
    x.move(to: CGPoint(x: c.x - 4, y: c.y - 4))
    x.addLine(to: CGPoint(x: c.x + 4, y: c.y + 4))
    x.move(to: CGPoint(x: c.x + 4, y: c.y - 4))
    x.addLine(to: CGPoint(x: c.x - 4, y: c.y + 4))
    close.path = x
    CATransaction.commit()
    search.frame = CGRect(x: 160, y: 7, width: max(60, bounds.width - 160 - 36), height: 22)
    empty.frame = CGRect(x: 14, y: Self.header + 8, width: bounds.width - 28, height: 18)
    scroll.frame = CGRect(x: 0, y: Self.header, width: bounds.width, height: max(0, bounds.height - Self.header - 8))
    fill(width: scroll.contentSize.width)
  }

  /// The rows laid out at `width`: headings (600 11 in --ink-3), each row a hair above it, the key (11 mono in --ink-2,
  /// 150 wide) and what it does (12), both wrapping
  private var filled: CGFloat = -1
  private func fill(width: CGFloat) {
    guard let doc = scroll.documentView, width != filled else { return }
    filled = width
    for v in doc.subviews { v.removeFromSuperview() }
    doc.wantsLayer = true
    for l in doc.layer?.sublayers ?? [] { l.removeFromSuperlayer() }
    let t = theme
    func label(_ s: String, _ font: NSFont, _ color: CGColor, x: CGFloat, y: CGFloat, w: CGFloat) -> CGFloat {
      let f = NSTextField(wrappingLabelWithString: s)
      f.font = font
      f.textColor = NSColor(cgColor: color)
      f.preferredMaxLayoutWidth = w
      let h = f.cell!.cellSize(forBounds: CGRect(x: 0, y: 0, width: w, height: 10_000)).height
      f.frame = CGRect(x: x, y: y, width: w, height: h)
      doc.addSubview(f)
      return h
    }
    let left: CGFloat = 14
    let w = width - 2 * left
    var y: CGFloat = 0
    for g in shown {
      y += 8
      y += label(g.name, font(11, weight: 600), t.ink3, x: left, y: y, w: w) + 4
      for r in g.rows {
        let hair = CALayer()
        hair.backgroundColor = t.line
        hair.frame = CGRect(x: left, y: y, width: w, height: 0.5)
        doc.layer?.addSublayer(hair)
        let a = label(
          r.key,
          (Font.board("JetBrainsMono-400-600", size: 11, weight: 400)?.ct as NSFont?)
            ?? .monospacedSystemFont(ofSize: 11, weight: .regular), t.ink2, x: left, y: y + 3, w: 140)
        let b = label(r.label, labelFont, t.ink, x: left + 150, y: y + 3, w: w - 150)
        y += max(a, b) + 6
      }
    }
    doc.frame = CGRect(x: 0, y: 0, width: width, height: y + 8)
  }

  var closeRect: CGRect { CGRect(x: bounds.width - 4 - 22 - 6, y: (Self.header - 22) / 2, width: 22, height: 22) }

  /// Pressed on the X: a click on it is a press and a release over it (main's <button>)
  private var down = false

  package override func mouseDown(with e: NSEvent) {
    CanvasView.under(self)?.stopGlide()
    down = closeRect.contains(convert(e.locationInWindow, from: nil))
  }
  package override func mouseUp(with e: NSEvent) {
    defer { down = false }
    if down, closeRect.contains(convert(e.locationInWindow, from: nil)) { onClose?() }
  }
  package override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

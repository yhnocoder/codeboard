import AppKit

// The shortcut list (BoardView.tsx Keys, keymap.ts helpRows): ? or the toolbar's ⋯ opens it at the right of the board;
// its rows are the board's key table (BoardKey.all), by group, then the app menu's keys, by menu, never a list of its
// own.

extension CanvasView {
  /// ? and ⋯ Keyboard Shortcuts: the list opens, or closes
  package func toggleKeys() {
    if let k = keysPanel {
      k.removeFromSuperview()
      keysPanel = nil
      return
    }
    let k = KeysPanel(theme: theme, groups: KeysPanel.rows(menu: NSApp?.mainMenu))
    k.onClose = { [weak self] in self?.toggleKeys() }
    k.frame = CGRect(x: bounds.width - 12 - 380, y: 56, width: 380, height: max(120, bounds.height - 56 - 60))
    k.autoresizingMask = [.minXMargin, .height]
    addSubview(k)
    keysPanel = k
  }
}

/// The list itself (.keys): "Keyboard Shortcuts" and its X, then each group's heading and its rows, key and what it does
package final class KeysPanel: NSView {
  package typealias Group = (name: String, rows: [(key: String, label: String)])
  var onClose: (() -> Void)?
  package let groups: [Group]
  private let theme: Theme
  private let face = CALayer()
  private let close = CAShapeLayer()
  private let scroll = NSScrollView()
  private static let header: CGFloat = 36

  init(theme: Theme, groups: [Group]) {
    self.theme = theme
    self.groups = groups
    super.init(frame: .zero)
    wantsLayer = true
    layer?.addSublayer(face)
    ShelfLook.glass(face, theme, radius: 14)
    let title = NSTextField(labelWithString: "Keyboard Shortcuts")
    title.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
    title.textColor = NSColor(cgColor: theme.ink)
    title.frame = CGRect(x: 14, y: 11, width: 300, height: 18)
    addSubview(title)
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

  /// The board's keys by group (gestures among them), then the app menu's by menu; a key the board already lists is
  /// not listed again
  static func rows(menu: NSMenu?) -> [Group] {
    var shown = Set<String>()
    var out: [Group] = []
    for g in BoardKey.groups {
      let rows: [(key: String, label: String)] = BoardKey.all.filter { $0.group == g }.map { ($0.show, $0.label) }
      shown.formUnion(rows.map(\.key))
      if !rows.isEmpty { out.append((g, rows)) }
    }
    for top in menu?.items ?? [] {
      guard let sub = top.submenu else { continue }
      var rows: [(key: String, label: String)] = []
      func walk(_ m: NSMenu) {
        for i in m.items where !i.isHidden && !i.isAlternate {
          if let s = i.submenu { walk(s) }
          let k = keyText(i)
          if !k.isEmpty && shown.insert(k).inserted { rows.append((k, i.title)) }
        }
      }
      walk(sub)
      if !rows.isEmpty { out.append((sub.title.isEmpty ? top.title : sub.title, rows)) }
    }
    return out
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
    for g in groups {
      y += 8
      y += label(g.name, .systemFont(ofSize: 11, weight: .semibold), t.ink3, x: left, y: y, w: w) + 4
      for r in g.rows {
        let hair = CALayer()
        hair.backgroundColor = t.line
        hair.frame = CGRect(x: left, y: y, width: w, height: 0.5)
        doc.layer?.addSublayer(hair)
        let a = label(
          r.key,
          (Font.board("JetBrainsMono-400-600", size: 11, weight: 400)?.ct as NSFont?)
            ?? .monospacedSystemFont(ofSize: 11, weight: .regular), t.ink2, x: left, y: y + 3, w: 140)
        let b = label(r.label, .systemFont(ofSize: 12), t.ink, x: left + 150, y: y + 3, w: w - 150)
        y += max(a, b) + 6
      }
    }
    doc.frame = CGRect(x: 0, y: 0, width: width, height: y + 8)
  }

  var closeRect: CGRect { CGRect(x: bounds.width - 4 - 22 - 6, y: (Self.header - 22) / 2, width: 22, height: 22) }

  package override func mouseDown(with e: NSEvent) { CanvasView.under(self)?.stopGlide() }
  package override func mouseUp(with e: NSEvent) {
    if closeRect.contains(convert(e.locationInWindow, from: nil)) { onClose?() }
  }
  package override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

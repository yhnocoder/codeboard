import AppKit
import CodeBoardMarkdown

/// Find and replace (editor/find.ts): ⌘F a small bar at the top right with the query, the count, back and on and the case
/// switch; ⌥⌘F adds the replacement. Every match is marked in the text; ↵ and ⇧↵ go on and back, ↵ in the replacement
/// replaces the current match, ⌘↵ all of them as one undo step; Esc closes it. At the screen's own size
@MainActor
final class FindBar: NSView, NSTextFieldDelegate {
  let query = NSTextField()
  let replacement = NSTextField()
  let count = NSTextField(labelWithString: "")
  /// Match Case, Previous and Next: the board's buttons, with its tips
  let buttons = FindButtons()
  var caseSensitive = false {
    didSet { buttons.caseOn = caseSensitive }
  }
  var replacing = false
  var onChange: () -> Void = {}
  var onStep: (Bool) -> Void = { _ in }
  var onReplace: (Bool) -> Void = { _ in }
  var onClose: () -> Void = {}

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.cornerRadius = 8
    layer?.borderWidth = 1
    for (f, p) in [(query, "Find"), (replacement, "Replace")] {
      f.placeholderString = p
      f.bezelStyle = .roundedBezel
      f.font = .systemFont(ofSize: 12)
      f.delegate = self
      addSubview(f)
    }
    count.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    count.textColor = .secondaryLabelColor
    addSubview(count)
    addSubview(buttons)
    buttons.onPress = { [weak self] id in
      switch id {
      case "case": self?.toggleCase()
      case "back": self?.onStep(false)
      default: self?.onStep(true)
      }
    }
    isHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }

  override func layout() {
    super.layout()
    query.frame = CGRect(x: 8, y: 8, width: 150, height: 24)
    count.frame = CGRect(x: 162, y: 12, width: 44, height: 16)
    buttons.frame = CGRect(x: 206, y: 8, width: 72, height: 24)
    replacement.frame = CGRect(x: 8, y: 38, width: 150, height: 24)
    replacement.isHidden = !replacing
  }

  /// a new look or appearance while shown
  func restyle(_ theme: MarkdownTheme) {
    layer?.backgroundColor = theme.colors.surface.cg
    layer?.borderColor = theme.colors.hair.cg
    buttons.theme = theme
  }

  func show(replace: Bool, theme: MarkdownTheme, in visible: CGRect) {
    replacing = replace
    layer?.backgroundColor = theme.colors.surface.cg
    layer?.borderColor = theme.colors.hair.cg
    buttons.theme = theme
    frame = CGRect(x: visible.maxX - 292, y: visible.minY + 8, width: 286, height: replace ? 70 : 40)
    isHidden = false
    needsLayout = true
    window?.makeFirstResponder(replace && !query.stringValue.isEmpty ? replacement : query)
  }

  func close() {
    guard !isHidden else { return }
    isHidden = true
    onClose()
  }

  private func toggleCase() {
    caseSensitive.toggle()
    onChange()
  }

  func controlTextDidChange(_ n: Notification) {
    if (n.object as? NSTextField) === query { onChange() }
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
    let shift = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
    let cmd = NSApp.currentEvent?.modifierFlags.contains(.command) ?? false
    switch sel {
    case #selector(NSResponder.insertNewline(_:)):
      if control === replacement {
        onReplace(cmd)
      } else {
        onStep(!shift)
      }
      return true
    case #selector(NSResponder.cancelOperation(_:)):
      close()
      return true
    default:
      return false
    }
  }
}

/// The find bar's buttons as the board's (.md-findbar .md-btn.md-ib with .tbtn): 24 square, 7 round, the ink at 7 %
/// behind on hover, 12 % and a little smaller while pressed, all at once; Match Case in the accent on --row while on.
/// Their tips name them and their keys (find.ts)
@MainActor
final class FindButtons: HoverControls {
  var theme: MarkdownTheme? { didSet { needsDisplay = true } }
  var caseOn = false { didSet { needsDisplay = true } }
  var onPress: (String) -> Void = { _ in }
  override var isFlipped: Bool { true }
  override var pressInk: Double? { 0.12 }
  private static let all = [
    (id: "case", symbol: "textformat", tip: "Match Case", keys: "⌥C"),
    (id: "back", symbol: "chevron.up", tip: "Previous Match", keys: "⇧Enter"),
    (id: "on", symbol: "chevron.down", tip: "Next Match", keys: "Enter"),
  ]

  override func controls() -> [(id: String, box: CGRect, tip: String)] {
    Self.all.enumerated().map {
      ($0.element.id, CGRect(x: CGFloat($0.offset) * 24, y: 0, width: 24, height: 24), $0.element.tip)
    }
  }
  override func keys(_ id: String) -> String? { Self.all.first { $0.id == id }?.keys }
  override func activate(_ id: String, box: CGRect) { onPress(id) }

  override func draw(_ dirtyRect: NSRect) {
    guard let theme, let ctx = NSGraphicsContext.current?.cgContext else { return }
    // Ink Wash squares the board's buttons; elsewhere the find bar's are 7 round
    let k = theme.controls.buttonRadius < 7 ? CGFloat(theme.controls.buttonRadius) : 7
    for (c, b) in zip(controls(), Self.all) {
      let look = look(c.id)
      let on = c.id == "case" && caseOn
      scaled(look.scale, about: c.box, ctx) {
        let fill = on ? (theme.controls.row ?? theme.colors.accent.alpha(0.09)) : theme.colors.ink.alpha(look.ink)
        if fill.a > 0 {
          ctx.addPath(CGPath(roundedRect: c.box, cornerWidth: k, cornerHeight: k, transform: nil))
          ctx.setFillColor(fill.cg)
          ctx.fillPath()
        }
        let ink = on ? theme.colors.accent : theme.colors.ink2.mixed(theme.colors.ink, look.hover)
        let config = NSImage.SymbolConfiguration(pointSize: 12, weight: .regular)
          .applying(.init(paletteColors: [NSColor(cgColor: ink.cg) ?? .labelColor]))
        guard
          let img = NSImage(systemSymbolName: b.symbol, accessibilityDescription: b.tip)?
            .withSymbolConfiguration(config)
        else { return }
        let s = img.size
        img.draw(
          in: CGRect(x: c.box.midX - s.width / 2, y: c.box.midY - s.height / 2, width: s.width, height: s.height))
      }
    }
  }
}

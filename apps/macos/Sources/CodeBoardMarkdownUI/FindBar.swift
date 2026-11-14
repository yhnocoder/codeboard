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
  private let caseButton = NSButton()
  private let back = NSButton()
  private let on = NSButton()
  var caseSensitive = false
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
    for (b, sym, tip) in [
      (caseButton, "textformat", "Match Case"), (back, "chevron.up", "Previous (⇧↵)"), (on, "chevron.down", "Next (↵)"),
    ] {
      b.image = NSImage(systemSymbolName: sym, accessibilityDescription: tip)
      b.toolTip = tip
      b.bezelStyle = .accessoryBarAction
      b.isBordered = false
      b.target = self
      addSubview(b)
    }
    caseButton.setButtonType(.pushOnPushOff)
    caseButton.action = #selector(toggleCase)
    back.action = #selector(goBack)
    on.action = #selector(goOn)
    isHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }

  override func layout() {
    super.layout()
    query.frame = CGRect(x: 8, y: 8, width: 150, height: 24)
    count.frame = CGRect(x: 162, y: 12, width: 44, height: 16)
    caseButton.frame = CGRect(x: 206, y: 8, width: 24, height: 24)
    back.frame = CGRect(x: 230, y: 8, width: 24, height: 24)
    on.frame = CGRect(x: 254, y: 8, width: 24, height: 24)
    replacement.frame = CGRect(x: 8, y: 38, width: 150, height: 24)
    replacement.isHidden = !replacing
  }

  func show(replace: Bool, theme: MarkdownTheme, in visible: CGRect) {
    replacing = replace
    layer?.backgroundColor = theme.colors.surface.cg
    layer?.borderColor = theme.colors.hair.cg
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

  @objc private func toggleCase() {
    caseSensitive.toggle()
    onChange()
  }
  @objc private func goBack() { onStep(false) }
  @objc private func goOn() { onStep(true) }

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

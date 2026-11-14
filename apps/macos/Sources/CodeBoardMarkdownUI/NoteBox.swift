import AppKit
import CodeBoardMarkdown

/// The toolbar's handwritten note box (bubble.tsx annot): one field under the selection; ↵ writes the note around the
/// selected words (or into the annotation the selection is in; empty takes it off), Esc closes it writing nothing
@MainActor
final class NoteBox: NSView, NSTextFieldDelegate {
  let field = NSTextField()
  var onWrite: (String) -> Void = { _ in }
  var onClose: () -> Void = {}

  override init(frame: NSRect) {
    super.init(frame: CGRect(x: 0, y: 0, width: 280, height: 44))
    wantsLayer = true
    layer?.cornerRadius = 8
    layer?.borderWidth = 1
    field.placeholderString = "Write a handwritten note…"
    field.bezelStyle = .roundedBezel
    field.font = .systemFont(ofSize: 12)
    field.delegate = self
    addSubview(field)
    isHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }

  override func layout() {
    super.layout()
    field.frame = CGRect(x: 10, y: 10, width: bounds.width - 20, height: 24)
  }

  /// a new look or appearance while shown
  func restyle(_ theme: MarkdownTheme) {
    layer?.backgroundColor = theme.colors.surface.cg
    layer?.borderColor = theme.colors.hair.cg
  }

  func show(_ note: String, under r: CGRect, theme: MarkdownTheme) {
    field.stringValue = note
    layer?.backgroundColor = theme.colors.surface.cg
    layer?.borderColor = theme.colors.hair.cg
    let room = superview?.bounds.width ?? 280
    frame = CGRect(x: max(0, min(r.minX, room - 280)), y: r.maxY + 6, width: 280, height: 44)
    isHidden = false
    window?.makeFirstResponder(field)
    field.currentEditor()?.selectAll(nil)
  }

  func close() {
    guard !isHidden else { return }
    isHidden = true
    onClose()
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
    if sel == #selector(NSResponder.insertNewline(_:)) {
      let v = field.stringValue
      close()
      onWrite(v)
      return true
    }
    if sel == #selector(NSResponder.cancelOperation(_:)) {
      close()
      return true
    }
    return false
  }
}

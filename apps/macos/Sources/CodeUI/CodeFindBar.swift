import AppKit
import CodeCore

/// A find bar at the top right of a CodeEditorView (⌘F): what is typed is found from the selection on as it is typed;
/// ↩ or ⌘G finds the next, ⇧↩ or ⇧⌘G the one before (both go round the end); Esc closes it and gives the keys back
/// to the editor, the found text selected. How it looks is the host's
public final class CodeFindBar: NSView, NSTextFieldDelegate {
  public struct Look {
    public var fill: CGColor
    public var line: CGColor
    public var text: CGColor
    public var font: CodeFont
    public var radius: CGFloat

    public init(fill: CGColor, line: CGColor, text: CGColor, font: CodeFont, radius: CGFloat) {
      self.fill = fill
      self.line = line
      self.text = text
      self.font = font
      self.radius = radius
    }
  }

  public let field = NSTextField()
  weak var editor: CodeEditorView?
  /// Where the selection began when the bar opened: typing finds from there on
  private var from = 0

  init(_ editor: CodeEditorView, look: Look) {
    self.editor = editor
    super.init(frame: CGRect(x: 0, y: 0, width: 220, height: 26))
    wantsLayer = true
    layer?.backgroundColor = look.fill
    layer?.borderColor = look.line
    layer?.borderWidth = 1
    layer?.cornerRadius = look.radius
    field.isBordered = false
    field.drawsBackground = false
    field.focusRingType = .none
    field.font = look.font.ct as NSFont
    field.textColor = NSColor(cgColor: look.text)
    field.placeholderString = "Find"
    field.delegate = self
    field.frame = bounds.insetBy(dx: 8, dy: 4)
    addSubview(field)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  public var query: String { field.stringValue }

  func opened() {
    from = editor?.editor.selection.range.lowerBound ?? 0
    window?.makeFirstResponder(field)
    field.currentEditor()?.selectAll(nil)
  }

  public func controlTextDidChange(_ n: Notification) {
    guard let e = editor else { return }
    e.change { $0.select(CodeSelection(from)) }
    e.findNext(forward: true)
  }

  public func control(_ c: NSControl, textView: NSTextView, doCommandBy s: Selector) -> Bool {
    switch s {
    case #selector(insertNewline(_:)):
      let back = NSApp.currentEvent?.modifierFlags.contains(.shift) == true
      editor?.findNext(forward: !back)
    case #selector(cancelOperation(_:)): editor?.closeFind()
    default: return false
    }
    return true
  }
}

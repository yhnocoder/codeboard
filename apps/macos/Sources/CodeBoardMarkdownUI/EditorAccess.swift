import AppKit
import CodeBoardMarkdown

/// What the editor tells assistive technology and a driver: a text area whose value is the Markdown, with its selection
/// and the caret's line; and the pointer's shape at a point
extension MarkdownEditorView {
  public override func isAccessibilityElement() -> Bool { true }
  public override func accessibilityRole() -> NSAccessibility.Role? { .textArea }
  public override func accessibilityRoleDescription() -> String? { "Markdown" }
  public override func accessibilityValue() -> Any? { core.source }
  public override func accessibilityNumberOfCharacters() -> Int { (core.source as NSString).length }
  public override func accessibilitySelectedTextRange() -> NSRange {
    let r = core.selection.range
    return NSRange(location: r.lowerBound, length: r.count)
  }
  public override func accessibilitySelectedText() -> String? {
    let r = core.selection.range
    return (core.source as NSString).substring(with: NSRange(location: r.lowerBound, length: r.count))
  }
  public override func accessibilityFrame(for range: NSRange) -> NSRect {
    firstRect(forCharacterRange: range, actualRange: nil)
  }

  /// The pointer's shape at a point (the view's points) with these modifiers: the resize arrows over a table's column
  /// and row edges and an image's handles, an open hand over a table grip, a pointing hand over a link with ⌘ held, the
  /// I-beam over text while editing, the arrow on the static picture
  public func cursor(at p: CGPoint, modifiers: NSEvent.ModifierFlags = []) -> NSCursor {
    let at = CGPoint(x: p.x / zoom, y: p.y / zoom)
    guard isEditing else { return .arrow }
    // a selected image's width grips on its sides (markdown.css .md-imgrip: ew-resize)
    if let box = imageBox, handles(box).contains(where: { $0.insetBy(dx: -4, dy: -4).contains(at) }) {
      return .resizeLeftRight
    }
    if let k = tableCursor(at) { return k }
    if modifiers.contains(.command), linkUnder(at) { return .pointingHand }
    return .iBeam
  }
}

import AppKit
import CodeBoardMarkdown

/// The caret's heading level (editor/headings.ts): a small "H2" in the left padding, ending a little before the heading's
/// first letter and sharing its first baseline, so it never covers text. A click opens the level menu: Body text and
/// Heading 1–6, the current one checked. It scales with the editor's zoom, as the heading does
@MainActor
final class HeadingChip: NSView {
  var level = 1
  var theme: MarkdownTheme?
  var zoom: CGFloat = 1
  var onPick: (Int) -> Void = { _ in }
  override var isFlipped: Bool { true }

  /// over the heading's first line: `baseline` its first baseline, `left` where its text starts (editor view points)
  func place(baseline: CGFloat, left: CGFloat) {
    let w = 12 * zoom
    let h = 13 * zoom
    frame = CGRect(x: left - 13.5 * zoom, y: baseline - h + 2.5 * zoom, width: w, height: h)
    isHidden = false
    needsDisplay = true
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let theme else { return }
    let s = "H\(level)" as NSString
    let font = NSFont.systemFont(ofSize: 8.5 * zoom, weight: .semibold)
    let attrs: [NSAttributedString.Key: Any] = [
      .font: font, .foregroundColor: NSColor(cgColor: theme.colors.ink3.cg) ?? .tertiaryLabelColor,
    ]
    let size = s.size(withAttributes: attrs)
    s.draw(at: CGPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: attrs)
  }

  override func mouseDown(with e: NSEvent) {
    let menu = NSMenu()
    for n in 0...6 {
      let item = NSMenuItem(
        title: n == 0 ? "Body Text" : "Heading \(n)", action: #selector(pick(_:)), keyEquivalent: "")
      item.tag = n
      item.target = self
      item.state = n == level ? .on : .off
      if n > 0 {
        item.attributedTitle = NSAttributedString(
          string: item.title,
          attributes: [.font: NSFont.systemFont(ofSize: [15, 15, 14, 13, 13, 13, 13][n], weight: .semibold)])
      }
      menu.addItem(item)
    }
    menu.popUp(positioning: nil, at: CGPoint(x: 0, y: bounds.maxY), in: self)
  }

  @objc private func pick(_ item: NSMenuItem) { onPick(item.tag) }
}

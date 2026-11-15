import AppKit
import CodeBoardMarkdown

/// The caret's heading level (editor/headings.ts): a small "H2" in the left padding, ending a little before the heading's
/// first letter and sharing its first baseline, so it never covers text. A click opens the level menu: Body text and
/// Heading 1–6, the current one checked. It scales with the editor's zoom, as the heading does. Hovered, and while its
/// menu is open, it is in the ink on the ink at 8.5 %, eased over 90 ms (.md-hchip-b:is(:hover, .open)); main gives it
/// no tip and no pressed look
@MainActor
final class HeadingChip: HoverControls {
  var level = 1
  var theme: MarkdownTheme?
  var zoom: CGFloat = 1
  var onPick: (Int) -> Void = { _ in }
  override var isFlipped: Bool { true }
  override func controls() -> [(id: String, box: CGRect, tip: String)] { [("chip", bounds, "")] }
  override var fade: Double { MarkdownTiming.headingChipFade }
  override var hoverInk: Double { 0.085 }
  // main's chip has no :active; Luna asked for the board buttons' press on every control of a Note (2026-11-15)
  override var pressInk: Double? { 0.12 }

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
    var attrs: [NSAttributedString.Key: Any] = [
      .font: font, .foregroundColor: NSColor(cgColor: theme.colors.ink3.cg) ?? .tertiaryLabelColor,
    ]
    let look = look("chip")
    if look.ink > 0, let ctx = NSGraphicsContext.current?.cgContext {
      if look.scale != 1 {
        ctx.translateBy(x: bounds.midX, y: bounds.midY)
        ctx.scaleBy(x: look.scale, y: look.scale)
        ctx.translateBy(x: -bounds.midX, y: -bounds.midY)
      }
      ctx.addPath(CGPath(roundedRect: bounds, cornerWidth: 3.5 * zoom, cornerHeight: 3.5 * zoom, transform: nil))
      ctx.setFillColor(theme.colors.ink.alpha(look.ink).cg)
      ctx.fillPath()
      attrs[.foregroundColor] =
        NSColor(cgColor: theme.colors.ink3.mixed(theme.colors.ink, look.hover).cg) ?? .labelColor
    }
    let size = s.size(withAttributes: attrs)
    s.draw(at: CGPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: attrs)
  }

  override func activate(_ id: String, box: CGRect) {
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
    open = "chip"
    menu.popUp(positioning: nil, at: CGPoint(x: 0, y: bounds.maxY), in: self)
    open = nil
    // the pointer may have gone anywhere while the menu was up
    hover(at: window.map { convert($0.mouseLocationOutsideOfEventStream, from: nil) })
  }

  @objc private func pick(_ item: NSMenuItem) { onPick(item.tag) }
}

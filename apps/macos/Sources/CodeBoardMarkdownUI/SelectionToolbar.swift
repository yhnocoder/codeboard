import AppKit
import CodeBoardMarkdown

/// The selection's toolbar (editor/bubble.tsx): once a selection has stood still for TOOLBAR_SETTLE with the button up,
/// a row of buttons over its first line (under it when there is no room above), at the screen's own size. While editing:
/// Bold, Italic, Strikethrough, Highlight, Inline Code, Link, Inline Math, Handwritten Note; on the static picture's
/// selection only Bold and Highlight (the board's static toolbar). A button is pressed when the selection is wrapped in
/// its markers; a press toggles them (one undo step). No labels: the web's icons say it (MarkdownIcons), the tooltips
/// name the keys; a thin separator between the marks and Link, as on the web
@MainActor
final class SelectionToolbar: HoverControls {
  struct Button {
    var id: String
    /// the icon's name in MarkdownIcons
    var symbol: String
    var tip: String
    var on: Bool
  }
  /// a separator goes before this button (bubble.tsx: between Inline Code and Link)
  private static let separated: Set<String> = ["link"]
  private let gap: CGFloat = 7
  private(set) var buttons: [Button] = []
  var onPress: (String) -> Void = { _ in }
  private(set) var theme: MarkdownTheme?
  private let size: CGFloat = 28

  override var isFlipped: Bool { true }

  /// Above the selection's first line, 8 points off, flipped under its last line when above would leave the Note's
  /// visible part, shifted across to stay 6 points inside it (bubble.tsx: place "top", gap 8, flip and shift, pad 6); and
  /// never over `avoid`, where the pointer last pressed (a press on the text there must reach the text)
  func show(
    _ buttons: [Button], over line: CGRect, under last: CGRect? = nil, in bounds: CGRect, avoid: CGPoint? = nil,
    theme: MarkdownTheme
  ) {
    self.buttons = buttons
    self.theme = theme
    let w = CGFloat(buttons.count) * size + 8 + CGFloat(buttons.filter { Self.separated.contains($0.id) }.count) * gap
    let h = size + 8
    let pad: CGFloat = 6
    let gap: CGFloat = 8
    let x = max(bounds.minX + pad, min(line.midX - w / 2, bounds.maxX - pad - w))
    let above = CGRect(x: x, y: line.minY - gap - h, width: w, height: h)
    let below = CGRect(x: x, y: (last ?? line).maxY + gap, width: w, height: h)
    let fitsAbove = above.minY >= bounds.minY + pad
    let fitsBelow = below.maxY <= bounds.maxY - pad
    var r = fitsAbove || !fitsBelow ? above : below
    if let p = avoid, r.insetBy(dx: -2, dy: -2).contains(p) {
      let other = r == above ? below : above
      if !other.insetBy(dx: -2, dy: -2).contains(p) { r = other }
    }
    frame = r
    toolTip = nil
    isHidden = false
    needsDisplay = true
    removeAllToolTips()
    for (i, b) in buttons.enumerated() { addToolTip(rect(i), owner: b.tip as NSString, userData: nil) }
  }

  func hide() { isHidden = true }

  override func controls() -> [(id: String, box: CGRect, tip: String)] {
    buttons.enumerated().map { ($0.element.id, rect($0.offset), $0.element.tip) }
  }

  private func rect(_ i: Int) -> CGRect {
    let seps = buttons.prefix(i + 1).filter { Self.separated.contains($0.id) }.count
    return CGRect(x: 4 + CGFloat(i) * size + CGFloat(seps) * gap, y: 4, width: size, height: size)
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let theme, let ctx = NSGraphicsContext.current?.cgContext else { return }
    let box = bounds.insetBy(dx: 0.5, dy: 0.5)
    let path = CGPath(roundedRect: box, cornerWidth: 8, cornerHeight: 8, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 3), blur: 12, color: CGColor(gray: 0, alpha: 0.18))
    ctx.addPath(path)
    ctx.setFillColor(theme.colors.surface.cg)
    ctx.fillPath()
    ctx.restoreGState()
    ctx.addPath(path)
    ctx.setStrokeColor(theme.colors.hair.cg)
    ctx.strokePath()
    for (i, b) in buttons.enumerated() {
      let r = rect(i)
      if b.on {
        ctx.setFillColor(theme.colors.accent.alpha(0.16).cg)
        ctx.addPath(CGPath(roundedRect: r.insetBy(dx: 2, dy: 2), cornerWidth: 5, cornerHeight: 5, transform: nil))
        ctx.fillPath()
      } else if hovered == b.id {
        // :hover as the board's buttons (.tbtn): the ink at 7 % behind it, 8.5 round, the icon in the ink
        ctx.setFillColor(theme.colors.ink.alpha(0.07).cg)
        ctx.addPath(
          CGPath(roundedRect: r.insetBy(dx: 1, dy: 1), cornerWidth: 8.5, cornerHeight: 8.5, transform: nil))
        ctx.fillPath()
      }
      if Self.separated.contains(b.id) {
        ctx.setFillColor(theme.colors.hair.cg)
        ctx.fill(CGRect(x: r.minX - gap / 2 - 0.5, y: r.midY - 8, width: 1, height: 16))
      }
      if let icon = MarkdownIcons.path(b.symbol) {
        ctx.saveGState()
        ctx.translateBy(x: r.midX - 8, y: r.midY - 8)
        ctx.addPath(icon)
        ctx.setStrokeColor((b.on ? theme.colors.accent : hovered == b.id ? theme.colors.ink : theme.colors.ink2).cg)
        ctx.setLineWidth(1.3)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        ctx.strokePath()
        ctx.restoreGState()
      }
    }
  }

  override func mouseDown(with e: NSEvent) {
    let p = convert(e.locationInWindow, from: nil)
    guard let i = buttons.indices.first(where: { rect($0).contains(p) }) else { return }
    onPress(buttons[i].id)
  }
}

extension MarkdownEditing {
  /// Whether the selection is wrapped in a pair of markers: they are just around it or at its edges (bubble.tsx isWrapped)
  public static func isWrapped(_ open: String, _ close: String, in state: MDEditState) -> Bool {
    let ns = state.source as NSString
    let r = state.selection.range
    let a = r.lowerBound
    let b = r.upperBound
    let lo = (open as NSString).length
    let lc = (close as NSString).length
    func text(_ x: Int, _ y: Int) -> String {
      guard x >= 0, y <= ns.length, x <= y else { return "" }
      return ns.substring(with: NSRange(location: x, length: y - x))
    }
    if text(a - lo, a) == open, text(b, b + lc) == close { return true }
    return b - a > lo + lc && text(a, a + lo) == open && text(b - lc, b) == close
  }
}

import AppKit
import CodeBoardMarkdown

/// The selection's toolbar (editor/bubble.tsx): once a selection has stood still for TOOLBAR_SETTLE with the button up,
/// a row of buttons over its first line (under it when there is no room above), at the screen's own size. While editing:
/// Bold, Italic, Strikethrough, Highlight, Inline Code, Link, Inline Math, Handwritten Note; on the static picture's
/// selection only Bold and Highlight (the board's static toolbar). A button is pressed when the selection is wrapped in
/// its markers; a press toggles them (one undo step). No labels: the symbols say it, the tooltips name the keys
@MainActor
final class SelectionToolbar: NSView {
  struct Button {
    var id: String
    var symbol: String
    var tip: String
    var on: Bool
  }
  private(set) var buttons: [Button] = []
  var onPress: (String) -> Void = { _ in }
  private var theme: MarkdownTheme?
  private let size: CGFloat = 28

  override var isFlipped: Bool { true }

  func show(_ buttons: [Button], over line: CGRect, in bounds: CGRect, theme: MarkdownTheme) {
    self.buttons = buttons
    self.theme = theme
    let w = CGFloat(buttons.count) * size + 8
    let h = size + 8
    var x = line.midX - w / 2
    x = min(max(bounds.minX, x), bounds.maxX - w)
    let above = line.minY - h - 6
    frame = CGRect(x: x, y: above >= bounds.minY - 40 ? above : line.maxY + 6, width: w, height: h)
    toolTip = nil
    isHidden = false
    needsDisplay = true
    removeAllToolTips()
    for (i, b) in buttons.enumerated() { addToolTip(rect(i), owner: b.tip as NSString, userData: nil) }
  }

  func hide() { isHidden = true }

  private func rect(_ i: Int) -> CGRect { CGRect(x: 4 + CGFloat(i) * size, y: 4, width: size, height: size) }

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
      }
      let ink = NSColor(cgColor: (b.on ? theme.colors.accent : theme.colors.ink2).cg) ?? .labelColor
      let config = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium).applying(.init(paletteColors: [ink]))
      if let img = NSImage(systemSymbolName: b.symbol, accessibilityDescription: b.tip)?.withSymbolConfiguration(config)
      {
        let s = img.size
        img.draw(in: CGRect(x: r.midX - s.width / 2, y: r.midY - s.height / 2, width: s.width, height: s.height))
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

import AppKit
import CodeBoardMarkdown

/// A reference the [[ menu offers (the host's: editor/menu.tsx RefItem)
public struct MarkdownRefCandidate: Sendable, Hashable {
  /// what [[label#^target]] writes
  public var label: String
  public var target: String?
  /// the row's title, and where it is (a board's name), shown after it
  public var title: String
  public var crumb: String?
  public init(label: String, target: String?, title: String, crumb: String? = nil) {
    self.label = label
    self.target = target
    self.title = title
    self.crumb = crumb
  }
}

/// A typed menu's list under the caret (/ blocks, [[ references, : emoji; editor/menu.tsx), at the screen's own size:
/// ↑ ↓ choose, ↵ or Tab take the row, Esc closes it for that trigger
@MainActor
final class MenuList: NSView {
  private(set) var items: [MDMenuItem] = []
  private(set) var chosen = 0
  private(set) var token: (kind: MDMenuKind, from: Int, query: String)?
  var dismissedAt: Int?
  private var theme: MarkdownTheme?
  private let rowHeight: CGFloat = 26
  var shown: Bool { !isHidden && !items.isEmpty }
  override var isFlipped: Bool { true }

  func show(
    _ items: [MDMenuItem], token: (kind: MDMenuKind, from: Int, query: String), under caret: CGRect,
    theme: MarkdownTheme
  ) {
    if self.token?.from != token.from { chosen = 0 }
    self.items = items
    self.token = token
    self.theme = theme
    chosen = min(chosen, max(0, items.count - 1))
    frame = CGRect(x: caret.minX, y: caret.maxY + 4, width: 240, height: CGFloat(items.count) * rowHeight + 8)
    isHidden = items.isEmpty
    needsDisplay = true
  }

  func hide() {
    items = []
    token = nil
    isHidden = true
  }

  func step(_ d: Int) {
    guard !items.isEmpty else { return }
    chosen = (chosen + d + items.count) % items.count
    needsDisplay = true
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
    let ink = NSColor(cgColor: theme.colors.ink.cg) ?? .labelColor
    let faint = NSColor(cgColor: theme.colors.ink3.cg) ?? .secondaryLabelColor
    let font = NSFont.systemFont(ofSize: 12.5)
    let small = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    for (i, it) in items.enumerated() {
      let row = CGRect(x: 4, y: 4 + CGFloat(i) * rowHeight, width: bounds.width - 8, height: rowHeight)
      if i == chosen {
        ctx.setFillColor(theme.colors.accent.alpha(0.14).cg)
        ctx.addPath(CGPath(roundedRect: row, cornerWidth: 5, cornerHeight: 5, transform: nil))
        ctx.fillPath()
      }
      (it.title as NSString).draw(
        in: CGRect(x: row.minX + 8, y: row.midY - 8, width: row.width - 90, height: 18),
        withAttributes: [.font: font, .foregroundColor: ink])
      let hs = (it.hint as NSString).size(withAttributes: [.font: small])
      (it.hint as NSString).draw(
        at: CGPoint(x: row.maxX - 8 - min(hs.width, 120), y: row.midY - hs.height / 2),
        withAttributes: [.font: small, .foregroundColor: faint])
    }
  }
}

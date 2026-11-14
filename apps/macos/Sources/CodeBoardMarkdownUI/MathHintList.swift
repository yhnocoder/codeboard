import AppKit
import CodeBoardMarkdown

/// The formula command list (editor/mathhints.ts): under the caret while a \command is typed in a formula's TeX, each row
/// the command typeset, its name, what it is and where it comes from (预设 the preamble, 本式 this formula). ↑ ↓ choose,
/// ↵ or Tab write it with the caret where its | is, Esc closes it until the next command. At the screen's own size,
/// whatever the zoom; each preview typeset once and kept
@MainActor
final class MathHintList: NSView {
  private(set) var items: [MDMathCommand] = []
  private(set) var chosen = 0
  /// where the command being typed starts in the source, and its query
  private(set) var token: (from: Int, query: String)?
  private var pictures: [String: MathPicture] = [:]
  private var theme: MarkdownTheme?
  private var math: MathTypesetter?
  private var preamble = ""
  /// closed by Esc for the command at this source offset
  var dismissedAt: Int?

  override var isFlipped: Bool { true }
  var shown: Bool { !isHidden && !items.isEmpty }

  private let rowHeight: CGFloat = 30
  private let width: CGFloat = 300

  func show(
    _ items: [MDMathCommand], token: (from: Int, query: String), under caret: CGRect, theme: MarkdownTheme,
    resources: MarkdownResources
  ) {
    if self.token?.from != token.from { chosen = 0 }
    self.items = items
    self.token = token
    self.theme = theme
    math = resources.math
    preamble = resources.mathPreamble
    chosen = min(chosen, max(0, items.count - 1))
    frame = CGRect(x: caret.minX, y: caret.maxY + 4, width: width, height: CGFloat(items.count) * rowHeight + 8)
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
    let mono = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .medium)
    let small = NSFont.systemFont(ofSize: 11)
    for (i, c) in items.enumerated() {
      let row = CGRect(x: 4, y: 4 + CGFloat(i) * rowHeight, width: width - 8, height: rowHeight)
      if i == chosen {
        ctx.setFillColor(theme.colors.accent.alpha(0.14).cg)
        ctx.addPath(CGPath(roundedRect: row, cornerWidth: 5, cornerHeight: 5, transform: nil))
        ctx.fillPath()
      }
      // the command typeset, at most 80 points wide
      if let pic = picture(c.preview) {
        let size: CGFloat = 13
        let k = min(1, 80 / max(1, CGFloat(pic.width) * size))
        ctx.saveGState()
        ctx.translateBy(x: row.minX + 6, y: row.midY - CGFloat(pic.height) * size * k / 2)
        ctx.scaleBy(x: k, y: k)
        SVGShapes.draw(pic.paths, pic.texts, ctx, scale: size, ink: theme.colors.ink, theme: theme, textFont: nil)
        ctx.restoreGState()
      }
      ("\\" + c.name as NSString).draw(
        at: CGPoint(x: row.minX + 96, y: row.midY - 8), withAttributes: [.font: mono, .foregroundColor: ink])
      let tag = c.origin == .preamble ? "预设  " : c.origin == .sameFormula ? "本式  " : ""
      ((tag + c.detail) as NSString).draw(
        in: CGRect(x: row.minX + 196, y: row.midY - 8, width: row.width - 200, height: 16),
        withAttributes: [.font: small, .foregroundColor: faint])
    }
  }

  private func picture(_ tex: String) -> MathPicture? {
    if let p = pictures[tex] { return p }
    guard let math, case .ok(let p) = math.typeset(tex, display: false, preamble: preamble) else { return nil }
    pictures[tex] = p
    return p
  }
}

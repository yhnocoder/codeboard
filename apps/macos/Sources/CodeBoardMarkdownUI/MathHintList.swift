import AppKit
import CodeBoardMarkdown

/// The formula command list (editor/mathhints.ts): under the caret while a \command is typed in a formula's TeX, each row
/// the command typeset, its name, where it comes from (预设 the preamble, 本式 this formula) and what it is. ↑ ↓ or the
/// pointer choose, ↵, Tab or a click write it with the caret where its | is, Esc closes it until the next command. At the
/// screen's own size, whatever the zoom; each preview typeset once and kept
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

  // .md-mathac: 250 wide, 4 of padding, rows of 4 + 8 around the name (12 × 1.3) over its description (11 × 1.4),
  // the foot under a line (2 above it, 4 + 2 around 10.5 type)
  private let width: CGFloat = 250
  private let rowHeight: CGFloat = 4 + 15.6 + 15.4 + 4
  private let footHeight: CGFloat = 2 + 4 + 15 + 2
  static let foot = "↑↓ 选 · 回车 / Tab 插入 · Esc 关"

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
    // at the caret, 6 under it (place bottom-start, gap 6)
    frame = CGRect(
      x: caret.minX, y: caret.maxY + 6, width: width, height: 8 + CGFloat(items.count) * rowHeight + footHeight)
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

  /// a row clicked: its command written (the caret stays in the source)
  var onTake: (Int) -> Void = { _ in }

  private func row(at p: CGPoint) -> Int? {
    let i = Int(((p.y - 4) / rowHeight).rounded(.down))
    return p.y >= 4 && i < items.count ? i : nil
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for a in trackingAreas where a.owner === self { removeTrackingArea(a) }
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeAlways], owner: self))
  }

  override func setFrameSize(_ s: NSSize) {
    super.setFrameSize(s)
    updateTrackingAreas()
  }

  /// the row under the pointer is the chosen one (mousemove)
  override func mouseMoved(with e: NSEvent) {
    guard let i = row(at: convert(e.locationInWindow, from: nil)), i != chosen else { return }
    chosen = i
    needsDisplay = true
  }

  override func mouseDown(with e: NSEvent) {
    guard let i = row(at: convert(e.locationInWindow, from: nil)) else { return }
    chosen = i
    onTake(i)
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let theme, let ctx = NSGraphicsContext.current?.cgContext else { return }
    let path = CGPath(roundedRect: bounds, cornerWidth: 10, cornerHeight: 10, transform: nil)
    ctx.saveGState()
    // --sh-float, as the other floating lists draw it
    ctx.setShadow(offset: CGSize(width: 0, height: 3), blur: 12, color: CGColor(gray: 0, alpha: 0.18))
    ctx.addPath(path)
    ctx.setFillColor(theme.colors.surface.cg)
    ctx.fillPath()
    ctx.restoreGState()
    ctx.addPath(
      CGPath(roundedRect: bounds.insetBy(dx: 0.25, dy: 0.25), cornerWidth: 10, cornerHeight: 10, transform: nil))
    ctx.setStrokeColor(theme.colors.hair.cg)
    ctx.setLineWidth(0.5)
    ctx.strokePath()
    let ink = NSColor(cgColor: theme.colors.ink.cg) ?? .labelColor
    let faint = NSColor(cgColor: theme.colors.ink3.cg) ?? .secondaryLabelColor
    let accent = NSColor(cgColor: theme.colors.accent.cg) ?? .controlAccentColor
    let fn = NSColor(cgColor: theme.colors.link.cg) ?? .linkColor
    let mono = NSFont.monospacedSystemFont(ofSize: 12, weight: .medium)
    let small = NSFont.systemFont(ofSize: 11)
    let cut = NSMutableParagraphStyle()
    cut.lineBreakMode = .byTruncatingTail
    let q = token?.query ?? ""
    for (i, c) in items.enumerated() {
      let row = CGRect(x: 4, y: 4 + CGFloat(i) * rowHeight, width: width - 8, height: rowHeight)
      if i == chosen {
        ctx.setFillColor(theme.colors.fill.cg)
        ctx.addPath(CGPath(roundedRect: row, cornerWidth: 7, cornerHeight: 7, transform: nil))
        ctx.fillPath()
      }
      // the command typeset, centred in its 62 wide column at 13.5
      let pv = CGRect(x: row.minX + 8, y: row.minY, width: 62, height: row.height)
      if let pic = picture(c.preview) {
        let size: CGFloat = 13.5
        let k = min(1, pv.width / max(1, CGFloat(pic.width) * size))
        let w = CGFloat(pic.width) * size * k
        ctx.saveGState()
        ctx.clip(to: pv)
        ctx.translateBy(x: pv.midX - w / 2, y: pv.midY - CGFloat(pic.height) * size * k / 2)
        ctx.scaleBy(x: k, y: k)
        SVGShapes.draw(pic.paths, pic.texts, ctx, scale: size, ink: theme.colors.ink, theme: theme, textFont: nil)
        ctx.restoreGState()
      }
      // \name, what is typed of it in the accent, its tag chip (预设 the preamble, 本式 this formula); then what it is
      let nx = pv.maxX + 8
      let nw = row.maxX - 8 - nx
      let name = NSMutableAttributedString(string: "\\", attributes: [.font: mono, .foregroundColor: ink])
      let head = !q.isEmpty && c.name.hasPrefix(q)
      if head { name.append(NSAttributedString(string: q, attributes: [.font: mono, .foregroundColor: accent])) }
      name.append(
        NSAttributedString(
          string: head ? String(c.name.dropFirst(q.count)) : c.name, attributes: [.font: mono, .foregroundColor: ink]))
      name.addAttribute(.paragraphStyle, value: cut, range: NSRange(location: 0, length: name.length))
      let tag = c.origin == .preamble ? "预设" : c.origin == .sameFormula ? "本式" : nil
      let tagFont = NSFont.systemFont(ofSize: 9.5, weight: .semibold)
      let tagW = tag.map { ceil(($0 as NSString).size(withAttributes: [.font: tagFont]).width) + 8 + 5 } ?? 0
      let top = row.minY + 4
      let nameW = min(ceil(name.size().width), nw - tagW)
      name.draw(
        with: CGRect(x: nx, y: top, width: nameW, height: 15.6),
        options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
      if let tag {
        let chip = CGRect(x: nx + nameW + 5, y: top + 1.5, width: tagW - 5, height: 13)
        ctx.addPath(CGPath(roundedRect: chip, cornerWidth: 4, cornerHeight: 4, transform: nil))
        ctx.setFillColor(theme.colors.link.alpha(0.12).cg)
        ctx.fillPath()
        (tag as NSString).draw(
          at: CGPoint(x: chip.minX + 4, y: chip.midY - 6), withAttributes: [.font: tagFont, .foregroundColor: fn])
      }
      (c.detail as NSString).draw(
        with: CGRect(x: nx, y: top + 15.6, width: nw, height: 15.4),
        options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
        attributes: [.font: small, .foregroundColor: faint, .paragraphStyle: cut])
    }
    // the keys, under a line (.foot)
    let fy = 4 + CGFloat(items.count) * rowHeight + 2
    ctx.setFillColor(theme.colors.line.cg)
    ctx.fill(CGRect(x: 4, y: fy, width: width - 8, height: 1))
    (Self.foot as NSString).draw(
      at: CGPoint(x: 4 + 8, y: fy + 1 + 4),
      withAttributes: [.font: NSFont.systemFont(ofSize: 10.5), .foregroundColor: faint])
  }

  private func picture(_ tex: String) -> MathPicture? {
    if let p = pictures[tex] { return p }
    guard let math, case .ok(let p) = math.typeset(tex, display: false, preamble: preamble) else { return nil }
    pictures[tex] = p
    return p
  }
}

import AppKit
import CodeBoardMarkdown

/// A reference the [[ menu offers (the host's: editor/menu.tsx RefItem)
/// What the [[ menu lists (menu.tsx refs): recently picked first (when nothing is typed), the local candidates (named
/// `here` when there are others), then the other places, one group each: its own row refers to the place itself, three
/// of its items show when nothing is typed and the rest behind "N more"
public struct MarkdownRefMenu: Sendable, Hashable {
  public var recent: [MarkdownRefCandidate]
  public var here: String?
  public var local: [MarkdownRefCandidate]
  public var groups: [MarkdownRefGroup]
  public init(
    recent: [MarkdownRefCandidate] = [], here: String? = nil, local: [MarkdownRefCandidate],
    groups: [MarkdownRefGroup] = []
  ) {
    self.recent = recent
    self.here = here
    self.local = local
    self.groups = groups
  }
}

/// Another place's candidates: its name, what [[…]] writes for the place itself, a note beside its name, its items
public struct MarkdownRefGroup: Sendable, Hashable {
  public var id: String
  public var title: String
  public var place: MarkdownRefCandidate
  public var note: String?
  public var items: [MarkdownRefCandidate]
  public init(
    id: String, title: String, place: MarkdownRefCandidate, note: String? = nil, items: [MarkdownRefCandidate]
  ) {
    self.id = id
    self.title = title
    self.place = place
    self.note = note
    self.items = items
  }
}

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
    if !items.isEmpty, !items[chosen].takes { chosen = items.firstIndex(where: \.takes) ?? 0 }
    // at most 300 points high (the [[ menu 340 and 372 wide), the rows scrolling inside (markdown.css .md-menu, .md-refs)
    let refs = token.kind == .ref
    // ending on a whole row where it scrolls (a row cut by the panel's edge read as a broken one)
    let cap: CGFloat = refs ? 340 : 300
    let rows = ((cap - 8) / rowHeight).rounded(.down)
    let h = min(CGFloat(items.count) * rowHeight + 8, rows * rowHeight + 8)
    frame = CGRect(x: caret.minX, y: caret.maxY + 4, width: refs ? 372 : 260, height: h)
    // a view draws outside its bounds unless told not to (macOS 14 on): the rows scrolled past the panel's edge are cut
    clipsToBounds = true
    keepChosenInView()
    isHidden = items.isEmpty
    needsDisplay = true
  }

  func hide() {
    items = []
    token = nil
    isHidden = true
  }

  /// how far the rows are scrolled
  private var scrolled: CGFloat = 0
  private var listHeight: CGFloat { CGFloat(items.count) * rowHeight + 8 }

  /// the chosen row in view, with a row and a half to spare above and below where the list allows (menu.tsx keepInView)
  private func keepChosenInView() {
    let top = 4 + CGFloat(chosen) * rowHeight
    let margin = rowHeight * 1.5
    if top - margin < scrolled { scrolled = top - margin }
    if top + rowHeight + margin > scrolled + bounds.height { scrolled = top + rowHeight + margin - bounds.height }
    scrolled = max(0, min(scrolled, listHeight - bounds.height))
  }

  override func scrollWheel(with e: NSEvent) {
    scrolled = max(0, min(scrolled - e.scrollingDeltaY, listHeight - bounds.height))
    needsDisplay = true
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for a in trackingAreas where a.owner === self { removeTrackingArea(a) }
    // over the whole panel: its visible rect is cut at the Note's edges, and the rows hanging below got no moves
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeAlways], owner: self))
  }

  override func setFrameSize(_ s: NSSize) {
    super.setFrameSize(s)
    updateTrackingAreas()
  }

  /// the pointer over a row makes it the chosen one (menu.tsx onPointerEnter), without scrolling the list
  override func mouseMoved(with e: NSEvent) { point(at: convert(e.locationInWindow, from: nil)) }

  /// the row under a point in the panel, as the list is scrolled now, is the chosen one
  func point(at p: CGPoint) {
    let i = Int(((p.y + scrolled - 4) / rowHeight).rounded(.down))
    guard i >= 0, i < items.count, items[i].takes, i != chosen else { return }
    chosen = i
    needsDisplay = true
  }

  /// a row clicked (a group's name is not taken)
  var onTake: (MDMenuItem) -> Void = { _ in }

  override func mouseDown(with e: NSEvent) {
    let p = convert(e.locationInWindow, from: nil)
    let i = Int((p.y + scrolled - 4) / rowHeight)
    guard i >= 0, i < items.count, items[i].takes else { return }
    chosen = i
    needsDisplay = true
    onTake(items[i])
  }

  func step(_ d: Int) {
    guard items.contains(where: \.takes) else { return }
    repeat { chosen = (chosen + d + items.count) % items.count } while !items[chosen].takes
    keepChosenInView()
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
    // the rows inside the panel's rounded box, the one half cut at its edge
    ctx.addPath(path)
    ctx.clip()
    let ink = NSColor(cgColor: theme.colors.ink.cg) ?? .labelColor
    let faint = NSColor(cgColor: theme.colors.ink3.cg) ?? .secondaryLabelColor
    let font = NSFont.systemFont(ofSize: 12.5)
    let small = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    for (i, it) in items.enumerated() {
      let row = CGRect(x: 4, y: 4 + CGFloat(i) * rowHeight - scrolled, width: bounds.width - 8, height: rowHeight)
      guard row.maxY > 0, row.minY < bounds.height else { continue }
      if it.style == .head {
        (it.title as NSString).draw(
          at: CGPoint(x: row.minX + 8, y: row.midY - 6),
          withAttributes: [.font: NSFont.systemFont(ofSize: 10.5, weight: .semibold), .foregroundColor: faint])
        continue
      }
      if i == chosen {
        // the chosen row: the accent, its text in the accent's ink (.md-menu button.sel)
        ctx.setFillColor(theme.colors.accent.cg)
        ctx.addPath(CGPath(roundedRect: row, cornerWidth: 5, cornerHeight: 5, transform: nil))
        ctx.fillPath()
      }
      let indent: CGFloat = it.style == .child || it.style == .more ? 22 : 8
      let on = i == chosen
      let accentInk = NSColor(cgColor: theme.colors.accentInk.cg) ?? .white
      let ink = on ? accentInk : ink
      let faint = on ? accentInk.withAlphaComponent(0.75) : faint
      // one line each, cut with an ellipsis: the hint (a crumb, "12 cards") at the right, the title in what is left
      let cut = NSMutableParagraphStyle()
      cut.lineBreakMode = .byTruncatingTail
      let hs = (it.hint as NSString).size(withAttributes: [.font: small])
      let hintW = it.hint.isEmpty ? 0 : min(ceil(hs.width), 120)
      (it.hint as NSString).draw(
        with: CGRect(x: row.maxX - 8 - hintW, y: row.midY - hs.height / 2, width: hintW, height: hs.height),
        options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
        attributes: [.font: small, .foregroundColor: faint, .paragraphStyle: cut])
      (it.title as NSString).draw(
        with: CGRect(
          x: row.minX + indent, y: row.midY - 8, width: max(0, row.width - indent - 8 - hintW - (hintW > 0 ? 10 : 0)),
          height: 18),
        options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
        attributes: [
          .font: it.style == .brow ? NSFont.systemFont(ofSize: 12.5, weight: .medium) : font,
          .foregroundColor: it.style == .more ? faint : ink, .paragraphStyle: cut,
        ])
    }
  }
}

import AppKit
import CodeBoardMarkdown
import CodeUI

/// The find bar's buttons as the web editor's (find.ts: Toggle Replace, Match Case, back, on, Close; Replace and All beside
/// the replacement; .md-findbar .md-btn.md-ib with .tbtn): 24 square, 7 round, the ink at 7 % behind on hover, 12 % and
/// a little smaller while pressed, all at once; Match Case and Toggle Replace in the accent on --row while on. Their tips
/// name them and their keys. Each does what its key does in the bar they are in (FindBar.perform), whose state they show
/// The find buttons for another editor's find bar (the canvas's code editor), in `theme`
@MainActor package func findButtons(_ theme: MarkdownTheme) -> NSView {
  let b = FindButtons()
  b.theme = theme
  return b
}

@MainActor
final class FindButtons: HoverControls {

  var theme: MarkdownTheme? { didSet { needsDisplay = true } }
  override var isFlipped: Bool { true }
  override var pressInk: Double? { 0.12 }
  private static let top: [(action: FindBar.Action, tip: String, keys: String)] = [
    (.toggleReplace, "Toggle Replace", "⌥⌘F"), (.matchCase, "Match Case", "⌥C"),
    (.previous, "Previous Match", "⇧Enter"), (.next, "Next Match", "Enter"), (.close, "Close", "Esc"),
  ]
  /// Beside the replacement: their words and widths
  private static let under: [(action: FindBar.Action, title: String, width: CGFloat, tip: String, keys: String)] = [
    (.replace, "Replace", 58, "Replace", "Enter"), (.replaceAll, "All", 32, "Replace All", "⌘Enter"),
  ]

  override init(frame: NSRect) { super.init(frame: frame) }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var intrinsicContentSize: NSSize { NSSize(width: CGFloat(Self.top.count) * 24, height: 24) }

  private var bar: FindBar? { superview as? FindBar }

  override func controls() -> [(id: String, box: CGRect, tip: String)] {
    let top = Self.top.enumerated().map {
      ($0.element.action.rawValue, CGRect(x: CGFloat($0.offset) * 24, y: 0, width: 24, height: 24), $0.element.tip)
    }
    guard bar?.replacing == true else { return top }
    var x: CGFloat = 0
    return top
      + Self.under.map { b in
        defer { x += b.width + 4 }
        return (b.action.rawValue, CGRect(x: x, y: 30, width: b.width, height: 24), b.tip)
      }
  }

  override func keys(_ id: String) -> String? {
    Self.top.first { $0.action.rawValue == id }?.keys ?? Self.under.first { $0.action.rawValue == id }?.keys
  }

  override func activate(_ id: String, box: CGRect) {
    guard let a = FindBar.Action(rawValue: id) else { return }
    bar?.perform(a)
    needsDisplay = true
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let theme, let ctx = NSGraphicsContext.current?.cgContext else { return }
    // Ink Wash squares the web page's buttons; elsewhere the find bar's are 7 round
    let k = theme.controls.buttonRadius < 7 ? CGFloat(theme.controls.buttonRadius) : 7
    let replacing = bar?.replacing == true
    for c in controls() {
      guard let action = FindBar.Action(rawValue: c.id) else { continue }
      let look = look(c.id)
      let on = (action == .matchCase && bar?.caseSensitive == true) || (action == .toggleReplace && replacing)
      scaled(look.scale, about: c.box, ctx) {
        let fill = on ? (theme.controls.row ?? theme.colors.accent.alpha(0.09)) : theme.colors.ink.alpha(look.ink)
        if fill.a > 0 {
          ctx.addPath(CGPath(roundedRect: c.box, cornerWidth: k, cornerHeight: k, transform: nil))
          ctx.setFillColor(fill.cg)
          ctx.fillPath()
        }
        let ink = on ? theme.colors.accent : theme.colors.ink2.mixed(theme.colors.ink, look.hover)
        let color = NSColor(cgColor: ink.cg) ?? .labelColor
        if let word = Self.under.first(where: { $0.action == action })?.title {
          let s = NSAttributedString(
            string: word, attributes: [.font: NSFont.systemFont(ofSize: 11.5), .foregroundColor: color])
          let size = s.size()
          s.draw(at: CGPoint(x: c.box.midX - size.width / 2, y: c.box.midY - size.height / 2))
          return
        }
        let config = NSImage.SymbolConfiguration(pointSize: 12, weight: .regular)
          .applying(.init(paletteColors: [color]))
        guard
          let img = NSImage(
            systemSymbolName: Self.symbol(action, replacing: replacing), accessibilityDescription: c.tip)?
            .withSymbolConfiguration(config)
        else { return }
        let s = img.size
        img.draw(
          in: CGRect(x: c.box.midX - s.width / 2, y: c.box.midY - s.height / 2, width: s.width, height: s.height))
      }
    }
  }

  private static func symbol(_ a: FindBar.Action, replacing: Bool) -> String {
    switch a {
    case .toggleReplace: replacing ? "chevron.down" : "chevron.right"
    case .matchCase: "textformat"
    case .previous: "chevron.up"
    case .next: "chevron.down"
    case .close: "xmark"
    case .replace, .replaceAll: ""
    }
  }
}

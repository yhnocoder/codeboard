import AppKit
import CodeBoardMarkdown

/// The find bar's buttons as the board's (.md-findbar .md-btn.md-ib with .tbtn): 24 square, 7 round, the ink at 7 %
/// behind on hover, 12 % and a little smaller while pressed, all at once; Match Case in the accent on --row while on.
/// Their tips name them and their keys (find.ts)
@MainActor
final class FindButtons: HoverControls {
  var theme: MarkdownTheme? { didSet { needsDisplay = true } }
  var caseOn = false { didSet { needsDisplay = true } }
  var onPress: (String) -> Void = { _ in }
  override var isFlipped: Bool { true }
  override var pressInk: Double? { 0.12 }
  private static let all = [
    (id: "case", symbol: "textformat", tip: "Match Case", keys: "⌥C"),
    (id: "back", symbol: "chevron.up", tip: "Previous Match", keys: "⇧Enter"),
    (id: "on", symbol: "chevron.down", tip: "Next Match", keys: "Enter"),
  ]

  override func controls() -> [(id: String, box: CGRect, tip: String)] {
    Self.all.enumerated().map {
      ($0.element.id, CGRect(x: CGFloat($0.offset) * 24, y: 0, width: 24, height: 24), $0.element.tip)
    }
  }
  override func keys(_ id: String) -> String? { Self.all.first { $0.id == id }?.keys }
  override func activate(_ id: String, box: CGRect) { onPress(id) }

  override func draw(_ dirtyRect: NSRect) {
    guard let theme, let ctx = NSGraphicsContext.current?.cgContext else { return }
    // Ink Wash squares the board's buttons; elsewhere the find bar's are 7 round
    let k = theme.controls.buttonRadius < 7 ? CGFloat(theme.controls.buttonRadius) : 7
    for (c, b) in zip(controls(), Self.all) {
      let look = look(c.id)
      let on = c.id == "case" && caseOn
      scaled(look.scale, about: c.box, ctx) {
        let fill = on ? (theme.controls.row ?? theme.colors.accent.alpha(0.09)) : theme.colors.ink.alpha(look.ink)
        if fill.a > 0 {
          ctx.addPath(CGPath(roundedRect: c.box, cornerWidth: k, cornerHeight: k, transform: nil))
          ctx.setFillColor(fill.cg)
          ctx.fillPath()
        }
        let ink = on ? theme.colors.accent : theme.colors.ink2.mixed(theme.colors.ink, look.hover)
        let config = NSImage.SymbolConfiguration(pointSize: 12, weight: .regular)
          .applying(.init(paletteColors: [NSColor(cgColor: ink.cg) ?? .labelColor]))
        guard
          let img = NSImage(systemSymbolName: b.symbol, accessibilityDescription: b.tip)?
            .withSymbolConfiguration(config)
        else { return }
        let s = img.size
        img.draw(
          in: CGRect(x: c.box.midX - s.width / 2, y: c.box.midY - s.height / 2, width: s.width, height: s.height))
      }
    }
  }
}

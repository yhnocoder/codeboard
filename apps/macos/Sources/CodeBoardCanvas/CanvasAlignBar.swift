import AppKit
import CodeBoardModel

// The bar over two or more selected cards (main's canvas/Canvas.tsx AlignBar, styles.css .alignbar and .alignmore):
// Create Section, Create Sub-board, Tidy Up | ⋯, which opens Align (five) and Distribute (two). It is in view points,
// the same size at any zoom, 12 above the cards (below them when the board's title row is in the way) and kept inside
// the view; its buttons act on the release over them.

/// What a button of the bar does
enum AlignBarButton: Hashable {
  case section
  case subBoard
  case tidy
  case more
  case align(AlignOp)
}

/// .alignbar.pill: 4 of padding, 2 between its parts; its .tbtn 30 tall (0 10 padding, a 16 icon, 6, 12.5px words), a
/// 1 × 16 .sep 3 from each side, the ⋯ .ib 30 square. .alignmore: 6 under the bar at its right, 4 of padding, a grid of
/// five 30 columns 2 apart, each group under its title (600 10.5px capitals, 0.06em apart, 6 6 3 round it)
enum AlignBarLayout {
  /// BAR_H
  static let height: CGFloat = 38
  /// BAR_PAD
  static let pad: CGFloat = 8
  /// CHROME_Y
  static let chromeY: CGFloat = 56
  static let margin: CGFloat = 32
  static let ops: [(AlignOp, String, String)] = [
    (
      .left, "Align Left",
      "M2 1v14M5.5 2H13.5A.5 .5 0 0 1 14 2.5V5.5A.5 .5 0 0 1 13.5 6H5.5A.5 .5 0 0 1 5 5.5V2.5A.5 .5 0 0 1 5.5 2zM5.5 10H10.5A.5 .5 0 0 1 11 10.5V13.5A.5 .5 0 0 1 10.5 14H5.5A.5 .5 0 0 1 5 13.5V10.5A.5 .5 0 0 1 5.5 10z"
    ),
    (
      .hcenter, "Align Centre",
      "M8 1v1M8 6v4M8 14v1M2.5 2H13.5A.5 .5 0 0 1 14 2.5V5.5A.5 .5 0 0 1 13.5 6H2.5A.5 .5 0 0 1 2 5.5V2.5A.5 .5 0 0 1 2.5 2zM4.5 10H11.5A.5 .5 0 0 1 12 10.5V13.5A.5 .5 0 0 1 11.5 14H4.5A.5 .5 0 0 1 4 13.5V10.5A.5 .5 0 0 1 4.5 10z"
    ),
    (
      .right, "Align Right",
      "M14 1v14M2.5 2H10.5A.5 .5 0 0 1 11 2.5V5.5A.5 .5 0 0 1 10.5 6H2.5A.5 .5 0 0 1 2 5.5V2.5A.5 .5 0 0 1 2.5 2zM5.5 10H10.5A.5 .5 0 0 1 11 10.5V13.5A.5 .5 0 0 1 10.5 14H5.5A.5 .5 0 0 1 5 13.5V10.5A.5 .5 0 0 1 5.5 10z"
    ),
    (
      .top, "Align Top",
      "M1 2h14M2.5 5H5.5A.5 .5 0 0 1 6 5.5V13.5A.5 .5 0 0 1 5.5 14H2.5A.5 .5 0 0 1 2 13.5V5.5A.5 .5 0 0 1 2.5 5zM10.5 5H13.5A.5 .5 0 0 1 14 5.5V10.5A.5 .5 0 0 1 13.5 11H10.5A.5 .5 0 0 1 10 10.5V5.5A.5 .5 0 0 1 10.5 5z"
    ),
    (
      .bottom, "Align Bottom",
      "M1 14h14M2.5 2H5.5A.5 .5 0 0 1 6 2.5V10.5A.5 .5 0 0 1 5.5 11H2.5A.5 .5 0 0 1 2 10.5V2.5A.5 .5 0 0 1 2.5 2zM10.5 5H13.5A.5 .5 0 0 1 14 5.5V10.5A.5 .5 0 0 1 13.5 11H10.5A.5 .5 0 0 1 10 10.5V5.5A.5 .5 0 0 1 10.5 5z"
    ),
    (
      .hdist, "Distribute Horizontally",
      "M2 2v12M14 2v12M6.5 4H9.5A.5 .5 0 0 1 10 4.5V11.5A.5 .5 0 0 1 9.5 12H6.5A.5 .5 0 0 1 6 11.5V4.5A.5 .5 0 0 1 6.5 4z"
    ),
    (
      .vdist, "Distribute Vertically",
      "M2 2h12M2 14h12M4.5 6H11.5A.5 .5 0 0 1 12 6.5V9.5A.5 .5 0 0 1 11.5 10H4.5A.5 .5 0 0 1 4 9.5V6.5A.5 .5 0 0 1 4.5 6z"
    ),
  ]
  /// icons.tsx newSection, subBoard, tidy
  static let tidy =
    "M3 2H5A1 1 0 0 1 6 3V5A1 1 0 0 1 5 6H3A1 1 0 0 1 2 5V3A1 1 0 0 1 3 2zM11 2H13A1 1 0 0 1 14 3V5A1 1 0 0 1 13 6H11A1 1 0 0 1 10 5V3A1 1 0 0 1 11 2zM3 10H5A1 1 0 0 1 6 11V13A1 1 0 0 1 5 14H3A1 1 0 0 1 2 13V11A1 1 0 0 1 3 10zM11 10H13A1 1 0 0 1 14 11V13A1 1 0 0 1 13 14H11A1 1 0 0 1 10 13V11A1 1 0 0 1 11 10z"
  static let newSection = "M4 3H12A2 2 0 0 1 14 5V11A2 2 0 0 1 12 13H4A2 2 0 0 1 2 11V5A2 2 0 0 1 4 3zM2 6h12"
  static let subBoard =
    "M4 2H12A2 2 0 0 1 14 4V12A2 2 0 0 1 12 14H4A2 2 0 0 1 2 12V4A2 2 0 0 1 4 2zM6 5H10A1 1 0 0 1 11 6V10A1 1 0 0 1 10 11H6A1 1 0 0 1 5 10V6A1 1 0 0 1 6 5z"

  static func font(_ t: Theme) -> Font {
    t.id == .inkWash
      ? Font.board("SourceSerif4-400-600", size: 12.5, weight: 400, opticalSize: true)
        ?? Font(NSFont(name: "Georgia", size: 12.5) ?? NSFont.systemFont(ofSize: 12.5))
      : Font(NSFont.systemFont(ofSize: 12.5))
  }

  static func titleFont(_ t: Theme) -> Font {
    var f =
      t.id == .inkWash
      ? Font.board("SourceSerif4-400-600", size: 10.5, weight: 600, opticalSize: true)
        ?? Font(NSFont(name: "Georgia-Bold", size: 10.5) ?? NSFont.boldSystemFont(ofSize: 10.5))
      : Font(NSFont.systemFont(ofSize: 10.5, weight: .semibold))
    f.tracking = 10.5 * 0.06
    return f
  }

  /// The bar's buttons and separator from its top left, and its width
  static func bar(_ font: Font) -> (buttons: [(AlignBarButton, CGRect)], sep: CGRect, width: CGFloat) {
    var x: CGFloat = 4
    var buttons: [(AlignBarButton, CGRect)] = []
    for (b, word) in [(AlignBarButton.section, "Create Section"), (.subBoard, "Create Sub-board"), (.tidy, "Tidy Up")] {
      let w = 10 + 16 + 6 + Drawing.width(word, font) + 10
      buttons.append((b, CGRect(x: x, y: 4, width: w, height: 30)))
      x += w + 2
    }
    let sep = CGRect(x: x + 3, y: (height - 16) / 2, width: 1, height: 16)
    x = sep.maxX + 3 + 2
    buttons.append((.more, CGRect(x: x, y: 4, width: 30, height: 30)))
    return (buttons, sep, x + 30 + 4)
  }

  /// The ⋯ panel's buttons and titles from its top left, and its size
  static func more(_ title: Font) -> (buttons: [(AlignBarButton, CGRect)], titles: [(String, CGRect)], size: CGSize) {
    let th = 6 + CTFontGetSize(title.ct) + 3
    var y: CGFloat = 4
    var buttons: [(AlignBarButton, CGRect)] = []
    var titles: [(String, CGRect)] = []
    for (name, group) in [("ALIGN", ops.prefix(5)), ("DISTRIBUTE", ops.suffix(2))] {
      titles.append((name, CGRect(x: 4, y: y, width: 5 * 30 + 4 * 2, height: th)))
      y += th + 2
      for (k, op) in group.enumerated() {
        buttons.append((.align(op.0), CGRect(x: 4 + CGFloat(k) * 32, y: y, width: 30, height: 30)))
      }
      y += 30 + 2
    }
    return (buttons, titles, CGSize(width: 4 + 5 * 30 + 4 * 2 + 4, height: y - 2 + 4))
  }
}

extension CanvasView {
  /// The cards the bar is for, at their frames as drawn: two or more selected, on the cards level, nothing dragged
  var alignCards: [(id: CardID, rect: CGRect)] {
    guard let doc = document, scene != nil, !opening, levels.level == .cards else { return [] }
    if case .move? = gesture?.kind { return [] }
    let rs = doc.selection.compactMap { item -> (id: CardID, rect: CGRect)? in
      guard case .card(let id) = item, let r = liveRect(item) else { return nil }
      return (id, r)
    }
    return rs.count >= 2 ? rs : []
  }

  /// Where the bar is in the view: over the cards' middle, 12 above them, or 12 below them when that is in the board's
  /// title row; then kept inside the view, clear of its toolbars
  func alignBarFrame() -> CGRect? {
    let rs = alignCards
    guard let first = rs.first else { return nil }
    let b = rs.dropFirst().reduce(first.rect) { $0.union($1.rect) }
    let w = AlignBarLayout.bar(AlignBarLayout.font(theme)).width
    let h = AlignBarLayout.height
    let top = camera.view(CGPoint(x: b.midX, y: b.minY))
    let below = camera.view(CGPoint(x: b.midX, y: b.maxY))
    let y = top.y - 12 - h >= AlignBarLayout.chromeY ? top.y - 12 - h : below.y + 12
    let pad = AlignBarLayout.pad
    return CGRect(
      x: max(pad, min(top.x - w / 2, bounds.width - pad - w)).rounded(),
      y: max(AlignBarLayout.chromeY, min(y, bounds.height - AlignBarLayout.chromeY - h)), width: w, height: h)
  }

  /// The ⋯ panel in the view: 6 under the bar, at its right
  func alignMoreFrame(_ bar: CGRect) -> CGRect {
    let s = AlignBarLayout.more(AlignBarLayout.titleFont(theme)).size
    return CGRect(x: bar.maxX - s.width, y: bar.maxY + 6, width: s.width, height: s.height)
  }

  /// The bar's button under a view point; .some(nil): on the bar or its open panel, between buttons
  func alignBarButton(at v: CGPoint) -> AlignBarButton?? {
    guard !alignBar.isHidden, let bar = alignBarFrame() else { return nil }
    if bar.contains(v) {
      let at = CGPoint(x: v.x - bar.minX, y: v.y - bar.minY)
      return .some(AlignBarLayout.bar(AlignBarLayout.font(theme)).buttons.first { $0.1.contains(at) }?.0)
    }
    let m = alignMoreFrame(bar)
    if alignMore, m.contains(v) {
      let at = CGPoint(x: v.x - m.minX, y: v.y - m.minY)
      return .some(AlignBarLayout.more(AlignBarLayout.titleFont(theme)).buttons.first { $0.1.contains(at) }?.0)
    }
    return nil
  }

  /// The bar where it goes now, drawn again when what it shows changed; the panel closes when the cards change
  func placeAlignBar() {
    let cards = alignCards.map(\.id)
    if cards != alignFor {
      alignFor = cards
      if alignMore { setAlignMore(false) }
    }
    guard let f = alignBarFrame() else {
      if !alignBar.isHidden { withoutAnimation { alignBar.isHidden = true } }
      return
    }
    let look = AlignBarLook(
      theme: theme.id, dark: theme.dark, scale: backing, hovered: alignHovered, pressed: alignPressed,
      more: alignMore)
    withoutAnimation {
      if alignBarDrawn != look {
        alignBarDrawn = look
        paintAlignBar()
      }
      let m = AlignBarLayout.margin
      alignBar.frame = f.insetBy(dx: -m, dy: -m)
      alignMoreLayer.frame = alignMoreFrame(f).insetBy(dx: -m, dy: -m).offsetBy(dx: -f.minX + m, dy: -f.minY + m)
      alignBar.isHidden = false
    }
  }

  /// The panel opens from its top right, growing from 0.97 of its size and fading in over 150 ms; it goes the same way
  /// back over 90 ms
  func setAlignMore(_ open: Bool) {
    let was = alignMoreLayer.isHidden ? nil : alignMoreLayer.contents
    alignMore = open
    alignBarDrawn = nil
    placeAlignBar()
    let l: CALayer
    if open {
      l = alignMoreLayer
    } else {
      guard let was, !alignBar.isHidden else { return }
      l = CALayer()
      l.frame = alignMoreLayer.frame
      l.contents = was
      l.contentsScale = alignMoreLayer.contentsScale
      l.opacity = 0
      alignBar.addSublayer(l)
    }
    let m = AlignBarLayout.margin
    let f = l.frame
    let anchor = CGPoint(x: (f.width - m) / f.width, y: m / f.height)
    withoutAnimation {
      l.anchorPoint = anchor
      l.frame = f
    }
    let grow = CABasicAnimation(keyPath: "transform.scale")
    grow.fromValue = open ? 0.97 : 1
    grow.toValue = open ? 1 : 0.97
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = open ? 0 : 1
    fade.toValue = open ? 1 : 0
    let g = CAAnimationGroup()
    g.animations = [grow, fade]
    g.duration = open ? 0.15 : 0.09
    // styles.css --in: cubic-bezier(0.4, 0, 1, 1)
    g.timingFunction =
      open ? CAMediaTimingFunction(name: .easeOut) : CAMediaTimingFunction(controlPoints: 0.4, 0, 1, 1)
    CATransaction.begin()
    if !open { CATransaction.setCompletionBlock { l.removeFromSuperlayer() } }
    l.add(g, forKey: "open")
    CATransaction.commit()
  }

  /// What a press on the bar's button does, on the release over it
  func pressAlignBar(_ b: AlignBarButton) {
    switch b {
    case .section:
      setAlignMore(false)
      moveToNewSection()
    case .subBoard:
      setAlignMore(false)
      turnIntoBoard(nil)
    case .tidy:
      setAlignMore(false)
      tidyUp()
    case .more: setAlignMore(!alignMore)
    case .align(let op):
      guard let doc = document else { return }
      let rs = alignCards.map {
        (id: $0.id, rect: Rect(x: $0.rect.minX, y: $0.rect.minY, width: $0.rect.width, height: $0.rect.height))
      }
      doc.edit([.hdist, .vdist].contains(op) ? "Distribute" : "Align") { $0.align(rs, op) }
    }
  }

  /// The pointer over the bar: the button under it lights up
  func hoverAlignBar(_ b: AlignBarButton?) {
    guard b != alignHovered else { return }
    alignHovered = b
    placeAlignBar()
  }

  private func paintAlignBar() {
    let t = theme
    let look = BarLook.of(t)
    let font = AlignBarLayout.font(t)
    let l = AlignBarLayout.bar(font)
    let m = AlignBarLayout.margin
    let ink = t.id == .inkWash
    let size = CGSize(width: l.width, height: AlignBarLayout.height)
    alignBar.contents = Self.picture(
      size: CGSize(width: size.width + 2 * m, height: size.height + 2 * m), scale: backing
    ) { ctx in
      ctx.translateBy(x: m, y: m)
      WritingBar.float(
        CGRect(origin: .zero, size: size), radius: look.radius, look: look, glass: look.glass, scale: backing,
        squircle: !ink, in: ctx)
      ctx.setFillColor(look.sep)
      ctx.fill(l.sep)
      for (b, r) in l.buttons {
        paintAlignButton(b, in: r, lit: b == .more && alignMore, look: look, ctx) { color in
          switch b {
          case .section, .subBoard, .tidy:
            let (icon, word) =
              b == .section
              ? (AlignBarLayout.newSection, "Create Section")
              : b == .subBoard ? (AlignBarLayout.subBoard, "Create Sub-board") : (AlignBarLayout.tidy, "Tidy Up")
            Icons.stroke(SVGPath.parse(icon), at: CGPoint(x: r.minX + 10, y: r.midY - 8), color: color, in: ctx)
            Self.chipLabel(word, x: r.minX + 10 + 16 + 6, midY: r.midY, font: font, color: color, ctx)
          default:
            // icons.tsx more: three filled squares of 2
            ctx.setFillColor(color)
            for x: CGFloat in [2, 7, 12] { ctx.fill(CGRect(x: r.midX - 8 + x, y: r.midY - 1, width: 2, height: 2)) }
          }
        }
      }
    }
    alignBar.contentsScale = backing
    alignMoreLayer.isHidden = !alignMore
    guard alignMore else { return }
    let title = AlignBarLayout.titleFont(t)
    let p = AlignBarLayout.more(title)
    alignMoreLayer.contents = Self.picture(
      size: CGSize(width: p.size.width + 2 * m, height: p.size.height + 2 * m), scale: backing
    ) { ctx in
      ctx.translateBy(x: m, y: m)
      WritingBar.float(
        CGRect(origin: .zero, size: p.size), radius: 12, look: look, glass: look.glass, scale: backing,
        squircle: !ink, in: ctx)
      for (s, r) in p.titles {
        Self.chipLabel(
          s, x: r.minX + 6, midY: r.minY + 6 + CTFontGetSize(title.ct) / 2, font: title, color: t.ink3, ctx)
      }
      for (b, r) in p.buttons {
        guard case .align(let op) = b, let d = AlignBarLayout.ops.first(where: { $0.0 == op })?.2 else { continue }
        paintAlignButton(b, in: r, lit: false, look: look, ctx) { color in
          Icons.stroke(SVGPath.parse(d), at: CGPoint(x: r.midX - 8, y: r.midY - 8), color: color, in: ctx)
        }
      }
    }
    alignMoreLayer.contentsScale = backing
  }

  /// .tbtn / .ib in .alignbar: the ink (Warm Ink's .ib its second ink until hovered), on 7 % of it when hovered or lit,
  /// 12 % and at 0.96 of its size while pressed
  private func paintAlignButton(
    _ b: AlignBarButton, in r: CGRect, lit: Bool, look: BarLook, _ ctx: CGContext, content: (CGColor) -> Void
  ) {
    let ink = theme.id == .inkWash
    let hovered = alignHovered == b
    let pressed = alignPressed == b
    let tbtn = [.section, .subBoard, .tidy].contains(b)
    let color = ink || tbtn || hovered || lit ? look.ink : look.ink2
    ctx.saveGState()
    defer { ctx.restoreGState() }
    if pressed {
      ctx.translateBy(x: r.midX, y: r.midY)
      ctx.scaleBy(x: 0.96, y: 0.96)
      ctx.translateBy(x: -r.midX, y: -r.midY)
    }
    if pressed || hovered || lit {
      ctx.addPath(
        ink ? CGPath(roundedRect: r, cornerWidth: 2, cornerHeight: 2, transform: nil) : Drawing.squircle(r, 8.5))
      ctx.setFillColor(look.ink.copy(alpha: pressed ? 0.12 : 0.07)!)
      ctx.fillPath()
    }
    content(color)
  }
}

/// What the bar was last drawn showing
struct AlignBarLook: Equatable {
  var theme: Theme.ID
  var dark: Bool
  var scale: CGFloat
  var hovered: AlignBarButton?
  var pressed: AlignBarButton?
  var more: Bool
}

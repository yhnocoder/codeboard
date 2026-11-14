import AppKit
import CodeBoardModel

// The Copy ✓ | Reference chip under copies pasted or duplicated on their own board (main's actions/pastechip.ts and
// canvas/Canvas.tsx PasteChip, styles.css .pastechip), and the mark on a card placed several times on the board
// (cards/Card.tsx and styles.css .twinmk, actions/shared.ts showNextTwin).

/// The chip: [copy, original] pairs, whether they are References now, and what the copies were when it was offered or
/// last chosen in (their place and content, segment ids not counted): any other change of them closes it
struct PasteChip {
  var pairs: [(copy: CardID, of: CardID)]
  var ref: Bool
  var looks: [ChipLook]
}

struct ChipLook: Equatable {
  var x: Double
  var y: Double
  var width: Double
  var content: Card.Content
}

enum ChipButton: Equatable {
  case copy
  case reference
}

/// .pastechip: a .pill with 3 of padding, its two .tbtn 24 tall (0 8 padding, 4 between their parts, 500 12px) and a
/// 1 × 14 separator 2 from each, 2 between the three; in view points
enum ChipLayout {
  static let pad: CGFloat = 3
  static let button: CGFloat = 24
  static let icon: CGFloat = 12
  /// Room around it in its bitmap for its shadow
  static let margin: CGFloat = 32

  static func font(_ t: Theme) -> Font {
    t.id == .inkWash
      ? Font.board("SourceSerif4-400-600", size: 12, weight: 500, opticalSize: true)
        ?? Font(NSFont(name: "Georgia", size: 12) ?? NSFont.systemFont(ofSize: 12))
      : Font(NSFont.systemFont(ofSize: 12, weight: .medium))
  }

  /// Copy, the separator and Reference from the chip's top left, and its size
  static func layout(ref: Bool, font: Font) -> (copy: CGRect, sep: CGRect, reference: CGRect, size: CGSize) {
    let check = 4 + icon
    let copyW = 8 + Drawing.width("Copy", font) + (ref ? 0 : check) + 8
    let refW = 8 + icon + 4 + Drawing.width("Reference", font) + (ref ? check : 0) + 8
    let copy = CGRect(x: pad, y: pad, width: copyW.rounded(.up), height: button)
    let sep = CGRect(x: copy.maxX + 2 + 2, y: pad + (button - 14) / 2, width: 1, height: 14)
    let reference = CGRect(x: sep.maxX + 2 + 2, y: pad, width: refW.rounded(.up), height: button)
    return (copy, sep, reference, CGSize(width: reference.maxX + pad, height: button + 2 * pad))
  }
}

extension CanvasView {
  // MARK: The chip

  /// Copies just made of these cards: the chip offers to make them References (only a card of the same kind as its
  /// original, not a sub-board)
  func offerReference(_ pairs: [(copy: CardID, of: CardID)]) {
    guard let b = document?.board else { return }
    let ok = pairs.filter { p in
      guard let a = b.card(p.copy), let o = b.card(p.of), case .own(let ac) = a.content,
        case .own(let oc) = o.content
      else { return false }
      if case .board = ac.body { return false }
      return Self.kind(ac.body) == Self.kind(oc.body)
    }
    pasteChip = ok.isEmpty ? nil : PasteChip(pairs: ok, ref: false, looks: chipLooks(ok))
    chipHovered = nil
    chipInside = false
    armChip()
    drawChrome()
  }

  static func kind(_ b: CardContent.Body) -> Int {
    switch b {
    case .code: 0
    case .note: 1
    case .text: 2
    case .image: 3
    case .web: 4
    case .links: 5
    case .board: 6
    }
  }

  /// It goes PASTE_CHIP_IDLE after the pointer left it (or it came); not while the pointer is over it
  func armChip(hold: Bool = false) {
    chipTimer?.cancel()
    chipTimer = nil
    guard !hold, pasteChip != nil else { return }
    let idle = chipIdle
    chipTimer = Task { [weak self] in
      try? await Task.sleep(for: idle)
      guard !Task.isCancelled else { return }
      self?.closeChip()
    }
  }

  func closeChip() {
    chipTimer?.cancel()
    chipTimer = nil
    guard pasteChip != nil else { return }
    pasteChip = nil
    chipHovered = nil
    chipInside = false
    drawChrome()
  }

  func chipLooks(_ pairs: [(copy: CardID, of: CardID)]) -> [ChipLook] {
    pairs.compactMap { p in
      guard let c = document?.board.card(p.copy) else { return nil }
      var content = c.content
      if case .own(var own) = content, case .code(var code) = own.body {
        for i in code.segments.indices { code.segments[i].id = SegmentID(rawValue: "") }
        own.body = .code(code)
        content = .own(own)
      }
      return ChipLook(x: c.x, y: c.y, width: c.width, content: content)
    }
  }

  /// The board changed: a copy moved or changed (not by a choice on the chip) closes it
  func chipFollowBoard() {
    guard let c = pasteChip, !choosingChip, chipLooks(c.pairs) != c.looks else { return }
    closeChip()
  }

  /// Copy or Reference chosen: Reference makes each copy another place of its original (one step), Copy makes them
  /// copies of their own again; the chip stays, showing the choice
  func pasteAs(_ ref: Bool) {
    guard let doc = document, var c = pasteChip, c.ref != ref else { return }
    choosingChip = true
    defer { choosingChip = false }
    if ref {
      var n = 0
      doc.edit("Reference") { b in
        n = 0
        for p in c.pairs where b.makeTwin(p.copy, of: p.of) { n += 1 }
      }
      guard n > 0 else { return }
      toast(
        n > 1
          ? "\(n) cards are now the same cards as the originals: editing one changes the other"
          : "Same card in 2 places: editing one changes the other")
    } else {
      doc.edit("Detach") { b in for p in c.pairs { b.detachTwin(p.copy) } }
      toast(
        c.pairs.count > 1
          ? "Detached \(c.pairs.count) cards: each is its own copy now" : "Detached: this is its own copy now")
    }
    c.ref = ref
    c.looks = chipLooks(c.pairs)
    pasteChip = c
    drawChrome()
  }

  /// Where it is on the board: right-aligned with the copies' right edge, 8 below them, its size the same at any zoom
  func chipRect() -> CGRect? {
    guard let c = pasteChip else { return nil }
    let rects = c.pairs.compactMap { liveRect(.card($0.copy)) }
    guard let first = rects.first else { return nil }
    let box = rects.dropFirst().reduce(first) { $0.union($1) }
    let size = ChipLayout.layout(ref: c.ref, font: ChipLayout.font(theme)).size
    let z = camera.zoom
    return CGRect(x: box.maxX - size.width / z, y: box.maxY + 8, width: size.width / z, height: size.height / z)
  }

  /// Its button under a board point; .some(nil): on the chip, between its buttons
  func chipButton(at p: CGPoint) -> ChipButton?? {
    guard let c = pasteChip, let r = chipRect(), r.contains(p) else { return nil }
    let l = ChipLayout.layout(ref: c.ref, font: ChipLayout.font(theme))
    let at = CGPoint(x: (p.x - r.minX) * camera.zoom, y: (p.y - r.minY) * camera.zoom)
    if l.copy.contains(at) { return .some(.copy) }
    if l.reference.contains(at) { return .some(.reference) }
    return .some(nil)
  }

  /// The pointer over the chip: it stays while it is there, and the button under it lights up
  func hoverChip(at p: CGPoint) {
    guard pasteChip != nil else { return }
    let on = chipButton(at: p)
    let inside = on != nil
    if inside != chipInside {
      chipInside = inside
      armChip(hold: inside)
    }
    let b = on ?? nil
    if b != chipHovered {
      chipHovered = b
      drawChrome()
    }
  }

  /// The chip as a chrome layer (board units), its bitmap at the view's own scale
  func chipLayer() -> CALayer? {
    guard let c = pasteChip, let r = chipRect() else { return nil }
    let t = theme
    let look = BarLook.of(t)
    let font = ChipLayout.font(t)
    let l = ChipLayout.layout(ref: c.ref, font: font)
    let m = ChipLayout.margin
    let scale = backing
    let ink = t.id == .inkWash
    let row: CGColor =
      ink
      ? (t.dark
        ? CGColor(srgbRed: 214 / 255, green: 83 / 255, blue: 58 / 255, alpha: 0.12)
        : CGColor(srgbRed: 184 / 255, green: 50 / 255, blue: 31 / 255, alpha: 0.08))
      : t.accent.copy(alpha: 0.09)!
    let image = CanvasView.picture(
      size: CGSize(width: l.size.width + 2 * m, height: l.size.height + 2 * m), scale: scale
    ) { ctx in
      ctx.translateBy(x: m, y: m)
      WritingBar.float(
        CGRect(origin: .zero, size: l.size), radius: look.radius, look: look, glass: look.glass, scale: scale, in: ctx)
      ctx.setFillColor(look.sep)
      ctx.fill(l.sep)
      for (b, r) in [(ChipButton.copy, l.copy), (.reference, l.reference)] {
        let on = (b == .reference) == c.ref
        let hovered = chipHovered == b
        // .tbtn.on: the accent on --row (Ink Wash: its ink); hovered: --ink, on 7 % of it when not on (.tbtn.on comes later)
        var color = ink ? look.ink : on ? t.accent : look.ink2
        if hovered { color = look.ink }
        let bg: CGColor? = on ? row : hovered ? look.ink.copy(alpha: 0.07) : nil
        if let bg {
          let k: CGFloat = ink ? 2 : 8.5
          ctx.addPath(CGPath(roundedRect: r, cornerWidth: k, cornerHeight: k, transform: nil))
          ctx.setFillColor(bg)
          ctx.fillPath()
        }
        var x = r.minX + 8
        if b == .reference {
          Self.chipIcon(WebIcons.link, at: CGPoint(x: x, y: r.midY - ChipLayout.icon / 2), color: color, ctx)
          x += ChipLayout.icon + 4
        }
        let word = b == .copy ? "Copy" : "Reference"
        Self.chipLabel(word, x: x, midY: r.midY, font: font, color: color, ctx)
        x += Drawing.width(word, font) + 4
        if on { Self.chipIcon(Self.check, at: CGPoint(x: x, y: r.midY - ChipLayout.icon / 2), color: color, ctx) }
      }
    }
    let layer = CALayer()
    let z = camera.zoom
    layer.frame = r.insetBy(dx: -m / z, dy: -m / z)
    layer.contents = image
    layer.contentsGravity = .resize
    layer.zPosition = 15
    return layer
  }

  /// icons.tsx check
  static let check = "M13 4 6 11 3 8"

  /// An icon of icons.tsx at 12 (`.ico`: its 16 grid scaled, a 1-unit line moved half a unit up and left)
  static func chipIcon(_ d: String, at: CGPoint, color: CGColor, _ ctx: CGContext) {
    ctx.saveGState()
    ctx.translateBy(x: at.x, y: at.y)
    ctx.scaleBy(x: ChipLayout.icon / 16, y: ChipLayout.icon / 16)
    ctx.translateBy(x: -0.5, y: -0.5)
    ctx.addPath(SVGPath.parse(d))
    ctx.setStrokeColor(color)
    ctx.setLineWidth(1)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.strokePath()
    ctx.restoreGState()
  }

  /// A label as CSS centres a line box as tall as its font (line-height 1)
  static func chipLabel(_ s: String, x: CGFloat, midY: CGFloat, font: Font, color: CGColor, _ ctx: CGContext) {
    let f = font.ct
    let size = CTFontGetSize(f)
    let asc = CTFontGetAscent(f)
    let desc = CTFontGetDescent(f)
    ctx.saveGState()
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    ctx.textPosition = CGPoint(x: x, y: midY - size / 2 + (size - (asc + desc)) / 2 + asc)
    CTLineDraw(Drawing.line(s, font, color), ctx)
    ctx.restoreGState()
  }

  // MARK: The mark of a card placed several times

  /// The cards placed with others on this board (the same `same`), each with how many places it has
  func twinCounts() -> [CardID: Int] {
    guard let b = document?.board else { return [:] }
    var groups: [String: [CardID]] = [:]
    for c in b.cards { if let s = c.same { groups[s, default: []].append(c.id) } }
    var out: [CardID: Int] = [:]
    for ids in groups.values where ids.count > 1 { for id in ids { out[id] = ids.count } }
    return out
  }

  static let twinFont = Font(NSFont.systemFont(ofSize: 10.5, weight: .semibold))
  static func twinFont(_ t: Theme) -> Font {
    t.id == .inkWash
      ? Font.board("SourceSerif4-400-600", size: 10.5, weight: 600, opticalSize: true) ?? twinFont : twinFont
  }

  /// The marks' layers in their cards' layers: 10 from a card's left, over its bottom edge (half of its 18 below it)
  func twinMarkLayers(boxes: [Scene.Owner: CALayer]) -> [(CALayer, CALayer)] {
    guard let scene else { return [] }
    twinSpots = []
    var out: [(CALayer, CALayer)] = []
    for (id, n) in twinCounts().sorted(by: { $0.key.rawValue < $1.key.rawValue }) {
      guard let box = boxes[.card(id)], let r = scene.items.first(where: { $0.owner == .card(id) })?.rect else {
        continue
      }
      let text = "\(n)"
      let font = Self.twinFont(theme)
      let w = (6 + 11 + 3 + Drawing.width(text, font) + 6).rounded(.up)
      let frame = CGRect(x: 10, y: r.height - 9, width: w, height: 18)
      let l = CALayer()
      l.name = "twin"
      l.frame = frame
      l.zPosition = 3
      paintTwin(l, count: n, hovered: hoveredTwin == id)
      out.append((l, box))
      twinSpots.append((id, frame.offsetBy(dx: r.minX, dy: r.minY)))
    }
    return out
  }

  func paintTwin(_ l: CALayer, count n: Int, hovered: Bool) {
    let t = theme
    let bg = hovered ? t.accent : Self.mix(t.accent, 0.13, t.surface)
    let ink = hovered ? t.accentInk : t.accent
    let font = Self.twinFont(t)
    let size = l.bounds.size
    let scale = backing * max(1, camera.zoom)
    l.contents = CanvasView.picture(size: size, scale: scale) { ctx in
      ctx.addPath(
        CGPath(roundedRect: CGRect(origin: .zero, size: size), cornerWidth: 9, cornerHeight: 9, transform: nil))
      ctx.setFillColor(bg)
      ctx.fillPath()
      ctx.saveGState()
      ctx.translateBy(x: 6, y: (size.height - 11) / 2)
      ctx.scaleBy(x: 11 / 16, y: 11 / 16)
      ctx.translateBy(x: -0.5, y: -0.5)
      ctx.addPath(SVGPath.parse(WebIcons.link))
      ctx.setStrokeColor(ink)
      ctx.setLineWidth(1)
      ctx.setLineCap(.round)
      ctx.setLineJoin(.round)
      ctx.strokePath()
      ctx.restoreGState()
      Self.chipLabel("\(n)", x: 6 + 11 + 3, midY: size.height / 2, font: font, color: ink, ctx)
    }
    l.contentsScale = scale
  }

  /// The card whose mark is under a board point
  func twinMark(at p: CGPoint) -> CardID? {
    twinSpots.last { $0.hit.contains(p) }?.card
  }

  /// A click on the mark: the next place of the card, selected and brought into view
  func showNextTwin(_ id: CardID) {
    guard let doc = document, let same = doc.board.card(id)?.same else { return }
    let ts = doc.board.cards.filter { $0.same == same }.map(\.id)
    guard let i = ts.firstIndex(of: id), ts.count > 1 else { return }
    let next = ts[(i + 1) % ts.count]
    doc.select([.card(next)])
    if let r = liveRect(.card(next)) { reveal(r) }
  }
}

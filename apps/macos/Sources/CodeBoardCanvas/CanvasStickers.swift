import AppKit
import CodeBoardModel

// Stickers on the canvas (the web board's stickers/Layer.tsx, Picker.tsx, actions/stickers.ts, styles.css .stk): a free
// one over the cards, one on a card in the card's own layer (it moves with it, nothing redrawn), one on an arrow over the
// cards at its place along the curve (Picker.tsx LinkStickers: moved with the arrow as it is routed again, with a dashed
// tether to that place while selected), one on a code line as a chip in the line numbers (a dot by a Highlight's
// count). Each is vector layers in its glyph's box (StickerArt), so a move, a resize or a zoom never redraws a bitmap;
// an emoji's text is drawn again only at rest, as the markers are.
//
// The toolbar's Sticker opens the palette; a glyph picked follows the pointer with no button held and a click puts it
// down, selected: on a code line's number, on the card or arrow under it, by a card within 40 px or an arrow within 24
// (the nearer), else free (⌥: free). Esc puts nothing down. A sticker is dragged (let go, it goes on what it would be
// put down on, lit meanwhile), resized by its corner grip when selected, and its menu has its colours, Size, Detach and
// Delete. Its label is its tip and its spoken name.

struct StickerSpot {
  var id: StickerID
  var glyph: Sticker.Glyph
  var color: String?
  /// The card it is drawn in; nil: free on the board
  var owner: CardID?
  /// Its box in the owner's units from its top left (or on the board)
  var frame: CGRect
  /// Where it is on the board
  var board: CGRect
  /// A chip in the line numbers (it is not moved or resized)
  var line: Bool
  /// Shrunk to a dot by a Highlight's count on its line
  var dot = false
  /// The arrow it is on and where along it (0…1): `frame` is then its box from that place
  var arrow: ArrowID? = nil
  var t: CGFloat = 0
}

/// What a sticker put down or let go goes on
enum StickerTarget: Equatable {
  case card(CardID)
  case arrow(ArrowID)
}

/// A sticker pressed: moved or resized from where it was, and where it is now (board units)
struct StickerDrag {
  var id: StickerID
  var resize: Bool
  var from: CGRect
  var to: CGRect
  var moved = false
  /// What it would go on if let go now (lit)
  var aim: StickerTarget? = nil
}

extension CanvasView {
  /// A line chip's size and step (.lstks: 14 across, 2 apart), and a dot's (.lstks.dot)
  static let chipSize: CGFloat = 14
  static let dotSize: CGFloat = 7
  /// How near a card a sticker put down beside it goes on it, in view points (Picker.tsx SNAP)
  static let stickerSnap: CGFloat = 40
  /// And near an arrow's line (actions/stickers.ts MAG_LINK)
  static let arrowSnap: CGFloat = 24

  /// The stickers of the board shown, where they are now
  func computeStickers() -> [StickerSpot] {
    guard let scene, let board = shownBoard else { return [] }
    var rects: [CardID: CGRect] = [:]
    for it in scene.items { if case .card(let c)? = it.owner { rects[c] = it.rect } }
    // the rows with a Highlight's count: a sticker there is a dot
    let countRows = Set(
      marks.filter { $0.gutter && !$0.add }.compactMap { m in m.owner.map { "\($0)|\(Int(m.frame.minY - 3.5))" } })
    var perLine: [String: Int] = [:]
    var out: [StickerSpot] = []
    for k in board.stickers {
      switch k.anchor {
      case .canvas(let x, let y, let s):
        let f = CGRect(origin: CGPoint(x: x, y: y), size: StickerArt.boxSize(k.glyph, size: s ?? Sticker.defaultSize))
        out.append(StickerSpot(id: k.id, glyph: k.glyph, color: k.color, owner: nil, frame: f, board: f, line: false))
      case .card(let c, let x, let y, let s):
        guard let r = rects[c] else { continue }
        let f = CGRect(origin: CGPoint(x: x, y: y), size: StickerArt.boxSize(k.glyph, size: s ?? Sticker.defaultSize))
        out.append(
          StickerSpot(
            id: k.id, glyph: k.glyph, color: k.color, owner: c, frame: f, board: f.offsetBy(dx: r.minX, dy: r.minY),
            line: false))
      // not drawn while its arrow is not
      case .arrow(let a, let t, let x, let y, let s):
        guard let pts = livePts(a) else { continue }
        let q = ArrowRoute.bezAt(pts, t)
        let f = CGRect(origin: CGPoint(x: x, y: y), size: StickerArt.boxSize(k.glyph, size: s ?? Sticker.defaultSize))
        out.append(
          StickerSpot(
            id: k.id, glyph: k.glyph, color: k.color, owner: nil, frame: f, board: f.offsetBy(dx: q.x, dy: q.y),
            line: false, arrow: a, t: t))
      case .line(let c, let seg, let n):
        guard let r = rects[c], let p = scene.placed[c], !p.folded, let code = p.code,
          case .code(let card)? = scene.parts[c]?.content.body,
          let si = card.segments.firstIndex(where: { $0.id == seg }),
          let row = code.layout.shownRow(segment: si, line: n),
          // past what a card of fixed or capped height shows: clipped, as in the web board's scrolling code (.cbody)
          code.top + row.y + row.height <= r.height
        else { continue }
        let y = code.top + row.y
        let key = "\(Scene.Owner.card(c))|\(Int(y))"
        let i = perLine[key, default: 0]
        perLine[key] = i + 1
        let dot = countRows.contains(key)
        let f: CGRect
        if dot {
          f = CGRect(x: 33 + CGFloat(i) * 9, y: y - 1.5, width: Self.dotSize, height: Self.dotSize)
        } else {
          let w = StickerArt.boxSize(k.glyph, size: Self.chipSize).width
          f = CGRect(x: code.layout.gutter - 18 + CGFloat(i) * 16, y: y + 3, width: w, height: Self.chipSize)
        }
        out.append(
          StickerSpot(
            id: k.id, glyph: k.glyph, color: k.color, owner: c, frame: f, board: f.offsetBy(dx: r.minX, dy: r.minY),
            line: true, dot: dot))
      }
    }
    return out
  }

  /// The stickers laid out again, with the markers (the board changed, the camera came to rest at another zoom)
  func placeStickers() {
    guard let scene else { return }
    stickerSpots = computeStickers()
    var boxes: [CardID: CALayer] = [:]
    for (i, it) in scene.items.enumerated() where i < items.count {
      if case .card(let c)? = it.owner { boxes[c] = items[i].box }
    }
    withoutAnimation {
      for l in stickerLayers { l.removeFromSuperlayer() }
      stickerLayers = stickerSpots.map { s in
        let l = stickerLayer(s)
        (s.owner.flatMap { boxes[$0] } ?? freeStickers).addSublayer(l)
        return l
      }
    }
  }

  /// The stickers on these arrows where they are drawn now (`pts`: re-routed, a card at an end moving): their layers
  /// moved, nothing else
  func followArrows(_ pts: [ArrowID: [CGPoint]]) {
    withoutAnimation {
      for (i, s) in stickerSpots.enumerated() where i < stickerLayers.count {
        guard let p = s.arrow.flatMap({ pts[$0] }) else { continue }
        let q = ArrowRoute.bezAt(p, s.t)
        stickerSpots[i].board.origin = CGPoint(x: q.x + s.frame.minX, y: q.y + s.frame.minY)
        stickerLayers[i].position = stickerSpots[i].board.origin
      }
    }
  }

  /// A sticker's layer: its glyph at its frame, a soft shadow under one on the board or a card (.stk.canvas .glyph)
  func stickerLayer(_ s: StickerSpot) -> CALayer {
    let l = StickerArt.layer(
      s.glyph, color: s.color, size: s.frame.height, theme: theme, pixels: backing * camera.zoom)
    l.name = "sticker"
    // one on an arrow is over the cards, as a free one: at its place on the board
    l.position = s.owner == nil ? s.board.origin : s.frame.origin
    l.zPosition = 4
    if !s.line { StickerArt.shadow(l, s.glyph, size: s.frame.height, pixels: backing * camera.zoom) }
    return l
  }

  /// The sticker under a board point, the last drawn first: inside its glyph's outline
  func stickerAt(_ p: CGPoint) -> Int? {
    stickerSpots.indices.last { i in
      let s = stickerSpots[i]
      let local = CGPoint(x: p.x - s.board.minX, y: p.y - s.board.minY)
      return StickerArt.outline(s.glyph, size: s.board.height, out: max(1, 2 / camera.zoom)).contains(local)
    }
  }

  /// The one selected sticker, when that is the selection
  var selectedSticker: Int? {
    guard let doc = document, doc.selection.count == 1, let id = doc.selection.first?.sticker else { return nil }
    return stickerSpots.firstIndex { $0.id == id }
  }

  /// Where a sticker's box is now (a drag of it under way included)
  func liveStickerRect(_ i: Int) -> CGRect {
    if case .sticker(let d)? = gesture?.kind, d.id == stickerSpots[i].id { return d.to }
    return stickerSpots[i].board
  }

  /// The resize grip's centre (.sgrip: on the outline at 45° for a disc or a pill, at the corner of an emoji's square)
  func stickerGrip(_ i: Int) -> CGPoint {
    let r = liveStickerRect(i)
    let k = StickerArt.shape(stickerSpots[i].glyph) == .square ? 0 : r.height * 0.146
    return CGPoint(x: r.maxX - k, y: r.maxY - k)
  }

  /// The selected sticker's grip under a view point
  func hitStickerGrip(_ v: CGPoint) -> Int? {
    guard let i = selectedSticker, !stickerSpots[i].line else { return nil }
    let g = camera.view(stickerGrip(i))
    return hypot(v.x - g.x, v.y - g.y) <= 7 ? i : nil
  }

  /// A selected sticker's look, in board units: the accent ring round its glyph 2 points out (.stk.sel), the grip at
  /// its corner, the dashed frame round the card it is on (.card.bind-anchor), and from the place on the arrow it is on
  /// a dashed line to its middle with a dot at that place (Picker.tsx .tether), under it
  func stickerChrome(_ id: StickerID) {
    guard let i = stickerSpots.firstIndex(where: { $0.id == id }) else { return }
    let s = stickerSpots[i]
    let z = camera.zoom
    let r = liveStickerRect(i)
    let ring = CAShapeLayer()
    ring.position = r.origin
    ring.path = StickerArt.outline(s.glyph, size: r.height, out: (2 + 0.75) / z)
    ring.fillColor = nil
    ring.strokeColor = theme.accent
    ring.lineWidth = 1.5 / z
    chrome.addSublayer(ring)
    var lifted = false
    if case .sticker(let d)? = gesture?.kind, d.id == id, d.moved, !d.resize { lifted = true }
    let onCard = s.owner != nil && !s.line && !lifted
    if !lifted, let a = s.arrow, let pts = livePts(a) {
      let q = ArrowRoute.bezAt(pts, s.t)
      let line = CAShapeLayer()
      let path = CGMutablePath()
      path.move(to: q)
      path.addLine(to: CGPoint(x: r.minX + r.height / 2, y: r.minY + r.height / 2))
      line.path = path
      line.strokeColor = theme.accent
      line.lineWidth = 1 / z
      line.lineDashPattern = [3, 3]
      let dot = CAShapeLayer()
      let rad = 3 / max(z, 0.5)
      dot.path = CGPath(ellipseIn: CGRect(x: q.x - rad, y: q.y - rad, width: 2 * rad, height: 2 * rad), transform: nil)
      dot.fillColor = theme.accent
      tether.sublayers = [line, dot]
    }
    if onCard, let c = s.owner, let cr = index(of: .card(c)).map({ scene!.items[$0].rect }) {
      let frame = CAShapeLayer()
      let out = 5.0
      frame.path = CGPath(
        roundedRect: cr.insetBy(dx: -out, dy: -out), cornerWidth: theme.cardRadius + out,
        cornerHeight: theme.cardRadius + out, transform: nil)
      frame.fillColor = nil
      frame.strokeColor = theme.accent.copy(alpha: 0.7)
      frame.lineWidth = 1 / z
      frame.lineDashPattern = [NSNumber(value: 3 / z), NSNumber(value: 3 / z)]
      chrome.addSublayer(frame)
    }
    guard !s.line else { return }
    let g = stickerGrip(i)
    let grip = CAShapeLayer()
    let rad = 5 / z
    grip.path = CGPath(ellipseIn: CGRect(x: g.x - rad, y: g.y - rad, width: 2 * rad, height: 2 * rad), transform: nil)
    grip.fillColor = theme.surface
    grip.strokeColor = theme.accent
    grip.lineWidth = 1.5 / z
    chrome.addSublayer(grip)
  }

  // MARK: Pointer

  /// The sticker under the pointer: its tip shows
  func hoverSticker(_ id: StickerID?) {
    guard id != hoveredSticker else { return }
    hoveredSticker = id
    showTip()
  }

  /// A press on a sticker or the selected one's grip: it is selected and the drag begins. True when the press is taken
  func pressSticker(_ e: NSEvent, view v: CGPoint, board p: CGPoint) -> Bool {
    guard let doc = document else { return false }
    if let i = hitStickerGrip(v) {
      let r = stickerSpots[i].board
      gesture = Gesture(
        kind: .sticker(StickerDrag(id: stickerSpots[i].id, resize: true, from: r, to: r)), startView: v, start: p)
      return true
    }
    guard let i = stickerAt(p) else { return false }
    // a double-click on one does nothing more
    guard e.clickCount == 1 else { return true }
    let s = stickerSpots[i]
    if doc.selection != [.sticker(s.id)] { doc.select([.sticker(s.id)]) }
    gesture = Gesture(
      kind: .sticker(StickerDrag(id: s.id, resize: false, from: s.board, to: s.board)), startView: v, start: p)
    return true
  }

  /// The pointer moved with a sticker pressed: it follows (lifted out of its card onto the board), or grows from its
  /// top left
  func dragSticker(_ d: inout StickerDrag, view v: CGPoint, start: CGPoint, startView: CGPoint) {
    guard let i = stickerSpots.firstIndex(where: { $0.id == d.id }), i < stickerLayers.count else { return }
    let s = stickerSpots[i]
    guard !s.line, d.moved || hypot(v.x - startView.x, v.y - startView.y) >= dragSlop else { return }
    let p = camera.board(v)
    let dx = p.x - start.x
    let dy = p.y - start.y
    let l = stickerLayers[i]
    withoutAnimation {
      if d.resize {
        let size = min(max((d.from.height + max(dx, dy)).rounded(), Sticker.sizes.lowerBound), Sticker.sizes.upperBound)
        d.to = CGRect(origin: d.from.origin, size: StickerArt.boxSize(s.glyph, size: size))
        StickerArt.resize(l, s.glyph, size: size)
        if case .builtin = s.glyph { l.shadowPath = StickerArt.outline(s.glyph, size: size, out: 0) }
      } else {
        if !d.moved {
          // over every card while it moves
          l.removeFromSuperlayer()
          freeStickers.addSublayer(l)
        }
        d.to = d.from.offsetBy(dx: dx, dy: dy)
        l.position = d.to.origin
        // a card is ringed; an arrow is lit as the arrows under the pointer are (drawArrowChrome)
        d.aim = stickerTarget(p, free: NSEvent.modifierFlags.contains(.option))
        dropAim?.removeFromSuperlayer()
        dropAim = nil
        if case .card(let c)? = d.aim { dropAim = aimLayer(.card(c)) }
      }
    }
    d.moved = true
  }

  /// What a sticker put down or let go with the pointer at `p` goes on (actions/stickers.ts targetAt): what is under it,
  /// the topmost of an arrow's label, a card and an arrow's line, else the nearest card or arrow within its snap distance
  /// (⌥: nothing)
  func stickerTarget(_ p: CGPoint, free: Bool) -> StickerTarget? {
    guard !free else { return nil }
    if let a = hitArrowLabel(p) { return .arrow(a) }
    if let c = hitCard(p) { return .card(c) }
    if let a = hitArrow(p) { return .arrow(a) }
    return targetNear(p)
  }

  /// Let go with the pointer at `p`: where it now is, or its new size, one step
  func commitSticker(_ d: StickerDrag, at p: CGPoint, free: Bool) {
    gesture = nil
    withoutAnimation {
      dropAim?.removeFromSuperlayer()
      dropAim = nil
    }
    guard let doc = document, d.moved else { return drawChrome() }
    if d.resize {
      doc.edit("Resize Sticker") { $0.setStickerSize(d.id, Double(d.to.height)) }
    } else {
      let anchor = anchorFor(d.to, on: stickerTarget(p, free: free), size: Double(d.to.height))
      doc.edit("Move Sticker") { $0.moveSticker(d.id, to: anchor) }
    }
    // let go where it was: back in its place
    placeStickers()
    drawChrome()
  }

  /// A sticker's place for a box on the board: on that card from its top left, on that arrow from the place along it
  /// nearest the box's middle (actions/stickers.ts bindAt), or free
  func anchorFor(_ r: CGRect, on target: StickerTarget?, size: Double?) -> Sticker.Anchor {
    let size = size == Sticker.defaultSize ? nil : size
    switch target {
    case .card(let c)?:
      if let cr = index(of: .card(c)).map({ scene!.items[$0].rect }) {
        return .card(c, x: Double((r.minX - cr.minX).rounded()), y: Double((r.minY - cr.minY).rounded()), size: size)
      }
    case .arrow(let a)?:
      if let pts = livePts(a) {
        let t = ArrowRoute.nearestT(pts, CGPoint(x: r.minX + r.height / 2, y: r.minY + r.height / 2))
        let q = ArrowRoute.bezAt(pts, t)
        return .arrow(
          a, position: Double(t), x: Double((r.minX - q.x).rounded()), y: Double((r.minY - q.y).rounded()), size: size)
      }
    case nil: break
    }
    return .canvas(x: Double(r.minX.rounded()), y: Double(r.minY.rounded()), size: size)
  }

  // MARK: Placing

  /// A glyph picked in the palette: it follows the pointer until a click puts it down
  package func beginPlacing(_ g: Sticker.Glyph) {
    placing = g
    let t = theme
    withoutAnimation {
      stickerGhost.sublayers = nil
      let art = StickerArt.layer(g, color: nil, size: 28, theme: t, pixels: backing)
      stickerGhost.addSublayer(art)
      stickerGhost.bounds = art.bounds
      stickerGhost.opacity = 0.85
      stickerGhost.isHidden = true
      if let w = window {
        let v = convert(w.mouseLocationOutsideOfEventStream, from: nil)
        if bounds.contains(v) { moveGhost(to: v) }
      }
    }
    toast("Click a code line, a card or empty canvas to place it · Esc to cancel")
    onMode?(activeTool)
  }

  /// The glyph being placed, centred on the pointer
  func moveGhost(to v: CGPoint) {
    withoutAnimation {
      stickerGhost.position = CGPoint(x: v.x - stickerGhost.bounds.width / 2, y: v.y - stickerGhost.bounds.height / 2)
      stickerGhost.isHidden = false
    }
  }

  /// Esc, a board switch: nothing is put down
  package func cancelPlacing() {
    guard placing != nil else { return }
    placing = nil
    withoutAnimation {
      stickerGhost.isHidden = true
      stickerGhost.sublayers = nil
    }
    onMode?(activeTool)
  }

  /// The click while placing: the sticker goes down there, one step, selected
  package func putSticker(at p: CGPoint, free: Bool) {
    guard let g = placing, let doc = document else { return }
    cancelPlacing()
    let anchor: Sticker.Anchor
    if !free, let c = hitCard(p), let placed = scene?.placed[c], let code = placed.code,
      p.x - placed.rect.minX < code.layout.gutter, let line = codeLine(at: p, of: c)?.end, let seg = line.segment,
      let n = line.line
    {
      anchor = .line(c, segment: seg, line: n)
    } else {
      let size = StickerArt.boxSize(g, size: Sticker.defaultSize)
      let r = CGRect(x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height)
      anchor = anchorFor(r, on: stickerTarget(p, free: free), size: nil)
    }
    let id = StickerID(rawValue: Board.newID("k"))
    doc.edit("Add Sticker", selection: [.sticker(id)]) { $0.addSticker(Sticker(id: id, glyph: g, anchor: anchor)) }
  }

  /// The nearest card within 40 view points of a board point or arrow within 24, whichever is nearer (a tie: the card)
  func targetNear(_ p: CGPoint) -> StickerTarget? {
    guard let s = scene else { return nil }
    let z = camera.zoom
    var best: (StickerTarget, CGFloat)?
    for it in s.items {
      guard case .card(let c)? = it.owner else { continue }
      let dx = max(it.rect.minX - p.x, 0, p.x - it.rect.maxX)
      let dy = max(it.rect.minY - p.y, 0, p.y - it.rect.maxY)
      let d = hypot(dx, dy) * z
      if d <= Self.stickerSnap, d < best?.1 ?? .infinity { best = (.card(c), d) }
    }
    let m = Self.arrowSnap / z
    for i in s.arrows.indices {
      guard let a = liveArrow(i) else { continue }
      // the curve is inside its control points' box: one farther than the snap from that is not looked along
      let xs = a.pts.map(\.x)
      let ys = a.pts.map(\.y)
      guard p.x >= xs.min()! - m, p.x <= xs.max()! + m, p.y >= ys.min()! - m, p.y <= ys.max()! + m else { continue }
      let q = ArrowRoute.bezAt(a.pts, ArrowRoute.nearestT(a.pts, p))
      let d = hypot(q.x - p.x, q.y - p.y) * z
      if d <= Self.arrowSnap, d < best?.1 ?? .infinity { best = (.arrow(a.id), d) }
    }
    return best?.0
  }

  // MARK: The palette

  /// The toolbar's Sticker: its palette opens above the button at `button` (in this view), or closes
  public func toggleStickerPalette(above button: CGRect) {
    if stickerPalette != nil { return closeStickerPalette() }
    cancelPlacing()
    let p = StickerPalette(theme: theme)
    p.onPick = { [weak self] g in self?.pickSticker(g) }
    let size = p.fittingSize
    var x = button.midX - size.width / 2
    x = min(max(8, x), bounds.width - size.width - 8)
    p.frame = CGRect(x: x, y: button.minY - 8 - size.height, width: size.width, height: size.height)
    addSubview(p)
    stickerPalette = p
    onMode?(activeTool)
  }

  package func closeStickerPalette() {
    guard let p = stickerPalette else { return }
    p.removeFromSuperview()
    stickerPalette = nil
    onMode?(activeTool)
  }

  /// A glyph picked is placed, whatever is selected (actions/stickers.ts pickSticker)
  package func pickSticker(_ g: Sticker.Glyph) {
    closeStickerPalette()
    beginPlacing(g)
  }

  // MARK: The menu

  /// A sticker's menu (actions/stickers.ts stickerMenu): its colours (not an emoji's), Size ▸ and Detach from Card or
  /// Arrow, Delete
  func stickerMenu(_ id: StickerID) -> NSMenu {
    let m = NSMenu()
    // an emoji has its own colours
    if let k = document?.board.sticker(id), Sticker.ownColor(k.glyph) != nil {
      let pick = { [weak self] (hex: String?) in self?.document?.edit("Sticker Color") { $0.setStickerColor(id, hex) } }
      m.addItem(
        submenu(
          "Color",
          [menuItem("Default", checked: k.color == nil) { pick(nil) }]
            + zip(Self.stickerColorNames, Sticker.palette).map { name, hex in
              menuItem(name, checked: k.color?.uppercased() == hex) { pick(hex) }
            }))
    }
    // one on the board, a card or an arrow: its size; on a card or an arrow, Detach keeps it where it is drawn, free
    if let k = document?.board.sticker(id), let now = k.size {
      m.addItem(
        submenu(
          "Size",
          [24.0, 32, 48, 72].map { n in
            menuItem("\(Int(n))px", checked: now == n) { [weak self] in
              self?.document?.edit("Sticker Size") { $0.setStickerSize(id, n) }
            }
          }))
      let on: (title: String, size: Double?)? =
        switch k.anchor {
        case .card(_, _, _, let s): ("Detach from Card", s)
        case .arrow(_, _, _, _, let s): ("Detach from Arrow", s)
        case .canvas, .line: nil
        }
      if let on, let at = stickerSpots.first(where: { $0.id == id })?.board {
        let detach = menuItem(on.title) { [weak self] in
          self?.document?.edit("Detach Sticker") { b in
            guard let i = b.stickers.firstIndex(where: { $0.id == id }) else { return }
            b.stickers[i].anchor = .canvas(x: at.minX.rounded(), y: at.minY.rounded(), size: on.size)
          }
        }
        detach.toolTip = "Keep it here on the canvas"
        m.addItem(detach)
      }
    }
    if !m.items.isEmpty { m.addItem(.separator()) }
    m.addItem(
      key(
        menuItem("Delete") { [weak self] in
          self?.document?.edit("Delete") { $0.delete([.sticker(id)]) }
        }, "\u{8}"))
    return m
  }

  /// Sticker.palette's names (glyphs.tsx STICKER_PALETTE)
  static let stickerColorNames = ["Gold", "Orange", "Red", "Pink", "Purple", "Blue", "Green", "Grey"]
}

/// The palette over the toolbar's Sticker (Picker.tsx .stkpick, without its tabs, search and colours): the built-in
/// glyphs in eight columns, the TODO tag two wide, and one button for the system's emoji
package final class StickerPalette: NSView {
  package var onPick: ((Sticker.Glyph) -> Void)?
  let theme: Theme
  private var hover: Int? {
    didSet { if hover != oldValue { draw() } }
  }
  private let glass = NSVisualEffectView()
  /// Over the glass: the face and the cells (layers added to the palette's own layer could end up under the glass)
  private let content = FlippedView()
  private let face = CALayer()
  private var cells: [CALayer] = []
  /// Where the system's emoji picker types its emoji
  private let field = EmojiField()

  static let width: CGFloat = 336
  static let pad: CGFloat = 8
  static let gap: CGFloat = 2
  static let cellHeight: CGFloat = 36
  static let columns = 8

  /// What each slot is: a glyph or the emoji button, with its span
  static let slots: [(glyph: Sticker.Glyph?, span: Int)] =
    StickerArt.picked.map { (.builtin($0), $0 == .todoText ? 2 : 1) } + [(nil, 1)]

  init(theme: Theme) {
    self.theme = theme
    super.init(frame: CGRect(origin: .zero, size: Self.size))
    wantsLayer = true
    appearance = NSAppearance(named: theme.dark ? .darkAqua : .aqua)
    if theme.id != .inkWash {
      glass.blendingMode = .withinWindow
      glass.material = .underWindowBackground
      glass.state = .active
      glass.wantsLayer = true
      glass.frame = bounds
      glass.layer?.cornerRadius = 14
      glass.layer?.masksToBounds = true
      addSubview(glass)
    }
    field.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
    field.alphaValue = 0
    field.onText = { [weak self] s in self?.typed(s) }
    addSubview(field)
    content.frame = bounds
    content.wantsLayer = true
    addSubview(content)
    content.layer?.addSublayer(face)
    let t = theme
    for (i, r) in Self.rects().enumerated() {
      let cell = CALayer()
      cell.frame = r
      let g = Self.slots[i].glyph
      let art: CALayer
      if let g {
        art = StickerArt.layer(g, color: nil, size: 22, theme: t, pixels: 2)
      } else {
        art = CALayer()
        art.bounds = CGRect(x: 0, y: 0, width: 22, height: 22)
        art.anchorPoint = .zero
        let smile = NSImage(systemSymbolName: "face.smiling", accessibilityDescription: nil)?
          .withSymbolConfiguration(.init(pointSize: 17, weight: .regular))
        let tint = NSImage(size: smile?.size ?? .zero, flipped: false) { rect in
          smile?.draw(in: rect)
          NSColor(cgColor: t.ink2)?.set()
          rect.fill(using: .sourceAtop)
          return true
        }
        art.contents = tint
        art.contentsGravity = .center
        art.contentsScale = 2
      }
      art.position = CGPoint(x: (r.width - art.bounds.width) / 2, y: (r.height - art.bounds.height) / 2)
      cell.addSublayer(art)
      content.layer?.addSublayer(cell)
      cells.append(cell)
    }
    draw()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("StickerPalette is not loaded from nibs") }

  package override var isFlipped: Bool { true }
  package override var fittingSize: NSSize { Self.size }

  static var rows: Int { (slots.reduce(0) { $0 + $1.span } + columns - 1) / columns }
  static var size: CGSize {
    CGSize(width: width, height: 2 * pad + CGFloat(rows) * cellHeight + CGFloat(rows - 1) * gap)
  }

  /// Each slot's rect, in order
  static func rects() -> [CGRect] {
    let w = (width - 2 * pad - CGFloat(columns - 1) * gap) / CGFloat(columns)
    var col = 0
    var row = 0
    return slots.map { s in
      if col + s.span > columns {
        col = 0
        row += 1
      }
      let r = CGRect(
        x: pad + CGFloat(col) * (w + gap), y: pad + CGFloat(row) * (cellHeight + gap),
        width: w * CGFloat(s.span) + gap * CGFloat(s.span - 1), height: cellHeight)
      col += s.span
      return r
    }
  }

  /// The panel (Warm Ink: the glass's tint, its shadow; Ink Wash: paper, 2 round) and the rings round the glyph under
  /// the pointer and the selected sticker's, hugging their shapes
  private func draw() {
    let t = theme
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    do {
      face.frame = bounds
      face.cornerRadius = t.id == .inkWash ? 2 : 14
      face.backgroundColor =
        t.id == .inkWash
        ? t.surface
        : t.dark
          ? CGColor(srgbRed: 40 / 255, green: 39 / 255, blue: 36 / 255, alpha: 0.6)
          : CGColor(srgbRed: 250 / 255, green: 248 / 255, blue: 244 / 255, alpha: 0.62)
      face.borderWidth = 0.5
      face.borderColor = t.hair
      layer?.shadowColor = CGColor(gray: 0, alpha: 1)
      layer?.shadowOpacity = t.dark ? 0.3 : 0.08
      layer?.shadowRadius = 7
      layer?.shadowOffset = CGSize(width: 0, height: -4)
      layer?.shadowPath = CGPath(
        roundedRect: bounds, cornerWidth: face.cornerRadius, cornerHeight: face.cornerRadius, transform: nil)
      for (i, cell) in cells.enumerated() {
        for l in cell.sublayers ?? [] where l.name == "ring" { l.removeFromSuperlayer() }
        let g = Self.slots[i].glyph
        guard hover == i, let art = cell.sublayers?.first else { continue }
        let ring = CAShapeLayer()
        ring.name = "ring"
        ring.position = art.position
        ring.path =
          g.map { StickerArt.outline($0, size: 22, out: 2.75) }
          ?? CGPath(ellipseIn: CGRect(x: -2.75, y: -2.75, width: 27.5, height: 27.5), transform: nil)
        ring.fillColor = t.hlrow
        ring.strokeColor = t.ink3.copy(alpha: 0.5)
        ring.lineWidth = 1.5
        cell.addSublayer(ring)
      }
    }
  }

  func slot(at p: CGPoint) -> Int? { Self.rects().firstIndex { $0.contains(p) } }

  package override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas where t.owner === self { removeTrackingArea(t) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
  }

  /// A glyph's label as its tip (Picker.tsx data-tip); the emoji button has none
  func tip(_ i: Int) -> Tip? { Self.slots[i].glyph.map { Tip(Sticker.label($0)) } }

  package override func mouseMoved(with e: NSEvent) {
    hover = slot(at: convert(e.locationInWindow, from: nil))
    Tips.shared.hover(hover.flatMap(tip), hover.map { Self.rects()[$0] } ?? .zero, in: self, theme: theme)
  }
  package override func mouseExited(with e: NSEvent) {
    hover = nil
    Tips.shared.hover(nil, in: self, theme: theme)
  }
  /// The slot pressed: a click on it is a press and a release over it (main's <button>)
  private var down: Int?

  package override func mouseDown(with e: NSEvent) {
    Tips.shared.press()
    down = slot(at: convert(e.locationInWindow, from: nil))
  }

  package override func mouseUp(with e: NSEvent) {
    defer { down = nil }
    guard let i = slot(at: convert(e.locationInWindow, from: nil)), i == down else { return }
    press(i)
  }

  /// A slot clicked: its glyph, or the system's emoji picker
  package func press(_ i: Int) {
    if let g = Self.slots[i].glyph {
      onPick?(g)
      return
    }
    window?.makeFirstResponder(field)
    NSApp.orderFrontCharacterPalette(field)
  }

  /// What the emoji picker typed: its first character is the sticker
  package func typed(_ s: String) {
    guard let c = s.first else { return }
    field.stringValue = ""
    onPick?(.emoji(String(c)))
  }

  package override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The hidden field the system's emoji picker types into
final class EmojiField: NSTextField, NSTextFieldDelegate {
  var onText: ((String) -> Void)?

  override init(frame: NSRect) {
    super.init(frame: frame)
    delegate = self
    isBordered = false
    drawsBackground = false
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("EmojiField is not loaded from nibs") }

  func controlTextDidChange(_ n: Notification) {
    if !stringValue.isEmpty { onText?(stringValue) }
  }
}

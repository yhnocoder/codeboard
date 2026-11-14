import AppKit
import CodeBoardModel

// Stickers on the canvas (the web board's stickers/Layer.tsx, Picker.tsx, actions/stickers.ts, styles.css .stk): a free
// one over the cards, one on a card in the card's own layer (it moves with it, nothing redrawn), one on a code line as a
// chip in the line numbers (a dot by a Highlight's count). Each is vector layers in its glyph's box (StickerArt), so a
// move, a resize or a zoom never redraws a bitmap; an emoji's text is drawn again only at rest, as the markers are.
//
// The toolbar's Sticker opens the palette; a glyph picked follows the pointer with no button held and a click puts it
// down: on a code line's number, on a card, by one within 40 px, else free (⌥: free). Esc puts nothing down. A sticker
// is dragged (let go on a card it goes on it), resized by its corner grip when selected, and its menu has its colours
// and Delete.

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
}

/// A sticker pressed: moved or resized from where it was, and where it is now (board units)
struct StickerDrag {
  var id: StickerID
  var resize: Bool
  var from: CGRect
  var to: CGRect
  var moved = false
}

extension CanvasView {
  /// A line chip's size and step (.lstks: 14 across, 2 apart), and a dot's (.lstks.dot)
  static let chipSize: CGFloat = 14
  static let dotSize: CGFloat = 7
  /// How near a card a sticker put down beside it goes on it, in view points (Picker.tsx SNAP)
  static let stickerSnap: CGFloat = 40

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
      case .line(let c, let seg, let n):
        guard let r = rects[c], let p = scene.placed[c], !p.folded, let code = p.code,
          case .code(let card)? = scene.parts[c]?.content.body,
          let si = card.segments.firstIndex(where: { $0.id == seg }), let row = code.layout.row(segment: si, line: n)
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

  /// A sticker's layer: its glyph at its frame, a soft shadow under one on the board or a card (.stk.canvas .glyph)
  func stickerLayer(_ s: StickerSpot) -> CALayer {
    let l = StickerArt.layer(
      s.glyph, color: s.color, size: s.frame.height, theme: theme, pixels: backing * camera.zoom)
    l.name = "sticker"
    l.position = s.frame.origin
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
  /// its corner, and the dashed frame round the card it is on (.card.bind-anchor)
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
    var onCard = s.owner != nil && !s.line
    if case .sticker(let d)? = gesture?.kind, d.id == id, d.moved, !d.resize { onCard = false }
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
        dropAim?.removeFromSuperlayer()
        dropAim = stickerTarget(d.to, free: NSEvent.modifierFlags.contains(.option)).flatMap { aimLayer(.card($0)) }
      }
    }
    d.moved = true
  }

  /// The card a sticker let go at `r` goes on: the one under its middle (⌥: none)
  func stickerTarget(_ r: CGRect, free: Bool) -> CardID? {
    free ? nil : hitCard(CGPoint(x: r.midX, y: r.midY))
  }

  /// Let go: where it now is, or its new size, one step
  func commitSticker(_ d: StickerDrag, free: Bool) {
    gesture = nil
    withoutAnimation {
      dropAim?.removeFromSuperlayer()
      dropAim = nil
    }
    guard let doc = document, d.moved else { return drawChrome() }
    if d.resize {
      doc.edit("Resize Sticker") { $0.setStickerSize(d.id, Double(d.to.height)) }
    } else {
      let anchor = anchorFor(d.to, card: stickerTarget(d.to, free: free), size: Double(d.to.height))
      doc.edit("Move Sticker") { $0.moveSticker(d.id, to: anchor) }
    }
    // let go where it was: back in its place
    placeStickers()
    drawChrome()
  }

  /// A sticker's place for a box on the board: on that card from its top left, or free
  func anchorFor(_ r: CGRect, card: CardID?, size: Double?) -> Sticker.Anchor {
    let size = size == Sticker.defaultSize ? nil : size
    if let c = card, let cr = index(of: .card(c)).map({ scene!.items[$0].rect }) {
      return .card(c, x: Double((r.minX - cr.minX).rounded()), y: Double((r.minY - cr.minY).rounded()), size: size)
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

  /// The click while placing: the sticker goes down there, one step, not selected
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
      anchor = anchorFor(r, card: free ? nil : hitCard(p) ?? cardNear(p), size: nil)
    }
    let id = StickerID(rawValue: Board.newID("k"))
    doc.edit("Add Sticker") { $0.addSticker(Sticker(id: id, glyph: g, anchor: anchor)) }
  }

  /// The nearest card within the snap distance of a board point
  func cardNear(_ p: CGPoint) -> CardID? {
    let reach = Self.stickerSnap / camera.zoom
    var best: (CardID, CGFloat)?
    for it in scene?.items ?? [] {
      guard case .card(let c)? = it.owner else { continue }
      let dx = max(it.rect.minX - p.x, 0, p.x - it.rect.maxX)
      let dy = max(it.rect.minY - p.y, 0, p.y - it.rect.maxY)
      let d = hypot(dx, dy)
      if d <= reach, d < best?.1 ?? .infinity { best = (c, d) }
    }
    return best?.0
  }

  // MARK: The palette

  /// The toolbar's Sticker: its palette opens above the button at `button` (in this view), or closes
  public func toggleStickerPalette(above button: CGRect) {
    if stickerPalette != nil { return closeStickerPalette() }
    cancelPlacing()
    let p = StickerPalette(theme: theme)
    let chosen = selectedSticker.map { stickerSpots[$0].glyph }
    p.chosen = chosen
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

  /// A glyph picked: the selected sticker takes it (its colour back to the glyph's own), else it is placed
  package func pickSticker(_ g: Sticker.Glyph) {
    closeStickerPalette()
    if let i = selectedSticker, let doc = document {
      let id = stickerSpots[i].id
      doc.edit("Change Sticker") { $0.setStickerGlyph(id, g) }
      return
    }
    beginPlacing(g)
  }

  // MARK: The menu

  /// A sticker's menu: its colours (not an emoji's) and Delete
  func stickerMenu(_ id: StickerID) -> NSMenu {
    let m = NSMenu()
    if let k = document?.board.sticker(id), let own = Sticker.ownColor(k.glyph) {
      let row = StickerSwatches(theme: theme, own: own, current: k.drawnColor ?? own)
      row.onPick = { [weak self, weak m] hex in
        m?.cancelTracking()
        self?.document?.edit("Sticker Color") { $0.setStickerColor(id, hex) }
      }
      let item = NSMenuItem()
      item.view = row
      m.addItem(item)
      m.addItem(.separator())
    }
    m.addItem(
      menuItem("Delete") { [weak self] in
        self?.document?.edit("Delete") { $0.delete([.sticker(id)]) }
      })
    return m
  }
}

/// The palette over the toolbar's Sticker (Picker.tsx .stkpick, without its tabs, search and colours): the built-in
/// glyphs in eight columns, the TODO tag two wide, and one button for the system's emoji
package final class StickerPalette: NSView {
  package var onPick: ((Sticker.Glyph) -> Void)?
  /// The selected sticker's glyph, ringed
  var chosen: Sticker.Glyph? {
    didSet { draw() }
  }
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
        let on = g != nil && g == chosen
        guard on || hover == i, let art = cell.sublayers?.first else { continue }
        let ring = CAShapeLayer()
        ring.name = "ring"
        ring.position = art.position
        ring.path =
          g.map { StickerArt.outline($0, size: 22, out: 2.75) }
          ?? CGPath(ellipseIn: CGRect(x: -2.75, y: -2.75, width: 27.5, height: 27.5), transform: nil)
        ring.fillColor = on ? nil : t.hlrow
        ring.strokeColor = on ? t.accent : t.ink3.copy(alpha: 0.5)
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

  package override func mouseMoved(with e: NSEvent) { hover = slot(at: convert(e.locationInWindow, from: nil)) }
  package override func mouseExited(with e: NSEvent) { hover = nil }
  package override func mouseDown(with e: NSEvent) {}

  package override func mouseUp(with e: NSEvent) {
    guard let i = slot(at: convert(e.locationInWindow, from: nil)) else { return }
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

/// A sticker menu's row of colours (Picker.tsx .scolors .sw): 16 across, 8 apart; the glyph's own first when the
/// palette lacks it; the one it is ringed in the accent
package final class StickerSwatches: NSView {
  package var onPick: ((String) -> Void)?
  package let colors: [String]
  let current: String
  let theme: Theme

  package init(theme: Theme, own: String, current: String) {
    self.theme = theme
    self.current = current.uppercased()
    let palette = Sticker.palette.map { $0.uppercased() }
    colors = (palette.contains(own.uppercased()) ? [] : [own.uppercased()]) + palette
    super.init(frame: CGRect(x: 0, y: 0, width: 14 + CGFloat(colors.count) * 24 - 8 + 14, height: 28))
    wantsLayer = true
    for (i, c) in colors.enumerated() {
      let l = CALayer()
      l.frame = rect(i)
      l.cornerRadius = 8
      l.backgroundColor = StickerArt.color(c)
      l.borderWidth = 1
      l.borderColor = CGColor(gray: 0, alpha: 0.12)
      layer?.addSublayer(l)
      if c == self.current {
        let ring = CAShapeLayer()
        ring.path = CGPath(ellipseIn: l.frame.insetBy(dx: -2.75, dy: -2.75), transform: nil)
        ring.fillColor = nil
        ring.strokeColor = theme.accent
        ring.lineWidth = 1.5
        layer?.addSublayer(ring)
      }
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("StickerSwatches is not loaded from nibs") }

  func rect(_ i: Int) -> CGRect { CGRect(x: 14 + CGFloat(i) * 24, y: 6, width: 16, height: 16) }

  package override func mouseUp(with e: NSEvent) {
    let p = convert(e.locationInWindow, from: nil)
    if let i = colors.indices.first(where: { rect($0).insetBy(dx: -4, dy: -6).contains(p) }) { onPick?(colors[i]) }
  }
}

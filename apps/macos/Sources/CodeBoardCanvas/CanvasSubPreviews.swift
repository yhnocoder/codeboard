import AppKit
import CodeBoardModel

// Previews of a sub-board's cards beside its sub-board card (the web board's state/subboards.ts pvs, pvLayout,
// togglePreview; cards/SubPreviews.tsx; cards/BoardBody.tsx .sbpick; styles.css .sbpv): a click on a card of the map a
// sub-board card draws (a double-click enters the board there) opens a read-only preview of that card on the card's
// right, numbered as the badge put on its block; up to three are expanded there, in one column or two, more open as title
// rows under the card (on the right under the expanded ones when something lies under the card). A click on its block
// again, or its ×, closes it. Which are open is the view's: never saved, never an undo step, gone with a board switch; a
// preview whose card leaves the sub-board closes, as do all of a sub-board card that goes or whose board cannot be read.
// They are drawn in the sub-board card's own layer, so a drag moves them with it; a preview's body is its card as the
// board draws it (as a ref's preview, CanvasRefs.swift), read from its board off the main thread.

/// One sub-board card's previews (subboards.ts Pv): `open` in the order opened (a preview's number is its place + 1),
/// `exp` expanded on the right in the order laid out, `tit` the title rows, `fold` all hidden
struct SubPreview: Equatable {
  var open: [CardID] = []
  var exp: [CardID] = []
  var tit: [CardID] = []
  var fold = false

  /// PV_W, PV_GAP, TIT_W, TIT_H, TIT_GAP, PV_MAX, PV_OFF (board units)
  static let width: CGFloat = 260
  static let gap: CGFloat = 10
  static let titleWidth: CGFloat = 200
  static let titleHeight: CGFloat = 30
  static let titleGap: CGFloat = 6
  static let most = 3
  static let off: CGFloat = 14
  /// A preview's height until its card is drawn
  static let guess: CGFloat = 120
  /// The body's greatest height (.pb max-height) and the fade at its foot when it is cut
  static let body: CGFloat = 170
  static let fade: CGFloat = 34

  /// A block clicked (togglePreview): an open one closes; another opens expanded while the right has room, else as the
  /// first free title row, and all show again
  mutating func toggle(_ id: CardID) {
    if let i = open.firstIndex(of: id) {
      open.remove(at: i)
      drop(id)
      return
    }
    open.append(id)
    if exp.count < Self.most { exp.append(id) } else { tit.append(id) }
    fold = false
  }

  mutating func drop(_ id: CardID) {
    exp.removeAll { $0 == id }
    tit.removeAll { $0 == id }
  }

  /// Where each preview goes, and the right side's and the title rows' areas
  struct Layout: Equatable {
    var boxes: [CardID: CGRect]
    /// Title rows in a line
    var per: Int
    /// The title rows are on the right, under the expanded ones
    var side: Bool
    var right: CGRect
    var titles: CGRect
  }

  /// pvLayout: `exp` in `columns` columns on the right of the card's rect `f`, each into the shorter (the left when even);
  /// `tit` in lines under the card as wide as it, or on the right under the expanded ones as wide as they are when the
  /// space under the card meets `obstacles`; `peek`'s title row opened in place. `height`: a preview's height expanded
  static func layout(
    _ f: CGRect, exp: [CardID], tit: [CardID], columns: Int, height: (CardID) -> CGFloat, peek: CardID? = nil,
    obstacles: [CGRect] = []
  ) -> Layout {
    var boxes: [CardID: CGRect] = [:]
    let x0 = f.maxX + off
    var colH = [CGFloat](repeating: 0, count: columns == 2 ? 2 : 1)
    for id in exp {
      let c = colH.count > 1 && colH[1] < colH[0] ? 1 : 0
      let h = height(id)
      boxes[id] = CGRect(x: x0 + CGFloat(c) * (width + gap), y: f.minY + colH[c], width: width, height: h)
      colH[c] += h + gap
    }
    let expH = max(0, colH.map { $0 - gap }.max() ?? 0)
    let n = CGFloat(colH.count)
    let rightW = n * width + (n - 1) * gap
    func rows(_ w: CGFloat) -> (per: Int, h: CGFloat) {
      let per = max(1, Int(((w + gap) / (titleWidth + gap)).rounded(.down)))
      let lines = (CGFloat(tit.count) / CGFloat(per)).rounded(.up)
      return (per, max(titleHeight, lines * (titleHeight + titleGap) - titleGap))
    }
    let under = rows(f.width)
    let below = CGRect(x: f.minX, y: f.maxY + off, width: f.width, height: under.h)
    let hits = { (a: CGRect, b: CGRect) in a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY }
    let side = !tit.isEmpty && obstacles.contains { hits($0, below) }
    let (per, th) = side ? rows(rightW) : under
    let titles =
      side ? CGRect(x: x0, y: f.minY + (expH > 0 ? expH + off : 0), width: rightW, height: th) : below
    for (i, id) in tit.enumerated() {
      let pk = id == peek
      boxes[id] = CGRect(
        x: titles.minX + CGFloat(i % per) * (titleWidth + gap),
        y: titles.minY + CGFloat(i / per) * (titleHeight + titleGap), width: pk ? width : titleWidth,
        height: pk ? height(id) : titleHeight)
    }
    let right = CGRect(x: x0, y: f.minY, width: rightW, height: side ? max(titleHeight, expH) : max(f.height, expH))
    return Layout(boxes: boxes, per: per, side: side, right: right, titles: titles)
  }
}

/// The previews open on the board shown and what they are drawn from: the view's own (CanvasView.subPreviews)
struct SubPreviews {
  /// A preview's card as drawn: its name, its picture (nil: it could not be read), shown as wide as the preview, and how
  /// much of the card's top is its own header, which the preview's header stands for (card units)
  struct Drawn {
    var name: String
    var picture: RefPeek.Picture?
    var crop: CGFloat
    /// Which drawing it is (`SubPreviews.draws` when it came)
    var serial = 0

    /// From the card's units to the preview's
    var k: CGFloat { picture.map { SubPreview.width / max(1, $0.size.width) } ?? 1 }
    /// The body's height: the picture below its header, at most `SubPreview.body`
    var body: CGFloat { min(SubPreview.body, full) }
    var cut: Bool { full > SubPreview.body + 1 }
    private var full: CGFloat { picture.map { max(0, ($0.size.height - crop) * k) } ?? 0 }
  }

  /// A sub-board card's layers in its own box: the badges on its map's blocks, and its previews
  @MainActor final class Shown {
    let group = CALayer()
    let picks = CALayer()
    let previews = CALayer()
    var cards: [CardID: (layer: CALayer, key: String)] = [:]
    var picksKey = ""

    init() {
      group.zPosition = 4
      group.addSublayer(picks)
      group.addSublayer(previews)
    }
  }

  var open: [CardID: SubPreview] = [:]
  /// By sub-board card, then card
  var drawn: [CardID: [CardID: Drawn]] = [:]
  /// The map each sub-board card's previews were drawn from: another one draws them again
  var maps: [CardID: Skeleton] = [:]
  /// The look they were drawn in
  var look = ""
  /// Being drawn (sub-board card, card); what comes for another map or look than now is left unused
  var asked: Set<[CardID]> = []
  var shown: [CardID: Shown] = [:]
  /// How many previews have been drawn (tests: a drag draws none)
  var draws = 0
}

/// A part of the previews under the pointer
enum PreviewPart: Equatable {
  case close(CardID, CardID)
  /// The rest of a preview: it takes the press
  case preview(CardID, CardID)
}

extension CanvasView {
  /// The card of a sub-board card's map under `p` clicked (interact.ts startCardDrag's click on a [data-sub] block): its
  /// preview opens, or closes
  func clickMap(_ frame: CardID, at p: CGPoint) {
    guard let card = mapCard(at: p, of: frame) else { return }
    toggleSubPreview(frame, card)
  }

  func toggleSubPreview(_ frame: CardID, _ card: CardID) {
    var pv = subPreviews.open[frame] ?? SubPreview()
    pv.toggle(card)
    subPreviews.open[frame] = pv.open.isEmpty ? nil : pv
    subPreviewsChanged()
  }

  /// The scene or the look changed: previews of a card gone from its sub-board close, those of a sub-board card gone or
  /// whose board is not there go; a map changed or another look draws them again
  func subPreviewsChanged() {
    let look = "\(theme.id) \(theme.dark)"
    if subPreviews.look != look {
      subPreviews.look = look
      subPreviews.drawn = [:]
      subPreviews.maps = [:]
      subPreviews.asked = []
    }
    for (frame, var pv) in subPreviews.open {
      guard case .board(let d)? = scene?.parts[frame]?.drawing, let map = d.map, !d.gone else {
        subPreviews.open[frame] = nil
        continue
      }
      let have = Set(map.cards.map(\.id))
      for id in pv.open where !have.contains(id) { pv.toggle(id) }
      subPreviews.open[frame] = pv.open.isEmpty ? nil : pv
      if subPreviews.maps[frame] != map {
        subPreviews.maps[frame] = map
        subPreviews.drawn[frame] = nil
        subPreviews.shown[frame]?.picksKey = ""
        subPreviews.asked = subPreviews.asked.filter { $0[0] != frame }
      }
    }
    for frame in subPreviews.drawn.keys where subPreviews.open[frame] == nil {
      subPreviews.drawn[frame] = nil
      subPreviews.maps[frame] = nil
    }
    for frame in subPreviews.open.keys { drawSubPreviews(frame) }
    placeSubPreviews()
  }

  /// Draws the open previews of a sub-board card not drawn yet, off the main thread: each card read from its board
  /// (a shared one from the vault), drawn as the board draws it; a Note, Text or Box laid out again at the preview's
  /// width, as the web board's preview sets its Markdown, another card scaled to it
  private func drawSubPreviews(_ frame: CardID) {
    guard let (_, vault) = shown, let target = subBoardTarget(frame), let pv = subPreviews.open[frame] else { return }
    let want = pv.open.filter { subPreviews.drawn[frame]?[$0] == nil && !subPreviews.asked.contains([frame, $0]) }
    guard !want.isEmpty else { return }
    for id in want { subPreviews.asked.insert([frame, id]) }
    let (map, look) = (subPreviews.maps[frame], subPreviews.look)
    let (theme, display, images) = (self.theme, self.display, self.images)
    // as sharp as the zoom it opens at needs, up to twice the screen's
    let backing = self.backing * min(2, max(1, camera.zoom))
    Task {
      let got = await Task.detached { () -> [CardID: SubPreviews.Drawn] in
        guard let meta = ((try? vault.tree())?.allBoards ?? []).first(where: { $0.id == target }),
          let board = try? vault.board(at: meta.path)
        else { return [:] }
        let package = vault.url(of: meta.path)
        let names = RefResolver(board, package: package, vault: vault)
        var out: [CardID: SubPreviews.Drawn] = [:]
        for id in want {
          guard var card = board.card(id) else { continue }
          // a code card's and a Note's own header: the preview's says what it says
          var crop: CGFloat = 0
          switch Scene.content(of: card, package: package, vault: vault)?.0.body {
          case .code?: crop = theme.headerHeight
          case .note?:
            crop = theme.headerHeight
            card.width = SubPreview.width
          case .text?: card.width = SubPreview.width
          default: break
          }
          let k = SubPreview.width / max(1, card.width)
          let picture = await CanvasView.peekPicture(
            card, board: board.id, package: package, vault: vault, theme: theme, display: display, images: images,
            room: card.width, backing: backing * k)
          out[id] = SubPreviews.Drawn(name: names.title(card), picture: picture, crop: crop)
        }
        return out
      }.value
      guard subPreviews.maps[frame] == map, subPreviews.look == look else { return }
      for id in want { subPreviews.asked.remove([frame, id]) }
      guard subPreviews.open[frame] != nil else { return }
      for (id, var d) in got {
        subPreviews.draws += 1
        d.serial = subPreviews.draws
        subPreviews.drawn[frame, default: [:]][id] = d
      }
      placeSubPreviews()
    }
  }

  /// A preview's height expanded: its header and body, or a guess until it is drawn
  func previewHeight(_ frame: CardID, _ card: CardID) -> CGFloat {
    subPreviews.drawn[frame]?[card].map { SubPreview.titleHeight + $0.body } ?? SubPreview.guess
  }

  /// Where a sub-board card's previews go now (nil: none open, or the card is not drawn)
  func previewLayout(_ frame: CardID) -> SubPreview.Layout? {
    guard let pv = subPreviews.open[frame], let r = scene?.placed[frame]?.rect, let s = scene else { return nil }
    // what is under the card (other cards, a sub-board card with its name above it) keeps the title rows off it
    var obstacles: [CGRect] = []
    if !pv.tit.isEmpty {
      for it in s.items {
        guard case .card(let id)? = it.owner, id != frame else { continue }
        var o = it.rect
        if case .board = it.drawing {
          o.origin.y -= Drawing.subHead
          o.size.height += Drawing.subHead
        }
        obstacles.append(o)
      }
    }
    let columns = scene?.parts[frame].flatMap { p -> Int? in
      if case .board(let sub) = p.content.body { sub.twoColumnPreview ? 2 : 1 } else { nil }
    }
    return SubPreview.layout(
      r, exp: pv.exp, tit: pv.tit, columns: columns ?? 1, height: { self.previewHeight(frame, $0) },
      obstacles: obstacles)
  }

  /// The previews' layers in their sub-board cards' boxes, each drawn again only when what it shows or the resting
  /// zoom changes (drawChrome calls this too)
  func placeSubPreviews() {
    for (frame, shown) in subPreviews.shown where subPreviews.open[frame] == nil || index(of: .card(frame)) == nil {
      shown.group.removeFromSuperlayer()
      subPreviews.shown[frame] = nil
    }
    let scale = (restZoom ?? camera.zoom) * backing
    for (frame, pv) in subPreviews.open {
      guard let i = index(of: .card(frame)), let r = scene?.placed[frame]?.rect, let lay = previewLayout(frame),
        case .board(let d)? = scene?.parts[frame]?.drawing, let map = d.map
      else { continue }
      let shown = subPreviews.shown[frame] ?? SubPreviews.Shown()
      subPreviews.shown[frame] = shown
      let box = items[i].box
      withoutAnimation {
        // the card's layers were made again (a redraw): into the new ones as it is
        if shown.group.superlayer !== box { box.addSublayer(shown.group) }
        shown.group.frame = box.bounds
        placePicks(map, pv, shown, in: r, scale: scale)
        shown.previews.isHidden = pv.fold
        for (id, s) in shown.cards where !pv.open.contains(id) {
          s.layer.removeFromSuperlayer()
          shown.cards[id] = nil
        }
        for (n, id) in pv.open.enumerated() {
          guard let b = lay.boxes[id] else { continue }
          let drawn = subPreviews.drawn[frame]?[id]
          let mini = pv.tit.contains(id)
          let kind = map.cards.first { $0.id == id }?.kind
          let key = "\(n) \(mini) \(drawn?.serial ?? 0) \(b.size) \(theme.id) \(theme.dark) \(scale)"
          var l = shown.cards[id]?.layer ?? CALayer()
          if shown.cards[id]?.key != key {
            l.removeFromSuperlayer()
            l = previewLayer(drawn, n: n + 1, kind: kind, size: b.size, mini: mini, scale: scale)
            shown.previews.addSublayer(l)
            shown.cards[id] = (l, key)
          }
          // hidden until its card is drawn (a ref's preview: once its picture is there)
          l.isHidden = drawn == nil
          l.frame = b.offsetBy(dx: -r.minX, dy: -r.minY)
        }
      }
    }
  }

  /// The badges on the open cards' blocks of the map (.sbpick): a ring of the accent round the block and its number
  private func placePicks(_ map: Skeleton, _ pv: SubPreview, _ shown: SubPreviews.Shown, in r: CGRect, scale: CGFloat) {
    let key = "\(pv.open) \(r.size) \(theme.id) \(theme.dark) \(scale)"
    guard shown.picksKey != key else { return }
    shown.picksKey = key
    shown.picks.sublayers = nil
    for (n, id) in pv.open.enumerated() {
      guard let b = Drawing.block(id, in: map, r)?.offsetBy(dx: -r.minX, dy: -r.minY) else { continue }
      let ring = CALayer()
      ring.frame = b.insetBy(dx: -2, dy: -2)
      ring.borderWidth = 2
      ring.borderColor = theme.accent
      ring.cornerRadius = 5
      shown.picks.addSublayer(ring)
      let badge = PreviewArt.badge(n + 1, ring: true, theme, scale: scale)
      let l = CALayer()
      l.frame = CGRect(origin: CGPoint(x: b.minX - 7 - 1.5, y: b.minY - 7 - 1.5), size: badge.size)
      l.contents = badge.image
      l.contentsGravity = .resize
      shown.picks.addSublayer(l)
    }
  }

  /// One preview (.sbpv): the card's shadow, its face with the header and the body; a title row (.mini) only its header
  /// in a hairline ring
  private func previewLayer(
    _ d: SubPreviews.Drawn?, n: Int, kind: Skeleton.Card.Kind?, size: CGSize, mini: Bool, scale: CGFloat
  ) -> CALayer {
    let t = theme
    let l = CALayer()
    l.bounds = CGRect(origin: .zero, size: size)
    l.anchorPoint = .zero
    let radius = t.cardRadius * 0.8
    if !mini, let shadow = cardShadow { l.addSublayer(CanvasView.shadowLayer(shadow, around: l.bounds)) }
    let face = CALayer()
    face.frame = l.bounds
    face.backgroundColor = t.surface
    face.cornerRadius = radius
    face.cornerCurve = .continuous
    face.masksToBounds = true
    if mini {
      face.borderWidth = 0.5
      face.borderColor = t.hair
    }
    l.addSublayer(face)
    let head = CALayer()
    head.frame = CGRect(x: 0, y: 0, width: size.width, height: SubPreview.titleHeight)
    head.contents = CanvasView.picture(size: head.bounds.size, scale: scale) { ctx in
      PreviewArt.header(ctx, n: n, name: d?.name ?? "", kind: kind, width: size.width, mini: mini, t)
    }
    head.contentsGravity = .resize
    face.addSublayer(head)
    guard !mini, let d, let p = d.picture else { return l }
    let stage = CALayer()
    stage.frame = CGRect(x: 0, y: SubPreview.titleHeight, width: size.width, height: d.body)
    stage.masksToBounds = true
    let k = d.k
    let picture = CALayer()
    picture.frame = CGRect(
      x: -p.bleed * k, y: -(d.crop + p.bleed) * k, width: (p.size.width + 2 * p.bleed) * k,
      height: (p.size.height + 2 * p.bleed) * k)
    picture.contents = p.surface
    picture.contentsGravity = .resize
    stage.addSublayer(picture)
    if d.cut {
      let m = CAGradientLayer()
      m.frame = stage.bounds
      m.colors = [CGColor(gray: 0, alpha: 1), CGColor(gray: 0, alpha: 1), CGColor(gray: 0, alpha: 0)]
      m.locations = [0, NSNumber(value: Double((d.body - SubPreview.fade) / d.body)), 1]
      stage.mask = m
    }
    face.addSublayer(stage)
    return l
  }

  /// The preview part at a board point: the topmost, a title row over the expanded ones
  func previewPart(at p: CGPoint) -> PreviewPart? {
    guard levels.level == .cards else { return nil }
    for (frame, pv) in subPreviews.open where !pv.fold {
      guard let lay = previewLayout(frame) else { continue }
      for id in pv.tit.reversed() + pv.exp.reversed() {
        guard subPreviews.drawn[frame]?[id] != nil, let b = lay.boxes[id], b.contains(p) else { continue }
        if PreviewArt.close(in: b).contains(p) { return .close(frame, id) }
        return .preview(frame, id)
      }
    }
    return nil
  }

  /// A press on a preview: its buttons act on the release over them (hold); the rest takes the press
  func pressSubPreview(_ e: NSEvent, at p: CGPoint) -> Bool {
    guard let part = previewPart(at: p) else { return false }
    if e.clickCount == 1, case .close(let frame, let card) = part {
      hold(
        over: { [weak self] in self?.previewPart(at: $0) == part },
        act: { [weak self] in self?.toggleSubPreview(frame, card) })
    }
    return true
  }

  /// The previews and their buttons as accessibility elements (ui-subpreview, ui-subpreviewclose)
  func subPreviewElements() -> [Any] {
    var out: [Any] = []
    for (frame, pv) in subPreviews.open where !pv.fold {
      guard let lay = previewLayout(frame) else { continue }
      for id in pv.open {
        guard let d = subPreviews.drawn[frame]?[id], let b = lay.boxes[id] else { continue }
        out.append(uiElement("subpreview", viewRect(b), label: d.name, in: self))
        out.append(
          uiElement("subpreviewclose", viewRect(PreviewArt.close(in: b)), label: "Close this preview", in: self))
      }
    }
    return out
  }

  private func viewRect(_ r: CGRect) -> CGRect {
    let a = camera.view(r.origin)
    let b = camera.view(CGPoint(x: r.maxX, y: r.maxY))
    return CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y)
  }
}

/// How a preview's parts are drawn (styles.css .sbpv .ph, .sbpick i)
enum PreviewArt {
  static let name = Font(NSFont.systemFont(ofSize: 12, weight: .semibold))
  static let miniName = Font(NSFont.systemFont(ofSize: 12, weight: .medium))
  static let number = Font(NSFont.systemFont(ofSize: 9.5, weight: .semibold))
  static let mono = Font(NSFont.monospacedSystemFont(ofSize: 11, weight: .medium))

  /// The × in a preview's header (.ph .x: 20 square, 6 in from the right, in the middle of the 30 high header)
  static func close(in b: CGRect) -> CGRect { CGRect(x: b.maxX - 6 - 20, y: b.minY + 5, width: 20, height: 20) }

  /// A number in the accent's pill (15 high, at least as wide, 4 either side of the number); `ring`: in a ring of the
  /// surface 1.5 wide, as on the map
  static func badge(_ n: Int, ring: Bool, _ t: Theme, scale: CGFloat) -> (image: CGImage?, size: CGSize) {
    let s = "\(n)"
    let w = max(15, Drawing.width(s, number) + 8)
    let o: CGFloat = ring ? 1.5 : 0
    let size = CGSize(width: w + 2 * o, height: 15 + 2 * o)
    let image = CanvasView.picture(size: size, scale: scale) { ctx in
      if ring {
        ctx.addPath(
          CGPath(roundedRect: CGRect(origin: .zero, size: size), cornerWidth: 9.5, cornerHeight: 9.5, transform: nil))
        ctx.setFillColor(t.surface)
        ctx.fillPath()
      }
      pill(ctx, s, CGRect(x: o, y: o, width: w, height: 15), t)
    }
    return (image, size)
  }

  private static func pill(_ ctx: CGContext, _ s: String, _ r: CGRect, _ t: Theme) {
    ctx.addPath(CGPath(roundedRect: r, cornerWidth: 7.5, cornerHeight: 7.5, transform: nil))
    ctx.setFillColor(t.accent)
    ctx.fillPath()
    let w = Drawing.width(s, number)
    Drawing.text(ctx, s, number, t.accentInk, x: r.midX - w / 2, midY: r.midY, width: w + 1)
  }

  /// The header (.ph): 9 in, the number, the kind's icon, the name (a code card's in the mono face) to the ×, 6 apart;
  /// a line under it but on a title row
  static func header(
    _ ctx: CGContext, n: Int, name: String, kind: Skeleton.Card.Kind?, width: CGFloat, mini: Bool, _ t: Theme,
    closeLit: Bool = false
  ) {
    let mid = SubPreview.titleHeight / 2
    let s = "\(n)"
    let bw = max(15, Drawing.width(s, number) + 8)
    pill(ctx, s, CGRect(x: 9, y: mid - 7.5, width: bw, height: 15), t)
    var x = 9 + bw + 6
    if let kind {
      Icons.stroke(icon(kind), scale: 11 / 16, at: CGPoint(x: x, y: mid - 5.5), color: t.ink3, in: ctx)
      x += 11 + 6
    }
    let close = close(in: CGRect(x: 0, y: 0, width: width, height: SubPreview.titleHeight))
    let font = kind == .code ? mono : mini ? miniName : self.name
    Drawing.text(ctx, name, font, mini ? t.ink2 : t.ink, x: x, midY: mid, width: close.minX - 6 - x)
    if closeLit {
      ctx.addPath(CGPath(roundedRect: close, cornerWidth: 5, cornerHeight: 5, transform: nil))
      ctx.setFillColor(t.hlrow)
      ctx.fillPath()
    }
    Icons.stroke(
      SVGPath.parse(WebIcons.close), scale: 10 / 16, at: CGPoint(x: close.midX - 5, y: close.midY - 5),
      color: closeLit ? t.ink : t.ink3, in: ctx)
    guard !mini else { return }
    ctx.setFillColor(t.line)
    ctx.fill(CGRect(x: 0, y: SubPreview.titleHeight - 0.5, width: width, height: 0.5))
  }

  /// A kind's icon (BoardBody.tsx skelIcon)
  static func icon(_ k: Skeleton.Card.Kind) -> CGPath {
    switch k {
    case .note: Icons.note()
    case .text: Icons.text()
    case .box: Icons.box()
    case .code: Icons.code
    case .image: Icons.image
    case .web: Icons.web
    case .links: SVGPath.parse(WebIcons.link)
    case .board: Icons.section()
    }
  }
}

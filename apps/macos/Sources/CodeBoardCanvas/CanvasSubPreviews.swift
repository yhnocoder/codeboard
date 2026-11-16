import AppKit
import CodeBoardModel

// Previews of a sub-board's cards beside its sub-board card (the web board's state/subboards.ts pvs, pvLayout,
// togglePreview; cards/SubPreviews.tsx; cards/BoardBody.tsx .sbpick; styles.css .sbpv): a click on a card of the map a
// sub-board card draws (a double-click enters the board there) opens a read-only preview of that card on the card's
// right, numbered as the badge put on its block; up to three are expanded there, in one column or two, more open as title
// rows under the card (on the right under the expanded ones when something lies under the card). A click on its block
// again, or its ×, closes it; above the card's right, the count with Hide / Show, one column or two (the card's own
// setting, saved, not an undo step) and Clear. Which are open is the view's: never saved, never an undo step, gone with a
// board switch; a preview whose card leaves the sub-board closes, as do all of a sub-board card that goes or whose board
// cannot be read. The preview under the pointer is ringed, a dashed line from its block to it. A preview is dragged by
// its header: onto the right it expands where it is let go (the lowest of more than three there goes first in the title
// rows), onto the title rows it is one of them; a title row clicked opens in place over the rows below until the next
// press elsewhere. They are drawn in the sub-board card's own layer, so a drag moves them with it; a preview's body is
// its card as the board draws it (as a ref's preview, CanvasRefs.swift), read from its board off the main thread.

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
  /// last title row, and all show again
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

  /// Let go on the right with its top at `y` (dropRight): expanded before the first whose middle is below it, else
  /// last; of more than three there, the lowest but it goes first in the title rows. `layout`: where `exp` would be
  mutating func dropRight(_ id: CardID, y: CGFloat, layout: ([CardID]) -> [CardID: CGRect]) {
    drop(id)
    let at0 = layout(exp)
    let at = exp.firstIndex { k in at0[k].map { y < $0.midY } ?? false } ?? exp.count
    exp.insert(id, at: at)
    guard exp.count > Self.most else { return }
    let l = layout(exp)
    guard let low = exp.filter({ $0 != id }).max(by: { (l[$0]?.maxY ?? 0) < (l[$1]?.maxY ?? 0) }) else { return }
    exp.removeAll { $0 == low }
    tit.insert(low, at: 0)
  }

  /// Let go on the title rows at line `row`, place `col` of `per` (dropTitles)
  mutating func dropTitles(_ id: CardID, row: Int, col: Int, per: Int) {
    drop(id)
    tit.insert(id, at: max(0, min(tit.count, row * per + col)))
  }

  /// Where a preview dragged with its top left at `o` would go (SubPreviews.tsx zoneOf): an expanded one with its middle
  /// over the title rows' area into them, else either one with its middle past the right's left edge onto the right
  static func zone(_ o: CGPoint, fromRight: Bool, _ l: Layout) -> PreviewDrag.Zone? {
    let cx = o.x + (fromRight ? width : titleWidth) / 2
    let t = l.titles
    if fromRight, o.y + titleHeight / 2 > t.minY - gap, cx > t.minX - gap, cx < t.maxX + gap { return .titles }
    return cx > l.right.minX - gap ? .right : nil
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
    let acts = CALayer()
    let line = CAShapeLayer()
    let previews = CALayer()
    /// Where a dragged preview can go (.sbdrop)
    let drops = CALayer()
    var cards: [CardID: (layer: CALayer, key: String)] = [:]
    var picksKey = ""
    var actsKey = ""

    init() {
      group.zPosition = 4
      line.fillColor = nil
      line.lineWidth = 1.2
      line.lineDashPattern = [3, 3]
      for l in [picks, acts, line, drops, previews] { group.addSublayer(l) }
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
  /// What the pointer is over
  var hover: PreviewPart?
  /// The title row opened in place (pvPeek)
  var peek: (frame: CardID, card: CardID)?
  /// How many previews have been drawn (tests: a drag draws none)
  var draws = 0
}

/// A preview dragged by its header: from where it was, to where its top left is now (board units)
struct PreviewDrag {
  enum Zone { case right, titles }

  var frame: CardID
  var card: CardID
  var from: CGRect
  /// It was expanded on the right
  var fromRight: Bool
  var at: CGPoint
  var zone: Zone?
  var moved = false
}

/// A part of the previews under the pointer
enum PreviewPart: Equatable {
  case close(CardID, CardID)
  /// The rest of a preview: it takes the press
  case preview(CardID, CardID)
  /// Above the sub-board card: Hide / Show, one column or two, Clear (.sbacts)
  case fold(CardID)
  case columns(CardID, Int)
  case clear(CardID)

  var isButton: Bool { if case .preview = self { false } else { true } }

  /// The preview it is on
  var preview: (frame: CardID, card: CardID)? {
    switch self {
    case .close(let f, let c), .preview(let f, let c): (f, c)
    default: nil
    }
  }
}

extension CanvasView {
  /// The card of a sub-board card's map under `p` clicked (interact.ts startCardDrag's click on a [data-sub] block): its
  /// preview opens, or closes
  func clickMap(_ frame: CardID, at p: CGPoint) {
    guard let card = mapCard(at: p, of: frame) else { return }
    toggleSubPreview(frame, card)
  }

  func toggleSubPreview(_ frame: CardID, _ card: CardID) {
    if subPreviews.peek.map({ $0 == (frame, card) }) == true { subPreviews.peek = nil }
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
    return SubPreview.layout(
      r, exp: pv.exp, tit: pv.tit, columns: previewColumns(frame), height: { self.previewHeight(frame, $0) },
      peek: subPreviews.peek.flatMap { $0.frame == frame ? $0.card : nil }, obstacles: obstacles)
  }

  /// A sub-board card's previews in one column or two (pvCols)
  func previewColumns(_ frame: CardID) -> Int {
    if case .board(let s)? = scene?.parts[frame]?.content.body, s.twoColumnPreview { 2 } else { 1 }
  }

  /// One column or two, the sub-board card's own setting: saved, not an undo step (setPreviewCols)
  func setPreviewColumns(_ frame: CardID, _ n: Int) {
    document?.sync { b in
      guard let i = b.cards.firstIndex(where: { $0.id == frame }), case .own(var k) = b.cards[i].content,
        case .board(var s) = k.body
      else { return }
      s.twoColumnPreview = n == 2
      k.body = .board(s)
      b.cards[i].content = .own(k)
    }
  }

  /// Hide / Show (foldPreviews)
  func foldSubPreviews(_ frame: CardID) {
    if subPreviews.peek?.frame == frame { subPreviews.peek = nil }
    subPreviews.open[frame]?.fold.toggle()
    placeSubPreviews()
  }

  /// Clear (clearPreviews)
  func clearSubPreviews(_ frame: CardID) {
    subPreviews.open[frame] = nil
    if subPreviews.hover.map({ previewFrame($0) == frame }) == true { subPreviews.hover = nil }
    if subPreviews.peek?.frame == frame { subPreviews.peek = nil }
    subPreviewsChanged()
  }

  private func previewFrame(_ p: PreviewPart) -> CardID {
    switch p {
    case .close(let f, _), .preview(let f, _), .fold(let f), .columns(let f, _), .clear(let f): f
    }
  }

  /// The buttons above a sub-board card's right with previews open (.sbacts: 20 above it, 6 apart, at its right)
  func previewActs(_ frame: CardID) -> [(PreviewPart, CGRect)] {
    guard let pv = subPreviews.open[frame], let r = scene?.placed[frame]?.rect else { return [] }
    let w = PreviewArt.actWidths(pv.open.count, fold: pv.fold)
    let y = r.minY - 20 - 26
    var x = r.maxX - w.clear
    var out: [(PreviewPart, CGRect)] = [(.clear(frame), CGRect(x: x, y: y, width: w.clear, height: 26))]
    x -= 6 + 49
    // the switch: 2 in, two 22 square buttons 1 apart
    out.append((.columns(frame, 1), CGRect(x: x + 2, y: y + 2, width: 22, height: 22)))
    out.append((.columns(frame, 2), CGRect(x: x + 25, y: y + 2, width: 22, height: 22)))
    x -= 6 + w.fold
    out.append((.fold(frame), CGRect(x: x, y: y, width: w.fold, height: 26)))
    return out
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
        placeActs(frame, pv, shown, in: r, scale: scale)
        shown.previews.isHidden = pv.fold
        var drag: PreviewDrag?
        if case .preview(let d)? = gesture?.kind, d.frame == frame, d.moved { drag = d }
        placeLine(frame, drag == nil ? pv : nil, lay, map, shown, in: r)
        placeDrops(drag, lay, shown, in: r)
        for (id, s) in shown.cards where !pv.open.contains(id) {
          s.layer.removeFromSuperlayer()
          shown.cards[id] = nil
        }
        for (n, id) in pv.open.enumerated() {
          guard let b = lay.boxes[id] else { continue }
          let drawn = subPreviews.drawn[frame]?[id]
          let peeked = subPreviews.peek.map { $0 == (frame, id) } == true
          let mini = pv.tit.contains(id) && !peeked
          let kind = map.cards.first { $0.id == id }?.kind
          let hot = subPreviews.hover?.preview.map { $0 == (frame, id) } == true
          let lit = subPreviews.hover == .close(frame, id)
          let key = "\(n) \(mini) \(drawn?.serial ?? 0) \(b.size) \(hot) \(lit) \(theme.id) \(theme.dark) \(scale)"
          var l = shown.cards[id]?.layer ?? CALayer()
          if shown.cards[id]?.key != key {
            l.removeFromSuperlayer()
            l = previewLayer(drawn, n: n + 1, kind: kind, size: b.size, mini: mini, hot: hot, lit: lit, scale: scale)
            shown.previews.addSublayer(l)
            shown.cards[id] = (l, key)
          }
          // hidden until its card is drawn (a ref's preview: once its picture is there)
          l.isHidden = drawn == nil
          // dragged: where the pointer has it, over the others (.sbpv.drag); opened in place: over the rows below
          let dragged = drag?.card == id
          l.frame = (dragged ? CGRect(origin: drag!.at, size: b.size) : b).offsetBy(dx: -r.minX, dy: -r.minY)
          l.zPosition = dragged ? 2 : peeked ? 1 : 0
          l.opacity = dragged ? 0.92 : 1
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
    _ d: SubPreviews.Drawn?, n: Int, kind: Skeleton.Card.Kind?, size: CGSize, mini: Bool, hot: Bool, lit: Bool,
    scale: CGFloat
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
    // a title row in a hairline (its header lit under the pointer); the one under the pointer in the accent (.hot)
    if mini || hot {
      face.borderWidth = hot ? 1.5 : 0.5
      face.borderColor = hot ? t.accent : t.hair
    }
    l.addSublayer(face)
    let head = CALayer()
    head.frame = CGRect(x: 0, y: 0, width: size.width, height: SubPreview.titleHeight)
    head.contents = CanvasView.picture(size: head.bounds.size, scale: scale) { ctx in
      if mini && hot {
        ctx.setFillColor(t.hlrow)
        ctx.fill(CGRect(origin: .zero, size: head.bounds.size))
      }
      PreviewArt.header(
        ctx, n: n, name: d?.name ?? "", kind: kind, width: size.width, mini: mini, t, closeLit: lit, nameLit: hot)
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

  /// The button row above the card, one bitmap drawn again when what it shows or the resting zoom changes
  private func placeActs(
    _ frame: CardID, _ pv: SubPreview, _ shown: SubPreviews.Shown, in r: CGRect, scale: CGFloat
  ) {
    let acts = previewActs(frame)
    guard let bounds = acts.map(\.1).reduce(nil, { ($0 ?? $1).union($1) }) else { return }
    let lit = subPreviews.hover.flatMap { h in acts.first { $0.0 == h }?.0 }
    let cols = previewColumns(frame)
    let key =
      "\(pv.open.count) \(pv.fold) \(cols) \(String(describing: lit)) \(r.size) \(theme.id) \(theme.dark) \(scale)"
    shown.acts.frame = bounds.offsetBy(dx: -r.minX, dy: -r.minY)
    guard shown.actsKey != key else { return }
    shown.actsKey = key
    let t = theme
    shown.acts.contents = CanvasView.picture(size: bounds.size, scale: scale) { ctx in
      ctx.translateBy(x: -bounds.minX, y: -bounds.minY)
      PreviewArt.acts(ctx, acts, n: pv.open.count, fold: pv.fold, columns: cols, lit: lit, t)
    }
    shown.acts.contentsGravity = .resize
  }

  /// The dashed line from the block of the preview under the pointer to its header (.sbpvl): out of its left on the
  /// right, out of its top in the title rows; none while one is dragged (`pv` nil)
  private func placeLine(
    _ frame: CardID, _ pv: SubPreview?, _ lay: SubPreview.Layout, _ map: Skeleton, _ shown: SubPreviews.Shown,
    in r: CGRect
  ) {
    shown.line.strokeColor = theme.accent.copy(alpha: 0.8)
    guard let pv, !pv.fold, let (f, id) = subPreviews.hover?.preview, f == frame, let b = lay.boxes[id],
      let k = Drawing.block(id, in: map, r)
    else {
      shown.line.path = nil
      return
    }
    let o = CGPoint(x: -r.minX, y: -r.minY)
    let a = CGPoint(x: k.midX + o.x, y: k.midY + o.y)
    let tit = pv.tit.contains(id)
    let z = CGPoint(x: b.minX + (tit ? 20 : 0) + o.x, y: b.minY + (tit ? 0 : 15) + o.y)
    let path = CGMutablePath()
    path.move(to: a)
    path.addCurve(
      to: z, control1: tit ? CGPoint(x: a.x, y: a.y + 50) : CGPoint(x: a.x + 60, y: a.y),
      control2: tit ? CGPoint(x: z.x, y: z.y - 50) : CGPoint(x: z.x - 40, y: z.y))
    shown.line.path = path
    let dot = CAShapeLayer()
    dot.path = CGPath(ellipseIn: CGRect(x: a.x - 2.5, y: a.y - 2.5, width: 5, height: 5), transform: nil)
    dot.fillColor = theme.accent
    shown.line.sublayers = [dot]
  }

  /// While a preview is dragged, the areas it can go to in dashed lines of the accent, the one it would go to strong
  /// (.sbdrop: 6 round the area, corners 12); the title rows' only for an expanded one
  private func placeDrops(_ d: PreviewDrag?, _ lay: SubPreview.Layout, _ shown: SubPreviews.Shown, in r: CGRect) {
    guard let d else {
      shown.drops.sublayers = nil
      return
    }
    let areas: [(PreviewDrag.Zone, CGRect)] = [(.right, lay.right)] + (d.fromRight ? [(.titles, lay.titles)] : [])
    if shown.drops.sublayers?.count != areas.count {
      shown.drops.sublayers = areas.map { _ in
        let l = CAShapeLayer()
        l.lineWidth = 1.5
        l.lineDashPattern = [4, 3]
        l.strokeColor = theme.accent
        l.fillColor = theme.accent.copy(alpha: 0.06)
        return l
      }
    }
    for ((zone, a), l) in zip(areas, shown.drops.sublayers ?? []) {
      let box = a.insetBy(dx: -6, dy: -6).offsetBy(dx: -r.minX, dy: -r.minY)
      (l as? CAShapeLayer)?.path = Drawing.squircle(box.insetBy(dx: 0.75, dy: 0.75), 11.25)
      l.opacity = zone == d.zone ? 1 : 0.35
    }
  }

  /// A press on a preview's header: it may be dragged (a gesture), or, let go where it was, a title row opens in place
  /// or closes again
  private func pressHeader(_ frame: CardID, _ card: CardID, at p: CGPoint, view v: CGPoint) {
    guard let pv = subPreviews.open[frame], let b = previewLayout(frame)?.boxes[card],
      p.y < b.minY + SubPreview.titleHeight
    else { return }
    let d = PreviewDrag(frame: frame, card: card, from: b, fromRight: pv.exp.contains(card), at: b.origin)
    gesture = Gesture(kind: .preview(d), startView: v, start: p)
  }

  /// The dragged preview where the pointer has it (`by`: from where it was pressed), over the area it would go to
  func dragPreview(_ d: inout PreviewDrag, by o: CGVector) {
    if !d.moved {
      d.moved = true
      subPreviews.peek = nil
    }
    d.at = CGPoint(x: d.from.minX + o.dx, y: d.from.minY + o.dy)
    if let lay = previewLayout(d.frame) { d.zone = SubPreview.zone(d.at, fromRight: d.fromRight, lay) }
    // placed with the gesture's own state
    if case .preview? = gesture?.kind { gesture?.kind = .preview(d) }
    placeSubPreviews()
  }

  /// Let go: on the right it expands where it is, on the title rows it is one of them; not moved, a title row opens in
  /// place or closes
  func dropPreview(_ d: PreviewDrag) {
    guard var pv = subPreviews.open[d.frame] else { return }
    if !d.moved {
      if !d.fromRight {
        subPreviews.peek = subPreviews.peek.map { $0 == (d.frame, d.card) } == true ? nil : (d.frame, d.card)
      }
    } else if let lay = previewLayout(d.frame), let r = scene?.placed[d.frame]?.rect {
      switch d.zone {
      case .right?:
        let columns = previewColumns(d.frame)
        pv.dropRight(d.card, y: d.at.y) { exp in
          SubPreview.layout(r, exp: exp, tit: [], columns: columns, height: { self.previewHeight(d.frame, $0) }).boxes
        }
      case .titles?:
        let t = lay.titles
        let row = max(
          0,
          Int(
            ((d.at.y + SubPreview.titleHeight / 2 - t.minY) / (SubPreview.titleHeight + SubPreview.titleGap)).rounded(
              .down)))
        let col = max(
          0,
          min(
            lay.per - 1,
            Int(
              ((d.at.x + SubPreview.titleWidth / 2 - t.minX) / (SubPreview.titleWidth + SubPreview.gap)).rounded(.down))
          ))
        pv.dropTitles(d.card, row: row, col: col, per: lay.per)
      case nil: break
      }
      subPreviews.open[d.frame] = pv
    }
    placeSubPreviews()
  }

  /// A press anywhere but on the title row opened in place folds it back
  func foldPeek(at p: CGPoint) {
    guard let (f, c) = subPreviews.peek, previewPart(at: p)?.preview.map({ $0 == (f, c) }) != true else { return }
    subPreviews.peek = nil
    placeSubPreviews()
  }

  /// The pointer over the previews' parts: the preview under it ringed with its line, a button lit; whether it is
  func hoverSubPreview(at p: CGPoint) -> Bool {
    let part = gesture == nil ? previewPart(at: p) : nil
    if part != subPreviews.hover {
      subPreviews.hover = part
      placeSubPreviews()
      showTip()
    }
    return part != nil
  }

  /// The tip of the button under the pointer and where it is
  func previewTip() -> (Tip, CGRect)? {
    guard let h = subPreviews.hover else { return nil }
    let tip: Tip
    let r: CGRect?
    switch h {
    case .close(let f, let c):
      tip = Tip("Close")
      r = previewLayout(f)?.boxes[c].map(PreviewArt.close)
    case .columns(let f, let n):
      tip = Tip(n == 2 ? "Previews in two columns" : "Previews in one column")
      r = previewActs(f).first { $0.0 == h }?.1
    case .clear(let f):
      tip = Tip("Close all previews")
      r = previewActs(f).first { $0.0 == h }?.1
    case .preview, .fold: return nil
    }
    return r.map { (tip, $0) }
  }

  /// The preview part at a board point: the topmost, a title row over the expanded ones
  func previewPart(at p: CGPoint) -> PreviewPart? {
    guard levels.level == .cards else { return nil }
    for frame in subPreviews.open.keys {
      if let (part, _) = previewActs(frame).first(where: { $0.1.contains(p) }) { return part }
    }
    for (frame, pv) in subPreviews.open where !pv.fold {
      guard let lay = previewLayout(frame) else { continue }
      let peeked = subPreviews.peek.flatMap { $0.frame == frame ? [$0.card] : nil } ?? []
      for id in peeked + pv.tit.reversed() + pv.exp.reversed() {
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
    if e.clickCount == 1, part.isButton {
      hold(over: { [weak self] in self?.previewPart(at: $0) == part }, act: { [weak self] in self?.pressPreview(part) })
    } else if e.clickCount == 1, case .preview(let f, let c) = part {
      pressHeader(f, c, at: p, view: convert(e.locationInWindow, from: nil))
    }
    return true
  }

  func pressPreview(_ part: PreviewPart) {
    switch part {
    case .close(let f, let c): toggleSubPreview(f, c)
    case .fold(let f): foldSubPreviews(f)
    case .columns(let f, let n): setPreviewColumns(f, n)
    case .clear(let f): clearSubPreviews(f)
    case .preview: break
    }
  }

  /// The previews and their buttons as accessibility elements (ui-subpreview, ui-subpreviewclose, ui-subpreviewfold,
  /// ui-subpreviewcols1, ui-subpreviewcols2, ui-subpreviewclear)
  func subPreviewElements() -> [Any] {
    var out: [Any] = []
    for (frame, pv) in subPreviews.open {
      for (part, r) in previewActs(frame) {
        let (name, label): (String, String) =
          switch part {
          case .fold:
            (
              "subpreviewfold",
              "\(pv.open.count) \(pv.open.count == 1 ? "preview" : "previews") · \(pv.fold ? "Show" : "Hide")"
            )
          case .columns(_, let n): ("subpreviewcols\(n)", n == 2 ? "Two columns" : "One column")
          default: ("subpreviewclear", "Close all previews")
          }
        out.append(uiElement(name, viewRect(r), label: label, in: self))
      }
    }
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
    closeLit: Bool = false, nameLit: Bool = false
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
    Drawing.text(ctx, name, font, mini && !nameLit ? t.ink2 : t.ink, x: x, midY: mid, width: close.minX - 6 - x)
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

  static let act = Font(NSFont.systemFont(ofSize: 12, weight: .medium))
  static let actCount = Font(NSFont.systemFont(ofSize: 12, weight: .semibold))

  /// After the count on Hide / Show
  static func foldLabel(_ n: Int, fold: Bool) -> String {
    " \(n == 1 ? "preview" : "previews") · \(fold ? "Show" : "Hide")"
  }

  /// Hide / Show's and Clear's widths (10 in either side, the chevron 11 wide 6 after the words)
  static func actWidths(_ n: Int, fold: Bool) -> (fold: CGFloat, clear: CGFloat) {
    (
      10 + Drawing.width("\(n)", actCount) + Drawing.width(foldLabel(n, fold: fold), act) + 6 + 11 + 10,
      10 + Drawing.width("Clear", act) + 10
    )
  }

  /// The row above the card (.sbacts): each button on the surface in a hairline, 26 high, its corners 11; the switch's
  /// buttons 22 high inside it, the one chosen on the accent's tint; a button under the pointer in the ink
  static func acts(
    _ ctx: CGContext, _ parts: [(PreviewPart, CGRect)], n: Int, fold: Bool, columns: Int, lit: PreviewPart?,
    _ t: Theme
  ) {
    func plate(_ r: CGRect) {
      ctx.addPath(Drawing.squircle(r, 11))
      ctx.setFillColor(t.surface)
      ctx.fillPath()
      ctx.addPath(Drawing.squircle(r.insetBy(dx: -0.25, dy: -0.25), 11.25))
      ctx.setStrokeColor(t.hair)
      ctx.setLineWidth(0.5)
      ctx.strokePath()
    }
    for (part, r) in parts {
      let ink = part == lit ? t.ink : t.ink2
      switch part {
      case .fold:
        plate(r)
        let count = "\(n)"
        let cw = Drawing.width(count, actCount)
        Drawing.text(ctx, count, actCount, t.accent, x: r.minX + 10, midY: r.midY, width: cw + 1)
        let label = foldLabel(n, fold: fold)
        let lw = Drawing.width(label, act)
        Drawing.text(ctx, label, act, ink, x: r.minX + 10 + cw, midY: r.midY, width: lw + 1)
        // the chevron points up while they show (.sbfold .ico rotated), down when hidden
        ctx.saveGState()
        ctx.translateBy(x: r.maxX - 10 - 5.5, y: r.midY)
        if !fold { ctx.scaleBy(x: 1, y: -1) }
        Icons.stroke(SectionActs.chev, scale: 11 / 16, at: CGPoint(x: -5.5, y: -5.5), color: ink, in: ctx)
        ctx.restoreGState()
      case .clear:
        plate(r)
        Drawing.text(ctx, "Clear", act, ink, x: r.minX + 10, midY: r.midY, width: r.width - 20 + 1)
      case .columns(_, let k):
        if k == 1 { plate(CGRect(x: r.minX - 2, y: r.minY - 2, width: 49, height: 26)) }
        if k == columns {
          ctx.addPath(Drawing.squircle(r, 9))
          ctx.setFillColor(t.accent.copy(alpha: 0.09) ?? t.hlrow)
          ctx.fillPath()
        }
        let icon = SVGPath.parse(k == 2 ? "M2.5 2.5h4.5v11h-4.5zM9 2.5h4.5v11h-4.5z" : "M5.5 2.5h5v11h-5z")
        let color = k == columns || part == lit ? t.ink : t.ink3
        Icons.stroke(icon, scale: 12 / 16, at: CGPoint(x: r.midX - 6, y: r.midY - 6), color: color, in: ctx)
      case .close, .preview: break
      }
    }
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

import AppKit
import CodeBoardModel

// Where Add Sidenote is (web board actions/notes.ts openAddNote, addSidenoteUI; menus.ts cardItems, lineItems,
// canvasMenu, sectionMenu): the first item of a card's menu (on the lines selected on it, else the Note's block under the
// pointer, else the whole card), of a Section's and of the empty board's (free where it was asked); S; and the + by the
// last of the lines selected in a code card's line numbers. Each opens the popup of what it goes on, its input ready.
// Lines are selected by their numbers (⇧ to extend), as on the web board; a free marker is dragged to another point, or
// onto a card or a Note's block, which then has it.

extension CanvasView {
  /// The popup of what a new sidenote goes on, its input ready (on lines: their Highlight's, or theirs alone when they
  /// are in none)
  func openAddNote(_ at: PopAt, ask: Bool = false) {
    var to = at
    if case .lines(let l) = at, let scene, let h = shownHighlight(l, in: scene) {
      to = .lines(Lines(card: l.card, segment: l.segment, range: h))
    }
    openPop(to, write: true, ask: ask)
  }

  /// S: on the lines selected; on the one card selected (a Note: the block under the pointer); on the one Section
  /// selected; else free where the pointer is
  func addSidenoteFromKey() {
    guard let doc = document else { return }
    if let l = lineSel { return openAddNote(.lines(l)) }
    let pointer = window.map { camera.board(convert($0.mouseLocationOutsideOfEventStream, from: nil)) }
    let sel = doc.selection
    if sel.count == 1, case .card(let c)? = sel.first {
      return openAddNote(.spot(pointer.flatMap { blockAt($0, of: c) }.map { .block(c, $0) } ?? .card(c)))
    }
    if sel.count == 1, case .section(let s)? = sel.first { return openAddNote(.spot(.section(s))) }
    let p = pointer ?? camera.board(CGPoint(x: bounds.midX, y: bounds.midY))
    openAddNote(.spot(.point(x: p.x.rounded(), y: p.y.rounded())))
  }

  /// The Add Sidenote item that starts a card's menu (or the lines' when some are selected on it)
  func addNoteItem(card c: CardID, at p: CGPoint) -> NSMenuItem {
    let at: PopAt =
      if let l = lineSel, l.card == c { .lines(l) } else if let b = blockAt(p, of: c) { .spot(.block(c, b)) } else {
        .spot(.card(c))
      }
    return addNoteItem(at)
  }

  func addNoteItem(_ at: PopAt) -> NSMenuItem {
    let i = menuItem("Add Sidenote") { [weak self] in self?.openAddNote(at) }
    i.keyEquivalent = "s"
    i.keyEquivalentModifierMask = []
    return i
  }

  /// The Note's block under a board point (a Note measured with its blocks)
  func blockAt(_ p: CGPoint, of c: CardID) -> BlockRef? {
    guard let placed = scene?.placed[c], let bs = placed.blocks, !placed.folded else { return nil }
    let y = p.y - placed.rect.minY
    guard let k = bs.firstIndex(where: { y >= $0.y - 4 && y < $0.y + $0.h + 4 }) else { return nil }
    return BlockRef(index: k, hash: bs[k].sig)
  }

  // MARK: Lines selected

  /// A press on a code card's line numbers selects that line (⇧: from the lines selected to it), and the card
  func selectLine(at p: CGPoint, extend: Bool) -> Bool {
    guard let doc = document, let c = hitCard(p), let placed = scene?.placed[c], let code = placed.code,
      p.x - placed.rect.minX < code.layout.gutter, let line = codeLine(at: p, of: c)?.end,
      let seg = line.segment, let n = line.line
    else { return false }
    if extend, let l = lineSel, l.card == c, l.segment == seg {
      lineSel = Lines(card: c, segment: seg, range: min(l.range.lowerBound, n)...max(l.range.upperBound, n))
    } else {
      lineSel = Lines(card: c, segment: seg, range: n...n)
    }
    if doc.selection != [.card(c)] { doc.select([.card(c)]) }
    placeMarks()
    return true
  }

  /// The code line under a board point selected for a right-click (kept when it is in the lines selected)
  func lineForMenu(at p: CGPoint, of c: CardID) {
    guard let line = codeLine(at: p, of: c)?.end, let seg = line.segment, let n = line.line else { return }
    if let l = lineSel, l.card == c, l.segment == seg, l.range.contains(n) { return }
    lineSel = Lines(card: c, segment: seg, range: n...n)
    placeMarks()
  }

  func clearLineSel() {
    guard lineSel != nil else { return }
    lineSel = nil
    placeMarks()
  }

  /// The lines selected: one rounded run with a Highlight band's geometry, a deeper fill (.lselb: from 4 left of the
  /// code to 14 short of the card's right edge, radius 6, the accent at 15 %, 20 % dark)
  func lineSelLayers(boxes: [Scene.Owner: CALayer]) -> [(CALayer, CALayer)] {
    guard let l = lineSel, let scene, let box = boxes[.card(l.card)], let code = scene.placed[l.card]?.code,
      case .code(let card)? = scene.parts[l.card]?.content.body,
      let si = card.segments.firstIndex(where: { $0.id == l.segment })
    else { return [] }
    let rows = l.range.compactMap { code.layout.row(segment: si, line: $0) }
    guard let first = rows.first, let last = rows.last else { return [] }
    let band = CALayer()
    let x = code.layout.gutter - 4
    band.frame = CGRect(
      x: x, y: code.top + first.y, width: box.bounds.width - 14 - x, height: last.y + last.height - first.y)
    band.cornerRadius = 6
    band.backgroundColor = theme.accent.copy(alpha: theme.dark ? 0.2 : 0.15)
    band.zPosition = 3
    return [(band, box)]
  }

  // MARK: A free marker dragged

  /// Where a free marker dragged to a board point would go: a card under it (a Note's block when over one), else the
  /// point
  func freeDrop(at p: CGPoint) -> Spot {
    if let c = hitCard(p) {
      if let b = blockAt(p, of: c) { return .block(c, b) }
      return .card(c)
    }
    return .point(x: p.x.rounded(), y: p.y.rounded())
  }

  /// The drag of a free marker: it follows the pointer (its layer only); what it would land on is tinted
  func dragMark(_ i: Int, to p: CGPoint) {
    guard i < marks.count, i < markLayers.count, case .spot(.point) = marks[i].at else { return }
    if openPop == marks[i].at { openPop(nil) }
    let l = markLayers[i]
    let spot = freeDrop(at: p)
    withoutAnimation {
      l.position = p
      dropAim?.removeFromSuperlayer()
      dropAim = aimLayer(spot)
    }
  }

  /// Let go: the marker's sidenotes go where it is
  func dropMark(_ i: Int, at p: CGPoint) {
    withoutAnimation {
      dropAim?.removeFromSuperlayer()
      dropAim = nil
    }
    guard let doc = document, i < marks.count, case .spot(.point) = marks[i].at else { return }
    let spot = freeDrop(at: p)
    let ids = Set(marks[i].notes)
    doc.edit("Move Sidenote") { $0.moveFreeSidenotes(ids, to: spot) }
    // nothing changed (let go where it was): back in its place
    placeMarks()
  }

  /// What a dragged free marker would land on, tinted: a card's paper ringed in the accent, or the Note's block (.sntint)
  func aimLayer(_ s: Spot) -> CALayer? {
    guard let scene else { return nil }
    let t = theme
    let l = CALayer()
    switch s {
    case .card(let c):
      guard let r = scene.items.first(where: { $0.owner == .card(c) })?.rect else { return nil }
      l.frame = r.insetBy(dx: -3, dy: -3)
      l.cornerRadius = 10
      l.borderColor = t.accent
      l.borderWidth = 2 / camera.zoom
    case .block(let c, let b):
      guard let r = scene.items.first(where: { $0.owner == .card(c) })?.rect, let bs = scene.placed[c]?.blocks,
        let k = b.at(bs.map(\.sig)) ?? (b.index < bs.count ? b.index : nil)
      else { return nil }
      l.frame = CGRect(x: r.minX + 8, y: r.minY + bs[k].y - 4, width: r.width - 16, height: bs[k].h + 8)
      l.cornerRadius = 8
      l.backgroundColor = t.accent.copy(alpha: 0.1)
      l.borderColor = t.accent.copy(alpha: 0.22)
      l.borderWidth = 1
    default:
      return nil
    }
    l.zPosition = 6
    freeMarks.addSublayer(l)
    return l
  }
}

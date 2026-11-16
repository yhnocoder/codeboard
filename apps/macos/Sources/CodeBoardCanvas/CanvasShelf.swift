import AppKit
import CodeBoardModel
import CodeBoardNotes
import TreeSitterHighlight

// The Shelf (the web board's ui/ShelfPanel.tsx, actions/shelf.ts, Chrome.tsx's dock button, styles.css .shelf, .spk): a
// place to keep cards and Sections aside, off the board. The button at the bottom right, with how many entries there
// are, opens the panel at the top right; only the button or the panel's X close it. Each entry is a real picture of
// what was put in, in the order they were on the board. ⌥S, Move to Shelf or a drag onto the button or the panel puts
// things in; with the panel open they fly to their picture's place. A click on a picture shows it large beside the
// panel with Put Back; a drag out lets it go where it is dropped. Hovering a picture outlines where it would return.
// Putting back never zooms and moves the camera only as far as needed to show what came back.

/// An entry as the panel shows it: where its cards and Sections were, and their box (board units)
/// What a Put Back brings onto the board, to fly out once the board shows it (CanvasView.flyOut)
struct FlyOut {
  /// An entry's picture on screen: its box drawn at `k`, its top left at `at` (view points)
  struct Picture {
    var at: CGPoint
    var k: CGFloat
    var box: CGRect
  }
  var cards: [CardID]
  var sections: [SectionID]
  var from: Picture?
}

struct ShelfShown {
  var entry: ShelfEntry
  var cards: [(CardID, CGRect)]
  var frames: [CGRect]
  var box: CGRect

  init(_ e: ShelfEntry) {
    entry = e
    cards = e.cards.map { c in
      (c.id, CGRect(x: c.x, y: c.y, width: c.width, height: c.height ?? c.measuredHeight ?? 120))
    }
    frames = e.sections.map { CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height) }
    box = (cards.map(\.1) + frames).reduce(CGRect.null) { $0.union($1) }
  }

  /// The order the Shelf shows them in (shelfOrder): as the board is read, rows from the top (an entry whose top is
  /// above the middle of a row's first is in that row), each from the left
  static func order(_ all: [ShelfShown]) -> [ShelfShown] {
    let sorted = all.sorted { $0.box.minY != $1.box.minY ? $0.box.minY < $1.box.minY : $0.box.minX < $1.box.minX }
    var rows: [(mid: CGFloat, items: [ShelfShown])] = []
    for it in sorted {
      if let last = rows.last, it.box.minY < last.mid {
        rows[rows.count - 1].items.append(it)
      } else {
        rows.append((it.box.midY, [it]))
      }
    }
    return rows.flatMap { $0.items.sorted { $0.box.minX < $1.box.minX } }
  }

  /// Its picture's scale and size in a thumbnail 276 wide (.sthumb: 8 in, between 30 % and 75 % of its width tall)
  static let thumbWidth: CGFloat = 276
  var thumbScale: CGFloat {
    let w = Self.thumbWidth
    return min(0.6, (w - 16) / max(1, box.width), (0.75 * w - 16) / max(1, box.height))
  }
  var thumbHeight: CGFloat {
    let w = Self.thumbWidth
    return min(max(0.3 * w, 16 + box.height * thumbScale), 0.75 * w).rounded()
  }
}

extension CanvasView {
  /// The height of the bottom toolbar's band, which put-back cards are kept clear of
  var toolbarBand: CGFloat { theme.id == .inkWash ? 58 : 48 }

  /// The board as it is seen: the view less the open panel and the bottom toolbar, in board units
  var seenArea: CGRect {
    var v = bounds
    if let p = shelfPanel { v.size.width = max(0, p.frame.minX - v.minX) }
    v.size.height -= toolbarBand
    let z = camera.zoom
    return CGRect(origin: camera.board(v.origin), size: CGSize(width: v.width / z, height: v.height / z))
  }

  /// The entries, in the panel's order
  var shelfShown: [ShelfShown] { ShelfShown.order((document?.board.shelf ?? []).map(ShelfShown.init)) }

  /// The board changed: the button's count, the panel's pictures
  func shelfChanged() {
    dock.isHidden = document == nil
    guard let doc = document else { return closeShelf() }
    if !dock.theme.same(as: theme) {
      dock.theme = theme
      if shelfPanel != nil {
        closeShelf()
        toggleShelf()
        return
      }
    }
    dock.count = doc.board.shelf.count
    placeShelf()
    if let p = shelfPanel {
      let shown = shelfShown
      p.show(shown)
      for s in shown { thumbnail(s) }
      if let id = previewing, !shown.contains(where: { $0.entry.id == id }) { closePreview() }
    }
  }

  /// The dock at the bottom right, the panel at the top right, the large picture by its thumbnail
  func placeShelf() {
    let s = dock.size
    let f = CGRect(x: bounds.width - 12 - s.width, y: bounds.height - 12 - s.height, width: s.width, height: s.height)
    if dock.frame != f { dock.frame = f }
    if let p = shelfPanel {
      let h = min(p.wantedHeight, min(0.76 * bounds.height, 700))
      p.frame = CGRect(x: bounds.width - 12 - ShelfPanel.width, y: 12, width: ShelfPanel.width, height: h)
    }
    if previewing != nil { placePreview() }
  }

  // MARK: The panel

  /// The button clicked: the panel opens, or closes
  package func toggleShelf() {
    if shelfPanel != nil { return closeShelf() }
    let p = ShelfPanel(theme: theme)
    p.onClose = { [weak self] in self?.closeShelf() }
    p.onClickThumb = { [weak self] id in self?.togglePreview(id) }
    p.onHoverThumb = { [weak self] id in self?.showHome(id) }
    p.onDragThumb = { [weak self] id, phase, at, grab in self?.dragOut(id, phase, at: at, grab: grab) }
    p.onMenu = { [weak self] id in self?.thumbMenu(id) }
    p.onBlank = { [weak self] in self?.closePreview() }
    addSubview(p)
    shelfPanel = p
    dock.open = true
    shelfChanged()
  }

  package func closeShelf() {
    closePreview()
    showHome(nil)
    shelfPanel?.removeFromSuperview()
    shelfPanel = nil
    dock.open = false
  }

  /// An entry's picture: drawn as the board draws it, once for what it holds in this look
  func thumbnail(_ s: ShelfShown) {
    let key = ShelfPictureKey(entry: s.entry, look: theme.id, dark: theme.dark)
    if let have = shelfPictures[s.entry.id], have.key == key {
      shelfPanel?.picture(s.entry.id, have.image)
      return
    }
    picture(s, scale: s.thumbScale * backing) { [weak self] img in
      guard let self, let img else { return }
      shelfPictures[s.entry.id] = (key, img)
      shelfPanel?.picture(s.entry.id, img)
    }
  }

  /// What is in an entry drawn at `scale` pixels per board unit, off the main thread (Notes by the renderer)
  func picture(_ s: ShelfShown, scale: CGFloat, done: @escaping (CGImage?) -> Void) {
    guard let (vb, vault) = shown, let doc = document else { return done(nil) }
    let e = s.entry
    let ids = Set(e.cards.map(\.id))
    let mini = Board(
      id: doc.board.id, cards: e.cards,
      arrows: e.arrows.filter { ids.contains($0.from.card) && ids.contains($0.to.card) },
      sections: e.sections, stickers: e.stickers)
    let t = theme
    let display = display
    let highlighter = CanvasView.highlighter ?? Highlighter()
    let package = vault.url(of: vb.path)
    let rect = s.box.insetBy(dx: -2, dy: -2)
    Task {
      let r = await Picture.draw(
        board: mini, package: package, vault: vault, theme: t, highlighter: highlighter, display: display, rect: rect,
        scale: scale, backdrop: false)
      done(r.image)
    }
  }

  // MARK: Putting in

  /// Move to Shelf ⌥S, in a menu
  func shelfItem() -> NSMenuItem {
    let i = NSMenuItem(title: "Move to Shelf", action: #selector(moveToShelf(_:)), keyEquivalent: "s")
    i.keyEquivalentModifierMask = .option
    i.target = self
    return i
  }

  /// ⌥S, Move to Shelf: what is selected goes onto the Shelf
  @objc func moveToShelf(_ sender: Any?) {
    guard let doc = document else { return }
    shelve(
      cards: Set(doc.selection.compactMap(\.card)), sections: Set(doc.selection.compactMap(\.section)), offset: .zero)
  }

  /// These cards and Sections onto the Shelf as one entry, one step, flying to their picture (`offset`: how far a drag
  /// had moved them, board units)
  func shelve(cards: Set<CardID>, sections: Set<SectionID>, offset d: CGVector) {
    guard let doc = document, let scene else { return }
    let pick = doc.board.shelfPick(cards: cards, sections: sections)
    guard !pick.cards.isEmpty || !pick.sections.isEmpty else { return }
    var heights: [CardID: Double] = [:]
    var flights: [(CardID, Any?, CGRect)] = []
    let picked = Set(pick.cards)
    withoutAnimation {
      for (i, it) in scene.items.enumerated() where i < items.count {
        switch it.owner {
        case .card(let c)? where picked.contains(c):
          heights[c] = Double(it.rect.height)
          let r = it.rect.offsetBy(dx: d.dx, dy: d.dy)
          let z = camera.zoom
          flights.append(
            (
              c, items[i].rest.contents ?? items[i].held.contents,
              CGRect(origin: camera.view(r.origin), size: CGSize(width: r.width * z, height: r.height * z))
            ))
          items[i].box.isHidden = true
        case .sectionTitle(let s)? where pick.sections.contains(s):
          items[i].box.isHidden = true
        default: break
        }
      }
      // their Sections' frames, their arrows and stickers go at once too: nothing stays behind until the board is drawn
      for (i, f) in scene.frames.enumerated() where pick.sections.contains(f.id) {
        if let ls = self.sections.sublayers, i < ls.count { ls[i].isHidden = true }
      }
      var gone = Set<ArrowID>()
      for (i, a) in scene.arrows.enumerated() where i < arrowGroups.count {
        guard picked.contains(a.from) || picked.contains(a.to) else { continue }
        for l in arrowGroups[i] { l.isHidden = true }
        gone.insert(a.id)
      }
      for (i, s) in stickerSpots.enumerated() where i < stickerLayers.count {
        if s.owner.map(picked.contains) == true || s.arrow.map(gone.contains) == true {
          stickerLayers[i].isHidden = true
        }
      }
    }
    let id = Board.newID("sh")
    doc.edit("Move to Shelf") {
      $0.shelve(
        cards: cards, sections: sections, id: id, at: (Date().timeIntervalSince1970 * 1000).rounded(), heights: heights)
    }
    doc.select([])
    // with the panel closed only the button's count shows it (actions/shelf.ts told)
    if shelfPanel == nil {
      toast(
        pick.sections.isEmpty && pick.cards.count > 1 ? "Moved \(pick.cards.count) cards to Shelf" : "Moved to Shelf")
    }
    flyIn(id, flights)
  }

  /// What was put in flies to its picture in the open panel, or into the button (420 ms, cubic(.45, 0, .25, 1), seen
  /// until 72 % of the way)
  func flyIn(_ id: String, _ flights: [(CardID, Any?, CGRect)]) {
    guard let root = layer else { return }
    var targets: [CardID: CGRect] = [:]
    if let p = shelfPanel, let s = shelfShown.first(where: { $0.entry.id == id }), let pic = p.pictureRect(id) {
      let r = p.convert(pic, to: self)
      let k = s.thumbScale
      let o = CGPoint(x: r.midX - s.box.width * k / 2, y: r.midY - s.box.height * k / 2)
      for (c, cr) in s.cards {
        targets[c] = CGRect(
          x: o.x + (cr.minX - s.box.minX) * k, y: o.y + (cr.minY - s.box.minY) * k, width: cr.width * k,
          height: cr.height * k)
      }
      p.fadeIn(id, after: Self.flyTime * 0.72)
    } else if let r = shelfButton {
      let c = CGPoint(x: r.midX, y: r.midY)
      for (cid, _, _) in flights { targets[cid] = CGRect(x: c.x - 7, y: c.y - 7, width: 14, height: 14) }
      dock.bump(after: Self.flyTime * 0.85)
    }
    let ease = CAMediaTimingFunction(controlPoints: 0.45, 0, 0.25, 1)
    for (c, contents, from) in flights {
      guard let to = targets[c] else { continue }
      let l = CALayer()
      l.contents = contents
      l.contentsGravity = .resize
      l.frame = to
      l.opacity = 0
      l.zPosition = 50
      root.addSublayer(l)
      let move = CABasicAnimation(keyPath: "position")
      move.fromValue = CGPoint(x: from.midX, y: from.midY)
      move.toValue = CGPoint(x: to.midX, y: to.midY)
      let size = CABasicAnimation(keyPath: "bounds.size")
      size.fromValue = from.size
      size.toValue = to.size
      for a in [move, size] { a.timingFunction = ease }
      let fade = CAKeyframeAnimation(keyPath: "opacity")
      fade.values = [1, 1, 0]
      fade.keyTimes = [0, 0.72, 1]
      let g = CAAnimationGroup()
      g.animations = [move, size, fade]
      g.duration = Self.flyTime
      l.add(g, forKey: "fly")
      shelfFlights.append(l)
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.flyTime) { [weak self, weak l] in
        l?.removeFromSuperlayer()
        self?.shelfFlights.removeAll { $0 === l }
      }
    }
  }

  static let flyTime: CFTimeInterval = 0.42

  /// The Shelf's button in the dock, in this view
  package var shelfButton: CGRect? { dock.isHidden ? nil : dock.rect(.shelf).map { dock.convert($0, to: self) } }

  /// A drag of cards over the Shelf's button or the open panel: they would go onto the Shelf
  func overShelf(_ v: CGPoint) -> Bool {
    (shelfButton?.contains(v) ?? false) || (shelfPanel?.frame.contains(v) ?? false)
  }

  /// The button and the panel while cards are dragged: armed, lit when the pointer is over them
  func armShelf(_ v: CGPoint?) {
    let hot = v.map(overShelf) ?? false
    dock.armed = v != nil
    dock.hot = hot
    shelfPanel?.hot = hot
  }

  // MARK: Taking out

  /// Put Back: the entry where it was, its cards in front and selected; the camera pans only to show it
  package func putBack(_ id: String) {
    guard let doc = document, let s = shelfShown.first(where: { $0.entry.id == id }) else { return }
    let from = pictureOf(s)
    closePreview()
    showHome(nil)
    var back: (cards: [CardID], sections: [SectionID])?
    doc.edit("Put Back") { back = $0.unshelve(id) }
    if let back {
      select(back)
      flyingOut = FlyOut(cards: back.cards, sections: back.sections, from: from)
    }
    reveal(put: s.box)
  }

  /// Where an entry's picture is in this view (its box drawn at `k` with its top left at `at`): the large one, else its
  /// thumbnail, else one the size of the dock's Shelf button on it (actions/shelf.ts pictureOf, dockPicture)
  func pictureOf(_ s: ShelfShown) -> FlyOut.Picture? {
    if previewing == s.entry.id, let v = shelfPreview {
      let r = v.convert(v.bounds.insetBy(dx: 12, dy: 12), to: self)
      return FlyOut.Picture(at: r.origin, k: r.width / s.box.width, box: s.box)
    }
    let k: CGFloat
    let c: CGPoint
    if let p = shelfPanel, let pic = p.pictureRect(s.entry.id) {
      let r = p.convert(pic, to: self)
      (k, c) = (s.thumbScale, CGPoint(x: r.midX, y: r.midY))
    } else if let r = shelfButton {
      (k, c) = (14 / max(s.box.width, s.box.height), CGPoint(x: r.midX, y: r.midY))
    } else {
      return nil
    }
    return FlyOut.Picture(
      at: CGPoint(x: c.x - s.box.width * k / 2, y: c.y - s.box.height * k / 2), k: k, box: s.box)
  }

  /// What came back flies out of its picture (`from`), or grows where it was dropped; the arrows to the rest of the
  /// board fade in as it lands (actions/shelf.ts flyOut). Run on the scene that first shows it, before it is drawn
  func flyOut(_ f: FlyOut) {
    guard let s = scene else { return }
    let cards = Set(f.cards)
    let ease = CAMediaTimingFunction(controlPoints: 0.2, 0.7, 0.25, 1)
    func fly(_ l: CALayer, _ r: CGRect, card: Bool) {
      var parts: [CAAnimation] = []
      let scale = CABasicAnimation(keyPath: "transform.scale")
      let opacity = CABasicAnimation(keyPath: "opacity")
      if let from = f.from {
        let at = CGPoint(
          x: from.at.x + (r.midX - from.box.minX) * from.k, y: from.at.y + (r.midY - from.box.minY) * from.k)
        let move = CABasicAnimation(keyPath: "position")
        move.fromValue = camera.board(at)
        move.toValue = l.position
        parts.append(move)
        scale.fromValue = from.k / camera.zoom
        opacity.fromValue = Float(0.9)
      } else {
        scale.fromValue = CGFloat(0.96)
        opacity.fromValue = Float(0)
      }
      scale.toValue = CGFloat(1)
      opacity.toValue = Float(1)
      parts += [scale, opacity]
      // a card flies over the other cards
      if card {
        let over = CABasicAnimation(keyPath: "zPosition")
        (over.fromValue, over.toValue) = (CGFloat(60), CGFloat(60))
        parts.append(over)
      }
      let g = CAAnimationGroup()
      g.animations = parts
      g.duration = Self.flyTime
      g.timingFunction = ease
      l.add(g, forKey: "flyOut")
    }
    for (i, it) in s.items.enumerated() where i < items.count {
      switch it.owner {
      case .card(let c)? where cards.contains(c): fly(items[i].box, it.rect, card: true)
      case .sectionTitle(let g)? where f.sections.contains(g): fly(items[i].box, it.rect, card: false)
      default: break
      }
    }
    for (i, fr) in s.frames.enumerated() where f.sections.contains(fr.id) {
      if let ls = sections.sublayers, i < ls.count { fly(ls[i], fr.rect, card: false) }
    }
    for (i, a) in s.arrows.enumerated() where i < arrowGroups.count && (cards.contains(a.from) || cards.contains(a.to))
    {
      for l in arrowGroups[i] {
        let fade = CAKeyframeAnimation(keyPath: "opacity")
        fade.values = [Float(0), 0, 1]
        fade.keyTimes = [0, 0.75, 1]
        fade.duration = Self.flyTime * 1.3
        l.add(fade, forKey: "fadeIn")
      }
    }
  }

  /// The camera, its zoom kept, moved just far enough for `box` to be seen with 24 points round it (seenArea); a box
  /// larger than what is seen is shown from its left or top. Nothing moves when it is seen whole already
  func reveal(put box: CGRect) {
    let seen = seenArea
    guard !seen.contains(box) else { return }
    let m = 24 / camera.zoom
    func shift(_ lo: CGFloat, _ hi: CGFloat, _ a: CGFloat, _ b: CGFloat) -> CGFloat {
      if b - a > hi - lo - 2 * m { return a - (lo + m) }
      let margin = min(m, (hi - lo - (b - a)) / 2)
      if a < lo + margin { return a - (lo + margin) }
      if b > hi - margin { return b - (hi - margin) }
      return 0
    }
    let dx = shift(seen.minX, seen.maxX, box.minX, box.maxX)
    let dy = shift(seen.minY, seen.maxY, box.minY, box.maxY)
    guard dx != 0 || dy != 0 else { return }
    motion.fly(to: Camera(origin: CGPoint(x: camera.origin.x + dx, y: camera.origin.y + dy), zoom: camera.zoom))
    moved()
  }

  /// A picture dragged out of the panel: a dashed outline of it at the pointer over the board; let go there, it lands
  /// there, joins the Section it lands in, and is selected; the camera stays
  func dragOut(_ id: String, _ phase: ShelfPanel.DragPhase, at window: CGPoint, grab: CGPoint) {
    guard let s = shelfShown.first(where: { $0.entry.id == id }) else { return }
    let v = convert(window, from: nil)
    let p = camera.board(v)
    let k = s.thumbScale
    let origin = CGPoint(x: p.x - grab.x / k, y: p.y - grab.y / k)
    let over = overShelf(v) || !bounds.contains(v)
    switch phase {
    case .moved:
      closePreview()
      showHome(nil)
      drawDragOutline(over ? nil : s, at: origin)
    case .ended:
      drawDragOutline(nil, at: .zero)
      guard !over, let doc = document else { return }
      let dx = (origin.x - s.box.minX).rounded()
      let dy = (origin.y - s.box.minY).rounded()
      var into: [String: SectionID] = [:]
      let own = Set(s.entry.sections.map(\.id))
      for (c, r) in s.cards where s.entry.cards.first(where: { $0.id == c })?.section.map(own.contains) != true {
        into[c.rawValue] = deepestSection(CGPoint(x: r.minX + dx + 16, y: r.minY + dy + 16))
      }
      for sec in s.entry.sections where sec.parent.map(own.contains) != true {
        into[sec.id.rawValue] = deepestSection(CGPoint(x: sec.x + dx + 16, y: sec.y + dy + 16))
      }
      var back: (cards: [CardID], sections: [SectionID])?
      doc.edit("Put Back") { back = $0.unshelve(id, dx: dx, dy: dy, into: into) }
      if let back {
        select(back)
        flyingOut = FlyOut(cards: back.cards, sections: back.sections, from: nil)
      }
    }
  }

  /// What came back selected: its Sections when it has any, else its cards (actions/shelf.ts putBack)
  private func select(_ back: (cards: [CardID], sections: [SectionID])) {
    document?.select(
      back.sections.isEmpty ? Set(back.cards.map(Item.card)) : Set(back.sections.map(Item.section)))
  }

  /// The dashed outline of an entry being dragged out: round it all, and round each card (board units)
  func drawDragOutline(_ s: ShelfShown?, at origin: CGPoint) {
    withoutAnimation {
      shelfDrag.sublayers = nil
      guard let s else { return }
      let z = camera.zoom
      let d = CGVector(dx: origin.x - s.box.minX, dy: origin.y - s.box.minY)
      let outer = CAShapeLayer()
      let o = s.box.offsetBy(dx: d.dx, dy: d.dy).insetBy(dx: -6, dy: -6)
      outer.path = CGPath(roundedRect: o, cornerWidth: 10, cornerHeight: 10, transform: nil)
      outer.fillColor = theme.accent.copy(alpha: 0.06)
      outer.strokeColor = theme.accent
      outer.lineWidth = 1.5 / z
      outer.lineDashPattern = [NSNumber(value: 4 / z), NSNumber(value: 3 / z)]
      shelfDrag.addSublayer(outer)
      for (_, r) in s.cards {
        let l = CAShapeLayer()
        l.path = CGPath(
          roundedRect: r.offsetBy(dx: d.dx, dy: d.dy), cornerWidth: 8, cornerHeight: 8, transform: nil)
        l.fillColor = nil
        l.strokeColor = theme.accent.copy(alpha: 0.6)
        l.lineWidth = 1 / z
        l.lineDashPattern = [NSNumber(value: 3 / z), NSNumber(value: 3 / z)]
        shelfDrag.addSublayer(l)
      }
    }
  }

  /// A picture hovered: where it would return, outlined on the board at its real size, when any of that is seen
  package func showHome(_ id: String?) {
    let s = id.flatMap { id in shelfShown.first { $0.entry.id == id } }
    shelfHovered = s?.entry.id
    withoutAnimation {
      shelfHome.sublayers = nil
      guard let s, s.box.intersects(seenArea) else { return }
      let z = camera.zoom
      for r in s.frames + s.cards.map(\.1) {
        let l = CAShapeLayer()
        l.path = CGPath(roundedRect: r, cornerWidth: 8, cornerHeight: 8, transform: nil)
        l.fillColor = theme.accent.copy(alpha: 0.05)
        l.strokeColor = theme.accent.copy(alpha: 0.55)
        l.lineWidth = 1.5 / z
        shelfHome.addSublayer(l)
      }
    }
    if s != nil, !shelfHome.sublayers.isNilOrEmpty {
      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 0
      fade.toValue = 1
      fade.duration = 0.14
      shelfHome.add(fade, forKey: "in")
    }
  }

  /// A picture's menu: Put Back, Remove
  func thumbMenu(_ id: String) -> NSMenu {
    let m = NSMenu()
    m.addItem(menuItem("Put Back") { [weak self] in self?.putBack(id) })
    m.addItem(.separator())
    let remove = menuItem("Remove") { [weak self] in
      self?.closePreview()
      self?.document?.edit("Remove from Shelf") { $0.removeShelfEntry(id) }
      self?.toast("Removed from Shelf")
    }
    remove.toolTip = "Delete it and what is in it"
    m.addItem(remove)
    return m
  }

  // MARK: The large picture

  /// A picture clicked: the entry large beside the panel, or closed when it shows already
  package func togglePreview(_ id: String) {
    if previewing == id { return closePreview() }
    closePreview()
    guard let s = shelfShown.first(where: { $0.entry.id == id }) else { return }
    previewing = id
    let v = ShelfPreview(theme: theme)
    v.onPutBack = { [weak self] in self?.putBack(id) }
    addSubview(v)
    shelfPreview = v
    shelfPanel?.lit = id
    placePreview()
    // until its own picture comes, the thumbnail's
    if let have = shelfPictures[id] { v.image = have.image }
    picture(s, scale: v.scale * backing) { [weak self, weak v] img in
      guard self?.previewing == id, let img else { return }
      v?.image = img
    }
  }

  /// A shelved entry shown without taking it out (⌘K picking a card in it, a ref arriving at one): the panel opened,
  /// its thumbnail scrolled to and ringed, the entry large beside it as a click on the thumbnail shows it; the board is
  /// not edited, and it goes as that does (Esc, a press on the board, closing the Shelf)
  package func showShelved(_ id: String) {
    guard shelfShown.contains(where: { $0.entry.id == id }) else { return }
    if shelfPanel == nil { toggleShelf() }
    if previewing != id { togglePreview(id) }
    if let t = shelfPanel?.thumbs[id] { t.scrollToVisible(t.bounds) }
  }

  package func closePreview() {
    previewing = nil
    shelfPreview?.removeFromSuperview()
    shelfPreview = nil
    shelfPanel?.lit = nil
  }

  /// Left of the panel, level with its thumbnail, never over the panel or the toolbar (styles.css .spk): or under the
  /// panel when the window is too narrow for it to be larger there
  func placePreview() {
    guard let id = previewing, let v = shelfPreview, let p = shelfPanel,
      let s = shelfShown.first(where: { $0.entry.id == id }), let thumb = p.thumbRect(id)
    else { return }
    let t = p.convert(thumb, to: self)
    let pad: CGFloat = 12
    let bottom = bounds.height - toolbarBand - 10
    func scale(_ w: CGFloat, _ h: CGFloat) -> CGFloat {
      max(
        0.01, min(0.8, 560 / s.box.width, 460 / s.box.height, (w - 2 * pad) / s.box.width, (h - 2 * pad) / s.box.height)
      )
    }
    let leftW = p.frame.minX - 10 - 8
    let leftH = bottom - 8
    let underW = bounds.width - 16
    let underH = bottom - (p.frame.maxY + 10)
    let left = scale(leftW, leftH)
    let under = underH > 40 ? scale(underW, underH) : 0
    var k = left
    var frame: CGRect
    if under > left {
      k = under
      let size = CGSize(width: s.box.width * k + 2 * pad, height: s.box.height * k + 2 * pad)
      frame = CGRect(
        origin: CGPoint(x: min(p.frame.maxX - size.width, bounds.width - 8 - size.width), y: p.frame.maxY + 10),
        size: size)
    } else {
      let size = CGSize(width: s.box.width * k + 2 * pad, height: s.box.height * k + 2 * pad)
      let y = min(max(8, t.minY), bottom - size.height)
      frame = CGRect(origin: CGPoint(x: p.frame.minX - 10 - size.width, y: y), size: size)
    }
    frame.origin.x = max(8, frame.origin.x)
    v.scale = k
    v.frame = frame
  }
}

extension Optional where Wrapped: Collection {
  var isNilOrEmpty: Bool { self?.isEmpty ?? true }
}

/// What an entry's picture was drawn from
package struct ShelfPictureKey: Equatable {
  var entry: ShelfEntry
  var look: Theme.ID
  var dark: Bool
}

// MARK: Views

/// The look the Shelf's floating things share: Warm Ink's glass tint with its float shadow, Ink Wash's paper
@MainActor enum ShelfLook {
  static func glass(_ l: CALayer, _ t: Theme, radius: CGFloat) {
    l.cornerRadius = t.id == .inkWash ? 2 : radius
    l.backgroundColor =
      t.id == .inkWash
      ? t.surface
      : t.dark
        ? CGColor(srgbRed: 42 / 255, green: 41 / 255, blue: 38 / 255, alpha: 0.96)
        : CGColor(srgbRed: 252 / 255, green: 250 / 255, blue: 246 / 255, alpha: 0.96)
    l.borderWidth = 0.5
    l.borderColor = t.hair
    l.shadowColor = CGColor(gray: 0, alpha: 1)
    l.shadowOpacity = t.dark ? 0.3 : 0.1
    l.shadowRadius = 7
    l.shadowOffset = CGSize(width: 0, height: 4)
  }

  static func icon(_ d: String, size: CGFloat, color: CGColor) -> CAShapeLayer {
    let l = CAShapeLayer()
    let k = size / 16
    var t = CGAffineTransform(scaleX: k, y: k)
    l.path = SVGPath.parse(d).copy(using: &t)
    l.fillColor = nil
    l.strokeColor = color
    l.lineWidth = 1.3
    l.lineCap = .round
    l.lineJoin = .round
    l.bounds = CGRect(x: 0, y: 0, width: size, height: size)
    return l
  }

  /// icons.tsx shelf and place
  static let shelf =
    "M2.5 2H13.5A.5 .5 0 0 1 14 2.5V4.5A.5 .5 0 0 1 13.5 5H2.5A.5 .5 0 0 1 2 4.5V2.5A.5 .5 0 0 1 2.5 2zM3 5V13.5A.5 .5 0 0 0 3.5 14H12.5A.5 .5 0 0 0 13 13.5V5M6 8h4"
  static let place =
    "M2.5 3H13.5A.5 .5 0 0 1 14 3.5V12.5A.5 .5 0 0 1 13.5 13H2.5A.5 .5 0 0 1 2 12.5V3.5A.5 .5 0 0 1 2.5 3zM5 7h6M5 10h4"
}

/// The panel at the top right (ShelfPanel.tsx .shelf): "Shelf" and the count, its X, and a picture of each entry
package final class ShelfPanel: NSView {
  enum DragPhase {
    case moved
    case ended
  }

  static let width: CGFloat = 300
  static let header: CGFloat = 34
  static let empty =
    "Nothing on the Shelf. Right-click a card or Section → Move to Shelf, or drag it onto the Shelf button."
  var onClose: (() -> Void)?
  var onClickThumb: ((String) -> Void)?
  var onHoverThumb: ((String?) -> Void)?
  /// A picture dragged: the pointer in the window, where in the picture it was pressed (picture points)
  var onDragThumb: ((String, DragPhase, CGPoint, CGPoint) -> Void)?
  var onMenu: ((String) -> NSMenu?)?
  var onBlank: (() -> Void)?
  let theme: Theme
  /// The entries shown, in order, and their thumbnails
  package private(set) var ids: [String] = []
  package private(set) var thumbs: [String: ShelfThumb] = [:]
  private let face = CALayer()
  private let title = CATextLayer()
  private let close = CAShapeLayer()
  private let emptyText = CATextLayer()
  private let scroll = NSScrollView()
  private let list = FlippedView()
  /// Cards dragged over it: a ring of the accent round it
  var hot = false {
    didSet { if hot != oldValue { draw() } }
  }
  /// The entry shown large: its thumbnail ringed
  var lit: String? {
    didSet { for (id, t) in thumbs { t.lit = id == lit } }
  }

  init(theme: Theme) {
    self.theme = theme
    super.init(frame: CGRect(x: 0, y: 0, width: Self.width, height: 120))
    wantsLayer = true
    layer?.addSublayer(face)
    for l in [title, emptyText] {
      l.contentsScale = 2
      face.addSublayer(l)
    }
    face.addSublayer(close)
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.documentView = list
    addSubview(scroll)
    draw()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("ShelfPanel is not loaded from nibs") }

  package override var isFlipped: Bool { true }

  /// Its height for what it shows (before the window's limit)
  var wantedHeight: CGFloat { Self.header + listHeight + 6 }
  private var listHeight: CGFloat = 40

  /// These entries, in this order: new thumbnails made, gone ones dropped, the rest slide to their places
  func show(_ shown: [ShelfShown]) {
    let wanted = Set(shown.map(\.entry.id))
    for (id, t) in thumbs where !wanted.contains(id) {
      t.removeFromSuperview()
      thumbs[id] = nil
    }
    var y: CGFloat = 2
    var moves: [(ShelfThumb, CGRect)] = []
    for s in shown {
      let f = CGRect(x: 8, y: y, width: ShelfShown.thumbWidth, height: s.thumbHeight)
      if let t = thumbs[s.entry.id] {
        if t.frame != f { moves.append((t, f)) }
        t.shown = s
      } else {
        let t = ShelfThumb(theme: theme, shown: s)
        t.frame = f
        t.owner = self
        list.addSubview(t)
        thumbs[s.entry.id] = t
      }
      y += s.thumbHeight + 8
    }
    if !moves.isEmpty {
      NSAnimationContext.runAnimationGroup { c in
        c.duration = 0.26
        c.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.7, 0.25, 1)
        for (t, f) in moves { t.animator().frame = f }
      }
    }
    ids = shown.map(\.entry.id)
    listHeight = shown.isEmpty ? 40 : y - 8 + 6
    list.frame = CGRect(x: 0, y: 0, width: Self.width - 8, height: listHeight)
    title.string = shown.isEmpty ? "Shelf" : "Shelf"
    draw()
    (superview as? CanvasView)?.placeShelf()
  }

  func picture(_ id: String, _ img: CGImage) { thumbs[id]?.image = img }

  /// A thumbnail's rect, and its picture's, in this view
  func thumbRect(_ id: String) -> CGRect? { thumbs[id].map { convert($0.bounds, from: $0) } }
  func pictureRect(_ id: String) -> CGRect? { thumbRect(id)?.insetBy(dx: 8, dy: 8) }

  /// What flies to a new thumbnail shows there at the end
  func fadeIn(_ id: String, after delay: CFTimeInterval) {
    guard let t = thumbs[id]?.layer else { return }
    t.opacity = 1
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = 0
    a.toValue = 1
    a.duration = 0.12
    a.beginTime = CACurrentMediaTime() + delay
    a.fillMode = .backwards
    t.add(a, forKey: "in")
  }

  package override func layout() {
    super.layout()
    draw()
  }

  private func draw() {
    let t = theme
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    face.frame = bounds
    ShelfLook.glass(face, t, radius: 14)
    if hot {
      face.borderWidth = 2
      face.borderColor = t.accent
    }
    let count = ids.isEmpty ? "" : "  \(ids.count)"
    let s = NSMutableAttributedString(
      string: "Shelf",
      attributes: [.font: NSFont.systemFont(ofSize: 12.5, weight: .bold), .foregroundColor: NSColor(cgColor: t.ink)!])
    s.append(
      NSAttributedString(
        string: count,
        attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor(cgColor: t.ink3)!]))
    title.string = s
    title.frame = CGRect(x: 12, y: 10, width: bounds.width - 60, height: 18)
    let x = CGMutablePath()
    let c = CGPoint(x: bounds.width - 4 - 11 - 4, y: Self.header / 2)
    x.move(to: CGPoint(x: c.x - 4, y: c.y - 4))
    x.addLine(to: CGPoint(x: c.x + 4, y: c.y + 4))
    x.move(to: CGPoint(x: c.x + 4, y: c.y - 4))
    x.addLine(to: CGPoint(x: c.x - 4, y: c.y + 4))
    close.path = x
    close.strokeColor = t.ink2
    close.lineWidth = 1.3
    close.lineCap = .round
    emptyText.isHidden = !ids.isEmpty
    emptyText.string = NSAttributedString(
      string: Self.empty,
      attributes: [.font: NSFont.systemFont(ofSize: 11.5), .foregroundColor: NSColor(cgColor: t.ink3)!])
    // .cpanel .empty.sm: 6 by 8 in from the list, wrapped
    emptyText.isWrapped = true
    emptyText.frame = CGRect(x: 12, y: Self.header + 6, width: bounds.width - 24, height: 48)
    CATransaction.commit()
    scroll.frame = CGRect(
      x: 4, y: Self.header, width: bounds.width - 8, height: max(0, bounds.height - Self.header - 6))
  }

  /// The X's rect
  var closeRect: CGRect { CGRect(x: bounds.width - 4 - 22 - 4, y: (Self.header - 22) / 2, width: 22, height: 22) }

  /// Pressed on the X: a click on it is a press and a release over it (main's <button>)
  private var down = false

  package override func mouseDown(with e: NSEvent) {
    down = closeRect.contains(convert(e.locationInWindow, from: nil))
  }
  package override func mouseUp(with e: NSEvent) {
    defer { down = false }
    let p = convert(e.locationInWindow, from: nil)
    if closeRect.contains(p) {
      if down { onClose?() }
    } else if !down {
      onBlank?()
    }
  }
  package override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class FlippedView: NSView {
  override var isFlipped: Bool { true }
}

/// One entry's picture in the panel (.sthumb): the canvas's paper under it, a hair round it, the accent round it while
/// it is shown large; faded while it is dragged out
package final class ShelfThumb: NSView {
  weak var owner: ShelfPanel?
  var shown: ShelfShown
  let theme: Theme
  private let pic = CALayer()
  package var image: CGImage? {
    didSet { pic.contents = image }
  }
  var lit = false {
    didSet { if lit != oldValue { draw() } }
  }
  private var hover = false {
    didSet { if hover != oldValue { draw() } }
  }
  private var press: CGPoint?
  private var dragging = false

  init(theme: Theme, shown: ShelfShown) {
    self.theme = theme
    self.shown = shown
    super.init(frame: .zero)
    wantsLayer = true
    pic.contentsGravity = .resizeAspect
    layer?.addSublayer(pic)
    draw()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("ShelfThumb is not loaded from nibs") }

  package override var isFlipped: Bool { true }

  package override func layout() {
    super.layout()
    draw()
  }

  private func draw() {
    let t = theme
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    guard let l = layer else { return CATransaction.commit() }
    l.cornerRadius = 7
    l.masksToBounds = false
    l.backgroundColor = t.canvas
    l.borderWidth = lit ? 1.5 : 1
    l.borderColor = lit ? t.accent : hover ? t.ink.copy(alpha: 0.3) : t.hair
    l.shadowColor = CGColor(gray: 0, alpha: 1)
    l.shadowOpacity = hover ? 0.12 : 0.08
    l.shadowRadius = hover ? 4 : 1.5
    l.shadowOffset = CGSize(width: 0, height: hover ? -2 : -1)
    l.opacity = dragging ? 0.35 : 1
    let k = shown.thumbScale
    let size = CGSize(width: (shown.box.width + 4) * k, height: (shown.box.height + 4) * k)
    pic.frame = CGRect(
      x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
    pic.cornerRadius = 4
    pic.masksToBounds = true
    CATransaction.commit()
  }

  package override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas where t.owner === self { removeTrackingArea(t) }
    addTrackingArea(
      NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
  }

  package override func mouseEntered(with e: NSEvent) {
    hover = true
    owner?.onHoverThumb?(shown.entry.id)
  }

  package override func mouseExited(with e: NSEvent) {
    hover = false
    owner?.onHoverThumb?(nil)
  }

  package override func mouseDown(with e: NSEvent) {
    press = convert(e.locationInWindow, from: nil)
    dragging = false
  }

  package override func mouseDragged(with e: NSEvent) {
    guard let p0 = press else { return }
    let p = convert(e.locationInWindow, from: nil)
    if !dragging, hypot(p.x - p0.x, p.y - p0.y) < 3 { return }
    if !dragging {
      dragging = true
      draw()
    }
    owner?.onDragThumb?(shown.entry.id, .moved, e.locationInWindow, grab)
  }

  package override func mouseUp(with e: NSEvent) {
    defer {
      press = nil
      dragging = false
      draw()
    }
    if dragging {
      owner?.onDragThumb?(shown.entry.id, .ended, e.locationInWindow, grab)
    } else if press != nil {
      owner?.onClickThumb?(shown.entry.id)
    }
  }

  /// Where in the picture it was pressed, from the picture's top left (picture points, the box's 2 margin less)
  private var grab: CGPoint {
    guard let p = press else { return .zero }
    let k = shown.thumbScale
    return CGPoint(x: p.x - pic.frame.minX - 2 * k, y: p.y - pic.frame.minY - 2 * k)
  }

  package override func menu(for e: NSEvent) -> NSMenu? { owner?.onMenu?(shown.entry.id) }
  package override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// An entry large beside the panel (.spk): its picture on the canvas's paper, and one button, Put Back
package final class ShelfPreview: NSView {
  var onPutBack: (() -> Void)?
  let theme: Theme
  var scale: CGFloat = 1
  private let pic = CALayer()
  private let button = CALayer()
  package var image: CGImage? {
    didSet { pic.contents = image }
  }

  init(theme: Theme) {
    self.theme = theme
    super.init(frame: .zero)
    wantsLayer = true
    pic.contentsGravity = .resizeAspect
    layer?.addSublayer(pic)
    layer?.addSublayer(button)
    let icon = ShelfLook.icon(ShelfLook.place, size: 14, color: theme.ink2)
    icon.position = CGPoint(x: 13, y: 13)
    button.addSublayer(icon)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("ShelfPreview is not loaded from nibs") }

  package override var isFlipped: Bool { true }

  /// The one button's rect (top right, 6 in)
  package var buttonRect: CGRect { CGRect(x: bounds.width - 6 - 26, y: 6, width: 26, height: 26) }

  package override func layout() {
    super.layout()
    let t = theme
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer?.cornerRadius = t.id == .inkWash ? 2 : 14
    layer?.backgroundColor = t.canvas
    layer?.borderWidth = 0.5
    layer?.borderColor = t.hair
    layer?.shadowColor = CGColor(gray: 0, alpha: 1)
    layer?.shadowOpacity = t.dark ? 0.35 : 0.14
    layer?.shadowRadius = 10
    layer?.shadowOffset = CGSize(width: 0, height: -6)
    pic.frame = bounds.insetBy(dx: 12, dy: 12)
    button.frame = buttonRect
    button.cornerRadius = 8.5
    button.backgroundColor = t.surface
    button.borderWidth = 1
    button.borderColor = t.hair
    CATransaction.commit()
  }

  /// Pressed on Put Back: a click on it is a press and a release over it (main's <button>)
  private var down = false

  package override func mouseDown(with e: NSEvent) {
    down = buttonRect.contains(convert(e.locationInWindow, from: nil))
  }
  package override func mouseUp(with e: NSEvent) {
    defer { down = false }
    if down, buttonRect.contains(convert(e.locationInWindow, from: nil)) { onPutBack?() }
  }
  package override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

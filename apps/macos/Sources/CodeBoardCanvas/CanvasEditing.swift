import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import QuartzCore

// Editing on the canvas, after the web board's interact.ts and gesture.ts with the Mac's conventions: select (click,
// ⇧/⌘-click, marquee, ⌘A, Esc), move (drag, arrow keys), resize (per kind), delete, copy, cut, paste, duplicate, stacking
// order, lock, tilt, and a context menu. Every change is a command on the board's document (BoardDocument), one undo step
// per gesture. While a gesture runs only layers move: nothing is redrawn, decoded, requested or swapped (the gesture
// rule); once it ends the scene is made again from the board, reusing every drawing that did not change
// (`refresh`), and what changed is drawn once, before it is swapped in, so nothing flashes or jumps.

/// A gesture under way, from the press to the release (or, for the arrow keys, the last key up)
struct Gesture {
  enum Kind {
    /// Pressed, not moved past the slop yet. item: what was pressed (nil: the canvas, or inside a Section, `inside`)
    case press(item: Item?, toggle: Bool, wasSelected: Bool, inside: SectionID?)
    case move(Move)
    case marquee(base: Set<Item>)
    case resize(Resize)
    /// Moving the selection with the arrow keys
    case nudge(Move)
    /// Pressed on something that cannot move (locked): nothing happens until the release
    case still
  }

  var kind: Kind
  /// Where it started, in the view's units and in board units
  var startView: CGPoint
  var start: CGPoint
}

/// What a move drags along, and how far it has gone (board units)
struct Move {
  var cards: Set<CardID>
  var sections: Set<SectionID>
  /// The dragged Sections not inside another dragged one: they get a new parent
  var tops: [SectionID]
  /// The dragged cards not in a dragged Section: they get a new home
  var loose: [CardID]
  /// What moves on screen: scene items (cards, Section titles), frames, arrows with an end on a moved card
  var items: [Int]
  var frames: [Int]
  var arrows: [Int]
  var d = CGVector.zero
}

/// A resize from one of an item's handles
struct Resize {
  struct Edges: OptionSet {
    let rawValue: Int
    static let left = Edges(rawValue: 1)
    static let right = Edges(rawValue: 2)
    static let top = Edges(rawValue: 4)
    static let bottom = Edges(rawValue: 8)
  }

  enum What {
    /// A code card or Note: width and height
    case card
    /// A Text's or Box's side edge: the width it wraps at
    case textWidth
    /// A Text's or Box's corner: its text size, and its width with it
    case textSize(fontSize: Double, width: Double)
    /// An image: its width, its height following
    case image
    case section
  }

  var item: Item
  var what: What
  var edges: Edges
  var from: CGRect
  var rect: CGRect
  var minSize: CGSize
  /// A Text corner: the text size reached
  var fontSize: Double?
}

/// How near a Text's handle the pointer must be to take it (view points)
private let handleReach: CGFloat = 6
/// How far the pointer moves before a press becomes a drag (view points)
private let dragSlop: CGFloat = 3

extension CanvasView {
  // MARK: Showing a document

  /// Shows an open board and edits it: what the document changes (an edit here, undo, another writer) is shown as it
  /// changes
  public func show(_ doc: BoardDocument, at board: VaultBoard, in vault: Vault, theme: Theme) async throws {
    if document !== doc {
      stopObserving?()
      document = doc
      stopObserving = doc.observe { [weak self] _ in self?.documentChanged() }
    }
    try await load(board, in: vault, theme: theme, keepCamera: false)
  }

  /// Stops showing the document (its tab closed)
  public func leave() {
    stopObserving?()
    stopObserving = nil
    document = nil
  }

  private func documentChanged() {
    guard let doc = document else { return }
    // only the selection changed (a marquee under way too): its rings follow at once
    if doc.board != shownBoard { refresh() } else { drawChrome() }
  }

  /// Makes the scene again from the document's board: drawings that did not change are reused with their bitmaps; what
  /// changed is measured and drawn (at the zoom shown, when in view) before anything is swapped in
  func refresh() {
    guard let doc = document, let (vb, vault) = shown, let old = scene else { return }
    guard gesture == nil else {
      pendingRefresh = true
      return
    }
    pendingRefresh = false
    refreshes += 1
    let n = refreshes
    let board = doc.board
    let (theme, notes, images, backing) = (self.theme, self.notes, self.images, self.backing)
    let known = measured
    let fit = fitZoom
    let zoom = camera.zoom
    let view = camera.visible(bounds.size)
    let highlighter = CanvasView.highlighter
    refreshing = Task {
      let r = await Task.detached(priority: .userInitiated) {
        let package = vault.url(of: vb.path)
        let ms = Scene.measures(board, package: package, vault: vault)
        var sizes: [CardID: CGSize] = [:]
        var todo: [Scene.Measure] = []
        for m in ms {
          if let k = known[m.card], k.note == m.note, k.width == m.width {
            sizes[m.card] = k.size
          } else {
            todo.append(m)
          }
        }
        sizes.merge(await CanvasView.measure(todo, theme: theme, notes: notes)) { a, _ in a }
        let s = Scene(
          board, package: package, vault: vault, theme: theme, highlighter: highlighter ?? Highlighter(), sizes: sizes,
          reusing: old)
        var before: [Scene.Owner: Scene.Item] = [:]
        for it in old.items { if let o = it.owner { before[o] = it } }
        var fresh: [Int: Fresh] = [:]
        for (i, it) in s.items.enumerated() where !CanvasView.keeps(it.owner.flatMap { before[$0] }, it, s.reused) {
          fresh[i] = await CanvasView.draw(
            it, fit: fit, zoom: zoom, view: view, backing: backing, theme: theme, images: images, notes: notes)
        }
        return (s, fresh, ms, sizes)
      }.value
      guard n == refreshes, document === doc else { return }
      guard gesture == nil else {
        pendingRefresh = true
        return
      }
      shownBoard = board
      measured = [:]
      for m in r.2 { if let size = r.3[m.card] { measured[m.card] = (m.note, m.width, size) } }
      reinstall(r.0, fresh: r.1)
    }
  }

  /// An item's new bitmaps: its overview, and at the zoom shown when it is in view
  struct Fresh: @unchecked Sendable {
    var overview: Overview
    var sharp: (IOSurface, CGFloat)?
  }

  /// Whether the next scene's item can keep the layers (and bitmaps) of the one before
  nonisolated static func keeps(_ old: Scene.Item?, _ new: Scene.Item, _ reused: Set<CardID>) -> Bool {
    guard let old, old.rect.size == new.rect.size, old.tilt == new.tilt, old.bleed == new.bleed else { return false }
    switch new.owner {
    case .card(let id): return reused.contains(id)
    case .sectionTitle, .arrowLabel:
      if case .label(let a) = old.drawing, case .label(let b) = new.drawing { return a.text == b.text }
      return false
    case nil: return false
    }
  }

  /// Draws an item that changed: a Note's picture is asked of the renderer now (not only from its cache), so it never
  /// shows bare paper where its text was
  nonisolated static func draw(
    _ it: Scene.Item, fit: CGFloat, zoom: CGFloat, view: CGRect, backing: CGFloat, theme: Theme, images: DecodeCache,
    notes: NoteRenderer
  ) async -> Fresh {
    func bitmap(_ scale: CGFloat) async -> (IOSurface?, NoteFace) {
      guard it.drawing.byRenderer else {
        return (render(it, scale: scale, theme: theme, images: images).surface, .drawn)
      }
      if let snap = await picture(it, scale: scale, theme: theme, notes: notes, priority: 0),
        let s = compose(it, snap, scale: scale, theme: theme, images: images)
      {
        return (s, .drawn)
      }
      return (render(it, scale: scale, theme: theme, images: images).surface, .paper)
    }
    let os =
      it.drawing.byRenderer
      ? Levels.noteOverview(fit, backing: backing, size: it.bitmapSize)
      : Levels.scale(fit, backing: backing, size: it.bitmapSize)
    let (o, face) = await bitmap(os)
    var sharp: (IOSurface, CGFloat)?
    let s = Levels.scale(zoom, backing: backing, size: it.bitmapSize)
    if s > os * 1.01, it.rect.intersects(view), let b = await bitmap(s).0 { sharp = (b, s) }
    return Fresh(overview: (o, os, face), sharp: sharp)
  }

  /// The new scene in place of the old one in one transaction: unchanged items keep their layers (moved where they are
  /// now), changed ones come with their bitmaps drawn, frames and arrows are made again
  private func reinstall(_ s: Scene, fresh: [Int: Fresh]) {
    guard let old = scene else { return }
    let started = CACurrentMediaTime()
    cancelRedraws()
    var byOwner: [Scene.Owner: ItemLayers] = [:]
    for (i, l) in items.enumerated() { if let o = old.items[i].owner { byOwner[o] = l } }
    let shadow = cardShadow
    var next: [ItemLayers] = []
    withoutAnimation {
      for (i, it) in s.items.enumerated() {
        if let f = fresh[i] {
          let l = ItemLayers(it, overview: f.overview, shadow: it.drawing.framed ? shadow : nil)
          if let (surface, scale) = f.sharp {
            l.held.contents = surface
            l.heldSurface = surface
            l.heldScale = scale
          }
          next.append(l)
        } else if let o = it.owner, let l = byOwner[o] {
          l.box.zPosition = 0
          l.box.setAffineTransform(it.tilt == 0 ? .identity : CGAffineTransform(rotationAngle: it.tilt))
          l.box.position = CGPoint(x: it.rect.midX, y: it.rect.midY)
          next.append(l)
        }
      }
      for l in [below, cards, above] { l.sublayers = nil }
      for (i, l) in next.enumerated() {
        (i < s.cardsFrom ? below : i < s.labelsFrom ? cards : above).addSublayer(l.box)
      }
      sections.sublayers = nil
      for f in s.frames { sections.addSublayer(CanvasView.frameLayer(f, theme)) }
      arrows.sublayers = nil
      arrowGroups = s.arrows.map { a in
        let ls = CanvasView.arrowLayers(a, theme)
        for l in ls { arrows.addSublayer(l) }
        return ls
      }
    }
    scene = s
    items = next
    // a swap made here otherwise reaches the screen a frame later than the layers it replaces go
    CATransaction.flush()
    arrive()
    drawChrome()
    lastInstall = (CACurrentMediaTime() - started, fresh.count)
  }

  // MARK: Measuring (CanvasBench)

  /// The cards drawn, in drawing order, where they are
  package var cardRects: [(id: CardID, rect: CGRect)] {
    scene?.items.compactMap { it in if case .card(let id)? = it.owner { (id, it.rect) } else { nil } } ?? []
  }

  package func sectionTitle(_ id: SectionID) -> CGRect? {
    scene?.items.first { $0.owner == .sectionTitle(id) }?.rect
  }

  /// A board point in the view
  package func viewPoint(_ p: CGPoint) -> CGPoint { camera.view(p) }

  /// Every item drawn again now at the zoom shown, Notes asked of the renderer (LookCompare: pictures without the
  /// display link, which a window off screen never gets)
  package func drawAll() async {
    guard let s = scene else { return }
    let (fit, zoom, view) = (fitZoom, camera.zoom, camera.visible(bounds.size))
    var fresh: [Int: Fresh] = [:]
    for (i, it) in s.items.enumerated() {
      fresh[i] = await CanvasView.draw(
        it, fit: fit, zoom: zoom, view: view, backing: backing, theme: theme, images: images, notes: notes)
    }
    reinstall(s, fresh: fresh)
  }

  // MARK: Hit testing

  /// The topmost card drawn at a board point
  func hitCard(_ p: CGPoint) -> CardID? {
    guard let s = scene else { return nil }
    for it in s.items[s.cardsFrom..<s.labelsFrom].reversed() {
      if case .card(let id)? = it.owner, it.rect.contains(p) { return id }
    }
    return nil
  }

  func hitSectionTitle(_ p: CGPoint) -> SectionID? {
    guard let s = scene else { return nil }
    for it in s.items[..<s.cardsFrom].reversed() {
      if case .sectionTitle(let id)? = it.owner, it.rect.insetBy(dx: -4, dy: -4).contains(p) { return id }
    }
    return nil
  }

  /// The innermost Section whose frame holds the point (core deepestAt)
  func deepestSection(_ p: CGPoint, frames: [SectionID: CGRect]? = nil, skip: Set<SectionID> = []) -> SectionID? {
    guard let board = document?.board, let s = scene else { return nil }
    let fr = frames ?? Dictionary(s.frames.map { ($0.id, $0.rect) }, uniquingKeysWith: { a, _ in a })
    var best: (SectionID, Int, CGFloat)?
    for q in board.sections where !skip.contains(q.id) && !q.collapsed {
      guard let r = fr[q.id], r.contains(p) else { continue }
      let d = depth(q.id, board)
      if best == nil || d > best!.1 || (d == best!.1 && r.width * r.height < best!.2) {
        best = (q.id, d, r.width * r.height)
      }
    }
    return best?.0
  }

  private func depth(_ id: SectionID, _ b: Board) -> Int {
    var n = 0
    var at = b.section(id)?.parent
    while let p = at, n < 64 {
      n += 1
      at = b.section(p)?.parent
    }
    return n
  }

  /// The Section a card's rect now lies in: the innermost it overlaps by more than a third (board homeFor)
  func home(of r: CGRect, frames: [SectionID: CGRect], skip: Set<SectionID> = []) -> SectionID? {
    guard let board = document?.board else { return nil }
    let third = r.width * r.height / 3
    var best: (SectionID, Int, CGFloat)?
    for q in board.sections where !q.collapsed && !skip.contains(q.id) {
      guard let f = frames[q.id] else { continue }
      let o = r.intersection(f)
      let area = o.isNull ? 0 : o.width * o.height
      guard area > third else { continue }
      let d = depth(q.id, board)
      if best == nil || d > best!.1 || (d == best!.1 && area > best!.2) { best = (q.id, d, area) }
    }
    return best?.0
  }

  func index(of owner: Scene.Owner) -> Int? { scene?.items.firstIndex { $0.owner == owner } }

  /// Where an item is drawn now (a move or resize under way included)
  func liveRect(_ item: Item) -> CGRect? {
    guard let s = scene else { return nil }
    var r: CGRect?
    switch item {
    case .card(let id): r = index(of: .card(id)).map { s.items[$0].rect }
    case .section(let id): r = s.frames.first { $0.id == id }?.rect
    }
    guard var rect = r else { return nil }
    switch gesture?.kind {
    case .move(let m)?, .nudge(let m)?:
      if let id = item.card, m.cards.contains(id) { rect = rect.offsetBy(dx: m.d.dx, dy: m.d.dy) }
      if let id = item.section, m.sections.contains(id) { rect = rect.offsetBy(dx: m.d.dx, dy: m.d.dy) }
    case .resize(let z)? where z.item == item: rect = z.rect
    default: break
    }
    return rect
  }

  // MARK: Selection chrome

  /// The selection's rings, and the handles of a lone selected item that can change, in the theme's accent; line widths
  /// in view points whatever the zoom
  func drawChrome() {
    guard let doc = document, scene != nil else {
      chrome.sublayers = nil
      return
    }
    let z = camera.zoom
    let accent = theme.accent
    withoutAnimation {
      chrome.sublayers = nil
      for item in doc.selection {
        guard let r = liveRect(item) else { continue }
        switch item {
        case .card(let id):
          let it = index(of: .card(id)).map { scene!.items[$0] }
          var text = false
          if case .note(let n)? = it?.drawing { text = n.content.isText }
          if text {
            outline(r, box: isBox(id), tilt: it?.tilt ?? 0, zoom: z)
          } else if theme.id == .inkWash {
            chrome.addSublayer(seal(on: r, tilt: it?.tilt ?? 0))
          } else {
            ring(r, tilt: it?.tilt ?? 0, zoom: z)
          }
        case .section(let id):
          if theme.id == .inkWash, let f = scene?.frames.first(where: { $0.id == id }), let strokes = f.strokes {
            brushed(r, strokes: strokes.cg)
          } else {
            framed(r, zoom: z)
          }
        }
      }
      guard doc.selection.count == 1, let item = doc.selection.first, !doc.board.isLocked(item) else { return }
      switch gesture?.kind {
      case .move?, .nudge?, .marquee?: return
      default: break
      }
      // only a Text's and a Box's handles show (styles.css .hw, .mkgrip); every other kind is resized by its edges,
      // which only the pointer's shape tells
      guard case .card(let id) = item, isText(id) else { return }
      for (_, r) in textHandles(id) {
        let l = CAShapeLayer()
        let radius = r.height > 12 ? 4.0 : 3.0
        l.path = CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)
        l.fillColor = theme.surface
        l.strokeColor = accent
        l.lineWidth = 1.5
        chrome.addSublayer(l)
      }
    }
  }

  /// A selected card's ring (styles.css .card.sel): 1.5 view points of the accent over a 4.5 point halo of it at 16 %
  private func ring(_ r: CGRect, tilt: CGFloat, zoom z: CGFloat) {
    for (width, alpha) in [(4.5, 0.16), (1.5, 1.0)] as [(CGFloat, CGFloat)] {
      let l = CAShapeLayer()
      let out = width / 2 / z
      let ring = r.insetBy(dx: -out, dy: -out)
      l.bounds = CGRect(origin: .zero, size: ring.size)
      l.position = CGPoint(x: ring.midX, y: ring.midY)
      let radius = theme.cardRadius + out
      l.path = CGPath(roundedRect: l.bounds, cornerWidth: radius, cornerHeight: radius, transform: nil)
      l.fillColor = nil
      l.strokeColor = theme.accent.copy(alpha: alpha)
      l.lineWidth = width / z
      if tilt != 0 { l.setAffineTransform(CGAffineTransform(rotationAngle: tilt)) }
      chrome.addSublayer(l)
    }
  }

  /// Ink Wash's selected card (themes.css #128): a small vermilion seal 选 over its top right corner, 24 board units
  /// square, its middle 7 out and 5 up from the corner, turned 6 degrees; no ring
  private func seal(on r: CGRect, tilt: CGFloat) -> CALayer {
    let box = CALayer()
    box.bounds = CGRect(x: 0, y: 0, width: r.width, height: r.height)
    box.position = CGPoint(x: r.midX, y: r.midY)
    if tilt != 0 { box.setAffineTransform(CGAffineTransform(rotationAngle: tilt)) }
    let stamp = CALayer()
    stamp.bounds = CGRect(x: 0, y: 0, width: 24, height: 24)
    stamp.position = CGPoint(x: r.width + 7, y: -5)
    stamp.setAffineTransform(CGAffineTransform(rotationAngle: -6 * .pi / 180))
    stamp.backgroundColor = theme.surface.copy(alpha: 0.6)
    stamp.borderColor = theme.accent
    stamp.borderWidth = 1.6
    stamp.cornerRadius = 2
    stamp.opacity = 0.92
    let font = CTFontCreateWithName("STSongti-SC-Bold" as CFString, 14, nil)
    let line = CTFontGetAscent(font) + CTFontGetDescent(font)
    let glyph = CATextLayer()
    glyph.frame = CGRect(x: 0, y: (24 - line) / 2, width: 24, height: line)
    glyph.string = NSAttributedString(string: "选", attributes: [.font: font, .foregroundColor: theme.accent])
    glyph.alignmentMode = .center
    glyph.contentsScale = backing * max(1, camera.zoom)
    stamp.addSublayer(glyph)
    box.addSublayer(stamp)
    return box
  }

  /// A selected Section (styles.css .sect.sel): the accent edge, a 3 point halo of it at 18 % and a 7 % wash
  private func framed(_ r: CGRect, zoom z: CGFloat) {
    let wash = CAShapeLayer()
    wash.path = Drawing.squircle(r, theme.sectionRadius)
    wash.fillColor = theme.accent.copy(alpha: 0.07)
    wash.strokeColor = theme.accent
    wash.lineWidth = 1 / z
    let halo = CAShapeLayer()
    let out = 1.5 / z
    halo.path = Drawing.squircle(r.insetBy(dx: -out, dy: -out), theme.sectionRadius + out)
    halo.fillColor = nil
    halo.strokeColor = theme.accent.copy(alpha: 0.18)
    halo.lineWidth = 3 / z
    chrome.addSublayer(halo)
    chrome.addSublayer(wash)
  }

  /// Ink Wash's selected Section (themes.css .sect.sel): its brush stroke in vermilion, a second stroke 5 down and
  /// right at 42 %, a faint vermilion wash inside
  private func brushed(_ r: CGRect, strokes: CGPath) {
    let box = CALayer()
    box.frame = r
    let wash = CALayer()
    wash.frame = box.bounds
    wash.backgroundColor = theme.accent.copy(alpha: theme.dark ? 0.07 : 0.045)
    box.addSublayer(wash)
    let echo = CAShapeLayer()
    echo.path = strokes
    echo.fillColor = theme.accent
    echo.opacity = 0.42
    echo.position = CGPoint(x: 5, y: 5)
    echo.anchorPoint = .zero
    box.addSublayer(echo)
    let brush = CAShapeLayer()
    brush.path = strokes
    brush.fillColor = theme.accent.copy(alpha: 0.85)
    brush.anchorPoint = .zero
    brush.position = .zero
    box.addSublayer(brush)
    chrome.addSublayer(box)
  }

  /// A Text or a Box
  func isText(_ id: CardID) -> Bool {
    guard let i = index(of: .card(id)), case .note(let n) = scene!.items[i].drawing else { return false }
    return n.content.isText
  }

  func isBox(_ id: CardID) -> Bool {
    guard let i = index(of: .card(id)), case .note(let n) = scene!.items[i].drawing, case .text(let t) = n.content
    else { return false }
    return t.look == .box
  }

  /// A selected Text's or Box's frame (styles.css .card.text.sel): a 1.5 point line of the accent, 2 out from a Text
  /// (3 from a Box), round as the card's corners
  private func outline(_ r: CGRect, box: Bool, tilt: CGFloat, zoom z: CGFloat) {
    let gap: CGFloat = box ? 3 : 2
    let w = 1.5 / z
    let o = r.insetBy(dx: -gap - w / 2, dy: -gap - w / 2)
    let l = CAShapeLayer()
    l.bounds = CGRect(origin: .zero, size: o.size)
    l.position = CGPoint(x: o.midX, y: o.midY)
    let radius = (box ? theme.cardRadius : 5.5) + gap + w / 2
    l.path = CGPath(roundedRect: l.bounds, cornerWidth: radius, cornerHeight: radius, transform: nil)
    l.fillColor = nil
    l.strokeColor = theme.accent
    l.lineWidth = w
    if tilt != 0 { l.setAffineTransform(CGAffineTransform(rotationAngle: tilt)) }
    chrome.addSublayer(l)
  }

  /// A Text's or Box's handles where they are drawn (board units): a pill on each side edge for the width it wraps at,
  /// a small square past the bottom right corner for its text size
  func textHandles(_ id: CardID) -> [(Resize.Edges, CGRect)] {
    guard let r = liveRect(.card(id)) else { return [] }
    return [
      (.left, CGRect(x: r.minX - 8, y: r.midY - 7, width: 8, height: 14)),
      (.right, CGRect(x: r.maxX, y: r.midY - 7, width: 8, height: 14)),
      ([.right, .bottom], CGRect(x: r.maxX - 1, y: r.maxY - 1, width: 10, height: 10)),
    ]
  }

  /// The edges an item is resized by: a Section by every side and corner, a code card or Note by its sides, its bottom
  /// and its bottom right corner, an image by its right side and that corner (its height follows), a Text or Box by its
  /// side handles and corner; none when tilted
  func resizeEdges(_ item: Item) -> [Resize.Edges] {
    switch item {
    case .section:
      return [.left, .right, .top, .bottom, [.left, .top], [.right, .top], [.left, .bottom], [.right, .bottom]]
    case .card(let id):
      guard let s = scene, let i = index(of: .card(id)), s.items[i].tilt == 0 else { return [] }
      switch s.items[i].drawing {
      case .note(let n) where n.content.isText: return [.left, .right, [.right, .bottom]]
      case .image: return [.right, [.right, .bottom]]
      case .code, .note: return [.left, .right, .bottom, [.right, .bottom]]
      default: return []
      }
    }
  }

  /// The edge of `item` under a view point: a Text's or Box's handles; any other kind's edges, a band 4 board units
  /// either side of each (never under 4 view points), its corners 14 units square (never under 8 points)
  func edge(of item: Item, at v: CGPoint) -> Resize.Edges? {
    guard let r = liveRect(item) else { return nil }
    let z = camera.zoom
    if case .card(let id) = item, isText(id) {
      for (e, h) in textHandles(id) {
        let q = CGRect(origin: camera.view(h.origin), size: CGSize(width: h.width * z, height: h.height * z))
        if q.insetBy(dx: -handleReach / 2, dy: -handleReach / 2).contains(v) { return e }
      }
      return nil
    }
    let edges = resizeEdges(item)
    let o = camera.view(r.origin)
    let view = CGRect(origin: o, size: CGSize(width: r.width * z, height: r.height * z))
    let band = max(4 * z, 4)
    let corner = max(7 * z, 8)
    for e in edges where e.rawValue.nonzeroBitCount == 2 {
      let p = CGPoint(x: e.contains(.left) ? view.minX : view.maxX, y: e.contains(.top) ? view.minY : view.maxY)
      if abs(v.x - p.x) <= corner && abs(v.y - p.y) <= corner { return e }
    }
    let alongY = v.y > view.minY + corner && v.y < view.maxY - corner
    let alongX = v.x > view.minX + corner && v.x < view.maxX - corner
    if edges.contains(.left), alongY, abs(v.x - view.minX) <= band { return .left }
    if edges.contains(.right), alongY, abs(v.x - view.maxX) <= band { return .right }
    if edges.contains(.top), alongX, abs(v.y - view.minY) <= band { return .top }
    if edges.contains(.bottom), alongX, abs(v.y - view.maxY) <= band { return .bottom }
    return nil
  }

  /// The edge under a view point that a press would resize: the lone selected item's, else a card's under the pointer
  /// (as the web board's corner grip shows on any card); never a locked one's
  func hitHandle(_ v: CGPoint) -> (Item, Resize.Edges)? {
    guard let doc = document else { return nil }
    if doc.selection.count == 1, let item = doc.selection.first, !doc.board.isLocked(item),
      let e = edge(of: item, at: v)
    {
      return (item, e)
    }
    let p = camera.board(v)
    for it in scene?.items[(scene?.cardsFrom ?? 0)..<(scene?.labelsFrom ?? 0)].reversed() ?? [] {
      guard case .card(let id)? = it.owner, it.rect.insetBy(dx: -8 / camera.zoom, dy: -8 / camera.zoom).contains(p)
      else { continue }
      // its corner only: a press by any other edge of a card not selected moves it
      guard !isText(id), !doc.board.isLocked(.card(id)), let e = edge(of: .card(id), at: v), e == [.right, .bottom]
      else { return nil }
      return (.card(id), e)
    }
    return nil
  }

  /// The pointer's shape over an edge: what dragging it does
  func resizeCursor(_ e: Resize.Edges) -> NSCursor {
    let position: NSCursor.FrameResizePosition =
      switch e {
      case .left: .left
      case .right: .right
      case .top: .top
      case .bottom: .bottom
      case [.left, .top]: .topLeft
      case [.right, .top]: .topRight
      case [.left, .bottom]: .bottomLeft
      default: .bottomRight
      }
    return NSCursor.frameResize(position: position, directions: .all)
  }

  public override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas where t.owner === self { removeTrackingArea(t) }
    addTrackingArea(
      NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self))
  }

  public override func mouseMoved(with e: NSEvent) {
    guard gesture == nil else { return }
    let v = convert(e.locationInWindow, from: nil)
    if let (_, edge) = hitHandle(v) { resizeCursor(edge).set() } else { NSCursor.arrow.set() }
  }

  // MARK: Pointer

  public override func mouseDown(with e: NSEvent) {
    window?.makeFirstResponder(self)
    guard let doc = document, scene != nil, gesture == nil, e.clickCount < 2 else { return }
    let v = convert(e.locationInWindow, from: nil)
    let p = camera.board(v)
    if let (item, edges) = hitHandle(v) {
      startResize(item, edges, at: v, p)
      return
    }
    let toggle = !e.modifierFlags.isDisjoint(with: [.shift, .command])
    var item: Item?
    if let id = hitCard(p) {
      item = .card(id)
    } else if let id = hitSectionTitle(p) {
      item = .section(id)
    } else if e.modifierFlags.contains(.command), let id = deepestSection(p) {
      // ⌘ on a Section's blank inside grabs it, as its title does
      item = .section(id)
    }
    let inside = item == nil ? deepestSection(p) : nil
    let was = item.map(doc.selection.contains) ?? false
    if let item, !was { doc.select(toggle ? doc.selection.union([item]) : [item]) }
    gesture = Gesture(
      kind: .press(
        item: item, toggle: toggle && !e.modifierFlags.contains(.command) || toggle && item?.card != nil,
        wasSelected: was, inside: inside),
      startView: v, start: p)
  }

  public override func mouseDragged(with e: NSEvent) {
    guard var g = gesture, let doc = document else { return }
    let v = convert(e.locationInWindow, from: nil)
    let p = camera.board(v)
    switch g.kind {
    case .press(let item, let toggle, _, _):
      guard hypot(v.x - g.startView.x, v.y - g.startView.y) >= dragSlop else { return }
      if item != nil {
        guard let m = makeMove(doc.selection) else {
          g.kind = .still
          gesture = g
          return
        }
        g.kind = .move(m)
      } else {
        let base = toggle ? doc.selection : []
        g.kind = .marquee(base: base)
        if !toggle { doc.select([]) }
      }
      gesture = g
      mouseDragged(with: e)
    case .move(var m):
      m.d = CGVector(dx: p.x - g.start.x, dy: p.y - g.start.y)
      g.kind = .move(m)
      gesture = g
      showMove(m)
    case .marquee(let base):
      let r = CGRect(
        x: min(v.x, g.startView.x), y: min(v.y, g.startView.y), width: abs(v.x - g.startView.x),
        height: abs(v.y - g.startView.y))
      showMarquee(r)
      let w = CGRect(
        origin: camera.board(r.origin), size: CGSize(width: r.width / camera.zoom, height: r.height / camera.zoom))
      var hit = base
      for it in scene?.items ?? [] {
        if case .card(let id)? = it.owner, it.rect.intersects(w), !doc.board.isLocked(.card(id)) {
          hit.insert(.card(id))
        }
      }
      for f in scene?.frames ?? [] where w.contains(f.rect) && !doc.board.isLocked(section: f.id) {
        hit.insert(.section(f.id))
      }
      if hit != doc.selection { doc.select(hit) }
    case .resize(var z):
      resizeTo(&z, CGVector(dx: p.x - g.start.x, dy: p.y - g.start.y))
      g.kind = .resize(z)
      gesture = g
      showResize(z)
    case .nudge, .still:
      break
    }
  }

  public override func mouseUp(with e: NSEvent) {
    guard let g = gesture, let doc = document else { return }
    switch g.kind {
    case .press(let item, let toggle, let was, let inside):
      gesture = nil
      if let item {
        if toggle && was {
          doc.select(doc.selection.subtracting([item]))
        } else if !toggle && doc.selection.count > 1 {
          doc.select([item])
        }
      } else if let s = inside {
        let it = Item.section(s)
        doc.select(toggle ? doc.selection.symmetricDifference([it]) : [it])
      } else if !toggle {
        doc.select([])
      }
    case .move(let m):
      commitMove(m)
    case .marquee:
      gesture = nil
      withoutAnimation { marquee.path = nil }
      drawChrome()
    case .resize(let z):
      commitResize(z)
    case .nudge, .still:
      gesture = nil
    }
    if pendingRefresh { refresh() }
  }

  // MARK: Moving

  /// What dragging `selection` moves; nil when nothing of it can (locked, or nothing)
  func makeMove(_ selection: Set<Item>) -> Move? {
    guard let doc = document, let s = scene else { return nil }
    let (cs, secs) = doc.board.carried(selection)
    guard !cs.isEmpty || !secs.isEmpty else { return nil }
    var items: [Int] = []
    for (i, it) in s.items.enumerated() {
      switch it.owner {
      case .card(let id)? where cs.contains(id): items.append(i)
      case .sectionTitle(let id)? where secs.contains(id): items.append(i)
      default: break
      }
    }
    let frames = s.frames.indices.filter { secs.contains(s.frames[$0].id) }
    let arrows = s.arrows.indices.filter { cs.contains(s.arrows[$0].from) || cs.contains(s.arrows[$0].to) }
    let tops = secs.filter { id in doc.board.section(id)?.parent.map(secs.contains) != true }.sorted {
      $0.rawValue < $1.rawValue
    }
    let loose = cs.filter { id in doc.board.card(id)?.section.map(secs.contains) != true }.sorted {
      $0.rawValue < $1.rawValue
    }
    return Move(cards: cs, sections: secs, tops: tops, loose: loose, items: items, frames: frames, arrows: arrows)
  }

  /// The moved layers where the move has them: cards and titles, frames, the arrows with an end on a moved card re-routed
  func showMove(_ m: Move) {
    guard let s = scene else { return }
    withoutAnimation {
      for i in m.items {
        let r = s.items[i].rect
        items[i].box.position = CGPoint(x: r.midX + m.d.dx, y: r.midY + m.d.dy)
        // picked up: over every card it passes (the web board's .lift)
        items[i].box.zPosition = 1
      }
      let frameLayers = sections.sublayers ?? []
      for i in m.frames where i < frameLayers.count {
        frameLayers[i].frame = s.frames[i].rect.offsetBy(dx: m.d.dx, dy: m.d.dy)
      }
      reroute(m.arrows) { id in
        guard var p = s.placed[id] else { return nil }
        if m.cards.contains(id) { p.rect = p.rect.offsetBy(dx: m.d.dx, dy: m.d.dy) }
        return p
      }
    }
    drawChrome()
  }

  /// Routes these arrows again with their cards where `placed` has them, and moves their labels
  func reroute(_ indices: [Int], placed: (CardID) -> Scene.Placed?) {
    guard let s = scene else { return }
    for i in indices where i < arrowGroups.count {
      let a = s.arrowModels[i]
      guard let from = placed(a.from.card), let to = placed(a.to.card) else { continue }
      let (arrow, label) = Scene.route(a, from: from, to: to, theme: theme)
      let ls = CanvasView.arrowLayers(arrow, theme)
      let old = arrowGroups[i]
      if let first = old.first {
        for l in ls { arrows.insertSublayer(l, below: first) }
      } else {
        for l in ls { arrows.addSublayer(l) }
      }
      for l in old { l.removeFromSuperlayer() }
      arrowGroups[i] = ls
      if let label, let li = index(of: .arrowLabel(a.id)) {
        items[li].box.position = CGPoint(x: label.rect.midX, y: label.rect.midY)
      }
    }
  }

  /// Puts back what a gesture moved, as the scene has it
  func showScene(arrows indices: [Int], items ids: [Int], frames fs: [Int]) {
    guard let s = scene else { return }
    withoutAnimation {
      for i in ids {
        items[i].box.position = CGPoint(x: s.items[i].rect.midX, y: s.items[i].rect.midY)
        items[i].box.zPosition = 0
        items[i].box.setAffineTransform(
          s.items[i].tilt == 0 ? .identity : CGAffineTransform(rotationAngle: s.items[i].tilt))
      }
      let frameLayers = sections.sublayers ?? []
      for i in fs where i < frameLayers.count {
        frameLayers[i].removeFromSuperlayer()
        sections.insertSublayer(CanvasView.frameLayer(s.frames[i], theme), at: UInt32(i))
      }
      reroute(indices) { s.placed[$0] }
    }
  }

  /// The move as one step: the cards and Sections moved, each loose card in the Section it now lies in, each outer
  /// Section in the one its title is in (board dragGroup)
  func commitMove(_ m: Move, name: String = "Move") {
    gesture = nil
    guard let doc = document, let s = scene else { return }
    let dx = m.d.dx.rounded()
    let dy = m.d.dy.rounded()
    guard dx != 0 || dy != 0 else {
      showScene(arrows: m.arrows, items: m.items, frames: m.frames)
      drawChrome()
      return
    }
    var frames = Dictionary(s.frames.map { ($0.id, $0.rect) }, uniquingKeysWith: { a, _ in a })
    for id in m.sections { frames[id] = frames[id]?.offsetBy(dx: dx, dy: dy) }
    var homes: [CardID: SectionID?] = [:]
    for id in m.loose {
      guard let i = index(of: .card(id)) else { continue }
      homes[id] = home(of: s.items[i].rect.offsetBy(dx: dx, dy: dy), frames: frames)
    }
    var parents: [SectionID: SectionID?] = [:]
    for id in m.tops {
      guard let r = frames[id] else { continue }
      let title = CGPoint(x: r.minX + theme.sectionTitleAt.x + 4, y: r.minY + theme.sectionTitleAt.y + 4)
      var skip = Set<SectionID>()
      for t in m.tops { skip.formUnion(doc.board.sectionTree(t)) }
      parents[id] = deepestSection(title, frames: frames, skip: skip)
    }
    let moved = Set(m.cards.map(Item.card)).union(m.sections.map(Item.section))
    doc.edit(name) { b in
      b.move(moved, dx: dx, dy: dy)
      b.setHomes(cards: homes, sections: parents)
    }
  }

  // MARK: Resizing

  func startResize(_ item: Item, _ edges: Resize.Edges, at v: CGPoint, _ p: CGPoint) {
    guard let doc = document, let s = scene, let r = liveRect(item) else { return }
    var what = Resize.What.card
    var minSize = CGSize(width: 160, height: 64)
    switch item {
    case .section:
      what = .section
      minSize = CGSize(width: 120, height: 80)
    case .card(let id):
      guard let i = index(of: .card(id)), let card = doc.board.card(id) else { return }
      switch s.items[i].drawing {
      case .note(let n) where n.content.isText:
        if edges == [.right, .bottom] {
          guard case .text(let t) = n.content else { return }
          what = .textSize(fontSize: t.fontSize, width: card.width)
        } else {
          what = .textWidth
          minSize = CGSize(width: leastWidths[id] ?? 40, height: 0)
          measureLeast(id, n.content, folder: n.folder)
        }
      case .image: what = .image
      default: break
      }
    }
    let z = Resize(item: item, what: what, edges: edges, from: r, rect: r, minSize: minSize)
    gesture = Gesture(kind: .resize(z), startView: v, start: p)
    drawChrome()
  }

  /// A Text's narrowest width, measured once by the Note page (as wide as its longest word)
  private func measureLeast(_ id: CardID, _ body: NoteBody, folder: URL) {
    guard leastWidths[id] == nil, case .text(var t) = body else { return }
    t.wrap = true
    let req = NoteRenderer.SizeRequest(
      note: .text(t), width: 0, folder: folder, look: theme.id.rawValue, dark: theme.dark)
    let notes = self.notes
    Task {
      guard let size = try? await notes.sizes(of: [req], priority: 0).first ?? nil else { return }
      leastWidths[id] = size.width
      if case .resize(var z)? = gesture?.kind, z.item == .card(id) {
        z.minSize.width = size.width
        gesture?.kind = .resize(z)
      }
    }
  }

  /// The rect a resize has reached with the pointer moved by d (board units)
  func resizeTo(_ z: inout Resize, _ d: CGVector) {
    let f = z.from
    var r = f
    switch z.what {
    case .textSize(let fs0, _):
      // the text size and the width scale together by how far the corner went along the diagonal (core scaleText)
      let k = 1 + (d.dx * f.width + d.dy * f.height) / max(1, f.width * f.width + f.height * f.height)
      let fs = min(TextCard.fontSizes.upperBound, max(TextCard.fontSizes.lowerBound, (fs0 * k * 2).rounded() / 2))
      z.fontSize = fs
      r.size = CGSize(width: f.width * fs / fs0, height: f.height * fs / fs0)
    case .image:
      let dx =
        abs(d.dy * f.width / max(1, f.height)) > abs(d.dx) && z.edges.contains(.bottom)
        ? d.dy * f.width / f.height : d.dx
      r.size.width = max(z.minSize.width, f.width + dx)
      r.size.height = r.width * f.height / max(1, f.width)
    default:
      if z.edges.contains(.right) { r.size.width = max(z.minSize.width, f.width + d.dx) }
      if z.edges.contains(.left) {
        r.size.width = max(z.minSize.width, f.width - d.dx)
        r.origin.x = f.maxX - r.width
      }
      if z.edges.contains(.bottom) { r.size.height = max(z.minSize.height, f.height + d.dy) }
      if z.edges.contains(.top) {
        r.size.height = max(z.minSize.height, f.height - d.dy)
        r.origin.y = f.maxY - r.height
      }
    }
    z.rect = r
  }

  /// While resizing: a Text's corner and an image scale their bitmap (what they will look like); a Section's frame takes
  /// the new size; any other card keeps its picture and the ring shows the new size, drawn once at the end
  func showResize(_ z: Resize) {
    guard let s = scene else { return }
    withoutAnimation {
      switch (z.item, z.what) {
      case (.card(let id), .textSize), (.card(let id), .image):
        guard let i = index(of: .card(id)) else { break }
        let k = z.rect.width / max(1, z.from.width)
        items[i].box.setAffineTransform(CGAffineTransform(scaleX: k, y: k))
        items[i].box.position = CGPoint(x: z.rect.midX, y: z.rect.midY)
      case (.section(let id), _):
        guard let fi = s.frames.firstIndex(where: { $0.id == id }), let ls = sections.sublayers, fi < ls.count else {
          break
        }
        var f = s.frames[fi]
        f.rect = z.rect
        if f.strokes != nil {
          f.strokes = Outline(InkFrame.path(id: id.rawValue, size: z.rect.size, gap: 40))
        }
        ls[fi].removeFromSuperlayer()
        sections.insertSublayer(CanvasView.frameLayer(f, theme), at: UInt32(fi))
        if let ti = index(of: .sectionTitle(id)) {
          let t = s.items[ti].rect
          items[ti].box.position = CGPoint(
            x: t.midX + z.rect.minX - z.from.minX, y: t.midY + z.rect.minY - z.from.minY)
        }
      default: break
      }
    }
    drawChrome()
  }

  func commitResize(_ z: Resize) {
    gesture = nil
    guard let doc = document, let s = scene else { return }
    let r = z.rect
    guard r != z.from else {
      restoreResize(z)
      return
    }
    let rounded = CGRect(x: r.minX.rounded(), y: r.minY.rounded(), width: r.width.rounded(), height: r.height.rounded())
    switch (z.item, z.what) {
    case (.section(let id), _):
      // the cards it now covers by more than a third join it (in none or in one around it), its own it no longer
      // covers go to the Section they then lie in (board resizeSection)
      var frames = Dictionary(s.frames.map { ($0.id, $0.rect) }, uniquingKeysWith: { a, _ in a })
      frames[id] = rounded
      let tree = doc.board.sectionTree(id)
      var around = Set<SectionID>()
      var at = doc.board.section(id)?.parent
      while let p = at, around.insert(p).inserted { at = doc.board.section(p)?.parent }
      var homes: [CardID: SectionID?] = [:]
      for c in doc.board.cards where !doc.board.isLocked(.card(c.id)) {
        guard let i = index(of: .card(c.id)) else { continue }
        let cr = s.items[i].rect
        let o = cr.intersection(rounded)
        let covered = !o.isNull && o.width * o.height > cr.width * cr.height / 3
        if covered, c.section == nil || c.section.map(around.contains) == true {
          homes[c.id] = id
        } else if !covered, c.section == id {
          homes[c.id] = home(of: cr, frames: frames, skip: tree)
        }
      }
      doc.edit("Resize") { b in
        b.resize(section: id, x: rounded.minX, y: rounded.minY, width: rounded.width, height: rounded.height)
        b.setHomes(cards: homes)
      }
    case (.card(let id), .textSize):
      guard let fs = z.fontSize, case .textSize(let fs0, let w0) = z.what else { return }
      doc.edit("Resize") { $0.scaleText(id, fontSize: fs, width: max(1, (w0 * fs / fs0).rounded())) }
    case (.card(let id), .textWidth):
      doc.edit("Resize") { $0.wrapText(id, x: rounded.minX, width: rounded.width) }
    case (.card(let id), _):
      guard let card = doc.board.card(id), let i = index(of: .card(id)) else { return }
      var height = card.height
      if case .image = z.what {
        height = card.height.map { _ in rounded.height }
      } else if z.edges.contains(.bottom) || z.edges.contains(.top) {
        switch s.items[i].drawing {
        case .code(let c):
          height = rounded.height - (c.framed ? theme.headerHeight : 0)
        default:
          // near the height its content takes: as tall as its content again (board resizeDown)
          let natural = measured[id]?.size.height
          height = natural.map { abs(rounded.height - $0) < 8 / camera.zoom } == true ? nil : rounded.height
        }
      }
      doc.edit("Resize") { $0.resize(id, x: rounded.minX, y: rounded.minY, width: rounded.width, height: height) }
    }
    if doc.board == shownBoard { restoreResize(z) }
  }

  private func restoreResize(_ z: Resize) {
    var ids: [Int] = []
    var fs: [Int] = []
    switch z.item {
    case .card(let id): if let i = index(of: .card(id)) { ids.append(i) }
    case .section(let id):
      if let i = index(of: .sectionTitle(id)) { ids.append(i) }
      if let i = scene?.frames.firstIndex(where: { $0.id == id }) { fs.append(i) }
    }
    showScene(arrows: [], items: ids, frames: fs)
    drawChrome()
  }

  // MARK: Marquee

  private func showMarquee(_ r: CGRect) {
    withoutAnimation {
      marquee.path = CGPath(rect: r.insetBy(dx: 0.5, dy: 0.5), transform: nil)
      marquee.fillColor = theme.accent.copy(alpha: 0.06)
      marquee.strokeColor = theme.accent.copy(alpha: 0.7)
      marquee.lineWidth = 1
    }
  }

  // MARK: Keys

  public override func keyDown(with e: NSEvent) {
    guard let doc = document else { return super.keyDown(with: e) }
    switch e.keyCode {
    case 51, 117:  // ⌫ ⌦
      delete(nil)
    case 53:  // Esc
      if gesture == nil { doc.select([]) }
    case 123, 124, 125, 126:
      nudge(e)
    default:
      super.keyDown(with: e)
    }
  }

  public override func keyUp(with e: NSEvent) {
    guard nudging.remove(e.keyCode) != nil else { return super.keyUp(with: e) }
    if nudging.isEmpty, case .nudge(let m)? = gesture?.kind { commitMove(m) }
  }

  /// An arrow key moves the selection one point on screen (⇧: ten); from the first key down to the last key up is one
  /// step
  private func nudge(_ e: NSEvent) {
    guard let doc = document else { return }
    let step = (e.modifierFlags.contains(.shift) ? 10 : 1) / camera.zoom
    let unit = max(1, step.rounded())
    let d: CGVector =
      switch e.keyCode {
      case 123: CGVector(dx: -unit, dy: 0)
      case 124: CGVector(dx: unit, dy: 0)
      case 125: CGVector(dx: 0, dy: unit)
      default: CGVector(dx: 0, dy: -unit)
      }
    var m: Move
    switch gesture?.kind {
    case .nudge(let current)?: m = current
    case nil:
      guard let made = makeMove(doc.selection) else { return }
      m = made
    default: return
    }
    nudging.insert(e.keyCode)
    m.d.dx += d.dx
    m.d.dy += d.dy
    gesture = Gesture(kind: .nudge(m), startView: .zero, start: .zero)
    showMove(m)
  }

  public override func resignFirstResponder() -> Bool {
    if case .nudge(let m)? = gesture?.kind {
      nudging = []
      commitMove(m)
    }
    return super.resignFirstResponder()
  }

  // MARK: Commands (the Edit menu and the context menu)

  @objc public func undo(_ sender: Any?) { document?.undo() }
  @objc public func redo(_ sender: Any?) { document?.redo() }

  @objc public override func selectAll(_ sender: Any?) {
    guard let doc = document else { return }
    let b = doc.board
    doc.select(
      Set(b.cards.filter { !b.isLocked(.card($0.id)) && index(of: .card($0.id)) != nil }.map { .card($0.id) })
        .union(b.sections.filter { !b.isLocked(section: $0.id) }.map { .section($0.id) }))
  }

  @objc public func delete(_ sender: Any?) {
    guard let doc = document, gesture == nil, !doc.selection.isEmpty else { return }
    doc.edit("Delete", selection: []) { $0.delete(doc.selection) }
  }

  @objc public func copy(_ sender: Any?) {
    guard let doc = document, let (_, vault) = shown, !doc.selection.isEmpty else { return }
    let clip = doc.board.clip(doc.selection) { try? vault.sharedCard($0) }
    guard !clip.isEmpty, let data = try? clip.encoded() else { return }
    pasteboard.clearContents()
    pasteboard.setData(data, forType: NSPasteboard.PasteboardType(Clip.pasteboardType))
    lastPaste = nil
  }

  @objc public func cut(_ sender: Any?) {
    copy(sender)
    guard let doc = document, gesture == nil else { return }
    doc.edit("Cut", selection: []) { $0.delete(doc.selection) }
  }

  /// Pastes plain copies: beside what was copied when that is in view (each paste a step further), else in the middle of
  /// the view
  @objc public func paste(_ sender: Any?) {
    guard document != nil, gesture == nil,
      let data = pasteboard.data(forType: NSPasteboard.PasteboardType(Clip.pasteboardType)),
      let clip = try? Clip(decoding: data), let box = clip.bounds
    else { return }
    let view = camera.visible(bounds.size)
    var dx: Double
    var dy: Double
    if let last = lastPaste, last.clip == data {
      (dx, dy) = (last.dx + 24, last.dy + 24)
    } else if view.intersects(CGRect(x: box.x, y: box.y, width: box.maxX - box.x, height: box.maxY - box.y)) {
      (dx, dy) = (24, 24)
    } else {
      dx = (view.midX - (box.x + box.maxX) / 2).rounded()
      dy = (view.midY - (box.y + box.maxY) / 2).rounded()
    }
    lastPaste = (data, dx, dy)
    place(clip, dx: dx, dy: dy, name: "Paste")
  }

  /// ⌘D: copies 48 down and to the right (core duplicateCards)
  @objc public func duplicate(_ sender: Any?) {
    guard let doc = document, let (_, vault) = shown, gesture == nil, !doc.selection.isEmpty else { return }
    let clip = doc.board.clip(doc.selection) { try? vault.sharedCard($0) }
    guard !clip.isEmpty else { return }
    place(clip, dx: 48, dy: 48, name: "Duplicate")
  }

  private func place(_ clip: Clip, dx: Double, dy: Double, name: String) {
    guard let doc = document else { return }
    var b = doc.board
    let made = b.paste(clip, dx: dx, dy: dy)
    doc.edit(name, selection: made) { $0 = b }
  }

  @objc public func bringToFront(_ sender: Any?) { arrange(front: true) }
  @objc public func sendToBack(_ sender: Any?) { arrange(front: false) }

  private func arrange(front: Bool) {
    guard let doc = document, gesture == nil else { return }
    let ids = Set(doc.selection.compactMap(\.card))
    doc.edit(front ? "Bring to Front" : "Send to Back") { $0.arrange(ids, toFront: front) }
  }

  @objc public func lock(_ sender: Any?) {
    guard let doc = document, gesture == nil, !doc.selection.isEmpty else { return }
    let all = doc.selection.allSatisfy(isOwnLock)
    doc.edit(all ? "Unlock" : "Lock") { $0.setLocked(doc.selection, !all) }
  }

  @objc public func tilt(_ sender: Any?) {
    guard let doc = document, gesture == nil else { return }
    let ids = Set(doc.selection.compactMap(\.card))
    let all = ids.allSatisfy { doc.board.card($0)?.tilted == true }
    doc.edit("Tilt") { $0.setTilted(ids, !all) }
  }

  /// Locked itself (not only through a Section it is in)
  private func isOwnLock(_ item: Item) -> Bool {
    switch item {
    case .card(let id): document?.board.card(id)?.locked == true
    case .section(let id): document?.board.section(id)?.locked == true
    }
  }

  // MARK: The context menu

  /// Only what works, in the web board's order: a card's Arrange ▸ (with Tilt and Lock), then Delete; for several items
  /// Lock, Tilt and Arrange ▸, then Cut, Copy, Duplicate and Delete; a Section's Lock and Delete; on the canvas, Paste
  public override func menu(for e: NSEvent) -> NSMenu? {
    guard let doc = document, gesture == nil else { return nil }
    // it acts on what is under the pointer, selected first when it is not
    let p = camera.board(convert(e.locationInWindow, from: nil))
    let under = hitCard(p).map(Item.card) ?? hitSectionTitle(p).map(Item.section) ?? deepestSection(p).map(Item.section)
    if let under, !doc.selection.contains(under) { doc.select([under]) } else if under == nil { doc.select([]) }
    let menu = NSMenu()
    func add(_ title: String, _ action: Selector, to m: NSMenu = menu) {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
      i.target = self
      m.addItem(i)
    }
    let sel = doc.selection
    let cards = sel.compactMap(\.card)
    let locked = !sel.isEmpty && sel.allSatisfy(isOwnLock)
    let tilted = !cards.isEmpty && cards.allSatisfy { doc.board.card($0)?.tilted == true }
    if sel.isEmpty {
      guard pasteboard.data(forType: NSPasteboard.PasteboardType(Clip.pasteboardType)) != nil else { return nil }
      add("Paste", #selector(paste(_:)))
      return menu
    }
    let arrange = NSMenu()
    add("Bring to Front", #selector(bringToFront(_:)), to: arrange)
    add("Send to Back", #selector(sendToBack(_:)), to: arrange)
    if sel.count == 1, !cards.isEmpty {
      arrange.addItem(.separator())
      add("Tilt", #selector(tilt(_:)), to: arrange)
      arrange.items.last?.state = tilted ? .on : .off
      add(locked ? "Unlock" : "Lock", #selector(lock(_:)), to: arrange)
      menu.addItem(withTitle: "Arrange", action: nil, keyEquivalent: "").submenu = arrange
    } else if sel.count == 1 {
      add(locked ? "Unlock" : "Lock", #selector(lock(_:)))
    } else {
      add(locked ? "Unlock" : "Lock", #selector(lock(_:)))
      if !cards.isEmpty {
        add("Tilt", #selector(tilt(_:)))
        menu.items.last?.state = tilted ? .on : .off
        menu.addItem(withTitle: "Arrange", action: nil, keyEquivalent: "").submenu = arrange
      }
      menu.addItem(.separator())
      add("Cut", #selector(cut(_:)))
      add("Copy", #selector(copy(_:)))
      add("Duplicate", #selector(duplicate(_:)))
    }
    if sel.count == 1 { menu.addItem(.separator()) }
    add("Delete", #selector(delete(_:)))
    return menu
  }
}

extension CanvasView: NSMenuItemValidation {
  public func validateMenuItem(_ item: NSMenuItem) -> Bool {
    guard let doc = document else { return false }
    let sel = doc.selection
    switch item.action {
    case #selector(undo(_:)):
      item.title = doc.undoName.map { "Undo \($0)" } ?? "Undo"
      return doc.history.canUndo && gesture == nil
    case #selector(redo(_:)):
      item.title = doc.redoName.map { "Redo \($0)" } ?? "Redo"
      return doc.history.canRedo && gesture == nil
    case #selector(copy(_:)), #selector(duplicate(_:)): return !sel.isEmpty
    case #selector(cut(_:)), #selector(delete(_:)): return sel.contains { !doc.board.isLocked($0) }
    case #selector(paste(_:)):
      return pasteboard.data(forType: NSPasteboard.PasteboardType(Clip.pasteboardType)) != nil
    case #selector(bringToFront(_:)), #selector(sendToBack(_:)), #selector(tilt(_:)):
      return sel.contains { $0.card != nil }
    case #selector(lock(_:)):
      item.title = !sel.isEmpty && sel.allSatisfy(isOwnLock) ? "Unlock" : "Lock"
      return !sel.isEmpty
    default: return true
    }
  }
}

extension NoteBody {
  var isText: Bool { if case .text = self { true } else { false } }
}

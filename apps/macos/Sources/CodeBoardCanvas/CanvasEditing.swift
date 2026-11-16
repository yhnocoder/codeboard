import AppKit
import CodeBoardModel
import CodeBoardNotes
import QuartzCore
import TreeSitterHighlight

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
    /// An arrow's label dragged along its line
    case label(LabelDrag)
    /// An arrow drawn from a port, or an end of the selected one moved
    case connect(Connect)
    /// A Section's frame dragged out (the toolbar's Section)
    case draw
    /// A sticker moved or resized
    case sticker(StickerDrag)
    /// A Link List's row dragged
    case row(RowDrag)
    /// The text of the one card selected, selected at rest (CanvasRestText)
    case text(CardID)
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
  /// A pointer drag's snapping (interact.ts snapMove): what it lines up with, what moves (at the start), how fast
  var targets: [CGRect] = []
  var box = CGRect.null
  var pace: Snap.Pace?
  /// Web cards over another's title: merged into it on the release once armed (interact.ts drop "merge")
  var merge: MergeDrop?
}

struct MergeDrop: Equatable {
  var card: CardID
  /// Held there MERGE_HOLD, or ⌥ down: the release merges
  var armed: Bool
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
  /// The other cards, which a card's right and bottom edges line up with (interact.ts resizeDown targets)
  var targets: [CGRect] = []
  /// Lined up: the guides, or the size it took from another card ("same width · 240")
  var guides: [Guide] = []
  var same: String?
}

/// How near a Text's handle the pointer must be to take it (view points)
private let handleReach: CGFloat = 6
/// How far the pointer moves before a press becomes a drag (view points)
let dragSlop: CGFloat = 3

/// Arrow keys held now (keymap.ts held): which and their way, Shift, when the speed-up began, the last frame, the part
/// of a world point not moved yet
struct NudgeHold {
  /// state/timing.ts NUDGE_HOLD, NUDGE_RAMP (ms), NUDGE_SPEED (points a ms on screen), NUDGE_MAX
  static let hold = 300.0
  static let ramp = 1500.0
  static let speed = 0.04
  static let most = 6.0
  var dirs: [UInt16: CGVector] = [:]
  var shift = false
  var t0: TimeInterval
  var last: TimeInterval
  var acc = CGVector.zero
}

extension CanvasView {
  // MARK: Showing a document

  /// Shows an open board and edits it: what the document changes (an edit here, undo, another writer) is shown as it
  /// changes
  public func show(_ doc: BoardDocument, at board: VaultBoard, in vault: Vault, theme: Theme) async throws {
    if document !== doc {
      stopObserving?()
      document = doc
      stopObserving = doc.observe { [weak self] in self?.documentChanged($0) }
    }
    try await load(board, in: vault, theme: theme, keepCamera: false)
  }

  /// Stops showing the document (its tab closed)
  public func leave() {
    keepCamera(now: true)
    closeRefPeek()
    cancelRefGo()
    dropEditing()
    mode = nil
    stopObserving?()
    stopObserving = nil
    document = nil
    shelfChanged()
  }

  private func documentChanged(_ change: BoardDocument.Change) {
    guard let doc = document else { return }
    chipFollowBoard()
    // a draft of the card being written in: the web view shows it already; its picture comes when the writing ends
    if change == .draft { return drawChrome() }
    // only the selection changed (a marquee under way too): its rings follow at once
    if doc.board != shownBoard { refresh() } else { drawChrome() }
    shelfChanged()
  }

  /// Makes the scene again from the document's board: drawings that did not change are reused with their bitmaps; what
  /// changed is measured and drawn (at the zoom shown, when in view) before anything is swapped in
  package func refresh() {
    guard let doc = document, let (vb, vault) = shown, let old = scene else { return }
    guard gesture == nil else {
      pendingRefresh = true
      return
    }
    pendingRefresh = false
    refreshes += 1
    let n = refreshes
    let board = doc.board
    let (theme, display, images, backing) = (self.theme, self.display, self.images, self.backing)
    let known = measured
    let knownInline = measuredInline
    let fit = fitZoom
    let seen = vaultSeen
    let zoom = camera.zoom
    let view = camera.visible(bounds.size)
    let highlighter = CanvasView.highlighter
    let fetching = Set(webFetching.filter { !$0.contains("/") }.map(CardID.init(rawValue:)))
    fetchPictures(board)
    let remote = remotePictures
    refreshing = Task {
      let r = await Task.detached(priority: .userInitiated) {
        let package = vault.url(of: vb.path)
        let ms = Scene.measures(board, package: package, vault: vault)
        var sizes: [CardID: NoteMetrics] = [:]
        var todo: [Scene.Measure] = []
        for m in ms {
          if let k = known[m.card], k.note == m.note, k.width == m.width {
            sizes[m.card] = k.size
          } else {
            todo.append(m)
          }
        }
        sizes.merge(await CanvasView.measure(todo, theme: theme, display: display)) { a, _ in a }
        // the Always Show sidenotes in code cards, measured again only when changed
        let ims = Scene.inlineMeasures(board, package: package, vault: vault, theme: theme)
        var inline: [SidenoteID: NoteMetrics] = [:]
        var inlineTodo: [Scene.Measure] = []
        for m in ims {
          guard let id = m.sidenote else { continue }
          if let k = knownInline[id], k.note == m.note, k.width == m.width {
            inline[id] = k.size
          } else {
            inlineTodo.append(m)
          }
        }
        inline.merge(await CanvasView.measureInline(inlineTodo, theme: theme, display: display)) { a, _ in a }
        let s = Scene(
          board, package: package, vault: vault, theme: theme, highlighter: highlighter ?? Highlighter(), sizes: sizes,
          inline: inline, reusing: old, vaultSeen: seen, fetching: fetching, remote: remote)
        var before: [Scene.Owner: Scene.Item] = [:]
        for it in old.items { if let o = it.owner { before[o] = it } }
        var fresh: [Int: Fresh] = [:]
        for (i, it) in s.items.enumerated() where !CanvasView.keeps(it.owner.flatMap { before[$0] }, it, s.reused) {
          fresh[i] = await CanvasView.draw(
            it, fit: fit, zoom: zoom, view: view, backing: backing, theme: theme, images: images, display: display)
        }
        return (s, fresh, ms, sizes, ims, inline)
      }.value
      guard n == refreshes, document === doc else { return }
      guard gesture == nil else {
        pendingRefresh = true
        return
      }
      shownBoard = board
      measured = [:]
      for m in r.2 { if let size = r.3[m.card] { measured[m.card] = (m.note, m.width, size) } }
      measuredInline = [:]
      for m in r.4 { if let id = m.sidenote, let size = r.5[id] { measuredInline[id] = (m.note, m.width, size) } }
      reinstall(r.0, fresh: r.1)
      if let f = flyingOut, f.cards.allSatisfy({ index(of: .card($0)) != nil }) {
        flyingOut = nil
        flyOut(f)
      }
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
    display: any NoteDisplay
  ) async -> Fresh {
    func bitmap(_ scale: CGFloat) async -> (IOSurface?, NoteFace) {
      guard it.drawing.byRenderer else {
        return (render(it, scale: scale, theme: theme, images: images).surface, .drawn)
      }
      if let snap = await picture(it, scale: scale, theme: theme, display: display, priority: 0),
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
    // where the frames and titles are shown now, to ease from
    var shownFrames: [SectionID: CGRect] = [:]
    for (i, l) in (sections.sublayers ?? []).enumerated() where i < old.frames.count {
      shownFrames[old.frames[i].id] = (l.presentation() ?? l).frame
    }
    var movedTitles: [(CALayer, CGPoint)] = []
    withoutAnimation {
      for (i, it) in s.items.enumerated() {
        if let f = fresh[i] {
          let l = ItemLayers(it, overview: f.overview, shadow: it.drawing.framed ? shadow : nil)
          if let (surface, scale) = f.sharp {
            l.fill(l.held, surface, scale: scale)
            l.heldSurface = surface
            l.heldScale = scale
          }
          next.append(l)
        } else if let o = it.owner, let l = byOwner[o] {
          l.box.zPosition = 0
          l.box.setAffineTransform(it.tilt == 0 ? .identity : CGAffineTransform(rotationAngle: it.tilt))
          let to = CGPoint(x: it.rect.midX, y: it.rect.midY)
          if case .sectionTitle = o, l.box.position != to { movedTitles.append((l.box, l.box.position)) }
          l.box.position = to
          next.append(l)
        }
      }
      // every layer is at zPosition 0 again
      raised = nil
      for l in [below, cards, above, kept, liftedLayer] { l.sublayers = nil }
      for (i, l) in next.enumerated() { home(of: i, in: s).addSublayer(l.box) }
      sections.sublayers = nil
      for f in s.frames { sections.addSublayer(CanvasView.frameLayer(f, theme)) }
      dropLayer.sublayers = nil
      dropLit = []
      arrows.sublayers = nil
      arrowGroups = s.arrows.map { a in
        let ls = CanvasView.arrowLayers(a, theme)
        for l in ls { arrows.addSublayer(l) }
        return ls
      }
    }
    scene = s
    items = next
    // cards let go a moment ago go on landing over the others
    withoutAnimation { relanding() }
    easeFrames(from: shownFrames, in: s)
    for (l, from) in movedTitles {
      let a = CASpringAnimation(keyPath: "position")
      a.stiffness = 2500
      a.damping = 100
      a.fromValue = NSValue(point: from)
      a.toValue = NSValue(point: l.position)
      a.duration = a.settlingDuration
      l.add(a, forKey: "ease")
    }
    routedArrows = [:]
    showTidySlide()
    if let h = hoveredArrow, !s.arrows.contains(where: { $0.id == h }) { hoveredArrow = nil }
    fieldShown()
    if let h = hoveredCard, index(of: .card(h)) == nil {
      hoveredCard = nil
      hoveredLine = nil
      hoveredPort = nil
    }
    // what is being written stays hidden under its field
    if let ip = inPlace, let li = inPlaceItem(ip.what) {
      withoutAnimation { items[li].box.isHidden = true }
    }
    hoveredMark = nil
    placeMarks()
    if openPop != nil { refreshPop() }
    questionsChanged()
    summariesChanged()
    // a swap made here otherwise reaches the screen a frame later than the layers it replaces go
    CATransaction.flush()
    arrive()
    drawChrome()
    lastInstall = (CACurrentMediaTime() - started, fresh.count)
    // another writer changed the board while a card is written in: it keeps its paper, the web view its place
    if editing?.ready == true, editing?.ending == false, editing?.zooming == false {
      editingOriginal = nil
      withoutAnimation {
        showPaper()
        positionEditor()
      }
    }
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
        it, fit: fit, zoom: zoom, view: view, backing: backing, theme: theme, images: images, display: display)
    }
    reinstall(s, fresh: fresh)
  }

  // MARK: Hit testing

  /// The topmost card drawn at a board point (`skip`: as if these were not there, the cards a drag carries)
  func hitCard(_ p: CGPoint, skip: Set<CardID> = []) -> CardID? {
    guard let s = scene else { return nil }
    // the kept cards (sub-boards, Texts, Boxes) are drawn over the others, so they are hit first; at the summary level
    // only they are there
    // a Text or Box selected alone is drawn over the cards round it (raiseText), so it is hit first
    if let r = raised, r < s.items.count, case .card(let id)? = s.items[r].owner, s.items[r].rect.contains(p) {
      return id
    }
    let all = s.items[s.cardsFrom..<s.labelsFrom].reversed()
    let order = all.filter(\.kept) + (levels.level == .summaries ? [] : all.filter { !$0.kept })
    for it in order {
      guard case .card(let id)? = it.owner, !skip.contains(id) else { continue }
      if it.rect.contains(p) { return id }
      // a sub-board card's name and count above it are the card's
      if case .board = it.drawing,
        CGRect(x: it.rect.minX, y: it.rect.minY - Drawing.subHead, width: it.rect.width, height: Drawing.subHead - 12)
          .contains(p)
      {
        return id
      }
    }
    return nil
  }

  func hitSectionTitle(_ p: CGPoint) -> SectionID? {
    guard let s = scene else { return nil }
    if let (id, a) = sectionAct(at: p) ?? fadedSectionAct(at: p), a == .grip { return id }
    // the whole strip of the Section whose controls show, but its buttons (main's .slabel: the title, the gaps between
    // the chevron and the buttons and between them)
    if let id = actsSection, let r = sectionTitle(id), sectionAct(at: p) == nil,
      actsLayout(id).map(\.1).reduce(r, { $0.union($1) }).contains(p)
    {
      return id
    }
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
    case .arrow, .sticker: return nil
    }
    guard var rect = r else { return nil }
    if case .card(let id) = item, editing?.id == id { rect = editingRect(rect) }
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

  /// The selection's rings and a selected Text's or Box's handles, in the theme's accent; line widths in view points
  /// whatever the zoom
  func drawChrome() {
    guard let doc = document, scene != nil else {
      chrome.sublayers = nil
      litArrows.sublayers = nil
      placeAlignBar()
      return
    }
    switch gesture?.kind {
    case .move?: break
    case .resize(let z)?:
      showGuides(z.guides)
      showSizeHint(z)
    default:
      snapSettle?.cancel()
      showGuides([])
      showSizeHint(nil)
    }
    let z = camera.zoom
    let before = selectedLooks
    selectedLooks = [:]
    defer {
      for (id, ls) in before where selectedLooks[id] == nil { Self.fadeOut(ls) }
    }
    withoutAnimation {
      chrome.sublayers = nil
      litArrows.sublayers = nil
      drawArrowChrome()
      drawMergeDrop()
      for item in doc.selection {
        if case .sticker(let id) = item {
          stickerChrome(id)
          continue
        }
        guard let r = liveRect(item) else { continue }
        switch item {
        case .card(let id):
          guard let i = index(of: .card(id)) else { continue }
          let box = items[i].box
          let old = before[id] ?? []
          let looks = selectedLook(id, box.bounds, tilt: 0, into: box, fadeIn: old.isEmpty)
          // drawn again while it comes in: it goes on coming in, not from the start
          for l in looks {
            if let was = old.first(where: { $0.name == l.name }), let a = was.animation(forKey: "in") {
              l.add(a, forKey: "in")
            }
          }
          for l in old { l.removeFromSuperlayer() }
          selectedLooks[id] = looks
        case .section(let id):
          if theme.id == .inkWash, let f = scene?.frames.first(where: { $0.id == id }), let strokes = f.strokes {
            brushed(r, strokes: strokes.cg)
          } else {
            framed(r, zoom: z)
          }
        // an arrow's selected look is its own (selectArrows)
        case .arrow, .sticker: break
        }
      }
      toneTitles()
      raiseText()
      if let bar = barLayer() { chrome.addSublayer(bar) }
      if let chip = chipLayer() { chrome.addSublayer(chip) }
      if let acts = sectionActsLayer() { chrome.addSublayer(acts) }
      drawHoverLine()
      placeHeadActs()
      if restText != nil { drawRestText() }
      placeAlignBar()
      drawPorts()
      drawConnect()
      placeTextHandles()
    }
  }

  /// The Texts and Boxes whose handles show: every one selected and not locked (styles.css .card.text.sel .hw,
  /// .mkgrip; .card.locked .hw); every other kind is resized by its edges, which only the pointer's shape tells
  var textHandleCards: Set<CardID> {
    guard let doc = document else { return [] }
    switch gesture?.kind {
    case .move?, .nudge?, .marquee?: return []
    default: break
    }
    return Set(doc.selection.compactMap(\.card).filter { isText($0) && !doc.board.isLocked(.card($0)) })
  }

  /// The handles in each card's own layer, as main's are in the card: over its content and selected look, under its
  /// stickers, and under a card drawn over it unless it comes up (raiseText)
  private func placeTextHandles() {
    for l in textHandleLayers { l.removeFromSuperlayer() }
    textHandleLayers = []
    for id in textHandleCards {
      guard let i = index(of: .card(id)) else { continue }
      let box = items[i].box
      for (_, r) in textHandles(id) {
        let o = box.convert(r.origin, from: box.superlayer)
        let l = CAShapeLayer()
        let radius = r.height > 12 ? 4.0 : 3.0
        l.path = CGPath(
          roundedRect: CGRect(origin: o, size: r.size), cornerWidth: radius, cornerHeight: radius, transform: nil)
        l.fillColor = theme.surface
        l.strokeColor = theme.accent
        l.lineWidth = 1.5
        l.zPosition = 3.6
        box.addSublayer(l)
        textHandleLayers.append(l)
      }
    }
  }

  /// A selected card's look at `r` in `parent` (the card's own layer, or a picture of it): a Text's or Box's outline,
  /// Ink Wash's seal, else the ring; `fadeIn`: it was not selected before, so it comes in as main's does. Its layers
  @discardableResult
  func selectedLook(_ id: CardID, _ r: CGRect, tilt: CGFloat, into parent: CALayer, fadeIn: Bool = false) -> [CALayer] {
    let looks: [CALayer]
    if isText(id) {
      looks = [outline(r, box: isBox(id), tilt: tilt)]
    } else if theme.id == .inkWash {
      looks = [seal(on: r, tilt: tilt)]
    } else {
      looks = ring(r, tilt: tilt)
      if fadeIn { looks.forEach(Self.fadeIn) }
    }
    for l in looks {
      // over the card's content, under its stickers and markers
      l.zPosition = 3
      parent.addSublayer(l)
    }
    return looks
  }

  /// A line that is `w` on the board, never thinner on screen than a pixel
  func boardLine(_ w: CGFloat) -> CGFloat { max(w, 1 / (camera.zoom * backing)) }

  /// A selected card's ring in Warm Ink (themes.css .card > .cface::before: `0 0 0 1.5px accent, 0 0 4px 3px accent
  /// 20%`, round as the card): a 1.5 line of the accent hugging the card on its own squircle corner, over a glow of it
  /// blurred 4 and spread 3, outside the card only; sizes on the board, so they zoom with it
  private func ring(_ r: CGRect, tilt: CGFloat) -> [CALayer] {
    func turned(_ l: CALayer) -> CALayer {
      l.frame = r
      l.bounds = CGRect(origin: r.origin, size: r.size)
      if tilt != 0 { l.setAffineTransform(CGAffineTransform(rotationAngle: tilt)) }
      return l
    }
    let glow = CALayer()
    glow.name = "glow"
    glow.shadowPath = Drawing.squircle(r.insetBy(dx: -3, dy: -3), theme.cardRadius + 3)
    glow.shadowColor = theme.accent
    glow.shadowOpacity = 0.2
    glow.shadowRadius = 2
    glow.shadowOffset = .zero
    // a box shadow: none under the card
    let mask = CAShapeLayer()
    let around = CGMutablePath()
    around.addRect(r.insetBy(dx: -20, dy: -20))
    around.addPath(Drawing.squircle(r, theme.cardRadius))
    mask.path = around
    mask.fillRule = .evenOdd
    glow.mask = mask
    let w = boardLine(1.5)
    let line = CAShapeLayer()
    line.name = "ring"
    line.path = Drawing.squircle(r.insetBy(dx: -w / 2, dy: -w / 2), theme.cardRadius + w / 2)
    line.fillColor = nil
    line.strokeColor = theme.accent
    line.lineWidth = w
    return [turned(glow), turned(line)]
  }

  /// A ring coming in (themes.css .card.sel > .cface::before): 120 ms, from 98.5 % of its size
  static func fadeIn(_ l: CALayer) {
    let o = CABasicAnimation(keyPath: "opacity")
    o.fromValue = 0
    o.toValue = 1
    let k = CABasicAnimation(keyPath: "transform.scale")
    k.fromValue = 0.985
    k.toValue = 1
    let g = CAAnimationGroup()
    g.animations = [o, k]
    g.duration = 0.12
    g.timingFunction = CAMediaTimingFunction(name: .easeOut)
    l.add(g, forKey: "in")
  }

  /// A card's look when it is no longer selected: out over 90 ms where it is, then gone
  static func fadeOut(_ ls: [CALayer]) {
    CATransaction.begin()
    CATransaction.setCompletionBlock {
      MainActor.assumeIsolated { for l in ls where l.opacity == 0 { l.removeFromSuperlayer() } }
    }
    for l in ls {
      l.removeAnimation(forKey: "in")
      l.opacity = 0
      let o = CABasicAnimation(keyPath: "opacity")
      o.fromValue = 1
      o.toValue = 0
      o.duration = 0.09
      o.timingFunction = CAMediaTimingFunction(name: .easeIn)
      l.add(o, forKey: "out")
    }
    CATransaction.commit()
  }

  /// Ink Wash's selected card (themes.css #128): a small vermilion seal 选 over its top right corner, 24 board units
  /// square, its middle 7 out and 5 up from the corner, turned 6 degrees; no ring
  private func seal(on r: CGRect, tilt: CGFloat) -> CALayer {
    let box = CALayer()
    box.name = "seal"
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
    let colour = theme.sectionSelected
    let wash = CAShapeLayer()
    wash.path = Drawing.squircle(r, theme.sectionRadius)
    wash.fillColor = colour.copy(alpha: 0.07)
    wash.strokeColor = colour
    wash.lineWidth = boardLine(0.5)
    let halo = CAShapeLayer()
    let out: CGFloat = 1.5
    halo.path = Drawing.squircle(r.insetBy(dx: -out, dy: -out), theme.sectionRadius + out)
    halo.fillColor = nil
    halo.strokeColor = colour.copy(alpha: 0.18)
    halo.lineWidth = 3
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
  /// (3 from a Box), round as the card's corners; hovered, `w` 1 in `color`, dashed on a Text
  private func outline(
    _ r: CGRect, box: Bool, tilt: CGFloat, width: CGFloat = 1.5, color: CGColor? = nil, dashed: Bool = false
  ) -> CAShapeLayer {
    let gap: CGFloat = box ? 3 : 2
    let w = boardLine(width)
    let o = r.insetBy(dx: -gap - w / 2, dy: -gap - w / 2)
    let l = CAShapeLayer()
    l.bounds = CGRect(origin: .zero, size: o.size)
    l.position = CGPoint(x: o.midX, y: o.midY)
    let radius = (box ? theme.cardRadius : 5.5) + gap + w / 2
    l.path = CGPath(roundedRect: l.bounds, cornerWidth: radius, cornerHeight: radius, transform: nil)
    l.fillColor = nil
    l.strokeColor = color ?? theme.accent
    l.lineWidth = w
    if dashed { l.lineDashPattern = [NSNumber(value: 3 * w), NSNumber(value: 3 * w)] }
    if tilt != 0 { l.setAffineTransform(CGAffineTransform(rotationAngle: tilt)) }
    l.name = "outline"
    return l
  }

  /// The Text or Box under the pointer, not selected: a dashed line of the faint ink round a Text, a line of the accent at
  /// 45 % round a Box (styles.css .card.text:hover, .card.text.box:hover:not(.sel)), in its layer
  func drawHoverLine() {
    hoverLine?.removeFromSuperlayer()
    hoverLine = nil
    // none while a card is dragged or anything else is under way, as main's
    guard gesture == nil, let id = hoveredCard, isText(id), document?.selection.contains(.card(id)) == false,
      let i = index(of: .card(id))
    else { return }
    let box = items[i].box
    let b = isBox(id)
    let l = outline(
      box.bounds, box: b, tilt: 0, width: 1, color: b ? theme.accent.copy(alpha: 0.45) : theme.ink3, dashed: !b)
    l.name = "hover"
    l.zPosition = 3
    box.addSublayer(l)
    hoverLine = l
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
    case .section(let id):
      // folded: no handles (only its title shows)
      if document?.board.section(id)?.collapsed == true { return [] }
      return [.left, .right, .top, .bottom, [.left, .top], [.right, .top], [.left, .bottom], [.right, .bottom]]
    case .arrow, .sticker: return []
    case .card(let id):
      guard let s = scene, let i = index(of: .card(id)), s.items[i].tilt == 0 else { return [] }
      switch s.items[i].drawing {
      case .note(let n) where n.content.isText: return [.left, .right, [.right, .bottom]]
      case .image: return [.right, [.right, .bottom]]
      case .code, .note, .board: return [.left, .right, .bottom, [.right, .bottom]]
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
      let card = CGRect(origin: camera.view(r.origin), size: CGSize(width: r.width * z, height: r.height * z))
      for (e, h) in textHandles(id) {
        let q = CGRect(origin: camera.view(h.origin), size: CGSize(width: h.width * z, height: h.height * z))
        // the side grips lie wholly outside the card (.hw at -8): a press on the card itself, its edge too, drags it
        let side = e == .left || e == .right
        if q.insetBy(dx: -handleReach / 2, dy: -handleReach / 2).contains(v), !(side && card.contains(v)) { return e }
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
    // every selected Text's and Box's handles (.card.text.sel .hw)
    for id in textHandleCards {
      if let e = edge(of: .card(id), at: v) { return (.card(id), e) }
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
    // any open Section's edges and corners, selected or not (Sections.tsx .sedge)
    for f in (scene?.frames ?? []).reversed() where !f.folded && !doc.board.isLocked(section: f.id) {
      if let e = CanvasView.sectionEdge(f.rect, at: p) { return (.section(f.id), e) }
    }
    return nil
  }

  /// A frame's edge or corner under a board point: 8 across each edge, 10 in from the corners, which take 14 square
  /// reaching 5 out (styles.css .sect .sedge)
  static func sectionEdge(_ r: CGRect, at p: CGPoint) -> Resize.Edges? {
    let corners: [(Resize.Edges, CGPoint)] = [
      ([.left, .top], CGPoint(x: r.minX - 5, y: r.minY - 5)), ([.right, .top], CGPoint(x: r.maxX - 9, y: r.minY - 5)),
      ([.left, .bottom], CGPoint(x: r.minX - 5, y: r.maxY - 9)),
      ([.right, .bottom], CGPoint(x: r.maxX - 9, y: r.maxY - 9)),
    ]
    for (e, o) in corners where CGRect(origin: o, size: CGSize(width: 14, height: 14)).contains(p) { return e }
    let across = (r.minX + 10)...(r.maxX - 10)
    let down = (r.minY + 10)...(r.maxY - 10)
    if across.contains(p.x), abs(p.y - r.minY) <= 4 { return .top }
    if across.contains(p.x), abs(p.y - r.maxY) <= 4 { return .bottom }
    if down.contains(p.y), abs(p.x - r.minX) <= 4 { return .left }
    if down.contains(p.y), abs(p.x - r.maxX) <= 4 { return .right }
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
      NSTrackingArea(
        rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
  }

  public override func mouseMoved(with e: NSEvent) {
    pointerInWindow = e.locationInWindow
    rehover(convert(e.locationInWindow, from: nil))
  }

  /// What is under the pointer at a view point: hovered, its cursor set. Also when the board moves under a pointer at
  /// rest, as the web board's :hover and pointer moves follow it
  func rehover(_ v: CGPoint) {
    guard gesture == nil else { return }
    var onSticker: StickerID?
    defer { hoverSticker(onSticker) }
    if spaceHeld { return NSCursor.openHand.set() }
    hoverChip(at: camera.board(v))
    let onBar = alignBarButton(at: v)
    hoverAlignBar(onBar ?? nil)
    if onBar != nil {
      NSCursor.arrow.set()
      hoverHead(nil)
      hover(nil)
      return
    }
    if chipInside {
      NSCursor.arrow.set()
      hover(nil)
      return
    }
    if levels.level == .summaries {
      let p = camera.board(v)
      let b = summaryButton(at: p)
      if b == nil { hoverSummary(summaryColumn(at: p).map { summaryColumns[$0].col.key }) }
      if b?.key != summaryButtonHover?.key || b?.keep != summaryButtonHover?.keep {
        summaryButtonHover = b
        showTip()
      }
      (b != nil ? NSCursor.pointingHand : NSCursor.arrow).set()
      return
    }
    if placing != nil {
      moveGhost(to: v)
      NSCursor.arrow.set()
      return
    }
    // a Link List's row: tinted, its ⋮⋮ and tools shown
    hoverRow(at: camera.board(v))
    // a card header's button: the arrow over it, its card hovered
    let head = headAct(at: camera.board(v))
    hoverHead(head)
    if head != nil {
      hoverPorts(at: v)
      NSCursor.arrow.set()
      hover(nil)
      return
    }
    if hitStickerGrip(v) != nil {
      resizeCursor([.right, .bottom]).set()
      hover(nil)
      return
    }
    if let i = stickerAt(camera.board(v)), markAt(camera.board(v)) == nil {
      (stickerSpots[i].line ? NSCursor.pointingHand : NSCursor.openHand).set()
      onSticker = stickerSpots[i].id
      hover(nil)
      return
    }
    let twin = twinMark(at: camera.board(v))
    if twin != hoveredTwin {
      hoveredTwin = twin
      placeMarks()
    }
    let mark = markAt(camera.board(v))
    hoverMark(mark)
    if mark != nil || twin != nil {
      NSCursor.pointingHand.set()
      hover(nil)
      return
    }
    // a Section's title, its grip and its controls: all the arrow, as main's buttons and chrome (styles.css)
    let bp = camera.board(v)
    if hitCard(bp) == nil, let id = titleHover(at: bp) {
      // hovered first, so its controls are there to be found on the first move onto it too
      if id != hoveredTitle { hoverTitle(id, act: nil) }
      hoverTitle(id, act: sectionAct(at: bp)?.1)
      NSCursor.arrow.set()
      hover(nil)
      return
    }
    hoverTitle(nil, act: nil)
    hoverPorts(at: v)
    let port = hitPort(v) != nil || hitEndHandle(v) != nil
    let arrow = hitHandle(v) == nil && !port ? arrowAt(camera.board(v)) : nil
    if port || mode != nil {
      NSCursor.crosshair.set()
    } else if let (_, edge) = hitHandle(v) {
      resizeCursor(edge).set()
    } else if arrow != nil {
      NSCursor.pointingHand.set()
    } else if hoveredRow?.grip == true {
      // .lgrip: cursor grab
      NSCursor.openHand.set()
    } else {
      NSCursor.arrow.set()
    }
    hover(arrow)
  }

  public override func mouseExited(with e: NSEvent) {
    pointerInWindow = nil
    hoverChip(at: CGPoint(x: CGFloat.infinity, y: .infinity))
    hoverAlignBar(nil)
    hoverHead(nil)
    hoverRow(at: CGPoint(x: CGFloat.infinity, y: .infinity))
    hoverTitle(nil, act: nil)
    hoverSummary(nil)
    hover(nil)
    hoverMark(nil)
    guard gesture == nil, hoveredCard != nil else { return }
    hoveredCard = nil
    hoveredLine = nil
    hoveredPort = nil
    drawChrome()
  }

  // MARK: Pointer

  public override func mouseDown(with e: NSEvent) {
    if opening { return }
    // a press anywhere hides a button's tip (main's TooltipLayer on pointerdown)
    tips.press()
    dropPicture()
    // a press anywhere puts away a row's bookmark (WebBody.tsx: pointerdown leaves the row)
    closeRowPeek()
    // and the text selected at rest (the browser's selection goes with a press)
    clearRestText()
    if spacePanDown(e) { return }
    // a press anywhere but in it writes the description being written (its editor takes its own presses)
    if descWriting != nil { endDesc() }
    // a header button of the card written in (its M↓, its ···): the writing goes on, the keys stay in the editor
    if let ed = editing, ed.writer != nil,
      let (id, a) = headAct(at: camera.board(convert(e.locationInWindow, from: nil))), id == ed.id
    {
      if e.clickCount == 1 {
        hold(
          over: { [weak self] in self?.headAct(at: $0).map { $0 == (id, a) } == true },
          act: { [weak self] in self?.press(a, of: id) })
      }
      return
    }
    // AppKit sends a multi-click's later presses to the view its first went to: a double-click's second press over the
    // editor its first press opened is the editor's, as in main
    if let w = writingView, let sv = w.superview,
      w.hitTest(sv.convert(e.locationInWindow, from: nil)) != nil
    {
      pressToEditor = true
      window?.makeFirstResponder(w)
      return w.mouseDown(with: e)
    }
    // on the paper of the card written in natively, off its text: below the text the caret goes to the end, beside it
    // nothing changes; the writing goes on
    if let ed = editing, let v = ed.writer, hitCard(camera.board(convert(e.locationInWindow, from: nil))) == ed.id {
      if v.convert(e.locationInWindow, from: nil).y > v.bounds.maxY {
        v.doCommand(by: #selector(NSResponder.moveToEndOfDocument(_:)))
      }
      window?.makeFirstResponder(v)
      return
    }
    // a click outside the card being written in ends the writing; on it while its editor is still mounting (that second
    // press, which main's editor would have) the writing goes on
    if let ed = editing, ed.ready || hitCard(camera.board(convert(e.locationInWindow, from: nil))) != ed.id {
      Task { await endEditing() }
    }
    window?.makeFirstResponder(self)
    guard let doc = document, scene != nil, gesture == nil else { return }
    let v = convert(e.locationInWindow, from: nil)
    let p = camera.board(v)
    // the bar's buttons, acting on the release over them; a press anywhere else closes its panel
    if let on = alignBarButton(at: v) {
      if let b = on {
        alignPressed = b
        placeAlignBar()
      }
      return
    }
    if alignMore { setAlignMore(false) }
    // the chip's buttons; a press anywhere else closes it. A button acts on the release over it (main's .tbtn)
    if let on = chipButton(at: p) {
      if let b = on {
        chipPressed = b
        drawChrome()
      }
      return
    }
    closeChip()
    if placing != nil {
      putSticker(at: p, free: e.modifierFlags.contains(.option))
      return
    }
    if levels.level == .summaries {
      pressAtSummaries(e, view: v, board: p, doc)
      return
    }
    // a press anywhere on the board closes the sticker palette and the Shelf's large picture
    closeStickerPalette()
    closePreview()
    if case .connect(let from)? = mode {
      finishConnect(from: from, at: p)
      return
    }
    // the buttons drawn on the board act on the release over them (hold)
    if let b = barButton(at: p) {
      if e.clickCount == 1 {
        hold(over: { [weak self] in self?.barButton(at: $0) == b }, act: { [weak self] in self?.press(b) })
      }
      return
    }
    // a Section title's control; its grip is pressed as the title is
    if let (id, a) = sectionAct(at: p), a != .grip {
      if e.clickCount == 1 {
        hold(
          over: { [weak self] in self?.sectionAct(at: $0).map { $0 == (id, a) } == true },
          act: { [weak self] in self?.press(a, of: id) })
      }
      return
    }
    // a sidenote marker: its popup opens, or closes when it is open
    if let i = markAt(p) {
      guard e.clickCount == 1 else { return }
      let at = marks[i].at
      if case .spot(.point) = at, !marks[i].add {
        // a free one is dragged, or clicked when it does not move
        markDrag = (i, v, false)
      } else {
        let add = marks[i].add
        hold(
          over: { [weak self] in self?.markAt($0).map { self?.marks[$0].at == at } == true },
          act: { [weak self] in add ? self?.openAddNote(at) : self?.togglePop(at) })
      }
      return
    }
    // a card's mark of its other places (on the card, over the Section titles): the next one
    if let id = twinMark(at: p) {
      if e.clickCount == 1 {
        hold(over: { [weak self] in self?.twinMark(at: $0) == id }, act: { [weak self] in self?.showNextTwin(id) })
      }
      return
    }
    // a faded chevron, under the markers
    if let (id, a) = fadedSectionAct(at: p), a == .fold {
      if e.clickCount == 1 {
        hold(
          over: { [weak self] in
            guard let self else { return false }
            return (sectionAct(at: $0) ?? fadedSectionAct(at: $0)).map { $0 == (id, a) } == true
          }, act: { [weak self] in self?.press(a, of: id) })
      }
      return
    }
    // a card header's button
    if let (id, a) = headAct(at: p) {
      if e.clickCount == 1 {
        hold(
          over: { [weak self] in self?.headAct(at: $0).map { $0 == (id, a) } == true },
          act: { [weak self] in self?.press(a, of: id) })
      }
      return
    }
    // a press anywhere else on the board closes it (what is being written in it is added)
    if openPop != nil { openPop(nil) }
    // a sticker, or the selected one's grip
    if pressSticker(e, view: v, board: p) {
      clearLineSel()
      return
    }
    // a Web card's Retry and Edit Title; a Link List's row, dragged
    if e.clickCount == 1, let l = webLink(at: p) {
      hold(
        over: { [weak self] in self?.webLink(at: $0).map { $0 == l } == true },
        act: { [weak self] in self?.pressWebLink(l) })
      return
    }
    if pressRow(e, view: v, board: p) { return }
    // a task's checkbox on a card at rest: checked or unchecked on the release over it
    if e.clickCount == 1, let t = taskAt(p) {
      hold(
        over: { [weak self] in self?.taskAt($0).map { $0.card == t.card && $0.nth == t.nth } == true },
        act: { [weak self] in self?.toggleTask(t) })
      return
    }
    // a ref's preview closes, but on the press on its ref (which closes it too, as its second click)
    refPress = e.clickCount == 1 ? refAt(p) : nil
    if let peek = refPeek,
      !(refPress.map { peek.key == refKey(.card($0.card, boardRect($0.box, on: $0.card)), $0.box) } ?? false)
    {
      closeRefPeek()
    }
    if e.clickCount >= 2 {
      // the second press of a double-click on a ref: what its first click began is dropped; its source opens
      cancelRefGo()
      if let r = refAt(p), isWriting(r.card), let doc = document, !doc.board.isLocked(.card(r.card)) {
        let at = boardRect(r.box, on: r.card)
        Task {
          await endEditing()
          beginEditing(r.card, at: CGPoint(x: at.midX, y: at.midY))
        }
        return
      }
      // a card's grip, or a Note's bottom edge: Fit Content (Card.tsx .grip, .hb); a Text's edge or corner: nothing.
      // Just inside a card's side its body is under the pointer (the board's side handles lie outside it): written in
      if let (item, edges) = sectionEdgeOrHandle(v, p),
        !(edges.isSubset(of: [.left, .right]) && item.card != nil && hitCard(p) == item.card)
      {
        if case .card(let id) = item, !isText(id) {
          var note = false
          if case .note? = scene?.parts[id]?.content.body { note = true }
          if edges == [.right, .bottom] || edges == .bottom && note { fitCards([id]) }
        }
      } else {
        doubleClick(at: p)
      }
      return
    }
    // a port: an arrow is drawn out of it
    if let port = hitPort(v) {
      startConnect(from: port, at: v)
      drawChrome()
      return
    }
    // a code card's line numbers select lines
    if e.clickCount == 1, selectLine(at: p, extend: e.modifierFlags.contains(.shift)) { return }
    clearLineSel()
    if let (item, edges) = sectionEdgeOrHandle(v, p) {
      startResize(item, edges, at: v, p)
      return
    }
    let toggle = !e.modifierFlags.isDisjoint(with: [.shift, .command])
    var item: Item?
    if hitEndHandle(v) != nil, let id = doc.selection.first?.arrow {
      // the selected arrow's end
      item = .arrow(id)
    } else if let id = hitArrowLabel(p) {
      item = .arrow(id)
    } else if let id = hitCard(p) {
      item = .card(id)
    } else if let id = hitArrow(p) {
      // a line is drawn over the Section titles, under the cards
      item = .arrow(id)
    } else if let id = hitSectionTitle(p) {
      item = .section(id)
    } else if e.modifierFlags.contains(.command), let id = deepestSection(p) {
      // ⌘ on a Section's blank inside grabs it, as its title does
      item = .section(id)
    }
    // the toolbar's Section: a frame dragged out on the canvas
    if item == nil, mode == .drawSection {
      gesture = Gesture(kind: .draw, startView: v, start: p)
      return
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

  /// The handle or edge under the pointer, but a Section's edge gives way to an arrow's label lying on it (main's labels
  /// are over the Sections and their edges)
  func sectionEdgeOrHandle(_ v: CGPoint, _ p: CGPoint) -> (Item, Resize.Edges)? {
    guard let (item, edges) = hitHandle(v) else { return nil }
    if item.section != nil, hitArrowLabel(p) != nil { return nil }
    return (item, edges)
  }

  /// A button on the board pressed: it acts on the release over it (main's <button>, whose click is a press and a
  /// release over it), nothing when let go off it
  func hold(over: @escaping (CGPoint) -> Bool, act: @escaping () -> Void) { held = (over, act) }

  public override func mouseDragged(with e: NSEvent) {
    if pressToEditor { return writingView?.mouseDragged(with: e) ?? () }
    if spacePanDragged(e) { return }
    if chipPressed != nil { return hoverChip(at: camera.board(convert(e.locationInWindow, from: nil))) }
    if alignPressed != nil { return hoverAlignBar(alignBarButton(at: convert(e.locationInWindow, from: nil)) ?? nil) }
    if held != nil { return }
    if let d = markDrag {
      let v = convert(e.locationInWindow, from: nil)
      guard d.moved || hypot(v.x - d.from.x, v.y - d.from.y) >= dragSlop else { return }
      markDrag?.moved = true
      dragMark(d.index, to: camera.board(v))
      return
    }
    guard var g = gesture, let doc = document else { return }
    let v = convert(e.locationInWindow, from: nil)
    let p = camera.board(v)
    switch g.kind {
    case .press(let item, let toggle, let was, _):
      guard hypot(v.x - g.startView.x, v.y - g.startView.y) >= dragSlop else { return }
      // the one card selected, dragged on its body: its text is selected, the card stays (interact.ts: solo, inBody)
      if case .card(let id)? = item, was, !toggle, doc.selection == [.card(id)], restOffset(id, g.start) != nil {
        g.kind = .text(id)
        gesture = g
        return dragRestText(id, from: g.start, to: p)
      }
      if case .arrow(let id)? = item {
        // an end of the selected arrow moves to another card or line; its label slides along it; the line itself stays
        // where its cards are
        if let end = hitEndHandle(g.startView), let c = startMoveEnd(end, of: id, at: g.start) {
          g.kind = .connect(c)
          gesture = g
          mouseDragged(with: e)
        } else if hitArrowLabel(g.start) == id, let d = startLabelDrag(id, at: g.start) {
          g.kind = .label(d)
          gesture = g
          mouseDragged(with: e)
        } else {
          g.kind = .still
          gesture = g
        }
        return
      }
      if item != nil {
        guard let m = makeMove(doc.selection) else {
          g.kind = .still
          gesture = g
          return
        }
        g.kind = .move(snapping(m, from: g.startView))
      } else {
        let base = toggle ? doc.selection : []
        g.kind = .marquee(base: base)
        if !toggle { doc.select([]) }
      }
      gesture = g
      mouseDragged(with: e)
    case .move(var m):
      aimMerge(&m, at: p, alt: e.modifierFlags.contains(.option))
      dragMove(
        &m, to: v, from: g, at: e.timestamp,
        unsnapped: !e.modifierFlags.isDisjoint(with: [.command, .control]) || m.merge != nil, still: false)
      g.kind = .move(m)
      gesture = g
      showMove(m)
      armShelf(v)
    case .marquee(let base):
      let r = CGRect(
        x: min(v.x, g.startView.x), y: min(v.y, g.startView.y), width: abs(v.x - g.startView.x),
        height: abs(v.y - g.startView.y))
      showMarquee(r)
      let w = CGRect(
        origin: camera.board(r.origin), size: CGSize(width: r.width / camera.zoom, height: r.height / camera.zoom))
      var hit = base
      for it in scene?.items ?? [] {
        if case .card(let id)? = it.owner, it.rect.intersects(w), !doc.board.isLocked(.card(id)),
          it.kept || levels.level == .cards
        {
          hit.insert(.card(id))
        }
      }
      for f in scene?.frames ?? []
      where levels.level == .cards && w.contains(f.rect) && !doc.board.isLocked(section: f.id) {
        hit.insert(.section(f.id))
      }
      if hit != doc.selection { doc.select(hit) }
    case .resize(var z):
      resizeTo(
        &z, CGVector(dx: p.x - g.start.x, dy: p.y - g.start.y),
        snap: e.modifierFlags.isDisjoint(with: [.command, .control]))
      g.kind = .resize(z)
      gesture = g
      showResize(z)
    case .label(var d):
      d.t = CanvasView.dragT(d, p)
      g.kind = .label(d)
      gesture = g
      showLabelDrag(d)
    case .draw:
      showDraw(from: g.startView, to: v)
    case .connect(var c):
      // a press that has not moved yet draws nothing
      guard hypot(v.x - g.startView.x, v.y - g.startView.y) >= dragSlop || c.pointer != g.start else { return }
      dragConnect(&c, to: p)
      g.kind = .connect(c)
      gesture = g
      drawChrome()
    case .sticker(var d):
      dragSticker(&d, view: v, start: g.start, startView: g.startView)
      g.kind = .sticker(d)
      gesture = g
      drawChrome()
    case .row(var d):
      dragRow(&d, view: v)
      g.kind = .row(d)
      gesture = g
    case .text(let id):
      dragRestText(id, from: g.start, to: p)
    case .nudge, .still:
      break
    }
  }

  public override func mouseUp(with e: NSEvent) {
    if pressToEditor {
      pressToEditor = false
      return writingView?.mouseUp(with: e) ?? ()
    }
    if spacePanUp(e) { return }
    if let b = alignPressed {
      alignPressed = nil
      let over = alignBarButton(at: convert(e.locationInWindow, from: nil)) == .some(b)
      placeAlignBar()
      if over { pressAlignBar(b) }
      return
    }
    if let b = chipPressed {
      chipPressed = nil
      if chipButton(at: camera.board(convert(e.locationInWindow, from: nil))) == .some(b) {
        pasteAs(b == .reference)
      }
      return drawChrome()
    }
    if let h = held {
      held = nil
      if h.over(camera.board(convert(e.locationInWindow, from: nil))) { h.act() }
      return
    }
    if releaseSummary(at: convert(e.locationInWindow, from: nil)) { return }
    if let d = markDrag {
      markDrag = nil
      if d.moved {
        dropMark(d.index, at: camera.board(convert(e.locationInWindow, from: nil)))
      } else if d.index < marks.count {
        togglePop(marks[d.index].at)
      }
      return
    }
    guard let g = gesture, let doc = document else { return }
    switch g.kind {
    case .text:
      gesture = nil
      settleRestText()
    case .press(let item, let toggle, let was, let inside):
      gesture = nil
      // a click on a ref
      if let r = refPress {
        refPress = nil
        refClicked(
          .card(r.card, boardRect(r.box, on: r.card)), r.box.ref, r.box.target, go: e.modifierFlags.contains(.command),
          writing: false)
      } else if case .card(let id)? = item, was, !toggle, doc.selection == [.card(id)] {
        clickEdit(id, at: g.start)
      }
      if let item {
        if toggle && was {
          doc.select(doc.selection.subtracting([item]))
        } else if !toggle && doc.selection.count > 1 && !(item.card.map(isText) ?? false) {
          // one of several: only it stays, a Text all of them (it has no body to press: interact.ts multiBody)
          doc.select([item])
        }
      } else if let s = inside {
        let it = Item.section(s)
        doc.select(toggle ? doc.selection.symmetricDifference([it]) : [it])
      } else if !toggle {
        doc.select([])
      }
    case .move(let m):
      armShelf(nil)
      mergeHold?.cancel()
      if overShelf(convert(e.locationInWindow, from: nil)) {
        // let go on the Shelf's button or panel: onto the Shelf, not moved
        gesture = nil
        clearDrop()
        shelve(cards: m.cards, sections: Set(m.tops), offset: m.d)
      } else if let t = m.merge, t.armed {
        dropMerge(m, into: t.card)
      } else {
        commitMove(m)
      }
    case .marquee:
      gesture = nil
      withoutAnimation { marquee.path = nil }
      drawChrome()
    case .resize(let z):
      commitResize(z)
    case .label(let d):
      commitLabelDrag(d)
    case .connect(let c):
      commitConnect(c)
    case .draw:
      let v = convert(e.locationInWindow, from: nil)
      commitDraw(
        from: g.start, to: camera.board(v), moved: hypot(v.x - g.startView.x, v.y - g.startView.y) >= dragSlop)
    case .sticker(let d):
      let p = camera.board(convert(e.locationInWindow, from: nil))
      commitSticker(d, at: p, free: e.modifierFlags.contains(.option))
    case .row(let d):
      commitRow(d, view: convert(e.locationInWindow, from: nil))
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

  /// What a pointer drag lines up with (interact.ts startCardDrag / startSectionDrag): a card drag, every other card and
  /// every Section frame; a Section drag, the frames but its own, those inside it and those round it, and the cards
  /// outside it when it carries loose cards too
  func snapping(_ m: Move, from v: CGPoint) -> Move {
    guard let doc = document, let s = scene else { return m }
    var m = m
    m.pace = Snap.Pace(at: v, time: CACurrentMediaTime())
    let loose = m.loose.compactMap { id in index(of: .card(id)).map { s.items[$0].rect } }
    let cards: [CGRect] = s.items.compactMap { it in
      guard case .card(let id)? = it.owner, !m.cards.contains(id) else { return nil }
      return it.rect
    }
    if m.sections.isEmpty {
      m.box = loose.reduce(CGRect.null) { $0.union($1) }
      m.targets = cards + s.frames.map(\.rect)
    } else {
      var outer = Set<SectionID>()
      for t in m.tops {
        var q = doc.board.section(t)?.parent
        while let id = q, outer.insert(id).inserted { q = doc.board.section(id)?.parent }
      }
      m.box = (s.frames.filter { m.tops.contains($0.id) }.map(\.rect) + loose).reduce(CGRect.null) { $0.union($1) }
      m.targets =
        s.frames.filter { !m.sections.contains($0.id) && !outer.contains($0.id) }.map(\.rect)
        + (loose.isEmpty ? [] : cards)
    }
    return m
  }

  /// The move to where the pointer is, lined up with what is near when it goes slowly and ⌘ is not held (interact.ts
  /// onMove); a pointer held still lines it up after SNAP_SETTLE
  func dragMove(_ m: inout Move, to v: CGPoint, from g: Gesture, at t: TimeInterval, unsnapped: Bool, still: Bool) {
    let z = camera.zoom
    m.d = CGVector(dx: (v.x - g.startView.x) / z, dy: (v.y - g.startView.y) / z)
    let fast = m.pace?.fast(v, at: t, still: still) ?? true
    snapSettle?.cancel()
    if !still {
      snapSettle = Task { [weak self] in
        try? await Task.sleep(for: Snap.Pace.settle)
        guard let self, !Task.isCancelled, var g = gesture, case .move(var m) = g.kind else { return }
        dragMove(&m, to: v, from: g, at: CACurrentMediaTime(), unsnapped: unsnapped, still: true)
        g.kind = .move(m)
        gesture = g
        showMove(m)
      }
    }
    var guides: [Guide] = []
    if !unsnapped, !fast, !m.box.isNull {
      let sn = Snap.move(m.box.offsetBy(dx: m.d.dx, dy: m.d.dy), to: m.targets, threshold: Snap.Pace.distance / z)
      m.d.dx += sn.d.dx
      m.d.dy += sn.d.dy
      guides = sn.guides
    }
    showGuides(guides)
  }

  /// The guides, dashed lines 1 point wide in the faint ink, 8 past what lines up at either end (styles.css .guide)
  func showGuides(_ gs: [Guide]) {
    guard !gs.isEmpty || guideLayer.path != nil else { return }
    let z = camera.zoom
    let path = CGMutablePath()
    for g in gs {
      switch g.axis {
      case .x:
        path.move(to: CGPoint(x: g.at, y: g.from - 8))
        path.addLine(to: CGPoint(x: g.at, y: g.to + 8))
      case .y:
        path.move(to: CGPoint(x: g.from - 8, y: g.at))
        path.addLine(to: CGPoint(x: g.to + 8, y: g.at))
      }
    }
    withoutAnimation {
      guideLayer.path = gs.isEmpty ? nil : path
      guideLayer.lineWidth = 1 / z
      guideLayer.lineDashPattern = [NSNumber(value: 3 / z), NSNumber(value: 3 / z)]
      guideLayer.strokeColor = theme.ink3.copy(alpha: 0.85)
    }
  }

  /// The size a resize took from another card under it, on the guide colour (Canvas.tsx sizeHint, styles.css .ghint)
  func showSizeHint(_ z: Resize?) {
    guard let z, let text = z.same else {
      if !sizeHint.isHidden { withoutAnimation { sizeHint.isHidden = true } }
      return
    }
    let font =
      theme.id == .inkWash
      ? Font.board("SourceSerif4-400-600", size: 10.5, weight: 600, opticalSize: true)
        ?? Font(NSFont(name: "Georgia-Bold", size: 10.5) ?? NSFont.boldSystemFont(ofSize: 10.5))
      : Font(NSFont.systemFont(ofSize: 10.5, weight: .semibold))
    let size = CGSize(width: (Drawing.width(text, font) + 12).rounded(.up), height: 10.5 + 8)
    let at = camera.view(CGPoint(x: z.rect.midX, y: z.rect.maxY + 8))
    let color = theme.guide
    withoutAnimation {
      sizeHint.frame = CGRect(origin: CGPoint(x: (at.x - size.width / 2).rounded(), y: at.y.rounded()), size: size)
      sizeHint.contents = CanvasView.picture(size: size, scale: backing) { ctx in
        ctx.addPath(
          CGPath(roundedRect: CGRect(origin: .zero, size: size), cornerWidth: 5.5, cornerHeight: 5.5, transform: nil))
        ctx.setFillColor(color)
        ctx.fillPath()
        CanvasView.chipLabel(text, x: 6, midY: size.height / 2, font: font, color: .white, ctx)
      }
      sizeHint.contentsScale = backing
      sizeHint.isHidden = false
    }
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
    lift(m)
    // the Sections the dragged cards are in or go into grow round them as they go (springs: not without animation)
    if !m.loose.isEmpty { followDrag(m) }
    showDrop(m)
    drawChrome()
  }

  /// Routes these arrows again with their cards where `placed` has them, and moves their labels
  func reroute(
    _ indices: [Int], model: (CodeBoardModel.Arrow) -> CodeBoardModel.Arrow = { $0 }, placed: (CardID) -> Scene.Placed?
  ) {
    guard let s = scene else { return }
    for i in indices where i < arrowGroups.count {
      let a = model(s.arrowModels[i])
      guard let from = placed(a.from.card), let to = placed(a.to.card) else { continue }
      let (arrow, label) = Scene.route(a, from: from, to: to, theme: theme)
      routedArrows[i] = arrow
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
    snapSettle?.cancel()
    showGuides([])
    land()
    let followed = Set(dragShown.keys)
    clearDrop()
    guard let doc = document, let s = scene else { return }
    let dx = m.d.dx.rounded()
    let dy = m.d.dy.rounded()
    guard dx != 0 || dy != 0 else {
      // back where it began: the frames the drag grew too
      let grown = s.frames.indices.filter { followed.contains(s.frames[$0].id) && !m.frames.contains($0) }
      let titles = grown.compactMap { index(of: .sectionTitle(s.frames[$0].id)) }
      showScene(arrows: m.arrows, items: m.items + titles, frames: m.frames + grown)
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
    case .arrow, .sticker: return
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
    var z = Resize(item: item, what: what, edges: edges, from: r, rect: r, minSize: minSize)
    if case .card(let id) = item {
      z.targets = s.items.compactMap { it in
        guard case .card(let o)? = it.owner, o != id else { return nil }
        return it.rect
      }
    }
    gesture = Gesture(kind: .resize(z), startView: v, start: p)
    drawChrome()
  }

  /// A Text's narrowest width, measured once by the Note page (as wide as its longest word)
  private func measureLeast(_ id: CardID, _ body: NoteBody, folder: URL) {
    guard leastWidths[id] == nil, case .text(var t) = body else { return }
    t.wrap = true
    let req = NoteSizeRequest(
      note: .text(t), width: 0, folder: folder, look: theme.id.rawValue, dark: theme.dark)
    let display = self.display
    Task {
      guard let size = try? await display.sizes(of: [req], priority: 0).first ?? nil else { return }
      leastWidths[id] = size.width
      if case .resize(var z)? = gesture?.kind, z.item == .card(id) {
        z.minSize.width = size.width
        gesture?.kind = .resize(z)
      }
    }
  }

  /// The rect a resize has reached with the pointer moved by d (board units); a card's right and bottom edges line up
  /// with the other cards' edges and sizes unless `snap` is off (⌘ or ⌃ held), as interact.ts resizeDown
  func resizeTo(_ z: inout Resize, _ d: CGVector, snap: Bool = false) {
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
    z.guides = []
    z.same = nil
    switch z.what {
    case .card, .textWidth, .image:
      guard snap, z.edges.isDisjoint(with: [.left, .top]) else { break }
      var image = false
      if case .image = z.what { image = true }
      let sn = Snap.resize(
        r, right: z.edges.contains(.right), bottom: z.edges.contains(.bottom) && !image, to: z.targets,
        threshold: Snap.Pace.distance / camera.zoom)
      r.size.width = max(z.minSize.width, sn.size.width)
      // an image's height follows its width
      r.size.height = image ? r.width * f.height / max(1, f.width) : sn.size.height
      switch sn.same {
      case .x?: z.same = "same width · \(Int(r.width.rounded()))"
      case .y?: z.same = "same height · \(Int(r.height.rounded()))"
      case nil: z.guides = sn.guides
      }
    default: break
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
    showGuides([])
    showSizeHint(nil)
    guard let doc = document, let s = scene else { return }
    let r = z.rect
    guard r != z.from else {
      restoreResize(z)
      return
    }
    let rounded = CGRect(x: r.minX.rounded(), y: r.minY.rounded(), width: r.width.rounded(), height: r.height.rounded())
    switch (z.item, z.what) {
    case (.arrow, _), (.sticker, _): return
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
          let natural = measured[id]?.size.size.height
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
    case .arrow, .sticker: break
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
    if opening { return }
    // Esc closes the bar's open panel, and only that
    if alignMore, e.keyCode == 53 { return setAlignMore(false) }
    guard document != nil else { return super.keyDown(with: e) }
    if let v = writingView {
      // the editor is there from the first: a key that came here is its
      window?.makeFirstResponder(v)
      return v.keyDown(with: e)
    }
    if editing != nil {
      // the editor is mounting: its keys wait for it, Esc among them, in the order typed
      editing?.keys.append(e)
      return
    }
    if keysAhead != nil {
      keysAhead?.append(e)
      return
    }
    if !restTextKey(e), !boardKey(e) { super.keyDown(with: e) }
  }

  public override func keyUp(with e: NSEvent) {
    if e.keyCode == 49 { return releaseSpace() }
    guard nudgeHold?.dirs.removeValue(forKey: e.keyCode) != nil else { return super.keyUp(with: e) }
    if nudgeHold?.dirs.isEmpty == true { stopNudge() }
  }

  public override func flagsChanged(with e: NSEvent) {
    nudgeHold?.shift = e.modifierFlags.contains(.shift)
    super.flagsChanged(with: e)
  }

  /// The last arrow up, the window or the keys gone: the nudge so far is one step
  func stopNudge() {
    nudgeHold = nil
    if case .nudge(let m)? = gesture?.kind { commitMove(m) }
  }

  /// An arrow key moves the selection one point on screen (⇧: ten) at once; held past NUDGE_HOLD it glides on every
  /// frame, faster the longer it is held (glideNudge). From the first key down to the last key up is one step
  func nudge(_ e: NSEvent) {
    // the OS key repeat would move in uneven jumps at one fixed speed
    if e.isARepeat && nudgeHold != nil { return }
    guard let doc = document else { return }
    let shift = e.modifierFlags.contains(.shift)
    let unit = max(1, ((shift ? 10 : 1) / camera.zoom).rounded())
    let d: CGVector =
      switch e.keyCode {
      case 123: CGVector(dx: -1, dy: 0)
      case 124: CGVector(dx: 1, dy: 0)
      case 125: CGVector(dx: 0, dy: 1)
      default: CGVector(dx: 0, dy: -1)
      }
    var m: Move
    switch gesture?.kind {
    case .nudge(let current)?: m = current
    case nil:
      guard let made = makeMove(doc.selection) else { return }
      m = made
    default: return
    }
    let t = now
    var h = nudgeHold ?? NudgeHold(t0: t, last: t)
    // another arrow joining the hold (a diagonal) starts the speed-up over
    h.dirs[e.keyCode] = d
    h.shift = shift
    h.t0 = t
    h.acc = .zero
    nudgeHold = h
    m.d.dx += d.dx * unit
    m.d.dy += d.dy * unit
    gesture = Gesture(kind: .nudge(m), startView: .zero, start: .zero)
    showMove(m)
    wake()
  }

  /// A frame of arrows held (keymap.ts glide): past NUDGE_HOLD at NUDGE_SPEED points a millisecond on screen, easing up
  /// to NUDGE_MAX times that over NUDGE_RAMP; whole world points like every other placement, the rest carried over
  func glideNudge(at time: TimeInterval) {
    guard var h = nudgeHold else { return }
    guard case .nudge(var m)? = gesture?.kind else {
      nudgeHold = nil
      return
    }
    let dt = min(50, max(0, time - h.last) * 1000)
    let t = (time - h.t0) * 1000
    h.last = time
    if t > NudgeHold.hold {
      let r = min(1, (t - NudgeHold.hold) / NudgeHold.ramp)
      let v = NudgeHold.speed * (1 + (NudgeHold.most - 1) * r * r * (3 - 2 * r)) * (h.shift ? 10 : 1) / camera.zoom
      let sum = h.dirs.values.reduce(CGVector.zero) { CGVector(dx: $0.dx + $1.dx, dy: $0.dy + $1.dy) }
      h.acc.dx += (sum.dx > 0 ? 1 : sum.dx < 0 ? -1 : 0) * v * dt
      h.acc.dy += (sum.dy > 0 ? 1 : sum.dy < 0 ? -1 : 0) * v * dt
      let move = CGVector(dx: h.acc.dx.rounded(.towardZero), dy: h.acc.dy.rounded(.towardZero))
      h.acc.dx -= move.dx
      h.acc.dy -= move.dy
      if move != .zero {
        m.d.dx += move.dx
        m.d.dy += move.dy
        gesture = Gesture(kind: .nudge(m), startView: .zero, start: .zero)
        showMove(m)
      }
    }
    nudgeHold = h
  }

  public override func resignFirstResponder() -> Bool {
    stopNudge()
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
    let gone = goneAutoCards
    doc.edit("Delete", selection: []) { $0.delete(doc.selection, missing: gone) }
  }

  /// ⌘C: the selected cards (only cards: actions/shared.ts copyCardsSel); none, nothing
  @objc public func copy(_ sender: Any?) {
    if copyRestText() { return }
    guard let board = shown?.board.id, let data = putOnPasteboard(selectedCards) else { return }
    copied = (board, data, 0)
  }

  /// ⌘X: the selected cards copied, then deleted in one step (actions/shared.ts cutCardsSel); a paste on this board
  /// puts them back
  @objc public func cut(_ sender: Any?) {
    guard let doc = document, let (_, vault) = shown, gesture == nil else { return }
    let ids = selectedCards
    guard let data = putOnPasteboard(ids) else { return }
    let clip = doc.board.clip(ids, touching: true) { try? vault.sharedCard($0) }
    let gone = goneAutoCards
    doc.edit("Cut", selection: []) { $0.delete(Set(ids.map(Item.card)), missing: gone) }
    cutClip = (doc.board.id, data, clip)
    toast("Cut \(clip.cards.count) card\(clip.cards.count > 1 ? "s" : "")")
  }

  private var selectedCards: Set<CardID> { Set(document?.selection.compactMap(\.card) ?? []) }

  /// The cards' clip on the pasteboard, and the first image card's picture as PNG for other apps (shared.ts copyCards,
  /// imagedata.ts copyPicture); nil: nothing to copy
  private func putOnPasteboard(_ ids: Set<CardID>) -> Data? {
    guard let doc = document, let (board, vault) = shown else { return nil }
    let clip = doc.board.clip(ids) { try? vault.sharedCard($0) }
    guard !clip.isEmpty, let data = try? clip.encoded() else { return nil }
    pasteboard.clearContents()
    pasteboard.setData(data, forType: NSPasteboard.PasteboardType(Clip.pasteboardType))
    let images = vault.url(of: board.path).appending(path: Vault.imagesFolder)
    if let png = clip.cards.lazy.compactMap({ Self.picturePNG($0, in: images) }).first {
      pasteboard.setData(png, forType: .png)
    }
    return data
  }

  /// An image card's picture file as PNG (imagedata.ts clipboardPng: a PNG as it is, any other drawn once)
  private static func picturePNG(_ card: Card, in images: URL) -> Data? {
    guard case .own(let k) = card.content, case .image(let img) = k.body, case .file(let name) = img.source,
      let data = try? Data(contentsOf: images.appending(path: name))
    else { return nil }
    if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return data }
    return NSImage(data: data)?.cgImage(forProposedRect: nil, context: nil, hints: nil).flatMap {
      NSBitmapImageRep(cgImage: $0).representation(using: .png, properties: [:])
    }
  }

  /// Pastes what was copied (actions/shared.ts pasteFromBoard): cards cut on this board back where the pointer is, with
  /// their ids and arrows (pasteCut); cards copied on this board as copies 36 × n down and right of them, n counting the
  /// pastes since the copy, with the chip that makes them References (pasteCopied); from another board, the same cards,
  /// shared by both (main's paste onto another board), at the pointer, once there: they are selected
  @objc public func paste(_ sender: Any?) { paste(asCopy: false, at: nil) }

  /// ⌥⌘V: cards copied on another board come as copies of their own (keymap.ts pasteOther)
  @objc public func pasteAsCopy(_ sender: Any?) { paste(asCopy: true, at: nil) }

  /// `at`: where the board's menu was asked, else the pointer's place (interact.ts paste: worldAt(lastPointer())), for
  /// plain text
  func paste(asCopy: Bool, at: CGPoint?) {
    let p = at ?? pointerInWindow.map { camera.board(convert($0, from: nil)) }
    if gesture == nil, pasteboard.data(forType: NSPasteboard.PasteboardType(Clip.pasteboardType)) == nil {
      // ⌘V only: the board menu's Paste puts it where the menu was asked, as main's
      let near = at == nil ? pasteboard.string(forType: .string).flatMap(pasteNear) : nil
      if pastePicture(at: p) || pasteLinks(at: near ?? p) || pasteText(at: near ?? p, exact: near != nil) { return }
    }
    guard let doc = document, gesture == nil, let here = shown?.board.id,
      let data = pasteboard.data(forType: NSPasteboard.PasteboardType(Clip.pasteboardType)),
      var clip = try? Clip(decoding: data), !clip.isEmpty
    else { return }
    if let c = cutClip, c.board == here, c.data == data {
      let back = c.clip.cards.allSatisfy { doc.board.card($0.id) == nil }
      let (dx, dy) = atPointer(c.clip)
      let n = place(c.clip, dx: dx, dy: dy, name: "Paste", back: back).count
      return toast(back ? "Pasted \(n) card\(n > 1 ? "s" : "")" : n > 1 ? "Pasted \(n) copies" : "Pasted a copy")
    }
    if let c = copied, c.board == here, c.data == data, clip.board == here,
      clip.cards.contains(where: { doc.board.card($0.id) != nil })
    {
      copied?.n += 1
      let k = 36 * Double(c.n + 1)
      let copies = place(clip, dx: k, dy: k, name: "Paste")
      toast(copies.count > 1 ? "Pasted \(copies.count) copies" : "Pasted a copy")
      return offerReference(copies)
    }
    let (dx, dy) = atPointer(clip)
    guard let from = clip.board, from != here else {
      let n = place(clip, dx: dx, dy: dy, name: "Paste").count
      return toast(n > 1 ? "Pasted \(n) copies" : "Pasted a copy")
    }
    let other = shareOnBoard?(from, asCopy ? [] : Set(clip.cards.map(\.id)))
    guard !asCopy, let other else {
      let n = place(clip, dx: dx, dy: dy, name: "Paste").count
      let what = n > 1 ? "\(n) copies" : "a copy"
      return toast(other.map { "Pasted \(what) from \($0.title)" } ?? "Pasted \(what)")
    }
    clip = clip.renamed(other.ids)
    if clip.cards.allSatisfy({ doc.board.card($0.id) != nil }) {
      doc.select(Set(clip.cards.map { .card($0.id) }))
      if let first = clip.cards.first, let r = liveRect(.card(first.id)) { reveal(r) }
      return toast("Already on this board")
    }
    let n = place(clip, dx: dx, dy: dy, name: "Paste", shared: true).count
    toast("Pasted as linked card\(n > 1 ? "s" : "") · also on \(other.title)")
  }

  /// How far to move the clip's cards for them to be at the first free place from where the pointer is (the view's
  /// middle when it is not over the board), as actions/shared.ts putCards: their box (a card's height, or 300, and 40),
  /// core layout.ts findFree
  private func atPointer(_ clip: Clip) -> (Double, Double) {
    let v = pointerInWindow.map { convert($0, from: nil) } ?? CGPoint(x: bounds.midX, y: bounds.midY)
    let at = camera.board(v)
    let rects = clip.cards.map { CGRect(x: $0.x, y: $0.y, width: $0.width, height: ($0.height ?? 300) + 40) }
    let box = rects.dropFirst().reduce(rects.first ?? .zero) { $0.union($1) }
    let others =
      document?.board.cards.map { c in
        liveRect(.card(c.id)) ?? CGRect(x: c.x, y: c.y, width: c.width, height: c.height ?? c.measuredHeight ?? 0)
      } ?? []
    let free = Self.findFree(CGRect(origin: at, size: box.size), others: others)
    return ((free.x - box.minX).rounded(), (free.y - box.minY).rounded())
  }

  /// The first place from `want`'s, in 40-unit steps down, right, both, up and left, where it is 28 clear of `others`
  /// (core layout.ts findFree)
  static func findFree(_ want: CGRect, others: [CGRect]) -> CGPoint {
    func free(_ x: CGFloat, _ y: CGFloat) -> Bool {
      let r = CGRect(x: x, y: y, width: want.width, height: want.height)
      return !others.contains {
        r.minX < $0.maxX + 28 && $0.minX < r.maxX + 28 && r.minY < $0.maxY + 28 && $0.minY < r.maxY + 28
      }
    }
    let (x, y) = (want.minX, want.minY)
    if free(x, y) { return want.origin }
    for r in 1..<60 {
      let d = CGFloat(r) * 40
      for (cx, cy) in [(x, y + d), (x + d, y), (x + d, y + d), (x, y - d), (x - d, y)] where free(cx, cy) {
        return CGPoint(x: cx, y: cy)
      }
    }
    return CGPoint(x: x, y: y + 60 * 40)
  }

  /// ⌘D: copies of the selected cards 48 down and to the right (core duplicateCards), with the chip that makes them
  /// References: no arrow and no sidenote come along, and they stay in no Section; with no card selected, it says so
  /// (actions/edit.ts duplicateSel)
  @objc public func duplicate(_ sender: Any?) {
    guard let doc = document, let (_, vault) = shown, gesture == nil, !doc.selection.isEmpty else { return }
    var clip = doc.board.clip(selectedCards) { try? vault.sharedCard($0) }
    guard !clip.isEmpty else { return toast("Select a card to duplicate") }
    clip.arrows = []
    clip.sidenotes = []
    // left where they are, in view or not (duplicateSel moves no camera)
    offerReference(place(clip, dx: 48, dy: 48, name: "Duplicate", settle: false, reveal: false))
  }

  /// The clip put on the board, what was made selected and brought into view; returns each card made with the one it
  /// was made from. `settle`: each card goes in the Section it lands in (board actions/shared.ts settleHome)
  @discardableResult
  private func place(
    _ clip: Clip, dx: Double, dy: Double, name: String, shared: Bool = false, back: Bool = false, settle: Bool = true,
    reveal shows: Bool = true
  ) -> [(copy: CardID, of: CardID)] {
    guard let doc = document else { return [] }
    var b = doc.board
    let (made, copies) = b.paste(clip, dx: dx, dy: dy, shared: shared, back: back)
    var placed = CGRect.null
    let frames = Dictionary((scene?.frames ?? []).map { ($0.id, $0.rect) }, uniquingKeysWith: { a, _ in a })
    for (id, of) in copies {
      guard let i = b.cards.firstIndex(where: { $0.id == id }) else { continue }
      let c = b.cards[i]
      let h = c.height ?? c.measuredHeight ?? liveRect(.card(of)).map { Double($0.height) } ?? 0
      let r = CGRect(x: c.x, y: c.y, width: c.width, height: h)
      placed = placed.union(r)
      if settle { b.cards[i].section = home(of: r, frames: frames) }
    }
    doc.edit(name, selection: made) { $0 = b }
    if shows && !placed.isNull { reveal(placed) }
    return copies
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
  func isOwnLock(_ item: Item) -> Bool {
    switch item {
    case .card(let id): document?.board.card(id)?.locked == true
    case .section(let id): document?.board.section(id)?.locked == true
    case .arrow, .sticker: false
    }
  }
}

extension CanvasView: NSMenuItemValidation {
  public func validateMenuItem(_ item: NSMenuItem) -> Bool {
    guard let doc = document else { return false }
    let sel = doc.selection
    switch item.action {
    case #selector(undo(_:)):
      item.title = doc.undoName.map { "Undo \($0)" } ?? "Undo"
      return doc.history.canUndo && gesture == nil && editing == nil
    case #selector(redo(_:)):
      item.title = doc.redoName.map { "Redo \($0)" } ?? "Redo"
      return doc.history.canRedo && gesture == nil && editing == nil
    case #selector(copy(_:)), #selector(duplicate(_:)): return !sel.isEmpty
    case #selector(cut(_:)), #selector(delete(_:)): return sel.contains { !doc.board.isLocked($0) }
    case #selector(paste(_:)), #selector(pasteAsCopy(_:)):
      return pasteboard.data(forType: NSPasteboard.PasteboardType(Clip.pasteboardType)) != nil
        || pasteboard.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
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

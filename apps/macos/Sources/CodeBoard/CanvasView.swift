// The canvas: a flipped, layer-backed view whose `world` layer holds every card, Section and arrow at board coordinates. The camera
// is the world layer's transform, so panning, pinching and ⌘-scrolling never redraw a card; a card being dragged moves its own
// layer and only the arrows on it are re-routed (a sub-millisecond call into core's routing). Cards are rasterised at a few zoom
// buckets (rasterBucket) over the base each always keeps (Base.swift); past a budget hidden cards fall back to their base; a
// change is committed to core when the drag ends.
// Gestures: drag a card (or the selection), marquee on empty space (⌥-drag pans), resize by a selected card's right edge / bottom
// corner, an arrow from a selected card's port dots to another card, double-click to edit a Note / Text / Free code or to make a
// Note on empty space, a Section's title to rename it. The card being edited is the EditCard's WKWebView over it (WebCards.swift).
import AppKit

protocol CanvasDelegate: AnyObject {
  func canvas(_ c: CanvasView, dragEnded moves: [JSBridge.Move])
  func canvas(_ c: CanvasView, cameraRested cam: Camera)
  func canvasRoute(_ c: CanvasView, rects: [String: WorldRect], only: [String]?, modes: [String: String]?, _ cb: @escaping ([RouteGeo]) -> Void)
  func canvasUndo(_ c: CanvasView)
  func canvasRedo(_ c: CanvasView)
  /** A live resize of a card: width, and height when the bottom edge was pulled */
  func canvas(_ c: CanvasView, resizing id: String, w: Double, h: JSBridge.Height)
  func canvasResizeBegan(_ c: CanvasView)
  func canvasResizeEnded(_ c: CanvasView)
  func canvas(_ c: CanvasView, editCard id: String)
  func canvas(_ c: CanvasView, newNoteAt p: CGPoint)
  func canvas(_ c: CanvasView, linkFrom: String, to: String)
  func canvas(_ c: CanvasView, deleteCards: [String], links: [String], sections: [String])
  func canvas(_ c: CanvasView, renameSection id: String, title: String)
  func canvasCopy(_ c: CanvasView)
  func canvasPaste(_ c: CanvasView)
  func canvasDuplicate(_ c: CanvasView)
  func canvasNewSection(_ c: CanvasView)
  /** A key on the canvas: n / t / c make a card at the pointer (the board's keys) */
  func canvas(_ c: CanvasView, newCard look: String, at p: CGPoint)
  /** A sub-board card double-clicked */
  func canvas(_ c: CanvasView, openBoard id: String)
  /** An image file dropped on the canvas (its bytes and file name), at a world point */
  func canvas(_ c: CanvasView, dropImage data: Data, name: String, at p: CGPoint)
  func canvas(_ c: CanvasView, foldSection id: String, shut: Bool, open: WorldRect)
  func canvasTurnIntoBoard(_ c: CanvasView)
  /** A question sticker double-clicked (or a new one made): its popover, by the sticker's rectangle in view coordinates */
  func canvas(_ c: CanvasView, editQuestion id: String, at: CGRect)
  func canvas(_ c: CanvasView, deleteStickers ids: [String])
  /** A card's sidenotes, asked for (the head's chip, the menu) */
  func canvas(_ c: CanvasView, showSidenotes card: String)
  /** `s` on a selected card (the board's Add Sidenote): a new note on it, opened for writing */
  func canvas(_ c: CanvasView, addSidenoteTo card: String)
  /** A sticker's drag: live moves (inside a gesture), then its drop at a world point, on a card or free */
  func canvasStickerDragBegan(_ c: CanvasView)
  func canvas(_ c: CanvasView, dragSticker id: String, to p: CGPoint)
  func canvas(_ c: CanvasView, dropSticker id: String, at p: CGPoint, on card: String?)
  /** The sticker menu's items (the board's stickerMenu): colour (nil = default), size, detach, answered */
  func canvas(_ c: CanvasView, sticker id: String, color: String?)
  func canvas(_ c: CanvasView, sticker id: String, size: Double)
  func canvas(_ c: CanvasView, detachSticker id: String, at p: CGPoint)
  func canvas(_ c: CanvasView, sticker id: String, answered: Bool)
}

/** How many finished bitmaps land per frame: enough to fill a view in a few frames, few enough that the commit stays short */
let HANDOVERS_PER_FRAME = 6

final class CanvasView: NSView {
  weak var delegate: CanvasDelegate?
  let world = CALayer()
  private let sections = CALayer()
  private let arrows = CALayer()
  private let cards = CALayer()
  /** Stickers (styles.css .stk.canvas: above the cards), and what rides over the arrows (a selected Mark's toolbar) */
  private let stickers = CALayer()
  private let top = CALayer()
  private let overlay = CALayer()
  /** The zoomed-out summary level (Summaries.swift) and what the detent and the switch draw over the board: the mist in the
   *  board's colour rising from the bottom (styles.css .cutmist), the vermilion line (.cutline) and the seal (.cutseal) */
  let summaries = SummaryLevel()
  private let mist = CALayer()
  /** The mist's image: the gradient blurred once, for a view size and board colour (a live blur filter cost every frame) */
  private var mistImage: (CGSize, CGColor, CGImage)?
  private let cutLine = CALayer()
  private let cutFill = CALayer()
  private let seal = CATextLayer()
  /** The level shown (0 cards, 1 summaries), the push into the detent (0…1) and the switch running */
  private(set) var level = 0
  private var push = 0.0
  private var pushedAt = 0.0
  private var drainTimer: Ticker?
  private var switchTimer: Ticker?
  private(set) var stickerLayers: [String: StickerLayer] = [:]
  /** Ink Wash's scene behind the board (packages/board/src/scenes): the whole view, bottom-anchored, cover */
  private let scene = CALayer()
  private(set) var cardLayers: [String: CardLayer] = [:]
  private(set) var sectionLayers: [String: SectionLayer] = [:]
  private(set) var arrowLayers: [String: ArrowLayer] = [:]
  private var order: [String] = []
  private(set) var cam = Camera(x: 80, y: 80, z: 1) {
    didSet { onCamera?(cam) }
  }
  var onCamera: ((Camera) -> Void)?
  static let zMax: CGFloat = 4
  /** The zoom floor: the board's own (core summaryMinZoom over its content and the view), set with the summaries and the view size */
  private(set) var zMin: CGFloat = 0.05
  private var restTimer: Timer?
  /** A zoom re-rasters once it has settled this long: during the pinch the bitmaps scale */
  private var settleTimer: Timer?
  static let RASTER_SETTLE = 0.12
  private var rasterScale: CGFloat = 0
  /** When the zoom last changed: until it has settled, a card coming near shows the bitmap it has, scaled */
  private var zoomedAt: CFTimeInterval = 0
  /** Cards shown mid-zoom with a bitmap of another bucket (or look): drawn again once the zoom settles */
  private var deferred: Set<String> = []
  private(set) var selected: Set<String> = []
  /** The routing off the main thread during a drag (RouteWorker), and this board's key in it */
  var router: RouteWorker?
  var routeKey = ""
  private var routeSeq = 0
  /** For the checks: how many requests behind each applied live route was, and how far the drop's final route moved the arrows */
  private(set) var routeLags: [Int] = []
  private(set) var dropJump: Double = 0
  private var liveGeos: [String: [Double]] = [:]
  /** The side choices of the last live routes, for the main router to adopt at the drop */
  private var liveModes: [String: String] = [:]
  private var dropPending = false
  /** Finished bitmaps waiting to be shown, a few per frame */
  private var landing: [(CardLayer, Any, CGFloat, Int)] = []
  private var landingLink: CADisplayLink?
  private(set) var selectedLinks: Set<String> = []
  private(set) var selectedSections: Set<String> = []
  private(set) var selectedStickers: Set<String> = []
  /** The selected sticker's tether to what it rides (styles.css .tether: a dashed accent line to the anchor, a dot there) */
  private let tether = CAShapeLayer()
  private let tetherDot = CAShapeLayer()
  /** Notes are rendered by the web page, offscreen (its view sits behind the window's content) */
  let notes = NoteRenderer()
  /** The card being edited: a web view over it */
  let edit = EditCard()
  /** The marquee, the port dots of the selected card and the arrow being drawn: in view coordinates, above the world */
  private let marquee = CAShapeLayer()
  private let ports = CAShapeLayer()
  private let rubber = CAShapeLayer()

  override init(frame: CGRect) {
    super.init(frame: frame)
    wantsLayer = true
    registerForDraggedTypes([.fileURL, .png, .tiff])
    layerContentsRedrawPolicy = .never
    layer!.backgroundColor = Theme.bg.cgColor
    layer!.masksToBounds = true
    world.anchorPoint = .zero
    world.addSublayer(summaries.layer)
    for l in [sections, cards, stickers, arrows, top] {
      l.anchorPoint = .zero
      world.addSublayer(l)
    }
    mist.anchorPoint = .zero
    mist.contentsGravity = .resize
    mist.isHidden = true
    cutLine.anchorPoint = .zero
    cutLine.cornerRadius = 1
    cutLine.isHidden = true
    cutFill.anchorPoint = CGPoint(x: 0.5, y: 0.5)
    cutFill.cornerRadius = 1
    cutLine.addSublayer(cutFill)
    seal.anchorPoint = CGPoint(x: 0.5, y: 0.5)
    seal.alignmentMode = .center
    seal.borderWidth = 2
    seal.cornerRadius = 4
    seal.isHidden = true
    seal.contentsScale = 2
    for l in [mist, cutLine, seal] { overlay.addSublayer(l) }
    still(world, sections, arrows, cards, stickers, top, overlay, mist, cutLine, cutFill, seal, scene, tether, tetherDot, marquee, ports, rubber, summaries.layer)
    notes.inView = { [weak self] id in
      guard let self, let l = self.cardLayers[id] else { return false }
      return CGRect(x: -self.cam.x / self.cam.z, y: -self.cam.y / self.cam.z, width: self.bounds.width / self.cam.z, height: self.bounds.height / self.cam.z).intersects(l.worldRect)
    }
    // Ink Wash's paper sheets and Section frames come off the ink thread: a card or Section drawn before its was there draws again
    NotificationCenter.default.addObserver(forName: Ink.ready, object: nil, queue: .main) { [weak self] _ in
      guard let self, Theme.isInk else { return }
      for l in self.cardLayers.values {
        l.needBase()
        if !l.isHidden, l.drewPaperless { l.setNeedsDisplay() }
      }
      for l in self.sectionLayers.values { l.restyle() }
    }
    scene.anchorPoint = .zero
    scene.contentsGravity = .resize
    layer!.addSublayer(scene)
    layer!.addSublayer(world)
    overlay.anchorPoint = .zero
    marquee.lineWidth = 1
    marquee.lineDashPattern = [4, 3]
    marquee.isHidden = true
    ports.isHidden = true
    rubber.fillColor = nil
    rubber.lineWidth = 1.5
    rubber.lineCap = .round
    rubber.isHidden = true
    tether.fillColor = nil
    tether.lineWidth = 1
    tether.lineDashPattern = [3, 3]
    tether.isHidden = true
    tetherDot.isHidden = true
    for l in [marquee, ports, rubber, tether, tetherDot] { overlay.addSublayer(l) }
    layer!.addSublayer(overlay)
    addSubview(edit.view)
    // the editor paints the card itself (paper, ring, text): the card's own bitmap hides under it, so nothing shows twice
    edit.onShown = { [weak self] on in
      guard let self else { return }
      if on, let id = self.edit.card?.id { self.underEdit = id }
      if let id = self.underEdit { self.cardLayers[id]?.isHidden = on }
      if !on { self.underEdit = nil }
    }
    edit.onCrashed = { [weak self] id in
      guard let self else { return }
      self.cardLayers[id]?.setNeedsDisplay()
      self.hideEditorWhenRendered(id)
      self.showPorts()
      self.onEditCrashed?()
    }
    edit.onHeight = { [weak self] id, h in
      guard let self, let l = self.cardLayers[id] else { return }
      // the editor grew: the card grows with it (arrows follow); the stored height is the text's when the edit ends
      if h > l.height {
        l.resize(to: CGSize(width: l.card.w, height: h))
        self.routeAround([id])
      }
      self.followEdit()
    }
    recolorOverlay()
  }
  required init?(coder: NSCoder) { fatalError() }
  override var isFlipped: Bool { true }
  override var acceptsFirstResponder: Bool { true }

  var backing: CGFloat { window?.backingScaleFactor ?? 2 }
  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    Theme.appearance = effectiveAppearance
    notes.setTheme(themeName)
    // (sent again whenever the page starts over: a content process crash)
    edit.page.onReady = { [weak self] in
      guard let self else { return }
      self.edit.page.call("cb.setup(\(encodeJSON(["theme": self.themeName, "look": Theme.look])))")
      self.edit.warm()
    }
    edit.page.call("cb.setup(\(encodeJSON(["theme": themeName, "look": Theme.look])))")
    edit.warm()
    // the renderer's page sits behind the window's content (WebKit paints and snapshots only views it counts as visible; one
    // clipped away by its superview is not)
    if let cv = window?.contentView, notes.page.web.superview !== cv {
      notes.page.web.frame = CGRect(origin: .zero, size: NoteRenderer.pageSize)
      cv.addSubview(notes.page.web, positioned: .below, relativeTo: nil)
    }
  }

  // MARK: scene
  /** The look's arrows: both routers draw for it (core's taper and dart, or brush and dot) */
  private func tellLook() {
    MainActor.assumeIsolated { (NSApp.delegate as? AppDelegate)?.bridge.setLook(Theme.look) }
    router?.setLook(Theme.look)
  }
  /** The scene behind the board, drawn at the view's size (center bottom / cover, as the board's CSS) */
  private func layoutScene() {
    guard Theme.isInk, bounds.width > 0, let img = Ink.scene(dark: Theme.isDark) else { scene.contents = nil; return }
    let k = max(bounds.width / img.size.width, bounds.height / img.size.height)
    let w = img.size.width * k, h = img.size.height * k
    scene.frame = CGRect(x: (bounds.width - w) / 2, y: bounds.height - h, width: w, height: h)
    // a resize stretches the image it has (contentsGravity resize); it is drawn at the new size once the size rests (a live
    // resize's end, or 0.2 s after a programmatic one: redrawn every frame it cost ~80 ms a frame)
    if inLiveResize { return }
    let px = CGSize(width: w * backing, height: h * backing)
    if let cached = sceneImage, cached.0 == px, cached.1 == Theme.isDark { scene.contents = cached.2; return }
    if sceneImage?.1 == Theme.isDark, scene.contents != nil {
      sceneTimer?.invalidate()
      let t = Timer(timeInterval: 0.2, repeats: false) { [weak self] _ in self?.sceneImage = nil; self?.layoutScene() }
      RunLoop.main.add(t, forMode: .common)
      sceneTimer = t
      return
    }
    let copy = img.copy() as! NSImage
    copy.size = px
    var rect = CGRect(origin: .zero, size: px)
    guard let cg = copy.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return }
    sceneImage = (px, Theme.isDark, cg)
    scene.contents = cg
  }
  private var sceneImage: (CGSize, Bool, CGImage)?
  private var sceneTimer: Timer?

  /** A whole scene. Layers of cards still in it stay (their bitmaps too: opening the same board again shows no blank card), the
   *  rest go */
  func load(_ s: Scene) {
    tellLook()
    edit.end { _ in }  // committed by whoever switched the board (BoardWindow.open), before this
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    // another board: the one shown stays on screen (its layers in a still copy of the world) until the new one is ready
    var ghost = self.ghost
    if shownKey != routeKey, !shownKey.isEmpty, !world.isHidden, ghost == nil {
      let g = CALayer()
      g.anchorPoint = .zero
      g.bounds = world.bounds
      g.position = world.position
      g.transform = world.transform
      layer!.insertSublayer(g, above: scene)
      ghost = g
    }
    let keepOld = ghost != nil && self.ghost == nil
    if shownKey != routeKey { swapShelf(into: keepOld ? ghost : nil) }
    let keep = Set(s.cards.map(\.id))
    for (id, l) in cardLayers where !keep.contains(id) {
      l.detach()
      cardLayers[id] = nil
    }
    for l in Array(sectionLayers.values) as [CALayer] + Array(arrowLayers.values) + Array(stickerLayers.values) {
      if keepOld { ghost?.addSublayer(l) } else { l.removeFromSuperlayer() }
    }
    sectionLayers = [:]
    arrowLayers = [:]
    stickerLayers = [:]
    order = order.filter { keep.contains($0) }
    selected = []
    landing = []
    selectedLinks = []
    selectedSections = []
    folded = []
    for sec in s.sections { putSection(sec) }
    for c in s.cards { putCard(c) }
    for l in s.links { putLink(l) }
    for k in s.stickers { putSticker(k) }
    refold()
    // the board shows once every card has its base (a second open: read from disk, a few ms), so no card is ever missing
    basesWaiting = Set(cardLayers.values.filter { !$0.hasFace }.map(\.card.id))
    self.ghost = ghost
    world.isHidden = !basesWaiting.isEmpty || ghost != nil
    if let ghost { after(0) { [weak self] in self?.dropGhost(ghost, key: self?.routeKey ?? "", until: CACurrentMediaTime() + 1) } }
    if world.isHidden, ghost == nil {
      let key = routeKey
      after(1) { [weak self] in
        guard let self, self.routeKey == key, self.world.isHidden, self.ghost == nil else { return }
        logLine("[canvas] shown with %d cards still without a base", self.basesWaiting.count)
        self.basesWaiting = []
        self.world.isHidden = false
      }
    }
    CATransaction.commit()
    showPorts()
    setCamera(s.cam, animated: false)
    routeAll()
  }
  /** The card layers of the boards this window showed last, bitmaps and all: switching back to one shows it sharp at once
   *  (as the same board opened again does) instead of from its bases while the sharp tier is drawn again */
  private var shelf: [(key: String, layers: [String: CardLayer], order: [String])] = []
  // ponytail: two boards kept whole; their sharp tiers are outside SHARP_BUDGET (each at most its own budget's worth)
  private static let SHELF = 2
  private var shownKey = ""
  /** The board shown before a switch, still (its layers moved here), until the new one has every base and is sharp in view */
  private var ghost: CALayer?
  private func dropGhost(_ g: CALayer, key: String, until end: Double) {
    guard ghost === g, routeKey == key else { return }
    guard (basesWaiting.isEmpty && softInView.isEmpty) || CACurrentMediaTime() > end else {
      return after(1.0 / 120) { [weak self] in self?.dropGhost(g, key: key, until: end) }
    }
    if !basesWaiting.isEmpty { logLine("[canvas] shown with %d cards still without a base", basesWaiting.count) }
    basesWaiting = []
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    world.isHidden = false
    g.removeFromSuperlayer()
    CATransaction.commit()
    ghost = nil
  }
  /** The layers shown go on the shelf (into the ghost meanwhile, when given), the new board's come off it */
  private func swapShelf(into ghost: CALayer?) {
    if !shownKey.isEmpty, !cardLayers.isEmpty {
      for l in cardLayers.values {
        l.selected = false
        l.detach()
        ghost?.addSublayer(l)
      }
      shelf.removeAll { $0.key == shownKey }
      shelf.append((shownKey, cardLayers, order))
    }
    let back = shelf.firstIndex { $0.key == routeKey }.map { shelf.remove(at: $0) }
    cardLayers = back?.layers ?? [:]
    order = back?.order ?? []
    for id in order {
      guard let l = cardLayers[id] else { continue }
      cards.addSublayer(l)
      l.riser = top
    }
    while shelf.count > CanvasView.SHELF { shelf.removeFirst() }
    shownKey = routeKey
  }
  /** Calls back once the board is fit to be seen: shown (every card has its base) and every card in view sharp, or after
   *  `cap` seconds whatever has landed (a new window stays invisible until then, so it never shows a soft or empty board) */
  func whenReady(cap: Double, _ cb: @escaping () -> Void) {
    let end = CACurrentMediaTime() + cap
    func poll() {
      if (!world.isHidden && softInView.isEmpty) || CACurrentMediaTime() > end { return cb() }
      after(1.0 / 120) { poll() }
    }
    poll()
  }
  private var basesWaiting: Set<String> = []
  private func baseCame(_ l: CardLayer) {
    guard !basesWaiting.isEmpty, basesWaiting.remove(l.card.id) != nil, basesWaiting.isEmpty, ghost == nil else { return }
    CATransaction.setDisableActions(true)
    world.isHidden = false
  }

  func apply(_ ch: SceneChange) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for id in ch.gone.cards {
      cardLayers.removeValue(forKey: id)?.detach()
      order.removeAll { $0 == id }
      selected.remove(id)
    }
    for id in ch.gone.sections { sectionLayers.removeValue(forKey: id)?.removeFromSuperlayer(); selectedSections.remove(id) }
    for id in ch.gone.links { arrowLayers.removeValue(forKey: id)?.removeFromSuperlayer(); selectedLinks.remove(id) }
    for id in ch.gone.stickers { stickerLayers.removeValue(forKey: id)?.removeFromSuperlayer(); selectedStickers.remove(id) }
    for sec in ch.sections { putSection(sec) }
    for c in ch.cards { putCard(c) }
    for m in ch.moved { cardLayers[m.id]?.move(to: CGPoint(x: m.x, y: m.y), section: m.section) }
    for l in ch.links { putLink(l) }
    for k in ch.stickers { putSticker(k) }
    refold()
    CATransaction.commit()
    showPorts()
    routeAll()
  }

  private func putCard(_ c: SceneCard) {
    if let l = cardLayers[c.id] {
      l.apply(c)
    } else {
      let l = CardLayer(card: c, notes: notes)
      l.contentsScale = max(rasterScale, 0.125)
      l.isHidden = true  // drawn once the camera says it is near (cull)
      l.handover = { [weak self] layer, surface, scale, gen in self?.enqueue(layer, surface, scale, gen) }
      l.onMeasured = { [weak self] l in
        self?.routeAround([l.card.id])
        self?.showPorts()
      }
      l.onRendered = { [weak self] l in self?.rendered(l.card.id) }
      l.onBase = { [weak self] l in self?.baseCame(l) }
      l.showsBoard = { [weak self] in self.map { !$0.world.isHidden } ?? false }
      l.riser = top
      cardLayers[c.id] = l
      cards.addSublayer(l)
      order.append(c.id)
    }
  }
  private func putSection(_ s: SceneSection) {
    if let l = sectionLayers[s.id] { l.apply(s) } else {
      let l = SectionLayer(section: s)
      l.setScale(max(rasterScale, 0.125))
      sectionLayers[s.id] = l
      sections.addSublayer(l)
    }
  }
  private func putLink(_ k: SceneLink) {
    if let l = arrowLayers[k.id] { l.apply(k) } else {
      let l = ArrowLayer(link: k)
      l.setScale(max(rasterScale, 1))
      arrowLayers[k.id] = l
      arrows.addSublayer(l)
    }
  }
  private func putSticker(_ k: SceneSticker) {
    let l = stickerLayers[k.id] ?? {
      let l = StickerLayer(sticker: k)
      l.setScale(max(rasterScale, 1))
      stickerLayers[k.id] = l
      stickers.addSublayer(l)
      return l
    }()
    l.apply(k)
    if let link = k.link, let a = arrowLayers[link] { l.place(along: a.pts) }
  }

  var rects: [String: WorldRect] {
    var out: [String: WorldRect] = [:]
    for (id, l) in cardLayers { out[id] = WorldRect(x: l.card.x, y: l.card.y, w: l.card.w, h: Double(l.height)) }
    return out
  }
  /** Every arrow routed by the board's session; the routes land when they come, unless the canvas shows another board by then */
  func routeAll() {
    let modes = liveModes.isEmpty ? nil : liveModes
    liveModes = [:]
    route(rects, only: nil, modes: modes, final: true)
  }
  private func route(_ rects: [String: WorldRect], only: [String]?, modes: [String: String]?, final: Bool = false) {
    let key = routeKey
    delegate?.canvasRoute(self, rects: rects, only: only, modes: modes) { [weak self] geos in
      guard let self, self.routeKey == key else { return }
      self.applyRoutes(geos, final: final)
    }
  }
  /** The window closed: nothing of the canvas keeps running */
  func close() {
    landingLink?.invalidate()
    landingLink = nil
    settleTimer?.invalidate()
    restTimer?.invalidate()
    router?.drop(routeKey)
  }
  /** The arrows on these cards routed again (asynchronously, by the session) */
  private func routeAround(_ ids: [String]) {
    let links = linksOn(Set(ids))
    if !links.isEmpty { route(rects, only: links, modes: nil) }
  }
  private func applyRoutes(_ geos: [RouteGeo], final: Bool = false) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for g in geos {
      arrowLayers[g.id]?.transform = CATransform3DIdentity
      arrowLayers[g.id]?.apply(geo: g)
      for l in stickerLayers.values where l.sticker.link == g.id { l.place(along: g.pts) }
    }
    CATransaction.commit()
    if final && dropPending {
      // the drop's final route against the last live one: a jump here is what the user would see as the arrow settling
      dropPending = false
      var jump = 0.0
      for g in geos {
        guard let was = liveGeos[g.id], was.count == g.pts.count else { continue }
        var d = 0.0
        for (a, b) in zip(was, g.pts) { d = max(d, abs(a - b)) }
        if d > 0.5 { logLine("[canvas] drop moved arrow %@ by %.2f px: live %@ final %@ (mode %@)", g.id, d, "\(was.map { Int($0) })", "\(g.pts.map { Int($0) })", g.mode ?? "-") }
        jump = max(jump, d)
      }
      dropJump = jump
      liveGeos = [:]
    }
  }
  /** The drag's arrows, routed off the main thread: the latest finished routes are drawn, a request behind at most */
  private func routeLive(_ links: [String], rects: [String: WorldRect], seq: Int) {
    router?.route(routeKey, rects: rects, only: links, seq: seq) { [weak self] geos, seq in
      guard let self, let targets = self.dragTargets[seq] else { return }
      for k in self.dragTargets.keys where k <= seq { self.dragTargets[k] = nil }
      self.routeLags.append(self.routeSeq - seq)
      for g in geos {
        self.liveGeos[g.id] = g.pts
        if let m = g.mode { self.liveModes[g.id] = m }
      }
      self.moveCards(targets)
      self.applyRoutes(geos)
    }
  }
  func resetRouteStats() {
    routeLags = []
    dropJump = 0
  }

  // Finished bitmaps land a few per frame, nearest the middle of the view first; a card keeps its old bitmap until its new one
  // lands, so a bucket crossing never shows a blank card and never puts every new surface into one commit
  private func enqueue(_ layer: CardLayer, _ surface: Any, _ scale: CGFloat, _ gen: Int) {
    landing.append((layer, surface, scale, gen))
    if landingLink == nil {
      let link = displayLink(target: self, selector: #selector(landSome))
      link.add(to: .main, forMode: .common)
      landingLink = link
    }
    landingLink?.isPaused = false
  }
  @objc private func landSome() {
    guard !landing.isEmpty else { landingLink?.isPaused = true; return }
    let centre = CGPoint(x: (bounds.midX - cam.x) / cam.z, y: (bounds.midY - cam.y) / cam.z)
    landing.sort { hypot($0.0.worldRect.midX - centre.x, $0.0.worldRect.midY - centre.y) < hypot($1.0.worldRect.midX - centre.x, $1.0.worldRect.midY - centre.y) }
    CATransaction.setDisableActions(true)
    for (l, surface, scale, gen) in landing.prefix(HANDOVERS_PER_FRAME) { l.land(surface, scale, gen) }
    landing.removeFirst(min(HANDOVERS_PER_FRAME, landing.count))
    if landing.isEmpty { landingLink?.isPaused = true }
  }
  private func linksOn(_ ids: Set<String>) -> [String] {
    arrowLayers.values.filter { ids.contains($0.link.from.card) || ids.contains($0.link.to.card) }.map(\.link.id)
  }

  // MARK: camera
  var viewport: CGRect { bounds }
  func setCamera(_ c: Camera, animated: Bool) {
    var c = c
    c.z = min(Double(CanvasView.zMax), max(Double(zMin), c.z))
    let zoomed = c.z != cam.z
    if zoomed { zoomedAt = CACurrentMediaTime() }
    cam = c
    CATransaction.begin()
    CATransaction.setDisableActions(!animated)
    var t = CATransform3DMakeTranslation(c.x, c.y, 0)
    t = CATransform3DScale(t, c.z, c.z, 1)
    world.transform = t
    CATransaction.commit()
    wantLevel()
    cull()
    if rasterScale == 0 { rasterIfNeeded() } else if zoomed { settleRaster() }
    showPorts()
    showTether()
    followEdit()
    rested()
  }
  private func settleRaster() {
    if rasterBucket(zoom: cam.z, backing: backing) == rasterScale && deferred.isEmpty { settleTimer?.invalidate(); return }
    settleTimer?.invalidate()
    let t = Timer(timeInterval: CanvasView.RASTER_SETTLE, repeats: false) { [weak self] _ in self?.rasterIfNeeded() }
    RunLoop.main.add(t, forMode: .common)
    settleTimer = t
  }
  private func rested() {
    restTimer?.invalidate()
    let t = Timer(timeInterval: 0.4, repeats: false) { [weak self] _ in
      guard let self else { return }
      self.delegate?.canvas(self, cameraRested: self.cam)
    }
    RunLoop.main.add(t, forMode: .common)
    restTimer = t
  }
  func toWorld(_ p: CGPoint) -> CGPoint { CGPoint(x: (p.x - cam.x) / cam.z, y: (p.y - cam.y) / cam.z) }
  func toView(_ r: CGRect) -> CGRect { CGRect(x: r.minX * cam.z + cam.x, y: r.minY * cam.z + cam.y, width: r.width * cam.z, height: r.height * cam.z) }
  func zoom(by f: CGFloat, at p: CGPoint, animated: Bool = false) {
    let z = detentZoom(cam.z, min(CanvasView.zMax, max(zMin, cam.z * f)), at: p)
    let k = z / cam.z
    setCamera(Camera(x: p.x - (p.x - cam.x) * k, y: p.y - (p.y - cam.y) * k, z: z), animated: animated)
  }
  func pan(by d: CGPoint) { setCamera(Camera(x: cam.x + d.x, y: cam.y + d.y, z: cam.z), animated: false) }
  /** The whole board in view */
  func fitAll(animated: Bool = true) {
    var r: CGRect? = nil
    for l in cardLayers.values { r = r.map { $0.union(l.worldRect) } ?? l.worldRect }
    for l in sectionLayers.values { r = r.map { $0.union(l.frame) } ?? l.frame }
    guard let r, bounds.width > 0 else { return }
    let z = min(1.5, min((bounds.width - 80) / max(1, r.width), (bounds.height - 80) / max(1, r.height)))
    setCamera(Camera(x: (bounds.width - r.width * z) / 2 - r.minX * z, y: (bounds.height - r.height * z) / 2 - r.minY * z, z: z), animated: animated)
  }

  /** Zoom to z about the view's centre */
  func zoomAbout(_ z: Double) {
    let m = CGPoint(x: bounds.midX, y: bounds.midY), k = z / cam.z
    setCamera(Camera(x: m.x - (m.x - cam.x) * k, y: m.y - (m.y - cam.y) * k, z: z), animated: false)
  }
  /** A card brought into view when it is not (a new card put at the nearest free spot, off the middle): the camera moves as
   *  little as it must, the zoom kept; a card taller than the view shows its top */
  func reveal(_ id: String) {
    guard let l = cardLayers[id], bounds.width > 0 else { return }
    // the view a person reads: below the title row (the canvas runs under it), above the docks, with some air
    let r = l.worldRect, z = cam.z, top = safeAreaInsets.top + 24, bottom: CGFloat = 80, side: CGFloat = 40
    let vis = CGRect(x: (side - cam.x) / z, y: (top - cam.y) / z, width: (bounds.width - 2 * side) / z, height: (bounds.height - top - bottom) / z)
    if vis.contains(r) { return }
    func shift(_ lo: CGFloat, _ hi: CGFloat, _ vlo: CGFloat, _ vhi: CGFloat) -> CGFloat {
      hi - lo > vhi - vlo || lo < vlo ? vlo - lo : hi > vhi ? vhi - hi : 0
    }
    let dx = shift(r.minX, r.maxX, vis.minX, vis.maxX), dy = shift(r.minY, r.maxY, vis.minY, vis.maxY)
    setCamera(Camera(x: cam.x + dx * z, y: cam.y + dy * z, z: z), animated: true)
  }
  /** A card at the top left, zoom 1 */
  func focus(_ id: String) {
    guard let l = cardLayers[id] else { return }
    setCamera(Camera(x: 40 - l.card.x, y: 40 - l.card.y, z: 1), animated: false)
  }

  /** Cards far outside the view drop their bitmaps; ones coming near draw again before they are seen */
  private func cull() {
    let vis = CGRect(x: -cam.x / cam.z, y: -cam.y / cam.z, width: bounds.width / cam.z, height: bounds.height / cam.z)
    // half a view around: a card is drawn well before a pan's momentum brings it in (a bitmap landing in view is a flash)
    let near = vis.insetBy(dx: -vis.width * 0.5, dy: -vis.height * 0.5)
    // a card coming near while a zoom is still going draws at this zoom's bucket, not the settled one (zooming out from 1 brought
    // every card in at 2× backing: 40 full-size rasters and uploads inside the gesture)
    let s = rasterBucket(zoom: cam.z, backing: backing)
    CardLayer.near = near
    // mid-zoom (pinch, ⌘-scroll) a card with a sharp bitmap shows it scaled, and is drawn at the settled bucket afterwards; a
    // card with none draws now (its base shows until then). A card whose bitmap is current (a pan back to it) shows it as it is.
    // A card leaving keeps its bitmap until the budget needs the room (then its base is what it has)
    let zooming = CACurrentMediaTime() - zoomedAt < CanvasView.RASTER_SETTLE
    let now = CACurrentMediaTime()
    CardLayer.screenScale = backing
    for l in cardLayers.values where l.card.id != underEdit {
      let on = near.intersects(l.worldRect) && !folded.contains(l.card.id)
      if on, l.parked {
        if !vis.intersects(l.worldRect) { continue }
        l.parked = false
        l.drawn = false
      }
      if l.isHidden != !on || (on && !l.drawn) {
        l.isHidden = !on
        if !on { l.lastSeen = now; l.parked = false; continue }
        l.drawn = true
        if l.stale { l.recolor() }
        if l.hasSharp && !l.stale && l.faceScale == s { continue }
        if zooming && l.hasSharp { deferred.insert(l.card.id); continue }
        l.contentsScale = s
        l.setNeedsDisplay()
      } else if on {
        // drawn (or asked) at another bucket than this zoom's: drawn again, now or once the zoom settles (a camera restored
        // at open, then moved, left cards asked at the first one's bucket for good)
        if l.card.id != underEdit, l.askedScale != s, l.faceScale != s {
          if zooming { deferred.insert(l.card.id) } else { l.contentsScale = s; l.setNeedsDisplay() }
        } else if !zooming { l.fillTiles() }
      }
    }
    evict(vis)
    // cards put off to the settled bucket: a settle is due however this cull came (a resize, a scene change, a summary switch)
    if !deferred.isEmpty { settleRaster() }
    // stickers out of view are hidden: an animated one then plays no frames
    for l in stickerLayers.values { l.isHidden = !near.intersects(l.frame) }
  }
  /** The sharp tier's memory: above this the hidden cards' sharp bitmaps go, least recently seen first, down to 3/4 of it,
   *  then those near the view but not in it, farthest first (parked: drawn again once they are in view); their bases stay. The
   *  cards in view are never evicted */
  static let SHARP_BUDGET = 160 << 20
  private func evict(_ vis: CGRect) {
    var total = 0
    for l in cardLayers.values { total += l.sharpBytes }
    guard total > CanvasView.SHARP_BUDGET else { return }
    let goal = CanvasView.SHARP_BUDGET * 3 / 4
    for l in cardLayers.values.filter({ $0.isHidden && $0.sharpBytes > 0 }).sorted(by: { $0.lastSeen < $1.lastSeen }) {
      if total <= goal { return }
      total -= l.sharpBytes
      l.drop()
    }
    let c = CGPoint(x: vis.midX, y: vis.midY)
    for l in cardLayers.values.filter({ !$0.isHidden && $0.sharpBytes > 0 && !vis.intersects($0.worldRect) }).sorted(by: { hypot($0.worldRect.midX - c.x, $0.worldRect.midY - c.y) > hypot($1.worldRect.midX - c.x, $1.worldRect.midY - c.y) }) {
      if total <= goal { return }
      total -= l.sharpBytes
      l.drop()
      l.drawn = true
      l.parked = true
    }
  }
  /** The cards in view not sharp over the view at the zoom's bucket (a base shows, or a tile row in view has not landed), with
   *  why, for the checks; none at the summary level (the cards are not shown there) */
  var softInView: [String] {
    guard level == 0 else { return [] }
    let vis = CGRect(x: -cam.x / cam.z, y: -cam.y / cam.z, width: bounds.width / cam.z, height: bounds.height / cam.z)
    let s = rasterBucket(zoom: cam.z, backing: backing)
    return cardLayers.values.filter { !$0.isHidden && $0.card.id != underEdit && vis.intersects($0.worldRect) }.compactMap { l in
      l.sharpMissing(in: vis, scale: s).map { "\(l.card.id): \($0)" }
    }
  }
  /** The sharp tier's bytes, for the checks */
  var sharpBytes: Int { cardLayers.values.reduce(0) { $0 + $1.sharpBytes } }
  /** The bitmap scale follows the zoom in buckets: crossing one redraws the cards at the new scale (the old bitmap stays until
   *  then), nearest the middle of the view first, in the run loop's own transaction (an explicit commit here waited on the
   *  render server) */
  private func rasterIfNeeded() {
    let s = rasterBucket(zoom: cam.z, backing: backing)
    deferred = []
    let changed = s != rasterScale
    rasterScale = s
    CATransaction.setDisableActions(true)
    // every shown card whose sharp tier is not at this bucket (nor asked at it) draws again: by what it shows, not by its
    // contentsScale (a card that was hidden when the bucket changed got the scale without a raster, and kept the old bitmap)
    for l in cardLayers.values {
      if l.isHidden { l.contentsScale = s; continue }
      if l.parked || l.card.id == underEdit { continue }
      if l.stale || (l.faceScale != s && l.askedScale != s) {
        l.contentsScale = s
        l.setNeedsDisplay()
      }
    }
    guard changed else { return }
    for l in sectionLayers.values { l.setScale(s) }
    for l in arrowLayers.values { l.setScale(max(s, 1)) }
    for l in stickerLayers.values { l.setScale(max(s, 1)) }
  }
  private var themeName: String { effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? "dark" : "light" }
  func redrawAll() {
    Theme.appearance = effectiveAppearance
    layer?.backgroundColor = Theme.bg.cgColor
    layoutScene()
    tellLook()
    notes.setTheme(themeName)
    edit.page.call("cb.setup(\(encodeJSON(["theme": themeName, "look": Theme.look])))")
    // the cards near the view draw again (each keeps its old bitmap until the new one lands, a few per frame, nearest first); the
    // rest when they come near
    for l in cardLayers.values {
      l.needBase()
      if l.isHidden && l.card.id != underEdit { l.stale = true; l.drawn = false } else { l.recolor(); l.setNeedsDisplay() }
    }
    for l in sectionLayers.values { l.restyle() }
    for l in arrowLayers.values { l.recolor(); l.drawLabel() }
    for l in stickerLayers.values { l.draw() }
    routeAll()
    recolorOverlay()
  }
  private func recolorOverlay() {
    Theme.appearance.performAsCurrentDrawingAppearance {
      marquee.strokeColor = Theme.accent.cgColor
      marquee.fillColor = Theme.accent.withAlphaComponent(0.08).cgColor
      ports.fillColor = Theme.surface.cgColor
      ports.strokeColor = Theme.accent.cgColor
      rubber.strokeColor = Theme.accent.cgColor
      tether.strokeColor = Theme.accent.cgColor
      tetherDot.fillColor = Theme.accent.cgColor
    }
  }
  /** The tether of the one selected sticker bound to a card (its corner) or an arrow (the point along it), in view coordinates */
  private func showTether() {
    guard selectedStickers.count == 1, let id = selectedStickers.first, let l = stickerLayers[id], l.sticker.card != nil || l.sticker.link != nil else {
      tether.isHidden = true
      tetherDot.isHidden = true
      return
    }
    let from: CGPoint
    if let card = l.sticker.card, let c = cardLayers[card] { from = c.worldRect.origin } else if l.sticker.link != nil { from = l.anchor } else { tether.isHidden = true; tetherDot.isHidden = true; return }
    let a = toView(CGRect(origin: from, size: .zero)).origin
    let b = toView(CGRect(origin: CGPoint(x: l.frame.midX, y: l.frame.midY), size: .zero)).origin
    let path = CGMutablePath()
    path.move(to: a)
    path.addLine(to: b)
    tether.path = path
    tetherDot.path = CGPath(ellipseIn: CGRect(x: a.x - 2.5, y: a.y - 2.5, width: 5, height: 5), transform: nil)
    tether.isHidden = false
    tetherDot.isHidden = false
  }
  func selectStickers(_ ids: Set<String>) {
    for id in selectedStickers.subtracting(ids) { stickerLayers[id]?.selected = false }
    for id in ids.subtracting(selectedStickers) { stickerLayers[id]?.selected = true }
    selectedStickers = ids
    showTether()
  }
  private func stickerAt(_ world: CGPoint) -> StickerLayer? {
    stickerLayers.values.filter { !$0.isHidden && $0.frame.contains(world) }.min { $0.frame.width < $1.frame.width }
  }
  /** The sticker's rectangle in view coordinates (the question popover's anchor) */
  func stickerRect(_ id: String) -> CGRect? { stickerLayers[id].map { toView($0.frame) } }
  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    redrawAll()
  }
  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    rasterScale = 0
    rasterIfNeeded()
  }
  override func layout() {
    layoutScene()
    super.layout()
    overlay.frame = bounds
    // the zoom floor and the cull once the resize ends (viewDidEndLiveResize): not per frame of it
    if !inLiveResize { floorZoom() }
    cutLine.frame = CGRect(x: bounds.width * 0.12, y: bounds.height - 20, width: bounds.width * 0.76, height: 2)
    cutFill.bounds = CGRect(origin: .zero, size: cutLine.bounds.size)
    cutFill.position = CGPoint(x: cutLine.bounds.midX, y: cutLine.bounds.midY)
    seal.position = CGPoint(x: bounds.width - 28 - seal.bounds.width / 2, y: bounds.height - 68 - seal.bounds.height / 2)
    if !inLiveResize { cull() }
  }
  override func viewDidEndLiveResize() {
    super.viewDidEndLiveResize()
    sceneImage = nil
    layoutScene()
    floorZoom()
    cull()
  }
  /** Undo / Redo from the menu reach the board, not the window's own (empty) undo manager; other keys are not the board's and
   *  do not beep */
  @objc func undo(_ sender: Any?) { delegate?.canvasUndo(self) }
  @objc func redo(_ sender: Any?) { delegate?.canvasRedo(self) }

  // MARK: input
  override func scrollWheel(with e: NSEvent) {
    if e.modifierFlags.contains(.command) {
      let p = convert(e.locationInWindow, from: nil)
      zoom(by: pow(1.0045, -e.scrollingDeltaY), at: p)
    } else {
      pan(by: CGPoint(x: e.scrollingDeltaX, y: e.scrollingDeltaY))
    }
  }
  override func magnify(with e: NSEvent) {
    zoom(by: 1 + e.magnification, at: convert(e.locationInWindow, from: nil))
  }

  private var drag: (ids: [String], start: CGPoint, origins: [String: CGPoint], links: [String], moved: Bool)?
  /** Where the dragged cards go once their arrows are routed (by request number): card and arrows move together, one frame
   *  behind the pointer, never apart */
  private var dragTargets: [Int: [String: CGPoint]] = [:]
  private var panStart: CGPoint?
  /** A sticker pressed: the layer follows the pointer, core moves it live once the drag is under way (3 px), binds it on the drop */
  private var stickerDrag: (id: String, start: CGPoint, origin: CGPoint, moved: Bool)?
  private var marqueeStart: CGPoint?
  private var resizing: (id: String, start: CGPoint, w: CGFloat, h: CGFloat, right: Bool, bottom: Bool)?
  private var linking: (from: String, port: CGPoint)?
  /** The pointer, for cards made with a key */
  private var pointer = CGPoint(x: 200, y: 200)

  func cardAt(_ world: CGPoint) -> CardLayer? {
    for id in order.reversed() {
      if let l = cardLayers[id], !l.isHidden, l.worldRect.contains(world) { return l }
    }
    return nil
  }
  private func sectionAt(_ world: CGPoint) -> SectionLayer? {
    sectionLayers.values.filter { $0.frame.contains(world) }.min { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
  }
  /** The arrow whose line passes within 6 screen px of the point */
  private func arrowAt(_ world: CGPoint) -> ArrowLayer? {
    let tol = 6 / cam.z
    return arrowLayers.values.first { $0.hit(world, tolerance: tol) }
  }
  /** The port dots of the one selected card: the midpoints of its four sides, in world units */
  private func portPoints(_ l: CardLayer) -> [CGPoint] {
    let r = l.worldRect
    return [CGPoint(x: r.midX, y: r.minY), CGPoint(x: r.maxX, y: r.midY), CGPoint(x: r.midX, y: r.maxY), CGPoint(x: r.minX, y: r.midY)]
  }
  /** The card under the pointer: its port dots show (styles.css .card:hover .eport; a Text card has none) */
  private var hovered: String? {
    didSet { if hovered != oldValue { showPorts() } }
  }
  private func showPorts() {
    guard let id = hovered, let l = cardLayers[id], !(l.card.kind == "note" && l.card.look != "note"), !edit.active, drag == nil else { ports.isHidden = true; return }
    let path = CGMutablePath()
    for p in portPoints(l) {
      let v = toView(CGRect(origin: p, size: .zero)).origin
      path.addEllipse(in: CGRect(x: v.x - 4, y: v.y - 4, width: 8, height: 8))
    }
    ports.path = path
    ports.lineWidth = 1.5
    ports.isHidden = false
  }
  /** A port dot under the point (view coordinates): the card and the dot's world point */
  private func portAt(_ p: CGPoint) -> (String, CGPoint)? {
    guard let id = hovered, let l = cardLayers[id], !(l.card.kind == "note" && l.card.look != "note") else { return nil }
    for q in portPoints(l) {
      let v = toView(CGRect(origin: q, size: .zero)).origin
      if hypot(v.x - p.x, v.y - p.y) <= 7 { return (id, q) }
    }
    return nil
  }
  /** The resize zone of a selected card: within 7 screen px inside its right edge or bottom edge */
  private func resizeEdge(_ l: CardLayer, _ world: CGPoint) -> (right: Bool, bottom: Bool)? {
    guard selected.contains(l.card.id), l.card.locked != true else { return nil }
    let r = l.worldRect, tol = 7 / cam.z
    let right = abs(world.x - r.maxX) <= tol, bottom = l.card.kind != "image" && abs(world.y - r.maxY) <= tol
    return right || bottom ? (right, bottom) : nil
  }
  private func editable(_ c: SceneCard) -> Bool { c.kind == "note" || (c.kind == "code" && c.segments?.first?.path == "") }

  override func mouseDown(with e: NSEvent) {
    window?.makeFirstResponder(self)
    let p = convert(e.locationInWindow, from: nil)
    let w = toWorld(p)
    if edit.active { endEdit(commit: true) }
    if e.clickCount == 2 {
      if let k = stickerAt(w) {
        if k.sticker.q != nil { delegate?.canvas(self, editQuestion: k.sticker.id, at: toView(k.frame)) }
      } else if let l = cardAt(w) {
        if editable(l.card) { select([l.card.id]); delegate?.canvas(self, editCard: l.card.id) } else if let b = l.card.board { delegate?.canvas(self, openBoard: b) }
      } else if let s = sectionAt(w), w.y - s.frame.minY < 30 {
        renameSection(s)
      } else {
        delegate?.canvas(self, newNoteAt: w)
      }
      return
    }
    if let (from, port) = portAt(p) {
      linking = (from, port)
      rubber.isHidden = false
      return
    }
    // stickers sit above the cards (styles.css .stk.canvas z-index 4); a press starts a drag (the board's startStickerDrag)
    if let k = stickerAt(w) {
      select([])
      selectLinks([])
      selectSections([])
      selectStickers(e.modifierFlags.contains(.shift) ? selectedStickers.symmetricDifference([k.sticker.id]) : [k.sticker.id])
      stickerDrag = (k.sticker.id, p, k.frame.origin, false)
      return
    }
    selectStickers([])
    // the head's sidenote chip (the board's marker: hover shows, click pins): the card's Sidenotes
    if let l = cardAt(w), let chip = l.chipRect, chip.insetBy(dx: -4, dy: -4).contains(CGPoint(x: w.x - l.card.x, y: w.y - l.card.y)) {
      select([l.card.id])
      delegate?.canvas(self, showSidenotes: l.card.id)
      return
    }
    // the Arrow tool: the next drag from a card to another makes a link
    if arrowMode, let l = cardAt(w) {
      arrowMode = false
      linking = (l.card.id, CGPoint(x: l.worldRect.midX, y: l.worldRect.midY))
      rubber.isHidden = false
      return
    }
    if let l = cardAt(w), let edge = resizeEdge(l, w) {
      resizing = (l.card.id, p, l.frame.width, l.height, edge.right, edge.bottom)
      delegate?.canvasResizeBegan(self)
      return
    }
    guard let l = cardAt(w) else {
      if let a = arrowAt(w) {
        selectLinks(e.modifierFlags.contains(.shift) ? selectedLinks.union([a.link.id]) : [a.link.id])
        select([])
        return
      }
      selectLinks([])
      if let s = sectionAt(w), w.y - s.frame.minY < 30 {
        // the leading 14 px of the title bar fold / unfold it
        if w.x - s.frame.minX < 14 { fold(s, shut: s.section.collapsed != true); return }
        selectSections([s.section.id])
        select([])
        return
      }
      selectSections([])
      if e.modifierFlags.contains(.option) {
        panStart = p
      } else {
        select([])
        marqueeStart = p
      }
      return
    }
    selectLinks([])
    selectSections([])
    if l.card.locked == true { select([l.card.id]); return }
    if e.modifierFlags.contains(.shift) { select(selected.symmetricDifference([l.card.id])) } else if !selected.contains(l.card.id) { select([l.card.id]) }
    // a locked card in the selection stays where it is
    let ids = selected.filter { cardLayers[$0]?.card.locked != true }
    if !ids.isEmpty { beginDrag(Array(ids), at: p) }
  }
  func beginDrag(_ ids: [String], at p: CGPoint) {
    var origins: [String: CGPoint] = [:]
    for id in ids { if let l = cardLayers[id] { origins[id] = l.worldRect.origin } }
    drag = (ids, p, origins, linksOn(Set(ids)), false)
  }
  override func mouseMoved(with e: NSEvent) {
    pointer = toWorld(convert(e.locationInWindow, from: nil))
    hovered = cardAt(pointer)?.card.id
  }
  override func mouseExited(with e: NSEvent) { hovered = nil }
  private var tracking: NSTrackingArea?
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    let t = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
    addTrackingArea(t)
    tracking = t
  }
  override func mouseDragged(with e: NSEvent) {
    let p = convert(e.locationInWindow, from: nil)
    pointer = toWorld(p)
    if var d = stickerDrag {
      let dx = (p.x - d.start.x) / cam.z, dy = (p.y - d.start.y) / cam.z
      if !d.moved, hypot(p.x - d.start.x, p.y - d.start.y) < 3 { return }
      if !d.moved { delegate?.canvasStickerDragBegan(self) }
      d.moved = true
      stickerDrag = d
      let to = CGPoint(x: d.origin.x + dx, y: d.origin.y + dy)
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      stickerLayers[d.id]?.frame.origin = to
      CATransaction.commit()
      showTether()
      delegate?.canvas(self, dragSticker: d.id, to: to)
      return
    }
    if let s = panStart {
      pan(by: CGPoint(x: p.x - s.x, y: p.y - s.y))
      panStart = p
      return
    }
    if let s = marqueeStart {
      marquee.isHidden = false
      marquee.path = CGPath(rect: CGRect(x: min(s.x, p.x), y: min(s.y, p.y), width: abs(p.x - s.x), height: abs(p.y - s.y)), transform: nil)
      return
    }
    if let (_, port) = linking {
      let a = toView(CGRect(origin: port, size: .zero)).origin
      let path = CGMutablePath()
      path.move(to: a)
      path.addLine(to: p)
      rubber.path = path
      return
    }
    if let r = resizing, let l = cardLayers[r.id] {
      let dx = (p.x - r.start.x) / cam.z, dy = (p.y - r.start.y) / cam.z
      let w = r.right ? max(120, r.w + dx) : r.w
      let h = r.bottom ? max(40, r.h + dy) : r.h
      l.resize(to: CGSize(width: w, height: h))
      delegate?.canvas(self, resizing: r.id, w: Double(w), h: r.bottom ? .fixed(Double(h)) : .keep)
      routeAround([r.id])
      showPorts()
      return
    }
    dragTo(p)
  }
  func dragTo(_ p: CGPoint) {
    guard var d = drag else { return }
    let dx = (p.x - d.start.x) / cam.z, dy = (p.y - d.start.y) / cam.z
    if !d.moved && hypot(dx, dy) * cam.z < 3 { return }
    d.moved = true
    drag = d
    var targets: [String: CGPoint] = [:]
    for id in d.ids { if let o = d.origins[id] { targets[id] = CGPoint(x: o.x + dx, y: o.y + dy) } }
    if d.links.isEmpty || router == nil {
      moveCards(targets)
      if !d.links.isEmpty { route(rects, only: d.links, modes: nil) }
      return
    }
    // the arrows are routed off the main thread for where the cards are going; cards and arrows then move in one frame. Only
    // the rectangles routing reads: the dragged cards' and those at the other ends of their arrows
    var rs: [String: WorldRect] = [:]
    for l in d.links { if let a = arrowLayers[l] { for id in [a.link.from.card, a.link.to.card] { if let c = cardLayers[id] { rs[id] = WorldRect(x: c.card.x, y: c.card.y, w: c.card.w, h: Double(c.height)) } } } }
    for (id, t) in targets { if let r = rs[id] { rs[id] = WorldRect(x: t.x, y: t.y, w: r.w, h: r.h) } }
    routeSeq += 1
    dragTargets[routeSeq] = targets
    routeLive(d.links, rects: rs, seq: routeSeq)
  }
  private func moveCards(_ targets: [String: CGPoint]) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for (id, t) in targets { cardLayers[id]?.move(to: t) }
    CATransaction.commit()
  }
  override func mouseUp(with e: NSEvent) {
    let p = convert(e.locationInWindow, from: nil)
    panStart = nil
    if let d = stickerDrag {
      stickerDrag = nil
      guard d.moved else { return }
      let to = CGPoint(x: d.origin.x + (p.x - d.start.x) / cam.z, y: d.origin.y + (p.y - d.start.y) / cam.z)
      // dropped on a card (⌥ held: stays free, as the board) it rides that card
      let w = toWorld(p)
      let on = e.modifierFlags.contains(.option) ? nil : cardAt(w)?.card.id
      delegate?.canvas(self, dropSticker: d.id, at: to, on: on)
      return
    }
    if let s = marqueeStart {
      marqueeStart = nil
      marquee.isHidden = true
      let r = CGRect(x: min(s.x, p.x), y: min(s.y, p.y), width: abs(p.x - s.x), height: abs(p.y - s.y))
      if r.width > 3 || r.height > 3 {
        let wr = CGRect(origin: toWorld(r.origin), size: CGSize(width: r.width / cam.z, height: r.height / cam.z))
        select(Set(cardLayers.values.filter { !$0.isHidden && wr.intersects($0.worldRect) }.map(\.card.id)))
      }
      return
    }
    if let (from, _) = linking {
      linking = nil
      rubber.isHidden = true
      if let to = cardAt(toWorld(p)), to.card.id != from { delegate?.canvas(self, linkFrom: from, to: to.card.id) }
      return
    }
    if resizing != nil {
      resizing = nil
      delegate?.canvasResizeEnded(self)
      return
    }
    endDrag()
    showPorts()
  }
  func endDrag() {
    guard let d = drag else { return }
    drag = nil
    if !d.moved { return }
    dropPending = !d.links.isEmpty
    // a move still waiting for its routes is the drop's: core puts the card there and the final routes come with it (apply),
    // in one frame
    let last = dragTargets.keys.max().flatMap { dragTargets[$0] } ?? [:]
    dragTargets = [:]
    let moves = d.ids.compactMap { id in
      cardLayers[id].map {
        let at = last[id] ?? $0.worldRect.origin
        return JSBridge.Move(id: id, x: Double(at.x), y: Double(at.y), w: Double($0.worldRect.width), h: Double($0.worldRect.height))
      }
    }
    delegate?.canvas(self, dragEnded: moves)
  }
  func select(_ ids: Set<String>) {
    for id in selected.subtracting(ids) { cardLayers[id]?.selected = false }
    for id in ids.subtracting(selected) { cardLayers[id]?.selected = true }
    selected = ids
    showPorts()
  }
  private func selectLinks(_ ids: Set<String>) {
    for id in selectedLinks.subtracting(ids) { arrowLayers[id]?.selected = false }
    for id in ids.subtracting(selectedLinks) { arrowLayers[id]?.selected = true }
    selectedLinks = ids
  }
  private func selectSections(_ ids: Set<String>) {
    for id in selectedSections.subtracting(ids) { sectionLayers[id]?.selected = false }
    for id in ids.subtracting(selectedSections) { sectionLayers[id]?.selected = true }
    selectedSections = ids
  }
  override func selectAll(_ sender: Any?) { select(Set(cardLayers.keys)) }

  // MARK: keys and the Edit menu (the responder chain: the edit card's web view takes them while it has focus)
  override func keyDown(with e: NSEvent) {
    let mods = e.modifierFlags.intersection([.command, .option, .control, .shift])
    switch (e.charactersIgnoringModifiers ?? "", mods) {
    case ("\u{7f}", []), ("\u{f728}", []): delete(nil)
    case ("\u{1b}", []): select([]); selectLinks([]); selectSections([]); selectStickers([])
    case ("n", []): delegate?.canvas(self, newCard: "note", at: pointer)
    case ("t", []): delegate?.canvas(self, newCard: "text", at: pointer)
    case ("c", []): delegate?.canvas(self, newCard: "code", at: pointer)
    case ("s", []): if selected.count == 1, let id = selected.first { delegate?.canvas(self, addSidenoteTo: id) }
    default: break  // not the board's: no beep
    }
  }
  @objc func delete(_ sender: Any?) {
    if !selectedStickers.isEmpty { delegate?.canvas(self, deleteStickers: Array(selectedStickers)) }
    guard !selected.isEmpty || !selectedLinks.isEmpty || !selectedSections.isEmpty else { return }
    delegate?.canvas(self, deleteCards: Array(selected), links: Array(selectedLinks), sections: Array(selectedSections))
  }
  // MARK: the sticker menu (the board's stickerMenu: question, Color, Size, Detach, Delete)
  override func menu(for e: NSEvent) -> NSMenu? {
    let w = toWorld(convert(e.locationInWindow, from: nil))
    guard let k = stickerAt(w) else { return super.menu(for: e) }
    selectStickers([k.sticker.id])
    let s = k.sticker, id = s.id
    let m = NSMenu()
    func item(_ title: String, _ sel: Selector, _ value: Any? = nil, checked: Bool = false) -> NSMenuItem {
      let it = NSMenuItem(title: title, action: sel, keyEquivalent: "")
      it.target = self
      it.representedObject = StickerRef(id: id, value: value)
      it.state = checked ? .on : .off
      return it
    }
    if let q = s.q {
      m.addItem(item(q.md.isEmpty ? "Write Question" : "Edit Question", #selector(menuEditQuestion(_:))))
      m.addItem(item(q.done ? "Reopen" : "Mark Answered", #selector(menuAnswered(_:)), !q.done))
      m.addItem(.separator())
    }
    if s.emoji != true {
      let colour = NSMenuItem(title: "Color", action: nil, keyEquivalent: "")
      let sub = NSMenu()
      sub.addItem(item("Default", #selector(menuColor(_:)), nil, checked: s.color == nil))
      for (name, hex) in zip(CanvasView.stickerColorNames, CanvasView.stickerColors) { sub.addItem(item(name, #selector(menuColor(_:)), hex, checked: s.color == hex)) }
      colour.submenu = sub
      m.addItem(colour)
    }
    let size = NSMenuItem(title: "Size", action: nil, keyEquivalent: "")
    let sizes = NSMenu()
    for n in [24, 32, 48, 72] { sizes.addItem(item("\(n)px", #selector(menuSize(_:)), Double(n), checked: Int(s.size) == n)) }
    size.submenu = sizes
    m.addItem(size)
    if s.card != nil || s.link != nil { m.addItem(item(s.card != nil ? "Detach from Card" : "Detach from Arrow", #selector(menuDetach(_:)))) }
    m.addItem(.separator())
    m.addItem(item("Delete", #selector(menuDelete(_:))))
    return m
  }
  /** The board's STICKER_COLORS (packages/board/src/stickers/glyphs.tsx) and their menu names */
  static let stickerColors = ["#E3A132", "#E8743B", "#D9534F", "#E25D8B", "#8B6FD6", "#4C8BF5", "#3FA36B", "#6B7280"]
  static let stickerColorNames = ["Gold", "Orange", "Red", "Pink", "Purple", "Blue", "Green", "Grey"]
  private final class StickerRef: NSObject {
    let id: String
    let value: Any?
    init(id: String, value: Any?) {
      self.id = id
      self.value = value
    }
  }
  private func ref(_ sender: Any?) -> StickerRef? { (sender as? NSMenuItem)?.representedObject as? StickerRef }
  @objc private func menuEditQuestion(_ sender: Any?) { if let r = ref(sender), let k = stickerLayers[r.id] { delegate?.canvas(self, editQuestion: r.id, at: toView(k.frame)) } }
  @objc private func menuAnswered(_ sender: Any?) { if let r = ref(sender) { delegate?.canvas(self, sticker: r.id, answered: r.value as? Bool ?? true) } }
  @objc private func menuColor(_ sender: Any?) { if let r = ref(sender) { delegate?.canvas(self, sticker: r.id, color: r.value as? String) } }
  @objc private func menuSize(_ sender: Any?) { if let r = ref(sender), let n = r.value as? Double { delegate?.canvas(self, sticker: r.id, size: n) } }
  @objc private func menuDetach(_ sender: Any?) { if let r = ref(sender), let k = stickerLayers[r.id] { delegate?.canvas(self, detachSticker: r.id, at: k.frame.origin) } }
  @objc private func menuDelete(_ sender: Any?) { if let r = ref(sender) { delegate?.canvas(self, deleteStickers: [r.id]) } }
  /** The selected card's sidenotes (the Insert menu) */
  @objc func showSidenotes(_ sender: Any?) {
    guard let id = selected.first, selected.count == 1 else { return }
    delegate?.canvas(self, showSidenotes: id)
  }
  @objc func copy(_ sender: Any?) { delegate?.canvasCopy(self) }
  @objc func paste(_ sender: Any?) { delegate?.canvasPaste(self) }
  @objc func duplicate(_ sender: Any?) { delegate?.canvasDuplicate(self) }
  @objc func newSection(_ sender: Any?) { delegate?.canvasNewSection(self) }
  @objc func turnIntoBoard(_ sender: Any?) { delegate?.canvasTurnIntoBoard(self) }
  /** Fold / unfold the selected Sections */
  @objc func foldSection(_ sender: Any?) {
    for id in selectedSections { if let s = sectionLayers[id] { fold(s, shut: s.section.collapsed != true) } }
  }
  private func fold(_ s: SectionLayer, shut: Bool) {
    let k = s.section
    delegate?.canvas(self, foldSection: k.id, shut: shut, open: WorldRect(x: k.x, y: k.y, w: k.w, h: k.h))
  }
  /** The Arrow tool is armed: the next drag from a card links it to the card it ends on */
  var arrowMode = false
  /** Cards inside folded Sections: not drawn, not hit */
  private var folded: Set<String> = []
  /** After a scene change: which cards folded Sections hide, and the arrows between them */
  private func refold() {
    var shut = Set(sectionLayers.values.filter { $0.section.collapsed == true }.map { $0.section.id })
    // a Section inside a folded one is folded with it
    var grew = true
    while grew {
      grew = false
      for s in sectionLayers.values where !shut.contains(s.section.id) {
        if let p = s.section.parent, shut.contains(p) { shut.insert(s.section.id); grew = true }
      }
    }
    let was = folded
    folded = Set(cardLayers.values.filter { c in c.card.section.map { shut.contains($0) } ?? false }.map { $0.card.id })
    for id in was.subtracting(folded) { if let l = cardLayers[id] { l.isHidden = false; if l.stale { l.recolor() }; l.setNeedsDisplay(); l.drawn = true } }
    for id in folded.subtracting(was) { if let l = cardLayers[id] { l.isHidden = true; l.drop() } }
    for s in sectionLayers.values { s.isHidden = s.section.parent.map { shut.contains($0) } ?? false }
    for a in arrowLayers.values { a.isHidden = folded.contains(a.link.from.card) || folded.contains(a.link.to.card) }
    if folded != was { select(selected.subtracting(folded)) }
  }

  // MARK: image files dragged in
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { imageDrop(sender) == nil ? [] : .copy }
  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    guard let (data, name) = imageDrop(sender) else { return false }
    delegate?.canvas(self, dropImage: data, name: name, at: toWorld(convert(sender.draggingLocation, from: nil)))
    return true
  }
  private func imageDrop(_ sender: NSDraggingInfo) -> (Data, String)? {
    let pb = sender.draggingPasteboard
    if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], let u = urls.first {
      guard CanvasView.imageExts.contains(u.pathExtension.lowercased()), let d = try? Data(contentsOf: u) else { return nil }
      return (d, u.lastPathComponent)
    }
    if let d = pb.data(forType: .png) { return (d, "image.png") }
    if let d = pb.data(forType: .tiff), let png = NSBitmapImageRep(data: d)?.representation(using: .png, properties: [:]) { return (png, "image.png") }
    return nil
  }
  static let imageExts: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "tiff", "bmp"]

  // MARK: editing a card in place
  /** Start the editor over the card (the delegate asked core for its text) */
  func beginEdit(_ id: String, text: String, kind: String, lang: String?) {
    guard let l = cardLayers[id] else { return }
    select([id])
    ports.isHidden = true
    edit.begin(l.card, text: text, kind: kind, lang: lang, frame: toView(l.worldRect), zoom: cam.z)
  }
  /** The card's sidenotes panel beside it (the page's cb.sidenotes); open = the note to start editing */
  func beginSidenotes(_ c: SceneCard, items: [JSBridge.SidenoteText], open: String?) {
    guard let l = cardLayers[c.id] else { return }
    if edit.active { endEdit(commit: true) }
    select([c.id])
    ports.isHidden = true
    edit.beginSidenotes(c, items: items, open: open, frame: toView(l.worldRect), zoom: cam.z)
  }
  private func followEdit() {
    guard edit.active, let c = edit.card, let l = cardLayers[c.id] else { return }
    edit.follow(frame: toView(l.worldRect), zoom: cam.z)
  }
  /** The card whose bitmap is hidden under the editor's view */
  private var underEdit: String?
  /** An edit that ended: the card, the text as edited (nil: not committed, or the page did not answer: the last live write stands),
   *  and what the edit was when it began (not the editor's state at reply time: another edit may have started by then) */
  struct EditEnd {
    var id: String
    var text: String?
    var kind: String
    var original: String
    var changed: Bool
  }
  var onEditEnded: ((EditEnd) -> Void)?
  /** The editor's content process died: nothing is written (the last live write stands), the card shows itself again */
  var onEditCrashed: (() -> Void)?
  /** End the edit: commit = the text goes to core (the delegate writes it); the editor stays on screen until the card shows it.
   *  done: once the page answered (the text written) or, when it does not within `wait` seconds (longer before a close or quit:
   *  the reply is the text), anyway */
  func endEdit(commit: Bool, wait: Double = 1, done: (() -> Void)? = nil) {
    guard edit.active, let c = edit.card else { done?(); return }
    var over = false
    let was = EditEnd(id: c.id, text: nil, kind: edit.kind, original: edit.original, changed: edit.changed)
    let finish = { [weak self] (v: String?) in
      guard !over, let self else { return }
      over = true
      var e = was
      e.text = commit ? v : nil
      e.changed = e.changed || self.edit.changed
      self.onEditEnded?(e)
      self.showPorts()
      done?()
    }
    edit.end(finish)
    after(wait) { finish(nil) }
  }
  /** The card's new bitmap landed after an edit (or 400 ms passed): the editor's view goes */
  private var awaitingRender: String?
  func hideEditorWhenRendered(_ id: String) {
    awaitingRender = id
    edit.shown = true
    after(0.4) { [weak self] in if self?.awaitingRender == id { self?.rendered(id) } }
  }
  private func rendered(_ id: String) {
    if awaitingRender == id {
      awaitingRender = nil
      edit.shown = false
    }
  }

  /** Rename a Section in a field over its title */
  private var titleField: NSTextField?
  private func renameSection(_ s: SectionLayer) {
    titleField?.removeFromSuperview()
    let r = toView(CGRect(x: s.frame.minX + 14, y: s.frame.minY + 6, width: max(120, s.frame.width - 28), height: 22))
    let f = NSTextField(frame: r)
    f.stringValue = s.section.title
    f.font = Theme.sys(12.5 * cam.z, weight: .semibold)
    f.target = self
    f.action = #selector(titleEntered(_:))
    f.identifier = NSUserInterfaceItemIdentifier(s.section.id)
    addSubview(f)
    window?.makeFirstResponder(f)
    titleField = f
  }
  @objc private func titleEntered(_ f: NSTextField) {
    guard let id = f.identifier?.rawValue else { return }
    f.removeFromSuperview()
    titleField = nil
    window?.makeFirstResponder(self)
    delegate?.canvas(self, renameSection: id, title: f.stringValue)
  }

  /** The canvas as drawn, for the debug snapshot (no screen capture needed) */
  func snapshot() -> NSBitmapImageRep? {
    guard let rep = bitmapImageRepForCachingDisplay(in: bounds) else { return nil }
    cacheDisplay(in: bounds, to: rep)
    return rep
  }
}

// MARK: the summary level, the detent at its cut and the switch (Summaries.swift; the rules are core's canvas/detent.ts)
extension CanvasView {
  func setSummaries(_ s: SumScene) {
    summaries.apply(s, backing: backing)
    floorZoom()
    wantLevel()
  }
  /** The zoom floor follows the board's content and the view's size */
  func floorZoom() {
    guard bounds.width > 0, let s = summaries.scene else { return }
    zMin = CGFloat(DetentRules.minZoom(view: bounds.size, content: s.content))
    if cam.z < zMin { setCamera(cam, animated: false) }
  }
  /** The level the zoom asks for: a programmatic zoom crosses the cut freely and gets the covered switch too */
  private func wantLevel() {
    // the rule asked only when the zoom is on the other side of the cut from the level shown (not a thread hop every frame)
    guard switchTimer == nil, summaries.cut > 0, (cam.z < summaries.cut) != (level == 1) else { return }
    let want = DetentRules.levelFor(cam.z, summaries.cut)
    if want != level { runSwitch(to: want, at: nil) }
  }
  /** A zoom step from z0 to z (core detentZoom): towards the cut it stops there and pushes into the detent; through, the switch
   *  runs. While the switch runs, steps towards the cut are held at it */
  private func detentZoom(_ z0: CGFloat, _ z: CGFloat, at p: CGPoint) -> CGFloat {
    let cut = summaries.cut
    guard cut > 0 else { return z }
    if !DetentRules.towardCut(z0, z, cut, level) {
      if push > 0, switchTimer == nil {
        push = 0
        show(.rest)
      }
      return z
    }
    if switchTimer != nil { return z0 == cut || (level == 0 ? z0 < cut : z0 > cut) ? z0 : cut }
    let to = level == 0 ? 1 : 0
    push = DetentRules.pushStep(push, z0, z)
    pushedAt = CACurrentMediaTime()
    if push >= 1 { runSwitch(to: to, at: p) } else {
      show(DetentRules.pushed(push, to))
      drain(to)
    }
    return cut
  }
  /** Let go before it is through, the push drains (a timer only while it does: nothing ticks at rest) */
  private func drain(_ to: Int) {
    guard drainTimer == nil else { return }
    var last = CACurrentMediaTime()
    let t = Ticker(self) { [weak self] t in
      guard let self else { t.invalidate(); return }
      let now = CACurrentMediaTime()
      if self.switchTimer != nil || self.push <= 0 { t.invalidate(); self.drainTimer = nil; return }
      if (now - self.pushedAt) * 1000 > DetentRules.times.drainAfter {
        self.push = DetentRules.drainStep(self.push, now - last)
        self.show(self.push <= 0 ? .rest : DetentRules.pushed(self.push, to))
      }
      last = now
      if self.push <= 0 { t.invalidate(); self.drainTimer = nil }
    }
    drainTimer = t
  }
  /** The switch: the mist covers the board (from where the push left it), the levels swap under it in one frame, the camera
   *  is set just across the cut around the push point, and the mist clears */
  private func runSwitch(to: Int, at: CGPoint?) {
    switchTimer?.invalidate()
    push = 0
    let mist0 = mist.isHidden ? 0 : Double(mist.bounds.height / max(1, bounds.height))
    let t0 = CACurrentMediaTime()
    var covered = false
    let t = Ticker(self) { [weak self] t in
      guard let self else { t.invalidate(); return }
      let k = min(1, (CACurrentMediaTime() - t0) * 1000 / DetentRules.times.ms)
      if k >= DetentRules.times.cover, !covered {
        covered = true
        self.level = to
        logLine("[canvas] summary level %d at z%.3f (cut %.3f, %d columns)", to, self.cam.z, self.summaries.cut, self.summaries.scene?.cols.count ?? 0)
        self.summaries.layer.isHidden = to == 0
        for l in [self.sections, self.cards, self.stickers, self.arrows, self.top] { l.isHidden = to == 1 }
        if let at {
          let z = CGFloat(DetentRules.acrossCut(self.summaries.cut, to)), kz = z / self.cam.z
          self.setCamera(Camera(x: at.x - (at.x - self.cam.x) * kz, y: at.y - (at.y - self.cam.y) * kz, z: z), animated: false)
        }
      }
      self.show(DetentRules.switching(k, mist0, to))
      if k >= 1 {
        t.invalidate()
        self.switchTimer = nil
        self.show(.rest)
        self.wantLevel()
      }
    }
    switchTimer = t
  }
  /** The mist as an image (styles.css .cutmist: the board's colour, solid to 70 % then clear, blurred 10 px), rendered once per
   *  view size and colour; the layer only moves and stretches it */
  private func mistContents() -> CGImage? {
    let size = CGSize(width: bounds.width * 1.2, height: bounds.height), bg = Theme.bg.cgColor
    if let m = mistImage, m.0 == size, m.1 == bg { return m.2 }
    let w = Int(size.width * backing), h = Int(size.height * backing)
    guard w > 0, h > 0, let cg = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
      let grad = CGGradient(colorsSpace: nil, colors: [bg, bg, bg.copy(alpha: 0)!] as CFArray, locations: [0, 0.7, 1])
    else { return nil }
    // CG's y is up: the solid end is the bottom of the view (the layer is anchored at its top left and stretched)
    cg.drawLinearGradient(grad, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: CGFloat(h)), options: [])
    guard let sharp = cg.makeImage() else { return nil }
    let blurred = CIImage(cgImage: sharp).applyingGaussianBlur(sigma: 10 * backing)
    let out = CIContext(options: [.useSoftwareRenderer: false]).createCGImage(blurred, from: CGRect(x: 0, y: 0, width: w, height: h))
    if let out { mistImage = (size, bg, out) }
    return out
  }
  private func show(_ d: Detent) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let h = bounds.height * d.mist
    mist.isHidden = d.mist <= 0
    if !mist.isHidden { mist.contents = mistContents() }
    mist.frame = CGRect(x: -bounds.width * 0.1, y: bounds.height - h, width: bounds.width * 1.2, height: h)
    cutLine.isHidden = d.line <= 0
    cutLine.backgroundColor = Theme.ink.withAlphaComponent(0.12).cgColor
    cutFill.backgroundColor = Theme.accent.cgColor
    cutFill.transform = CATransform3DMakeScale(max(0.0001, d.line), 1, 1)
    seal.isHidden = !d.seal
    if d.seal {
      let f = Theme.isInk ? Theme.serif(14, weight: .bold) : Theme.sys(13, weight: .semibold)
      seal.string = NSAttributedString(string: d.to == 1 ? "SUMMARY" : "DETAIL", attributes: [.font: f, .foregroundColor: Theme.accent, .kern: f.pointSize * (Theme.isInk ? 0.1 : 0.14)])
      seal.borderColor = Theme.accent.cgColor
      seal.borderWidth = Theme.isInk ? 2.5 : 2
      seal.cornerRadius = Theme.isInk ? 5 : 4
      seal.opacity = 0.92
      let w = (seal.string as! NSAttributedString).size().width + 20
      seal.bounds = CGRect(x: 0, y: 0, width: w, height: f.pointSize + 13)
      seal.position = CGPoint(x: bounds.width - 28 - w / 2, y: bounds.height - 68 - seal.bounds.height / 2)
      seal.transform = CATransform3DMakeRotation(-3 * .pi / 180, 0, 0, 1)
    }
    CATransaction.commit()
  }
}

/** A closure run on every display frame (the view's display link: 120 Hz on ProMotion, where a 1/60 s timer moved the mist at
 *  half the rate) until invalidated */
final class Ticker: NSObject {
  private let tick: (Ticker) -> Void
  private var link: CADisplayLink?
  init(_ view: NSView, _ tick: @escaping (Ticker) -> Void) {
    self.tick = tick
    super.init()
    link = view.displayLink(target: self, selector: #selector(fire))
    link?.add(to: .main, forMode: .common)
  }
  @objc private func fire() { tick(self) }
  func invalidate() {
    link?.invalidate()
    link = nil
  }
}

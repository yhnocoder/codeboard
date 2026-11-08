// The canvas: a flipped, layer-backed view whose `world` layer holds every card, Section and arrow at board coordinates. The camera
// is the world layer's transform, so panning, pinching and ⌘-scrolling never redraw a card; a card being dragged moves its own
// layer and only the arrows on it are re-routed (a sub-millisecond call into core's routing). Cards are rasterised at a few zoom
// buckets (rasterBucket) and far off-screen ones drop their bitmaps; a change is committed to core when the drag ends.
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
  static let zMin: CGFloat = 0.05, zMax: CGFloat = 4
  private var restTimer: Timer?
  /** A zoom re-rasters once it has settled this long: during the pinch the bitmaps scale */
  private var settleTimer: Timer?
  static let RASTER_SETTLE = 0.12
  private var rasterScale: CGFloat = 0
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
  private var landing: [(CardLayer, IOSurface, CGFloat, Int)] = []
  private var landingLink: CADisplayLink?
  private(set) var selectedLinks: Set<String> = []
  private(set) var selectedSections: Set<String> = []
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
    for l in [sections, cards, stickers, arrows, top] {
      l.anchorPoint = .zero
      world.addSublayer(l)
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
    for l in [marquee, ports, rubber] { overlay.addSublayer(l) }
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
    let px = CGSize(width: w * backing, height: h * backing)
    if let cached = sceneImage, cached.0 == px, cached.1 == Theme.isDark { scene.contents = cached.2; return }
    let copy = img.copy() as! NSImage
    copy.size = px
    var rect = CGRect(origin: .zero, size: px)
    guard let cg = copy.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return }
    sceneImage = (px, Theme.isDark, cg)
    scene.contents = cg
  }
  private var sceneImage: (CGSize, Bool, CGImage)?

  /** A whole scene. Layers of cards still in it stay (their bitmaps too: opening the same board again shows no blank card), the
   *  rest go */
  func load(_ s: Scene) {
    tellLook()
    edit.end { _ in }  // committed by whoever switched the board (BoardWindow.open), before this
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let keep = Set(s.cards.map(\.id))
    for (id, l) in cardLayers where !keep.contains(id) {
      l.detach()
      cardLayers[id] = nil
    }
    for l in sectionLayers.values { l.removeFromSuperlayer() }
    for l in arrowLayers.values { l.removeFromSuperlayer() }
    for l in stickerLayers.values { l.removeFromSuperlayer() }
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
    CATransaction.commit()
    showPorts()
    setCamera(s.cam, animated: false)
    routeAll()
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
    for id in ch.gone.stickers { stickerLayers.removeValue(forKey: id)?.removeFromSuperlayer() }
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
  private func enqueue(_ layer: CardLayer, _ surface: IOSurface, _ scale: CGFloat, _ gen: Int) {
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
    c.z = min(Double(CanvasView.zMax), max(Double(CanvasView.zMin), c.z))
    cam = c
    CATransaction.begin()
    CATransaction.setDisableActions(!animated)
    var t = CATransform3DMakeTranslation(c.x, c.y, 0)
    t = CATransform3DScale(t, c.z, c.z, 1)
    world.transform = t
    CATransaction.commit()
    cull()
    if rasterScale == 0 { rasterIfNeeded() } else { settleRaster() }
    showPorts()
    followEdit()
    rested()
  }
  private func settleRaster() {
    if rasterBucket(zoom: cam.z, backing: backing) == rasterScale { settleTimer?.invalidate(); return }
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
    let z = min(CanvasView.zMax, max(CanvasView.zMin, cam.z * f))
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
    for l in cardLayers.values where l.card.id != underEdit {
      let on = near.intersects(l.worldRect) && !folded.contains(l.card.id)
      if l.isHidden != !on || (on && l.contents == nil && !l.drawn) {
        l.isHidden = !on
        if on { l.contentsScale = s; l.setNeedsDisplay(); l.drawn = true } else { l.contents = nil; l.drawn = false }
      }
    }
    // stickers out of view are hidden: an animated one then plays no frames
    for l in stickerLayers.values { l.isHidden = !near.intersects(l.frame) }
  }
  /** The bitmap scale follows the zoom in buckets: crossing one redraws the cards at the new scale (the old bitmap stays until
   *  then), nearest the middle of the view first, in the run loop's own transaction (an explicit commit here waited on the
   *  render server) */
  private func rasterIfNeeded() {
    let s = rasterBucket(zoom: cam.z, backing: backing)
    if s == rasterScale { return }
    rasterScale = s
    let centre = CGPoint(x: (bounds.midX - cam.x) / cam.z, y: (bounds.midY - cam.y) / cam.z)
    let near = cardLayers.values.filter { !$0.isHidden }.sorted { hypot($0.worldRect.midX - centre.x, $0.worldRect.midY - centre.y) < hypot($1.worldRect.midX - centre.x, $1.worldRect.midY - centre.y) }
    CATransaction.setDisableActions(true)
    for l in cardLayers.values where l.isHidden { l.contentsScale = s }
    for l in near where l.contentsScale != s {
      l.contentsScale = s
      l.setNeedsDisplay()
    }
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
    for l in cardLayers.values { l.recolor(); l.setNeedsDisplay() }
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
    }
  }
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
    if !inLiveResize { cull() }
  }
  override func viewDidEndLiveResize() {
    super.viewDidEndLiveResize()
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
      if let l = cardAt(w) {
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
    case ("\u{1b}", []): select([]); selectLinks([]); selectSections([])
    case ("n", []): delegate?.canvas(self, newCard: "note", at: pointer)
    case ("t", []): delegate?.canvas(self, newCard: "text", at: pointer)
    case ("c", []): delegate?.canvas(self, newCard: "code", at: pointer)
    default: break  // not the board's: no beep
    }
  }
  @objc func delete(_ sender: Any?) {
    guard !selected.isEmpty || !selectedLinks.isEmpty || !selectedSections.isEmpty else { return }
    delegate?.canvas(self, deleteCards: Array(selected), links: Array(selectedLinks), sections: Array(selectedSections))
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
    for id in was.subtracting(folded) { if let l = cardLayers[id] { l.isHidden = false; l.setNeedsDisplay(); l.drawn = true } }
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

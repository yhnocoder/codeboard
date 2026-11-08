// The canvas: a flipped, layer-backed view whose `world` layer holds every card, Section and arrow at board coordinates. The camera
// is the world layer's transform, so panning, pinching and ⌘-scrolling never redraw a card; a card being dragged moves its own
// layer and only the arrows on it are re-routed (a sub-millisecond call into core's routing). Cards are rasterised at a few zoom
// buckets (rasterBucket) and far off-screen ones drop their bitmaps; a change is committed to core when the drag ends.
import AppKit

protocol CanvasDelegate: AnyObject {
  func canvas(_ c: CanvasView, dragEnded moves: [JSBridge.Move])
  func canvas(_ c: CanvasView, cameraRested cam: Camera)
  func canvasRoute(_ c: CanvasView, rects: [String: WorldRect], only: [String]?, modes: [String: String]?) -> [RouteGeo]
}

/** How many finished bitmaps land per frame: enough to fill a view in a few frames, few enough that the commit stays short */
let HANDOVERS_PER_FRAME = 6

final class CanvasView: NSView {
  weak var delegate: CanvasDelegate?
  let world = CALayer()
  private let sections = CALayer()
  private let arrows = CALayer()
  private let cards = CALayer()
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

  override init(frame: CGRect) {
    super.init(frame: frame)
    wantsLayer = true
    layerContentsRedrawPolicy = .never
    layer!.backgroundColor = Theme.bg.cgColor
    layer!.masksToBounds = true
    world.anchorPoint = .zero
    for l in [sections, cards, arrows] {
      l.anchorPoint = .zero
      world.addSublayer(l)
    }
    layer!.addSublayer(world)
  }
  required init?(coder: NSCoder) { fatalError() }
  override var isFlipped: Bool { true }
  override var acceptsFirstResponder: Bool { true }

  var backing: CGFloat { window?.backingScaleFactor ?? 2 }

  // MARK: scene
  func load(_ s: Scene) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for l in cardLayers.values { l.removeFromSuperlayer() }
    for l in sectionLayers.values { l.removeFromSuperlayer() }
    for l in arrowLayers.values { l.removeFromSuperlayer() }
    cardLayers = [:]
    sectionLayers = [:]
    arrowLayers = [:]
    order = []
    selected = []
    rasterScale = 0
    for sec in s.sections { putSection(sec) }
    for c in s.cards { putCard(c) }
    for l in s.links { putLink(l) }
    CATransaction.commit()
    setCamera(s.cam, animated: false)
    routeAll()
  }

  func apply(_ ch: SceneChange) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for id in ch.gone.cards {
      cardLayers.removeValue(forKey: id)?.removeFromSuperlayer()
      order.removeAll { $0 == id }
      selected.remove(id)
    }
    for id in ch.gone.sections { sectionLayers.removeValue(forKey: id)?.removeFromSuperlayer() }
    for id in ch.gone.links { arrowLayers.removeValue(forKey: id)?.removeFromSuperlayer() }
    for sec in ch.sections { putSection(sec) }
    for c in ch.cards { putCard(c) }
    for l in ch.links { putLink(l) }
    CATransaction.commit()
    routeAll()
  }

  private func putCard(_ c: SceneCard) {
    if let l = cardLayers[c.id] {
      l.apply(c)
    } else {
      let l = CardLayer(card: c)
      l.contentsScale = max(rasterScale, 0.125)
      l.isHidden = true  // drawn once the camera says it is near (cull)
      l.handover = { [weak self] layer, surface, scale, gen in self?.enqueue(layer, surface, scale, gen) }
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
      arrowLayers[k.id] = l
      arrows.addSublayer(l)
    }
  }

  var rects: [String: WorldRect] {
    var out: [String: WorldRect] = [:]
    for (id, l) in cardLayers { out[id] = WorldRect(x: l.card.x, y: l.card.y, w: l.card.w, h: Double(l.height)) }
    return out
  }
  func routeAll() {
    let modes = liveModes.isEmpty ? nil : liveModes
    liveModes = [:]
    applyRoutes(delegate?.canvasRoute(self, rects: rects, only: nil, modes: modes) ?? [], final: true)
  }
  private func applyRoutes(_ geos: [RouteGeo], final: Bool = false) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for g in geos { arrowLayers[g.id]?.apply(geo: g) }
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
  private func routeLive(_ links: [String]) {
    guard let router else { return applyRoutes(delegate?.canvasRoute(self, rects: rects, only: links, modes: nil) ?? []) }
    routeSeq += 1
    router.route(routeKey, rects: rects, only: links, seq: routeSeq) { [weak self] geos, seq in
      guard let self, self.drag != nil || self.dropPending else { return }
      self.routeLags.append(self.routeSeq - seq)
      for g in geos {
        self.liveGeos[g.id] = g.pts
        if let m = g.mode { self.liveModes[g.id] = m }
      }
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
    rasterIfNeeded()
    rested()
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
    let near = vis.insetBy(dx: -vis.width * 0.25, dy: -vis.height * 0.25)
    for l in cardLayers.values {
      let on = near.intersects(l.worldRect)
      if l.isHidden != !on || (on && l.contents == nil && !l.drawn) {
        l.isHidden = !on
        if on { l.setNeedsDisplay(); l.drawn = true } else { l.contents = nil; l.drawn = false }
      }
    }
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
    for l in near {
      l.contentsScale = s
      l.setNeedsDisplay()
    }
    for l in sectionLayers.values { l.setScale(s) }
  }
  func redrawAll() {
    Theme.appearance = effectiveAppearance
    layer?.backgroundColor = Theme.bg.cgColor
    for l in cardLayers.values { l.setNeedsDisplay() }
    for l in sectionLayers.values { l.recolor() }
    for l in arrowLayers.values { l.recolor() }
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
    super.layout()
    cull()
  }

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
  private var panStart: CGPoint?

  func cardAt(_ world: CGPoint) -> CardLayer? {
    for id in order.reversed() {
      if let l = cardLayers[id], !l.isHidden, l.worldRect.contains(world) { return l }
    }
    return nil
  }
  override func mouseDown(with e: NSEvent) {
    window?.makeFirstResponder(self)
    let p = convert(e.locationInWindow, from: nil)
    guard let l = cardAt(toWorld(p)) else {
      select([])
      panStart = p
      return
    }
    if l.card.locked == true { select([l.card.id]); return }
    select(e.modifierFlags.contains(.shift) ? selected.union([l.card.id]) : [l.card.id])
    // a locked card in the selection stays where it is
    let ids = selected.filter { cardLayers[$0]?.card.locked != true }
    if !ids.isEmpty { beginDrag(Array(ids), at: p) }
  }
  func beginDrag(_ ids: [String], at p: CGPoint) {
    var origins: [String: CGPoint] = [:]
    for id in ids { if let l = cardLayers[id] { origins[id] = l.frame.origin } }
    drag = (ids, p, origins, linksOn(Set(ids)), false)
  }
  override func mouseDragged(with e: NSEvent) {
    let p = convert(e.locationInWindow, from: nil)
    if let s = panStart {
      pan(by: CGPoint(x: p.x - s.x, y: p.y - s.y))
      panStart = p
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
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for id in d.ids { if let l = cardLayers[id], let o = d.origins[id] { l.move(to: CGPoint(x: o.x + dx, y: o.y + dy)) } }
    CATransaction.commit()
    if !d.links.isEmpty { routeLive(d.links) }
  }
  override func mouseUp(with e: NSEvent) {
    panStart = nil
    endDrag()
  }
  func endDrag() {
    guard let d = drag else { return }
    drag = nil
    if !d.moved { return }
    dropPending = !d.links.isEmpty
    let moves = d.ids.compactMap { id in
      cardLayers[id].map { JSBridge.Move(id: id, x: Double($0.frame.minX), y: Double($0.frame.minY), w: Double($0.frame.width), h: Double($0.frame.height)) }
    }
    delegate?.canvas(self, dragEnded: moves)
  }
  func select(_ ids: Set<String>) {
    for id in selected.subtracting(ids) { cardLayers[id]?.selected = false }
    for id in ids.subtracting(selected) { cardLayers[id]?.selected = true }
    selected = ids
  }

  /** The canvas as drawn, for the debug snapshot (no screen capture needed) */
  func snapshot() -> NSBitmapImageRep? {
    guard let rep = bitmapImageRepForCachingDisplay(in: bounds) else { return nil }
    cacheDisplay(in: bounds, to: rep)
    return rep
  }
}

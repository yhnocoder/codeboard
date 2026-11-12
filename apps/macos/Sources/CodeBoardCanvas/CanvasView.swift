import AppKit
import CodeBoardModel
import QuartzCore

/// One board, read-only, panned and zoomed. While a gesture runs (its glide and rubber band included) Core Animation
/// only moves and scales the bitmaps the items already have; at rest they are redrawn at fixed levels (`Levels`,
/// `RestPlan`), off the main thread, and swapped in a few per frame (`RedrawQueue`).
public final class CanvasView: NSView {
  private var theme = Theme.warmInkLight
  private var scene: Scene?
  private var items: [ItemLayers] = []
  private let world = CALayer()
  private let sections = CALayer()
  private let below = CALayer()
  private let arrows = CALayer()
  private let above = CALayer()
  private var camera = Camera(origin: .zero, zoom: 1)
  private var limits = ZoomLimits(fit: 1)
  private var motion = Motion()
  private var queue = RedrawQueue<IOSurface>()
  /// Rest bitmaps are drawn for this zoom; nil once a zoom has cleared them
  private var restZoom: CGFloat?
  private var tasks: [Int: Task<Void, Never>] = [:]
  private var nextTask = 0
  private var loads = 0
  private var link: CADisplayLink?
  private let images = DecodeCache(cap: 128 << 20)

  /// Called at the start of every display-link frame, before the canvas moves (CanvasBench drives and measures from it).
  /// While set, the display link never pauses
  package var onFrame: ((CADisplayLink) -> Void)? {
    didSet { link?.isPaused = false }
  }
  /// Work begun while a gesture was active; the gesture rule says all three stay 0
  package private(set) var ruleBreaks = (redraws: 0, decodes: 0, swaps: 0)

  public override init(frame: NSRect) {
    super.init(frame: frame)
    // layer-hosting: the canvas owns its layer tree, y-down like the board
    let root = CALayer()
    root.isGeometryFlipped = true
    layer = root
    wantsLayer = true
    for l in [world, sections, below, arrows, above] { l.anchorPoint = .zero }
    for l in [sections, below, arrows, above] { world.addSublayer(l) }
    root.addSublayer(world)
  }

  @available(*, unavailable)
  public required init?(coder: NSCoder) {
    fatalError("CanvasView is not loaded from nibs")
  }

  public override var isFlipped: Bool { true }
  public override var acceptsFirstResponder: Bool { true }

  /// Shows a board of the vault, fitted to the view. Returns once every item is on screen (each at least as its
  /// overview bitmap, so nothing is ever blank); a later call supersedes an earlier one still loading
  public func show(_ board: VaultBoard, in vault: Vault, theme: Theme) async throws {
    loads += 1
    let load = loads
    let size =
      bounds.isEmpty ? (window?.screen ?? NSScreen.main)?.frame.size ?? CGSize(width: 1440, height: 900) : bounds.size
    let backing = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
    let images = self.images
    let (scene, overviews, shadow) = try await Task.detached(priority: .userInitiated) {
      let package = vault.url(of: board.path)
      let scene = Scene(try vault.board(at: board.path), package: package, vault: vault, theme: theme)
      let fit = Camera.fit(scene.bounds, in: size).zoom
      let overviews = await withTaskGroup(of: (Int, IOSurface?, CGFloat).self) { g in
        for (i, it) in scene.items.enumerated() {
          g.addTask {
            let s = Levels.scale(fit, backing: backing, size: it.rect.size)
            return (i, CanvasView.render(it, scale: s, theme: theme, images: images).surface, s)
          }
        }
        var out = [(IOSurface?, CGFloat)](repeating: (nil, 1), count: scene.items.count)
        for await (i, s, scale) in g { out[i] = (s, scale) }
        return out
      }
      return (scene, overviews, CanvasView.shadow(theme))
    }.value
    guard load == loads else { return }
    install(scene, overviews: overviews, shadow: shadow, theme: theme)
  }

  // MARK: Layers

  /// An item's layers: its shadow (framed cards), the held bitmap and the rest bitmap over it
  private final class ItemLayers {
    let box = CALayer()
    let held = CALayer()
    let rest = CALayer()
    let overview: IOSurface?
    let overviewScale: CGFloat
    var heldSurface: IOSurface?
    var heldScale: CGFloat
    var restScale: CGFloat?

    init(_ item: Scene.Item, overview: IOSurface?, scale: CGFloat, shadow: (IOSurface, margin: CGFloat)?) {
      self.overview = overview
      overviewScale = scale
      heldScale = scale
      let r = item.rect
      box.bounds = CGRect(origin: .zero, size: r.size)
      box.position = CGPoint(x: r.midX, y: r.midY)
      if item.tilt != 0 {
        box.setAffineTransform(CGAffineTransform(rotationAngle: item.tilt))
        box.allowsEdgeAntialiasing = true
      }
      if let shadow {
        let l = CALayer()
        l.frame = box.bounds.insetBy(dx: -shadow.margin, dy: -shadow.margin)
        l.contents = shadow.0
        l.contentsScale = 2
        let side = CGFloat(shadow.0.width) / 2
        l.contentsCenter = CGRect(x: (side / 2 - 1) / side, y: (side / 2 - 1) / side, width: 2 / side, height: 2 / side)
        box.addSublayer(l)
      }
      for l in [held, rest] {
        l.frame = box.bounds
        l.contentsGravity = .resize
        l.magnificationFilter = .linear
        box.addSublayer(l)
      }
      held.minificationFilter = .trilinear
      held.contents = overview
      rest.minificationFilter = .linear
    }

    var bytes: Int {
      (overview?.allocationSize ?? 0) + (heldSurface?.allocationSize ?? 0)
        + ((rest.contents as? IOSurface)?.allocationSize ?? 0)
    }

    func showOverview() {
      held.contents = overview
      heldSurface = nil
      heldScale = overviewScale
    }

    func clearRest() {
      rest.contents = nil
      restScale = nil
    }
  }

  private func install(
    _ s: Scene, overviews: [(IOSurface?, CGFloat)], shadow: (IOSurface, margin: CGFloat)?, theme: Theme
  ) {
    cancelRedraws()
    self.theme = theme
    scene = s
    withoutAnimation {
      layer?.backgroundColor = theme.canvas
      for l in [sections, below, arrows, above] { l.sublayers = nil }
      for f in s.frames {
        let l = CALayer()
        l.frame = f.rect
        l.backgroundColor = f.fill
        l.borderColor = theme.hair
        l.borderWidth = 0.5
        l.cornerRadius = theme.sectionRadius
        l.cornerCurve = .continuous
        sections.addSublayer(l)
      }
      items = s.items.enumerated().map { i, it in
        ItemLayers(
          it, overview: overviews[i].0, scale: overviews[i].1, shadow: it.drawing.framed ? shadow : nil)
      }
      for (i, l) in items.enumerated() { (i < s.labelsFrom ? below : above).addSublayer(l.box) }
      for a in s.arrows {
        let line = CAShapeLayer()
        line.path = CanvasView.path(a.line)
        line.fillColor = nil
        line.strokeColor = a.color
        line.lineWidth = a.width
        line.lineCap = .round
        if a.dashed { line.lineDashPattern = [4, 4] }
        arrows.addSublayer(line)
        if !a.heads.isEmpty {
          let heads = CAShapeLayer()
          let p = CGMutablePath()
          for h in a.heads { p.addPath(CanvasView.path(h)) }
          heads.path = p
          heads.fillColor = a.color
          arrows.addSublayer(heads)
        }
      }
    }
    let fit = Camera.fit(s.bounds, in: bounds.isEmpty ? CGSize(width: 1440, height: 900) : bounds.size)
    limits = ZoomLimits(fit: fit.zoom)
    camera = fit
    motion = Motion()
    restZoom = nil
    applyCamera()
    arrive()
  }

  /// The soft shadow under a framed card, nine-sliced onto every one
  private nonisolated static func shadow(_ t: Theme) -> (IOSurface, margin: CGFloat)? {
    let m: CGFloat = 80
    let k = t.cardRadius
    let side = 2 * (m + k + 1)
    let card = CGRect(x: m, y: m, width: side - 2 * m, height: side - 2 * m)
    let s = Raster.surface(size: CGSize(width: side, height: side), scale: 2) { ctx in
      for l in t.shadow {
        ctx.saveGState()
        // shadow offsets and blurs are in device space, which is y-up
        ctx.setShadow(
          offset: CGSize(width: 0, height: -l.y * 2), blur: l.blur * 2,
          color: CGColor(srgbRed: t.shadowColor.r, green: t.shadowColor.g, blue: t.shadowColor.b, alpha: l.alpha))
        ctx.addPath(Drawing.squircle(card.insetBy(dx: -l.spread, dy: -l.spread), k))
        ctx.setFillColor(t.surface)
        ctx.fillPath()
        ctx.restoreGState()
      }
    }
    return s.map { ($0, m) }
  }

  private static func path(_ ops: [PathOp]) -> CGPath {
    let p = CGMutablePath()
    for op in ops {
      switch op {
      case .move(let a): p.move(to: a)
      case .line(let a): p.addLine(to: a)
      case .quad(let c, let a): p.addQuadCurve(to: a, control: c)
      case .curve(let c1, let c2, let a): p.addCurve(to: a, control1: c1, control2: c2)
      }
    }
    return p
  }

  private func withoutAnimation(_ f: () -> Void) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    f()
    CATransaction.commit()
  }

  private var backing: CGFloat { window?.backingScaleFactor ?? 2 }

  // MARK: Camera

  private func applyCamera() {
    var m = CATransform3DIdentity
    m.m11 = camera.zoom
    m.m22 = camera.zoom
    m.m41 = -camera.origin.x * camera.zoom
    m.m42 = -camera.origin.y * camera.zoom
    withoutAnimation {
      world.sublayerTransform = m
      // a zoom (not a pan) away from the rest zoom: the held bitmaps take over, with mipmaps
      if let z = restZoom, z != camera.zoom {
        restZoom = nil
        for l in items {
          l.clearRest()
          l.held.minificationFilter = .trilinear
        }
      }
    }
  }

  public override func setFrameSize(_ newSize: NSSize) {
    let unsized = bounds.isEmpty
    super.setFrameSize(newSize)
    guard let scene, newSize.width > 0, newSize.height > 0 else { return }
    let fit = Camera.fit(scene.bounds, in: newSize)
    limits = ZoomLimits(fit: fit.zoom)
    // shown before the view had a size: fit now
    if unsized { camera = fit }
    applyCamera()
    if motion.isResting { arrive() }
  }

  public override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    if motion.isResting && scene != nil { arrive() }
  }

  public override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    link?.invalidate()
    link = nil
    guard window != nil else { return }
    let l = displayLink(target: self, selector: #selector(step(_:)))
    l.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
    l.add(to: .main, forMode: .common)
    link = l
  }

  // MARK: Input

  public override func scrollWheel(with e: NSEvent) {
    // the system's momentum: the canvas glides on its own
    guard scene != nil, e.momentumPhase.isEmpty else { return }
    if e.modifierFlags.contains(.command) {
      let d = e.scrollingDeltaY * (e.hasPreciseScrollingDeltas ? 0.01 : 0.1)
      motion.wheelZoom(
        by: exp(d), at: convert(e.locationInWindow, from: nil), time: e.timestamp, limits: limits, camera: &camera)
      moved()
    } else {
      let k: CGFloat = e.hasPreciseScrollingDeltas ? 1 : 10
      scroll(
        by: CGVector(dx: e.scrollingDeltaX * k, dy: e.scrollingDeltaY * k), at: e.timestamp,
        began: !e.phase.isDisjoint(with: [.began, .mayBegin]), ended: !e.phase.isDisjoint(with: [.ended, .cancelled]))
    }
  }

  public override func magnify(with e: NSEvent) {
    guard scene != nil else { return }
    pinch(
      by: 1 + e.magnification, around: convert(e.locationInWindow, from: nil), at: e.timestamp,
      began: e.phase.contains(.began), ended: !e.phase.isDisjoint(with: [.ended, .cancelled]))
  }

  package func scroll(by d: CGVector, at t: TimeInterval, began: Bool, ended: Bool) {
    motion.scroll(d, at: t, began: began, ended: ended, camera: &camera)
    moved()
  }

  package func pinch(by f: CGFloat, around p: CGPoint, at t: TimeInterval, began: Bool, ended: Bool) {
    motion.pinch(by: f, at: p, time: t, began: began, ended: ended, limits: limits, camera: &camera)
    moved()
  }

  /// Input moved the camera: rest work is cancelled
  private func moved() {
    if !queue.isIdle || !tasks.isEmpty { cancelRedraws() }
    applyCamera()
    link?.isPaused = false
  }

  private func cancelRedraws() {
    queue.cancel()
    for t in tasks.values { t.cancel() }
  }

  // MARK: Frames

  @objc private func step(_ l: CADisplayLink) {
    onFrame?(l)
    var cam = camera
    let rested = motion.step(at: l.timestamp, camera: &cam)
    if cam != camera {
      camera = cam
      applyCamera()
    }
    if rested { arrive() }
    if motion.isResting { pump() }
    if motion.isResting && queue.isIdle && onFrame == nil { l.isPaused = true }
  }

  /// At rest: what each item should hold now
  private func arrive() {
    guard scene != nil else { return }
    let pointer = window.map { camera.board(convert($0.mouseLocationOutsideOfEventStream, from: nil)) }
    let plan = RestPlan(
      items: items.map {
        RestPlan.Item(rect: $0.box.frame, held: $0.heldScale, rest: $0.restScale, overview: $0.overviewScale)
      },
      view: camera.visible(bounds.size), zoom: camera.zoom, backing: backing, pointer: pointer)
    withoutAnimation {
      for i in plan.dropHeld { items[i].showOverview() }
      for i in plan.dropRest { items[i].clearRest() }
      let linear = Set(plan.linear)
      for (i, l) in items.enumerated() { l.held.minificationFilter = linear.contains(i) ? .linear : .trilinear }
    }
    restZoom = camera.zoom
    queue.replace(with: plan.jobs)
    link?.isPaused = false
  }

  /// Each frame at rest: start redraws up to the limit, swap in finished ones within the frame's budget
  private func pump() {
    guard let scene else { return }
    for (job, generation) in queue.start() {
      if !motion.isResting { ruleBreaks.redraws += 1 }
      let item = scene.items[job.item]
      let theme = self.theme
      let images = self.images
      let id = nextTask
      nextTask += 1
      tasks[id] = Task.detached(priority: .userInitiated) { [weak self] in
        let r = CanvasView.render(item, scale: job.scale, theme: theme, images: images)
        await self?.finished(job, generation: generation, result: r, overlapped: Task.isCancelled, task: id)
      }
    }
    let swaps = queue.takeSwaps()
    guard !swaps.isEmpty else { return }
    if !motion.isResting { ruleBreaks.swaps += swaps.count }
    withoutAnimation {
      for s in swaps {
        let l = items[s.job.item]
        switch s.job.slot {
        case .held:
          l.held.contents = s.payload
          l.heldSurface = s.payload
          l.heldScale = s.job.scale
        case .rest:
          l.rest.contents = s.payload
          l.restScale = s.job.scale
        }
      }
    }
    // a swap made in the display-link callback otherwise reaches the screen a frame later
    CATransaction.flush()
  }

  /// overlapped: a gesture started while it ran (its result is dropped); counted against the gesture rule, as the work
  /// may have run on into the gesture
  private func finished(
    _ job: RestPlan.Job, generation: Int, result: (surface: IOSurface?, decodes: Int), overlapped: Bool, task: Int
  ) {
    tasks[task] = nil
    let s = result.surface
    queue.finish(job, generation: generation, payload: s, pixels: s.map { $0.width * $0.height } ?? 0)
    if overlapped {
      ruleBreaks.redraws += 1
      ruleBreaks.decodes += result.decodes
    }
    link?.isPaused = false
  }

  /// Draws an item off the main thread: no bitmap when cancelled (a gesture started) or when it could not be made
  private nonisolated static func render(_ item: Scene.Item, scale: CGFloat, theme: Theme, images: DecodeCache) -> (
    surface: IOSurface?, decodes: Int
  ) {
    guard !Task.isCancelled else { return (nil, 0) }
    var decodes = 0
    let s = Raster.surface(size: item.rect.size, scale: scale) { ctx in
      decodes = item.drawing.draw(in: ctx, size: item.rect.size, scale: scale, theme: theme, images: images)
    }
    return (Task.isCancelled ? nil : s, decodes)
  }

  // MARK: Measuring (CanvasBench)

  package var isResting: Bool { motion.isResting }
  package var isSettled: Bool { motion.isResting && queue.isIdle }
  package var zoom: CGFloat { camera.zoom }
  package var shownRect: CGRect { camera.visible(bounds.size) }
  package var boardBounds: CGRect { scene?.bounds ?? .zero }
  package var bitmapBytes: Int { items.reduce(0) { $0 + $1.bytes } }
  package var decodedBytes: Int { images.bytes }

  /// Anything in view drawn below display resolution
  package var lowRes: Bool {
    let view = camera.visible(bounds.size)
    let z = min(camera.zoom, limits.max)
    return items.contains { l in
      let r = l.box.frame
      guard r.intersects(view) else { return false }
      return max(l.heldScale, l.restScale ?? 0) < Levels.scale(z, backing: backing, size: r.size) * 0.98
    }
  }

  /// Jumps to a zoom with the board point `centre` in the middle of the view, at rest
  package func place(zoom: CGFloat, centre: CGPoint) {
    let z = limits.clamp(zoom)
    camera = Camera(origin: CGPoint(x: centre.x - bounds.width / 2 / z, y: centre.y - bounds.height / 2 / z), zoom: z)
    motion = Motion()
    cancelRedraws()
    applyCamera()
    arrive()
  }
}

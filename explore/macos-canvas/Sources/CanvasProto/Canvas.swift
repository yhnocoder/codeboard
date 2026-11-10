import AppKit
import QuartzCore
import Metal

/// The board canvas: a world layer moved by the camera, one layer per card (modes 1–2) or one screen-sized layer that
/// draws the visible cards with CoreText every frame (mode 3).
final class Canvas: NSView, CALayerDelegate {
    static let modeNames = [0: "?", 1: "settle", 2: "ahead", 3: "live", 4: "tiles"]

    var board: Board!
    var boardIndex = 0
    var boards: [String] = []
    var vault = ""
    var mode = 1 { didSet { modeChanged() } }

    // Camera: board point at the view's top-left, and zoom (view points per board unit).
    var camX: CGFloat = 0, camY: CGFloat = 0, z: CGFloat = 1
    var fitZoom: CGFloat = 1
    var backing: CGFloat { window?.backingScaleFactor ?? 2 }
    var refresh: Double { 1.0 / Double(window?.screen?.maximumFramesPerSecond ?? 60) }

    let world = CALayer()
    let sectionsLayer = CAShapeLayer()
    let linksLayer = CAShapeLayer()
    let live = CALayer()
    let hud = CATextLayer()
    var cardLayers: [CALayer] = []
    var rasterScale: [CGFloat] = []
    var baseImage: [CGImage?] = []
    var baseScale: [CGFloat] = []
    var inFlight: [Bool] = []
    var generation = 0
    var visible: [Int] = []
    var liveAsync = false
    var liveOwn = true       // mode 3 draws into our own IOSurface (true) or the layer's CA backing store (false)
    var useSurfaces = true   // modes 1–2 hand finished rasters to CA as IOSurfaces (true) or CGImages (false)
    var liveSurfaces: [IOSurface] = []
    var liveNext = 0
    var maxZoom: CGFloat = 2
    // Speed shaping: 1:1 below `knee` (pt/s); above it the speed is compressed softly towards knee + soft (tanh), with
    // no buffering and so no added latency. Momentum (after the fingers lift) uses a lower knee and extra friction.
    var shaping = true
    var knee: CGFloat = 1500
    var friction: Double = 0.35        // momentum gain decays as exp(-t / friction s); 0 = system momentum untouched
    var lastScrollTs = 0.0
    var momentumStart = 0.0
    // Motion blur: a CIMotionBlur on the canvas while it moves faster than `blurFrom` pt per frame.
    var blurOn = true
    var blurStrength: CGFloat = 0.5    // blur radius (pt) per pt of per-frame displacement above blurFrom
    let blurFrom: CGFloat = 12        // 1440 pt/s at 120 Hz: above ordinary reading pans
    var blurRadius: CGFloat = 0
    var blurAngle: CGFloat = 0
    var blurCount = 0                  // frames drawn with blur in the current gesture
    let content = CALayer()            // the canvas (world, live, world2) the blur applies to; HUD and probe outside
    // Rubber band past the zoom limit
    var pinchRaw: CGFloat = 0
    var springBack: CGPoint?
    var springAnchor = CGPoint.zero
    var lastCam = (x: CGFloat(0), y: CGFloat(0), z: CGFloat(1))
    var cardTiles: [CardTiles] = []
    var tileBytes = 0
    var lastMemSample = 0.0
    var memLine = ""

    // Images: their own layers above the cards (and above mode 3's text), decoded at the level the zoom needs.
    let world2 = CALayer()
    let store = ImageStore()
    var slots: [ImageSlot] = []
    var visibleSlots: [Int] = []
    var baseLevel: [Int] = []
    var loadStart = 0.0
    var firstVisibleLogged = false, firstAllLogged = false

    // Presented-frame probe: a tiny Metal layer drawn with each moving frame, presented with the CA transaction.
    let probe = CAMetalLayer()
    var mtlQueue: MTLCommandQueue?

    let pool: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = max(2, ProcessInfo.processInfo.activeProcessorCount - 2)
        q.qualityOfService = .userInteractive
        return q
    }()

    // Gesture and frame tracking
    var link: CADisplayLink?
    var lastTick: Double = 0
    var lastMove: Double = 0
    var moved = false
    var zoomingIn = false
    var gesture: GestureStats?
    var lastSummary = "—"
    var pendingLabel: String?
    var tickStart = 0.0
    var observer: CFRunLoopObserver?

    // Scripted bench
    var script: Bench?

    override var isFlipped: Bool { false }
    override var acceptsFirstResponder: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer = CALayer()
        layer!.backgroundColor = Render.boardBg
        layerUsesCoreImageFilters = true
        content.anchorPoint = .zero
        content.actions = ["filters": NSNull(), "bounds": NSNull(), "position": NSNull()]
        layer!.addSublayer(content)
        content.addSublayer(world)
        world.anchorPoint = .zero
        world.frame = .zero
        for s in [sectionsLayer, linksLayer] {
            s.fillColor = nil
            s.actions = ["lineWidth": NSNull(), "path": NSNull()]
            world.addSublayer(s)
        }
        sectionsLayer.strokeColor = CGColor(srgbRed: 0.38, green: 0.36, blue: 0.33, alpha: 0.45)
        linksLayer.strokeColor = Render.ink2
        live.delegate = self
        live.isOpaque = false
        live.needsDisplayOnBoundsChange = true
        live.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull()]
        content.addSublayer(live)
        world2.anchorPoint = .zero
        world2.frame = .zero
        content.addSublayer(world2)
        if let dev = MTLCreateSystemDefaultDevice() {
            probe.device = dev
            probe.pixelFormat = .bgra8Unorm
            probe.presentsWithTransaction = true
            probe.frame = CGRect(x: 0, y: 0, width: 2, height: 2)
            probe.drawableSize = CGSize(width: 4, height: 4)
            probe.actions = ["contents": NSNull()]
            mtlQueue = dev.makeCommandQueue()
            layer!.addSublayer(probe)
        }
        hud.fontSize = 11
        hud.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        hud.foregroundColor = CGColor(gray: 1, alpha: 1)
        hud.backgroundColor = CGColor(gray: 0, alpha: 0.66)
        hud.cornerRadius = 6
        hud.isWrapped = true
        hud.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull()]
        layer!.addSublayer(hud)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil, link == nil else { return }
        let l = displayLink(target: self, selector: #selector(tick(_:)))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        l.add(to: .main, forMode: .common)
        link = l
        // Main-thread work per frame: from the display link callback to the run loop going idle (includes the CA commit).
        let o = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, Int.max) { [weak self] _, _ in
            guard let self, self.tickStart > 0 else { return }
            self.gesture?.busyMs.append((CACurrentMediaTime() - self.tickStart) * 1000)
            self.tickStart = 0
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), o, .commonModes)
        observer = o
        hud.contentsScale = backing
        live.contentsScale = backing
    }

    override func layout() {
        super.layout()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        live.frame = bounds
        content.frame = bounds
        layoutHud()
        CATransaction.commit()
        applyCamera()
    }

    // MARK: loading

    func load(_ index: Int) {
        guard !boards.isEmpty else { return }
        boardIndex = (index + boards.count) % boards.count
        let t0 = CACurrentMediaTime()
        do { board = try Board(path: boards[boardIndex], vault: vault) } catch {
            Log.write("failed to read \(boards[boardIndex]): \(error)"); return
        }
        let t1 = CACurrentMediaTime()
        generation += 1
        cardLayers.forEach { $0.removeFromSuperlayer() }
        cardLayers = []; rasterScale = []; baseImage = []; baseScale = []; inFlight = []
        fit()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for c in board.cards {
            let l = CALayer()
            l.anchorPoint = .zero
            l.frame = CGRect(x: c.rect.minX, y: -c.rect.maxY, width: c.rect.width, height: c.rect.height)
            l.contentsGravity = .resize
            l.minificationFilter = .trilinear
            l.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull()]
            world.addSublayer(l)
            cardLayers.append(l)
            let s = Render.cappedScale(c, max(fitZoom * backing, 0.75))
            let img = Render.raster(c, scale: s)
            l.contents = img
            baseImage.append(img); baseScale.append(s); rasterScale.append(s); inFlight.append(false)
        }
        world.insertSublayer(sectionsLayer, at: 0)
        world.addSublayer(linksLayer)
        loadImages()
        let sp = CGMutablePath()
        for s in board.sections { sp.addRoundedRect(in: CGRect(x: s.rect.minX, y: -s.rect.maxY, width: s.rect.width, height: s.rect.height), cornerWidth: 10, cornerHeight: 10) }
        sectionsLayer.path = sp
        let lp = CGMutablePath()
        let byId = Dictionary(board.cards.map { ($0.id, $0.rect) }, uniquingKeysWith: { a, _ in a })
        for l in board.links { if let a = byId[l.from], let b = byId[l.to] {
            lp.move(to: CGPoint(x: a.midX, y: -a.midY)); lp.addLine(to: CGPoint(x: b.midX, y: -b.midY)) } }
        linksLayer.path = lp
        CATransaction.commit()
        let t2 = CACurrentMediaTime()
        Log.write(String(format: "load board=%@ cards=%d sections=%d links=%d parse+layout=%.0fms base_rasters=%.0fms",
                         (board.path as NSString).lastPathComponent, board.cards.count, board.sections.count, board.links.count,
                         (t1 - t0) * 1000, (t2 - t1) * 1000))
        window?.title = "\(board.name) — \((board.path as NSString).lastPathComponent)"
        modeChanged()
    }

    func fit() {
        let b = board.bounds.insetBy(dx: -40, dy: -40)
        fitZoom = min(bounds.width / b.width, bounds.height / b.height)
        z = fitZoom
        camX = b.midX - bounds.width / 2 / z
        camY = b.midY - bounds.height / 2 / z
        applyCamera()
    }

    /// Back to the base bitmaps, then the visible cards sharp at the current zoom (synchronously), so a mode starts clean.
    func resetRasters() {
        generation += 1
        pool.cancelAllOperations()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for i in cardLayers.indices { cardLayers[i].contents = baseImage[i]; rasterScale[i] = baseScale[i]; inFlight[i] = false }
        computeVisible()
        clearTiles()
        if mode == 4 { updateTiles() }
        if mode == 1 || mode == 2 {
            for i in visible {
                let want = Canvas.pow2ForDiff ? pow(2, ceil(log2(z * backing))) : z * backing
                let s = Render.cappedScale(board.cards[i], want)
                if s > rasterScale[i] { cardLayers[i].contents = Render.raster(board.cards[i], scale: s); rasterScale[i] = s }
            }
        }
        CATransaction.commit()
    }

    func modeChanged() {
        guard board != nil else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        let hide = mode == 3
        cardLayers.forEach { $0.isHidden = hide }
        live.isHidden = !hide
        live.drawsAsynchronously = liveAsync
        live.contents = nil
        CATransaction.commit()
        resetRasters()
        if mode == 3 { if liveOwn { drawLiveOwn() } else { live.setNeedsDisplay() } }
        updateHud()
    }

    // MARK: camera

    func applyCamera() {
        guard board != nil else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        world.sublayerTransform = CATransform3DMakeAffineTransform(
            CGAffineTransform(a: z, b: 0, c: 0, d: z, tx: -camX * z, ty: bounds.height + camY * z))
        world2.sublayerTransform = world.sublayerTransform
        sectionsLayer.lineWidth = 1.2 / z
        linksLayer.lineWidth = 1.4 / z
        CATransaction.commit()
        computeVisible()
        if mode == 3 { if liveOwn { drawLiveOwn() } else { live.setNeedsDisplay() } }
    }

    /// Mode 3, own surface: every visible card drawn at the exact scale into a screen-sized IOSurface, on the main thread,
    /// so the time measured is the whole cost (CoreText and glyph rasterisation included). Three surfaces rotate.
    func drawLiveOwn() {
        let s = backing
        let w = Int(bounds.width * s), h = Int(bounds.height * s)
        if liveSurfaces.first.map({ $0.width != w || $0.height != h }) ?? true {
            liveSurfaces = (0..<3).compactMap { _ in Render.surface(width: w, height: h) }
        }
        guard !liveSurfaces.isEmpty else { return }
        let surf = liveSurfaces[liveNext % liveSurfaces.count]
        liveNext += 1
        let t0 = CACurrentMediaTime()
        Render.withContext(surf) { ctx in
            ctx.clear(CGRect(x: 0, y: 0, width: w, height: h))
            ctx.scaleBy(x: s, y: s)
            drawVisible(ctx)
        }
        gesture?.drawMs.append((CACurrentMediaTime() - t0) * 1000)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        live.contents = surf
        CATransaction.commit()
    }

    func drawVisible(_ ctx: CGContext) {
        let h = bounds.height
        for i in visible {
            let c = board.cards[i]
            ctx.saveGState()
            ctx.translateBy(x: (c.rect.minX - camX) * z, y: h - (c.rect.maxY - camY) * z)
            ctx.scaleBy(x: z, y: z)
            Render.draw(c, in: ctx)
            ctx.restoreGState()
        }
    }

    func computeVisible() {
        let view = CGRect(x: camX, y: camY, width: bounds.width / z, height: bounds.height / z)
        visible = board.cards.indices.filter { board.cards[$0].rect.intersects(view) }
        visibleSlots = slots.indices.filter { slots[$0].rect.intersects(view) }
    }

    /// Board point under a view point (view y up).
    func boardPoint(_ p: CGPoint) -> CGPoint { CGPoint(x: camX + p.x / z, y: camY + (bounds.height - p.y) / z) }

    /// Past the limit the zoom follows the fingers ever more stiffly (rubber band), and springs back when they lift.
    func rubber(_ raw: CGFloat) -> CGFloat {
        let top = max(maxZoom, fitZoom), bottom = fitZoom * 0.5
        if raw > top { return top * (1 + 0.15 * tanh(log(raw / top) / 0.15 / 2)) }
        if raw < bottom { return bottom / (1 + 0.15 * tanh(log(bottom / raw) / 0.15 / 2)) }
        return raw
    }

    func zoom(by f: CGFloat, at p: CGPoint, pinching: Bool = false) {
        let nz: CGFloat
        if pinching {
            if pinchRaw == 0 { pinchRaw = z }
            pinchRaw *= f
            nz = rubber(pinchRaw)
        } else {
            nz = min(max(z * f, fitZoom * 0.5), max(maxZoom, fitZoom))
        }
        springAnchor = p
        let b = boardPoint(p)
        zoomingIn = nz > z
        z = nz
        camX = b.x - p.x / z
        camY = b.y - (bounds.height - p.y) / z
        cameraMoved()
    }

    /// Moves the camera by a screen distance. With shaping on, the speed this step implies is compressed above the
    /// knee (softly); momentum steps also lose speed with time since the fingers lifted.
    func pan(_ dx: CGFloat, _ dy: CGFloat, dt: Double, momentum: Bool, sinceLift: Double) {
        var dx = dx, dy = dy
        if shaping {
            let d = hypot(dx, dy)
            let v = d / CGFloat(max(dt, 1.0 / 240))
            let k = momentum ? knee * 0.6 : knee
            let soft = k * 0.6
            if v > k {
                let out = k + soft * tanh((v - k) / soft)
                dx *= out / v; dy *= out / v
            }
            if momentum && friction > 0 {
                let g = CGFloat(exp(-sinceLift / friction))
                dx *= g; dy *= g
            }
        }
        camX += dx / z; camY += dy / z
        cameraMoved()
    }

    func cameraMoved() {
        moved = true
        applyCamera()
    }

    // MARK: input

    override func scrollWheel(with e: NSEvent) {
        guard script == nil else { return }
        if e.modifierFlags.contains(.command) {
            let d = e.scrollingDeltaY * (e.hasPreciseScrollingDeltas ? 0.01 : 0.1)
            zoom(by: exp(d), at: convert(e.locationInWindow, from: nil))
        } else {
            let k: CGFloat = e.hasPreciseScrollingDeltas ? 1 : 10
            let ts = e.timestamp
            let dt = lastScrollTs > 0 ? ts - lastScrollTs : 1.0 / 120
            lastScrollTs = ts
            let momentum = !e.momentumPhase.isEmpty
            if e.momentumPhase.contains(.began) { momentumStart = ts }
            pan(-e.scrollingDeltaX * k, -e.scrollingDeltaY * k, dt: dt, momentum: momentum, sinceLift: momentum ? ts - momentumStart : 0)
        }
    }

    override func magnify(with e: NSEvent) {
        guard script == nil else { return }
        if e.phase.contains(.began) { pinchRaw = z }
        zoom(by: 1 + e.magnification, at: convert(e.locationInWindow, from: nil), pinching: true)
        if e.phase.contains(.ended) || e.phase.contains(.cancelled) {
            let clamped = min(max(z, fitZoom * 0.5), max(maxZoom, fitZoom))
            if abs(clamped - z) > 1e-4 { springBack = CGPoint(x: clamped, y: 0) }
            pinchRaw = 0
        }
    }

    /// The rubber band settling back to the limit after a pinch.
    func playSpring() {
        guard let target = springBack?.x else { return }
        let nz = abs(target - z) < 0.002 ? target : z + (target - z) * 0.25
        let p = springAnchor
        let b = boardPoint(p)
        z = nz
        camX = b.x - p.x / z
        camY = b.y - (bounds.height - p.y) / z
        if nz == target { springBack = nil }
        cameraMoved()
    }

    override func keyDown(with e: NSEvent) {
        switch e.charactersIgnoringModifiers {
        case "1": mode = 1
        case "2": mode = 2
        case "3": mode = 3
        case "4": mode = 4
        case "z": maxZoom = maxZoom == 2 ? 3 : 2; updateHud()
        case "v": shaping.toggle(); updateHud()
        case "[": knee = max(500, knee - 250); updateHud()
        case "]": knee = min(6000, knee + 250); updateHud()
        case ",": friction = max(0, friction - 0.1); updateHud()
        case ".": friction = min(2, friction + 0.1); updateHud()
        case "m": blurOn.toggle(); updateBlur(step: 0, dir: .zero, force: true); updateHud()
        case "-": blurStrength = max(0.1, blurStrength - 0.1); updateHud()
        case "=": blurStrength = min(2, blurStrength + 0.1); updateHud()
        case "a": liveAsync.toggle(); modeChanged(); updateHud()
        case "c": liveOwn.toggle(); modeChanged(); updateHud()
        case "s": useSurfaces.toggle(); modeChanged(); updateHud()
        case "f", "0": fit(); resetRasters()
        case "b": startBench(boards: [boardIndex], modes: [mode], quit: false)
        default:
            switch e.keyCode {
            case 123, 126: load(boardIndex - 1)
            case 124, 125: load(boardIndex + 1)
            default: super.keyDown(with: e)
            }
        }
    }

    // MARK: frames

    @objc func tick(_ l: CADisplayLink) {
        let now = l.timestamp
        let dt = lastTick > 0 ? now - lastTick : 0
        lastTick = now
        tickStart = CACurrentMediaTime()
        if let s = script { s.step(self, now: CACurrentMediaTime()) }
        playSpring()
        if !moved && blurRadius > 0 { updateBlur(step: 0, dir: .zero) }
        if moved {
            moved = false
            let step = hypot((camX - lastCam.x) * z, (camY - lastCam.y) * z)
            let zoomed = abs(z - lastCam.z) > 1e-6
            let dir = CGPoint(x: camX - lastCam.x, y: camY - lastCam.y)
            lastCam = (camX, camY, z)
            updateBlur(step: zoomed ? 0 : step, dir: dir)
            if gesture == nil || gesture!.motionEnd != nil {
                if let g = gesture { finish(g, interrupted: true) }
                gesture = GestureStats(label: pendingLabel ?? "gesture", mode: mode, refresh: refresh)
                store.decodeMs = []
            } else if dt > 0 {
                gesture!.intervals.append(dt)
                if !zoomed { gesture!.maxStep = max(gesture!.maxStep, step); gesture!.maxSpeed = max(gesture!.maxSpeed, step / CGFloat(dt)) }
            }
            lastMove = now
            if mode == 2 { requestRasters(ahead: true) }
            if mode == 4 { updateTiles() }
            if mode != 1 { requestImages(ahead: true) }
            pulseProbe(gesture!)
        }
        sampleMemory(now)
        guard let g = gesture else { return }
        g.maxVisible = max(g.maxVisible, visible.count)
        g.maxImages = max(g.maxImages, visibleSlots.count)
        var low = 0, imgLow = 0, blank = 0
        if dt > 0 {
            if mode == 4 {
                let st = tileState()
                low = st.low
                if st.fallback > 0 { g.fallbackAny += dt }
                if st.mixed > 0 { g.mixedAny += dt }
                g.lowCard += dt * Double(low)
                g.visCard += dt * Double(visible.count)
                if low > 0 { g.lowAny += dt }
            } else if mode != 3 {
                for i in visible where rasterScale[i] < Render.cappedScale(board.cards[i], z * backing) * 0.98 {
                    low += 1
                    if rasterScale[i] <= baseScale[i] { g.fallbackCards += 1 }
                }
                if visible.contains(where: { rasterScale[$0] <= baseScale[$0] && rasterScale[$0] < Render.cappedScale(board.cards[$0], z * backing) * 0.98 }) { g.fallbackAny += dt }
                if low > 0 { g.lowAny += dt }
                g.lowCard += dt * Double(low)
                g.visCard += dt * Double(visible.count)
            }
            for i in visibleSlots {
                let sl = slots[i]
                if sl.level == 0 { blank += 1 }
                if CGFloat(sl.level) < min(sl.rect.width * z * backing, CGFloat(sl.item.cap)) * 0.98 { imgLow += 1 }
            }
            if imgLow > 0 { g.imgLowAny += dt }
            if blank > 0 { g.imgBlank += dt }
            g.imgLow += dt * Double(imgLow)
            g.imgVis += dt * Double(visibleSlots.count)
            if g.motionEnd != nil && low == 0 && imgLow == 0 { g.settleMs = (now - g.motionEnd!) * 1000; finish(g, interrupted: false) }
        }
        if gesture == nil { return }
        if g.motionEnd == nil && now - lastMove > 0.15 {
            g.motionEnd = lastMove
            if mode == 1 || mode == 2 { requestRasters(ahead: false) }
            if mode == 4 { updateTiles() }
            requestImages(ahead: false)
        } else if let end = g.motionEnd, now - end > 5 {
            finish(g, interrupted: true)
        }
    }

    func finish(_ g: GestureStats, interrupted: Bool) {
        if gesture === g { gesture = nil }
        if g.intervals.isEmpty { return }
        g.decodeMs = store.decodeMs
        g.zoomAtEnd = z
        g.imgBytes = store.bytes
        g.cardBytes = cardMemory()
        g.footprint = physFootprint()
        let v = g.mode == 3 ? (liveOwn ? "own" : liveAsync ? "ca-async" : "ca") : (useSurfaces ? "iosurface" : "cgimage")
        let line = g.summary(board: (board.path as NSString).lastPathComponent) + " variant=" + v
        Log.write(line)
        lastSummary = line
        script?.finished(g)
        updateHud()
        if mode == 1 || mode == 2 { dropOffscreen() }
        if mode == 4 { trimTiles() }
        dropOffscreenImages()
    }

    // MARK: motion blur

    /// Blur radius follows the per-frame displacement above `blurFrom`; it rises at once and fades over a few frames.
    /// The filter is removed entirely at rest, so it costs nothing then.
    func updateBlur(step: CGFloat, dir: CGPoint, force: Bool = false) {
        let target = blurOn ? max(0, step - blurFrom) * blurStrength : 0
        let prev = blurRadius
        blurRadius = target >= blurRadius ? target : blurRadius * 0.7 + target * 0.3
        if blurRadius < 0.3 { blurRadius = 0 }
        if hypot(dir.x, dir.y) > 0 { blurAngle = atan2(-dir.y, dir.x) }  // view y is up, board y is down
        guard force || blurRadius != prev else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        if blurRadius == 0 {
            content.filters = nil
        } else {
            if content.filters == nil {
                let f = CIFilter(name: "CIMotionBlur")!
                f.name = "blur"
                content.filters = [f]
            }
            content.setValue(blurRadius * backing, forKeyPath: "filters.blur.inputRadius")
            content.setValue(blurAngle, forKeyPath: "filters.blur.inputAngle")
            gesture?.blurFrames += 1
        }
        CATransaction.commit()
    }

    // MARK: memory

    /// Bytes held by card pixels: the fit-zoom bitmaps, plus the sharper whole-card bitmaps (modes 1–2), the tiles
    /// (mode 4) or the screen surfaces (mode 3).
    func cardMemory() -> Int {
        var b = baseImage.reduce(0) { $0 + ($1.map { $0.bytesPerRow * $0.height } ?? 0) }
        switch mode {
        case 4: b += tileBytes
        case 3: b += liveSurfaces.reduce(0) { $0 + $1.allocationSize }
        default:
            for (i, c) in board.cards.enumerated() where rasterScale[i] > baseScale[i] {
                b += Int(c.rect.width * c.rect.height * rasterScale[i] * rasterScale[i] * 4)
            }
        }
        return b
    }

    /// About twice a second: memory into the HUD, and peaks into the running gesture.
    func sampleMemory(_ now: Double) {
        guard board != nil else { return }
        let card = cardMemory(), img = store.bytes
        if let g = gesture {
            g.peakCard = max(g.peakCard, card); g.peakImg = max(g.peakImg, img)
        }
        guard now - lastMemSample > 0.5 else { return }
        lastMemSample = now
        let foot = physFootprint()
        gesture.map { $0.peakFootprint = max($0.peakFootprint, foot) }
        memLine = String(format: "memory: cards %.0f MB · images %.0f MB · process %.0f MB", Double(card) / 1e6, Double(img) / 1e6, Double(foot) / 1e6)
        updateHud()
    }

    // MARK: images

    func loadImages() {
        slots.forEach { $0.layer.removeFromSuperlayer() }
        store.generation += 1
        store.queue.cancelAllOperations()
        store.items = [:]
        slots = []; baseLevel = []
        loadStart = CACurrentMediaTime()
        firstVisibleLogged = false; firstAllLogged = false
        for c in board.cards {
            for im in c.images {
                guard let item = store.item(im.path) else { continue }
                let sl = ImageSlot(item: item, rect: im.rect)
                world2.addSublayer(sl.layer)
                slots.append(sl)
                baseLevel.append(item.level(for: im.rect.width * fitZoom * backing))
            }
        }
        computeVisible()
        // First the visible images at the current zoom, then every image at the fit level (never blank after that).
        requestImages(ahead: false)
        for i in slots.indices where slots[i].level == 0 && !slots[i].inFlight { show(i, level: baseLevel[i]) }
    }

    /// Decode (or reuse) `level` for slot i and show it when ready; the previous level stays on screen until then.
    func show(_ i: Int, level: Int) {
        let sl = slots[i]
        sl.inFlight = true
        let gen = store.generation
        store.request(sl.item, level: level) { [weak self] surf in
            guard let self, self.store.generation == gen else { return }
            sl.inFlight = false
            guard let surf, level != sl.level else { return }
            CATransaction.begin(); CATransaction.setDisableActions(true)
            sl.layer.contents = surf
            sl.layer.backgroundColor = nil
            CATransaction.commit()
            sl.level = level
            self.checkFirstOpen()
        }
    }

    func requestImages(ahead: Bool) {
        for i in visibleSlots where !slots[i].inFlight {
            let sl = slots[i]
            let need = sl.rect.width * z * backing
            let target = min(need, CGFloat(sl.item.cap))
            if CGFloat(sl.level) >= target * 0.98 && sl.level <= 4 * sl.item.level(for: need) { continue }
            let want = sl.item.level(for: ahead && zoomingIn ? need * 1.3 : need)
            if want != sl.level { show(i, level: want) }
        }
    }

    /// After a gesture: off-screen images back to their fit level, and levels nobody shows are freed.
    func dropOffscreenImages() {
        let vis = Set(visibleSlots)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for i in slots.indices where !vis.contains(i) && slots[i].level > baseLevel[i] && !slots[i].inFlight {
            if let s = slots[i].item.levels[baseLevel[i]] { slots[i].layer.contents = s; slots[i].level = baseLevel[i] }
        }
        CATransaction.commit()
        var keep: [ObjectIdentifier: Set<Int>] = [:]
        for (i, sl) in slots.enumerated() { keep[ObjectIdentifier(sl.item), default: []].formUnion([sl.level, baseLevel[i]]) }
        for item in store.items.values where item.pending.isEmpty { store.trim(item, keep: keep[ObjectIdentifier(item)] ?? []) }
    }

    func checkFirstOpen() {
        let ms = (CACurrentMediaTime() - loadStart) * 1000
        let name = (board.path as NSString).lastPathComponent
        if !firstVisibleLogged && visibleSlots.allSatisfy({ slots[$0].level > 0 }) {
            firstVisibleLogged = true
            Log.write(String(format: "first-open board=%@ images=%d files=%d visible_images=%d visible_ready=%.0fms", name,
                             slots.count, store.items.count, visibleSlots.count, ms))
        }
        if !firstAllLogged && slots.allSatisfy({ $0.level > 0 }) {
            firstAllLogged = true
            let d = store.decodeMs
            Log.write(String(format: "first-open board=%@ all_images_ready=%.0fms decodes=%d decode_p50=%.1fms decode_max=%.1fms image_mem=%.1fMB",
                             name, ms, d.count, GestureStats.pct(d, 0.5), d.max() ?? 0, Double(store.bytes) / 1e6))
        }
    }

    // MARK: presented-frame probe

    func pulseProbe(_ g: GestureStats) {
        guard let q = mtlQueue, let d = probe.nextDrawable(), let cb = q.makeCommandBuffer() else { g.probeMissed += 1; return }
        let rp = MTLRenderPassDescriptor()
        rp.colorAttachments[0].texture = d.texture
        rp.colorAttachments[0].loadAction = .clear
        rp.colorAttachments[0].storeAction = .store
        let v = Double(g.intervals.count % 2) * 0.1 + 0.85
        rp.colorAttachments[0].clearColor = MTLClearColor(red: v, green: v, blue: v, alpha: 1)
        cb.makeRenderCommandEncoder(descriptor: rp)?.endEncoding()
        cb.commit()
        cb.waitUntilScheduled()
        d.addPresentedHandler { [weak g] dr in
            let t = dr.presentedTime
            DispatchQueue.main.async { g?.presented.append(t) }
        }
        d.present()
    }

    /// Off-screen cards go back to their base bitmap, so memory stays bounded.
    func dropOffscreen() {
        let vis = Set(visible)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for i in cardLayers.indices where !vis.contains(i) && rasterScale[i] > baseScale[i] && !inFlight[i] {
            cardLayers[i].contents = baseImage[i]; rasterScale[i] = baseScale[i]
        }
        CATransaction.commit()
    }

    /// Re-rasterise visible cards off the main thread; the old bitmap stays until the new one is ready.
    func requestRasters(ahead: Bool) {
        let target = z * backing
        let gen = generation
        let surfaces = useSurfaces
        for i in visible where !inFlight[i] {
            let c = board.cards[i]
            let best = Render.cappedScale(c, target)
            let r = rasterScale[i]
            guard r < best * 0.98 || r > target * 2.5 else { continue }
            let want = Render.cappedScale(c, ahead && zoomingIn ? target * 1.3 : target)
            inFlight[i] = true
            pool.addOperation { [weak self] in
                let t0 = CACurrentMediaTime()
                let img: Any? = surfaces ? Render.rasterSurface(c, scale: want) : Render.raster(c, scale: want)
                let ms = (CACurrentMediaTime() - t0) * 1000
                DispatchQueue.main.async {
                    guard let self, self.generation == gen else { return }
                    self.inFlight[i] = false
                    CATransaction.begin(); CATransaction.setDisableActions(true)
                    self.cardLayers[i].contents = img
                    CATransaction.commit()
                    self.rasterScale[i] = want
                    if let g = self.gesture { g.rasters += 1; g.rasterMs.append(ms) }
                }
            }
        }
    }

    // MARK: live drawing (mode 3)

    func draw(_ layer: CALayer, in ctx: CGContext) {
        guard layer === live, board != nil, mode == 3, !liveOwn else { return }
        let t0 = CACurrentMediaTime()
        drawVisible(ctx)
        gesture?.drawMs.append((CACurrentMediaTime() - t0) * 1000)
    }

    // MARK: HUD

    func layoutHud() {
        hud.frame = CGRect(x: 12, y: bounds.height - 12 - 76, width: min(bounds.width - 24, 1180), height: 76)
    }

    func updateHud() {
        guard board != nil else { return }
        let fps = window?.screen?.maximumFramesPerSecond ?? 0
        let variant = mode == 3 ? (liveOwn ? "(own surface)" : liveAsync ? "(CA, drawsAsynchronously)" : "(CA backing store)")
            : (useSurfaces ? "(IOSurface)" : "(CGImage)")
        hud.string = """
         mode \(mode) \(Canvas.modeNames[mode]!)\(variant)   1–4 modes · z 200/300% · v shaping [ ] knee , . friction · m blur - = strength · c live: own surface / CA · a async · s IOSurface / CGImage · f fit · ←/→ · b bench
         board \(boardIndex + 1)/\(boards.count) \((board.path as NSString).lastPathComponent)  cards \(board.cards.count)  display \(fps) Hz
         zoom \(String(format: "%.2f", z)) (max \(Int(maxZoom * 100))%)  shaping \(shaping ? "knee \(Int(knee)) pt/s, friction \(String(format: "%.1f", friction)) s" : "off")  blur \(blurOn ? String(format: "%.1f", blurStrength) : "off")  visible \(visible.count)   \(memLine)
         last: \(lastSummary.split(separator: " ").dropFirst(2).joined(separator: " "))
        """
    }
}

extension Canvas {
    /// Renders the view's layer tree into a PNG (for checking the drawing without screen-recording permission).
    func snapshot(to path: String) {
        let s = backing
        let w = Int(bounds.width * s), h = Int(bounds.height * s)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return }
        ctx.scaleBy(x: s, y: s)
        layer!.render(in: ctx)
        guard let img = ctx.makeImage(), let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(dest, img, nil)
        CGImageDestinationFinalize(dest)
    }
}

extension Canvas {
    static var pow2ForDiff = false

    func snapshotPixels() -> (w: Int, h: Int, px: [UInt8]) {
        let s = backing
        let w = Int(bounds.width * s), h = Int(bounds.height * s)
        var px = [UInt8](repeating: 0, count: w * h * 4)
        px.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
            else { return }
            ctx.scaleBy(x: s, y: s)
            layer!.render(in: ctx)
        }
        return (w, h, px)
    }

    /// Writes |a − b| amplified 4× as a PNG and logs how many pixels differ, and whether differences line up in rows or
    /// columns (what a tile seam would look like).
    static func diff(_ a: (w: Int, h: Int, px: [UInt8]), _ b: (w: Int, h: Int, px: [UInt8]), to path: String) {
        guard a.w == b.w, a.h == b.h else { return }
        var out = [UInt8](repeating: 255, count: a.px.count)
        var differ = 0, maxd = 0
        var colHits = [Int](repeating: 0, count: a.w), rowHits = [Int](repeating: 0, count: a.h)
        for i in stride(from: 0, to: a.px.count, by: 4) {
            var d = 0
            for k in 0..<3 { d = max(d, abs(Int(a.px[i + k]) - Int(b.px[i + k]))) }
            maxd = max(maxd, d)
            if d > 24 { differ += 1; let p = i / 4; colHits[p % a.w] += 1; rowHits[p / a.w] += 1 }
            let v = UInt8(max(0, 255 - min(255, d * 4)))
            out[i] = v; out[i + 1] = v; out[i + 2] = 255; out[i + 3] = 255
        }
        let lineCols = colHits.filter { $0 > a.h / 3 }.count, lineRows = rowHits.filter { $0 > a.w / 3 }.count
        Log.write("diff tiles-vs-whole pixels=\(a.w * a.h) differ(>24)=\(differ) max=\(maxd) seam_like_cols=\(lineCols) seam_like_rows=\(lineRows)")
        out.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: a.w, height: a.h, bitsPerComponent: 8, bytesPerRow: a.w * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
                  let img = ctx.makeImage(),
                  let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil)
            else { return }
            CGImageDestinationAddImage(dest, img, nil)
            CGImageDestinationFinalize(dest)
        }
    }
}

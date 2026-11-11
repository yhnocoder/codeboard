import AppKit
import QuartzCore

/// Mode 5, "levels": while a gesture runs the GPU only moves and scales the bitmaps the cards already have; nothing is
/// redrawn, snapshotted or swapped. At rest every card in view (plus a margin) gets a bitmap at a fixed level chosen so
/// that one zoom-in of up to 2x from rest stays at or above display resolution; the redraws are queued nearest the
/// viewport centre and the pointer first, run at most `concurrency` at a time, and are swapped onto the screen within
/// a pixel budget per frame. A new gesture cancels the queue and drops late results.
final class LevelState {
    var budget = 8_000_000          // device pixels swapped onto the screen per frame
    var concurrency = 4             // background redraws at once
    var cardsPerFrame = 4           // cards swapped onto the screen per frame (with the pixel budget: whichever is hit first)
    var queue: [(i: Int, scale: CGFloat, exact: Bool)] = []
    /// At rest, visible cards are shown from the smallest level at or above the zoom (shrunk by at most 2x), with linear
    /// filtering: drawn exactly as the live editor is, which is drawn at that level by WebKit and shrunk linearly. The
    /// held level (one up, for zooming in) is shown during gestures with mipmaps. When the two levels differ, the rest
    /// bitmap is a sublayer over the held one; a pan keeps it, a zoom hides it and the held bitmap takes over.
    var exact = true
    var exactLayers: [Int: CALayer] = [:]
    var exactScale: [Int: CGFloat] = [:]
    var pictureBase: [Int: IOSurface] = [:]   // fit-zoom bitmaps with their pictures (cards that have pictures)   // scale of the bitmap each rest layer shows
    var restZ: CGFloat = 0
    var inflight = 0
    var gen = 0
    var ready: [(i: Int, scale: CGFloat, contents: Any, px: Int, exact: Bool)] = []
    var resting = true
    var restAt = 0.0
    var queued = Set<Int>()
    var swapsThisFrame = 0
    var ring: CGFloat = 1            // second ring, in screens beyond the view (0 = off)
    let raster: OperationQueue = {
        let q = OperationQueue()
        q.qualityOfService = .userInitiated
        return q
    }()
    /// Larger than the other modes' cap, so a 940 × 1115 Note at 200 % (4 px per unit) fits whole.
    static let maxPixels: CGFloat = 24_000_000
}

extension Canvas {
    static let levels: [CGFloat] = [0.5, 1, 2]

    /// The level (zoom) a card holds at rest at zoom z: the smallest level at or above min(2z, the top level), so a
    /// zoom-in of up to 2x from rest never needs more than is held.
    func restLevel(_ z: CGFloat) -> CGFloat {
        let need = min(2 * z, Canvas.levels.last!)
        return Canvas.levels.first { $0 >= need - 1e-6 } ?? Canvas.levels.last!
    }

    func levelScale(_ i: Int, _ level: CGFloat) -> CGFloat {
        let c = board.cards[i]
        var s = level * backing
        let px = c.rect.width * c.rect.height * s * s
        if px > LevelState.maxPixels { s *= sqrt(LevelState.maxPixels / px) }
        return s
    }

    var levelMode: Bool { mode == 5 }

    /// Called from cameraMoved: the first movement after rest starts a gesture.
    func levelGestureStart() {
        guard levelMode, lv.resting else { return }
        lv.resting = false
        lv.gen += 1
        lv.queue = []
        lv.queued = []
        lv.ready = []
        lv.raster.cancelAllOperations()
        if web.editing != nil { freezeEditor() }
    }

    /// Rest: fill the levels the view needs, nearest first; release what is far away.
    func levelRest() {
        guard levelMode else { return }
        if let i = web.editing { snapCamera(to: i) }
        exactOnCameraMove()  // the zoom may have been set without a gesture (fit, board switch): reset the rest bitmaps
        lv.resting = true
        lv.restAt = CACurrentMediaTime()
        lv.gen += 1
        lv.queue = []
        lv.queued = []
        lv.ready = []
        let level = restLevel(z)
        let w = bounds.width / z, h = bounds.height / z
        let view = CGRect(x: camX, y: camY, width: w, height: h)
        let near = view.insetBy(dx: -w * 0.25, dy: -h * 0.25)
        // a second ring, one screen beyond the view, at display resolution (no headroom), filled after the first
        let far = view.insetBy(dx: -w * lv.ring, dy: -h * lv.ring)
        let shown = Canvas.levels.first { $0 >= min(z, Canvas.levels.last!) - 1e-6 } ?? Canvas.levels.last!
        let center = CGPoint(x: view.midX, y: view.midY)
        let mouse = window.map { boardPoint(convert($0.mouseLocationOutsideOfEventStream, from: nil)) } ?? center
        var want: [(i: Int, scale: CGFloat, d: CGFloat)] = []
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for (i, c) in board.cards.enumerated() {
            if web.editing == i { continue }
            let inNear = c.rect.intersects(near)
            guard inNear || (lv.ring > 0 && c.rect.intersects(far)) else {
                // far away: back to the fit-zoom bitmap (no visible change)
                hideExact(i)
                if rasterScale[i] > baseScale[i] && !(web.editing == i) {
                    cardLayers[i].contents = webBaseContents(i); rasterScale[i] = baseScale[i]
                }
                continue
            }
            let s = levelScale(i, inNear ? level : shown)
            let r = rasterScale[i]
            // missing (below the level), or two levels above it (memory)
            if r < s * 0.98 || r > s * 2.5 {
                let p = CGPoint(x: c.rect.midX, y: c.rect.midY)
                let d = min(hypot(p.x - center.x, p.y - center.y), hypot(p.x - mouse.x, p.y - mouse.y))
                want.append((i, s, d + (c.rect.intersects(view) ? 0 : inNear ? 100_000 : 1_000_000)))
            }
        }
        CATransaction.commit()
        var jobs = want.map { (i: $0.i, scale: $0.scale, exact: false, d: $0.d) }
        if lv.exact {
            let lr = shownLevel
            CATransaction.begin(); CATransaction.setDisableActions(true)
            for i in visible where web.editing != i && c_intersects(i, view) {
                let s = levelScale(i, lr)
                // the held bitmap is already at that level: just show it linearly
                if abs(levelScale(i, level) - s) / s < 0.01 { hideExact(i); cardLayers[i].minificationFilter = .linear; continue }
                if let l = lv.exactLayers[i], l.contents != nil, abs((lv.exactScale[i] ?? 0) - s) / s < 0.01 { continue }
                let p = CGPoint(x: board.cards[i].rect.midX, y: board.cards[i].rect.midY)
                // what is seen at rest goes first; the held level (for the next zoom-in) after it
                jobs.append((i, s, true, min(hypot(p.x - center.x, p.y - center.y), hypot(p.x - mouse.x, p.y - mouse.y)) - 50_000))
            }
            CATransaction.commit()
        }
        lv.restZ = z
        alignRestLayers()   // a pan keeps the rest bitmaps; their corners go back onto whole pixels
        if ProcessInfo.processInfo.environment["CANVAS_RESTLOG"] != nil {
            Log.write(String(format: "rest gen=\(lv.gen) z=%.2f level=%.1f jobs=%d exact_jobs=%d visible=%d", z, level, jobs.count, jobs.filter { $0.exact }.count, visible.count))
        }
        lv.queue = jobs.sorted { $0.d < $1.d }.map { ($0.i, $0.scale, $0.exact) }
        lv.queued = Set(lv.queue.map { $0.i })
        requestImages(ahead: false, headroom: 2)
        if web.editing != nil { thawEditor() }
    }

    /// Each frame at rest: start redraws up to the concurrency cap, swap finished ones within the pixel budget.
    func levelPump() {
        guard levelMode, lv.resting else { return }
        let gen = lv.gen
        while lv.inflight < lv.concurrency, !lv.queue.isEmpty {
            let job = lv.queue.removeFirst()
            let i = job.i, scale = job.scale, exact = job.exact
            lv.inflight += 1
            if isWebNote(i) {
                webSnapshot(i, scale: scale) { [weak self] surf, ms in
                    guard let self else { return }
                    self.lv.inflight -= 1
                    self.lv.queued.remove(i)
                    if self.lv.gen != gen, exact, ProcessInfo.processInfo.environment["CANVAS_RESTLOG"] != nil { Log.write("rest-bitmap dropped card=\(i) (gen \(gen) → \(self.lv.gen))") }
                    guard self.lv.gen == gen, let surf else { return }
                    self.lv.ready.append((i, scale, surf, surf.width * surf.height, exact))
                    self.gesture?.rasterMs.append(ms)
                }
            } else {
                let c = board.cards[i]
                lv.raster.maxConcurrentOperationCount = lv.concurrency
                let op = BlockOperation()
                op.addExecutionBlock { [weak self, weak op] in
                    guard let op, !op.isCancelled else {
                        DispatchQueue.main.async { self?.lv.inflight -= 1; self?.lv.queued.remove(i) }
                        return
                    }
                    let t0 = CACurrentMediaTime()
                    // one pipeline: the card's pictures are drawn into its bitmap at the same scale
                    let surf = Render.rasterSurface(c, scale: scale, images: Render.pictures(c, scale: scale))
                    let ms = (CACurrentMediaTime() - t0) * 1000
                    DispatchQueue.main.async {
                        guard let self else { return }
                        self.lv.inflight -= 1
                        self.lv.queued.remove(i)
                        guard self.lv.gen == gen, let surf else { return }
                        self.lv.ready.append((i, scale, surf, surf.width * surf.height, exact))
                        self.gesture?.rasterMs.append(ms)
                    }
                }
                lv.raster.addOperation(op)
            }
        }
        guard !lv.ready.isEmpty else { return }
        var px = 0, cards = 0
        CATransaction.begin(); CATransaction.setDisableActions(true)
        while let r = lv.ready.first, cards < lv.cardsPerFrame, px == 0 || px + r.px <= lv.budget {
            lv.ready.removeFirst()
            px += r.px
            cards += 1
            if web.editing == r.i { continue }
            if r.exact {
                if ProcessInfo.processInfo.environment["CANVAS_RESTLOG"] != nil { Log.write("rest-bitmap swap card=\(r.i) scale=\(r.scale)") }
                let l = exactLayer(r.i)
                // shown 1:1 at its own scale, not stretched to the card's (fractional) size: no resampling at all
                l.contentsGravity = Canvas.restExact ? .topLeft : .resize
                l.contentsScale = Canvas.restExact ? r.scale : 1
                l.masksToBounds = Canvas.restExact
                l.contents = r.contents
                lv.exactScale[r.i] = r.scale
                if Canvas.restExact { pixelAlign(r.i) }
                continue
            }
            cardLayers[r.i].contents = r.contents
            rasterScale[r.i] = r.scale
            gesture?.rasters += 1
        }
        CATransaction.commit()
        // A swap made inside the display-link callback reached the screen only with a later commit (seen by capturing
        // the window): flush so it is drawn in this frame.
        CATransaction.flush()
        lv.swapsThisFrame = px
    }

    func exactScale(_ i: Int) -> CGFloat {
        let c = board.cards[i]
        var s = z * backing
        let px = c.rect.width * c.rect.height * s * s
        if px > LevelState.maxPixels { s *= sqrt(LevelState.maxPixels / px) }
        return s
    }

    func c_intersects(_ i: Int, _ view: CGRect) -> Bool { board.cards[i].rect.intersects(view) }

    func exactLayer(_ i: Int) -> CALayer {
        if let l = lv.exactLayers[i] { return l }
        let l = CALayer()
        l.anchorPoint = .zero
        l.frame = cardLayers[i].bounds
        l.contentsGravity = .resize
        l.minificationFilter = .linear   // as WebKit shrinks the live editor
        l.zPosition = 1
        l.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "hidden": NSNull()]
        cardLayers[i].addSublayer(l)
        lv.exactLayers[i] = l
        return l
    }

    /// A rest layer is never hidden (IOSurface contents set on a hidden layer did not reach the screen after it was
    /// shown); without contents it is transparent.
    func hideExact(_ i: Int) {
        guard let l = lv.exactLayers[i], l.contents != nil else { return }
        l.contents = nil
        lv.exactScale[i] = nil
    }

    /// The level shown at rest: the smallest level at or above the zoom, or (rest mode "exact") the zoom itself, drawn
    /// 1:1 with no resampling.
    var shownLevel: CGFloat {
        if Canvas.restExact { return min(z, Canvas.levels.last!) }
        return Canvas.levels.first { $0 >= min(z, Canvas.levels.last!) - 1e-6 } ?? Canvas.levels.last!
    }
    nonisolated(unsafe) static var restExact = ProcessInfo.processInfo.environment["CANVAS_RESTMODE"] == "exact"

    /// A zoom (not a pan) away from the rest zoom: the held bitmaps take over, with mipmaps.
    func exactOnCameraMove() {
        guard levelMode, abs(z - lv.restZ) > 1e-6 else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for i in lv.exactLayers.keys { hideExact(i) }
        for l in cardLayers where l.minificationFilter != .trilinear { l.minificationFilter = .trilinear }
        CATransaction.commit()
    }

    /// Mode 5 draws pictures into card bitmaps, so the fit-zoom fallback of a card with pictures is redrawn with them.
    func loadPictureBases() {
        lv.pictureBase = [:]
        guard levelMode else { return }
        let gen = generation
        for (i, c) in board.cards.enumerated() where !c.images.isEmpty && !isWebNote(i) {
            let scale = baseScale[i]
            lv.raster.addOperation { [weak self] in
                let surf = Render.rasterSurface(c, scale: scale, images: Render.pictures(c, scale: scale))
                DispatchQueue.main.async {
                    guard let self, self.generation == gen, let surf else { return }
                    self.lv.pictureBase[i] = surf
                    if self.rasterScale[i] <= self.baseScale[i] && self.web.editing != i {
                        CATransaction.begin(); CATransaction.setDisableActions(true)
                        self.cardLayers[i].contents = surf
                        CATransaction.commit()
                    }
                }
            }
        }
    }

    /// Card i's top-left corner on screen, in device pixels (y down from the view's top).
    func deviceCorner(_ i: Int) -> CGPoint {
        let r = board.cards[i].rect, s = z * backing
        return CGPoint(x: (r.minX - camX) * s, y: (r.minY - camY) * s)
    }

    /// Rest mode "exact": the card's 1:1 bitmap is moved by under half a device pixel so its corner lands on a whole
    /// pixel; drawn without any resampling, like the editor (whose view is rounded the same way).
    func pixelAlign(_ i: Int) {
        guard let l = lv.exactLayers[i] else { return }
        let p = deviceCorner(i), s = z * backing
        let dx = (p.x.rounded() - p.x) / s, dy = (p.y.rounded() - p.y) / s
        let b = cardLayers[i].bounds
        // layer space is y up: moving the top edge down on screen (dy > 0) lowers the layer
        l.frame = CGRect(x: dx, y: -dy, width: b.width, height: b.height)
    }

    func alignRestLayers() {
        guard Canvas.restExact else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for i in visible where lv.exactLayers[i]?.contents != nil { pixelAlign(i) }
        CATransaction.commit()
    }

    var levelBusy: Bool { !lv.queue.isEmpty || lv.inflight > 0 || !lv.ready.isEmpty }
}

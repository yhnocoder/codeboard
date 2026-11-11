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
    var queue: [(i: Int, scale: CGFloat)] = []
    var inflight = 0
    var gen = 0
    var ready: [(i: Int, scale: CGFloat, contents: Any, px: Int)] = []
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
        lv.queue = want.sorted { $0.d < $1.d }.map { ($0.i, $0.scale) }
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
            let i = job.i, scale = job.scale
            lv.inflight += 1
            if isWebNote(i) {
                webSnapshot(i, scale: scale) { [weak self] surf, ms in
                    guard let self else { return }
                    self.lv.inflight -= 1
                    self.lv.queued.remove(i)
                    guard self.lv.gen == gen, let surf else { return }
                    self.lv.ready.append((i, scale, surf, surf.width * surf.height))
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
                    let surf = Render.rasterSurface(c, scale: scale)
                    let ms = (CACurrentMediaTime() - t0) * 1000
                    DispatchQueue.main.async {
                        guard let self else { return }
                        self.lv.inflight -= 1
                        self.lv.queued.remove(i)
                        guard self.lv.gen == gen, let surf else { return }
                        self.lv.ready.append((i, scale, surf, surf.width * surf.height))
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
            cardLayers[r.i].contents = r.contents
            rasterScale[r.i] = r.scale
            gesture?.rasters += 1
        }
        CATransaction.commit()
        lv.swapsThisFrame = px
    }

    var levelBusy: Bool { !lv.queue.isEmpty || lv.inflight > 0 || !lv.ready.isEmpty }
}

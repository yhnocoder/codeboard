import AppKit

/// A scripted pan and zoom, driven from the display link: per board and mode, pan across the board at 100 %,
/// zoom from fit to the maximum zoom around the centre, and back out. Each motion is one gesture in the log.
final class Bench {
    struct Run { let board: Int; let mode: Int }
    enum Seg { case pan(Double), zoomIn(Double), zoomOut(Double), flick(Double), zoomTo(CGFloat, CGFloat, Double, String) }
    var labels: [String] = []

    var runs: [Run]
    let quit: Bool
    var run = -1
    var segs: [Seg] = []
    var seg = -1
    var segStart = 0.0
    var waiting = true     // between motions: wait for the gesture to be logged (settled), then a short pause
    var waitSince = 0.0
    var results: [GestureStats] = []
    var flickDone: CGFloat = 0
    var flickLast = 0.0
    var flickLifted = false
    var prepared = false

    init(runs: [Run], quit: Bool) { self.runs = runs; self.quit = quit }

    func next(_ c: Canvas, now: Double) {
        seg += 1
        if seg >= segs.count {
            run += 1
            if run >= runs.count { done(c); return }
            let r = runs[run]
            if c.boardIndex != r.board || c.board == nil { c.load(r.board) }
            c.mode = r.mode
            c.fit(); c.resetRasters()
            if r.mode == 5 {
                // mode 5: every motion starts from rest at its start zoom with the levels filled
                segs = [.zoomTo(0.5, 1, 0.4, "pinch-in-2x"), .zoomTo(1, 2, 2, "zoom-in-2x"), .zoomTo(0.5, 2, 2, "zoom-in-4x"),
                        .zoomTo(2, 0.5, 2, "zoom-out"), .flick(0.15), .pan(3)]
                labels = ["pinch-in-2x", "zoom-in-2x", "zoom-in-4x", "zoom-out", "flick", "pan-across"]
                if ProcessInfo.processInfo.environment["CANVAS_ONLYFLICK"] != nil { segs = [.flick(0.15)]; labels = ["flick"] }
            } else {
                segs = [.pan(3), .zoomIn(2), .zoomOut(2), .flick(0.15), .zoomIn(0.4), .zoomOut(0.4)]
                labels = ["pan", "zoom-in", "zoom-out", "flick", "pinch-in", "pinch-out"]
            }
            seg = 0
        }
        if case .zoomTo(let a, _, _, _) = segs[seg], !prepared {
            // the start zoom, then wait at rest until the levels are filled
            let b = c.board.bounds
            c.z = max(a, c.fitZoom * 0.5)
            c.camX = b.midX - c.bounds.width / 2 / c.z
            c.camY = b.midY - c.bounds.height / 2 / c.z
            c.applyCamera()
            c.resetRasters()
            prepared = true
            seg -= 1
            waiting = true
            waitSince = now
            return
        }
        if c.mode == 5, !prepared, { if case .flick = segs[seg] { return true }; if case .pan = segs[seg] { return true }; return false }() {
            place(c, t: 0); c.resetRasters(); flickDone = 0; flickLast = 0; flickLifted = false
            prepared = true
            seg -= 1
            waiting = true
            waitSince = now
            return
        }
        prepared = false
        switch segs[seg] {  // start sharp where a pan starts
        case .pan, .flick:
            if c.mode != 5 { place(c, t: 0); c.resetRasters() }
            flickDone = 0; flickLast = 0; flickLifted = false
        default: break
        }
        segStart = now
        waiting = false
        c.pendingLabel = labels[seg]
    }

    func step(_ c: Canvas, now: Double) {
        if waiting {
            if c.gesture == nil && c.web.pending == 0 && !c.levelBusy && now - waitSince > 0.4 || now - waitSince > 12 { next(c, now: now) }
            return
        }
        let t = now - segStart
        let b = c.board.bounds
        let w = c.bounds.width, h = c.bounds.height
        switch segs[seg] {
        case .pan(let d):
            let p = min(t / d, 1)
            place(c, t: p)
            c.cameraMoved()
            if p >= 1 { pause(now) }
        case .flick(let d):
            // A flick as the trackpad delivers it: fingers move at 3000 pt/s for `d`, through the shaping, then lift;
            // the canvas glides on its own. The segment ends when the glide stops.
            if t < d {
                let dtStep = flickLast > 0 ? now - flickLast : 1.0 / 120
                flickLast = now
                c.pan(3000 * CGFloat(dtStep), 0, dt: dtStep)
            } else if !flickLifted {
                flickLifted = true
                c.startGlide(at: now)
            } else if c.glide == nil {
                pause(now)
            }
        case .zoomTo(let a0, let e0, let d, _):
            let a = max(a0, c.fitZoom * 0.5), e = max(e0, c.fitZoom * 0.5)
            let p = min(t / d, 1)
            let nz = a * pow(e / a, CGFloat(p))
            c.zoomingIn = e > a
            c.z = nz
            c.camX = b.midX - w / 2 / nz
            c.camY = b.midY - h / 2 / nz
            c.cameraMoved()
            if p >= 1 { pause(now) }
        case .zoomIn(let d), .zoomOut(let d):
            let inward: Bool
            if case .zoomIn = segs[seg] { inward = true } else { inward = false }
            let p = min(t / d, 1)
            let top = max(c.maxZoom, c.fitZoom)
            let (a, e) = inward ? (c.fitZoom, top) : (top, c.fitZoom)
            let nz = a * pow(e / a, CGFloat(p))
            c.zoomingIn = inward
            c.z = nz
            c.camX = b.midX - w / 2 / nz
            c.camY = b.midY - h / 2 / nz
            c.cameraMoved()
            if p >= 1 { pause(now) }
        }
    }

    func place(_ c: Canvas, t p: Double) {
        let b = c.board.bounds, w = c.bounds.width, h = c.bounds.height
        let zp = max(1.0, c.fitZoom)
        let span = max(b.width - w / zp, w / zp)
        c.z = zp
        c.camX = b.minX + span * CGFloat(p) - (b.width - w / zp < 0 ? w / zp / 2 : 0)
        c.camY = b.midY - h / 2 / zp
        c.applyCamera()
    }

    func pause(_ now: Double) { waiting = true; waitSince = now }

    func finished(_ g: GestureStats) { results.append(g) }

    func done(_ c: Canvas) {
        c.script = nil
        Log.write("bench done")
        if quit { NSApp.terminate(nil) }
    }
}

extension Canvas {
    func startBench(boards: [Int], modes: [Int], quit: Bool) {
        var runs: [Bench.Run] = []
        for b in boards { for m in modes { runs.append(.init(board: b, mode: m)) } }
        let s = Bench(runs: runs, quit: quit)
        s.waitSince = CACurrentMediaTime() - 1
        Log.write("bench start runs=\(runs.count) display=\(window?.screen?.maximumFramesPerSecond ?? 0)Hz backing=\(backing) view=\(Int(bounds.width))x\(Int(bounds.height))")
        script = s
    }
}

extension Canvas {
    /// The same scripted flick (fingers at 3000 pt/s for 150 ms, then lift) at each τ; the glide logs its distance and
    /// duration. Then quits.
    func glideTest(_ taus: [Double]) {
        var rest = taus
        guard !rest.isEmpty else { NSApp.terminate(nil); return }
        tau = rest.removeFirst()
        fit(); z = max(1, fitZoom); applyCamera()
        let start = CACurrentMediaTime()
        var last = start
        func step() {
            let now = CACurrentMediaTime()
            if now - start < 0.15 {
                pan(3000 * CGFloat(now - last), 0, dt: now - last)
                last = now
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 120) { step() }
            } else {
                startGlide(at: now)
                func wait() {
                    if self.glide == nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.glideTest(rest) } }
                    else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { wait() } }
                }
                wait()
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 120) { step() }
    }
}

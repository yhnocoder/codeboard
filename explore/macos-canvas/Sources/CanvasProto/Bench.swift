import AppKit

/// A scripted pan and zoom, driven from the display link: per board and mode, pan across the board at 100 %,
/// zoom from fit to 300 % around the centre, and back out. Each motion is one gesture in the log.
final class Bench {
    struct Run { let board: Int; let mode: Int }
    enum Seg { case pan(Double), zoomIn(Double), zoomOut(Double), flick(Double) }

    var runs: [Run]
    let quit: Bool
    var run = -1
    var segs: [Seg] = []
    var seg = -1
    var segStart = 0.0
    var waiting = true     // between motions: wait for the gesture to be logged (settled), then a short pause
    var waitSince = 0.0
    var results: [GestureStats] = []

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
            segs = [.pan(3), .zoomIn(2), .zoomOut(2), .flick(0.8), .zoomIn(0.4), .zoomOut(0.4)]
            seg = 0
        }
        switch segs[seg] {  // start sharp where a pan starts
        case .pan, .flick: place(c, t: 0); c.resetRasters()
        default: break
        }
        segStart = now
        waiting = false
        c.pendingLabel = ["pan", "zoom-in", "zoom-out", "flick", "pinch-in", "pinch-out"][seg]
    }

    func step(_ c: Canvas, now: Double) {
        if waiting {
            if c.gesture == nil && now - waitSince > 0.4 || now - waitSince > 4 { next(c, now: now) }
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
            // A momentum-like flick: starts at 5000 pt/s and decelerates to rest (ease-out cubic).
            let p = min(t / d, 1)
            let zp = max(1.0, c.fitZoom)
            let dist = 5000 * d / 3 / zp
            place(c, t: 0)
            c.camX += dist * CGFloat(1 - pow(1 - p, 3))
            c.applyCamera()
            c.cameraMoved()
            if p >= 1 { pause(now) }
        case .zoomIn(let d), .zoomOut(let d):
            let inward: Bool
            if case .zoomIn = segs[seg] { inward = true } else { inward = false }
            let p = min(t / d, 1)
            let (a, e) = inward ? (c.fitZoom, 3.0) : (3.0, c.fitZoom)
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

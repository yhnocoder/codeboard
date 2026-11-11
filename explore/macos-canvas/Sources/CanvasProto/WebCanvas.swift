import AppKit
import WebKit

/// Notes drawn by the Markdown package in WebKit: snapshots as card bitmaps (modes 1–2), and the package's editor in a
/// live WKWebView over the card on double-click.
final class WebState {
    var on = true
    var pool: [NoteWeb] = []
    var tails: [Task<Void, Never>?] = []
    var base: [IOSurface?] = []
    var baseScale: [CGFloat] = []
    var pending = 0
    var loadStart = 0.0
    var baseLogged = false
    var editor: NoteWeb?
    var editing: Int?
    var editStart = 0.0
    var editHeight: CGFloat = 0
    var lastShown: CGImage?        // the bitmap the editor replaced, at the editor's scale (for the switch diff)
    var onPainted: ((Double) -> Void)?
    var onLeft: (() -> Void)?
    var shownReady: CheckedContinuation<Void, Never>?
    var shownDone = false
    var diffDir: String? = ProcessInfo.processInfo.environment["CANVAS_DIFFDIR"]
    var diffN = 0
    var snapMs: [Double] = []
    // Mode 5: while a gesture runs, the editor is replaced by a bitmap of itself (a native layer moving with the canvas)
    var frozen = false
    var still: IOSurface?
    var stillSize = CGSize.zero          // CSS px the still covers (card width × edit height)
    var stillScale: CGFloat = 0
    var stillDirty = false
    var stillTask: Task<Void, Never>?
    var thawing = false
    var svgView: NoteWeb?
    var onThawed: (() -> Void)?
    var freezeDiff: ((CGImage?) -> Void)?
    /// How the editor follows the camera's zoom: "pagezoom" (re-layout at every frame) or "magnify" (WebKit's
    /// magnification while moving, pageZoom once the gesture ends).
    var zoomMode = ProcessInfo.processInfo.environment["CANVAS_EDITZOOM"] ?? "level"
    var editZoom: CGFloat = 1
    let host = NSView()            // the editor sits in it; while zooming, its bounds scale the editor on the GPU
}

extension Canvas {
    var poolSize: Int { Int(ProcessInfo.processInfo.environment["CANVAS_WEBPOOL"] ?? "") ?? 3 }

    func isWebNote(_ i: Int) -> Bool {
        web.on && (mode == 1 || mode == 2 || mode == 5) && (board.cards[i].kind == .note || board.cards[i].kind == .frameless)
    }

    func setUpWeb() {
        guard web.pool.isEmpty, let container = superview else { return }
        for _ in 0..<poolSize {
            let w = NoteWeb(vault: vault)
            container.addSubview(w.view, positioned: .below, relativeTo: self)  // behind the opaque canvas: painted, unseen
            web.pool.append(w)
            web.tails.append(nil)
        }
        prepareEditor()
    }

    /// One editor web view kept loaded and warmed, above the canvas but transparent until an edit shows it.
    func prepareEditor() {
        guard let container = superview else { return }
        let e = NoteWeb(vault: vault, focusable: true)
        e.view.alphaValue = 0
        e.view.frame = CGRect(x: -4000, y: -4000, width: 400, height: 300)
        attachEditor(e, container)
        e.onMessage = { [weak self] m in self?.editorMessage(m) }
        web.editor = e
        Task { @MainActor in await e.call("return cb.warm()") }
    }

    /// Serialises work per web view; card i always goes to the same view, so a zoom re-snapshot needs no re-render.
    func onView(_ k: Int, _ work: @escaping @MainActor (NoteWeb) async -> Void) {
        let prev = web.tails[k]
        let v = web.pool[k]
        web.tails[k] = Task { @MainActor in
            await prev?.value
            await work(v)
        }
    }

    /// A snapshot of card i at `scale` device px per CSS px, as an IOSurface, then `done` on the main thread.
    func webSnapshot(_ i: Int, scale: CGFloat, done: @escaping (IOSurface?, Double) -> Void) {
        let c = board.cards[i]
        web.pending += 1
        onView(i % web.pool.count) { [weak self] v in
            let t0 = CACurrentMediaTime()
            let (img, _, _) = await v.snapshot(src: c.body, width: c.rect.width, height: c.rect.height, card: c.kind == .note, scale: scale,
                                               viaEditor: self?.mode == 5)
            let surf: IOSurface? = await Task.detached { img.flatMap { Canvas.surface(from: $0) } }.value
            let ms = (CACurrentMediaTime() - t0) * 1000
            guard let self else { return }
            self.web.pending -= 1
            self.web.snapMs.append(ms)
            done(surf, ms)
        }
    }

    nonisolated static func surface(from img: CGImage) -> IOSurface? {
        guard let s = Render.surface(width: img.width, height: img.height) else { return nil }
        Render.withContext(s) { ctx in
            ctx.clear(CGRect(x: 0, y: 0, width: img.width, height: img.height))
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
        }
        return s
    }

    /// Card layer look for web notes: the snapshot has the paper; the frame is the layer's own border and corners.
    /// In web display the Note's images are inside its snapshot, so the native image layers of web Notes are hidden.
    func updateSlotVisibility() {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        // web Notes have their pictures in the snapshot; mode 5 draws every picture into its card's bitmap
        for sl in slots where sl.card >= 0 { sl.layer.isHidden = isWebNote(sl.card) || mode == 5 }
        CATransaction.commit()
        computeVisible()
    }

    func styleWebLayers() {
        updateSlotVisibility()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for (i, l) in cardLayers.enumerated() {
            let webNote = isWebNote(i) && board.cards[i].kind == .note
            l.cornerRadius = webNote ? 7 : 0
            l.masksToBounds = webNote
            l.borderWidth = webNote ? 1 : 0
            l.borderColor = webNote ? Render.hairline : nil
        }
        CATransaction.commit()
    }

    /// Base snapshots (fit zoom) for every Note; until a Note has one it shows its CoreText bitmap.
    func loadWebBase() {
        web.base = board.cards.map { _ in nil }
        web.baseScale = baseScale
        web.loadStart = CACurrentMediaTime()
        web.baseLogged = false
        web.snapMs = []
        styleWebLayers()
        guard web.on else { return }
        setUpWeb()
        let gen = generation
        let notes = board.cards.indices.filter { isWebNote($0) }
        // visible ones first
        let order = notes.filter { visible.contains($0) } + notes.filter { !visible.contains($0) }
        for i in order {
            webSnapshot(i, scale: baseScale[i]) { [weak self] s, _ in
                guard let self, self.generation == gen || self.web.base.count == self.board.cards.count, let s else { return }
                self.web.base[i] = s
                if self.rasterScale[i] <= self.baseScale[i] && !self.inFlight[i] {
                    CATransaction.begin(); CATransaction.setDisableActions(true)
                    self.cardLayers[i].contents = s
                    CATransaction.commit()
                }
                if !self.web.baseLogged && notes.allSatisfy({ self.web.base[$0] != nil }) {
                    self.web.baseLogged = true
                    let ms = self.web.snapMs
                    Log.write(String(format: "web-base board=%@ notes=%d pool=%d all_ready=%.0fms snap_p50=%.1fms snap_max=%.1fms",
                                     (self.board.path as NSString).lastPathComponent, notes.count, self.web.pool.count,
                                     (CACurrentMediaTime() - self.web.loadStart) * 1000, GestureStats.pct(ms, 0.5), ms.max() ?? 0))
                    if ProcessInfo.processInfo.environment["CANVAS_LOADONLY"] != nil {
                        Log.write("web-mem views=\(self.web.pool.count + 1) web=\(self.webFootprint() / 1_000_000)MB")
                        NSApp.terminate(nil)
                    }
                }
            }
        }
    }

    func webBaseContents(_ i: Int) -> Any? {
        if levelMode, let p = lv.pictureBase[i] { return p }
        return isWebNote(i) ? (web.base[safe: i] ?? nil) ?? baseImage[i] : baseImage[i]
    }

    // MARK: editing

    func card(at p: CGPoint) -> Int? {
        let b = boardPoint(p)
        return board.cards.indices.last { board.cards[$0].rect.contains(b) }
    }

    /// The card's rectangle in the container's coordinates (y up), at the current camera.
    func screenRect(_ i: Int, height: CGFloat? = nil) -> CGRect {
        let r = board.cards[i].rect
        let h = height ?? r.height
        let local = CGRect(x: (r.minX - camX) * z, y: bounds.height - (r.minY - camY) * z - h * z, width: r.width * z, height: h * z)
        return convert(local, to: superview)
    }

    func beginEdit(_ i: Int, cold: Bool = false, at local: CGPoint? = nil) {
        guard isWebNote(i), web.editing == nil else { return }
        if cold || web.editor == nil {
            web.editor?.view.removeFromSuperview()
            prepareEditorCold()
        }
        guard let e = web.editor else { return }
        let c = board.cards[i]
        if mode == 5 { snapCamera(to: i) }
        web.editing = i
        hideExact(i)  // its exact bitmap would be stale when the edit ends
        web.editStart = CACurrentMediaTime()
        web.editHeight = c.rect.height
        settleEditorZoom()
        // the bitmap now on screen, at the editor's scale, to compare with the editor once it has painted
        let scale = z * backing
        web.shownDone = false
        web.lastShown = nil
        webSnapshot(i, scale: scale) { [weak self] s, _ in
            guard let self else { return }
            defer { self.web.shownDone = true; self.web.shownReady?.resume(); self.web.shownReady = nil }
            self.web.lastShown = s.flatMap { surf in Canvas.image(from: surf) }
            if let s {  // and show exactly that bitmap, so the diff is against what the user sees
                CATransaction.begin(); CATransaction.setDisableActions(true)
                self.cardLayers[i].contents = s
                CATransaction.commit()
                self.rasterScale[i] = scale
            }
        }
        var args: [String: Any] = ["src": c.body, "width": Double(c.rect.width), "card": c.kind == .note]
        if let p = local { args["x"] = Double(p.x); args["y"] = Double(p.y) }
        args["scale"] = web.zoomMode == "transform" ? Double(z) : web.zoomMode == "level" ? Double(editLevel) : 1.0
        web.editZoom = z
        Task { @MainActor in await e.call("return await cb.edit(src, width, card, x, y, scale)", args.merging(["x": NSNull(), "y": NSNull()]) { a, _ in a }) }
    }

    func prepareEditorCold() {
        guard let container = superview else { return }
        let e = NoteWeb(vault: vault, focusable: true)
        e.view.alphaValue = 0
        attachEditor(e, container)
        e.onMessage = { [weak self] m in self?.editorMessage(m) }
        web.editor = e
    }

    func attachEditor(_ e: NoteWeb, _ container: NSView) {
        if web.zoomMode == "scale" || web.zoomMode == "level" {
            web.host.wantsLayer = true
            if web.host.superview == nil { container.addSubview(web.host, positioned: .above, relativeTo: self) }
            web.host.addSubview(e.view)
        } else {
            container.addSubview(e.view, positioned: .above, relativeTo: self)
        }
    }

    /// "level": the editor draws at the level the display bitmaps hold (a whole scale, 100 % or 200 % here) and its
    /// host view is scaled down to the canvas zoom by the GPU, exactly as the display bitmap is.
    var editLevel: CGFloat { shownLevel }

    /// WebKit's tile layers shrink with linear filtering; the display bitmaps use mipmaps (trilinear). Same filter on
    /// both, so shrinking the level-drawn editor looks like shrinking the display bitmap.
    func trilinearEditor(_ e: NoteWeb) {
        guard ProcessInfo.processInfo.environment["CANVAS_EDITFILTER"] == "trilinear" else { return }
        func walk(_ l: CALayer) { l.minificationFilter = .trilinear; l.sublayers?.forEach(walk) }
        if let l = e.view.layer { walk(l) }
    }

    /// Moves the camera by under half a device pixel so card i's top-left corner falls on a whole device pixel: the
    /// card bitmap and the editor's view are then both drawn without a sub-pixel offset, and match exactly.
    func snapCamera(to i: Int) {
        if ProcessInfo.processInfo.environment["CANVAS_NOSNAP"] != nil || Canvas.restExact { return }
        let r = board.cards[i].rect, s = z * backing
        camX = r.minX - ((r.minX - camX) * s).rounded() / s
        camY = r.minY - ((r.minY - camY) * s).rounded() / s
        applyCamera()
    }

    func placeLevelEditor(_ i: Int, _ e: NoteWeb) {
        let L = editLevel
        let w = board.cards[i].rect.width, h = web.editHeight
        var hf = screenRect(i, height: h)
        if Canvas.restExact {
            // the corner on a whole device pixel, as the card's rest bitmap (top edge, y up in the container)
            let b = backing
            let top = ((hf.maxY) * b).rounded() / b
            hf.origin.x = (hf.minX * b).rounded() / b
            hf.origin.y = top - hf.height
        }
        web.host.frame = hf
        web.host.bounds = CGRect(x: 0, y: 0, width: w * L, height: h * L)
        e.view.frame = CGRect(x: 0, y: 0, width: w * L, height: h * L)
        if web.editZoom != L {
            web.editZoom = L
            e.view.evaluateJavaScript("cb.setScale(\(Double(L)))")
        }
    }

    func placeEditor() {
        guard let i = web.editing, let e = web.editor else { return }
        if web.zoomMode == "level" { if e.view.pageZoom != 1 { e.view.pageZoom = 1 }; placeLevelEditor(i, e); return }
        if web.zoomMode == "transform" {
            // 100 % layout always, like the snapshots; the page scales the Note (CSS transform) to the camera's zoom
            if e.view.pageZoom != 1 { e.view.pageZoom = 1 }
            e.view.frame = screenRect(i, height: web.editHeight)
            if web.editZoom != z {
                web.editZoom = z
                e.view.evaluateJavaScript("cb.setScale(\(Double(z)))")
            }
            return
        }
        if web.zoomMode == "scale" && gesture != nil && gesture?.motionEnd == nil && abs(z - web.editZoom) > 1e-6 {
            let r = screenRect(i, height: web.editHeight)
            web.host.frame = r
            web.host.bounds = CGRect(x: 0, y: 0, width: r.width * web.editZoom / z, height: r.height * web.editZoom / z)
        } else if web.zoomMode == "magnify" && gesture != nil && gesture?.motionEnd == nil {
            e.view.frame = screenRect(i, height: web.editHeight)
            e.view.setMagnification(z / web.editZoom, centeredAt: .zero)
        } else {
            settleEditorZoom()
        }
    }

    /// pageZoom at the camera's zoom, magnification back to 1: sharp text, same CSS width, so no reflow.
    func settleEditorZoom() {
        guard let i = web.editing, let e = web.editor else { return }
        if web.zoomMode == "transform" || web.zoomMode == "level" { web.editZoom = -1; placeEditor(); return }
        if e.view.magnification != 1 { e.view.setMagnification(1, centeredAt: .zero) }
        if e.view.pageZoom != z { e.view.pageZoom = z }
        web.editZoom = z
        let r = screenRect(i, height: web.editHeight)
        if web.zoomMode == "scale" {
            web.host.frame = r
            web.host.bounds = CGRect(origin: .zero, size: r.size)
            e.view.frame = CGRect(origin: .zero, size: r.size)
        } else {
            e.view.frame = r
        }
    }

    func editorMessage(_ m: [String: Any]) {
        guard let i = web.editing, let e = web.editor else { return }
        if m["painted"] != nil {
            let ms = (CACurrentMediaTime() - web.editStart) * 1000
            if let h = m["height"] as? Double { web.editHeight = max(board.cards[i].rect.height, CGFloat(h)) }
            placeEditor()
            Task { @MainActor in
                // compare what the editor painted with the bitmap it replaces, before showing it
                let size = board.cards[i].rect.size
                if !web.shownDone { await withCheckedContinuation { web.shownReady = $0 } }
                if ProcessInfo.processInfo.environment["CANVAS_DEBUGJS"] != nil {
                    let info = await e.call("const n = document.getElementById('note'); return [n.style.transform, n.getBoundingClientRect().width, n.offsetWidth, window.innerWidth, n.className].join(' | ')")
                    Log.write("debug editor note: \(info ?? "nil") view=\(e.view.frame.size) pageZoom=\(e.view.pageZoom)")
                }
                let pz = web.zoomMode == "transform" ? z : web.zoomMode == "level" ? editLevel : e.view.pageZoom
                if let shown = web.lastShown, let live = await e.take(width: size.width * pz, height: size.height * pz, scale: backing) {
                    Log.write("switch-in " + imageDiff(shown, live).summary + String(format: " zoom=%.2f", z))
                    if let d = web.diffDir { web.diffN += 1; saveImage(shown, "\(d)/in\(web.diffN)-shown.png"); saveImage(live, "\(d)/in\(web.diffN)-editor.png") }
                }
                CATransaction.begin(); CATransaction.setDisableActions(true)
                if web.zoomMode == "level" { trilinearEditor(e) }
                e.view.alphaValue = 1
                cardLayers[i].isHidden = true
                CATransaction.commit()
                window?.makeFirstResponder(e.view)
                (e.view as? EditorWebView)?.holdFocus = true
                if mode == 5 { refreshStill() }
                Log.write(String(format: "edit-open card=%d ready=%.0fms js_mount=%.0fms", i, ms, (m["ms"] as? Double) ?? 0))
                web.onPainted?(ms)
            }
        } else if m["changed"] != nil {
            if mode == 5 { refreshStill() }
        } else if let h = m["height"] as? Double, m["painted"] == nil, m["leave"] == nil {
            web.editHeight = max(board.cards[i].rect.height, CGFloat(h))
            if !(mode == 5 && web.frozen) { placeEditor() }
            if mode == 5 { refreshStill() }
        } else if m["leave"] != nil {
            leaveEdit(value: m["value"] as? String)
        }
    }

    /// Leaving: snapshot the editor's last picture, render the static Note, show its bitmap, then remove the editor.
    func leaveEdit(value: String?) {
        guard let i = web.editing, let e = web.editor else { return }
        if let v = value, v != board.cards[i].body { board.cards[i].setBody(v) }
        let scale = z * backing
        let size = board.cards[i].rect.size
        Task { @MainActor in
            let pz = web.zoomMode == "transform" ? z : web.zoomMode == "level" ? self.editLevel : e.view.pageZoom
            let live = await e.take(width: size.width * pz, height: size.height * pz, scale: backing)
            webSnapshot(i, scale: scale) { [weak self] s, _ in
                guard let self else { return }
                if let live, let s, let still = Canvas.image(from: s) {
                    Log.write("switch-out " + imageDiff(live, still).summary + String(format: " zoom=%.2f", self.z))
                    if let d = self.web.diffDir { saveImage(live, "\(d)/out\(self.web.diffN)-editor.png"); saveImage(still, "\(d)/out\(self.web.diffN)-shown.png") }
                }
                CATransaction.begin(); CATransaction.setDisableActions(true)
                if let s { self.cardLayers[i].contents = s; self.rasterScale[i] = scale }
                self.cardLayers[i].isHidden = false
                e.view.alphaValue = 0
                CATransaction.commit()
                e.view.frame = CGRect(x: -4000, y: -4000, width: 400, height: 300)
                (e.view as? EditorWebView)?.holdFocus = false
                self.web.editing = nil
                self.web.frozen = false
                self.web.still = nil
                self.cardLayers[i].frame = CGRect(x: self.board.cards[i].rect.minX, y: -self.board.cards[i].rect.maxY,
                                                  width: self.board.cards[i].rect.width, height: self.board.cards[i].rect.height)
                self.window?.makeFirstResponder(self)
                Task { @MainActor in await e.call("return cb.finish()") }
                self.web.onLeft?()
            }
        }
    }

    nonisolated static func image(from s: IOSurface) -> CGImage? {
        s.lock(options: .readOnly, seed: nil)
        defer { s.unlock(options: .readOnly, seed: nil) }
        guard let ctx = CGContext(data: s.baseAddress, width: s.width, height: s.height, bitsPerComponent: 8, bytesPerRow: s.bytesPerRow,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        return ctx.makeImage()
    }

    /// Memory of the web content processes.
    func webFootprint() -> Int {
        (web.pool + [web.editor, web.svgView].compactMap { $0 }).reduce(0) { $0 + footprint(of: $1.webPID) }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

/// How two pictures of the same card differ: pixels off by more than 24 levels, the largest difference, and the shift
/// (within ±4 px) that matches them best, from a central crop.
struct ImageDiff {
    var w = 0, h = 0, differ = 0, maxd = 0, shiftX = 0, shiftY = 0, sizeMismatch = false
    var meanZero = 0.0, meanBest = 0.0
    var summary: String {
        sizeMismatch ? "diff size_mismatch" :
            String(format: "diff %dx%d differ(>24)=%d (%.3f%%) max=%d best_shift=(%d,%d) mean_abs=%.2f→%.2f",
                   w, h, differ, Double(differ) / Double(max(1, w * h)) * 100, maxd, shiftX, shiftY, meanZero, meanBest)
    }
}

func pixels(_ img: CGImage) -> [UInt8] {
    var px = [UInt8](repeating: 0, count: img.width * img.height * 4)
    px.withUnsafeMutableBytes { buf in
        let ctx = CGContext(data: buf.baseAddress, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: img.width * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        ctx?.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
    }
    return px
}

func imageDiff(_ a: CGImage, _ b: CGImage) -> ImageDiff {
    var d = ImageDiff()
    guard a.width == b.width, abs(a.height - b.height) <= 2 else { d.sizeMismatch = true; return d }
    let w = a.width, h = min(a.height, b.height)
    d.w = w; d.h = h
    let pa = pixels(a), pb = pixels(b)
    var sum = 0
    for y in 0..<h {
        for x in 0..<w {
            let i = (y * w + x) * 4
            var m = 0
            for k in 0..<3 { m = max(m, abs(Int(pa[i + k]) - Int(pb[i + k]))) }
            sum += m
            if m > 24 { d.differ += 1 }
            d.maxd = max(d.maxd, m)
        }
    }
    d.meanZero = Double(sum) / Double(w * h)
    // best shift on a central crop
    let cw = min(w - 16, 600), ch = min(h - 16, 600), x0 = (w - cw) / 2, y0 = (h - ch) / 2
    var best = Double.infinity
    for sy in -4...4 { for sx in -4...4 {
        var s = 0
        for y in stride(from: y0, to: y0 + ch, by: 2) { for x in stride(from: x0, to: x0 + cw, by: 2) {
            let i = (y * w + x) * 4, j = ((y + sy) * w + (x + sx)) * 4
            s += abs(Int(pa[i + 1]) - Int(pb[j + 1]))
        } }
        let m = Double(s) / Double((cw / 2) * (ch / 2))
        if m < best { best = m; d.shiftX = sx; d.shiftY = sy }
    } }
    d.meanBest = best
    return d
}

extension Canvas {
    /// Runs `step(t)` once per display frame until it returns false.
    func drive(_ step: @escaping (Double) -> Bool) async {
        await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
            let start = CACurrentMediaTime()
            driver = { now in
                if step(now - start) { return true }
                k.resume()
                return false
            }
        }
    }

    func sleep(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1e9)) }

    func editOnce(_ i: Int, cold: Bool) async -> Double {
        let ms: Double = await withCheckedContinuation { k in
            web.onPainted = { ms in k.resume(returning: ms) }
            beginEdit(i, cold: cold)
        }
        web.onPainted = nil
        return ms
    }

    func leaveOnce() async {
        guard let e = web.editor else { return }
        let v = await e.call("return cb.value()") as? String
        await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
            web.onLeft = { k.resume() }
            leaveEdit(value: v)
        }
        web.onLeft = nil
    }

    /// The scripted edit experiment on the longest Note of the board.
    func editTest() async {
        while web.pending > 0 || !web.baseLogged { await sleep(0.1) }
        let notes = board.cards.indices.filter { isWebNote($0) && board.cards[$0].kind == .note }
        guard let i = notes.max(by: { board.cards[$0].body.count < board.cards[$1].body.count }) else { return }
        // also the longest Note without tables or <br>, to tell the package's differences from the mechanism's
        if let plain = notes.filter({ !board.cards[$0].body.contains("|") && !board.cards[$0].body.contains("<br") })
            .max(by: { board.cards[$0].body.count < board.cards[$1].body.count }) {
            let pr = board.cards[plain].rect
            for zoom: CGFloat in [1.0, 1.37, 2.0] {
                z = zoom; camX = pr.minX - 40 / z; camY = pr.minY - 40 / z; applyCamera(); resetRasters()
                while web.pending > 0 { await sleep(0.05) }
                await sleep(0.3)
                Log.write(String(format: "edittest plain-note card=%d chars=%d zoom=%.2f", plain, board.cards[plain].body.count, zoom))
                _ = await editOnce(plain, cold: false)
                await sleep(0.3)
                await leaveOnce()
                await sleep(0.3)
            }
        }
        let r = board.cards[i].rect
        func look(at zoom: CGFloat) {
            z = zoom
            camX = r.minX - 40 / z
            camY = r.minY - 40 / z
            applyCamera()
            resetRasters()
        }
        Log.write("edittest zoom_follow=\(web.zoomMode) table-note card=\(i) size=\(Int(r.width))x\(Int(r.height)) chars=\(board.cards[i].body.count)")
        for zoom: CGFloat in [1.0, 1.37, 2.0] {
            look(at: zoom)
            while web.pending > 0 { await sleep(0.05) }
            await sleep(0.3)
            let ms = await editOnce(i, cold: false)
            Log.write(String(format: "edittest warm zoom=%.2f open=%.0fms", zoom, ms))
            await sleep(0.3)
            await leaveOnce()
            await sleep(0.3)
        }
        look(at: 1.0)
        await sleep(0.3)
        let cold = await editOnce(i, cold: true)
        Log.write(String(format: "edittest cold open=%.0fms (new web view: page load, editor load, mount)", cold))
        await sleep(0.5)
        // typing at the end of the long Note
        if let e = web.editor {
            await e.call("cb.placeCaretEnd(); return true")
            let t = await e.call("return await cb.typeTimed(text)", ["text": " typing latency test, forty characters."]) as? [String: Any]
            Log.write("edittest typing key_to_next_frame p50=\(t?["p50"] ?? "?")ms max=\(t?["max"] ?? "?")ms (in the page, scripted keys)")
        }
        // pan and zoom while editing: a gesture each
        pendingLabel = "edit-pan"
        let x0 = camX
        await drive { [self] t in
            camX = x0 + CGFloat(t) * 800 / z
            cameraMoved()
            return t < 1.5
        }
        await sleep(0.6)
        pendingLabel = "edit-zoom"
        let z0 = z
        await drive { [self] t in
            let p = min(t / 1.5, 1)
            zoom(by: (z0 * pow(2.0 / z0, CGFloat(p))) / z, at: CGPoint(x: bounds.width / 3, y: bounds.height / 2))
            return p < 1
        }
        await sleep(0.6)
        Log.write("edittest web_mem=\(webFootprint() / 1_000_000)MB views=\(web.pool.count + 1) app=\(physFootprint() / 1_000_000)MB")
        await leaveOnce()
        await sleep(0.3)
        NSApp.terminate(nil)
    }
}

extension Canvas {
    /// Keeps a bitmap of the live editor as it looks now (at rest, debounced after each change), ready for a freeze.
    func refreshStill() {
        guard web.editing != nil, !web.frozen else { return }
        web.stillDirty = true
        web.stillTask?.cancel()
        web.stillTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 40_000_000)
            guard !Task.isCancelled, let i = web.editing, let e = web.editor, !web.frozen, lv.resting else { return }
            let size = CGSize(width: board.cards[i].rect.width, height: web.editHeight)
            let zoom = z
            let k = web.zoomMode == "level" ? editLevel : zoom   // the scale the editor draws at
            guard let img = await e.take(width: size.width * k, height: size.height * k, scale: backing),
                  web.editing == i, !web.frozen, z == zoom else { return }
            web.still = await Task.detached { Canvas.surface(from: img) }.value
            web.stillSize = size
            web.stillScale = k * backing
            web.stillDirty = false
        }
    }

    /// How the live editor is hidden while frozen (CANVAS_HIDEMODE: alpha, layer, none; for finding what blurs the page).
    func setEditorHidden(_ e: NoteWeb, _ hidden: Bool) {
        switch ProcessInfo.processInfo.environment["CANVAS_HIDEMODE"] ?? "alpha" {
        case "layer": e.view.layer?.opacity = hidden ? 0 : 1
        case "none": break
        default: e.view.alphaValue = hidden ? 0 : 1
        }
    }

    /// Gesture start while editing: the card layer shows the editor's still and the live editor hides, in the same
    /// transaction, so the switch happens within one frame of our own layers.
    func freezeEditor() {
        guard let i = web.editing, let e = web.editor, !web.frozen else { return }
        web.stillTask?.cancel()
        guard let still = web.still else {
            Log.write("freeze: no still yet; the live editor stays")
            return
        }
        let r = board.cards[i].rect
        web.freezeDiff?(Canvas.image(from: still))
        CATransaction.begin(); CATransaction.setDisableActions(true)
        cardLayers[i].frame = CGRect(x: r.minX, y: -(r.minY + web.stillSize.height), width: r.width, height: web.stillSize.height)
        cardLayers[i].contents = still
        cardLayers[i].isHidden = false
        setEditorHidden(e, true)
        CATransaction.commit()
        rasterScale[i] = web.stillScale
        web.frozen = true
        // The editor keeps first responder (and so its page focus); keys and clicks during the gesture are dropped by the
        // app's event monitor instead. Taking focus away and giving it back left the page unfocused after the thaw.
        e.view.evaluateJavaScript("cb.saveSel()")
        if web.stillDirty { Log.write("freeze: still was older than the last change") }
    }

    /// Rest: the live editor at the new place and scale; it is shown once it has painted there, caret and selection
    /// untouched (the page is never re-rendered). Stays frozen while the Note is off screen.
    func thawEditor() {
        guard let i = web.editing, let e = web.editor, web.frozen, !web.thawing else { return }
        let view = CGRect(x: camX, y: camY, width: bounds.width / z, height: bounds.height / z)
        guard board.cards[i].rect.intersects(view) else { return }
        web.thawing = true
        let gen = lv.gen
        Task { @MainActor in
            if web.zoomMode == "level" {
                let L = editLevel
                web.editZoom = -1
                placeLevelEditor(i, e)
                await e.call("return await cb.setScaleSettled(s)", ["s": Double(L)])
            } else {
                e.view.frame = screenRect(i, height: web.editHeight)
                web.editZoom = z
                await e.call("return await cb.setScaleSettled(s)", ["s": Double(z)])
            }
            web.thawing = false
            guard lv.gen == gen, lv.resting, web.editing == i, web.frozen else { return }
            CATransaction.begin(); CATransaction.setDisableActions(true)
            if web.zoomMode == "level" { trilinearEditor(e) }
            setEditorHidden(e, false)
            cardLayers[i].isHidden = true
            CATransaction.commit()
            web.frozen = false
            if window?.firstResponder !== e.view { window?.makeFirstResponder(e.view) }
            await e.call("return cb.restoreSel()")
            web.onThawed?()
            refreshStill()
        }
    }

    /// SVG files drawn by WebKit (for the native image layers), one view kept for it.
    func setUpSVG() {
        guard web.svgView == nil, let container = superview else { return }
        let v = NoteWeb(vault: vault)
        container.addSubview(v.view, positioned: .below, relativeTo: self)
        web.svgView = v
        ImageStore.svgRaster = { [weak self] path, size, width in
            guard let self, let v = self.web.svgView else { return nil }
            let w = max(size.width, 1), h = max(size.height, 1)
            if v.view.frame.width != ceil(w) || v.view.frame.height < ceil(h) { v.view.setFrameSize(CGSize(width: ceil(w), height: ceil(h))) }
            v.rendered = nil
            _ = await v.call("return await cb.renderImage(src, w, h)", ["src": URL(fileURLWithPath: path).absoluteString, "w": Double(w), "h": Double(h)])
            return await v.take(width: w, height: h, scale: CGFloat(width) / w)
        }
    }
}

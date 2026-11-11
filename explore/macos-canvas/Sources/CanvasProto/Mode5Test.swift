import AppKit

/// Scripted checks for mode 5: where gestures go while editing, whether the freeze and the thaw of the editor can be
/// seen, and what the levels cost in memory at 25 / 50 / 100 / 200 %.
extension Canvas {
    nonisolated(unsafe) static var routeGestures = true

    func waitIdle(_ max: Double = 8) async {
        let t0 = CACurrentMediaTime()
        while CACurrentMediaTime() - t0 < max && (levelBusy || web.pending > 0 || !lv.resting) { await sleep(0.05) }
        await sleep(0.15)
    }

    /// A trackpad-like scroll event at a point of the view, sent through the application (so event monitors apply).
    func syntheticScroll(at p: CGPoint, dy: Int32) {
        guard let w = window, let screen = w.screen ?? NSScreen.main else { return }
        let inWindow = convert(p, to: nil)
        let onScreen = w.convertPoint(toScreen: inWindow)
        let mainH = NSScreen.screens.first?.frame.height ?? screen.frame.height
        guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0) else { return }
        cg.location = CGPoint(x: onScreen.x, y: mainH - onScreen.y)
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w.windowNumber))
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(w.windowNumber))
        cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        cg.postToPid(getpid())  // through the window server to this app, as a real trackpad event arrives
    }

    func scaled(_ img: CGImage, to w: Int, _ h: Int) -> CGImage? {
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
        ctx.interpolationQuality = .medium  // close to the GPU's linear filtering
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }

    func mode5Test() async {
        mode = 5
        await waitIdle()
        let name = (board.path as NSString).lastPathComponent
        // 1. memory at the levels
        for zoom: CGFloat in ProcessInfo.processInfo.environment["CANVAS_SKIPMEM"] != nil ? [] : [0.25, 0.5, 1, 2] {
            z = max(zoom, fitZoom * 0.5)
            let b = board.bounds
            camX = b.midX - bounds.width / 2 / z; camY = b.midY - bounds.height / 2 / z
            applyCamera()
            levelRest()
            await waitIdle(15)
            Log.write(String(format: "levels board=%@ notes=%@ zoom=%.2f level=%.1f visible=%d card_mem=%.0fMB img_mem=%.0fMB app=%.0fMB web=%.0fMB",
                             name, web.on ? "web" : "coretext", z, restLevel(z), visible.count, Double(cardMemory()) / 1e6,
                             Double(store.bytes) / 1e6, Double(physFootprint()) / 1e6, Double(webFootprint()) / 1e6))
        }
        guard web.on else { NSApp.terminate(nil); return }
        // 2. where gestures go while editing
        let notes = board.cards.indices.filter { isWebNote($0) && board.cards[$0].kind == .note }
        guard let i = notes.filter({ !board.cards[$0].body.contains("|") && !board.cards[$0].body.contains("<br") })
            .max(by: { board.cards[$0].body.count < board.cards[$1].body.count }) else { NSApp.terminate(nil); return }
        let r = board.cards[i].rect
        func look(at zoom: CGFloat) async {
            z = zoom; camX = r.minX - 40 / z; camY = r.minY - 40 / z
            applyCamera(); levelRest()
            await waitIdle()
        }
        await look(at: 1)
        _ = await editOnce(i, cold: false)
        await waitIdle()
        await sleep(0.3)
        let over = convert(screenRect(i).center, from: superview)
        let outside = CGPoint(x: bounds.width - 20, y: 20)
        for route in [false, true] {
            Canvas.routeGestures = route
            for (label, p) in [("over-editor", over), ("outside", outside)] {
                let x0 = camY
                let hit = window?.contentView?.hitTest(convert(p, to: superview))
                syntheticScroll(at: p, dy: -40)
                await sleep(0.4)
                Log.write(String(format: "route monitor=%@ %@ hit=%@ canvas_panned=%@", route ? "on" : "off", label,
                                 hit.map { String(describing: type(of: $0)) } ?? "nil", abs(camY - x0) > 0.01 ? "yes" : "no"))
                await waitIdle()
            }
        }
        Canvas.routeGestures = true
        // 3. freeze and thaw, at 100 / 137 / 200 %
        for zl: CGFloat in ProcessInfo.processInfo.environment["CANVAS_SKIPFREEZE"] != nil ? [] : [1, 1.37, 2] {
            if web.editing != nil { await leaveOnce() }
            await look(at: zl)
            _ = await editOnce(i, cold: false)
            await waitIdle()
            await sleep(0.4)
            guard let e = web.editor else { break }
            let size = CGSize(width: r.width, height: web.editHeight)
            let live = await e.take(width: size.width * z, height: size.height * z, scale: backing)
            var frozenImg: CGImage?
            web.freezeDiff = { frozenImg = $0 }
            // a pan gesture, then rest
            let y0 = camY
            await drive { [self] t in camY = y0 + CGFloat(t) * 300 / z; cameraMoved(); return t < 0.4 }
            web.freezeDiff = nil
            if let a = live, let b = frozenImg { Log.write(String(format: "freeze zoom=%.2f ", zl) + imageDiff(a, b).summary) }
            else { Log.write("freeze zoom=\(zl) no still") }
            let shown = web.still.flatMap { Canvas.image(from: $0) }
            await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
                web.onThawed = { k.resume() }
                if !web.frozen { k.resume() }
            }
            web.onThawed = nil
            let after = await e.take(width: size.width * z, height: size.height * z, scale: backing)
            if let a = shown, let b = after { Log.write(String(format: "thaw-after-pan zoom=%.2f ", zl) + imageDiff(a, b).summary) }
            // a zoom gesture: the still was drawn at the old zoom, the GPU scaled it; the editor comes back sharp
            await sleep(0.3)
            let z0 = z, z1 = min(z * 1.4, maxZoom)
            let stillBefore = web.still.flatMap { Canvas.image(from: $0) }
            await drive { [self] t in
                let p = min(t / 0.4, 1)
                zoom(by: (z0 * pow(z1 / z0, CGFloat(p))) / z, at: CGPoint(x: bounds.width / 2, y: bounds.height / 2))
                return p < 1
            }
            await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
                web.onThawed = { k.resume() }
                if !web.frozen { k.resume() }
            }
            web.onThawed = nil
            let size2 = CGSize(width: r.width, height: web.editHeight)
            if let s0 = stillBefore, let b = await e.take(width: size2.width * z, height: size2.height * z, scale: backing),
               let gpu = scaled(s0, to: b.width, b.height) {
                Log.write(String(format: "thaw-after-zoom %.2f→%.2f ", z0, z) + imageDiff(gpu, b).summary)
            }
        }
        if web.editing != nil { await leaveOnce() }
        NSApp.terminate(nil)
    }
}

extension CGRect { var center: CGPoint { CGPoint(x: midX, y: midY) } }

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

    func selectionInfo() async -> String {
        guard let e = web.editor else { return "no editor" }
        let r = await e.call("""
            const s = getSelection();
            const a = document.activeElement;
            return [s.rangeCount, s.anchorNode ? (s.anchorNode.nodeType === 3 ? 'text' : s.anchorNode.nodeName) : 'none', s.anchorOffset,
                    a ? a.tagName + '.' + (a.className || '').toString().slice(0, 30) : 'none', document.hasFocus()].join(' | ')
        """)
        let fr = window?.firstResponder
        let who = fr === web.editor?.view ? "editor" : web.pool.contains(where: { $0.view === fr }) ? "snapshot-view" : fr === web.svgView?.view ? "svg-view" : fr.map { String(describing: type(of: $0)) } ?? "nil"
        return "\(r ?? "nil") first_responder=\(who)"
    }

    /// Caret kept across a freeze and thaw: near pan, and far pan (the Note leaves the screen) and back.
    func caretTest() async {
        mode = 5
        await waitIdle()
        let notes = board.cards.indices.filter { isWebNote($0) && board.cards[$0].kind == .note }
        guard let i = notes.filter({ !board.cards[$0].body.contains("|") }).max(by: { board.cards[$0].body.count < board.cards[$1].body.count })
        else { NSApp.terminate(nil); return }
        let r = board.cards[i].rect
        z = 1; camX = r.minX - 40; camY = r.minY - 40; applyCamera(); levelRest()
        await waitIdle()
        // edit with the caret placed in the middle of the first lines
        let ms: Double = await withCheckedContinuation { k in
            web.onPainted = { k.resume(returning: $0) }
            beginEdit(i, at: CGPoint(x: r.width * 0.5, y: 40))
        }
        web.onPainted = nil
        await sleep(0.5)
        Log.write("caret opened (\(Int(ms)) ms): " + (await selectionInfo()))
        if ProcessInfo.processInfo.environment["CANVAS_FOCUSPROBE"] != nil, let e = web.editor {
            func f() async -> String { (await e.call("return String(document.hasFocus())") as? String) ?? "?" }
            Log.write("probe idle 0s focus=\(await f())"); await sleep(1)
            Log.write("probe idle 1s focus=\(await f())")
            _ = await e.take(width: 100, height: 100, scale: 2)
            Log.write("probe after takeSnapshot focus=\(await f())")
            var fr = e.view.frame; fr.origin.x += 10; e.view.frame = fr
            await sleep(0.3)
            Log.write("probe after frame change focus=\(await f())")
            await e.call("return await cb.setScaleSettled(s)", ["s": 1.0])
            Log.write("probe after setScale focus=\(await f())")
            window?.makeFirstResponder(self); await sleep(0.3)
            Log.write("probe after resign focus=\(await f())")
            window?.makeFirstResponder(e.view); await sleep(0.3)
            Log.write("probe after makeFirstResponder(editor) focus=\(await f())")
            await e.call("return cb.restoreSel()"); await sleep(0.2)
            Log.write("probe after restoreSel focus=\(await f())")
            NSApp.terminate(nil); return
        }
        func key() async -> String { (await web.editor?.call("return cb.selKey()") as? String) ?? "nil" }
        var ok = 0, total = 0
        for selectSpan in [false, true] {
            if selectSpan { await web.editor?.call("return cb.selectSome()"); await sleep(0.2) }
            // distances: within the view, beyond the inner ring, beyond the outer ring
            for (label, dist) in [("near", CGFloat(200)), ("beyond-inner", bounds.height * 1.5 / z + r.height),
                                  ("beyond-outer", bounds.height * 4 / z + r.height)] {
                let before = await key()
                let y0 = camY
                await drive { [self] t in camY = y0 + dist * CGFloat(min(t / 0.4, 1)); cameraMoved(); return t < 0.4 }
                await waitIdle(); await sleep(0.3)
                let away = web.frozen
                await drive { [self] t in camY = y0 + dist * CGFloat(1 - min(t / 0.4, 1)); cameraMoved(); return t < 0.4 }
                await waitIdle(); await sleep(0.5)
                let after = await key()
                let same = before.replacingOccurrences(of: " focus=true", with: "").replacingOccurrences(of: " focus=false", with: "")
                    == after.replacingOccurrences(of: " focus=true", with: "").replacingOccurrences(of: " focus=false", with: "")
                total += 1; if same { ok += 1 }
                Log.write("caret \(selectSpan ? "span" : "caret") \(label) frozen_while_away=\(away) same=\(same) before=[\(before)] after=[\(after)] " + (await selectionInfo()).components(separatedBy: " first_responder=").last!)
            }
        }
        Log.write("caret summary \(ok)/\(total) identical")
        // typing after a far round trip: a real key event through the window, then where did it land?
        await web.editor?.call("const n = document.getElementById('note'); const t = document.createTreeWalker(n, NodeFilter.SHOW_TEXT).nextNode(); getSelection().setBaseAndExtent(t, 5, t, 5); return true")
        await sleep(0.2)
        let y0 = camY, dist = bounds.height * 4 / z + r.height
        await drive { [self] t in camY = y0 + dist * CGFloat(min(t / 0.4, 1)); cameraMoved(); return t < 0.4 }
        await waitIdle(); await sleep(0.3)
        await drive { [self] t in camY = y0 + dist * CGFloat(1 - min(t / 0.4, 1)); cameraMoved(); return t < 0.4 }
        await waitIdle(); await sleep(0.5)
        Log.write("typing: key window=\(window?.isKeyWindow ?? false) app active=\(NSApp.isActive) first responder=\(window?.firstResponder.map { String(describing: type(of: $0)) } ?? "nil")")
        if let w = window, let ev = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                     windowNumber: w.windowNumber, context: nil, characters: "Q", charactersIgnoringModifiers: "q", isARepeat: false, keyCode: 12) {
            w.sendEvent(ev)
            if let up = NSEvent.keyEvent(with: .keyUp, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                         windowNumber: w.windowNumber, context: nil, characters: "Q", charactersIgnoringModifiers: "q", isARepeat: false, keyCode: 12) { w.sendEvent(up) }
        }
        await sleep(0.5)
        let where_ = await web.editor?.call("const v = cb.value() || ''; const i = v.indexOf('Q'); return i < 0 ? 'not typed' : 'Q at ' + i + ' of ' + v.length") as? String
        Log.write("typing after far round trip: \(where_ ?? "nil") (caret was at offset 5 of the first text node) sel=\(await key())")
        NSApp.terminate(nil)
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

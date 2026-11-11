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
            Log.write(String(format: "levels board=%@ notes=%@ zoom=%.2f level=%.1f visible=%d card_mem=%.0fMB img_mem=%.0fMB pic_cache=%.0fMB app=%.0fMB web=%.0fMB",
                             name, web.on ? "web" : "coretext", z, restLevel(z), visible.count, Double(cardMemory()) / 1e6,
                             Double(store.bytes) / 1e6, Double(ImageCache.shared.bytes) / 1e6, Double(physFootprint()) / 1e6, Double(webFootprint()) / 1e6))
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

extension Canvas {
    /// The window as the window server composites it (own window: no screen-recording permission needed, if allowed).
    func windowImage() -> CGImage? {
        guard let w = window else { return nil }
        // Copied into our own bitmap at once: the returned image can be read lazily, after the screen has changed.
        guard let img = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(w.windowNumber), [.boundsIgnoreFraming, .bestResolution]),
              let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
        return ctx.makeImage()
    }

    func windowCaptureProbe(_ dir: String) async {
        await waitIdle()
        await sleep(1)
        Log.write("hud frame \(hud.frame) hidden=\(hud.isHidden) superlayer=\(hud.superlayer != nil) string chars=\(((hud.string as? String) ?? "").count) bounds=\(bounds)")
        if let img = windowImage() { saveImage(img, "\(dir)/window.png"); Log.write("window capture \(img.width)x\(img.height)") }
        else { Log.write("window capture failed") }
        NSApp.terminate(nil)
    }
}

/// Ink weight and sharpness of a grey crop: mean darkness (0–255) and mean gradient between neighbours.
func inkStats(_ img: CGImage) -> (ink: Double, grad: Double) {
    let px = pixels(img), w = img.width, h = img.height
    var ink = 0.0, grad = 0.0
    for y in 0..<h - 1 {
        for x in 0..<w - 1 {
            let i = (y * w + x) * 4
            let g = Double(px[i + 1]), r = Double(px[i + 4 + 1]), d = Double(px[i + w * 4 + 1])
            ink += 255 - g
            grad += abs(g - r) + abs(g - d)
        }
    }
    let n = Double((w - 1) * (h - 1))
    return (ink / n, grad / n)
}

extension Canvas {
    /// The part of the window capture where card i is (device pixels), shrunk by a margin so only the inside counts.
    func cardCrop(_ img: CGImage, _ i: Int, height: CGFloat? = nil) -> CGImage? {
        guard let w = window else { return nil }
        let r = screenRect(i, height: height)                     // container (content view) coordinates, y up
        let inWin = superview!.convert(r, to: nil)
        let s = CGFloat(img.width) / w.frame.width
        let top = (w.frame.height - inWin.maxY) * s
        var crop = CGRect(x: inWin.minX * s, y: top, width: inWin.width * s, height: inWin.height * s).insetBy(dx: 30 * s, dy: 30 * s)
        crop = crop.intersection(CGRect(x: 0, y: 0, width: img.width, height: img.height)).integral
        return img.cropping(to: crop)
    }

    /// Display vs edit, as composited on screen, at 100 / 137 / 200 %.
    func weightTest(_ dir: String) async {
        mode = 5
        await waitIdle()
        let notes = board.cards.indices.filter { isWebNote($0) && board.cards[$0].kind == .note }
        guard let i = notes.filter({ !board.cards[$0].body.contains("|") }).max(by: { board.cards[$0].body.count < board.cards[$1].body.count })
        else { NSApp.terminate(nil); return }
        let r = board.cards[i].rect
        let tag = ProcessInfo.processInfo.environment["CANVAS_WEIGHTTAG"] ?? "base"
        let zooms = (ProcessInfo.processInfo.environment["CANVAS_WEIGHTZOOMS"] ?? "1,1.37,2").split(separator: ",").compactMap { Double($0) }.map { CGFloat($0) }
        for zl: CGFloat in zooms {
            if web.editing != nil { await leaveOnce() }
            z = zl; camX = r.minX - 60 / z; camY = r.minY - 60 / z
            applyCamera(); levelRest()
            await waitIdle(); await sleep(0.6)
            if ProcessInfo.processInfo.environment["CANVAS_RESTLOG"] != nil { Log.write("display capture now (rest layer contents=\(lv.exactLayers[i]?.contents != nil))") }
            guard let shotA = windowImage(), let a = cardCrop(shotA, i) else { continue }
            _ = await withCheckedContinuation { (k: CheckedContinuation<Double, Never>) in
                web.onPainted = { k.resume(returning: $0) }
                beginEdit(i, at: CGPoint(x: r.width - 20, y: r.height - 20))
            }
            web.onPainted = nil
            await web.editor?.call("return cb.hideCaret(true)")
            await sleep(0.8)
            guard let shotB = windowImage(), let b = cardCrop(shotB, i) else { continue }
            let sa = inkStats(a), sb = inkStats(b)
            Log.write(String(format: "weight %@ zoom=%.2f display ink=%.2f grad=%.2f | edit ink=%.2f grad=%.2f | ", tag, zl, sa.ink, sa.grad, sb.ink, sb.grad)
                      + imageDiff(a, b).summary)
            saveImage(a, "\(dir)/w-\(tag)-\(zl)-display.png"); saveImage(b, "\(dir)/w-\(tag)-\(zl)-edit.png")
            await web.editor?.call("return cb.hideCaret(false)")
        }
        if web.editing != nil { await leaveOnce() }
        NSApp.terminate(nil)
    }
}

extension Canvas {
    /// Display vs edit after the edit was opened at 100 % and the canvas was zoomed to the target with a gesture
    /// (freeze, then thaw at the new scale).
    func weightAfterZoom(_ dir: String) async {
        mode = 5
        await waitIdle()
        let notes = board.cards.indices.filter { isWebNote($0) && board.cards[$0].kind == .note }
        guard let i = notes.filter({ !board.cards[$0].body.contains("|") }).max(by: { board.cards[$0].body.count < board.cards[$1].body.count })
        else { NSApp.terminate(nil); return }
        let r = board.cards[i].rect
        let zooms = (ProcessInfo.processInfo.environment["CANVAS_WEIGHTZOOMS"] ?? "1.37,1.95,2").split(separator: ",").compactMap { Double($0) }.map { CGFloat($0) }
        for zl in zooms {
            if web.editing != nil { await leaveOnce() }
            z = 1; camX = r.minX - 60; camY = r.minY - 60
            applyCamera(); levelRest(); await waitIdle(); await sleep(0.4)
            _ = await withCheckedContinuation { (k: CheckedContinuation<Double, Never>) in
                web.onPainted = { k.resume(returning: $0) }
                beginEdit(i, at: CGPoint(x: r.width - 20, y: r.height - 20))
            }
            web.onPainted = nil
            await web.editor?.call("return cb.hideCaret(true)")
            await sleep(0.5)
            // zoom about the card's top-left corner on screen, as a pinch would
            let anchor = convert(screenRect(i).origin, from: superview)
            let p0 = CGPoint(x: anchor.x + 60, y: bounds.height - 60)
            await drive { [self] t in
                let p = min(t / 0.5, 1)
                zoom(by: pow(zl, CGFloat(p)) / z, at: p0)
                return p < 1
            }
            await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
                web.onThawed = { k.resume() }
                if !web.frozen { k.resume() }
            }
            web.onThawed = nil
            await sleep(0.8)
            guard let shotB = windowImage(), let b = cardCrop(shotB, i) else { continue }
            await web.editor?.call("return cb.hideCaret(false)")
            await leaveOnce()
            levelRest(); await waitIdle(); await sleep(0.6)
            guard let shotA = windowImage(), let a = cardCrop(shotA, i) else { continue }
            let sa = inkStats(a), sb = inkStats(b)
            Log.write(String(format: "weight after-zoom 1.00→%.2f display ink=%.2f grad=%.2f | edit ink=%.2f grad=%.2f | ", z, sa.ink, sa.grad, sb.ink, sb.grad)
                      + imageDiff(a, b).summary)
            saveImage(a, "\(dir)/az-\(zl)-display.png"); saveImage(b, "\(dir)/az-\(zl)-edit.png")
        }
        NSApp.terminate(nil)
    }
}

extension Canvas {
    /// Cost of the edit and rest-bitmap setup: card memory at rest, time to an editable editor, typing, web memory.
    func costTest() async {
        mode = 5
        await waitIdle()
        let notes = board.cards.indices.filter { isWebNote($0) && board.cards[$0].kind == .note }
        guard let i = notes.filter({ !board.cards[$0].body.contains("|") }).max(by: { board.cards[$0].body.count < board.cards[$1].body.count })
        else { NSApp.terminate(nil); return }
        let r = board.cards[i].rect
        let tag = ProcessInfo.processInfo.environment["CANVAS_WEIGHTTAG"] ?? "cost"
        for zl: CGFloat in [0.6, 1.37, 1.95] {
            if web.editing != nil { await leaveOnce() }
            z = zl; camX = r.minX - 60 / z; camY = r.minY - 60 / z
            applyCamera(); levelRest()
            await waitIdle(); await sleep(0.5)
            let cardMem = cardMemory() + lv.exactLayers.values.reduce(0) { $0 + (($1.contents as? IOSurface)?.allocationSize ?? 0) }
            let webBefore = webFootprint()
            let open = await withCheckedContinuation { (k: CheckedContinuation<Double, Never>) in
                web.onPainted = { k.resume(returning: $0) }
                beginEdit(i, at: CGPoint(x: r.width - 20, y: r.height - 20))
            }
            web.onPainted = nil
            await sleep(0.5)
            let t = await web.editor?.call("cb.placeCaretEnd(); return await cb.typeTimed(text)", ["text": " typing test, thirty characters"]) as? [String: Any]
            await sleep(0.5)
            Log.write(String(format: "cost %@ zoom=%.2f card_mem=%.0fMB open=%.0fms typing_p50=%@ms typing_max=%@ms web_mem %.0f→%.0fMB editor_view=%.0fx%.0fpt",
                             tag, zl, Double(cardMem) / 1e6, open, "\(t?["p50"] ?? "?")", "\(t?["max"] ?? "?")",
                             Double(webBefore) / 1e6, Double(webFootprint()) / 1e6, web.editor?.view.frame.width ?? 0, web.editor?.view.frame.height ?? 0))
        }
        if web.editing != nil { await leaveOnce() }
        NSApp.terminate(nil)
    }
}

extension Canvas {
    /// Image diagnosis: every visible-able image slot at rest, while panned in from beyond the view, and while zoomed.
    func imageDiag() async {
        mode = 5
        await waitIdle()
        let name = (board.path as NSString).lastPathComponent
        func need(_ sl: ImageSlot, _ zz: CGFloat) -> CGFloat { min(sl.rect.width * zz * backing, CGFloat(sl.item.cap)) }
        // mode 5 draws pictures into the card: judge the card's bitmap scale instead of the (hidden) image layer
        func cardSharp(_ k: Int) -> Bool { let c = slots[k].card; return rasterScale[c] >= Render.cappedScale(board.cards[c], z * backing) * 0.98 }
        func desc(_ k: Int) -> String {
            let sl = slots[k], c = board.cards[sl.card]
            let ext = (sl.item.path as NSString).pathExtension
            return "slot=\(k) card=\(sl.card) kind=\(c.kind == .image ? "image-card" : "note-image") file=\(ext) px=\(Int(sl.item.pixelSize.width))x\(Int(sl.item.pixelSize.height)) shown_w=\(Int(sl.rect.width)) hidden=\(sl.layer.isHidden)"
        }
        Log.write("imgdiag board=\(name) fit=\(String(format: "%.3f", fitZoom)) slots=\(slots.count) visible-able=\(slots.filter { !$0.layer.isHidden }.count)")
        for k in slots.indices where !slots[k].layer.isHidden || board.cards[slots[k].card].kind == .image {
            let sl = slots[k], r = sl.rect
            Log.write("imgdiag " + desc(k) + " base_level=\(baseLevel[k]) cap=\(sl.item.cap)")
            // a) at rest, centred, 175 %
            z = 1.75; camX = r.midX - bounds.width / 2 / z; camY = r.midY - bounds.height / 2 / z
            applyCamera(); levelRest(); await waitIdle(); await sleep(0.4)
            Log.write(String(format: "imgdiag   rest@1.75 centred: level=%d need=%.0f need_x2=%.0f → %@", slots[k].level, need(sl, 1.75), need(sl, 3.5),
                             CGFloat(slots[k].level) >= need(sl, 1.75) * 0.98 ? "sharp" : "BELOW"))
            // b) a real gesture far away first (its end drops off-screen images to their fit level), then pan in from one
            // screen to the left, at 175 %
            let viewW = bounds.width / z
            camX = r.midX - bounds.width / 2 / z - viewW * 4
            applyCamera()
            let xf = camX
            pendingLabel = "far"
            await drive { [self] t in camX = xf + CGFloat(t) * 50; cameraMoved(); return t < 0.2 }
            await waitIdle(); await sleep(0.4)
            camX = r.midX - bounds.width / 2 / z - viewW * 1.2
            applyCamera(); levelRest(); await waitIdle(); await sleep(0.4)
            pendingLabel = "pan-in-\(k)"
            let before = slots[k].level
            let x0 = camX
            var minLevel = Int.max, framesVisibleLow = 0, framesVisible = 0
            await drive { [self] t in
                let p = min(t / 0.6, 1)
                camX = x0 + viewW * 1.2 * CGFloat(p); cameraMoved()
                let v = CGRect(x: camX, y: camY, width: bounds.width / z, height: bounds.height / z)
                if sl.rect.intersects(v) {
                    framesVisible += 1
                    minLevel = min(minLevel, slots[k].level)
                    if slots[k].layer.isHidden ? !cardSharp(k) : CGFloat(slots[k].level) < need(sl, z) * 0.98 { framesVisibleLow += 1 }
                }
                return p < 1
            }
            let t0 = CACurrentMediaTime()
            while CGFloat(slots[k].level) < need(sl, z) * 0.98 && CACurrentMediaTime() - t0 < 3 { await sleep(0.02) }
            Log.write(String(format: "imgdiag   pan-in@1.75: level before=%d (off screen), during motion min=%d need=%.0f (%.1fx too small), visible frames below res %d/%d, sharp %.0f ms after the motion",
                             before, minLevel == Int.max ? -1 : minLevel, need(sl, z), need(sl, z) / CGFloat(max(1, minLevel == Int.max ? 1 : minLevel)),
                             framesVisibleLow, framesVisible, (CACurrentMediaTime() - t0) * 1000))
            // c) zoom 1.0 → 1.75 with the slot centred
            z = 1; camX = r.midX - bounds.width / 2 / z; camY = r.midY - bounds.height / 2 / z
            applyCamera(); levelRest(); await waitIdle(); await sleep(0.4)
            let atRest1 = slots[k].level
            var lowFrames = 0, frames = 0
            await drive { [self] t in
                let p = min(t / 0.5, 1)
                zoom(by: pow(1.75, CGFloat(p)) / z, at: CGPoint(x: bounds.width / 2, y: bounds.height / 2))
                frames += 1
                if CGFloat(slots[k].level) < need(sl, z) * 0.98 { lowFrames += 1 }
                return p < 1
            }
            Log.write(String(format: "imgdiag   zoom 1.00→1.75: level at rest(1.00)=%d (rule wants ≥ need at 2.00=%.0f), frames below res during zoom %d/%d",
                             atRest1, need(sl, 2.0), lowFrames, frames))
            await waitIdle()
        }
        NSApp.terminate(nil)
    }
}

extension Canvas {
    /// After a motion ends, captures the window repeatedly and logs every visible change between consecutive captures.
    func watchSettle(_ label: String, seconds: Double = 1.2) async {
        let t0 = CACurrentMediaTime()
        let zBefore = z
        var prev: CGImage?
        var changes: [String] = []
        var n = 0, maxShift = 0
        while CACurrentMediaTime() - t0 < seconds {
            guard let full = windowImage(), let img = full.cropping(to: CGRect(x: 0, y: 260, width: full.width, height: full.height - 300)) else { break }
            if let p = prev {
                let d = imageDiff(p, img)
                if d.meanZero > 0.02 || d.differ > img.width * img.height / 20000 {
                    n += 1; maxShift = max(maxShift, abs(d.shiftX), abs(d.shiftY))
                    changes.append(String(format: "%.0fms:%.3f%%/mean%.2f/shift(%d,%d)", (CACurrentMediaTime() - t0) * 1000,
                                          Double(d.differ) / Double(img.width * img.height) * 100, d.meanZero, d.shiftX, d.shiftY))
                }
            }
            prev = img
            await sleep(0.008)   // let the canvas run between captures (rest detection, swaps)
        }
        Log.write(String(format: "settle %@: zoom %.3f→%.3f visible changes=%d max_shift=%dpx ", label, zBefore, z, n, maxShift) + changes.joined(separator: " "))
    }

    /// The frames of a slow pan, without the camera moving between captures: the camera is held at sub-pixel offsets
    /// (as a pan passes through them) and the text's sharpness is read at each; a spread means shimmering while moving.
    func shimmer(_ label: String, card i: Int) async {
        let s = z * backing
        let x0 = camX, y0 = camY
        var grads: [Double] = []
        for k in 0..<8 {
            let f = CGFloat(k) / 8
            camX = x0 + f / s; camY = y0 + f / s
            cameraMoved()   // as a pan frame does (exact pixels rounds the camera here)
            await sleep(0.12)
            if let img = windowImage(), let c = cardCrop(img, i) { grads.append(inkStats(c).grad) }
        }
        camX = x0; camY = y0; applyCamera()
        let lo = grads.min() ?? 0, hi = grads.max() ?? 0
        Log.write(String(format: "shimmer %@: sharpness over sub-pixel offsets min=%.2f max=%.2f spread=%.1f%%", label, lo, hi, (hi - lo) / max(hi, 1) * 100))
    }

    func jitterTest() async {
        mode = 5
        await waitIdle()
        let notes = board.cards.indices.filter { isWebNote($0) && board.cards[$0].kind == .note }
        guard let i = notes.filter({ !board.cards[$0].body.contains("|") }).max(by: { board.cards[$0].body.count < board.cards[$1].body.count })
        else { NSApp.terminate(nil); return }
        let r = board.cards[i].rect
        let tag = Canvas.restExact ? "e-on" : "e-off"
        let zooms = (ProcessInfo.processInfo.environment["CANVAS_WEIGHTZOOMS"] ?? "1.13,1.37").split(separator: ",").compactMap { Double($0) }.map { CGFloat($0) }
        for zl in zooms {
            func home() async {
                z = zl; camX = r.minX - 80 / z; camY = r.minY - 60 / z
                applyCamera(); levelRest(); await waitIdle(); await sleep(0.6)
            }
            await home()
            await shimmer(String(format: "%@ pan@%.2f", tag, zl), card: i)
            await home()
            let x0 = camX, y0 = camY
            await drive { [self] t in let p = min(t / 0.4, 1); camX = x0 + 37.3 * CGFloat(p) / z; camY = y0 + 21.7 * CGFloat(p) / z; cameraMoved(); return p < 1 }
            await watchSettle(String(format: "%@ pan-stop@%.2f", tag, zl))
            z = 1; camX = r.minX - 80; camY = r.minY - 60; applyCamera(); levelRest(); await waitIdle(); await sleep(0.6)
            await drive { [self] t in
                let p = min(t / 0.4, 1)
                zoom(by: pow(zl, CGFloat(p)) / z, at: CGPoint(x: bounds.width * 0.4, y: bounds.height * 0.6))
                return p < 1
            }
            endPinch()   // as the fingers lifting from a pinch
            await watchSettle(String(format: "%@ zoom-stop 1.00→%.2f", tag, zl))
        }
        NSApp.terminate(nil)
    }
}

/// CPU seconds (user + system) of this process and of the given other processes.
func cpuSeconds(_ pids: [pid_t]) -> (app: Double, web: Double) {
    var ru = rusage(); getrusage(RUSAGE_SELF, &ru)
    let app = Double(ru.ru_utime.tv_sec) + Double(ru.ru_utime.tv_usec) / 1e6 + Double(ru.ru_stime.tv_sec) + Double(ru.ru_stime.tv_usec) / 1e6
    var web = 0.0
    var tb = mach_timebase_info_data_t(); mach_timebase_info(&tb)
    for pid in pids where pid > 0 {
        var info = rusage_info_v4()
        let r = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) } }
        if r == 0 { web += Double(info.ri_user_time + info.ri_system_time) * Double(tb.numer) / Double(tb.denom) / 1e9 }
    }
    return (app, web)
}

extension Canvas {
    /// A browse session: zoom and pan around a Note and come back, a dozen rests; CPU, drawing work and cache hits.
    func browseTest() async {
        mode = 5
        await waitIdle()
        let notes = board.cards.indices.filter { isWebNote($0) && board.cards[$0].kind == .note }
        guard let i = notes.filter({ !board.cards[$0].body.contains("|") }).max(by: { board.cards[$0].body.count < board.cards[$1].body.count })
        else { NSApp.terminate(nil); return }
        let r = board.cards[i].rect
        let pids = (web.pool + [web.editor, web.svgView].compactMap { $0 }).map { $0.webPID }
        z = 1; camX = r.minX - 80; camY = r.minY - 60; applyCamera(); levelRest(); await waitIdle(); await sleep(0.5)
        lv.cacheHits = 0; lv.cacheMisses = 0
        let c0 = cpuSeconds(pids)
        let steps: [(String, CGFloat, CGFloat, CGFloat)] = [   // (label, zoom, dx, dy in screen pt)
            ("zoom", 1.37, 0, 0), ("pan", 1.37, 300, 0), ("pan", 1.37, -300, 0), ("zoom", 1.0, 0, 0), ("zoom", 1.37, 0, 0),
            ("zoom", 1.62, 0, 0), ("pan", 1.62, 0, 250), ("pan", 1.62, 0, -250), ("zoom", 1.37, 0, 0), ("zoom", 1.0, 0, 0),
            ("zoom", 1.62, 0, 0), ("zoom", 1.0, 0, 0)]
        var restMs: [Double] = []
        for (label, zt, dx, dy) in steps {
            lv.restWorkMs = 0
            if label == "zoom" {
                let z0 = z
                await drive { [self] t in let p = min(t / 0.35, 1); zoom(by: (z0 * pow(zt / z0, CGFloat(p))) / z, at: CGPoint(x: bounds.width * 0.3, y: bounds.height * 0.7)); return p < 1 }
            } else {
                let x0 = camX, y0 = camY, zz = z
                await drive { [self] t in let p = min(t / 0.35, 1); camX = x0 + dx * CGFloat(p) / zz; camY = y0 + dy * CGFloat(p) / zz; cameraMoved(); return p < 1 }
            }
            await waitIdle(); await sleep(0.2)
            restMs.append(lv.restWorkMs)
        }
        let c1 = cpuSeconds(pids)
        Log.write(String(format: "browse %@: rests=%d drawing work per rest p50=%.0fms total=%.0fms cpu app=%.2fs web=%.2fs cache hits=%d misses=%d cache=%.0fMB card_mem=%.0fMB",
                         Canvas.restExact ? "e-on\(lv.snap ? "+snap" : "")" : "e-off", steps.count, GestureStats.pct(restMs, 0.5), restMs.reduce(0, +),
                         c1.app - c0.app, c1.web - c0.web, lv.cacheHits, lv.cacheMisses,
                         Double(lv.cache.values.reduce(0) { $0 + $1.bytes }) / 1e6, Double(cardMemory()) / 1e6))
        NSApp.terminate(nil)
    }
}

extension Canvas {
    /// Disk format comparison on real snapshots: size, encode and decode time, exactness.
    func formatTest() async {
        mode = 5
        await waitIdle()
        let notes = board.cards.indices.filter { isWebNote($0) }.prefix(12)
        var rows: [String: (size: Int, enc: Double, dec: Double, exact: Bool)] = [:]
        var px = 0
        for scale: CGFloat in [2, 4] {
            for i in notes {
                let img: CGImage? = await withCheckedContinuation { k in
                    webSnapshot(i, scale: scale, useCache: false) { s, _ in k.resume(returning: s.flatMap { Canvas.image(from: $0) }) }
                }
                guard let img else { continue }
                px += img.width * img.height
                let ref = pixels(img)
                for f in [SnapshotCache.Format.lzfse, .png] {
                    let c = SnapshotCache.shared
                    c.format = f
                    let t0 = CACurrentMediaTime(); let data = c.encode(img)!; let t1 = CACurrentMediaTime()
                    let back = c.decode(data); let t2 = CACurrentMediaTime()
                    let same = back.flatMap { Canvas.image(from: $0) }.map { pixels($0) == ref } ?? false
                    var r = rows["\(f.rawValue)@\(Int(scale))"] ?? (0, 0, 0, true)
                    r.size += data.count; r.enc += (t1 - t0) * 1000; r.dec += (t2 - t1) * 1000; r.exact = r.exact && same
                    rows["\(f.rawValue)@\(Int(scale))"] = r
                }
            }
        }
        for (k, r) in rows.sorted(by: { $0.key < $1.key }) {
            Log.write(String(format: "format %@: %d notes, %.1f MB on disk (%.2f bytes/px), encode %.1f ms/note, decode %.1f ms/note, exact=%@",
                             k, notes.count, Double(r.size) / 1e6, Double(r.size) / Double(max(px / 2, 1)), r.enc / Double(notes.count), r.dec / Double(notes.count), r.exact ? "yes" : "NO"))
        }
        NSApp.terminate(nil)
    }
}

extension Canvas {
    func webProcs() -> String {
        var parts: [String] = []
        if let e = web.editor { parts.append("editor \(footprint(of: e.webPID) / 1_000_000)MB") }
        for (k, v) in web.pool.enumerated() { parts.append("snap\(k) \(footprint(of: v.webPID) / 1_000_000)MB") }
        return String(format: "app %dMB · ", physFootprint() / 1_000_000) + parts.joined(separator: " · ") + String(format: " · web total %dMB", webFootprint() / 1_000_000)
    }

    func waitBase(_ max: Double = 20) async {
        let t0 = CACurrentMediaTime()
        while !web.baseLogged && CACurrentMediaTime() - t0 < max { await sleep(0.05) }
    }

    /// The web-Note memory and timing scenario: first open (never drawn), idle teardown, switching boards, warm reopen,
    /// editing one Note, and a 50 %→200 % zoom with the configured number of snapshot views.
    func webMemTest(other: Int) async {
        let a = boardIndex
        let tag = "views=\(web.poolCount)"
        mode = 5
        // 1. first open: watch memory while the first snapshots are drawn
        var peak = (app: 0, web: 0)
        let t0 = CACurrentMediaTime()
        while (!web.baseLogged || levelBusy) && CACurrentMediaTime() - t0 < 30 {
            peak.app = max(peak.app, physFootprint()); peak.web = max(peak.web, webFootprint())
            await sleep(0.1)
        }
        Log.write(String(format: "memtest %@ first-open: everything sharp %.0f ms after load · peak while drawing app %dMB web %dMB",
                         tag, (CACurrentMediaTime() - web.loadStart) * 1000, peak.app / 1_000_000, peak.web / 1_000_000))
        await sleep(1)
        Log.write("memtest \(tag) board open, idle, snapshot views alive: " + webProcs())
        while !web.pool.isEmpty { await sleep(0.2) }   // idle teardown
        await sleep(1)
        Log.write("memtest \(tag) after idle teardown: " + webProcs())
        // 2. switching boards
        for (label, idx) in [("switch to other board (never drawn)", other), ("back to first board (disk cache warm)", a)] {
            let d0 = web.diskHits, n0 = web.drawn
            load(idx)
            await waitBase()
            while levelBusy { await sleep(0.05) }
            Log.write(String(format: "memtest %@ %@: everything sharp %.0f ms after load · disk hits %d · drawn %d", tag, label,
                             (CACurrentMediaTime() - web.loadStart) * 1000, web.diskHits - d0, web.drawn - n0))
        }
        // 3. edit one Note and leave with a change
        let notes = board.cards.indices.filter { isWebNote($0) && board.cards[$0].kind == .note && visible.contains($0) }
        if let i = notes.first {
            while !web.pool.isEmpty { await sleep(0.2) }   // snapshot views closed: the cold case
            let open = await editOnce(i, cold: false)
            await web.editor?.call("cb.placeCaretEnd(); return true")
            await web.editor?.call("return await cb.typeTimed(text)", ["text": "x"])
            let n0 = web.drawn
            let t1 = CACurrentMediaTime()
            await leaveOnce()
            let leaveMs = (CACurrentMediaTime() - t1) * 1000
            while levelBusy { await sleep(0.05) }
            Log.write(String(format: "memtest %@ edit: open to typing %.0f ms (snapshot views closed) · leave → new picture on screen %.0f ms (snapshot view cold-started) · Notes drawn %d",
                             tag, open, leaveMs, web.drawn - n0))
        }
        // 4. zoom 50 % → 200 %, time from rest to sharp: snapshot views closed (cold), then open (warm)
        for (label, region) in [("snapshot view closed", 0.0), ("snapshot view open", 0.3)] {
            if label.hasSuffix("closed") { while !web.pool.isEmpty { await sleep(0.2) } }
            z = 0.5; let b = board.bounds
            camX = b.midX - bounds.width / 2 / z + CGFloat(region) * b.width; camY = b.midY - bounds.height / 2 / z
            applyCamera(); levelRest(); await waitIdle(20)
            if label.hasSuffix("closed") { while !web.pool.isEmpty { await sleep(0.2) } }
            await drive { [self] t in let p = min(t / 1.0, 1); zoom(by: (0.5 * pow(4, CGFloat(p))) / z, at: CGPoint(x: bounds.midX, y: bounds.midY)); return p < 1 }
            let t2 = CACurrentMediaTime()
            while (!lv.resting || levelBusy) && CACurrentMediaTime() - t2 < 20 { await sleep(0.02) }
            Log.write(String(format: "memtest %@ zoom 50→200%% (%@): rest to sharp %.0f ms after the motion (incl. 150 ms rest detection)", tag, label, (CACurrentMediaTime() - t2) * 1000))
        }
        Log.write(String(format: "memtest %@ disk cache: %d files, %.1f MB, read p50 %.1f ms", tag, SnapshotCache.shared.count,
                         Double(SnapshotCache.shared.size) / 1e6, GestureStats.pct(SnapshotCache.shared.readMs, 0.5)))
        NSApp.terminate(nil)
    }
}

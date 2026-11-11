import AppKit

// Usage: CanvasProto [board.json | vault folder] [--bench N] [--modes 1,2,3]
//   --bench N: run the scripted pan / zoom on the N largest boards of the vault in every mode, log, and quit.

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var canvas: Canvas!
    var monitor: Any?

    func applicationDidFinishLaunching(_ n: Notification) {
        var args = Array(CommandLine.arguments.dropFirst())
        var bench: Int?
        var modes = [1, 2, 3, 4]
        var asyncLive = false, caLive = false, cgimage = false
        if let i = args.firstIndex(of: "--bench"), i + 1 < args.count { bench = Int(args[i + 1]); args.removeSubrange(i...i + 1) }
        if let i = args.firstIndex(of: "--modes"), i + 1 < args.count {
            modes = args[i + 1].split(separator: ",").compactMap { Int($0) }; args.removeSubrange(i...i + 1)
        }
        if let i = args.firstIndex(of: "--async") { args.remove(at: i); asyncLive = true }
        var maxZoom: CGFloat = 2, shaping = true, glideTest = false
        if let i = args.firstIndex(of: "--max-zoom"), i + 1 < args.count { maxZoom = CGFloat(Double(args[i + 1]) ?? 2); args.removeSubrange(i...i + 1) }
        if let i = args.firstIndex(of: "--no-shaping") { args.remove(at: i); shaping = false }
        if let i = args.firstIndex(of: "--glide-test") { args.remove(at: i); glideTest = true }
        var webOn = true
        if let i = args.firstIndex(of: "--no-web") { args.remove(at: i); webOn = false }
        if let i = args.firstIndex(of: "--ca") { args.remove(at: i); caLive = true }
        if let i = args.firstIndex(of: "--cgimage") { args.remove(at: i); cgimage = true }
        args.removeAll { $0.hasPrefix("-") }  // Launch Services' own arguments
        var target = args.first ?? "\(NSHomeDirectory())/Projects/persona/.codeboard"
        target = (target as NSString).expandingTildeInPath
        var isDir: ObjCBool = false
        FileManager.default.fileExists(atPath: target, isDirectory: &isDir)
        let vault = isDir.boolValue ? target : (target as NSString).deletingLastPathComponent

        let screen = NSScreen.main!.visibleFrame
        window = NSWindow(contentRect: screen.insetBy(dx: 40, dy: 30), styleMask: [.titled, .closable, .resizable, .miniaturizable],
                          backing: .buffered, defer: false)
        canvas = Canvas(frame: window.contentLayoutRect)
        canvas.vault = vault
        canvas.boards = Board.list(vault: vault)
        canvas.liveAsync = asyncLive
        canvas.maxZoom = maxZoom
        canvas.shaping = shaping
        canvas.web.on = webOn
        canvas.liveOwn = !caLive && !asyncLive
        canvas.useSurfaces = !cgimage
        // The canvas fills a plain container, so web views can sit behind it (offscreen renders) or above it (the editor).
        let container = NSView(frame: canvas.frame)
        container.wantsLayer = true
        canvas.autoresizingMask = [.width, .height]
        container.addSubview(canvas)
        window.contentView = container
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(canvas)
        NSApp.activate(ignoringOtherApps: true)
        canvas.layoutSubtreeIfNeeded()
        let start = isDir.boolValue ? 0 : (canvas.boards.firstIndex(of: target) ?? 0)
        canvas.load(start)
        if glideTest {
            window.level = .floating
            window.orderFrontRegardless()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.canvas.glideTest([0.15, 0.3, 0.6]) }
        }
        if let n = bench {
            window.level = .floating  // a covered window gets no display-link callbacks; keep the bench on top
            window.orderFrontRegardless()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.canvas.startBench(boards: Array(start..<min(start + n, self.canvas.boards.count)), modes: modes, quit: true)
            }
        }
        buildMenu()
        // Gestures always belong to the canvas, also over the editor (a WKWebView would take them otherwise).
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .magnify]) { [weak self] e in
            if ProcessInfo.processInfo.environment["CANVAS_MODE5TEST"] != nil {
                Log.write("event \(e.type == .scrollWheel ? "scroll" : "magnify") window=\(e.window === self?.window) routed=\(Canvas.routeGestures)")
            }
            guard let self, Canvas.routeGestures, e.window === self.window else { return e }
            if e.type == .scrollWheel { self.canvas.scrollWheel(with: e) } else { self.canvas.magnify(with: e) }
            return nil
        }
        if ProcessInfo.processInfo.environment["CANVAS_MODE5TEST"] != nil {
            window.level = .floating
            window.orderFrontRegardless()
            Task { @MainActor in await self.canvas.mode5Test() }
        }
        if let dir = ProcessInfo.processInfo.environment["CANVAS_WEBTEST"] { webTest(dir) }
        if let spec = ProcessInfo.processInfo.environment["CANVAS_NOTESHOT"] { noteShot(spec) }
        if ProcessInfo.processInfo.environment["CANVAS_EDITTEST"] != nil {
            window.level = .floating
            window.orderFrontRegardless()
            canvas.mode = 2
            Task { @MainActor in await self.canvas.editTest() }
        }
        if let dir = ProcessInfo.processInfo.environment["CANVAS_SNAP"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.canvas.zoom(by: 1.5, at: CGPoint(x: self.canvas.bounds.midX, y: self.canvas.bounds.midY))
                self.canvas.resetRasters()
                self.canvas.snapshot(to: "\(dir)/snap-1.png")
                self.canvas.mode = 3
                self.canvas.snapshot(to: "\(dir)/snap-3.png")
                self.canvas.zoom(by: 1.7, at: CGPoint(x: self.canvas.bounds.midX, y: self.canvas.bounds.midY))
                self.canvas.mode = 4
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                    self.canvas.snapshot(to: "\(dir)/snap-4.png")
                    let a = self.canvas.snapshotPixels()
                    Canvas.pow2ForDiff = true  // same scale as the tiles, so only seams and borders can differ
                    self.canvas.mode = 2  // whole cards rastered synchronously at this zoom
                    let b = self.canvas.snapshotPixels()
                    Canvas.diff(a, b, to: "\(dir)/diff-4-vs-2.png")
                    NSApp.terminate(nil)
                }
            }
        }
    }

    /// Snapshots the largest Note of the board at 1, 2 and 4 device px per CSS px and logs sizes and times.
    func webTest(_ dir: String) {
        let web = NoteWeb(vault: canvas.vault)
        window.contentView!.addSubview(web.view, positioned: .below, relativeTo: canvas)
        Task { @MainActor in
            await web.whenReady()
            Log.write(String(format: "webtest page ready in %.0fms", (web.readyAt - web.created) * 1000))
            guard let c = canvas.board.cards.filter({ $0.kind == .note }).max(by: { $0.body.count < $1.body.count }) else { return }
            for s in [1.0, 2.0, 4.0, 2.0] {
                let (img, r, t) = await web.snapshot(src: c.body, width: c.rect.width, height: c.rect.height, card: true, scale: s)
                Log.write(String(format: "webtest scale=%.0f card=%.0fx%.0f image=%dx%d render=%.1fms snapshot=%.1fms", s, c.rect.width, c.rect.height,
                                 img?.width ?? 0, img?.height ?? 0, r, t))
                if let img { saveImage(img, "\(dir)/web-\(Int(s)).png") }
            }
            Log.write("webtest web_footprint=\(footprint(of: web.webPID) / 1_000_000)MB pid=\(web.webPID)")
            NSApp.terminate(nil)
        }
    }

    /// "cardId:dir": the Note drawn by the static render and by the editor path, at 2×, saved as PNGs (for checking a
    /// rendering difference by eye; the files stay outside the repository).
    func noteShot(_ spec: String) {
        let parts = spec.split(separator: ":", maxSplits: 1).map(String.init)
        let web = NoteWeb(vault: canvas.vault)
        window.contentView!.addSubview(web.view, positioned: .below, relativeTo: canvas)
        Task { @MainActor in
            await web.whenReady()
            guard let c = canvas.board.cards.first(where: { $0.id == parts[0] }) else { NSApp.terminate(nil); return }
            for (k, im) in c.images.enumerated() {
                let item = ImageItem(path: im.path, size: ImageStore.pixelSize(im.path) ?? .zero)
                if let surf = ImageStore.decode(item, width: 910), let img = Canvas.image(from: surf) {
                    saveImage(img, "\(parts[1])/note-native-image\(k).png")
                    Log.write("noteshot native image \(k) at \(Int(im.rect.minX)),\(Int(im.rect.minY)) size \(Int(im.rect.width))x\(Int(im.rect.height))")
                }
            }
            for via in [false, true] { for sc: CGFloat in [0.75, 1, 4] {
                let (img, r, t) = await web.snapshot(src: c.body, width: c.rect.width, height: c.rect.height, card: true, scale: sc, viaEditor: via)
                Log.write(String(format: "noteshot via=%@ scale=%.2f render=%.0fms snap=%.0fms size=%dx%d", via ? "editor" : "static", sc, r, t, img?.width ?? 0, img?.height ?? 0))
                if let img { saveImage(img, "\(parts[1])/note-\(via ? "editor" : "static")-\(sc).png") }
            } }
            NSApp.terminate(nil)
        }
    }

    func buildMenu() {
        let main = NSMenu()
        let app = NSMenuItem(); main.addItem(app)
        let am = NSMenu()
        am.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        app.submenu = am
        let file = NSMenuItem(); main.addItem(file)
        let fm = NSMenu(title: "File")
        fm.addItem(withTitle: "Open Board…", action: #selector(open(_:)), keyEquivalent: "o")
        file.submenu = fm
        NSApp.mainMenu = main
    }

    @objc func open(_ sender: Any?) {
        let p = NSOpenPanel()
        p.allowedContentTypes = [.json]
        p.directoryURL = URL(fileURLWithPath: canvas.vault)
        guard p.runModal() == .OK, let url = p.url else { return }
        let vault = url.deletingLastPathComponent().path
        if vault != canvas.vault { canvas.vault = vault; canvas.boards = Board.list(vault: vault) }
        canvas.load(canvas.boards.firstIndex(of: url.path) ?? 0)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()

import AppKit

// Usage: CanvasProto [board.json | vault folder] [--bench N] [--modes 1,2,3]
//   --bench N: run the scripted pan / zoom on the N largest boards of the vault in every mode, log, and quit.

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var canvas: Canvas!

    func applicationDidFinishLaunching(_ n: Notification) {
        var args = Array(CommandLine.arguments.dropFirst())
        var bench: Int?
        var modes = [1, 2, 3]
        var asyncLive = false, caLive = false, cgimage = false
        if let i = args.firstIndex(of: "--bench"), i + 1 < args.count { bench = Int(args[i + 1]); args.removeSubrange(i...i + 1) }
        if let i = args.firstIndex(of: "--modes"), i + 1 < args.count {
            modes = args[i + 1].split(separator: ",").compactMap { Int($0) }; args.removeSubrange(i...i + 1)
        }
        if let i = args.firstIndex(of: "--async") { args.remove(at: i); asyncLive = true }
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
        canvas.liveOwn = !caLive && !asyncLive
        canvas.useSurfaces = !cgimage
        window.contentView = canvas
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(canvas)
        NSApp.activate(ignoringOtherApps: true)
        canvas.layoutSubtreeIfNeeded()
        let start = isDir.boolValue ? 0 : (canvas.boards.firstIndex(of: target) ?? 0)
        canvas.load(start)
        if let n = bench {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.canvas.startBench(boards: Array(0..<min(n, self.canvas.boards.count)), modes: modes, quit: true)
            }
        }
        buildMenu()
        if let dir = ProcessInfo.processInfo.environment["CANVAS_SNAP"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.canvas.zoom(by: 3, at: CGPoint(x: self.canvas.bounds.midX, y: self.canvas.bounds.midY))
                self.canvas.resetRasters()
                self.canvas.snapshot(to: "\(dir)/snap-1.png")
                self.canvas.mode = 3
                self.canvas.snapshot(to: "\(dir)/snap-3.png")
                NSApp.terminate(nil)
            }
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

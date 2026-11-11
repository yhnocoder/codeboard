import AppKit
import WebKit

/// One WKWebView with the Note page (web/dist/page.html): the Markdown package's static render and its editor.
/// It has to sit in a visible window to paint, so the app keeps its static ones behind the opaque canvas.
final class NoteWeb: NSObject, WKScriptMessageHandler {
    let view: WKWebView
    private(set) var ready = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    var onMessage: (([String: Any]) -> Void)?
    let created = CACurrentMediaTime()
    var readyAt = 0.0

    static var pageURL: URL? = {
        // The app bundle's Resources/web, else web/dist next to the package (swift run / .build)
        if let r = Bundle.main.resourceURL?.appendingPathComponent("web/page.html"), FileManager.default.fileExists(atPath: r.path) { return r }
        var dir = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<6 {
            let p = dir.appendingPathComponent("web/dist/page.html")
            if FileManager.default.fileExists(atPath: p.path) { return p }
            dir = dir.deletingLastPathComponent()
        }
        return nil
    }()

    init(vault: String, focusable: Bool = false) {
        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = true
        // Only the editor may take keyboard focus: a snapshot view mounting the editor to draw a Note would otherwise
        // become first responder and blur the editor the user is typing in.
        view = focusable ? EditorWebView(frame: CGRect(x: 0, y: 0, width: 600, height: 800), configuration: config)
            : UnfocusableWebView(frame: CGRect(x: 0, y: 0, width: 600, height: 800), configuration: config)
        super.init()
        config.userContentController.add(self, name: "cb")
        // Opaque pages let WebKit use the system's font smoothing (heavier, firmer glyphs); transparent ones do not.
        if NoteWeb.opaque {
            view.setValue(true, forKey: "drawsBackground")
            view.underPageBackgroundColor = NSColor(cgColor: Render.cardBg)
        } else {
            view.setValue(false, forKey: "drawsBackground")
        }
        if let page = NoteWeb.pageURL {
            view.loadFileURL(page, allowingReadAccessTo: URL(fileURLWithPath: NSHomeDirectory()))
        } else {
            Log.write("web: page not found (run make-app.sh or node web/build.mjs)")
        }
        self.vault = vault
    }
    private var vault = ""
    // what the page shows now, so a snapshot at another scale needs no re-render
    var rendered: String?
    var renderedWidth: CGFloat = 0
    var renderedVia = false
    var renderedScale: CGFloat = 1
    nonisolated(unsafe) static var textStroke: CGFloat = CGFloat(Double(ProcessInfo.processInfo.environment["CANVAS_STROKE"] ?? "") ?? 0)
    nonisolated(unsafe) static var opaque = ProcessInfo.processInfo.environment["CANVAS_OPAQUE"] != nil
    nonisolated(unsafe) static var transformSnapshots = ProcessInfo.processInfo.environment["CANVAS_SNAPMODE"] != "scaled"

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any] else { return }
        if m["ready"] != nil {
            readyAt = CACurrentMediaTime()
            view.evaluateJavaScript("cb.setVault(\(jsString(URL(fileURLWithPath: vault).absoluteString + "/")))")
            if let look = ProcessInfo.processInfo.environment["CANVAS_TEXTLOOK"] { view.evaluateJavaScript("cb.setTextLook(\(jsString(look)))") }
            if NoteWeb.textStroke > 0 { view.evaluateJavaScript("cb.setTextStroke(\(Double(NoteWeb.textStroke)))") }
            ready = true
            waiting.forEach { $0.resume() }
            waiting = []
            return
        }
        onMessage?(m)
    }

    func whenReady() async {
        if ready { return }
        await withCheckedContinuation { waiting.append($0) }
    }

    @discardableResult
    func call(_ body: String, _ args: [String: Any] = [:]) async -> Any? {
        await whenReady()
        do { return try await view.callAsyncJavaScript(body, arguments: args, in: nil, contentWorld: .page) } catch {
            Log.write("web: js error \(error)")
            return nil
        }
    }

    /// Renders `src` statically at `width` CSS px and snapshots the card (width × height) at `scale` device px per CSS px.
    func snapshot(src: String, width: CGFloat, height: CGFloat, card: Bool, scale: CGFloat, viaEditor: Bool = false) async -> (CGImage?, Double, Double) {
        let t0 = CACurrentMediaTime()
        // The editor's own way of drawing at a scale: the Note keeps its 100 % layout and is scaled by a CSS transform,
        // drawn 1:1 at the screen's backing scale. (A scaled snapshot of an unscaled page comes out softer between
        // whole scales than the live editor, which is what made entering edit look sharper.)
        let backing = view.window?.backingScaleFactor ?? 2
        let k = viaEditor && NoteWeb.transformSnapshots ? scale / backing : 1
        let vw = ceil(width * k), vh = ceil(height * k)
        if view.frame.width != vw || view.frame.height < vh {
            view.setFrameSize(CGSize(width: vw, height: vh))
        }
        if rendered != src || renderedWidth != width || renderedVia != viaEditor {
            _ = await call(viaEditor ? "return await cb.renderEditor(src, width, card)" : "return await cb.render(src, width, card)",
                           ["src": src, "width": Double(width), "card": card])
            rendered = src; renderedWidth = width; renderedVia = viaEditor; renderedScale = 1
        }
        if viaEditor && NoteWeb.transformSnapshots {
            if renderedScale != k { _ = await call("return await cb.setScaleSettled(s)", ["s": Double(k)]); renderedScale = k }
            let t1 = CACurrentMediaTime()
            let img = await take(width: width * k, height: height * k, scale: backing)
            return (img, (t1 - t0) * 1000, (CACurrentMediaTime() - t1) * 1000)
        }
        let t1 = CACurrentMediaTime()
        let img = await take(width: width, height: height, scale: scale)
        return (img, (t1 - t0) * 1000, (CACurrentMediaTime() - t1) * 1000)
    }

    func take(width: CGFloat, height: CGFloat, scale: CGFloat) async -> CGImage? {
        let c = WKSnapshotConfiguration()
        c.rect = CGRect(x: 0, y: 0, width: width, height: height)
        let backing = view.window?.backingScaleFactor ?? 2
        c.snapshotWidth = NSNumber(value: Double(width * scale / backing))
        c.afterScreenUpdates = true
        guard let img = try? await view.takeSnapshot(configuration: c) else { return nil }
        return img.cgImage(forProposedRect: nil, context: nil, hints: nil)
    }

    /// The web content process, for its memory.
    var webPID: pid_t { (view.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value ?? 0 }
}

func jsString(_ s: String) -> String {
    let d = try! JSONSerialization.data(withJSONObject: [s])
    let a = String(data: d, encoding: .utf8)!
    return String(a.dropFirst().dropLast())
}

/// Physical footprint of another process of this user (the web content processes).
func footprint(of pid: pid_t) -> Int {
    guard pid > 0 else { return 0 }
    var info = rusage_info_v4()
    let r = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
    }
    return r == 0 ? Int(info.ri_phys_footprint) : 0
}

func saveImage(_ img: CGImage, _ path: String) {
    guard let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(d, img, nil)
    CGImageDestinationFinalize(d)
}

/// A web view that never takes keyboard focus (offscreen renders).
final class UnfocusableWebView: WKWebView {
    override var acceptsFirstResponder: Bool { false }
    override func becomeFirstResponder() -> Bool { false }
}

/// The editor's web view: while an edit is open it keeps keyboard focus unless the app itself lets it go.
final class EditorWebView: WKWebView {
    var holdFocus = false
    override func resignFirstResponder() -> Bool {
        if holdFocus { return false }
        return super.resignFirstResponder()
    }
}

// Notes drawn and edited by the board's own web renderer (apps/macos/web, @yhnocoder/markdown with the board's stylesheets) in
// WKWebViews: CardPage is one loaded page; NoteRenderer keeps one offscreen behind the canvas and snapshots cards into bitmaps,
// a few at a time, cached by content, width, theme and scale; EditCard shows one over the card being edited, following the camera.
import AppKit
import CryptoKit
import WebKit

/** The web page's description of a card (web/main.ts CardSpec) */
struct CardSpec: Encodable {
  var id: String
  var kind: String
  var look: String?
  var md: String
  var title: String
  var name: String?
  var w: Double
  var size: String?
  var bold: Bool?
  var fill: String?
  var hand: String?
  var weight: String?
  var level: Int?
  var fs: Double?
  var locked: Bool?
  var lang: String?
  /** The board's own height (Place.h): the body scrolls inside it */
  var h: Double?
  /** A sub-board card: its skeleton as JSON (the page draws the map) */
  var skel: String?
  /** A Highlight's Always Show notes: their Markdown as a JSON array, at the width they get */
  init(inote id: String, mds: [String], width: Double) {
    self.id = id
    kind = "inote"
    md = (try? String(data: JSONEncoder().encode(mds), encoding: .utf8)) ?? "[]"
    title = ""
    w = width
  }
  init(_ c: SceneCard, text: String? = nil, lang: String? = nil) {
    id = c.id
    kind = c.kind
    look = c.look
    md = text ?? c.md ?? ""
    title = c.title
    name = c.name
    w = c.w
    size = c.size
    bold = c.bold
    fill = c.fill
    hand = c.hand
    weight = c.weight
    level = c.level
    fs = c.fs
    locked = c.locked
    self.lang = lang
    if c.fixed == true { h = c.h }
    skel = c.skel
  }
  /** What a rendering depends on, for the bitmap cache */
  var key: String { "\(kind)|\(look ?? "")|\(w)|\(title)|\(name ?? "")|\(size ?? "")|\(bold ?? false)|\(fill ?? "")|\(hand ?? "")|\(weight ?? "")|\(level ?? 0)|\(fs ?? 0)|\(h ?? 0)|\(skel ?? "")|\(md)" }
}

/** The configuration's handlers (retained by WebKit): they forward to the page without retaining it */
private final class PageHandler: NSObject, WKScriptMessageHandler, WKURLSchemeHandler {
  weak var page: CardPage?
  /** Tasks WebKit stopped (the page navigated, the view went) while their file was being read: calling into one throws */
  var stopped: Set<ObjectIdentifier> = []
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { page?.userContentController(c, didReceive: m) }
  func webView(_ w: WKWebView, start task: WKURLSchemeTask) { page?.webView(w, start: task) }
  func webView(_ w: WKWebView, stop task: WKURLSchemeTask) { stopped.insert(ObjectIdentifier(task)) }
}

/** The card page in a WKWebView: cb.* calls in, messages out (web/main.ts), the page and the storage folder's assets under cb: */
final class CardPage: NSObject, WKScriptMessageHandler, WKURLSchemeHandler, WKNavigationDelegate {
  let web: WKWebView
  private(set) var ready = false
  private var queued: [(String, ((Any?) -> Void)?)] = []
  var onMessage: (([String: Any]) -> Void)?
  /** The page is ready (again): whoever set it up sends its setup again (after a WebContent crash the page starts over) */
  var onReady: (() -> Void)?
  /** WebKit's content process died under the page: it is loading again; the owner recovers what it was doing */
  var onTerminated: (() -> Void)?
  private weak var handler: PageHandler?
  var assetsDir = ""
  static var pageDir: URL {
    if let r = Bundle.main.url(forResource: "web", withExtension: nil) { return r }
    return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("dist/web")
  }

  private static var warned60 = false
  init(frame: CGRect) {
    let cfg = WKWebViewConfiguration()
    let handler = PageHandler()
    // the configuration is copied by the web view: everything goes on it first
    cfg.userContentController.add(handler, name: "cb")
    // the page's errors reach the log (no inspector in a scripted run)
    cfg.userContentController.addUserScript(WKUserScript(source: "window.onerror=(m,s,l,c,e)=>webkit.messageHandlers.cb.postMessage({type:'error',text:String(m)+' @ '+s+':'+l+(e&&e.stack?'\\n'+e.stack:'')});window.addEventListener('unhandledrejection',e=>webkit.messageHandlers.cb.postMessage({type:'error',text:'rejection: '+(e.reason&&e.reason.stack||e.reason)}))", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    // the page and the storage folder's assets come through one scheme: cb://app/… is dist/web, cb://a/assets/… the assets
    // (a file: page cannot load module scripts: its origin is opaque)
    cfg.setURLSchemeHandler(handler, forURLScheme: "cb")
    // WebKit renders near 60 fps unless told the page prefers the display's rate: on a 120 Hz display the editor then paints
    // a keystroke in 8 ms, not 17 (a private preference; without it the page runs at 60 as before)
    // (the WebKit feature flag PreferPageRenderingUpdatesNear60FPSEnabled, off; it is listed under _features, as the Safari
    // develop menu's feature flags are)
    if let f = (WKPreferences.perform(Selector(("_features")))?.takeUnretainedValue() as? [NSObject])?.first(where: { ($0.value(forKey: "key") as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled" }),
      cfg.preferences.responds(to: Selector(("_setEnabled:forFeature:"))) {
      typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
      let sel = Selector(("_setEnabled:forFeature:"))
      unsafeBitCast(cfg.preferences.method(for: sel), to: SetEnabled.self)(cfg.preferences, sel, false, f)
      typealias IsEnabled = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
      let isSel = Selector(("_isEnabledForFeature:"))
      if cfg.preferences.responds(to: isSel) { logLine("[codeboard web] near-60 fps rendering: %d", unsafeBitCast(cfg.preferences.method(for: isSel), to: IsEnabled.self)(cfg.preferences, isSel, f) ? 1 : 0) }
    } else if !CardPage.warned60 {
      CardPage.warned60 = true
      logLine("[codeboard web] no PreferPageRenderingUpdatesNear60FPSEnabled feature in this WebKit: the editor paints at 60 Hz")
    }
    web = CardWeb(frame: frame, configuration: cfg)
    super.init()
    handler.page = self
    self.handler = handler
    web.setValue(false, forKey: "drawsBackground")
    // --inspect: the pages show in Safari's Develop menu (the editor's typing profile)
    if CommandLine.arguments.contains("--inspect") { web.isInspectable = true }
    web.navigationDelegate = self
    web.load(URLRequest(url: URL(string: "cb://app/index.html")!))
  }

  /** Run JavaScript on the page; before the page is ready the calls wait */
  func call(_ js: String, _ done: ((Any?) -> Void)? = nil) {
    guard ready else { queued.append((js, done)); return }
    // a statement, so a Promise or an element is never the result (evaluateJavaScript fails on those)
    web.evaluateJavaScript(done == nil ? "void (\(js))" : js) { v, e in
      if let e { logLine("[codeboard web] %@: %@", js.prefix(80).description, e.localizedDescription) }
      done?(v)
    }
  }
  func setup(theme: String, titles: [[String: String]]) {
    call("cb.setup(\(encodeJSON(["theme": theme, "look": Theme.look])))")
    call("cb.setup(\(encodeJSON(["titles": titles])))")
  }

  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let d = m.body as? [String: Any] else { return }
    if d["type"] as? String == "error" { logLine("[codeboard web] %@", d["text"] as? String ?? "?"); return }
    if d["type"] as? String == "ready" {
      ready = true
      logLine("[codeboard web] script ready (page %.0f ms since its start, fonts %@)", d["ms"] as? Double ?? -1, d["fonts"] as? Bool == true ? "loaded" : "loading")
      onReady?()
      let q = queued
      queued = []
      for (js, done) in q { call(js, done) }
    }
    onMessage?(d)
  }
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
    logLine("[codeboard web] the page's content process died: loading it again")
    ready = false
    onTerminated?()
    web.load(URLRequest(url: URL(string: "cb://app/index.html")!))
  }
  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { logLine("[codeboard web] load failed: %@", e.localizedDescription) }
  func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { logLine("[codeboard web] failed: %@", e.localizedDescription) }
  func webView(_ w: WKWebView, didFinish n: WKNavigation!) { if !ready { logLine("[codeboard web] page loaded, waiting for its script") } }

  // cb://app/x → dist/web/x (cb://app/wasm/x → the tree-sitter wasm beside bridge.js); cb://a/assets/x.png → <storage folder>/assets/x.png.
  // The path is canonicalised and must stay under its root (no ..); the file is read off the main thread
  func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url, let path = url.path.removingPercentEncoding else { task.didFailWithError(URLError(.badURL)); return }
    let root: URL
    let rel: String
    if url.host == "app" {
      if path.hasPrefix("/wasm/") {
        root = CardPage.pageDir.deletingLastPathComponent()
        rel = String(path.dropFirst(6))
      } else {
        root = CardPage.pageDir
        rel = String(path.dropFirst())
      }
    } else {
      guard url.host == "a", !assetsDir.isEmpty, path.hasPrefix("/assets/") else { task.didFailWithError(URLError(.badURL)); return }
      root = URL(fileURLWithPath: assetsDir)
      rel = String(path.dropFirst(8))
    }
    // symlinks resolved on both sides, so a link inside assets/ cannot lead out of it
    let base = root.standardizedFileURL.resolvingSymlinksInPath().path
    let file = root.appendingPathComponent(rel).standardizedFileURL.resolvingSymlinksInPath().path
    guard !rel.isEmpty, file.hasPrefix(base + "/") else { task.didFailWithError(URLError(.badURL)); return }
    let mime = CardPage.mime[(file as NSString).pathExtension.lowercased()] ?? "application/octet-stream"
    let key = ObjectIdentifier(task)
    DispatchQueue.global(qos: .userInitiated).async {
      let data = FileManager.default.contents(atPath: file)
      DispatchQueue.main.async { [weak self] in
        // stopped meanwhile (the page moved on): nothing may be called on the task
        guard let h = self?.handler, !h.stopped.contains(key) else { self?.handler?.stopped.remove(key); return }
        guard let data else { task.didFailWithError(URLError(.fileDoesNotExist)); return }
        task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: nil))
        task.didReceive(data)
        task.didFinish()
      }
    }
  }
  private static let mime = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "svg": "image/svg+xml", "webp": "image/webp", "html": "text/html", "js": "text/javascript", "css": "text/css", "woff2": "font/woff2", "woff": "font/woff", "json": "application/json", "wasm": "application/wasm"]
  func webView(_ w: WKWebView, stop task: WKURLSchemeTask) {}
}

/** A finished rendering: the card as a PDF page (vector: drawn at any scale) and its measured size in points */
struct NotePDF {
  var doc: CGPDFDocument
  var w: CGFloat
  var h: CGFloat
  /** The PDF's size in memory (the cache is bounded by it) */
  var bytes = 0
  /** The PDF drawn into a bitmap, pixels = points × scale (off the main thread; the caller keeps the result) */
  func raster(scale: CGFloat) -> CGImage? {
    guard let page = doc.page(at: 1) else { return nil }
    let pw = max(1, Int((w * scale).rounded())), ph = max(1, Int((h * scale).rounded()))
    guard let ctx = CGContext(data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0, space: CardLayer.colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
    let box = page.getBoxRect(.mediaBox)
    ctx.scaleBy(x: CGFloat(pw) / box.width, y: CGFloat(ph) / box.height)
    ctx.translateBy(x: -box.minX, y: -box.minY)
    ctx.setAllowsFontSmoothing(true)
    ctx.setShouldSmoothFonts(true)
    ctx.interpolationQuality = .high
    ctx.drawPDFPage(page)
    return ctx.makeImage()
  }
}

/**
 * Renders Notes through one offscreen CardPage, one card at a time (the page has one stage), newest request first; a request
 * for a card still queued replaces it. The page lays the card out at its width and the app takes it as a PDF (WKWebView's
 * createPDF: the web process's print path, which needs no display, unlike takeSnapshot), cached by content + width + theme
 * (NotePDF); the layer rasterises it at the zoom bucket it needs. Render times are recorded (p50 / p95 for the auto report).
 */
final class NoteRenderer: NSObject {
  let page: CardPage
  /** The rendered PDFs, least recently used first, no more than `cacheBytes` together */
  private var cache: [String: NotePDF] = [:]
  private var order: [String] = []
  private var bytes = 0
  static let cacheBytes = 48 << 20
  /** Rendered PDFs kept on disk too (keyed by content, width, look and theme), so a board opened again shows its Notes' final
   *  pixels at once instead of a blank card while the page renders them */
  static let diskDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("CodeBoard/notes", isDirectory: true)
  private static let disk = DispatchQueue(label: "codeboard.notes.disk", qos: .utility)
  private static func file(_ key: String) -> URL { diskDir.appendingPathComponent(SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()) }
  /** At most this many files and bytes; the oldest go when there are more (checked once per launch) */
  static let diskFiles = 4000
  static let diskBytes = 256 << 20
  private static var pruned = false
  private static func prune() {
    guard !pruned else { return }
    pruned = true
    disk.async {
      try? FileManager.default.createDirectory(at: diskDir, withIntermediateDirectories: true)
      guard let all = try? FileManager.default.contentsOfDirectory(at: diskDir, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey]) else { return }
      let dated = all.map { u -> (URL, Date, Int) in
        let v = try? u.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        return (u, v?.contentModificationDate ?? .distantPast, v?.fileSize ?? 0)
      }.sorted { $0.1 < $1.1 }
      var count = dated.count, bytes = dated.reduce(0) { $0 + $1.2 }
      guard count > diskFiles || bytes > diskBytes else { return }
      // down to half of either bound, oldest first
      for (u, _, size) in dated where count > diskFiles / 2 || bytes > diskBytes / 2 {
        try? FileManager.default.removeItem(at: u)
        count -= 1
        bytes -= size
      }
    }
  }
  /** The PDF on disk for this key, read here (a few dozen KB; ~0.2 ms) */
  private func fromDisk(_ key: String) -> NotePDF? {
    let u = NoteRenderer.file(key)
    guard let data = try? Data(contentsOf: u.appendingPathExtension("pdf")), let doc = CGDataProvider(data: data as CFData).flatMap({ CGPDFDocument($0) }),
      let wh = try? String(contentsOf: u.appendingPathExtension("wh"), encoding: .utf8)
    else { return nil }
    let p = wh.split(separator: " ").compactMap { Double($0) }
    guard p.count == 2 else { return nil }
    return NotePDF(doc: doc, w: p[0], h: p[1], bytes: data.count)
  }
  private func toDisk(_ key: String, _ data: Data, w: CGFloat, h: CGFloat) {
    let u = NoteRenderer.file(key)
    NoteRenderer.disk.async {
      try? data.write(to: u.appendingPathExtension("pdf"), options: .atomic)
      try? "\(w) \(h)".write(to: u.appendingPathExtension("wh"), atomically: true, encoding: .utf8)
    }
  }
  private var queue: [(key: String, spec: CardSpec, done: (NotePDF) -> Void)] = []
  /** The request the page is rendering now (requests that come meanwhile go to the front of the queue), and its number: the
   *  page answers with it, so a late answer to an earlier request for the same card is not taken for this one */
  private var current: (key: String, spec: CardSpec, done: (NotePDF) -> Void)?
  private var req = 0
  private var busy: Bool { current != nil }
  /** The theme the page was told last ("" until the canvas tells it, with the look) */
  private var theme = ""
  /** The board's titles, as [[refs]] show them: a Note with refs is cached under them too */
  private var titlesKey = ""
  /** WebKit gives an occluded window's pages no rendering updates: while the window is, nothing is asked of the page */
  private var paused = false
  private(set) var times: [Double] = []
  private(set) var snapTimes: [Double] = []
  /** The page is 1600 × 3200 points: a card wider or taller than that is cut (the widest Notes are ~1000) */
  static let pageSize = CGSize(width: 1600, height: 3200)
  /** A render the page does not answer within this is dropped (the layer asks again when it is next displayed) */
  static let timeout: TimeInterval = 6
  var debugLog = CommandLine.arguments.contains("--log-web")

  override init() {
    page = CardPage(frame: CGRect(origin: .zero, size: NoteRenderer.pageSize))
    super.init()
    page.onMessage = { [weak self] m in self?.message(m) }
    // the page starts over (first load, or after its process died): its theme and titles again, the render in flight re-asked
    page.onReady = { [weak self] in
      guard let self else { return }
      if !self.theme.isEmpty { self.page.call("cb.setup(\(encodeJSON(["theme": self.theme, "look": Theme.look])))") }
      if let t = self.titles { self.page.call("cb.setup(\(encodeJSON(["titles": t])))") }
    }
    page.onTerminated = { [weak self] in
      guard let self else { return }
      if let c = self.current { self.queue.insert(c, at: 0) }
      self.current = nil
      self.pump()
    }
    NoteRenderer.prune()
    NotificationCenter.default.addObserver(self, selector: #selector(occlusionChanged(_:)), name: NSWindow.didChangeOcclusionStateNotification, object: nil)
  }
  @objc private func occlusionChanged(_ n: Notification) {
    guard let w = page.web.window, (n.object as? NSWindow) === w else { return }
    paused = !w.occlusionState.contains(.visible)
    if !paused { pump() }
  }

  func setTheme(_ t: String) {
    guard t != theme else { return }
    theme = t
    clear()
    page.call("cb.setup(\(encodeJSON(["theme": t, "look": Theme.look])))")
  }
  private var titles: [[String: String]]?
  func setTitles(_ titles: [[String: String]]) {
    self.titles = titles
    titlesKey = SHA256.hash(data: Data(titles.map { "\($0["id"] ?? "")=\($0["title"] ?? "")" }.joined(separator: "|").utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    page.call("cb.setup(\(encodeJSON(["titles": titles])))")
  }
  private func clear() {
    cache = [:]
    order = []
    bytes = 0
  }
  /** The card page bundle's identity (Vite names its files by content): a rebuilt page never reads the old page's renders */
  private static let bundleKey: String = {
    let dir = CardPage.pageDir.appendingPathComponent("assets")
    let names = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).sorted().joined(separator: "\n")
    return SHA256.hash(data: Data(names.utf8)).prefix(6).map { String(format: "%02x", $0) }.joined()
  }()
  private func key(_ spec: CardSpec) -> String { "\(NoteRenderer.bundleKey)|\(theme)|\(spec.md.contains("[[") ? titlesKey : "")|\(spec.key)" }
  private func hit(_ key: String) -> NotePDF? {
    guard let pdf = cache[key] else {
      guard let pdf = fromDisk(key) else { return nil }
      diskHits += 1
      keep(key, pdf)
      return pdf
    }
    if let i = order.firstIndex(of: key) {
      order.remove(at: i)
      order.append(key)
    }
    return pdf
  }
  private(set) var diskHits = 0
  private func keep(_ key: String, _ pdf: NotePDF) {
    if let old = cache[key] { bytes -= old.bytes } else { order.append(key) }
    cache[key] = pdf
    bytes += pdf.bytes
    while bytes > NoteRenderer.cacheBytes, order.count > 1 {
      let k = order.removeFirst()
      bytes -= cache.removeValue(forKey: k)?.bytes ?? 0
    }
  }

  /** The PDF if it is already there (a lookup), else nil and `done` is called once it is rendered */
  @discardableResult
  func render(_ spec: CardSpec, done: @escaping (NotePDF) -> Void) -> NotePDF? {
    let key = key(spec)
    if let pdf = hit(key) { return pdf }
    queue.removeAll { $0.spec.id == spec.id }
    queue.insert((key, spec, done), at: 0)
    pump()
    return nil
  }

  private func pump() {
    guard !busy, !paused, !queue.isEmpty else { return }
    let r = queue.removeFirst()
    if let pdf = hit(r.key) {
      r.done(pdf)
      pump()
      return
    }
    current = r
    req += 1
    let mine = req
    if debugLog { logLine("[codeboard web] render %@ (#%d)", r.spec.id, mine) }
    page.call("cb.render(\(encodeJSON(r.spec)), 1, \(mine))")
    after(NoteRenderer.timeout) { [weak self] in
      guard let self, let c = self.current, c.key == r.key, self.req == mine else { return }
      logLine("[codeboard web] render of %@ did not answer in %.0f s: dropped", r.spec.id, NoteRenderer.timeout)
      self.current = nil
      // occluded meanwhile: the page could not answer; asked again once the window shows
      if self.paused { self.queue.append(c) }
      self.pump()
    }
  }

  private func message(_ m: [String: Any]) {
    if debugLog { logLine("[codeboard web] message %@ busy %d queue %d", m["type"] as? String ?? "?", busy ? 1 : 0, queue.count) }
    guard m["type"] as? String == "rendered", let r = current, m["id"] as? String == r.spec.id, (m["req"] as? Int) == req else { return }
    let w = (m["w"] as? Double) ?? r.spec.w, h = (m["h"] as? Double) ?? 60
    // shown either way; kept on disk only when the render settled on its own and threw nothing
    let clean = m["capped"] as? Bool != true && m["error"] as? Bool != true
    times.append(m["ms"] as? Double ?? 0)
    let ts = CACurrentMediaTime()
    let cfg = WKPDFConfiguration()
    cfg.rect = CGRect(x: 0, y: 0, width: ceil(w), height: ceil(h))
    var answered = false
    let finish = { [weak self] (doc: CGPDFDocument?, size: Int, how: String) in
      guard let self, !answered, self.current?.key == r.key else { return }
      answered = true
      self.snapTimes.append((CACurrentMediaTime() - ts) * 1000)
      if self.debugLog { logLine("[codeboard web] %@ answered in %.1f ms", how, (CACurrentMediaTime() - ts) * 1000) }
      self.current = nil
      if let doc {
        let pdf = NotePDF(doc: doc, w: w, h: h, bytes: size)
        self.keep(r.key, pdf)
        r.done(pdf)
      } else { logLine("[codeboard web] pdf failed for %@", r.spec.id) }
      self.pump()
    }
    page.web.createPDF(configuration: cfg) { res in
      switch res {
      case .success(let data):
        if clean { self.toDisk(r.key, data, w: w, h: h) }
        finish(CGDataProvider(data: data as CFData).flatMap { CGPDFDocument($0) }, data.count, "createPDF")
      case .failure(let err): logLine("[codeboard web] createPDF failed: %@", err.localizedDescription); finish(nil, 0, "createPDF")
      }
    }
    after(2) { [weak self] in
      guard let self, !answered else { return }
      logLine("[codeboard web] createPDF did not answer in 2 s: trying takeSnapshot")
      let sc = WKSnapshotConfiguration()
      sc.rect = cfg.rect ?? .zero
      sc.afterScreenUpdates = false
      self.page.web.takeSnapshot(with: sc) { img, err in
        if let err { logLine("[codeboard web] takeSnapshot failed: %@", err.localizedDescription) }
        finish(img.flatMap { Self.pdfFrom($0) }, Int((img?.size.width ?? 0) * (img?.size.height ?? 0) * 4), "takeSnapshot")
      }
      // neither answered: the render is dropped (the page may be wedged; the layer asks again when it is next displayed)
      after(2) { finish(nil, 0, "timeout") }
    }
  }
  /** A bitmap wrapped as a one-page PDF (the fallback path's result in the renderer's shape) */
  private static func pdfFrom(_ img: NSImage) -> CGPDFDocument? {
    guard let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
    let data = NSMutableData()
    var box = CGRect(origin: .zero, size: img.size)
    guard let cons = CGDataConsumer(data: data), let ctx = CGContext(consumer: cons, mediaBox: &box, nil) else { return nil }
    ctx.beginPDFPage(nil)
    ctx.draw(cg, in: box)
    ctx.endPDFPage()
    ctx.closePDF()
    return CGDataProvider(data: data).flatMap { CGPDFDocument($0) }
  }

  /** p50 / p95 of the page's render time and of taking the PDF, ms */
  func stats() -> [String: Double] {
    func pct(_ xs: [Double], _ p: Double) -> Double { let s = xs.sorted(); return s.isEmpty ? 0 : s[min(s.count - 1, Int(Double(s.count) * p))] }
    return ["render_p50_ms": pct(times, 0.5), "render_p95_ms": pct(times, 0.95), "pdf_p50_ms": pct(snapTimes, 0.5), "pdf_p95_ms": pct(snapTimes, 0.95), "count": Double(times.count), "disk_hits": Double(diskHits), "total_ms": times.reduce(0, +) + snapTimes.reduce(0, +)]
  }
}

/** The card being edited: a visible CardPage placed over the card, following the camera, the editor in it */
final class EditCard {
  let page: CardPage
  private(set) var card: SceneCard?
  private(set) var kind = "note"
  private(set) var original = ""
  private(set) var contentHeight: CGFloat = 0
  /** The text was handed over while editing (written through core already) */
  private(set) var changed = false
  private var t0: CFTimeInterval = 0
  /** The editor is on screen (painted): the time from begin to it, ms */
  private(set) var enterMs: Double = 0
  var onPainted: ((String) -> Void)?
  var onDone: ((String, String?) -> Void)?
  var onHeight: ((String, CGFloat) -> Void)?
  var onTyped: (([Double], [Double]) -> Void)?
  /** The text as edited so far, every LIVE_WRITE while it changes (the app writes it through core: a crash loses at most that) */
  var onChanged: ((String, String) -> Void)?

  init() {
    page = CardPage(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
    // never hidden (a hidden web view runs no animation frames, so the page could not tell when it painted): alpha 0 instead
    page.web.alphaValue = 0
    page.onMessage = { [weak self] m in self?.message(m) }
    // the content process died under an edit: the text as of the last live write is what the card keeps (written through core
    // already); the editor closes and the user is told
    page.onTerminated = { [weak self] in
      guard let self, let c = self.card else { return }
      self.card = nil
      self.shown = false
      self.onCrashed?(c.id)
    }
  }
  var onCrashed: ((String) -> Void)?
  /** The air around the card the view keeps, in points at zoom 1: the selection ring and Ink Wash's paper reach outside the
   *  card (web/main.ts EDIT_EDGE) */
  static let edge: CGFloat = 16
  /** Shown over the card (true) or out of sight (false); onShown tells the canvas (the card's own bitmap hides under it) */
  var shown: Bool {
    get { view.alphaValue > 0 }
    set {
      view.alphaValue = newValue ? 1 : 0
      onShown?(newValue)
    }
  }
  var onShown: ((Bool) -> Void)?
  var view: WKWebView { page.web }
  var active: Bool { card != nil }
  /** The view's height is the card's rounded up to a step with air below, so a line wrap does not resize the web view (a
   *  WKWebView resize lays the page out and paints it whole: 40 ms frames while typing); below the card it lets clicks through */
  static let slack: CGFloat = 240
  private var lastZoom: CGFloat = 0
  private func place(frame: CGRect, zoom: CGFloat) {
    let frame = panel ? CGRect(x: frame.minX + panelOffset * zoom, y: frame.minY, width: 320 * zoom, height: frame.height) : frame
    let e = EditCard.edge * zoom
    let want = max(frame.height, contentHeight * zoom) + 2 * e
    let h = ceil(want / (EditCard.slack * zoom)) * EditCard.slack * zoom
    let f = CGRect(x: frame.minX - e, y: frame.minY - e, width: frame.width + 2 * e, height: h)
    if view.frame != f { view.frame = f }
    (view as? CardWeb)?.hitHeight = want
  }
  /** The editor built ahead of the first edit (and a card's text parsed ahead: the one selected, as the board does) */
  func warm(_ text: String? = nil) { page.call("cb.warm(\(text.map { encodeJSON($0) } ?? ""))") }

  func begin(_ c: SceneCard, text: String, kind: String, lang: String?, frame: CGRect, zoom: CGFloat) {
    card = c
    self.kind = kind
    original = text
    changed = false
    t0 = CACurrentMediaTime()
    contentHeight = frame.height / zoom
    lastZoom = zoom
    panelOffset = 0
    place(frame: frame, zoom: zoom)
    var spec = CardSpec(c, text: text, lang: lang)
    spec.kind = kind
    page.call("cb.edit(\(encodeJSON(spec)), \(zoom))")
  }
  /** The card's sidenotes panel (the page's cb.sidenotes), to the right of the card: frame = the card's, in view coordinates */
  func beginSidenotes(_ c: SceneCard, items: [JSBridge.SidenoteText], open: String?, frame: CGRect, zoom: CGFloat) {
    card = c
    kind = "sidenotes"
    original = ""
    changed = false
    t0 = CACurrentMediaTime()
    contentHeight = 80
    lastZoom = zoom
    panelOffset = frame.width / zoom + 12
    place(frame: frame, zoom: zoom)
    page.call("cb.sidenotes(\(encodeJSON(["id": c.id, "title": c.title])), \(encodeJSON(items)), \(zoom), \(open.map { encodeJSON($0) } ?? "undefined"))")
  }
  /** A sidenotes panel sits this far right of its card's left edge (world units); 0 for an editor over the card */
  private var panelOffset: CGFloat = 0
  var panel: Bool { kind == "sidenotes" }
  /** The panel's own messages: sidenote (sn, value), sidenoteDelete (sn), sidenoteAdd */
  var onPanel: ((String, String, [String: Any]) -> Void)?
  /** The camera moved: the view follows the card */
  func follow(frame: CGRect, zoom: CGFloat) {
    guard active else { return }
    place(frame: frame, zoom: zoom)
    if zoom != lastZoom {
      lastZoom = zoom
      page.call("cb.zoom(\(zoom))")
    }
  }
  /** Stop editing (click outside, a board switch); the text as edited, or nil when the edit was already over */
  func end(_ done: @escaping (String?) -> Void) {
    guard card != nil else { return done(nil) }
    card = nil
    page.call("cb.endEdit()") { [weak self] v in
      self?.shown = false
      done(v as? String)
    }
  }
  private func message(_ m: [String: Any]) {
    if CommandLine.arguments.contains("--log-web") { logLine("[codeboard edit] message %@ for %@ h %.0f (content %.0f, frame %@)", m["type"] as? String ?? "?", m["id"] as? String ?? "-", m["h"] as? Double ?? -1, contentHeight, "\(view.frame)") }
    guard let c = card, m["id"] as? String == c.id, let type = m["type"] as? String else { return }
    switch type {
    case "painted":
      enterMs = (CACurrentMediaTime() - t0) * 1000
      if let h = m["h"] as? Double, h != contentHeight {
        contentHeight = h
        onHeight?(c.id, h)
      }
      shown = true
      view.window?.makeFirstResponder(view)
      onPainted?(c.id)
    case "height":
      if let h = m["h"] as? Double, h != contentHeight {
        contentHeight = h
        onHeight?(c.id, h)
      }
    case "sidenote", "sidenoteDelete", "sidenoteAdd":
      onPanel?(c.id, type, m)
    case "typed":
      if let js = m["js"] as? [Double], let fr = m["frame"] as? [Double] {
        let p95 = { (a: [Double]) -> Double in let s = a.sorted(); return s.isEmpty ? 0 : s[min(s.count - 1, Int(Double(s.count) * 0.95))] }
        let lay = m["layout"] as? [Double] ?? []
        logLine("[codeboard edit] typed %d: js p50 %.1f p95 %.1f ms, layout p95 %.1f max %.1f ms, to next frame p50 %.1f p95 %.1f max %.1f ms", js.count, js.sorted()[js.count / 2], p95(js), p95(lay), lay.max() ?? 0, fr.sorted()[fr.count / 2], p95(fr), fr.max() ?? 0)
        logLine("[codeboard edit] frames over 9 ms: %@", fr.enumerated().filter { $0.element > 9 }.map { "#\($0.offset) \(Int($0.element)) (layout \(Int(lay.indices.contains($0.offset) ? lay[$0.offset] : 0)))" }.joined(separator: " "))
        for s in m["slow"] as? [String] ?? [] { logLine("[codeboard edit] slow callback %@", s) }
        onTyped?(js, fr)
      }
    case "changed":
      if let v = m["value"] as? String {
        changed = true
        onChanged?(c.id, v)
      }
    case "done":
      // Esc / ⌘↵ inside the editor: the value as edited (null = unchanged); the view stays until the card shows the text
      card = nil
      onDone?(c.id, m["value"] is NSNull ? nil : m["value"] as? String)
    default: break
    }
  }
}

/** The card pages' web view: the editor's lets clicks below `hitHeight` through to the canvas (its frame has air below the card) */
final class CardWeb: WKWebView {
  var hitHeight: CGFloat?
  override func hitTest(_ point: NSPoint) -> NSView? {
    if let h = hitHeight, let sv = superview, convert(point, from: sv).y > h { return nil }
    return super.hitTest(point)
  }
}

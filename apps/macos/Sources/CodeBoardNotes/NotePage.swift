import AppKit
import CodeBoardModel
import WebKit

/// The Note page in its one web view. WebKit paints, and runs the animation frames the page waits for, only while it
/// counts the view as visible, which by default means its window is on screen and not covered (and the app pumps the
/// events that report this). With that check off (WebKit's `_windowOcclusionDetectionEnabled`, the one private switch
/// for it) a window ordered in but far off screen is enough: nothing shows, nothing covers it, no Space or full-screen
/// app hides it. Closing the window and letting go of the view ends the web process. Notes stay mounted in the page once
/// mounted (up to `cap`), so measuring a board is one layout pass and a picture at any scale is a snapshot.
@MainActor
final class NotePage {
  private let window: NSWindow
  private let view: WKWebView
  private let signal = ReadySignal()
  /// The Notes (and images) mounted, by id, with their size at 100 %; the most recently used last
  private var mounted: [String: CGSize] = [:]
  private var used: [String] = []
  /// The board theme and appearance the mounted Notes are drawn in: the page has one, and mounting a Note in another
  /// lets the rest go
  private var look = ""
  private var dark = false
  /// The size every mounted Note fits in: the window never gets smaller, as a code block draws only the lines in view
  private var extent = CGSize.zero
  /// What stays mounted: a board's Notes, at 3–5 MB of the web process each. Past it the least recently used go
  /// (mounting one again costs what its first picture did)
  static let cap = 48

  init(page: URL) throws {
    let html = page.appending(path: "page.html")
    guard FileManager.default.fileExists(atPath: html.path(percentEncoded: false)) else {
      throw NoteRenderError.pageMissing(page)
    }
    let config = WKWebViewConfiguration()
    config.suppressesIncrementalRendering = true
    config.userContentController.add(signal, name: "note")
    view = DrawOnlyWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 400), configuration: config)
    // the page is transparent: the canvas draws the card under the Note
    view.setValue(false, forKey: "drawsBackground")
    // the board's appearance, not the Mac's: a picture's prefers-color-scheme rules follow the board
    view.appearance = NSAppearance(named: .aqua)
    guard view.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) else {
      throw NoteRenderError.page("this WebKit has no _setWindowOcclusionDetectionEnabled:")
    }
    view.setValue(false, forKey: "windowOcclusionDetectionEnabled")
    window = NSWindow(
      contentRect: CGRect(origin: CGPoint(x: -30000, y: -30000), size: view.frame.size), styleMask: .borderless,
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.collectionBehavior = [.ignoresCycle, .transient]
    window.isExcludedFromWindowsMenu = true
    window.contentView = view
    window.orderFrontRegardless()
    // images resolve to file URLs anywhere: in board packages and the vault's shared cards, wherever the vault is
    view.loadFileURL(html, allowingReadAccessTo: URL(filePath: "/"))
  }

  isolated deinit {
    window.orderOut(nil)
    window.contentView = nil
    window.close()
  }

  typealias Measured = (size: CGSize, complete: Bool, blocks: [NoteBlock]?, refs: [NoteRefBox])

  /// Mounts the Notes not mounted yet (`id`: what the Note draws, its images included), all in the board theme `look`
  /// and appearance, in one layout pass, and returns every one's size at 100 % and whether every image came in
  func mount(_ notes: [(id: String, json: String, images: URL)], look: String, dark: Bool) async throws -> [String:
    Measured]
  {
    await signal.ready()
    adopt(look: look, dark: dark)
    let list = notes.map { n -> [String: Any] in
      ["id": n.id, "note": n.json, "images": n.images.absoluteString]
    }
    var r = try await call(
      "return await note.mount(list.map((l) => ({ id: l.id, note: JSON.parse(l.note), images: l.images })))",
      ["list": list])
    // every card whole in view at 100 %: code blocks draw only the lines in view and the rest would be missing; a few
    // rounds, as cards grow with each one
    for _ in 0..<4 {
      let need = r.values.reduce(extent) { $0.union($1.size) }
      guard !view.frame.size.contains(need) else { break }
      extent = need
      window.setContentSize(view.frame.size.union(need))
      r = try await call("return await note.measure(ids)", ["ids": Array(r.keys)])
    }
    for (id, v) in r { keep(id, v.size) }
    return r
  }

  /// Where each mounted Note's first glyph is from its top left at 100 % (nil: it has no text)
  func firstGlyphs(_ ids: [String]) async throws -> [String: CGPoint] {
    let r = try await view.callAsyncJavaScript("return note.first(ids)", arguments: ["ids": ids], contentWorld: .page)
    guard let d = r as? [String: Any] else { return [:] }
    return d.compactMapValues { v in
      guard let p = v as? [String: Double], let x = p["x"], let y = p["y"] else { return nil }
      return CGPoint(x: x, y: y)
    }
  }

  /// An image file as an image card shows it, `width` pixels wide at the window's backing scale (`stamp`: the file's
  /// size and time, so a file replaced under its name is shown again), and whether it came in. Mounted only for this
  func picture(of file: URL, stamp: String, width: Int, dark: Bool) async throws -> (NoteSnapshot, complete: Bool) {
    await signal.ready()
    adopt(look: look, dark: dark)
    let backing = window.backingScaleFactor
    let id = "image \(file.absoluteString) \(stamp) \(width)"
    let r = try await view.callAsyncJavaScript(
      "return await note.image(id, src, width, dark)",
      arguments: [
        "id": id, "src": file.absoluteString,
        "width": Double(width) / backing, "dark": dark,
      ], contentWorld: .page)
    defer { view.callAsyncJavaScript("note.drop([id])", arguments: ["id": id], in: nil, in: .page) }
    let size = try Self.size(r)
    window.setContentSize(view.frame.size.union(size.size))
    let shot = try await snapshot(id, size: size.size, scale: backing)
    return (shot.0, size.complete && shot.complete)
  }

  /// The page draws in one look and appearance (the page itself drops its Notes when either changes)
  private func adopt(look: String, dark: Bool) {
    guard look != self.look || dark != self.dark else { return }
    self.look = look
    if dark != self.dark { view.appearance = NSAppearance(named: dark ? .darkAqua : .aqua) }
    self.dark = dark
    mounted = [:]
    used = []
  }

  /// That Note's size at 100 % if it is mounted (it counts as used now)
  func mountedSize(_ id: String) -> CGSize? {
    guard let s = mounted[id] else { return nil }
    touch(id)
    return s
  }

  private func keep(_ id: String, _ size: CGSize) {
    mounted[id] = size
    touch(id)
    guard used.count > Self.cap else { return }
    let gone = Array(used.prefix(used.count - Self.cap))
    used.removeFirst(gone.count)
    for g in gone { mounted[g] = nil }
    view.callAsyncJavaScript("note.drop(ids)", arguments: ["ids": gone], in: nil, in: .page)
  }

  private func touch(_ id: String) {
    if let i = used.lastIndex(of: id) { used.remove(at: i) }
    used.append(id)
  }

  private func call(_ js: String, _ args: [String: Any]) async throws -> [String: Measured] {
    let r = try await view.callAsyncJavaScript(js, arguments: args, contentWorld: .page)
    guard let d = r as? [String: Any] else { throw NoteRenderError.page("the page answered \(String(describing: r))") }
    return try d.mapValues(Self.size)
  }

  private static func size(_ r: Any?) throws -> Measured {
    guard let d = r as? [String: Any], let w = d["width"] as? Double, let h = d["height"] as? Double else {
      throw NoteRenderError.page("the page answered \(String(describing: r))")
    }
    let blocks = (d["blocks"] as? [[String: Any]])?.compactMap { b -> NoteBlock? in
      guard let t = b["text"] as? String, let y = b["y"] as? Double, let h = b["h"] as? Double
      else { return nil }
      return NoteBlock(sig: BlockRef.sig(t), y: y, h: h, line: b["line"] as? Double ?? h)
    }
    let refs = (d["refs"] as? [[String: Any]] ?? []).compactMap { b -> NoteRefBox? in
      guard let x = b["x"] as? Double, let y = b["y"] as? Double, let w = b["w"] as? Double, let h = b["h"] as? Double
      else { return nil }
      return NoteRefBox(
        ref: b["ref"] as? String ?? "", target: b["target"] as? String, rect: CGRect(x: x, y: y, width: w, height: h))
    }
    return (CGSize(width: w, height: h), d["complete"] as? Bool ?? false, blocks, refs)
  }

  /// A mounted Note as `scale` device pixels per CSS px, covering whole pixels from its top left corner, and whether
  /// every image in it is in. Drawn the way the editor is shown at a zoom: the 100 % layout under a CSS transform, drawn
  /// at the window's backing scale.
  func snapshot(_ id: String, size: CGSize, scale: Double) async throws -> (NoteSnapshot, complete: Bool) {
    let backing = window.backingScaleFactor
    let px = (w: Int((size.width * scale).rounded(.up)), h: Int((size.height * scale).rounded(.up)))
    guard px.w > 0, px.h > 0 else { throw NoteRenderError.page("empty Note \(size)") }
    let points = CGSize(width: CGFloat(px.w) / backing, height: CGFloat(px.h) / backing)
    // never smaller than every mounted card at 100 %, which mount made sure are all in view
    window.setContentSize(points.union(extent).union(size))
    let shown = try await view.callAsyncJavaScript(
      "return await note.show(id, k)", arguments: ["id": id, "k": scale / backing], contentWorld: .page)
    guard let complete = shown as? Bool else { throw NoteRenderError.page("\(id) is not mounted") }
    let c = WKSnapshotConfiguration()
    c.rect = CGRect(origin: .zero, size: points)
    c.snapshotWidth = NSNumber(value: Double(points.width))
    c.afterScreenUpdates = true
    let image = try await view.takeSnapshot(configuration: c)
    guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let surface = NoteSnapshot.makeSurface(width: px.w, height: px.h)
    else { throw NoteRenderError.page("no snapshot") }
    NoteSnapshot.draw(cg, into: surface)
    return (NoteSnapshot(surface: surface, size: size), complete)
  }
}

/// Waits for the page's "ready" message
@MainActor
private final class ReadySignal: NSObject, WKScriptMessageHandler {
  private var isReady = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  func ready() async {
    if isReady { return }
    await withCheckedContinuation { waiting.append($0) }
  }

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    isReady = true
    for w in waiting { w.resume() }
    waiting = []
  }
}

/// Never takes the keyboard: the page mounts the editor to draw, and a web view that asks to become first responder
/// takes focus from the editor or field the user is typing in
extension CGSize {
  fileprivate func contains(_ s: CGSize) -> Bool { s.width <= width && s.height <= height }
  fileprivate func union(_ s: CGSize) -> CGSize { CGSize(width: max(width, s.width), height: max(height, s.height)) }
}

private final class DrawOnlyWebView: WKWebView {
  override var acceptsFirstResponder: Bool { false }
  override func becomeFirstResponder() -> Bool { false }
}

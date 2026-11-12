import AppKit
import WebKit

/// The Note page in its one web view. WebKit paints, and runs the animation frames the page waits for, only while it
/// counts the view as visible, which by default means its window is on screen and not covered (and the app pumps the
/// events that report this). With that check off (WebKit's `_windowOcclusionDetectionEnabled`, the one private switch
/// for it) a window ordered in but far off screen is enough: nothing shows, nothing covers it, no Space or full-screen
/// app hides it. Closing the window and letting go of the view ends the web process.
@MainActor
final class NotePage {
  private let window: NSWindow
  private let view: WKWebView
  private let signal = ReadySignal()
  /// The Note on the page now (its JSON and image folder), so a snapshot at another scale draws nothing again
  private var shown: (note: String, folder: URL, size: CGSize, complete: Bool)?
  /// The CSS scale the shown Note is under (show puts it back to 1)
  private var zoom = 1.0

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

  /// Shows the Note (unless it is the one shown) and returns its size at 100 % and whether every image came in
  func show(note: String, folder: URL) async throws -> (size: CGSize, complete: Bool) {
    if let s = shown, s.note == note, s.folder == folder { return (s.size, s.complete) }
    shown = nil
    await signal.ready()
    let images = folder.appending(path: "images", directoryHint: .notDirectory).absoluteString
    var r = try await call("return await note.show(JSON.parse(n), images)", ["n": note, "images": images])
    zoom = 1
    // the whole card in view at 100 %: code blocks draw only the lines in view and the rest would be missing; a few
    // rounds, as the card grows with each one
    for _ in 0..<4 where !view.frame.size.contains(r.size) {
      window.setContentSize(view.frame.size.union(r.size))
      r = try await call("return await note.measure()", [:])
    }
    shown = (note, folder, r.size, r.complete)
    return r
  }

  private func call(_ js: String, _ args: [String: Any]) async throws -> (size: CGSize, complete: Bool) {
    let r = try await view.callAsyncJavaScript(js, arguments: args, contentWorld: .page)
    guard let d = r as? [String: Any], let w = d["width"] as? Double, let h = d["height"] as? Double else {
      throw NoteRenderError.page("the page answered \(String(describing: r))")
    }
    return (CGSize(width: w, height: h), d["complete"] as? Bool ?? false)
  }

  /// The shown Note as `scale` device pixels per CSS px, covering whole pixels from its top left corner. Drawn the way
  /// the editor is shown at a zoom: the 100 % layout under a CSS transform, drawn at the window's backing scale.
  func snapshot(size: CGSize, scale: Double) async throws -> NoteSnapshot {
    let backing = window.backingScaleFactor
    let px = (w: Int((size.width * scale).rounded(.up)), h: Int((size.height * scale).rounded(.up)))
    guard px.w > 0, px.h > 0 else { throw NoteRenderError.page("empty Note \(size)") }
    let points = CGSize(width: CGFloat(px.w) / backing, height: CGFloat(px.h) / backing)
    // never smaller than the card at 100 %, which show made sure is all in view
    window.setContentSize(points.union(size))
    if scale / backing != zoom {
      zoom = scale / backing
      _ = try await view.callAsyncJavaScript("await note.scale(k)", arguments: ["k": zoom], contentWorld: .page)
    }
    let c = WKSnapshotConfiguration()
    c.rect = CGRect(origin: .zero, size: points)
    c.snapshotWidth = NSNumber(value: Double(points.width))
    c.afterScreenUpdates = true
    let image = try await view.takeSnapshot(configuration: c)
    guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let surface = NoteSnapshot.makeSurface(width: px.w, height: px.h)
    else { throw NoteRenderError.page("no snapshot") }
    NoteSnapshot.draw(cg, into: surface)
    return NoteSnapshot(surface: surface, size: size)
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

import AppKit
import WebKit

/// The SVG page (svg.html of the assets build) in its one web view. WebKit paints, and runs the animation frames the page
/// waits for, only while it counts the view as visible, which by default means its window is on screen and not covered.
/// With that check off (WebKit's `_windowOcclusionDetectionEnabled`, the one private switch for it) a window ordered in
/// but far off screen is enough: nothing shows, nothing covers it, no Space or full-screen app hides it. Closing the
/// window and letting go of the view ends the web process.
@MainActor
final class SVGPage {
  private let window: NSWindow
  private let view: WKWebView
  private let signal = ReadySignal()
  private var dark = false
  /// how long each step may take: the page loading, the script, the snapshot
  private let limit: Duration

  init(assets: URL, limit: Duration) throws {
    self.limit = limit
    let html = assets.appending(path: "svg.html")
    guard FileManager.default.fileExists(atPath: html.path(percentEncoded: false)) else {
      throw SVGError.pageMissing(assets)
    }
    let config = WKWebViewConfiguration()
    config.suppressesIncrementalRendering = true
    config.userContentController.add(signal, name: "svg")
    view = DrawOnlyWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 400), configuration: config)
    // the page is transparent: the canvas draws the card under the picture
    view.setValue(false, forKey: "drawsBackground")
    // the board's appearance, not the Mac's: a picture's prefers-color-scheme rules follow the board
    view.appearance = NSAppearance(named: .aqua)
    guard view.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) else {
      throw SVGError.page("this WebKit has no _setWindowOcclusionDetectionEnabled:")
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

  isolated deinit { close() }

  /// Stops it for good (a step that timed out may still hold it): its web process ends with the view
  func close() {
    view.stopLoading()
    window.orderOut(nil)
    window.contentView = nil
    window.close()
  }

  /// The file as an image card shows it, `width` pixels wide at the window's backing scale (`stamp`: the file's size and
  /// time, so a file replaced under its name is shown again), and whether it came in
  func picture(of file: URL, stamp: String, width: Int, dark: Bool) async throws -> (SVGPicture, complete: Bool) {
    let signal = self.signal
    try await bounded(limit, "the SVG page did not load") { await signal.ready() }
    if dark != self.dark {
      view.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
      self.dark = dark
    }
    let backing = window.backingScaleFactor
    let view = self.view
    let src = file.absoluteString
    let shown = try await bounded(limit, "the SVG page did not draw \(file.lastPathComponent)") {
      () -> (w: Double, h: Double, complete: Bool) in
      let r = try await view.callAsyncJavaScript(
        "return await svg.show(src, width)", arguments: ["src": src, "width": Double(width) / backing],
        contentWorld: .page)
      guard let d = r as? [String: Any], let w = d["width"] as? Double, let h = d["height"] as? Double, w > 0, h > 0
      else { throw SVGError.page("the page answered \(String(describing: r))") }
      return (w, h, d["complete"] as? Bool ?? false)
    }
    let size = CGSize(width: shown.w, height: shown.h)
    let px = (w: Int((shown.w * backing).rounded(.up)), h: Int((shown.h * backing).rounded(.up)))
    let points = CGSize(width: CGFloat(px.w) / backing, height: CGFloat(px.h) / backing)
    let frame = view.frame.size
    window.setContentSize(CGSize(width: max(frame.width, points.width), height: max(frame.height, points.height)))
    let c = WKSnapshotConfiguration()
    c.rect = CGRect(origin: .zero, size: points)
    c.snapshotWidth = NSNumber(value: Double(points.width))
    c.afterScreenUpdates = true
    let picture = try await bounded(limit, "no snapshot of \(file.lastPathComponent)") { () -> SVGPicture in
      let image = try await view.takeSnapshot(configuration: c)
      guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
        let surface = SVGPicture.makeSurface(width: px.w, height: px.h)
      else { throw SVGError.page("no snapshot") }
      SVGPicture.draw(cg, into: surface)
      return SVGPicture(surface: surface, size: size)
    }
    return (picture, shown.complete)
  }
}

/// The step's result, or `SVGError.timedOut` once `limit` has passed: whichever comes first. A step WebKit never answers
/// is left behind (the caller closes the page), not waited for
@MainActor
func bounded<T: Sendable>(_ limit: Duration, _ what: String, _ step: @escaping @MainActor () async throws -> T)
  async throws -> T
{
  let first = First<T>()
  return try await withCheckedThrowingContinuation { c in
    first.continuation = c
    Task { @MainActor in
      do { first.resume(.success(try await step())) } catch { first.resume(.failure(error)) }
    }
    Task { @MainActor in
      try? await Task.sleep(for: limit)
      first.resume(.failure(SVGError.timedOut(what)))
    }
  }
}

/// Resumes a continuation once, with the first result
@MainActor
private final class First<T: Sendable> {
  var continuation: CheckedContinuation<T, any Error>?
  func resume(_ r: Result<T, any Error>) {
    continuation?.resume(with: r)
    continuation = nil
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

/// Never takes the keyboard: a web view that asks to become first responder takes focus from the field the user is
/// typing in
private final class DrawOnlyWebView: WKWebView {
  override var acceptsFirstResponder: Bool { false }
  override func becomeFirstResponder() -> Bool { false }
}

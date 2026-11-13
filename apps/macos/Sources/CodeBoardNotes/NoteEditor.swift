import AppKit
import CodeBoardModel
import CryptoKit
import ImageIO
import UniformTypeIdentifiers
import WebKit

/// The Note page's editor in a web view of its own that takes the keyboard (page.html?edit): one Note, Text or Box at a
/// time, laid out as the snapshots are (same page, same editor, the 100 % layout under a CSS transform), so what is shown
/// while editing is what the canvas shows at rest, apart from the caret. The card sits `margin` points in from the web
/// view's top left so the editor's menus have room; the pointer goes through the web view everywhere but on the card and
/// on the editor's own menus. Made once and kept: entering editing only mounts the Note.
@MainActor
public final class NoteEditor: NSObject {
  /// What the editing ended with: the Markdown written (nil: unchanged) and the layout, and whether the layout changed
  public struct Written: Sendable {
    public var text: String?
    public var layout: NoteLayout?
    public var layoutChanged: Bool
  }

  public let view: EditorWebView
  /// The card's size at 100 % as it changes while typing
  public var onSize: ((CGSize) -> Void)?
  /// The editor left by itself (Esc), with what was written
  public var onDone: ((Written) -> Void)?
  /// Where a pasted or dropped picture is stored: the folder whose `images/` it goes into (the board's package)
  public var imagesFolder: URL?
  private let signal = EditorSignal()

  public init(page: URL = NoteRenderer.bundledPage) {
    let config = WKWebViewConfiguration()
    view = EditorWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 300), configuration: config)
    super.init()
    config.userContentController.add(signal, name: "note")
    config.userContentController.addScriptMessageHandler(ImageSaver(self), contentWorld: .page, name: "image")
    view.setValue(false, forKey: "drawsBackground")
    view.shown = false
    signal.editor = self
    var url = page.appending(path: "page.html")
    url.append(queryItems: [URLQueryItem(name: "edit", value: nil)])
    view.loadFileURL(url, allowingReadAccessTo: URL(filePath: "/"))
  }

  func ready() async { await signal.ready() }

  /// Draws, and runs the page's animation frames, in a window that is off screen (tests and the review sheets): WebKit
  /// otherwise counts such a view as hidden (as NotePage)
  package func drawOffScreen() {
    view.setValue(false, forKey: "windowOcclusionDetectionEnabled")
  }

  /// Mounts `note` (on a card `width` wide, `height` tall or as tall as its content) in the board theme `look` and
  /// appearance, at zoom `k`, its card `margin` points in, the caret at `caret` (card points at 100 %) or at the end, and
  /// takes the keyboard; returns its size at 100 %
  public func begin(
    _ note: NoteBody, width: Double, height: Double?, folder: URL, look: String, dark: Bool, refs: [NoteRef] = [],
    k: Double, margin: Double, caret: CGPoint?, placeholder: String
  ) async throws -> CGSize {
    await ready()
    view.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    view.cardRect = .zero
    view.uiRects = []
    let json = try PageNote(note, width: width, height: height, look: look, dark: dark, refs: refs).json()
    let args: [String: Any] = [
      "note": json, "images": NoteRenderer.images(folder).absoluteString, "k": k, "margin": margin,
      "placeholder": placeholder, "caret": caret.map { ["x": $0.x, "y": $0.y] } ?? NSNull(),
    ]
    let r = try await view.callAsyncJavaScript(
      "return await edit.begin({note: JSON.parse(note), images, k, margin, caret, placeholder})", arguments: args,
      contentWorld: .page)
    guard let d = r as? [String: Any], let w = d["width"] as? Double, let h = d["height"] as? Double else {
      throw NoteRenderError.page("the editor answered \(String(describing: r))")
    }
    let size = CGSize(width: w, height: h)
    place(size: size, k: k, margin: margin)
    return size
  }

  /// Where the card is in the web view (its points), for letting the pointer through around it
  public func place(size: CGSize, k: Double, margin: Double) {
    view.cardRect = CGRect(x: margin, y: margin, width: size.width * k, height: size.height * k)
  }

  /// Shown at zoom `k`; returns once drawn so
  public func zoom(_ k: Double) async {
    _ = try? await view.callAsyncJavaScript("await edit.zoom(k)", arguments: ["k": k], contentWorld: .page)
  }

  /// What the card shows now (its content, over nothing), as the canvas's bitmap of it: for a zoom, during which the
  /// canvas scales a bitmap in its place. `size`: the card at 100 %, shown at `k`
  public func snapshot(size: CGSize, k: Double) async -> NoteSnapshot? {
    let c = WKSnapshotConfiguration()
    c.rect = view.cardRect
    c.afterScreenUpdates = false
    guard view.cardRect.width > 0, let image = try? await view.takeSnapshot(configuration: c),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let surface = NoteSnapshot.makeSurface(width: cg.width, height: cg.height)
    else { return nil }
    NoteSnapshot.draw(cg, into: surface)
    return NoteSnapshot(surface: surface, size: size)
  }

  /// Text typed before the editor was there (keys pressed while it mounted)
  public func type(_ text: String) {
    view.callAsyncJavaScript("edit.type(t)", arguments: ["t": text], in: nil, in: .page)
  }

  /// Ends the editing: what was written; the content stays shown until `clear`
  public func finish() async -> Written? {
    guard let r = try? await view.callAsyncJavaScript("return edit.finish()", contentWorld: .page) else { return nil }
    return Self.written(r)
  }

  /// Lets the card go (once the canvas shows its picture under the web view)
  public func clear() {
    view.callAsyncJavaScript("edit.clear()", arguments: [:], in: nil, in: .page)
    view.cardRect = .zero
    view.uiRects = []
  }

  nonisolated static func written(_ r: Any?) -> Written? {
    guard let d = r as? [String: Any] else { return nil }
    var layout: NoteLayout?
    if let l = d["layout"], !(l is NSNull), let data = try? JSONSerialization.data(withJSONObject: l) {
      layout = try? JSONDecoder().decode(NoteLayout.self, from: data)
    }
    return Written(text: d["text"] as? String, layout: layout, layoutChanged: d["layoutChanged"] as? Bool ?? false)
  }

  fileprivate func received(_ body: Any) {
    if let s = body as? String, s == "ready" {
      return
    }
    guard let m = body as? [String: Any], let type = m["type"] as? String else { return }
    switch type {
    case "size":
      if let w = m["width"] as? Double, let h = m["height"] as? Double { onSize?(CGSize(width: w, height: h)) }
    case "done":
      if let w = Self.written(m) { onDone?(w) }
    case "ui":
      let rects = (m["rects"] as? [[String: Double]]) ?? []
      view.uiRects = rects.map {
        CGRect(x: $0["x"] ?? 0, y: $0["y"] ?? 0, width: $0["width"] ?? 0, height: $0["height"] ?? 0)
      }
    default: break
    }
  }

  // MARK: Pictures pasted or dropped

  /// Stores a picture given as a data: URL in `images/` of `folder` as the old host named them (the first 16 hex digits
  /// of its SHA-1, its size in pixels, its type: `<sha>-<w>x<h>.<ext>`; an SVG without a size `<sha>.svg`), written
  /// whole and never over a file of that name; returns its Markdown address, or nil when it is not a picture CodeBoard
  /// keeps (PNG, JPEG, WebP, GIF, SVG, up to 10 MB)
  public nonisolated static func store(dataURL: String, in folder: URL) throws -> String? {
    guard dataURL.hasPrefix("data:"), let comma = dataURL.firstIndex(of: ","),
      dataURL[..<comma].hasSuffix(";base64"),
      let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...]))
    else { return nil }
    guard data.count <= 10 << 20, let (ext, size) = kind(of: data) else { return nil }
    let sha = Insecure.SHA1.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(16)
    let name = size.map { "\(sha)-\($0.0)x\($0.1).\(ext)" } ?? "\(sha).\(ext)"
    let images = folder.appending(path: Vault.imagesFolder)
    try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
    let file = images.appending(path: name)
    if !FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) {
      // whole or not at all, and never over a file of that name (moving does not overwrite)
      let temp = images.appending(path: ".\(name).\(UUID().uuidString)")
      try data.write(to: temp)
      do { try FileManager.default.moveItem(at: temp, to: file) } catch {
        try? FileManager.default.removeItem(at: temp)
      }
    }
    return "\(Vault.imagesFolder)/\(name)"
  }

  /// The picture's type by its first bytes, and its size in pixels when it has one
  nonisolated static func kind(of data: Data) -> (String, (Int, Int)?)? {
    let head = [UInt8](data.prefix(16))
    let ext: String
    if head.starts(with: [0x89, 0x50, 0x4E, 0x47]) {
      ext = "png"
    } else if head.starts(with: [0xFF, 0xD8, 0xFF]) {
      ext = "jpg"
    } else if head.starts(with: Array("GIF8".utf8)) {
      ext = "gif"
    } else if head.count >= 12, head.starts(with: Array("RIFF".utf8)), Array(head[8..<12]) == Array("WEBP".utf8) {
      ext = "webp"
    } else if let text = String(data: data.prefix(1024), encoding: .utf8), text.contains("<svg") {
      return ("svg", nil)
    } else {
      return nil
    }
    guard let src = CGImageSourceCreateWithData(data as CFData, nil),
      let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
      let w = p[kCGImagePropertyPixelWidth] as? Int, let h = p[kCGImagePropertyPixelHeight] as? Int
    else { return nil }
    return (ext, (w, h))
  }
}

/// The editing web view: takes the keyboard; lets the pointer through outside its card and the editor's menus
public final class EditorWebView: WKWebView {
  /// The card and the editor's open menus, in the view's points (top left origin)
  package var cardRect = CGRect.zero
  package var uiRects: [CGRect] = []

  /// Shown or not; one out of sight still lays out and draws (a hidden web view runs no animation frames, which the
  /// editor waits on while it mounts)
  public var shown: Bool {
    get { alphaValue > 0 }
    set { alphaValue = newValue ? 1 : 0 }
  }

  public override func hitTest(_ point: NSPoint) -> NSView? {
    guard shown, let sv = superview else { return nil }
    let p = convert(point, from: sv)
    // a WKWebView is flipped
    let inside = cardRect.insetBy(dx: -6, dy: -6).contains(p) || uiRects.contains { $0.contains(p) }
    return inside ? super.hitTest(point) : nil
  }
}

@MainActor
private final class EditorSignal: NSObject, WKScriptMessageHandler {
  weak var editor: NoteEditor?
  private var isReady = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  func ready() async {
    if isReady { return }
    await withCheckedContinuation { waiting.append($0) }
  }

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    if message.body as? String == "ready" {
      isReady = true
      for w in waiting { w.resume() }
      waiting = []
      return
    }
    editor?.received(message.body)
  }
}

@MainActor
private final class ImageSaver: NSObject, WKScriptMessageHandlerWithReply {
  weak var editor: NoteEditor?
  init(_ e: NoteEditor) { editor = e }

  func userContentController(
    _ c: WKUserContentController, didReceive message: WKScriptMessage
  ) async -> (Any?, String?) {
    guard let m = message.body as? [String: Any], let url = m["dataUrl"] as? String, let folder = editor?.imagesFolder
    else { return (nil, nil) }
    let address = try? await Task.detached { try NoteEditor.store(dataURL: url, in: folder) }.value
    return (address ?? nil, nil)
  }
}

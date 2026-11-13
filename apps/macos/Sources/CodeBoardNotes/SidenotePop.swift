import AppKit
import CodeBoardModel
import WebKit

/// The sidenote popup: the web board's (ui/pops/notes.tsx), its markup and stylesheet, in a web view of its own over the
/// canvas (page.html?pop), so its slips, questions and the Notes' editor in its input are the web board's. One popup at
/// a time, kept while what it shows changes: `show` again with the same key updates it in place. The web view is the
/// popup and room around it (its shadow, and the [[ list below or above it); the pointer goes through it everywhere but
/// on the popup and the editor's menus. Its title bar is dragged natively (`onDrag`): the canvas moves the web view, the
/// page never lays out during a drag. Made once and kept.
@MainActor
public final class SidenotePop: NSObject {
  /// What the popup shows (pop.ts PopData)
  public struct Shown: Encodable, Sendable {
    public struct Answer: Encodable, Sendable {
      public var id: String
      public var md: String
      public init(id: String, md: String) {
        self.id = id
        self.md = md
      }
    }
    public struct Ask: Encodable, Sendable {
      public var done: Bool
      public var answers: [Answer]
      public init(done: Bool, answers: [Answer]) {
        self.done = done
        self.answers = answers
      }
    }
    public struct Head: Encodable, Sendable {
      public var title: String
      public var `where`: String
      public var version: String
      public init(title: String, where w: String, version: String) {
        self.title = title
        self.where = w
        self.version = version
      }
    }
    /// A sidenote: text (`md`, `q` when a question) or code (`head`, `start`, `html`: each line's highlighted HTML).
    /// `fixed`: shown, not changed here
    public struct Note: Encodable, Sendable {
      public var id: String
      public var fixed: Bool
      public var kind: String
      public var md: String?
      public var q: Ask?
      public var head: Head?
      public var start: Int?
      public var html: [String]?

      public static func text(_ id: String, _ md: String, q: Ask?, fixed: Bool = false) -> Note {
        Note(id: id, fixed: fixed, kind: "text", md: md, q: q)
      }
      public static func code(_ id: String, head: Head, start: Int, html: [String], fixed: Bool = false) -> Note {
        Note(id: id, fixed: fixed, kind: "code", head: head, start: start, html: html)
      }
    }

    public var key: String
    public var look: String
    public var dark: Bool
    public var range: String?
    public var title: String
    public var remove: String?
    public var notes: [Note]
    public var write: Bool
    public var ask: Bool
    public var focus: String?
    public var images: String
    public var refs: [NoteRef]
    public var refList: RefCandidates?

    public init(
      key: String, look: String, dark: Bool, range: String?, title: String, remove: String?, notes: [Note],
      write: Bool = false, ask: Bool = false, focus: String? = nil, folder: URL, refs: [NoteRef],
      refList: RefCandidates?
    ) {
      self.key = key
      self.look = look
      self.dark = dark
      self.range = range
      self.title = title
      self.remove = remove
      self.notes = notes
      self.write = write
      self.ask = ask
      self.focus = focus
      self.images = NoteRenderer.images(folder).absoluteString
      self.refs = refs
      self.refList = refList
    }
  }

  /// What the user did in it
  public enum Action: Equatable, Sendable {
    case add(String, ask: Bool)
    case write(String, String)
    case delete(String)
    case done(String, Bool)
    case answer(String, String)
    case writeAnswer(String, answer: String, String)
    /// The title bar's delete
    case remove
    case close
    case picked(group: String?, id: String)
  }

  /// The room around the popup in the web view: its shadow's on every side, and the [[ list's below it (or above,
  /// `roomAbove`), which the editor places inside the web view
  public static let margin: CGFloat = 24
  public static let room: CGFloat = 300

  public let view: PopWebView
  public var onAction: ((Action) -> Void)?
  /// Its size as it changes (an entry added, a code sidenote opened, the input growing)
  public var onSize: ((CGSize) -> Void)?
  /// Something in it is being written, or not any more
  public var onWriting: ((Bool) -> Void)?
  /// Its title bar dragged: by how much since the press (view points), and whether the drag ended
  public var onDrag: ((CGSize, _ ended: Bool) -> Void)?
  /// The key of what it shows, nil when it shows nothing
  public private(set) var key: String?
  public private(set) var size = CGSize.zero
  public private(set) var writing = false
  /// Where the room for the [[ list is: above the popup when it sits low in the window
  public private(set) var roomAbove = false
  private let signal = PopSignal()

  public init(page: URL = NoteRenderer.bundledPage) {
    let config = WKWebViewConfiguration()
    view = PopWebView(frame: CGRect(x: 0, y: 0, width: 500, height: 400), configuration: config)
    super.init()
    config.userContentController.add(signal, name: "note")
    view.setValue(false, forKey: "drawsBackground")
    view.alphaValue = 0
    signal.pop = self
    view.grip.onDrag = { [weak self] d, ended in self?.onDrag?(d, ended) }
    var url = page.appending(path: "page.html")
    url.append(queryItems: [URLQueryItem(name: "pop", value: nil)])
    view.loadFileURL(url, allowingReadAccessTo: URL(filePath: "/"))
  }

  func ready() async { await signal.ready() }

  /// Draws, and runs the page's animation frames, in a window that is off screen (tests and the review sheets)
  package func drawOffScreen() {
    view.setValue(false, forKey: "windowOcclusionDetectionEnabled")
  }

  /// The popup's top left in the web view
  public var origin: CGPoint {
    CGPoint(x: Self.margin, y: Self.margin + (roomAbove ? Self.room : 0))
  }

  /// The web view's frame (in its superview, flipped or not) for the popup's top left at `p` there
  public func frame(popupAt p: CGPoint, flipped: Bool) -> CGRect {
    let o = origin
    let w = size.width + 2 * Self.margin
    let h = size.height + 2 * Self.margin + Self.room
    return flipped
      ? CGRect(x: p.x - o.x, y: p.y - o.y, width: w, height: h)
      : CGRect(x: p.x - o.x, y: p.y + o.y - h, width: w, height: h)
  }

  /// Shows `d` (the same key: updated in place, what is being written kept), as tall as `maxHeight` at most, the room
  /// for the [[ list above it or below; returns its size once laid out
  @discardableResult
  public func show(_ d: Shown, maxHeight: CGFloat, roomAbove: Bool) async -> CGSize {
    await ready()
    view.appearance = NSAppearance(named: d.dark ? .darkAqua : .aqua)
    let same = key == d.key
    key = d.key
    if !same { self.roomAbove = roomAbove }
    guard let json = try? String(decoding: JSONEncoder().encode(d), as: UTF8.self) else { return size }
    let r: Any?
    do {
      r = try await view.callAsyncJavaScript(
        "return pop.show(JSON.parse(d), y, limit)",
        arguments: ["d": json, "y": origin.y, "limit": maxHeight], contentWorld: .page)
    } catch {
      print("pop.show", error)
      return size
    }
    if let m = r as? [String: Any], let w = m["width"] as? Double, let h = m["height"] as? Double {
      took(CGSize(width: w, height: h))
    }
    return size
  }

  /// Ends what is being written (what is written is kept: added, or saved) before the popup closes
  public func end() async {
    _ = try? await view.callAsyncJavaScript("pop.end()", contentWorld: .page)
  }

  /// Lets what it shows go; out of sight
  public func clear() {
    key = nil
    view.alphaValue = 0
    view.popRect = .zero
    view.uiRects = []
    view.callAsyncJavaScript("pop.clear()", arguments: [:], in: nil, in: .page)
  }

  /// Runs a page call (tests and the review sheets): pop.click(sel), pop.type(t), pop.press(key)
  package func run(_ js: String, _ args: [String: Any] = [:]) async -> Any? {
    try? await view.callAsyncJavaScript(js, arguments: args, contentWorld: .page)
  }

  private func took(_ s: CGSize) {
    size = s
    view.popRect = CGRect(origin: origin, size: s)
  }

  fileprivate func received(_ m: [String: Any]) {
    guard let type = m["type"] as? String else { return }
    let s = { (k: String) in m[k] as? String ?? "" }
    func rect(_ d: [String: Any]) -> CGRect {
      CGRect(
        x: d["x"] as? Double ?? 0, y: d["y"] as? Double ?? 0, width: d["width"] as? Double ?? 0,
        height: d["height"] as? Double ?? 0)
    }
    switch type {
    case "size":
      let c = CGSize(width: m["width"] as? Double ?? 0, height: m["height"] as? Double ?? 0)
      guard key != nil, c != size else { return }
      took(c)
      onSize?(c)
    case "grip":
      let o = origin
      view.grip.frame = rect(m).offsetBy(dx: o.x, dy: o.y)
    case "ui":
      view.uiRects = ((m["rects"] as? [[String: Any]]) ?? []).map(rect)
    case "writing":
      writing = m["on"] as? Bool ?? false
      onWriting?(writing)
    case "add": onAction?(.add(s("text"), ask: m["ask"] as? Bool ?? false))
    case "write": onAction?(.write(s("id"), s("text")))
    case "delete": onAction?(.delete(s("id")))
    case "done": onAction?(.done(s("id"), m["done"] as? Bool ?? false))
    case "answer": onAction?(.answer(s("id"), s("text")))
    case "writeAnswer": onAction?(.writeAnswer(s("id"), answer: s("answer"), s("text")))
    case "remove": onAction?(.remove)
    case "close": onAction?(.close)
    case "picked": onAction?(.picked(group: m["group"] as? String, id: s("id")))
    default: break
    }
  }
}

/// The popup's web view: lets the pointer through outside the popup and the editor's menus; its title bar is a native
/// view (`grip`) that takes the drag
public final class PopWebView: WKWebView {
  /// The popup and the editor's open menus, in the view's points (a WKWebView is flipped)
  package var popRect = CGRect.zero
  package var uiRects: [CGRect] = []
  package let grip = GripView()

  public override init(frame: CGRect, configuration: WKWebViewConfiguration) {
    super.init(frame: frame, configuration: configuration)
    addSubview(grip)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  public override func hitTest(_ point: NSPoint) -> NSView? {
    guard alphaValue > 0, let sv = superview else { return nil }
    let p = convert(point, from: sv)
    if uiRects.contains(where: { $0.contains(p) }) { return super.hitTest(point) }
    if grip.frame.contains(p) { return grip }
    return popRect.contains(p) ? super.hitTest(point) : nil
  }
}

/// The popup's title bar, but its buttons: a press and drag moves the popup (the canvas moves the web view)
public final class GripView: NSView {
  var onDrag: ((CGSize, Bool) -> Void)?
  private var from: CGPoint?

  public override var isFlipped: Bool { true }
  public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  public override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }

  public override func mouseDown(with e: NSEvent) {
    from = e.locationInWindow
    NSCursor.closedHand.push()
  }

  public override func mouseDragged(with e: NSEvent) {
    guard let f = from else { return }
    let p = e.locationInWindow
    onDrag?(CGSize(width: p.x - f.x, height: f.y - p.y), false)
  }

  public override func mouseUp(with e: NSEvent) {
    guard let f = from else { return }
    from = nil
    NSCursor.pop()
    let p = e.locationInWindow
    onDrag?(CGSize(width: p.x - f.x, height: f.y - p.y), true)
  }
}

@MainActor
private final class PopSignal: NSObject, WKScriptMessageHandler {
  weak var pop: SidenotePop?
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
    if let m = message.body as? [String: Any] { pop?.received(m) }
  }
}

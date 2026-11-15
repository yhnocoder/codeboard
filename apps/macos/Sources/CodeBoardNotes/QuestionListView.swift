import AppKit
import WebKit

/// The question list: the web board's (ui/QuestionList.tsx), its markup and stylesheet, in a web view of its own over
/// the canvas (page.html?pop, `qlist`). The web view is the list and room around it for its shadow; the pointer goes
/// through it everywhere but on the list. Made once and kept.
@MainActor
public final class QuestionListView: NSObject {
  /// What it lists (qlist.ts QData)
  public struct Shown: Encodable, Sendable {
    public struct Board: Encodable, Sendable {
      public var id: String
      public var name: String
      public init(id: String, name: String) {
        self.id = id
        self.name = name
      }
    }
    /// A question: its first line, where it is, resolved or not, when it was asked
    public struct Item: Encodable, Sendable {
      public var board: String
      public var note: String
      public var line: String
      public var `where`: String
      public var done: Bool
      public var at: Double
      public init(board: String, note: String, line: String, where w: String, done: Bool, at: Double) {
        self.board = board
        self.note = note
        self.line = line
        self.where = w
        self.done = done
        self.at = at
      }
    }
    public var look: String
    public var dark: Bool
    public var board: Board
    public var boards: [Board]
    public var questions: [Item]
    public init(look: String, dark: Bool, board: Board, boards: [Board], questions: [Item]) {
      self.look = look
      self.dark = dark
      self.board = board
      self.boards = boards
      self.questions = questions
    }
  }

  public static let margin: CGFloat = 24
  public let view: ListWebView
  /// A row picked: its board and question
  public var onPick: ((_ board: String, _ note: String) -> Void)?
  public var onClose: (() -> Void)?
  public var onSize: ((CGSize) -> Void)?
  public private(set) var size = CGSize.zero
  public private(set) var isOpen = false
  private let signal = ListSignal()

  public init(page: URL = NoteRenderer.bundledPage) {
    let config = WKWebViewConfiguration()
    view = ListWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 480), configuration: config)
    super.init()
    config.userContentController.add(signal, name: "note")
    view.setValue(false, forKey: "drawsBackground")
    view.alphaValue = 0
    signal.list = self
    var url = page.appending(path: "page.html")
    url.append(queryItems: [URLQueryItem(name: "pop", value: nil)])
    view.loadFileURL(url, allowingReadAccessTo: URL(filePath: "/"))
  }

  package func drawOffScreen() {
    view.setValue(false, forKey: "windowOcclusionDetectionEnabled")
  }

  /// The web view's frame (in its superview, flipped or not) for the list's bottom right corner at `p` there
  public func frame(bottomRightAt p: CGPoint, flipped: Bool) -> CGRect {
    let m = Self.margin
    let w = size.width + 2 * m
    let h = size.height + 2 * m
    return flipped
      ? CGRect(x: p.x + m - w, y: p.y + m - h, width: w, height: h)
      : CGRect(x: p.x + m - w, y: p.y - m, width: w, height: h)
  }

  /// Opens it, as tall as `maxHeight` at most; its size once laid out
  @discardableResult
  public func show(_ d: Shown, maxHeight: CGFloat) async -> CGSize {
    await signal.ready()
    view.appearance = NSAppearance(named: d.dark ? .darkAqua : .aqua)
    isOpen = true
    guard let json = try? String(decoding: JSONEncoder().encode(d), as: UTF8.self),
      let r = try? await view.callAsyncJavaScript(
        "return qlist.show(JSON.parse(d), m, m, limit)", arguments: ["d": json, "m": Self.margin, "limit": maxHeight],
        contentWorld: .page) as? [String: Any]
    else { return size }
    took(CGSize(width: r["width"] as? Double ?? 0, height: r["height"] as? Double ?? 0))
    return size
  }

  /// The questions again, what is typed in it kept
  public func update(_ d: Shown) {
    guard isOpen, let json = try? String(decoding: JSONEncoder().encode(d), as: UTF8.self) else { return }
    view.callAsyncJavaScript("qlist.update(JSON.parse(d))", arguments: ["d": json], in: nil, in: .page)
  }

  public func close() {
    isOpen = false
    view.alphaValue = 0
    view.listRect = .zero
    view.callAsyncJavaScript("qlist.clear()", arguments: [:], in: nil, in: .page)
  }

  package func run(_ js: String, _ args: [String: Any] = [:]) async -> Any? {
    try? await view.callAsyncJavaScript(js, arguments: args, contentWorld: .page)
  }

  private func took(_ s: CGSize) {
    size = s
    view.listRect = CGRect(x: Self.margin, y: Self.margin, width: s.width, height: s.height)
  }

  fileprivate func received(_ m: [String: Any]) {
    switch m["type"] as? String {
    case "qsize":
      let s = CGSize(width: m["width"] as? Double ?? 0, height: m["height"] as? Double ?? 0)
      guard isOpen, s != size else { return }
      took(s)
      onSize?(s)
    case "qpick": onPick?(m["board"] as? String ?? "", m["note"] as? String ?? "")
    case "qclose": onClose?()
    default: break
    }
  }
}

/// The list's web view: lets the pointer through outside the list
public final class ListWebView: WKWebView {
  package var listRect = CGRect.zero

  public override func hitTest(_ point: NSPoint) -> NSView? {
    guard alphaValue > 0, let sv = superview, listRect.contains(convert(point, from: sv)) else { return nil }
    return super.hitTest(point)
  }
}

@MainActor
private final class ListSignal: NSObject, WKScriptMessageHandler {
  weak var list: QuestionListView?
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
    if let m = message.body as? [String: Any] { list?.received(m) }
  }
}

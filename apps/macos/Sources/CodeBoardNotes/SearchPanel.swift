import AppKit
import CodeBoardModel
import WebKit

/// ⌘K and ⌘F: the web board's search palette (ui/Palette.tsx), its markup and stylesheet, in a web view of its own
/// (page.html?palette, `palette`) as big as the board it is over, its scrim and all, as main's covers the board. Typed
/// into, it asks `onSearch` for the matches, `onResources` for the Resources group (its search cancelled when the query
/// changes) and, a little later, `onMeaning` for Related by Meaning (the page owns the pauses and asks again while
/// indexing; an answer for an older query is dropped); a row picked or the palette closed is told to `onPick`,
/// `onPickResource` and `onClose`. Made once and kept.
@MainActor
public final class SearchPanel: NSObject {
  /// What it opens with (palette.ts PaletteData)
  public struct Shown: Encodable, Sendable {
    public var look: String
    public var dark: Bool
    /// ⌘F: this board's cards and sidenotes only (Tab switches)
    public var here: Bool
    public init(look: String, dark: Bool, here: Bool) {
      self.look = look
      self.dark = dark
      self.here = here
    }
  }

  /// A row picked: where it is
  public struct Pick: Equatable, Sendable {
    public var board: BoardID
    public var card: CardID
  }

  /// Related by Meaning's answer (protocol.ts MeaningResult)
  public struct Related: Encodable, Sendable {
    public var items: [BoardSearch.Item]
    /// Pieces still to embed: "indexing, N left", and asked again
    public var left: Int?
    public var error: String?
    /// No embedding address: said when nothing at all is found
    public var off: Bool?
    /// The reranker's order of the rows shown, which they slide to
    public var ranked: Bool?
    public init(
      items: [BoardSearch.Item], left: Int? = nil, error: String? = nil, off: Bool? = nil, ranked: Bool? = nil
    ) {
      self.items = items
      self.left = left
      self.error = error
      self.off = off
      self.ranked = ranked
    }
  }

  /// A row of the Resources group (palette.ts ResourceItem): an entry, at the place its text matched
  public struct Resource: Encodable, Sendable {
    public struct Preview: Encodable, Sendable {
      public var md: String
      public var `where`: String
    }
    public var kind = "resource"
    public var entry: String
    public var label: String
    /// The line under it: the sentence that matched, with its place
    public var context: String
    /// Beside it: how many places matched
    public var detail: String
    /// What Return opens and ⌥↵ puts on the board, as JSON the page hands back
    public var open: String
    public var collect: String?
    public var preview: Preview
    /// The folder its preview's images are under
    public var images: String

    public init(
      entry: EntryID, label: String, context: String, detail: String, open: SourceAnchor, collect: Collected?,
      preview: String, where w: String, images: URL
    ) {
      self.entry = entry.rawValue
      self.label = label
      self.context = context
      self.detail = detail
      self.open = Self.json(open) ?? ""
      self.collect = collect.flatMap { Self.json($0) }
      self.preview = Preview(md: preview, where: w)
      self.images = images.absoluteString
    }

    private static func json(_ v: some Encodable) -> String? {
      (try? JSONEncoder().encode(v)).map { String(decoding: $0, as: UTF8.self) }
    }
  }

  public let view: WKWebView
  public var onSearch: ((_ q: String, _ thisBoard: Bool) async -> [BoardSearch.Item])?
  /// Related by Meaning for `q`: its answer told to `reply`, then the reranker's order told to it again if one comes
  public var onMeaning:
    ((_ q: String, _ thisBoard: Bool, _ reply: @escaping @MainActor (Related) async -> Void) async -> Void)?
  public var onResources: ((_ q: String, _ thisBoard: Bool) async -> [Resource])?
  /// A Resources row picked: Return opens `open`; ⌥↵ puts `collect` on the board
  public var onPickResource: ((_ open: SourceAnchor, _ collect: Collected?) -> Void)?
  public var onPick: ((Pick) -> Void)?
  public var onClose: (() -> Void)?
  public private(set) var isOpen = false
  /// How many times it was opened: an answer asked for in an earlier opening is dropped
  private var opening = 0
  private let signal = PanelSignal()
  /// The Resources search going on: cancelled by the next query
  private var resources: Task<Void, Never>?

  public init(page: URL = NoteRenderer.bundledPage) {
    let config = WKWebViewConfiguration()
    view = WKWebView(frame: CGRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
    super.init()
    config.userContentController.add(signal, name: "note")
    view.setValue(false, forKey: "drawsBackground")
    view.isHidden = true
    signal.panel = self
    var url = page.appending(path: "page.html")
    url.append(queryItems: [URLQueryItem(name: "palette", value: nil)])
    view.loadFileURL(url, allowingReadAccessTo: URL(filePath: "/"))
  }

  package func drawOffScreen() {
    view.setValue(false, forKey: "windowOcclusionDetectionEnabled")
  }

  /// Opens it, its field taking the keys
  public func show(_ d: Shown) async {
    isOpen = true
    opening += 1
    await signal.ready()
    guard isOpen, let json = try? String(decoding: JSONEncoder().encode(d), as: UTF8.self) else { return }
    view.appearance = NSAppearance(named: d.dark ? .darkAqua : .aqua)
    _ = try? await view.callAsyncJavaScript(
      "palette.show(JSON.parse(d))", arguments: ["d": json], contentWorld: .page)
    guard isOpen else { return }
    view.isHidden = false
    view.window?.makeFirstResponder(view)
  }

  public func close() {
    guard isOpen else { return }
    isOpen = false
    resources?.cancel()
    view.isHidden = true
    view.callAsyncJavaScript("palette.clear()", arguments: [:], in: nil, in: .page)
  }

  package func run(_ js: String, _ args: [String: Any] = [:]) async -> Any? {
    try? await view.callAsyncJavaScript(js, arguments: args, contentWorld: .page)
  }

  fileprivate func received(_ m: [String: Any]) {
    guard isOpen else { return }
    switch m["type"] as? String {
    case "psearch":
      let n = m["n"] as? Int ?? 0
      let q = m["q"] as? String ?? ""
      let here = m["here"] as? Bool ?? false
      Task {
        let items = await onSearch?(q, here) ?? []
        guard isOpen, let json = try? String(decoding: JSONEncoder().encode(items), as: UTF8.self) else { return }
        _ = await run("palette.results(n, JSON.parse(items))", ["n": n, "items": json])
      }
    case "presources":
      let n = m["n"] as? Int ?? 0
      let q = m["q"] as? String ?? ""
      let here = m["here"] as? Bool ?? false
      resources?.cancel()
      resources = Task {
        let items = await onResources?(q, here) ?? []
        guard !Task.isCancelled, isOpen, let json = try? String(decoding: JSONEncoder().encode(items), as: UTF8.self)
        else { return }
        _ = await run("palette.resources(n, JSON.parse(items))", ["n": n, "items": json])
      }
    case "prpick":
      let decode = { (s: String) in try? JSONDecoder().decode(SourceAnchor.self, from: Data(s.utf8)) }
      guard let a = (m["open"] as? String).flatMap(decode) else { return }
      let c = (m["collect"] as? String).flatMap { try? Collected(data: Data($0.utf8)) }
      onPickResource?(a, c)
    case "pmeaning":
      let n = m["n"] as? Int ?? 0
      let q = m["q"] as? String ?? ""
      let here = m["here"] as? Bool ?? false
      let opening = opening
      Task {
        await onMeaning?(q, here) { r in
          guard self.isOpen, opening == self.opening,
            let json = try? String(decoding: JSONEncoder().encode(r), as: UTF8.self)
          else {
            return
          }
          _ = await self.run("palette.meaning(n, JSON.parse(m))", ["n": n, "m": json])
        }
      }
    case "ppick":
      guard let b = m["board"] as? String, let c = m["card"] as? String else { return }
      onPick?(Pick(board: BoardID(rawValue: b), card: CardID(rawValue: c)))
    case "pclose": onClose?()
    default: break
    }
  }
}

@MainActor
private final class PanelSignal: NSObject, WKScriptMessageHandler {
  weak var panel: SearchPanel?
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
    if let m = message.body as? [String: Any] { panel?.received(m) }
  }
}

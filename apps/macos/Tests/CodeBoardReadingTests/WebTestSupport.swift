import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Network
import WebKit

@testable import CodeBoardReading

// What the web tab's tests share: the loopback server their made-up pages come from, waiting on a page, the saving
// service in memory and a reading pane of web tabs.

/// Waits for `ok`, looking again every few milliseconds; the time is only a bound
@MainActor func until(_ what: String, _ ok: () async throws -> Bool) async throws {
  let end = ContinuousClock.now + .seconds(15)
  while try await !ok() {
    guard ContinuousClock.now < end else { throw Timeout(what: what) }
    try await Task.sleep(for: .milliseconds(10))
  }
}

struct Timeout: Error { var what: String }

/// An HTTP/1.1 server on 127.0.0.1 at a free port, one request per connection, answering from `pages`
final class LoopbackServer: Sendable {
  struct Request: Sendable {
    var method: String
    var path: String
    /// By lowercased name
    var headers: [String: String]
  }

  struct Response: Sendable {
    var status = "200 OK"
    var headers: [String: String] = [:]
    var body: String

    static func html(_ body: String, headers: [String: String] = [:]) -> Response {
      Response(headers: headers, body: "<!doctype html><meta charset='utf-8'>" + body)
    }
  }

  private let listener: NWListener
  let port: UInt16
  private let queue = DispatchQueue(label: "loopback-server")

  init(pages: @escaping @Sendable (Request) -> Response) async throws {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
    let listener = try NWListener(using: params)
    let queue = queue
    listener.newConnectionHandler = { c in
      c.start(queue: queue)
      Self.read(c, Data(), pages)
    }
    port = try await withCheckedThrowingContinuation { (k: CheckedContinuation<UInt16, any Error>) in
      listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          listener.stateUpdateHandler = nil
          k.resume(returning: listener.port?.rawValue ?? 0)
        case .failed(let e):
          listener.stateUpdateHandler = nil
          k.resume(throwing: e)
        default: break
        }
      }
      listener.start(queue: queue)
    }
    self.listener = listener
  }

  deinit { listener.cancel() }

  private static func read(_ c: NWConnection, _ had: Data, _ pages: @escaping @Sendable (Request) -> Response) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { chunk, _, done, error in
      let got = had + (chunk ?? Data())
      guard let end = got.range(of: Data("\r\n\r\n".utf8)) else {
        if done || error != nil { c.cancel() } else { read(c, got, pages) }
        return
      }
      let head = String(decoding: got[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
      let start = head[0].split(separator: " ").map(String.init)
      var headers: [String: String] = [:]
      for line in head.dropFirst() {
        guard let colon = line.firstIndex(of: ":") else { continue }
        headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      }
      let length = Int(headers["content-length"] ?? "") ?? 0
      guard got.count - end.upperBound >= length || done else { return read(c, got, pages) }
      let r = pages(Request(method: start[0], path: start.count > 1 ? start[1] : "/", headers: headers))
      let body = Data(r.body.utf8)
      var lines = ["HTTP/1.1 \(r.status)", "Content-Type: text/html; charset=utf-8", "Content-Length: \(body.count)"]
      lines += ["Connection: close"] + r.headers.map { "\($0.key): \($0.value)" }
      let answer = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8) + body
      c.send(content: answer, completion: .contentProcessed { _ in c.cancel() })
    }
  }
}

/// The saving service of the web tabs under test, in memory: what they saved, and the saved pages it has
actor TestStore: PageStore {
  struct Page: Sendable {
    var capture: PageCapture
    var file: URL
    var html: String
  }

  private(set) var links: [PageLink] = []
  private(set) var pages: [Page] = []
  private var ruleFiles: [String: [Data]] = [:]
  private var files: [String: URL] = [:]

  func saveLink(_ meta: PageLink) -> SavedItem {
    links.append(meta)
    return SavedItem(id: "link-\(links.count)", kind: .link, url: meta.url, title: meta.title, savedAt: 1_000)
  }

  /// Hashes `00…01`, `00…02`…
  func savePage(_ meta: PageCapture, file: URL) throws -> SavedItem {
    let html = try String(contentsOf: file, encoding: .utf8)
    pages.append(Page(capture: meta, file: file, html: html))
    return SavedItem(
      id: "page-\(pages.count)", kind: .page, url: meta.url, title: meta.title, savedAt: 2_000,
      pageHash: Self.hash(pages.count), bytes: Int64(html.utf8.count))
  }

  static func hash(_ n: Int) -> String { String(format: "%064x", n) }

  func items(kind: SavedItem.Kind?, after: String?, limit: Int) -> SavedItems { SavedItems(items: []) }

  func writePage(hash: String, to: URL) throws -> Int64 {
    guard let f = files[hash] else { throw CocoaError(.fileNoSuchFile) }
    let data = try Data(contentsOf: f)
    try data.write(to: to)
    return Int64(data.count)
  }

  func pin(id: String, pinned: Bool) {}
  func rules(forHost host: String) -> [Data] { ruleFiles[host] ?? [] }

  func set(rules: [String], forHost host: String) { ruleFiles[host] = rules.map { Data($0.utf8) } }
  func set(file: URL, forHash hash: String) { files[hash] = file }
}

/// A reading pane whose web tabs keep their sites' data in a store in memory of the test's own, and their history in
/// a folder of its own (none: `keeps` false), in a window never ordered in. Each tab is made as the pane makes it,
/// with web tabs registered for it just before, since other tests register their own
@MainActor final class WebTabs {
  let pane = ReadingPane()
  let paneView: ReadingPaneView
  let window: NSWindow
  let websiteData: WKWebsiteDataStore
  let machine = FileManager.default.temporaryDirectory.appending(path: "web-machine-\(UUID().uuidString)")
  private let store: (any PageStore)?
  private let scripts: URL?
  private let translate: WebReading.Translator?

  init(
    vault: Vault? = nil, store: (any PageStore)? = nil, scripts: URL? = nil,
    translate: WebReading.Translator? = nil, websiteData: WKWebsiteDataStore = .nonPersistent(), keeps: Bool = true
  ) throws {
    _ = NSApplication.shared
    self.store = store
    self.scripts = scripts
    self.translate = translate
    self.websiteData = websiteData
    pane.vault = vault
    if let vault { pane.entries = EntryIndex(vault, try vault.tree()) }
    if keeps { pane.machineFolder = machine }
    paneView = ReadingPaneView(pane: pane)
    window = NSWindow(
      contentRect: CGRect(x: -30000, y: -30000, width: 600, height: 500), styleMask: [.titled], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = paneView
  }

  /// The web tabs' folder on this Mac
  var data: URL { machine.appending(path: "Web") }

  /// A new web tab showing what `payload` names, selected; its view
  func open(_ payload: [String: String] = [:]) -> WebPageView {
    WebReading.register(saving: store, scripts: scripts, translate: translate, websiteData: websiteData)
    let id = pane.open("New Tab", kind: WebReading.kind, payload: payload)
    paneView.sync()
    window.layoutIfNeeded()
    return paneView.views[id] as! WebPageView
  }

  /// The tab `view` is in
  func tab(_ view: WebPageView) -> ReadingTab? { pane.tabs.first { paneView.views[$0.id] === view } }

  func close() {
    window.close()
    try? FileManager.default.removeItem(at: machine)
  }
}

/// Stand-ins for the saving service's page scripts, speaking their messages, written to a folder of their own
enum StandInScripts {
  /// Marks the page's world, so that a test sees it ran there
  static let hooks = "window.hooked = true"

  /// Metadata of its own; a saving that says its first stage, fetches one resource, writes two chunks and returns.
  /// `?fail` fails at once, `?hold` waits for `cancel()`
  static let capture = """
    var shiyiCapture = {
      stopped: false,
      meta: async () => {
        if (location.pathname == "/mute") await new Promise(() => {})
        if (location.pathname == "/late") {
          await new Promise(done => {
            const t = setInterval(() => { if (document.documentElement.dataset.answer) { clearInterval(t); done() } }, 5)
          })
        }
        return { url: location.href, title: document.title, description: "A made-up page",
          site_name: "Loopback", favicon: location.origin + "/icon.png", cover: location.origin + "/cover.png" }
      },
      async savePage(files) {
        const post = m => webkit.messageHandlers.shiyi.postMessage(m)
        await post({ type: "stage", stage: "prepare" })
        if (location.search == "?fail") return { ok: false, code: "too-large", message: "over the limit" }
        if (location.search == "?hold") await new Promise(k => this.release = k)
        if (this.stopped) return { ok: false, code: "cancelled", message: "" }
        const asset = await post({ type: "fetch", url: location.origin + "/asset", accept: "text/plain", timeout_ms: 5000 })
        const parts = ["<!doctype html><title>" + document.title + "</title>",
          "<p id=asset>" + atob(asset.base64) + " " + asset.status + "</p><p id=rules>" + JSON.stringify(files) + "</p>"]
        for (const [seq, text] of parts.entries()) {
          const r = await post({ type: "chunk", seq, text })
          if (!r.ok) return { ok: false, code: "internal", message: r.error }
        }
        return { ok: true, meta: await this.meta(), bytes: parts.join("").length, chunks: parts.length }
      },
      cancel() { this.stopped = true; this.release?.() },
    }
    """

  /// Marks the page as read and, in body mode, hides what the rule files' `body` selectors leave out, with an
  /// attribute as the real one does. A reader older than translation: no blocks
  static let olderReader = """
    document.documentElement.setAttribute("data-reader", "")
    var shiyiReader = {
      files: [], mode: "full",
      apply({ files, url, mode }) { this.files = files; this.url = url; this.setMode(mode) },
      setMode(mode) {
        this.mode = mode
        const keep = this.files.map(f => f.body).filter(Boolean).join(",")
        for (const e of document.body.children) {
          if (mode == "body" && keep && !e.matches(keep)) e.setAttribute("data-shiyi-hidden", "")
          else e.removeAttribute("data-shiyi-hidden")
        }
      },
      state() { return { mode: this.mode, url: this.url } },
    }
    """

  /// The older reader with the blocks: headings, paragraphs, items, captions, quotes, cells and code numbered `1.b1`,
  /// `1.b2`… in document order, each with a hash of its text; translations shown under each block (`both`, as a
  /// `[data-shiyi-translation]` after it) or in its place (`translation`). Whatever it shows, the block at the top of
  /// the window stays there, as the real one promises
  static let reader =
    olderReader + "\n"
      + """
      Object.assign(shiyiReader, {
        translations: {}, language: "original",
        kinds: { H1: "heading", H2: "heading", H3: "heading", P: "paragraph", LI: "item", FIGCAPTION: "caption",
          BLOCKQUOTE: "quote", TD: "cell", TH: "cell", PRE: "code" },
        els() {
          const all = [...document.body.querySelectorAll("h1,h2,h3,p,li,figcaption,blockquote,td,th,pre")]
          all.forEach((e, i) => {
            if (!e.dataset.shiyiId) { e.dataset.shiyiId = "1.b" + (i + 1); e.dataset.shiyiOriginal = e.textContent }
          })
          return all
        },
        hash(t) { let h = 5381; for (const c of t) h = (h * 33 + c.codePointAt(0)) >>> 0; return h.toString(16) },
        blocks() {
          const keep = this.files.map(f => f.body).filter(Boolean).join(",")
          return { scheme: 1, blocks: this.els().map(e => {
            const kind = this.kinds[e.tagName], text = e.dataset.shiyiOriginal
            return { id: e.dataset.shiyiId, kind, text, textHash: this.hash(text), inBody: !keep || !!e.closest(keep),
              translate: kind != "code" }
          }) }
        },
        setTranslations(t) { Object.assign(this.translations, t); this.render() },
        setLanguage(language) { this.language = language; this.render() },
        render() {
          const at = this.position()
          for (const n of document.querySelectorAll("[data-shiyi-translation]")) n.remove()
          for (const e of this.els()) {
            const t = this.translations[e.dataset.shiyiId]
            e.textContent = this.language == "translation" && t ? t : e.dataset.shiyiOriginal
            if (this.language != "both" || !t) continue
            const d = document.createElement("div")
            d.dataset.shiyiTranslation = e.dataset.shiyiId
            d.textContent = t
            e.after(d)
          }
          if (at) this.scrollTo(at.id, null, at.offset)
        },
        position() {
          for (const e of this.els()) {
            const r = e.getBoundingClientRect()
            if (r.bottom > 0) return { id: e.dataset.shiyiId, offset: -r.top }
          }
          return null
        },
        scrollTo(id, range, offset = 0) {
          const e = this.els().find(e => e.dataset.shiyiId == id)
          if (e) window.scrollTo(0, e.getBoundingClientRect().top + scrollY + offset)
        },
      })
      """

  /// A new folder holding them, the reader `reader`
  static func folder(reader: String = reader) throws -> URL {
    let f = FileManager.default.temporaryDirectory.appending(path: "web-scripts-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: f, withIntermediateDirectories: true)
    try hooks.write(to: f.appending(path: "hooks.js"), atomically: true, encoding: .utf8)
    try capture.write(to: f.appending(path: "capture.js"), atomically: true, encoding: .utf8)
    try reader.write(to: f.appending(path: "reader.js"), atomically: true, encoding: .utf8)
    return f
  }
}

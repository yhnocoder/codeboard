import Foundation
import Network

@testable import CodeBoardReading

// What the web tab's tests share: the loopback server their made-up pages come from, and waiting on a page.

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

/// The owner of the web tabs under test: what they saved, kept in memory, and what it says was saved
actor TestSaving: WebSaving {
  struct Page: Sendable {
    var meta: WebReading.PageMeta
    var file: URL
    var html: String
  }

  private(set) var links: [WebReading.PageMeta] = []
  private(set) var pages: [Page] = []
  private var states: [URL: WebReading.Saved] = [:]
  private var ruleFiles: [String: [Data]] = [:]
  private var files: [String: URL] = [:]

  func saveLink(_ meta: WebReading.PageMeta) { links.append(meta) }

  func savePage(_ meta: WebReading.PageMeta, file: URL) throws -> String {
    pages.append(Page(meta: meta, file: file, html: try String(contentsOf: file, encoding: .utf8)))
    return "hash-\(pages.count)"
  }

  func saved(_ url: URL) -> WebReading.Saved { states[url] ?? .unsaved }
  func rules(forHost host: String) -> [Data] { ruleFiles[host] ?? [] }

  func savedPage(hash: String) throws -> URL {
    guard let f = files[hash] else { throw CocoaError(.fileNoSuchFile) }
    return f
  }

  func set(_ url: URL, _ state: WebReading.Saved) { states[url] = state }
  func set(rules: [String], forHost host: String) { ruleFiles[host] = rules.map { Data($0.utf8) } }
  func set(file: URL, forHash hash: String) { files[hash] = file }
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
      meta: async () => ({ url: location.href, title: document.title, description: "A made-up page",
        site_name: "Loopback", favicon: location.origin + "/icon.png", cover: location.origin + "/cover.png" }),
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
  /// attribute as the real one does
  static let reader = """
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

  /// A new folder holding them
  static func folder() throws -> URL {
    let f = FileManager.default.temporaryDirectory.appending(path: "web-scripts-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: f, withIntermediateDirectories: true)
    try hooks.write(to: f.appending(path: "hooks.js"), atomically: true, encoding: .utf8)
    try capture.write(to: f.appending(path: "capture.js"), atomically: true, encoding: .utf8)
    try reader.write(to: f.appending(path: "reader.js"), atomically: true, encoding: .utf8)
    return f
  }
}

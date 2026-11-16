import CodeBoardModel
import CodeBoardResources
import Foundation
import WebKit

extension WebReading {
  /// How an address is saved
  enum Saved: Equatable, Sendable {
    case unsaved
    case link
    case page(hash: String)
  }

  /// The world the saving scripts run in and post to, out of the page's reach
  @MainActor static let scriptWorld = WKContentWorld.world(name: "shiyi")

  /// The resource saving goes into: the vault's first with the web preset, in the sidebar's order (the top level's
  /// first, then each folder's), or with none a new one, 网页, at the top level. Its path
  static func webResource(in vault: Vault) throws -> String {
    if let r = try vault.tree().allFolders.lazy.flatMap(\.resources).first(where: { $0.preset == .web }) {
      return r.path
    }
    return try vault.newResource(in: "", title: "网页", preset: .web).path
  }
}

extension WebMeta {
  /// What the metadata script read of a page, `{title, description, site_name, cover, favicon}`, its pictures by
  /// address; the page's own title where it gives none
  init(script: Any?, title: String, at date: Date = Date()) {
    let d = script as? [String: Any] ?? [:]
    func text(_ key: String) -> String? { (d[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
    self.init(
      title: text("title") ?? (title.isEmpty ? nil : title), description: text("description"),
      site: text("site_name"), image: text("cover").map(ImageSource.url), icon: text("favicon").map(ImageSource.url),
      fetchedAt: (date.timeIntervalSince1970 * 1000).rounded())
  }
}

extension ReadingPane {
  /// How `url` is saved, from the vault's entries: its entry's latest page saved whole, else a link
  func webSaved(_ url: URL) -> WebReading.Saved {
    let address = Vault.pageAddress(url.absoluteString)
    guard let e = entries.all.lazy.map(\.entry).first(where: { $0.origin == .web(address) }) else { return .unsaved }
    let hashes = e.versions.compactMap { v -> String? in if case .page(let h, _, _) = v.content { h } else { nil } }
    return hashes.last.map { .page(hash: $0) } ?? .link
  }

  /// What was saved, in its entry in the web resource with what was read of the page; the entries know it at once
  func saveWeb(_ item: SavedItem, meta: WebMeta) throws {
    guard let vault else { return }
    let path = try vault.save(item, in: WebReading.webResource(in: vault), meta: meta)
    entries.update(try vault.entry(at: path), at: path)
  }
}

/// The saving service's scripts, read from the folder `register` was given; none when one is missing
struct WebScripts {
  var hooks: String
  var capture: String
  var reader: String

  init?(_ folder: URL?) {
    guard let folder,
      let hooks = try? String(contentsOf: folder.appending(path: "hooks.js"), encoding: .utf8),
      let capture = try? String(contentsOf: folder.appending(path: "capture.js"), encoding: .utf8),
      let reader = try? String(contentsOf: folder.appending(path: "reader.js"), encoding: .utf8)
    else { return nil }
    self.hooks = hooks
    self.capture = capture
    self.reader = reader
  }

  /// Online pages: the hooks in the page's world at its start, the capture script in its own, in every frame
  @MainActor var online: [WKUserScript] {
    [
      WKUserScript(source: hooks, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page),
      WKUserScript(
        source: capture, injectionTime: .atDocumentEnd, forMainFrameOnly: false, in: WebReading.scriptWorld),
    ]
  }

  /// Saved pages: the reader in its own world, in the page alone
  @MainActor var saved: [WKUserScript] {
    [WKUserScript(source: reader, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: WebReading.scriptWorld)]
  }
}

/// A saving failed; `code` as the capture script names it, or `store` when the owner could not keep it
struct WebSaveError: Error, Equatable {
  var code: String
  var message: String

  /// What the save button says about it
  var shown: String {
    switch code {
    case "busy": "This page is already being saved"
    case "timeout": "The page took too long to save"
    case "serialize": "The page could not be written out"
    case "too-large": "The page is too large to save"
    default: message.isEmpty ? "The page could not be saved" : "The page could not be saved: \(message)"
    }
  }
}

/// One saving of a page whole: the capture script driven from its call to its result, its fetches answered from a
/// session of its own with the tab's cookies, its chunks written in order to a temporary file. Nothing of it runs on
/// the main thread but the messages' bookkeeping
@MainActor final class WebCapture {
  private let web: WKWebView
  private let file: CaptureFile
  private let session: URLSession
  private let jar: HTTPCookieStorage?
  private let onStage: (String) -> Void
  private var nextChunk: Int?
  private var chunks = 0
  /// The chunks' writes, each after the one before
  private var writing: Task<Void, any Error>?
  private(set) var cancelled = false

  init(web: WKWebView, onStage: @escaping (String) -> Void) {
    self.web = web
    self.onStage = onStage
    file = CaptureFile(
      url: FileManager.default.temporaryDirectory.appending(path: "codeboard-capture-\(UUID().uuidString).html"))
    let config = URLSessionConfiguration.ephemeral
    jar = config.httpCookieStorage
    session = URLSession(configuration: config)
  }

  /// The page captured with the site's rule `files`, its resources fetched with the tab's `cookies`: its file and
  /// what the script read of it. The file is the caller's to remove
  func run(files: [Data], cookies: [HTTPCookie]) async throws -> (file: URL, meta: Any?) {
    defer { session.finishTasksAndInvalidate() }
    for c in cookies { jar?.setCookie(c) }
    do {
      let rules = files.compactMap { try? JSONSerialization.jsonObject(with: $0) }
      let result = try await web.callAsyncJavaScript(
        "return await shiyiCapture.savePage(files)", arguments: ["files": rules], contentWorld: WebReading.scriptWorld)
      let r = result as? [String: Any] ?? [:]
      try await writing?.value
      try await file.close()
      if cancelled { throw CancellationError() }
      guard r["ok"] as? Bool == true else {
        throw WebSaveError(code: r["code"] as? String ?? "internal", message: r["message"] as? String ?? "")
      }
      guard (r["chunks"] as? NSNumber)?.intValue == chunks else {
        throw WebSaveError(code: "internal", message: "\(chunks) of \(r["chunks"] ?? "?") parts came")
      }
      return (file.url, r["meta"])
    } catch {
      try? await file.close()
      try? FileManager.default.removeItem(at: file.url)
      if cancelled { throw CancellationError() }
      throw error
    }
  }

  /// The script told to stop and every fetch dropped; `run` then throws `CancellationError`
  func cancel() {
    guard !cancelled else { return }
    cancelled = true
    session.invalidateAndCancel()
    web.callAsyncJavaScript("shiyiCapture.cancel()", in: nil, in: WebReading.scriptWorld)
  }

  /// A message of the script's, `{type, …}`, and the answer it waits for
  func reply(to body: Any) async -> Any? {
    let m = body as? [String: Any] ?? [:]
    switch m["type"] as? String {
    case "stage":
      if let s = m["stage"] as? String { onStage(s) }
      return nil
    case "fetch":
      guard let request = Self.request(m), !cancelled else {
        return ["ok": false, "status": 0, "url": m["url"] ?? "", "headers": [], "base64": "", "error": "refused"]
      }
      return await Self.fetch(request, in: session).reply
    case "chunk":
      return await chunk(m)
    default:
      return nil
    }
  }

  private func chunk(_ m: [String: Any]) async -> Any {
    guard let seq = (m["seq"] as? NSNumber)?.intValue, let text = m["text"] as? String, !cancelled,
      nextChunk.map({ $0 == seq }) ?? true
    else { return ["ok": false, "error": "chunk out of order"] }
    nextChunk = seq + 1
    chunks += 1
    let (before, file) = (writing, file)
    let write = Task {
      try await before?.value
      try await file.append(text)
    }
    writing = write
    do {
      try await write.value
      return ["ok": true]
    } catch {
      return ["ok": false, "error": error.localizedDescription]
    }
  }

  /// Only web addresses: the script never reads a file of this Mac through the app
  private static func request(_ m: [String: Any]) -> URLRequest? {
    guard let s = m["url"] as? String, let url = URL(string: s), ["http", "https"].contains(url.scheme?.lowercased())
    else { return nil }
    var r = URLRequest(url: url)
    if let ms = (m["timeout_ms"] as? NSNumber)?.doubleValue, ms > 0 { r.timeoutInterval = ms / 1000 }
    if let referrer = m["referrer"] as? String { r.setValue(referrer, forHTTPHeaderField: "Referer") }
    if let accept = m["accept"] as? String { r.setValue(accept, forHTTPHeaderField: "Accept") }
    return r
  }

  struct Fetched: Sendable {
    var status = 0
    var url: String
    var headers: [[String]] = []
    var base64 = ""
    var error: String?

    var reply: [String: Any] {
      var r: [String: Any] = [
        "ok": error == nil && (200..<300).contains(status), "status": status, "url": url, "headers": headers,
        "base64": base64,
      ]
      if let error { r["error"] = error }
      return r
    }
  }

  @concurrent private static func fetch(_ request: URLRequest, in session: URLSession) async -> Fetched {
    let asked = request.url?.absoluteString ?? ""
    do {
      let (data, response) = try await session.data(for: request)
      let http = response as? HTTPURLResponse
      return Fetched(
        status: http?.statusCode ?? 200, url: response.url?.absoluteString ?? asked,
        headers: (http?.allHeaderFields ?? [:]).map { ["\($0.key)", "\($0.value)"] }, base64: data.base64EncodedString()
      )
    } catch {
      return Fetched(url: asked, error: error.localizedDescription)
    }
  }
}

/// The captured page's file, written a chunk at a time off the main thread
private actor CaptureFile {
  nonisolated let url: URL
  private var handle: FileHandle?

  init(url: URL) { self.url = url }

  func append(_ text: String) throws {
    try open().write(contentsOf: Data(text.utf8))
  }

  func close() throws {
    _ = try open()
    try handle?.close()
    handle = nil
  }

  private func open() throws -> FileHandle {
    if let handle { return handle }
    if !FileManager.default.fileExists(atPath: url.path) {
      guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
        throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
      }
    }
    let h = try FileHandle(forWritingTo: url)
    try h.seekToEnd()
    handle = h
    return h
  }
}

/// Hands the saving scripts' messages to the view without the content controller keeping the view alive
final class SavingRelay: NSObject, WKScriptMessageHandlerWithReply {
  weak var owner: WebPageView?

  func userContentController(
    _ c: WKUserContentController, didReceive message: WKScriptMessage,
    replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
  ) {
    let body = message.body
    Task { @MainActor [weak owner] in replyHandler(await owner?.capture?.reply(to: body), nil) }
  }
}

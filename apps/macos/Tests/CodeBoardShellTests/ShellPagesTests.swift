import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Network
import Synchronization
import Testing
import WebKit

@testable import CodeBoardReading
@testable import CodeBoardShell

/// A saving service of a test's own: the real executable and page scripts (`node apps/macos/tools/shiyi/fetch.mjs`
/// puts them in apps/macos/.build-shiyi) with a data folder in a short temp path, since its socket is in it; `end`
/// ends the service it started, found by its socket, and removes the folder
final class TestService: Sendable {
  static let folder = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../.build-shiyi")
    .standardized
  static let binary = folder.appending(path: "shiyi")
  static let scripts = folder.appending(path: "scripts", directoryHint: .isDirectory)
  static let missing = Comment(
    rawValue: "no saving service in apps/macos/.build-shiyi: node apps/macos/tools/shiyi/fetch.mjs fetches it")
  static var present: Bool {
    FileManager.default.isExecutableFile(atPath: binary.path)
      && FileManager.default.fileExists(atPath: scripts.appending(path: "reader.js").path)
  }

  let home = URL(filePath: "/private/tmp").appending(path: "shiyi-\(UUID().uuidString.prefix(8))")
  let store: ShiyiStore

  init() throws {
    store = try ShiyiStore(home: home, binary: Self.binary)
    #expect(store.home == home)
  }

  /// SIGKILL: the service waits on the client's connection before it ends otherwise, and its data goes with the folder
  func end() {
    let socket = home.appending(path: "shiyi.sock").path
    for pid in Self.holders(of: socket) where pid != getpid() { kill(pid, SIGKILL) }
    try? FileManager.default.removeItem(at: home)
  }

  /// The processes that have `file` open: of the socket, the service listening on it
  static func holders(of file: String) -> [pid_t] {
    guard FileManager.default.fileExists(atPath: file) else { return [] }
    let lsof = Process()
    lsof.executableURL = URL(filePath: "/usr/sbin/lsof")
    lsof.arguments = ["-t", file]
    let out = Pipe()
    lsof.standardOutput = out
    lsof.standardError = FileHandle.nullDevice
    guard (try? lsof.run()) != nil else { return [] }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    lsof.waitUntilExit()
    return String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { pid_t($0) }
  }
}

/// A vault in a folder of its own
func tempVault() throws -> Vault {
  let root = FileManager.default.temporaryDirectory.appending(path: "pages-vault-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  return Vault(root: root)
}

/// Only the app's own identity reaches the service's own folder; any other gets one in its folder on this Mac, or
/// none without one. No service is started by asking
@MainActor @Suite struct PageStoreChoiceTests {
  @Test func anotherIdentityNeverUsesTheServicesOwnFolder() throws {
    let binary = URL(filePath: "/nonexistent/shiyi")
    let machine = URL(filePath: "/private/tmp/m", directoryHint: .isDirectory)
    #expect(Shell.pageStore(binary: nil, id: Shell.appID, machine: machine) == nil)
    #expect(Shell.pageStore(binary: binary, id: "com.example.codeboard.accept.x", machine: nil) == nil)
    #expect(Shell.pageStore(binary: binary, id: nil, machine: nil) == nil)
    let own = try #require(Shell.pageStore(binary: binary, id: "com.example.codeboard.accept.x", machine: machine))
    #expect(own.home == machine.appending(path: "Shiyi", directoryHint: .isDirectory))
    #expect(Bundle.main.bundleIdentifier != Shell.appID && Shell.webSaving == nil, "a test process carries none")
  }
}

/// The store over the real service: what it is handed comes back as the app reads it
@Suite(.serialized, .enabled(if: TestService.present, TestService.missing))
struct ShiyiStoreTests {
  @Test func linksAndPagesAreKeptListedAndWrittenBackAndRulesComeAsFiles() async throws {
    let service = try TestService()
    defer { service.end() }
    let store = service.store
    let link = try await store.saveLink(PageLink(url: "http://127.0.0.1:9/a", title: "Page A"))
    #expect(link.kind == .link && link.url == "http://127.0.0.1:9/a" && link.title == "Page A" && link.savedAt > 0)

    let html = "<!doctype html><meta charset=\"utf-8\"><title>Page B</title><p>saved — whole</p>\n"
    let file = FileManager.default.temporaryDirectory.appending(path: "shiyi-page-\(UUID().uuidString).html")
    try html.write(to: file, atomically: true, encoding: .utf8)
    defer { try? FileManager.default.removeItem(at: file) }
    let page = try await store.savePage(PageCapture(url: "http://127.0.0.1:9/b", title: "Page B"), file: file)
    let hash = try #require(page.pageHash)
    #expect(page.kind == .page && page.bytes == Int64(html.utf8.count) && hash.count == 64)
    #expect(page.savedAt >= link.savedAt)

    let all = try await store.items(kind: nil, after: nil, limit: 10)
    #expect(all.items.map(\.url) == ["http://127.0.0.1:9/b", "http://127.0.0.1:9/a"] && all.next == nil)
    #expect(try await store.items(kind: .page, after: nil, limit: 10).items.map(\.id) == [page.id])
    let next = try #require(try await store.items(kind: nil, after: nil, limit: 1).next)
    #expect(try await store.items(kind: nil, after: next, limit: 1).items.map(\.id) == [link.id])

    let back = FileManager.default.temporaryDirectory.appending(path: "shiyi-back-\(UUID().uuidString).html")
    defer { try? FileManager.default.removeItem(at: back) }
    #expect(try await store.writePage(hash: hash, to: back) == Int64(html.utf8.count))
    #expect(try Data(contentsOf: back) == Data(html.utf8))
    await #expect(throws: ShiyiStore.Failure.self) {
      try await store.writePage(hash: String(repeating: "0", count: 64), to: back)
    }

    #expect(try await store.rules(forHost: "127.0.0.1").isEmpty)
    // a site the service has a rule of its own for
    let files = try await store.rules(forHost: "mp.weixin.qq.com").map { try JSONSerialization.jsonObject(with: $0) }
    #expect(!files.isEmpty)
    for f in files {
      #expect(Set(((f as? [String: Any]) ?? [:]).keys) == ["domain", "origin", "rules"])
    }
  }

  /// What the service has comes into the vault's web resource, once: a second import finds nothing new
  @Test func importTakesWhatTheServiceSavedIntoTheVaultOnce() async throws {
    let service = try TestService()
    defer { service.end() }
    let vault = try tempVault()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let watermark = vault.root.appending(path: "machine/Web/page-watermark.json")
    await Shell.importPages(from: service.store, into: vault, watermark: watermark)
    #expect(try vault.tree().allFolders.flatMap(\.resources).isEmpty, "no resource for nothing saved")

    _ = try await service.store.saveLink(PageLink(url: "http://127.0.0.1:9/a#top", title: "Page A"))
    await Shell.importPages(from: service.store, into: vault, watermark: watermark)
    let resource = try WebReading.webResource(in: vault)
    let entries = try vault.items(in: resource).compactMap { i -> Entry? in
      if case .entry(let e, _) = i { e } else { nil }
    }
    #expect(entries.map(\.title) == ["Page A"] && entries.map(\.origin) == [.web("http://127.0.0.1:9/a")])
    #expect(FileManager.default.fileExists(atPath: watermark.path))
    #expect(try await PageImport.run(from: service.store, into: vault, resource: resource, watermark: watermark) == 0)
  }
}

/// A web tab with the real scripts and the real service: a made-up page on the loopback saved whole, then shown saved
/// in another tab without reaching the loopback, read in body view and whole. In a window never ordered in
@MainActor @Suite(.serialized, .enabled(if: TestService.present, TestService.missing))
struct ShiyiWebTabTests {
  /// An HTTP server on 127.0.0.1 answering every request with `page`, saying which paths reached it
  final class Server: Sendable {
    private let listener: NWListener
    let port: UInt16
    private let paths = Paths()
    var asked: [String] { paths.all.withLock { $0 } }

    final class Paths: Sendable { let all = Mutex<[String]>([]) }

    init(page: String) async throws {
      let params = NWParameters.tcp
      params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
      let listener = try NWListener(using: params)
      let queue = DispatchQueue(label: "shiyi-web-tab-server")
      listener.newConnectionHandler = { [paths] c in
        c.start(queue: queue)
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
          let head = String(decoding: data ?? Data(), as: UTF8.self)
          paths.all.withLock { $0.append(String(head.split(separator: " ").dropFirst().first ?? "")) }
          let body = Data(page.utf8)
          let start = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.count)\r\n"
          c.send(
            content: Data((start + "Connection: close\r\n\r\n").utf8) + body,
            completion: .contentProcessed { _ in c.cancel() })
        }
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
  }

  static let page = """
    <!doctype html><meta charset="utf-8"><title>A made-up article</title>
    <nav id="nav"><a href="/x">Home</a> <a href="/y">About</a> <a href="/z">Archive</a></nav>
    <article id="main"><h1>A made-up article</h1>
    \(String(repeating: "<p>The article's text, long enough to be read as the body of the page and nothing else.</p>\n", count: 12))
    </article>
    <footer id="foot">Footer links and the like</footer>
    """

  func until(_ what: String, _ ok: () async throws -> Bool) async throws {
    let end = ContinuousClock.now + .seconds(20)
    while try await !ok() {
      guard ContinuousClock.now < end else {
        Issue.record("timed out waiting for \(what)")
        return
      }
      try await Task.sleep(for: .milliseconds(10))
    }
  }

  func js(_ v: WebPageView, _ body: String) async throws -> Any? {
    try await v.web.callAsyncJavaScript(body, contentWorld: .defaultClient)
  }

  @Test func aPageSavedWholeIsShownSavedWithoutTheNetworkInBodyViewOrWhole() async throws {
    _ = NSApplication.shared
    let service = try TestService()
    defer { service.end() }
    let vault = try tempVault()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let server = try await Server(page: Self.page)
    let pane = ReadingPane()
    pane.vault = vault
    pane.entries = EntryIndex(vault, try vault.tree())
    let paneView = ReadingPaneView(pane: pane)
    let window = NSWindow(
      contentRect: CGRect(x: -30000, y: -30000, width: 900, height: 700), styleMask: [.titled], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = paneView
    defer { window.close() }
    let websiteData = WKWebsiteDataStore.nonPersistent()
    // just before each tab is made: other suites' shells register theirs
    func open(_ payload: [String: String]) -> WebPageView {
      WebReading.register(saving: service.store, scripts: TestService.scripts, websiteData: websiteData)
      let id = pane.open("New Tab", kind: WebReading.kind, payload: payload)
      paneView.sync()
      window.layoutIfNeeded()
      return paneView.views[id] as! WebPageView
    }

    let address = URL(string: "http://127.0.0.1:\(server.port)/article")!
    let online = open(["url": address.absoluteString])
    try await until("the page online") { online.web.title == "A made-up article" && !online.web.isLoading }
    online.savePage(nil)
    try await until("the page saved") { if case .page = online.saved { true } else { false } }
    guard case .page(let hash) = online.saved else { return }
    let kept = try await service.store.items(kind: .page, after: nil, limit: 10).items
    #expect(kept.map(\.pageHash) == [hash] && kept.map(\.url) == [address.absoluteString])
    let entries = try vault.items(in: WebReading.webResource(in: vault)).compactMap { i -> Entry? in
      if case .entry(let e, _) = i { e } else { nil }
    }
    #expect(entries.map(\.origin) == [.web(address.absoluteString)] && entries.first?.versions.count == 1)

    let asked = server.asked
    let saved = WebReading.Page.saved(hash: hash, address: address, title: "A made-up article")
    let v = open(saved.payload)
    try await until("the saved page") { v.web.url == WebReading.savedURL(hash) && !v.web.isLoading }
    let text = "return document.body.innerText"
    try await until("its text") { (try await js(v, text) as? String)?.contains("long enough to be read") == true }
    let navShown = "return document.getElementById('nav')?.checkVisibility() ?? false"
    try await until("body view") { try await js(v, navShown) as? Bool == false }
    #expect(v.bar.extract.isEnabled && v.bar.extract.selectedSegment == 0)
    v.bar.extract.selectedSegment = 1
    NSApp.sendAction(v.bar.extract.action!, to: v.bar.extract.target, from: v.bar.extract)
    try await until("full page") { try await js(v, navShown) as? Bool == true }
    v.bar.extract.selectedSegment = 0
    NSApp.sendAction(v.bar.extract.action!, to: v.bar.extract.target, from: v.bar.extract)
    try await until("body view again") { try await js(v, navShown) as? Bool == false }
    #expect((try await js(v, text) as? String)?.contains("long enough to be read") == true)
    #expect(server.asked == asked, "the saved page reached the loopback: \(server.asked.dropFirst(asked.count))")
  }
}

import AppKit
import Foundation
import Synchronization
import Testing
import WebKit

@testable import CodeBoardReading

/// A saved page in a web tab: made-up saved files served under the app's scheme, the loopback server standing for the
/// web they came from and saying which requests reached it, in a window never ordered in
@MainActor @Suite(.serialized) struct WebSavedPageTests {
  let server: LoopbackServer
  let asked: Asked
  let data = FileManager.default.temporaryDirectory.appending(path: "web-saved-\(UUID().uuidString)")
  let scripts: URL

  /// The paths the server was asked for
  final class Asked: Sendable {
    private let paths = Mutex<[String]>([])
    func add(_ path: String) { paths.withLock { $0.append(path) } }
    var all: [String] { paths.withLock { $0 } }
  }

  init() async throws {
    _ = NSApplication.shared
    let asked = Asked()
    self.asked = asked
    server = try await LoopbackServer { r in
      asked.add(r.path)
      return Self.pages(r)
    }
    scripts = try StandInScripts.folder()
    try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
  }

  /// The page online, and an address that has moved to it
  nonisolated static func pages(_ r: LoopbackServer.Request) -> LoopbackServer.Response {
    switch r.path {
    case "/a": .html("<title>Page A</title><p>online</p>")
    case "/moved": LoopbackServer.Response(status: "302 Found", headers: ["Location": "/a"], body: "")
    default: LoopbackServer.Response(status: "404 Not Found", body: "<title>Missing</title>")
    }
  }

  func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(server.port)\(path)")! }

  static let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

  /// A saved file that would reach the loopback every way a page can, and run a script if it could: an image, a
  /// stylesheet, a frame, a refresh, an inline script and a handler
  func savedFile(_ extra: String = "") -> String {
    let web = "http://127.0.0.1:\(server.port)"
    return """
      <!doctype html><meta charset="utf-8"><title>Saved A</title>
      <meta http-equiv="refresh" content="0; url=\(web)/refreshed">
      <link rel="stylesheet" href="\(web)/style.css">
      <style>#main { color: rgb(1, 2, 3) }</style>
      <body onload="document.documentElement.setAttribute('data-ran', '')">
      <nav id="nav">menu</nav><main id="main">the text</main>
      <img id="pic" src="\(web)/pixel.png"><iframe src="\(web)/frame"></iframe>
      <script>document.documentElement.setAttribute("data-ran", ""); fetch("\(web)/fetched")</script>
      \(extra)
      """
  }

  /// A tab showing `page`, whose saved file the service has when `html` is given
  func tab(
    _ page: WebReading.Page, html: String?, scripts: Bool = true, rules: [String] = []
  ) async throws -> (WebPageView, WebTabs) {
    let store = TestStore()
    if let html {
      let file = data.appending(path: "\(Self.hash).html")
      try html.write(to: file, atomically: true, encoding: .utf8)
      await store.set(file: file, forHash: Self.hash)
    }
    await store.set(rules: rules, forHost: "127.0.0.1")
    let tabs = try WebTabs(store: store, scripts: scripts ? self.scripts : nil)
    return (tabs.open(page.payload), tabs)
  }

  func done(_ tabs: WebTabs) {
    tabs.close()
    try? FileManager.default.removeItem(at: data)
    try? FileManager.default.removeItem(at: scripts)
  }

  var saved: WebReading.Page { .saved(hash: Self.hash, address: url("/moved"), title: "Saved A") }

  /// Read in a world of the app's own: the page's world runs nothing on a saved page
  func js(_ v: WebPageView, _ body: String) async throws -> Any? {
    try await v.web.callAsyncJavaScript(body, contentWorld: .defaultClient)
  }

  func shown(_ v: WebPageView, _ title: String) async throws {
    try await until(title) { v.web.title == title && !v.web.isLoading }
  }

  /// The saved file is shown as it was saved, its inline style kept; nothing of it runs and nothing reaches the
  /// network, not even the refresh, which the tab refuses; the bar shows the address it was saved from and the tab
  /// keeps the saved page, titled as the page is, gone to by its hash
  @Test func aSavedPageShowsWhatItHoldsAndNothingRunsOrIsFetched() async throws {
    let (v, tabs) = try await tab(saved, html: savedFile())
    defer { done(tabs) }
    try await shown(v, "Saved A")
    try await until("the refresh refused") { v.refused == [url("/refreshed")] }
    #expect(try await js(v, "return document.documentElement.hasAttribute('data-ran')") as? Bool == false)
    let color = try await js(v, "return getComputedStyle(document.getElementById('main')).color")
    #expect(color as? String == "rgb(1, 2, 3)", "the inline style kept")
    #expect(try await js(v, "return document.getElementById('pic').naturalWidth") as? Int == 0)
    #expect(asked.all.isEmpty, "asked for \(asked.all)")
    #expect(v.web.url == WebReading.savedURL(Self.hash) && v.page == saved)
    let tab = try #require(tabs.tab(v))
    #expect(tab.payload == ["url": url("/moved").absoluteString, "hash": Self.hash, "title": "Saved A"])
    #expect(tab.title == "Saved A" && tab.key == "web:" + Self.hash)
    #expect(v.bar.address.stringValue == "127.0.0.1" && !v.bar.save.isEnabled)
    #expect(!FileManager.default.fileExists(atPath: tabs.data.appending(path: "history.json").path), "not a visit")
  }

  /// Going to the address shown leaves the saved page for the page online, in the same tab, following where it has
  /// moved, which the tab then keeps; back is the saved page again, still running nothing
  @Test func goingToTheAddressLeavesTheSavedPageForTheOnlineOne() async throws {
    let (v, tabs) = try await tab(saved, html: savedFile())
    defer { done(tabs) }
    try await shown(v, "Saved A")
    v.openLocation(nil)
    let editor = try #require(v.bar.address.currentEditor() as? NSTextView)
    #expect(v.bar.address.stringValue == url("/moved").absoluteString)
    editor.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    try await shown(v, "Page A")
    #expect(v.page == .online(url("/a")) && tabs.tab(v)?.payload == ["url": url("/a").absoluteString])
    #expect(tabs.tab(v)?.title == "Page A" && tabs.tab(v)?.key == nil, "no longer gone to by the saved page's hash")
    #expect(asked.all == ["/moved", "/a"])
    #expect(v.bar.back.isEnabled)
    v.bar.back.performClick(nil)
    try await until("the saved page again") {
      v.page == saved && !v.web.isLoading && tabs.tab(v)?.payload == saved.payload
    }
    #expect(tabs.tab(v)?.key == "web:" + Self.hash)
    #expect(try await js(v, "return document.documentElement.hasAttribute('data-ran')") as? Bool == false)
    #expect(asked.all == ["/moved", "/a"])
  }

  /// With the scripts, a saved page is read in body view with its site's rule files, and full page shows it all
  /// again; the control is off, saying why, on an online page and without the scripts
  @Test func bodyAndFullPageReadASavedPage() async throws {
    let (v, tabs) = try await tab(saved, html: savedFile(), rules: [##"{"body":"#main"}"##])
    defer { done(tabs) }
    try await shown(v, "Saved A")
    #expect(v.bar.extract.isEnabled && v.bar.extract.selectedSegment == 0)
    let hidden = "return [...document.querySelectorAll('[data-shiyi-hidden]')].map(e => e.id).filter(Boolean).join(' ')"
    try await until("body view") { try await js(v, hidden) as? String == "nav pic" }
    v.bar.extract.selectedSegment = 1
    NSApp.sendAction(v.bar.extract.action!, to: v.bar.extract.target, from: v.bar.extract)
    try await until("full page") { try await js(v, hidden) as? String == "" }
    v.bar.extract.selectedSegment = 0
    NSApp.sendAction(v.bar.extract.action!, to: v.bar.extract.target, from: v.bar.extract)
    try await until("body view again") { try await js(v, hidden) as? String == "nav pic" }

    v.go(to: url("/a"))
    try await shown(v, "Page A")
    #expect(!v.bar.extract.isEnabled && v.bar.extract.toolTip?.isEmpty == false)
    #expect(try await js(v, "return document.documentElement.hasAttribute('data-reader')") as? Bool == false)

    let (bare, other) = try await tab(saved, html: savedFile(), scripts: false)
    defer { other.close() }
    try await shown(bare, "Saved A")
    #expect(!bare.bar.extract.isEnabled && bare.bar.extract.toolTip?.contains("scripts") == true)
  }

  /// The bar comes and goes on a saved page as on any: the scroll script runs in the app's world with the page's
  /// own scripts off; clearing the sites' data leaves a saved page as it is
  @Test func theBarComesAndGoesOnASavedPage() async throws {
    let long = "<!doctype html><title>Saved long</title><body style='margin:0'><div style='height:20000px'>long</div>"
    let (v, tabs) = try await tab(saved, html: long)
    defer { done(tabs) }
    try await shown(v, "Saved long")
    let page = v.web.frame
    _ = try await js(v, "scrollTo(0, 400)")
    try await until("the first offset heard") { v.visibility.offset == 400 }
    _ = try await js(v, "scrollTo(0, 3000)")
    try await until("the bar hidden") { !v.visibility.shown }
    _ = try await js(v, "scrollTo(0, 2900)")
    try await until("the bar shown") { v.visibility.shown }
    _ = try await js(v, "scrollTo(0, 5000)")
    try await until("the bar hidden again") { !v.visibility.shown }
    _ = try await js(v, "scrollTo(0, 0)")
    try await until("the bar shown at the top") { v.visibility.shown }
    #expect(v.web.frame == page)
    await WebReading.clearAll(in: tabs.websiteData)
    #expect(!v.web.isLoading && v.page == saved, "not loaded again")
  }

  /// A saved page whose file is not on this Mac says so in the tab, which keeps the saved title
  @Test func aSavedPageNotOnThisMacSaysSo() async throws {
    let (v, tabs) = try await tab(saved, html: nil)
    defer { done(tabs) }
    try await until("the page") { !v.web.isLoading && v.web.url != nil }
    try await until("it says so") {
      (try await js(v, "return document.body.innerText") as? String)?.contains("not on this Mac") == true
    }
    #expect(tabs.tab(v)?.title == "Saved A" && v.bar.address.stringValue == "127.0.0.1")
  }
}

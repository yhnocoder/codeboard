import AppKit
import Foundation
import Testing
import WebKit

@testable import CodeBoardReading

/// A web tab against made-up pages from a server on the loopback the test starts, in a window that is never ordered
/// in: nothing shows, and no page is fetched from anywhere else
@MainActor @Suite(.serialized) struct WebPageTests {
  let server: LoopbackServer
  let data = FileManager.default.temporaryDirectory.appending(path: "web-tab-\(UUID().uuidString)")

  init() async throws {
    _ = NSApplication.shared
    server = try await LoopbackServer(pages: Self.pages)
  }

  /// The made-up site: a long page, two pages linked to each other, a sign-in form whose answer sets a cookie, and a
  /// page that says which cookie came with it
  nonisolated static func pages(_ r: LoopbackServer.Request) -> LoopbackServer.Response {
    switch (r.method, r.path) {
    case ("GET", "/long"):
      return .html("<title>Long</title><body style='margin:0'><div style='height:20000px'>long</div>")
    case ("GET", "/a"): return .html("<title>Page A</title><a id='next' href='/b'>to B</a>")
    case ("GET", "/b"): return .html("<title>Page B</title><a href='/a'>to A</a>")
    case ("GET", "/login"):
      return .html(
        "<title>Sign in</title><form method='post' action='/signin'><input name='user' value='reader'>"
          + "<button id='go'>Sign in</button></form>")
    case ("POST", "/signin"):
      return .html(
        "<title>Signed in</title>", headers: ["Set-Cookie": "session=made-up-token; Path=/; Max-Age=3600"])
    case ("GET", "/home"):
      return .html("<title>\(r.headers["cookie"] ?? "no cookie")</title>")
    default: return LoopbackServer.Response(status: "404 Not Found", body: "<title>Missing</title>")
    }
  }

  func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(server.port)\(path)")! }

  /// A tab's view in a window never ordered in, with its own store unless one is given
  func tab(
    _ path: String?, store: WKWebsiteDataStore = .nonPersistent(),
    changed: @escaping (String?, URL?) -> Void = { _, _ in }
  ) -> (WebPageView, NSWindow) {
    let context = WebReading.Context(dataDirectory: data, websiteData: store, changed: changed)
    let view = WebReading.makeView(url: path.map(url), context: context) as! WebPageView
    let window = NSWindow(
      contentRect: CGRect(x: -30000, y: -30000, width: 600, height: 500), styleMask: [.titled], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = view
    window.layoutIfNeeded()
    return (view, window)
  }

  func done(_ w: NSWindow) {
    w.close()
    try? FileManager.default.removeItem(at: data)
  }

  func js(_ view: WebPageView, _ script: String) async throws -> Any? {
    try await view.web.evaluateJavaScript(script)
  }

  /// The page fills the tab, the bar floats over its bottom edge with the toolbar's numbers, and nothing is above
  /// the page
  @Test func thePageFillsTheTabAndTheBarFloatsOverItsBottom() throws {
    let (v, w) = tab("/long")
    defer { done(w) }
    let look = WebReading.BarLook()
    #expect(v.web.frame == v.bounds)
    #expect(v.bar.frame.maxY == v.bounds.height - look.bottom && v.bar.frame.height == look.height)
    #expect(v.bar.frame.minX == look.side && v.bar.frame.maxX == v.bounds.width - look.side)
    #expect(v.subviews.allSatisfy { $0 === v.web || $0.frame.minY > v.bounds.height / 2 }, "nothing over the top")
    #expect(v.web.allowsBackForwardNavigationGestures)
    let controls: [NSControl] = [v.bar.back, v.bar.forward, v.bar.address, v.bar.extract, v.bar.translate, v.bar.save]
    #expect(controls.allSatisfy { $0.accessibilityIdentifier().hasPrefix("ui-web-") })
    #expect(!v.bar.extract.isEnabled && !v.bar.translate.isEnabled && !v.bar.save.isEnabled)
    #expect(v.bar.extract.segmentCount == 2 && v.bar.translate.segmentCount == 3)
    #expect([v.bar.back, v.bar.forward, v.bar.save].allSatisfy { $0.toolTip?.isEmpty == false })
  }

  /// Scrolling down the page hides the bar without laying the page out again, scrolling back up shows it, and the
  /// top of the page shows it
  @Test func scrollingThePageHidesAndShowsTheBar() async throws {
    let (v, w) = tab("/long")
    defer { done(w) }
    try await until("the long page") { v.web.title == "Long" && !v.web.isLoading }
    let page = v.web.frame
    _ = try await js(v, "scrollTo(0, 400); 0")
    try await until("the first offset heard") { v.visibility.offset == 400 }
    #expect(v.visibility.shown)
    _ = try await js(v, "scrollTo(0, 3000); 0")
    try await until("the bar hidden") { !v.visibility.shown }
    #expect(v.web.frame == page, "the page stays where it was")
    _ = try await js(v, "scrollTo(0, 2900); 0")
    try await until("the bar shown") { v.visibility.shown }
    _ = try await js(v, "scrollTo(0, 5000); 0")
    try await until("the bar hidden again") { !v.visibility.shown }
    _ = try await js(v, "scrollTo(0, 0); 0")
    try await until("the bar shown at the top") { v.visibility.shown }
    #expect(v.web.frame == page)
  }

  /// Back and forward go through the page's history and are off when there is none; the tab hears of each title
  /// and address; the visits are written down
  @Test func backAndForwardFollowThePagesHistory() async throws {
    var heard: [String] = []
    let (v, w) = tab("/a") { title, _ in if let title, heard.last != title { heard.append(title) } }
    defer { done(w) }
    try await until("page A") { v.web.title == "Page A" && !v.web.isLoading }
    #expect(!v.bar.back.isEnabled && !v.bar.forward.isEnabled)
    #expect(v.bar.address.stringValue == "127.0.0.1")
    _ = try await js(v, "document.getElementById('next').click(); 0")
    try await until("page B") { v.web.title == "Page B" && !v.web.isLoading }
    #expect(v.bar.back.isEnabled && !v.bar.forward.isEnabled)
    v.bar.back.performClick(nil)
    try await until("back on page A") { v.web.title == "Page A" && v.bar.forward.isEnabled }
    #expect(!v.bar.back.isEnabled)
    v.bar.forward.performClick(nil)
    try await until("forward on page B") { v.web.title == "Page B" && !v.bar.forward.isEnabled }
    #expect(Array(heard.filter { $0.hasPrefix("Page") }.prefix(4)) == ["Page A", "Page B", "Page A", "Page B"])
    let file = data.appending(path: "history.json")
    try await until("both visits written") {
      let h = await WebHistoryFile.shared.read(file)
      return h.entries.first { $0.url == url("/a") }?.count == 2 && h.entries.contains { $0.url == url("/b") }
    }
    let h = await WebHistoryFile.shared.read(file)
    #expect(h.entries.first { $0.url == url("/a") }?.title == "Page A")
  }

  /// Signing in keeps the cookie in the tab's store, sends it with the next page, and leaves the default store alone
  @Test func aSignInStaysInTheTabsStore() async throws {
    let store = WKWebsiteDataStore.nonPersistent()
    let (v, w) = tab("/login", store: store)
    defer { done(w) }
    try await until("the form") { v.web.title == "Sign in" && !v.web.isLoading }
    _ = try await js(v, "document.getElementById('go').click(); 0")
    try await until("signed in") { v.web.title == "Signed in" && !v.web.isLoading }
    let mine = await store.httpCookieStore.allCookies()
    #expect(mine.contains { $0.name == "session" && $0.value == "made-up-token" })
    let elsewhere = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
    #expect(!elsewhere.contains { $0.name == "session" && $0.domain == "127.0.0.1" })
    v.go(to: url("/home"))
    try await until("home") { v.web.url == url("/home") && !v.web.isLoading && v.web.title != nil }
    #expect(v.web.title == "session=made-up-token")
  }

  /// A blank tab edits its address at once; Return goes; ⌘L edits the whole address again, Escape gives it up;
  /// typing suggests the pages visited, the arrows choose one and Return goes there
  @Test func theAddressIsEditedGoneToAndSuggested() async throws {
    let (v, w) = tab(nil)
    defer { done(w) }
    let field = v.bar.address
    #expect(field.isEditing && v.visibility.shown)
    var editor = try #require(field.currentEditor() as? NSTextView)
    editor.insertText("127.0.0.1:\(server.port)/a", replacementRange: editor.selectedRange())
    editor.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    try await until("page A") { v.web.title == "Page A" && !v.web.isLoading }
    #expect(!field.isEditing && field.stringValue == "127.0.0.1")
    _ = try await js(v, "document.getElementById('next').click(); 0")
    try await until("page B") { v.web.title == "Page B" && !v.web.isLoading }

    w.makeFirstResponder(v.web)
    let key = try #require(
      NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: w.windowNumber,
        context: nil, characters: "l", charactersIgnoringModifiers: "l", isARepeat: false, keyCode: 37))
    #expect(v.performKeyEquivalent(with: key))
    editor = try #require(field.currentEditor() as? NSTextView)
    #expect(field.stringValue == url("/b").absoluteString && editor.selectedRange().length == field.stringValue.count)
    editor.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
    #expect(!field.isEditing && field.stringValue == "127.0.0.1" && w.firstResponder === v.web)

    let file = data.appending(path: "history.json")
    try await until("both visits written with their titles") {
      await WebHistoryFile.shared.read(file).entries.filter { $0.count == 1 && $0.title.hasPrefix("Page") }.count == 2
    }
    v.openLocation(nil)
    try await until("the history read") { v.history.entries.count == 2 }
    editor = try #require(field.currentEditor() as? NSTextView)
    editor.insertText("page", replacementRange: editor.selectedRange())
    #expect(v.suggestions.entries.map(\.title).sorted() == ["Page A", "Page B"] && !v.suggestions.isHidden)
    let first = try #require(v.suggestions.entries.first).url
    editor.doCommand(by: #selector(NSResponder.moveUp(_:)))
    #expect(field.stringValue == first.absoluteString)
    editor.doCommand(by: #selector(NSResponder.moveDown(_:)))
    #expect(field.stringValue == "page", "back to what was typed")
    editor.doCommand(by: #selector(NSResponder.moveUp(_:)))
    editor.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    #expect(v.suggestions.isHidden && !field.isEditing)
    try await until("the suggestion") { v.web.url == first && !v.web.isLoading }
  }
}

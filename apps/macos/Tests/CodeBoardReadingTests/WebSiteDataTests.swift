import AppKit
import Foundation
import Testing
import WebKit

@testable import CodeBoardReading

/// The sites in a web tabs' store, listed and cleared, against made-up pages on the loopback (127.0.0.1 and localhost
/// are two sites to WebKit), each test with a store of its own that is never written to disk
@MainActor @Suite(.serialized) struct WebSiteDataTests {
  let server: LoopbackServer
  let data = FileManager.default.temporaryDirectory.appending(path: "web-sites-\(UUID().uuidString)")

  init() async throws {
    _ = NSApplication.shared
    server = try await LoopbackServer(pages: Self.pages)
  }

  /// Signing in sets a cookie; home says which cookie came with it; ua says who asked
  nonisolated static func pages(_ r: LoopbackServer.Request) -> LoopbackServer.Response {
    switch r.path {
    case "/signin":
      .html("<title>Signed in</title>", headers: ["Set-Cookie": "session=made-up-token; Path=/; Max-Age=3600"])
    case "/home": .html("<title>\(r.headers["cookie"] ?? "no cookie")</title>")
    case "/ua": .html("<title>\(r.headers["user-agent"] ?? "")</title>")
    default: LoopbackServer.Response(status: "404 Not Found", body: "<title>Missing</title>")
    }
  }

  func url(_ host: String, _ path: String) -> URL { URL(string: "http://\(host):\(server.port)\(path)")! }

  /// A tab's view in a window never ordered in
  func tab(_ url: URL, store: WKWebsiteDataStore) -> (WebPageView, NSWindow) {
    let view = WebPageView(page: .online(url), context: WebReading.Context(dataDirectory: data, websiteData: store))
    let window = NSWindow(
      contentRect: CGRect(x: -30000, y: -30000, width: 600, height: 500), styleMask: [.titled], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = view
    return (view, window)
  }

  func signedIn(_ v: WebPageView, at host: String) async throws {
    try await until("signed in at \(host)") { v.web.title == "Signed in" && !v.web.isLoading }
    v.go(to: url(host, "/home"))
    try await until("home at \(host)") { v.web.title == "session=made-up-token" && !v.web.isLoading }
  }

  func kinds(in store: WKWebsiteDataStore) async -> [String: Set<WebReading.SiteData.Kind>] {
    Dictionary(uniqueKeysWithValues: await WebReading.sites(in: store).map { ($0.domain, $0.kinds) })
  }

  func js(_ v: WebPageView, _ script: String) async throws -> Any? { try await v.web.evaluateJavaScript(script) }

  /// Each site is listed by its domain with what it keeps; clearing one signs out its tabs and leaves the other site,
  /// its tabs and their pages as they were; clearing everything signs out every tab of the store, and no other store
  @Test func sitesAreListedAndClearedOneOrAllAndTheirTabsAreSignedOut() async throws {
    let store = WKWebsiteDataStore.nonPersistent()
    let (a, wa) = tab(url("127.0.0.1", "/signin"), store: store)
    let (b, wb) = tab(url("localhost", "/signin"), store: store)
    let other = WKWebsiteDataStore.nonPersistent()
    let (c, wc) = tab(url("127.0.0.1", "/signin"), store: other)
    defer {
      for w in [wa, wb, wc] { w.close() }
      try? FileManager.default.removeItem(at: data)
    }
    try await signedIn(a, at: "127.0.0.1")
    try await signedIn(b, at: "localhost")
    try await signedIn(c, at: "127.0.0.1")
    _ = try await js(a, "localStorage.setItem('draft', 'kept'); window.untouched = 1; 0")
    _ = try await js(c, "window.untouched = 1; 0")
    try await until("both sites listed with what they keep") {
      let sites = await WebReading.sites(in: store)
      return sites.map(\.domain) == ["127.0.0.1", "localhost"] && sites[0].kinds.isSuperset(of: [.cookies, .storage])
        && sites[1].kinds.contains(.cookies)
    }

    await WebReading.clear(domain: "localhost", in: store)
    try await until("the localhost tab signed out") { b.web.title == "no cookie" && !b.web.isLoading }
    // the page loaded again is in the memory cache of its site, which is listed again with that alone
    var kept = await kinds(in: store)
    #expect(kept["127.0.0.1"]?.isSuperset(of: [.cookies, .storage]) == true && kept["localhost"] ?? [] == [.cache])
    #expect(a.web.title == "session=made-up-token")
    #expect(try await js(a, "window.untouched") as? Int == 1, "the other site's page is not loaded again")
    #expect(b.web.url == url("localhost", "/home"))

    await WebReading.clearAll(in: store)
    try await until("the 127.0.0.1 tab signed out") { a.web.title == "no cookie" && !a.web.isLoading }
    #expect(try await js(a, "localStorage.getItem('draft')") is NSNull)
    kept = await kinds(in: store)
    #expect(kept.values.allSatisfy { $0 == [.cache] }, "\(kept)")
    #expect(try await js(c, "window.untouched") as? Int == 1, "a tab of another store is left alone")
    #expect(await other.httpCookieStore.allCookies().contains { $0.name == "session" })
  }

  /// Clearing a site that has no data is no error
  @Test func clearingASiteWithNoDataChangesNothing() async throws {
    let store = WKWebsiteDataStore.nonPersistent()
    await WebReading.clear(domain: "example.com", in: store)
    #expect(await WebReading.sites(in: store).isEmpty)
  }

  @Test(arguments: [
    ("www.zhihu.com", "zhihu.com", true), ("zhihu.com", "zhihu.com", true), ("WWW.Zhihu.com", "zhihu.com", true),
    ("notzhihu.com", "zhihu.com", false), ("zhihu.com.example", "zhihu.com", false), ("127.0.0.1", "127.0.0.1", true),
  ])
  func aHostIsOfItsDomain(_ host: String, _ domain: String, _ yes: Bool) {
    #expect(WebReading.host(host, isOf: domain) == yes)
  }

  /// Pages are asked for as the Safari of this macOS would ask, and see the same in the page
  @Test func pagesSeeSafariOnThisMac() async throws {
    let (v, w) = tab(url("127.0.0.1", "/ua"), store: .nonPersistent())
    defer { w.close() }
    try await until("the page") { v.web.title?.isEmpty == false && !v.web.isLoading }
    let sent = try #require(v.web.title)
    let os = ProcessInfo.processInfo.operatingSystemVersion
    #expect(sent.hasPrefix("Mozilla/5.0 (Macintosh; "))
    let safari = "Version/\(os.majorVersion).\(os.minorVersion) Safari/605.1.15"
    #expect(sent.hasSuffix(") AppleWebKit/605.1.15 (KHTML, like Gecko) " + safari), "\(sent)")
    #expect(try await js(v, "navigator.userAgent") as? String == sent)
  }
}

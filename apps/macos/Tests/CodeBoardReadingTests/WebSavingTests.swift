import AppKit
import Foundation
import Testing
import WebKit

@testable import CodeBoardReading

/// Saving from a web tab's bar, against made-up pages on the loopback and stand-ins for the saving service's scripts
/// (StandInScripts), in a window never ordered in; the save menu is tried by its items, never popped up
@MainActor @Suite(.serialized) struct WebSavingTests {
  let server: LoopbackServer
  let data = FileManager.default.temporaryDirectory.appending(path: "web-saving-\(UUID().uuidString)")
  let scripts: URL

  init() async throws {
    _ = NSApplication.shared
    server = try await LoopbackServer(pages: Self.pages)
    scripts = try StandInScripts.folder()
  }

  /// Two pages, and the one resource the stand-in capture fetches, which says which cookie came with it
  nonisolated static func pages(_ r: LoopbackServer.Request) -> LoopbackServer.Response {
    switch r.path.prefix(while: { $0 != "?" }) {
    case "/a": .html("<title>Page A</title><a id='next' href='/b'>to B</a>")
    case "/b": .html("<title>Page B</title>")
    case "/asset": LoopbackServer.Response(body: "asset for \(r.headers["cookie"] ?? "no cookie")")
    default: LoopbackServer.Response(status: "404 Not Found", body: "<title>Missing</title>")
    }
  }

  func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(server.port)\(path)")! }

  func tab(
    _ path: String, saving: TestSaving?, scripts: Bool = true, store: WKWebsiteDataStore = .nonPersistent()
  ) -> (WebPageView, NSWindow) {
    let context = WebReading.Context(
      dataDirectory: data, websiteData: store, saving: saving, scripts: scripts ? self.scripts : nil)
    let view = WebReading.makeView(url: url(path), context: context) as! WebPageView
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
    try? FileManager.default.removeItem(at: scripts)
  }

  func loaded(_ v: WebPageView, _ title: String) async throws {
    try await until(title) { v.web.title == title && !v.web.isLoading }
  }

  /// Without the scripts the menu offers a link alone, saved with the page's own title and address; the button then
  /// says it is saved as a link
  @Test func withoutTheScriptsALinkIsSavedWithThePagesTitleAndAddress() async throws {
    let saving = TestSaving()
    let (v, w) = tab("/a", saving: saving, scripts: false)
    defer { done(w) }
    try await loaded(v, "Page A")
    #expect(v.saveState == .saved(.unsaved) && v.bar.save.isEnabled)
    let menu = v.saveMenu()
    #expect(menu.items.map(\.title) == ["Save Link", "Save Full Page"])
    #expect(menu.items[0].isEnabled && !menu.items[1].isEnabled)
    #expect(menu.items[1].toolTip?.contains("scripts") == true, "it says why")
    menu.performActionForItem(at: 0)
    try await until("the link saved") { await saving.links.count == 1 }
    #expect(await saving.links == [WebReading.PageMeta(url: url("/a"), title: "Page A")])
    try await until("the button says so") { v.saveState == .saved(.link) }
    #expect(v.bar.save.toolTip == "Saved as a Link" && v.bar.save.accessibilityValue() as? String == "Saved as a Link")
  }

  /// Each page loaded asks the owner how it is saved; with no owner the button is off and says why
  @Test func theButtonShowsHowEachPageLoadedIsSaved() async throws {
    let saving = TestSaving()
    await saving.set(url("/a"), .link)
    await saving.set(url("/b"), .page(hash: "made-up-hash"))
    let (v, w) = tab("/a", saving: saving)
    defer { done(w) }
    try await loaded(v, "Page A")
    try await until("page A saved as a link") { v.saveState == .saved(.link) }
    _ = try await v.web.evaluateJavaScript("document.getElementById('next').click(); 0")
    try await until("page B saved whole") { v.saveState == .saved(.page(hash: "made-up-hash")) }
    #expect(v.bar.save.toolTip == "Saved as a Full Page")

    let (off, w2) = tab("/a", saving: nil)
    defer { w2.close() }
    try await loaded(off, "Page A")
    #expect(!off.bar.save.isEnabled && off.bar.save.toolTip?.isEmpty == false)
  }

  /// With the scripts, a link takes what the metadata script read; the hooks ran in the page's own world
  @Test func aLinkTakesTheMetadataTheScriptRead() async throws {
    let saving = TestSaving()
    let (v, w) = tab("/a", saving: saving)
    defer { done(w) }
    try await loaded(v, "Page A")
    #expect(try await v.web.evaluateJavaScript("window.hooked === true") as? Bool == true)
    v.saveMenu().performActionForItem(at: 0)
    try await until("the link saved") { await saving.links.count == 1 }
    let link = try #require(await saving.links.first)
    #expect(link.url == url("/a") && link.title == "Page A" && link.description == "A made-up page")
    #expect(link.siteName == "Loopback" && link.icon == url("/icon.png") && link.cover == url("/cover.png"))
  }

  /// Saving a page whole: the script's fetch is answered with the tab's cookie, its two chunks written in order, the
  /// rule files of its host handed to it; the owner gets the one file and the metadata and gives back the hash the
  /// button then shows; the file is gone after
  @Test func aFullPageIsCapturedAndHandedToTheOwner() async throws {
    let saving = TestSaving()
    await saving.set(rules: [##"{"body":"#main"}"##], forHost: "127.0.0.1")
    let store = WKWebsiteDataStore.nonPersistent()
    let cookie = try #require(
      HTTPCookie(properties: [.name: "session", .value: "made-up-token", .domain: "127.0.0.1", .path: "/"]))
    await store.httpCookieStore.setCookie(cookie)
    let (v, w) = tab("/a", saving: saving, store: store)
    defer { done(w) }
    try await loaded(v, "Page A")
    let menu = v.saveMenu()
    #expect(menu.items[1].isEnabled)
    menu.performActionForItem(at: 1)
    #expect(v.capture != nil && !v.bar.save.toolTip!.isEmpty)
    try await until("the page saved") { await saving.pages.count == 1 }
    let page = try #require(await saving.pages.first)
    #expect(
      page.html == "<!doctype html><title>Page A</title><p id=asset>asset for session=made-up-token 200</p>"
        + ##"<p id=rules>[{"body":"#main"}]</p>"##)
    #expect(page.meta.url == url("/a") && page.meta.description == "A made-up page")
    try await until("the button says so") { v.saveState == .saved(.page(hash: "hash-1")) }
    #expect(v.capture == nil && !FileManager.default.fileExists(atPath: page.file.path))
  }

  /// A saving shows its stage on the button; Escape stops it, and so does leaving the page; nothing reaches the owner
  @Test func escapeOrLeavingThePageStopsASaving() async throws {
    let saving = TestSaving()
    let (v, w) = tab("/a?hold", saving: saving)
    defer { done(w) }
    try await loaded(v, "Page A")
    v.saveMenu().performActionForItem(at: 1)
    try await until("the first stage") { v.saveState == .saving(stage: "prepare") }
    #expect(v.bar.save.toolTip?.contains(WebBar.stageName("prepare")) == true)
    w.makeFirstResponder(v.web)
    #expect(v.web.tryToPerform(#selector(NSResponder.cancelOperation(_:)), with: nil))
    try await until("stopped") { v.capture == nil && v.saveState == .saved(.unsaved) }

    v.saveMenu().performActionForItem(at: 1)
    try await until("saving again") { v.saveState == .saving(stage: "prepare") }
    v.go(to: url("/b"))
    try await loaded(v, "Page B")
    try await until("stopped by leaving") { v.capture == nil && v.saveState == .saved(.unsaved) }
    #expect(await saving.pages.isEmpty)
  }

  /// A saving that fails says why on the button, with no alert, until the next page
  @Test func aFailedSavingSaysWhyOnTheButton() async throws {
    let saving = TestSaving()
    let (v, w) = tab("/a?fail", saving: saving)
    defer { done(w) }
    try await loaded(v, "Page A")
    v.saveMenu().performActionForItem(at: 1)
    let why = WebSaveError(code: "too-large", message: "").shown
    try await until("the failure shown") { v.saveState == .failed(why) }
    #expect(v.bar.save.toolTip == why && w.attachedSheet == nil && NSApp.modalWindow == nil)
    #expect(await saving.pages.isEmpty)
    v.go(to: url("/b"))
    try await until("cleared on the next page") { v.saveState == .saved(.unsaved) }
  }
}

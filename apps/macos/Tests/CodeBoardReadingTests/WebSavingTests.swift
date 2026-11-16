import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing
import WebKit

@testable import CodeBoardReading

/// Saving from a web tab's bar into a vault in a temporary folder, against made-up pages on the loopback and stand-ins
/// for the saving service (TestStore) and its scripts (StandInScripts), in a window never ordered in; the save menu is
/// tried by its items, never popped up
@MainActor @Suite(.serialized) struct WebSavingTests {
  let server: LoopbackServer
  let scripts: URL
  let vault: Vault

  init() async throws {
    _ = NSApplication.shared
    server = try await LoopbackServer(pages: Self.pages)
    scripts = try StandInScripts.folder()
    let root = FileManager.default.temporaryDirectory.appending(path: "web-saving-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    vault = Vault(root: root)
  }

  /// Two pages, and the one resource the stand-in capture fetches, which says which cookie came with it
  nonisolated static func pages(_ r: LoopbackServer.Request) -> LoopbackServer.Response {
    switch r.path.prefix(while: { $0 != "?" }) {
    case "/a": .html("<title>Page A</title><a id='next' href='/b'>to B</a>")
    case "/b": .html("<title>Page B</title>")
    case "/mute": .html("<title>Page Mute</title>")
    case "/late": .html("<title>Page Late</title>")
    case "/asset": LoopbackServer.Response(body: "asset for \(r.headers["cookie"] ?? "no cookie")")
    default: LoopbackServer.Response(status: "404 Not Found", body: "<title>Missing</title>")
    }
  }

  func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(server.port)\(path)")! }

  /// A tab on `path` in a pane on the vault (none: `vault` false)
  func tab(
    _ path: String, store: TestStore? = nil, scripts: Bool = true, vault: Bool = true,
    websiteData: WKWebsiteDataStore = .nonPersistent()
  ) throws -> (WebPageView, WebTabs) {
    let tabs = try WebTabs(
      vault: vault ? self.vault : nil, store: store, scripts: scripts ? self.scripts : nil, websiteData: websiteData)
    return (tabs.open(["url": url(path).absoluteString]), tabs)
  }

  func done(_ tabs: WebTabs) {
    tabs.close()
    try? FileManager.default.removeItem(at: vault.root)
    try? FileManager.default.removeItem(at: scripts)
  }

  func loaded(_ v: WebPageView, _ title: String) async throws {
    try await until(title) { v.web.title == title && !v.web.isLoading }
  }

  /// The vault's web resources, and the entries of each
  func web() throws -> [(VaultResource, [Entry])] {
    try vault.tree().allFolders.flatMap(\.resources).filter { $0.preset == .web }.map { r in
      (r, try vault.items(in: r.path).compactMap { if case .entry(let e, _) = $0 { e } else { nil } })
    }
  }

  /// With neither the service nor its scripts, the menu offers a link alone, saved into a new web resource 网页 at the
  /// top of the vault as an entry of the page's address and title; the button then says it is saved as a link, and
  /// the same page in another tab knows it from the vault
  @Test func withoutTheServiceALinkIsSavedIntoANewWebResource() async throws {
    let (v, tabs) = try tab("/a", scripts: false)
    defer { done(tabs) }
    try await loaded(v, "Page A")
    #expect(v.saveState == .saved(.unsaved) && v.bar.save.isEnabled)
    let menu = v.saveMenu()
    #expect(menu.items.map(\.title) == ["Save Link", "Save Full Page"])
    #expect(menu.items[0].isEnabled && !menu.items[1].isEnabled)
    #expect(menu.items[1].toolTip?.contains("scripts") == true, "it says why")
    menu.performActionForItem(at: 0)
    try await until("the button says so") { v.saveState == .saved(.link) }
    #expect(v.bar.save.toolTip == "Saved as a Link" && v.bar.save.accessibilityValue() as? String == "Saved as a Link")
    let saved = try web()
    #expect(saved.map(\.0.title) == ["网页"] && saved.first?.0.folder == "")
    let entry = try #require(saved.first?.1.first)
    #expect(entry.title == "Page A" && entry.origin == .web(url("/a").absoluteString) && entry.versions.isEmpty)
    #expect(entry.meta?.title == "Page A" && entry.meta?.fetchedAt != nil)

    let again = tabs.open(["url": url("/a").absoluteString])
    try await loaded(again, "Page A")
    #expect(again.saveState == .saved(.link))
  }

  /// A link kept without a tab goes into the resource named, once: the same address again, with or without a
  /// fragment, gives the entry it has, untouched; what is not a web page's address gives none
  @Test func anAddressIsKeptAsALinkWithoutATab() async throws {
    let tabs = try WebTabs(vault: vault, scripts: nil)
    defer { done(tabs) }
    let r = try vault.newResource(in: "", title: "Reading", preset: .web)
    let first = try #require(try tabs.pane.saveLink(url("/a"), title: "Kept", in: r.path))
    #expect(first.title == "Kept" && first.origin == .web(url("/a").absoluteString) && first.versions.isEmpty)
    let again = try tabs.pane.saveLink(try #require(URL(string: url("/a").absoluteString + "#part")), in: r.path)
    let kept = try vault.items(in: r.path).count
    #expect(again == first && kept == 1)
    #expect(tabs.pane.entries.all.map(\.entry) == [first])
    let other = try tabs.pane.saveLink(try #require(URL(string: "file:///etc/hosts")), in: r.path)
    #expect(other == nil)
  }

  /// A vault that has a web resource, in a folder, saves into it; each page loaded says how the vault has it saved,
  /// a link or its latest page whole; with no vault the button is off and says why
  @Test func theButtonShowsHowTheVaultHasEachPageSaved() async throws {
    try vault.newFolder(in: "", name: "Reading")
    let r = try vault.newResource(in: "Reading", title: "Pages", preset: .web)
    let hash = TestStore.hash(7)
    try vault.save(SavedItem(id: "l", kind: .link, url: url("/a").absoluteString, title: "A", savedAt: 1), in: r.path)
    try vault.save(
      SavedItem(id: "p", kind: .page, url: url("/b").absoluteString, title: "B", savedAt: 2, pageHash: hash, bytes: 3),
      in: r.path)
    let (v, tabs) = try tab("/a")
    defer { done(tabs) }
    try await loaded(v, "Page A")
    try await until("page A saved as a link") { v.saveState == .saved(.link) }
    _ = try await v.web.evaluateJavaScript("document.getElementById('next').click(); 0")
    try await until("page B saved whole") { v.saveState == .saved(.page(hash: hash)) }
    #expect(v.bar.save.toolTip == "Saved as a Full Page")
    v.saveMenu().performActionForItem(at: 0)
    try await until("saved into the vault's resource") {
      try vault.items(in: r.path).contains { if case .entry(let e, _) = $0 { e.meta != nil } else { false } }
    }
    #expect(try web().count == 1 && vault.items(in: r.path).count == 2)

    let (off, other) = try tab("/a", vault: false)
    defer { other.close() }
    try await loaded(off, "Page A")
    #expect(!off.bar.save.isEnabled && off.bar.save.toolTip?.isEmpty == false)
  }

  /// A tab restored at launch loads its page before the shell has read the vault's entries: once it has, the button
  /// says how the page is saved, without leaving it
  @Test func aTabLoadedBeforeTheEntriesAreReadShowsHowItsPageIsSavedOnceTheyAre() async throws {
    let r = try vault.newResource(in: "", title: "Pages", preset: .web)
    try vault.save(SavedItem(id: "l", kind: .link, url: url("/a").absoluteString, title: "A", savedAt: 1), in: r.path)
    let tabs = try WebTabs(vault: vault, scripts: scripts)
    defer { done(tabs) }
    tabs.pane.entries = EntryIndex()
    let v = tabs.open(["url": url("/a").absoluteString])
    try await loaded(v, "Page A")
    #expect(v.saveState == .saved(.unsaved))
    tabs.pane.entries = EntryIndex(vault, try vault.tree())
    tabs.pane.follow { ReadingKinds.follow($0, in: tabs.pane) }
    #expect(v.saveState == .saved(.link) && v.bar.save.toolTip == "Saved as a Link")
    #expect(tabs.tab(v)?.title == "Page A" && v.web.url == url("/a"))
  }

  /// With the scripts, a link takes what the metadata script read, its pictures by address; the service is told of the
  /// link after; the hooks ran in the page's own world
  @Test func aLinkTakesTheMetadataTheScriptRead() async throws {
    let store = TestStore()
    let (v, tabs) = try tab("/a", store: store)
    defer { done(tabs) }
    try await loaded(v, "Page A")
    #expect(try await v.web.evaluateJavaScript("window.hooked === true") as? Bool == true)
    v.saveMenu().performActionForItem(at: 0)
    #expect(v.saveState == .saved(.link))
    try await until("the metadata added") { try web().first?.1.first?.meta?.description != nil }
    try await until("the service told") {
      await store.links == [PageLink(url: url("/a").absoluteString, title: "Page A")]
    }
    let entry = try #require(try web().first?.1.first)
    let meta = try #require(entry.meta)
    #expect(meta.title == "Page A" && meta.description == "A made-up page" && meta.site == "Loopback")
    #expect(meta.icon == .url(url("/icon.png").absoluteString) && meta.image == .url(url("/cover.png").absoluteString))
    #expect(entry.added <= meta.fetchedAt ?? 0, "when the link was saved, not when the script or the service answers")
  }

  /// The metadata script that never answers (as WebKit never does for a call made while the page is being left) does
  /// not keep the link from being saved: it is in the vault with the page's title as the press returns
  @Test func aLinkIsSavedWhenTheMetadataScriptNeverAnswers() async throws {
    let (v, tabs) = try tab("/mute")
    defer { done(tabs) }
    try await loaded(v, "Page Mute")
    v.saveMenu().performActionForItem(at: 0)
    #expect(v.saveState == .saved(.link))
    let meta = try #require(try web().first?.1.first?.meta)
    #expect(meta.title == "Page Mute" && meta.description == nil)
  }

  /// A metadata script that answers late: the entry is there with the title as the press returns, and what the
  /// script read is added to it when it answers
  @Test func aLinkIsThereAtOnceAndTakesItsMetadataWhenTheScriptAnswers() async throws {
    let (v, tabs) = try tab("/late")
    defer { done(tabs) }
    try await loaded(v, "Page Late")
    v.saveMenu().performActionForItem(at: 0)
    #expect(v.saveState == .saved(.link))
    let first = try #require(try web().first?.1.first)
    #expect(first.title == "Page Late" && first.meta?.title == "Page Late" && first.meta?.description == nil)
    #expect(tabs.pane.entries.all.map(\.entry) == [first], "the sidebar and the lists have it already")
    // (the page's icon a one-pixel PNG: the loopback server answers with text only)
    let png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    _ = try await v.web.evaluateJavaScript(
      "document.documentElement.dataset.icon = '\(png)'; document.documentElement.dataset.answer = '1'; 0")
    try await until("the metadata added") { try web().first?.1.first?.meta?.description == "A made-up page" }
    try await until("the site's icon kept as a file") { try web().first?.1.first?.meta?.icon == .file("icon.png") }
    let entries = try web().first?.1
    #expect(entries?.count == 1 && entries?.first?.id == first.id && entries?.first?.added == first.added)
    let found = try #require(tabs.pane.entries.all.first)
    let vault = try #require(tabs.pane.vault)
    let file = vault.url(of: found.path).appending(path: Vault.imagesFolder).appending(path: "icon.png")
    #expect(FileManager.default.fileExists(atPath: file.path))
    #expect(WebReading.sourceLabel(SourceAnchor(entry: found.entry.id), in: tabs.pane)?.icon == .image(file))
  }

  /// A link added without a tab is read by the reader the shell gives: its entry takes the page's title, description
  /// and site, and its icon as a file; with no reader, or a page that cannot be read, it stays as it was added
  @Test func aLinkAddedWithoutATabIsReadAndKeepsItsIcon() async throws {
    let tabs = try WebTabs(vault: vault, store: nil, scripts: nil)
    defer { done(tabs) }
    let pane = tabs.pane
    let resource = try vault.newResource(in: "", title: "Links", preset: .web).path
    let png = try #require(
      Data(
        base64Encoded:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="))
    func add(_ address: String) throws -> (SavedItem, String) {
      let item = SavedItem(id: "", kind: .link, url: address, title: address, savedAt: 1_000)
      let path = try vault.save(item, in: resource)
      pane.entries.update(try vault.entry(at: path), at: path)
      pane.readLink(item, in: resource)
      return (item, path)
    }
    let (_, bare) = try add("https://example.org/bare")
    #expect(try vault.entry(at: bare).meta == nil, "no reader: as it was added")

    pane.readsPage = { url in
      url.path == "/gone"
        ? nil : PageRead(title: "A Page", description: "About it", site: "Example", icon: png, iconEnding: "png")
    }
    let (_, read) = try add("https://example.org/read")
    try await until("read") { try vault.entry(at: read).meta?.icon == .file("icon.png") }
    let e = try vault.entry(at: read)
    #expect(e.title == "A Page" && e.meta?.description == "About it" && e.meta?.site == "Example")
    #expect(pane.entries[e.id]?.entry == e, "the pane knows")
    let file = vault.url(of: read).appending(path: Vault.imagesFolder).appending(path: "icon.png")
    #expect(try Data(contentsOf: file) == png)
    #expect(WebReading.sourceLabel(SourceAnchor(entry: e.id), in: pane)?.icon == .image(file))
    let (_, gone) = try add("https://example.org/gone")
    try await Task.sleep(for: .milliseconds(50))
    #expect(try vault.entry(at: gone).meta == nil && vault.entry(at: gone).title == "https://example.org/gone")
  }

  /// Saving a page whole: the script's fetch is answered with the tab's cookie, its two chunks written in order, the
  /// rule files of its host handed to it, the vault's own first; the service gets the one file, and the page's entry
  /// one version of the hash it gave, which the button then shows; the file is gone after
  @Test func aFullPageIsCapturedKeptByTheServiceAndListedInTheVault() async throws {
    let store = TestStore()
    await store.set(
      rules: [
        ##"{"domain":"127.0.0.1","origin":"vault","rules":{"variants":[{"hide":["#ad"]}]}}"##,
        ##"{"domain":"127.0.0.1","origin":"builtin","rules":{"variants":[{"body":"#main"}]}}"##,
      ],
      forHost: "127.0.0.1")
    let websiteData = WKWebsiteDataStore.nonPersistent()
    let cookie = try #require(
      HTTPCookie(properties: [.name: "session", .value: "made-up-token", .domain: "127.0.0.1", .path: "/"]))
    await websiteData.httpCookieStore.setCookie(cookie)
    let (v, tabs) = try tab("/a", store: store, websiteData: websiteData)
    defer { done(tabs) }
    try await loaded(v, "Page A")
    let menu = v.saveMenu()
    #expect(menu.items[1].isEnabled)
    menu.performActionForItem(at: 1)
    #expect(v.capture != nil && !v.bar.save.toolTip!.isEmpty)
    try await until("the page saved") { await store.pages.count == 1 }
    let page = try #require(await store.pages.first)
    #expect(
      page.html == "<!doctype html><title>Page A</title><p id=asset>asset for session=made-up-token 200</p>"
        + ##"<p id=rules>vault 127.0.0.1 {"variants":[{"hide":["#ad"]}]} | "##
        + ##"builtin 127.0.0.1 {"variants":[{"body":"#main"}]}</p>"##)
    #expect(page.capture == PageCapture(url: url("/a").absoluteString, title: "Page A"))
    try await until("the button says so") { v.saveState == .saved(.page(hash: TestStore.hash(1))) }
    #expect(v.capture == nil && !FileManager.default.fileExists(atPath: page.file.path))
    let entry = try #require(try web().first?.1.first)
    #expect(entry.versions.map(\.content) == [.page(hash: TestStore.hash(1), bytes: page.html.utf8.count)])
    #expect(entry.meta?.description == "A made-up page")
  }

  /// Without the service a page is not saved whole, and the menu says why
  @Test func withoutTheServiceNoPageIsSavedWhole() async throws {
    let (v, tabs) = try tab("/a")
    defer { done(tabs) }
    try await loaded(v, "Page A")
    let item = v.saveMenu().items[1]
    #expect(!item.isEnabled && item.toolTip?.contains("saving service") == true)
  }

  /// A saving shows its stage on the button; Escape stops it, and so does leaving the page; nothing reaches the service
  @Test func escapeOrLeavingThePageStopsASaving() async throws {
    let store = TestStore()
    let (v, tabs) = try tab("/a?hold", store: store)
    defer { done(tabs) }
    try await loaded(v, "Page A")
    tabs.window.makeFirstResponder(v.web)
    #expect(v.web.tryToPerform(#selector(NSResponder.cancelOperation(_:)), with: nil), "with nothing to stop, on up")
    v.saveMenu().performActionForItem(at: 1)
    try await until("the first stage") { v.saveState == .saving(stage: "prepare") }
    #expect(v.bar.save.toolTip?.contains(WebBar.stageName("prepare")) == true)
    tabs.window.makeFirstResponder(v.web)
    #expect(v.web.tryToPerform(#selector(NSResponder.cancelOperation(_:)), with: nil))
    try await until("stopped") { v.capture == nil && v.saveState == .saved(.unsaved) }

    v.saveMenu().performActionForItem(at: 1)
    try await until("saving again") { v.saveState == .saving(stage: "prepare") }
    v.go(to: url("/b"))
    try await loaded(v, "Page B")
    try await until("stopped by leaving") { v.capture == nil && v.saveState == .saved(.unsaved) }
    #expect(await store.pages.isEmpty && web().isEmpty)
  }

  /// A saving that fails says why on the button, with no alert, until the next page
  @Test func aFailedSavingSaysWhyOnTheButton() async throws {
    let store = TestStore()
    let (v, tabs) = try tab("/a?fail", store: store)
    defer { done(tabs) }
    try await loaded(v, "Page A")
    v.saveMenu().performActionForItem(at: 1)
    let why = WebSaveError(code: "too-large", message: "").shown
    try await until("the failure shown") { v.saveState == .failed(why) }
    #expect(v.bar.save.toolTip == why && tabs.window.attachedSheet == nil && NSApp.modalWindow == nil)
    #expect(await store.pages.isEmpty)
    v.go(to: url("/b"))
    try await until("cleared on the next page") { v.saveState == .saved(.unsaved) }
  }
}

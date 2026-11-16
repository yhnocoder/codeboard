import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing
import WebKit

@testable import CodeBoardReading

/// A selection on a web page taken to the board: made-up pages online from a server on the loopback, and a made-up
/// saved page with the stand-in reader, each in a vault of the test's own, in a window never ordered in. A real drag
/// cannot be made offscreen: what it would carry is read from a pasteboard of the test's own
@MainActor @Suite(.serialized) struct WebSelectionTests {
  let server: LoopbackServer
  let dir = FileManager.default.temporaryDirectory.appending(path: "web-selection-\(UUID().uuidString)")
  let vault: Vault
  let scripts: URL
  static let hash = String(repeating: "5", count: 64)
  static let address = URL(string: "http://127.0.0.1:9/saved")!

  init() async throws {
    _ = NSApplication.shared
    server = try await LoopbackServer(pages: Self.pages)
    try FileManager.default.createDirectory(at: dir.appending(path: "vault"), withIntermediateDirectories: true)
    vault = Vault(root: dir.appending(path: "vault"))
    scripts = try StandInScripts.folder()
  }

  func done(_ tabs: WebTabs) {
    tabs.close()
    try? FileManager.default.removeItem(at: dir)
    try? FileManager.default.removeItem(at: scripts)
  }

  /// A paper with two headings before the passage, a page without any, and a form
  nonisolated static func pages(_ r: LoopbackServer.Request) -> LoopbackServer.Response {
    switch r.path {
    case "/paper":
      return .html(
        "<title>Paper</title><body style='margin:0;padding-top:200px;font:16px sans-serif'>"
          + "<h1>Intro</h1><p>Before.</p><h2>Methods</h2>"
          + "<p id=s>We use <em>sparse</em> attention, see <a href='/ref'>the paper</a> and "
          + "<strong>bold</strong> a*b.</p>"
          + "<ul><li>One</li><li>Two</li></ul><pre>let a = 1\n  b</pre><p id=e>End <code>f()</code></p>"
          + "<div style='height:3000px'></div>")
    case "/plain": return .html("<title>Plain</title><p id=p>No heading here.</p>")
    case "/form": return .html("<title>Form</title><input id=i value='typed words'>")
    default: return LoopbackServer.Response(status: "404 Not Found", body: "")
    }
  }

  func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(server.port)\(path)")! }

  /// A web tab on `path` with the vault, what it collects kept in `got`
  func online(_ path: String, store: TestStore? = nil) async throws -> (WebPageView, WebTabs, Got) {
    let tabs = try WebTabs(vault: vault, store: store, scripts: scripts)
    let got = Got()
    tabs.pane.onCollect = { got.list.append($0) }
    tabs.pane.pasteboard = NSPasteboard(name: .init("codeboard-tests-\(UUID().uuidString)"))
    let v = tabs.open(["url": url(path).absoluteString])
    try await until("the page") { v.web.url == url(path) && !v.web.isLoading && v.web.title?.isEmpty == false }
    return (v, tabs, got)
  }

  final class Got {
    var list: [Collected] = []
  }

  /// `script` run in the page's own world, as its own scripts would
  func page(_ v: WebPageView, _ script: String) async throws {
    _ = try await v.web.callAsyncJavaScript(script, contentWorld: .page)
  }

  func select(_ v: WebPageView, from: String, to: String) async throws {
    try await page(
      v,
      """
      const a = document.getElementById("\(from)"), b = document.getElementById("\(to)")
      getSelection().setBaseAndExtent(a, 0, b, b.childNodes.length)
      """)
  }

  func optionReturn(_ v: WebPageView) -> NSEvent {
    NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: .option, timestamp: 0, windowNumber: v.window?.windowNumber ?? 0,
      context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)!
  }

  /// The app's script says what is selected: its text, its HTML as simple Markdown, the heading before it and its
  /// lines; the selection bar comes over its first line, follows the page as it scrolls, and goes when it is cleared
  @Test func aSelectionOnlineIsSaidAsMarkdownWithTheHeadingBeforeIt() async throws {
    let (v, tabs, _) = try await online("/paper")
    defer { done(tabs) }
    #expect(v.selectionBar.isHidden)
    try await select(v, from: "s", to: "e")
    try await until("the selection said") { v.selection != nil }
    let s = try #require(v.selection)
    #expect(
      s.markdown == """
        We use *sparse* attention, see [the paper](\(url("/ref").absoluteString)) and **bold** a\\*b.

        - One
        - Two

        ```
        let a = 1
          b
        ```

        End `f()`
        """)
    #expect(s.text.hasPrefix("We use sparse attention") && s.heading == "Methods")
    let first = try #require(s.lines.first)
    #expect(!v.selectionBar.isHidden)
    #expect(v.selectionBar.buttons.map { $0.accessibilityIdentifier() } == ["ui-selectionadd", "ui-selectioncopy"])
    #expect(v.selectionBar.frame.maxY == first.minY - 6 && v.selectionBar.frame.minX == first.minX)
    let top = v.selectionBar.frame.minY
    try await page(v, "scrollTo(0, 50)")
    try await until("the bar follows the page") { v.selectionBar.frame.minY == top - 50 }
    v.selectionBar.buttons[1].performClick(nil)
    #expect(tabs.pane.pasteboard.string(forType: .string) == s.text)
    try await page(v, "getSelection().removeAllRanges()")
    try await until("the selection cleared") { v.selection == nil && v.selectionBar.isHidden }
  }

  /// The script is in a world of its own: the page cannot see it or speak for it; a selection in a field being
  /// edited is not said
  @Test func thePageNeitherSeesTheScriptNorSelectionsInFields() async throws {
    let (v, tabs, _) = try await online("/form")
    defer { done(tabs) }
    let seen = try await v.web.callAsyncJavaScript(
      "return typeof window.webkit?.messageHandlers?.selection", contentWorld: .page)
    #expect(seen as? String == "undefined")
    try await page(
      v, "document.body.append(Object.assign(document.createElement('p'), {id: 'after', textContent: 'x'}))")
    try await select(v, from: "after", to: "after")
    try await until("the paragraph's selection said") { v.selection?.text == "x" }
    // as a click into the field and its letting go
    try await page(
      v, "const i = document.getElementById('i'); i.focus(); i.select(); dispatchEvent(new PointerEvent('pointerup'))")
    try await until("a field's selection not said") { v.selection == nil }
  }

  /// Add to Board on a page not saved saves it as a link first, and the card's source names its entry alone, with
  /// the page's title and the heading before the passage; ⌥↵ takes the next one to the same entry
  @Test func addToBoardSavesThePageAsALinkAndNamesItsEntry() async throws {
    let store = TestStore()
    let (v, tabs, got) = try await online("/paper", store: store)
    defer { done(tabs) }
    #expect(v.saveState == .saved(.unsaved))
    try await select(v, from: "s", to: "s")
    try await until("the selection said") { v.selection != nil }
    v.selectionBar.buttons[0].performClick(nil)
    let c = try #require(got.list.first)
    let found = try #require(tabs.pane.entries.all.first { $0.entry.origin == .web(url("/paper").absoluteString) })
    #expect(c.source == SourceAnchor(entry: found.entry.id))
    #expect(c.title == "Paper" && c.label == "Methods")
    #expect(c.body == .note(markdown: v.selection?.markdown ?? ""))
    #expect(v.saveState == .saved(.link))
    try await until("the saving service keeps the link") { await store.links.count == 1 }
    try await select(v, from: "e", to: "e")
    try await until("the next selection said") { v.selection?.text == "End f()" }
    v.web.keyDown(with: optionReturn(v))
    #expect(got.list.count == 2 && got.list[1].source == c.source)
    #expect(tabs.pane.entries.all.filter { $0.entry.origin == .web(url("/paper").absoluteString) }.count == 1)
  }

  /// A drag of the selection keeps what WebKit put on the pasteboard and promises the passage beside it, made (and the
  /// page saved) only when the drop asks for it; a press off the selection is a drag of WebKit's alone
  @Test func aDragOfTheSelectionCarriesThePassageBesideWebKitsData() async throws {
    let (v, tabs, _) = try await online("/plain")
    defer { done(tabs) }
    try await select(v, from: "p", to: "p")
    try await until("the selection said") { v.selection != nil }
    let line = try #require(v.selection?.lines.first)
    #expect(v.web.dragsSelection?(CGPoint(x: line.midX, y: line.midY)) == "No heading here.")
    #expect(v.web.dragsSelection?(CGPoint(x: line.midX, y: line.maxY + 40)) == nil)
    let pb = NSPasteboard(name: .init("codeboard-tests-drag-\(UUID().uuidString)"))
    defer { pb.releaseGlobally() }
    pb.declareTypes([.string, .html], owner: nil)
    pb.setString("No heading here.", forType: .string)
    pb.setString("<p>No heading here.</p>", forType: .html)
    v.web.carry(on: pb)
    #expect(tabs.pane.entries.all.isEmpty, "nothing saved before the drop asks")
    let c = try #require(Collected(from: pb))
    let found = try #require(tabs.pane.entries.all.first)
    #expect(c.source == SourceAnchor(entry: found.entry.id) && c.title == "Plain" && c.label == "")
    #expect(c.body == .note(markdown: "No heading here."))
    #expect(pb.string(forType: .html) == "<p>No heading here.</p>" && pb.string(forType: .string) == "No heading here.")
  }

  // MARK: Saved pages

  /// A saved page of an entry in the vault, its file kept by `store`: the entry's folder
  func savePage(in store: TestStore) async throws -> String {
    let resource = try vault.newResource(in: "", title: "Web", preset: .web).path
    let path = try vault.save(
      SavedItem(
        id: "p1", kind: .page, url: Self.address.absoluteString, title: "Saved", savedAt: 1_000, pageHash: Self.hash,
        bytes: 100),
      in: resource)
    let file = dir.appending(path: "page.html")
    try """
    <!doctype html><html lang="en"><meta charset="utf-8"><title>Saved</title>
    <body style="margin:0;padding-top:200px"><h1>A heading</h1><p>The first paragraph.</p><h2>Second</h2>
    <p id=p>The second paragraph.</p><div style="height:3000px"></div><p>Far below.</p>
    """.write(to: file, atomically: true, encoding: .utf8)
    await store.set(file: file, forHash: Self.hash)
    return path
  }

  /// A tab on the saved page, the stand-in reader in it, in tabs of their own reading the vault
  func openSaved(_ store: TestStore) async throws -> (WebPageView, WebTabs, Got) {
    let tabs = try WebTabs(vault: vault, store: store, scripts: scripts)
    let got = Got()
    tabs.pane.onCollect = { got.list.append($0) }
    let v = tabs.open(WebReading.Page.saved(hash: Self.hash, address: Self.address, title: "Saved").payload)
    try await until("the saved page read") { v.blocks != nil && !v.web.isLoading }
    return (v, tabs, got)
  }

  func saved() async throws -> (WebPageView, WebTabs, Got, Entry) {
    let store = TestStore()
    let path = try await savePage(in: store)
    let (v, tabs, got) = try await openSaved(store)
    return (v, tabs, got, try vault.entry(at: path))
  }

  func client(_ v: WebPageView, _ script: String) async throws -> Any? {
    try await v.web.callAsyncJavaScript(script, contentWorld: .defaultClient)
  }

  /// On a saved page the reader says what is selected, by its blocks: the card's source is the block and its
  /// characters in the version the tab shows, the heading before it the lighter part; in a translation, the whole
  /// original block
  @Test func aSelectionOnASavedPageNamesItsBlockInTheVersion() async throws {
    let (v, tabs, got, entry) = try await saved()
    defer { done(tabs) }
    _ = try await client(
      v,
      """
      const t = document.getElementById("p").firstChild
      getSelection().setBaseAndExtent(t, 4, t, 10)
      """)
    try await until("the reader said") { v.selection?.ranges.isEmpty == false }
    #expect(v.selection?.text == "second" && v.selection?.heading == "Second" && !v.selectionBar.isHidden)
    v.web.keyDown(with: optionReturn(v))
    let place = Place(version: VersionID(rawValue: "v1"), block: .id("1.b4"), range: 4..<10)
    let c = try #require(got.list.first)
    #expect(c.source == SourceAnchor(entry: entry.id, place: place))
    #expect(c.title == "Saved" && c.label == "Second" && c.body == .note(markdown: "second"))
    #expect(
      ReadingSources(pane: tabs.pane).sourceLabel(SourceAnchor(entry: entry.id, place: place))
        == SourceLabel(title: "Saved", number: "Second", icon: .site), "the shell's provider asks the web tab")
    _ = try await v.web.callAsyncJavaScript(
      "shiyiReader.setTranslations({'1.b4': '第二段。'}); shiyiReader.setLanguage('both')",
      contentWorld: WebReading.scriptWorld)
    _ = try await client(
      v,
      """
      const t = document.querySelector("[data-shiyi-translation]").firstChild
      getSelection().setBaseAndExtent(t, 0, t, 2)
      """)
    try await until("the translation's selection said") { v.selection?.ranges.first?.fromTranslation == true }
    v.selectionBar.buttons[0].performClick(nil)
    #expect(
      got.list.last?.source
        == SourceAnchor(entry: entry.id, place: Place(version: VersionID(rawValue: "v1"), block: .id("1.b4"))))
  }

  /// A card's source shows its place again: a saved page's block in the saved page's tab, scrolled to by the reader;
  /// a page online in the tab already on it. Its foot is the site's and the entry's title, the nearest heading above
  /// the block lighter; nothing for an entry that is not a web page's
  @Test func aWebSourceIsLabelledAndShownAgain() async throws {
    let (v, tabs, _, entry) = try await saved()
    defer { done(tabs) }
    let far = SourceAnchor(entry: entry.id, place: Place(version: VersionID(rawValue: "v1"), block: .id("1.b5")))
    #expect(WebReading.sourceLabel(far, in: tabs.pane) == SourceLabel(title: "Saved", number: "Second", icon: .site))
    #expect(WebReading.sourceLabel(SourceAnchor(entry: entry.id), in: tabs.pane)?.title == "Saved")
    let gone = SourceAnchor(entry: entry.id, place: Place(version: VersionID(rawValue: "v9"), block: .id("1.b5")))
    #expect(WebReading.sourceLabel(gone, in: tabs.pane) == nil)
    #expect(WebReading.sourceLabel(SourceAnchor(entry: EntryID(rawValue: "e-none")), in: tabs.pane) == nil)
    #expect(WebReading.reveal(far, in: tabs.pane))
    tabs.paneView.sync()
    #expect(tabs.pane.tabs.count == 1, "the saved page's tab gone to")
    try await until("scrolled to the block") {
      try await v.web.callAsyncJavaScript(
        "return shiyiReader.scrolledTo?.id == '1.b5' && scrollY > 0", contentWorld: WebReading.scriptWorld) as? Bool
        == true
    }
    #expect(WebReading.reveal(SourceAnchor(entry: entry.id), in: tabs.pane))
    tabs.paneView.sync()
    #expect(tabs.pane.tabs.count == 2 && tabs.pane.tabs[1].payload == ["url": Self.address.absoluteString])
    tabs.pane.select(tabs.pane.tabs[0].id)
    #expect(WebReading.reveal(SourceAnchor(entry: entry.id), in: tabs.pane))
    #expect(tabs.pane.tabs.count == 2 && tabs.pane.selected == tabs.pane.tabs[1].id, "the tab on it gone to")
  }

  /// The reader's blocks are kept beside the entry the first time the saved page is read, and named in its version:
  /// after a relaunch (a pane and provider of their own reading the vault) the heading above a place is known without
  /// the page; reading the page again writes nothing
  @Test func theSavedPagesBlocksAreKeptOnceForItsHeadingsAfterARelaunch() async throws {
    let store = TestStore()
    let path = try await savePage(in: store)
    let (_, tabs, _) = try await openSaved(store)
    defer { done(tabs) }
    let entry = try vault.entry(at: path)
    #expect(entry.versions[0].content == .page(hash: Self.hash, bytes: 100, blocks: "v1.blocks.json"))
    #expect(tabs.pane.entries[entry.id]?.entry == entry, "the pane's entries have it")
    let blocks = try vault.pageBlocks("v1.blocks.json", in: path)
    #expect(blocks.map(\.id) == ["1.b1", "1.b2", "1.b3", "1.b4", "1.b5"])
    #expect(blocks.map(\.kind) == ["heading", "paragraph", "heading", "paragraph", "paragraph"])
    #expect(blocks.map(\.level) == [1, nil, 2, nil, nil] && blocks[3].text == "The second paragraph.")
    let files = ["v1.blocks.json", Vault.entryFileName].map { vault.url(of: path).appending(path: $0) }
    func written() throws -> [Data] { try files.map { try Data(contentsOf: $0) } }
    let before = try written()

    let (_, again, _) = try await openSaved(store)
    defer { again.close() }
    #expect(try written() == before, "read again: nothing written")
    let relaunched = try WebTabs(vault: vault)
    defer { relaunched.close() }
    let provider = ReadingSources(pane: relaunched.pane)
    let at = { (block: String) in
      provider.sourceLabel(
        SourceAnchor(entry: entry.id, place: Place(version: VersionID(rawValue: "v1"), block: .id(block))))
    }
    #expect(at("1.b5") == SourceLabel(title: "Saved", number: "Second", icon: .site))
    #expect(at("1.b3")?.number == "Second" && at("1.b2")?.number == "A heading")
    #expect(at("1.b9") == SourceLabel(title: "Saved", number: nil, icon: .site), "a block not in the file")
  }

  /// A saved page whose version names a blocks file already is read without writing any; its places' headings are
  /// that file's
  @Test func aVersionNamingItsBlocksFileAlreadyIsLeftAsItIs() async throws {
    let store = TestStore()
    let path = try await savePage(in: store)
    var entry = try vault.entry(at: path)
    entry.versions[0].content = .page(hash: Self.hash, bytes: 100, blocks: "kept.json")
    try vault.write(entry, at: path)
    try Data(
      """
      [
        {
          "hash": "x",
          "id": "1.b4",
          "kind": "heading",
          "level": 3,
          "text": "Kept"
        }
      ]

      """.utf8
    ).write(to: vault.url(of: path).appending(path: "kept.json"))
    let entryFile = vault.url(of: path).appending(path: Vault.entryFileName)
    let before = try Data(contentsOf: entryFile)
    let (_, tabs, _) = try await openSaved(store)
    defer { done(tabs) }
    #expect(try Data(contentsOf: entryFile) == before)
    #expect(!FileManager.default.fileExists(atPath: vault.url(of: path).appending(path: "v1.blocks.json").path))
    let place = Place(version: VersionID(rawValue: "v1"), block: .id("1.b4"))
    #expect(WebReading.sourceLabel(SourceAnchor(entry: entry.id, place: place), in: tabs.pane)?.number == "Kept")
  }

  /// The source line's icon is the site's own when it can be drawn: the file kept in the entry's images, never an
  /// address; otherwise the site's mark
  @Test func aWebSourcesIconIsTheSitesOwnWhenItCanBeDrawn() throws {
    let resource = try vault.newResource(in: "", title: "Web", preset: .web).path
    let path = try vault.save(
      SavedItem(id: "l1", kind: .link, url: Self.address.absoluteString, title: "Linked", savedAt: 1_000), in: resource)
    let images = vault.url(of: path).appending(path: Vault.imagesFolder)
    try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
    try Data("<svg xmlns='http://www.w3.org/2000/svg'/>".utf8).write(to: images.appending(path: "icon.svg"))
    let tabs = try WebTabs(vault: vault)
    defer { done(tabs) }
    var entry = try vault.entry(at: path)
    func icon(_ source: ImageSource?) -> SourceLabel.Icon? {
      entry.meta = WebMeta(icon: source)
      tabs.pane.entries.update(entry, at: path)
      return WebReading.sourceLabel(SourceAnchor(entry: entry.id), in: tabs.pane)?.icon
    }
    #expect(icon(.file("icon.svg")) == .image(images.appending(path: "icon.svg")))
    #expect(icon(.file("gone.png")) == .site, "not kept")
    #expect(icon(.file("../icon.svg")) == .site, "not a file name")
    let https = "https://example.com/favicon.ico"
    #expect(icon(.url(https)) == .site, "the board draws files only")
    #expect(icon(.url("http://example.com/favicon.ico")) == .site)
    #expect(icon(.url("data:image/png;base64,AAAA")) == .site)
    #expect(icon(nil) == .site)
  }
}

import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Synchronization
import Testing
import WebKit

@testable import CodeBoardReading

/// A saved page translated in its web tab: made-up saved files of one entry's version in a vault of the test's own, the
/// stand-in reader, and an AI that is a closure of the test's own, in a window never ordered in. Nothing is fetched
@MainActor @Suite(.serialized) struct WebTranslationTests {
  let dir = FileManager.default.temporaryDirectory.appending(path: "web-translation-\(UUID().uuidString)")
  let vault: Vault
  /// The entry's folder
  let entry: String
  let scripts: URL
  static let hash = String(repeating: "7", count: 64)
  static let address = URL(string: "http://127.0.0.1:9/a")!

  /// What the AI was asked, and how it answers: each text with the language before it; a batch holding a text that
  /// starts with one of `failing` fails; `holding`, it never answers
  final class AI: Sendable {
    private struct State {
      var asked: [[String]] = []
      var from: [String?] = []
      var failing: [String] = []
      var holding = false
      var cancelled = 0
    }
    private let state = Mutex(State())
    var asked: [[String]] { state.withLock { $0.asked } }
    var from: [String?] { state.withLock { $0.from } }
    var cancelled: Int { state.withLock { $0.cancelled } }
    func fail(_ starts: [String]) { state.withLock { $0.failing = starts } }
    func hold() { state.withLock { $0.holding = true } }

    struct Down: Error {}

    var translate: WebReading.Translator {
      { texts, from, to in
        let (failing, holding) = self.state.withLock { s in
          s.asked.append(texts)
          s.from.append(from)
          return (s.failing, s.holding)
        }
        if holding {
          do { try await Task.sleep(for: .seconds(60)) } catch {
            self.state.withLock { $0.cancelled += 1 }
            throw error
          }
        }
        if texts.contains(where: { t in failing.contains { t.hasPrefix($0) } }) { throw Down() }
        return texts.map { "\(to): \($0)" }
      }
    }
  }

  init() throws {
    _ = NSApplication.shared
    try FileManager.default.createDirectory(at: dir.appending(path: "vault"), withIntermediateDirectories: true)
    vault = Vault(root: dir.appending(path: "vault"))
    let resource = try vault.newResource(in: "", title: "Web", preset: .web).path
    entry = try vault.save(
      SavedItem(
        id: "p1", kind: .page, url: Self.address.absoluteString, title: "Saved", savedAt: 1_000, pageHash: Self.hash,
        bytes: 100),
      in: resource)
    scripts = try StandInScripts.folder()
  }

  func done(_ tabs: WebTabs...) {
    for t in tabs { t.close() }
    try? FileManager.default.removeItem(at: dir)
    try? FileManager.default.removeItem(at: scripts)
  }

  /// Seven blocks to translate (a heading, two paragraphs, an item, a quote, a cell and a caption) and code
  static func page(second: String = "The second paragraph.") -> String {
    """
    <!doctype html><html lang="en"><meta charset="utf-8"><title>Saved</title>
    <h1>A heading</h1><p>The first paragraph.</p><p>\(second)</p><ul><li>An item</li></ul>
    <pre>let code = 1</pre><blockquote>A quote</blockquote>
    <table><tr><td>A cell</td></tr></table><figure><figcaption>A caption</figcaption></figure>
    """
  }

  /// A tab showing the saved page `html`, as the tab keeps it with `view`
  func tab(
    _ html: String, ai: AI?, view: String? = nil, reader: URL? = nil
  ) async throws -> (WebPageView, WebTabs) {
    let store = TestStore()
    let file = dir.appending(path: "\(UUID().uuidString).html")
    try html.write(to: file, atomically: true, encoding: .utf8)
    await store.set(file: file, forHash: Self.hash)
    let tabs = try WebTabs(vault: vault, store: store, scripts: reader ?? scripts, translate: ai?.translate)
    var payload = WebReading.Page.saved(hash: Self.hash, address: Self.address, title: "Saved").payload
    payload["view"] = view
    return (tabs.open(payload), tabs)
  }

  func js(_ v: WebPageView, _ body: String) async throws -> Any? {
    try await v.web.callAsyncJavaScript(body, contentWorld: .defaultClient)
  }

  func ready(_ v: WebPageView) async throws {
    try await until("translation on") { v.bar.translation == .ready && !v.web.isLoading }
  }

  /// The language button `i` pressed
  func choose(_ v: WebPageView, _ i: Int) { v.bar.translate.buttons[i].performClick(nil) }

  func translationsShown(_ v: WebPageView) async throws -> Int {
    try await js(v, "return document.querySelectorAll('[data-shiyi-translation]').length") as? Int ?? -1
  }

  func text(_ v: WebPageView, _ selector: String) async throws -> String? {
    try await js(v, "return document.querySelector(\(selector.debugDescription)).textContent") as? String
  }

  var kept: PageTranslations? {
    get throws { try vault.translations(of: VersionID(rawValue: "v1"), language: "zh", in: entry) }
  }

  /// Side by side asks the AI for the seven blocks, never the code, with the page's language; each shows under its
  /// block and is kept by its hash in the entry's folder; translation shows them in place of the originals with no
  /// call more, and original takes them away. The tab keeps the view chosen
  @Test func sideBySideAndTranslationShowTheBlocksTranslatedAndLeaveCodeAlone() async throws {
    let ai = AI()
    let (v, tabs) = try await tab(Self.page(), ai: ai)
    defer { done(tabs) }
    try await ready(v)
    #expect(v.bar.translate.isEnabled && v.bar.translate.selectedSegment == 0 && ai.asked.isEmpty)
    choose(v, 1)
    try await until("seven translations under their blocks") { try await translationsShown(v) == 7 }
    try await until("translated") { v.translating == nil && v.bar.translation == .ready }
    let texts = ai.asked.flatMap { $0 }
    #expect(Set(texts).count == 7 && texts.count == 7 && !texts.contains("let code = 1"), "\(texts)")
    #expect(ai.from.allSatisfy { $0 == "en" })
    #expect(try await text(v, "h1 + [data-shiyi-translation]") == "zh: A heading")
    #expect(
      try await js(v, "return document.querySelector('pre').nextElementSibling?.tagName") as? String == "BLOCKQUOTE")
    #expect(tabs.tab(v)?.payload["view"] == "both")
    try await until("kept beside the entry") { try kept?.blocks.count == 7 }
    let file = try #require(try kept)
    let pid = try #require(try await js(v, "return document.querySelectorAll('p')[1].dataset.shiyiBlock") as? String)
    #expect(file.scheme == 1 && file.blocks[pid]?.text == "zh: The second paragraph.")

    choose(v, 2)
    try await until("in place of the originals") { try await text(v, "h1") == "zh: A heading" }
    #expect(try await translationsShown(v) == 0)
    #expect(try await text(v, "pre") == "let code = 1")
    #expect(ai.asked.count == 1 && tabs.tab(v)?.payload["view"] == "translation")
    choose(v, 0)
    try await until("the original") { try await text(v, "h1") == "A heading" }
    #expect(try await translationsShown(v) == 0 && tabs.tab(v)?.payload["view"] == nil)
  }

  /// A tab reopened in side by side shows the kept translations without asking the AI, and again after a reload; a
  /// block whose text changed since is the one asked for again
  @Test func keptTranslationsShowAgainAndOnlyAChangedBlockIsAskedFor() async throws {
    let first = AI()
    let (v, tabs) = try await tab(Self.page(), ai: first)
    try await ready(v)
    choose(v, 1)
    try await until("kept") { try kept?.blocks.count == 7 }
    tabs.close()

    let again = AI()
    let (w, other) = try await tab(Self.page(), ai: again, view: "both")
    #expect(w.bar.translate.selectedSegment == 1)
    try await until("the kept translations shown") { try await translationsShown(w) == 7 }
    #expect(again.asked.isEmpty)
    _ = try await js(w, "document.body.dataset.before = ''")
    w.web.reload()
    try await until("shown again after the reload") {
      let fresh = try await js(w, "return document.body.dataset.before === undefined") as? Bool == true
      let shown = try await translationsShown(w)
      return fresh && shown == 7
    }
    #expect(again.asked.isEmpty)
    other.close()

    let changed = AI()
    let (x, third) = try await tab(Self.page(second: "A changed paragraph."), ai: changed, view: "both")
    defer { done(third) }
    try await until("the changed block translated") {
      try await translationsShown(x) == 7 && x.translating == nil && x.bar.translation == .ready
    }
    #expect(changed.asked == [["A changed paragraph."]])
    #expect(
      try await text(x, "p + [data-shiyi-translation] + p + [data-shiyi-translation]") == "zh: A changed paragraph.")
    try await until("kept with its new hash") {
      try kept?.blocks.values.contains { $0.text == "zh: A changed paragraph." } == true
    }
  }

  /// The translations' Versions in the entry
  func listed() throws -> [Version] {
    try vault.entry(at: entry).versions.filter { if case .translation = $0.content { true } else { false } }
  }

  /// The first translations kept are listed in the entry as a Version of the page, which the pane is told of;
  /// later ones add none; a file kept before it was listed gets its Version when the page is opened again
  @Test func theTranslationsAreAVersionOfThePageListedOnce() async throws {
    let v1 = VersionID(rawValue: "v1")
    let (v, tabs) = try await tab(Self.page(), ai: AI())
    try await ready(v)
    choose(v, 1)
    try await until("listed") { try listed().count == 1 }
    let t = try listed()[0]
    #expect(t.of == v1 && t.language == "zh" && t.label == "v1 中文" && t.content == .translation(file: "v1.zh.json"))
    // written off the main thread: the pane is told when the write comes back
    try await until("the pane knows it") { tabs.pane.entries.all.first?.entry.versions.contains(t) == true }
    try await until("translated") { v.translating == nil && v.bar.translation == .ready }
    tabs.close()

    let (w, other) = try await tab(Self.page(second: "A changed paragraph."), ai: AI(), view: "both")
    try await until("the changed block kept") {
      try kept?.blocks.values.contains { $0.text == "zh: A changed paragraph." } == true
    }
    #expect(try listed() == [t], "no second one")
    try await until("translated") { w.translating == nil && w.bar.translation == .ready }
    other.close()

    var e = try vault.entry(at: entry)
    e.versions.removeAll { $0.id == t.id }
    try vault.write(e, at: entry)
    let (x, third) = try await tab(Self.page(second: "A changed paragraph."), ai: AI())
    defer { done(third) }
    try await ready(x)
    try await until("listed on opening") { try listed().count == 1 }
    #expect(try listed()[0].of == v1 && third.pane.entries.all.first?.entry.versions.count == 2)
  }

  /// A batch that fails leaves its blocks untranslated and says so on the language buttons, the other batches shown
  /// and kept; the next choice of a translated view asks for those blocks again
  @Test func aFailedBatchLeavesTheRestAndIsAskedForAgainOnTheNextChoice() async throws {
    let long = { (s: String) in s + String(repeating: " and more", count: WebTranslating.batchCharacters / 10) }
    let html = "<!doctype html><title>Saved</title><p>\(long("One"))</p><p>\(long("Two"))</p><p>\(long("Three"))</p>"
    let ai = AI()
    ai.fail(["Two"])
    let (v, tabs) = try await tab(html, ai: ai)
    defer { done(tabs) }
    try await ready(v)
    choose(v, 1)
    try await until("the batch that failed said") {
      if case .failed = v.bar.translation { v.translating == nil } else { false }
    }
    #expect(ai.asked.count == 3 && ai.from.allSatisfy { $0 == nil }, "a batch each; the page gives no language")
    #expect(try await translationsShown(v) == 2)
    #expect(v.bar.translate.isEnabled && v.bar.translate.toolTip?.contains("could not be translated") == true)
    try await until("the rest kept") { try kept?.blocks.count == 2 }

    ai.fail([])
    choose(v, 2)
    try await until("all translated") { v.translating == nil && v.bar.translation == .ready }
    #expect(ai.asked.count == 4 && ai.asked.last?.first?.hasPrefix("Two") == true)
    #expect(try await text(v, "p + p") == "zh: " + long("Two"))
    try await until("all kept") { try kept?.blocks.count == 3 }
  }

  /// The block at the top of the window stays there through every view, and is the first asked for
  @Test func switchingViewsKeepsTheReadingPosition() async throws {
    let paragraphs = (1...80).map { "<p style='margin:0;height:40px'>Paragraph \($0)</p>" }.joined()
    let ai = AI()
    let (v, tabs) = try await tab("<!doctype html><title>Saved</title><body style='margin:0'>\(paragraphs)", ai: ai)
    defer { done(tabs) }
    try await ready(v)
    func position() async throws -> [String: Any] {
      try await v.web.callAsyncJavaScript("return shiyiReader.position()", contentWorld: WebReading.scriptWorld)
        as? [String: Any] ?? [:]
    }
    _ = try await v.web.callAsyncJavaScript(
      "shiyiReader.scrollTo('1.b40', null, 10)", contentWorld: WebReading.scriptWorld)
    let at = try await position()
    #expect(at["id"] as? String == "1.b40" && at["offset"] as? Double == 10)
    choose(v, 1)
    try await until("translated") { try await translationsShown(v) == 80 && v.translating == nil }
    #expect(ai.asked.first?.first == "Paragraph 40", "from the top of the window")
    #expect(try await js(v, "return scrollY") as? Double ?? 0 > 40 * 40, "the translations above took room")
    for i in [2, 0, 1] {
      choose(v, i)
      try await until("view \(i)") {
        let (shown, first) = (try await translationsShown(v), try await text(v, "p"))
        return shown == (i == 1 ? 80 : 0) && first == (i == 2 ? "zh: Paragraph 1" : "Paragraph 1")
      }
      let now = try await position()
      #expect(now["id"] as? String == "1.b40" && now["offset"] as? Double == 10, "view \(i): \(now)")
    }
  }

  /// Leaving the page stops its translating, and so does closing its tab
  @Test func leavingThePageOrClosingTheTabStopsTheTranslating() async throws {
    let server = try await LoopbackServer { _ in .html("<title>Elsewhere</title><p>online</p>") }
    let ai = AI()
    ai.hold()
    let (v, tabs) = try await tab(Self.page(), ai: ai)
    defer { done(tabs) }
    try await ready(v)
    choose(v, 1)
    try await until("asked") { ai.asked.count == 1 }
    v.go(to: URL(string: "http://127.0.0.1:\(server.port)/elsewhere")!)
    try await until("stopped") { ai.cancelled == 1 && v.translating == nil && v.web.title == "Elsewhere" }
    if case .off(let why) = v.bar.translation {
      #expect(why.contains("save the full page"))
    } else {
      Issue.record("on, on a page online: \(v.bar.translation)")
    }

    let (w, other) = try await tab(Self.page(), ai: ai)
    defer { other.close() }
    try await ready(w)
    choose(w, 2)
    try await until("asked again") { ai.asked.count == 2 }
    let id = try #require(other.tab(w)?.id)
    other.pane.close(id)
    other.paneView.sync()
    try await until("stopped with its tab") { ai.cancelled == 2 }
  }

  /// Off, saying why: on a page online, without the AI, and with an older reader that has no blocks
  @Test func translationIsOffWhereItCannotBeAndSaysWhy() async throws {
    func why(_ v: WebPageView) -> String? {
      if case .off(let why) = v.bar.translation { why } else { nil }
    }
    let ai = AI()
    let online = try WebTabs(scripts: scripts, translate: ai.translate)
    let blank = online.open([:])
    #expect(!blank.bar.translate.isEnabled && why(blank)?.contains("save the full page") == true)
    #expect(blank.bar.translate.toolTip == why(blank))
    online.close()

    let (v, tabs) = try await tab(Self.page(), ai: nil)
    try await until("loaded") { !v.web.isLoading && v.web.title == "Saved" }
    #expect(why(v)?.contains("AI") == true && !v.bar.translate.isEnabled)
    tabs.close()

    let older = try StandInScripts.folder(reader: StandInScripts.olderReader)
    defer { try? FileManager.default.removeItem(at: older) }
    let (w, other) = try await tab(Self.page(), ai: ai, view: "both", reader: older)
    defer { done(other) }
    try await until("the reader asked") { why(w)?.contains("newer") == true }
    #expect(!w.bar.translate.isEnabled && w.bar.translate.selectedSegment == 1 && ai.asked.isEmpty)
  }
}

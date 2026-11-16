import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing
import WebKit

@testable import CodeBoardReading

/// Correcting what counts as the body of a saved page, against the stand-in reader (StandInScripts), the saving
/// service's built-in rule for its site and a vault in a temporary folder, in a window never ordered in; the body
/// button's menu is tried by its item, never popped up
@MainActor @Suite(.serialized) struct WebPickingTests {
  let data = FileManager.default.temporaryDirectory.appending(path: "web-picking-\(UUID().uuidString)")
  let scripts: URL
  let vault: Vault

  init() throws {
    _ = NSApplication.shared
    scripts = try StandInScripts.folder()
    try FileManager.default.createDirectory(at: data.appending(path: "vault"), withIntermediateDirectories: true)
    vault = Vault(root: data.appending(path: "vault"))
  }

  static let hash = String(repeating: "ab", count: 32)
  static let address = URL(string: "https://news.example.org/a")!
  /// The service's rule for the site: the main text and the aside are the body
  static let builtIn = ##"{"domain":"example.org","origin":"builtin","rules":{"variants":[{"body":"main, aside"}]}}"##
  static let html = """
    <!doctype html><meta charset="utf-8"><title>Saved</title>
    <nav id="nav">menu</nav><main id="main"><p>the text</p></main><aside id="aside">more</aside>
    <footer id="foot">foot</footer>
    """

  let store = TestStore()

  /// A tab on the saved page in body view, read with its rules
  func tab(scripts: URL? = nil, vault: Bool = true) async throws -> (WebPageView, WebTabs) {
    let file = data.appending(path: "\(Self.hash).html")
    try Self.html.write(to: file, atomically: true, encoding: .utf8)
    await store.set(file: file, forHash: Self.hash)
    await store.set(rules: [Self.builtIn], forHost: "news.example.org")
    let tabs = try WebTabs(vault: vault ? self.vault : nil, store: store, scripts: scripts ?? self.scripts)
    let v = tabs.open(WebReading.Page.saved(hash: Self.hash, address: Self.address, title: "Saved").payload)
    try await until("the page read") {
      v.web.title == "Saved" && !v.web.isLoading && v.readerPicks != nil
    }
    return (v, tabs)
  }

  func done(_ tabs: WebTabs) {
    tabs.close()
    try? FileManager.default.removeItem(at: data)
    try? FileManager.default.removeItem(at: scripts)
  }

  func reader(_ v: WebPageView, _ body: String) async throws -> Any? {
    try await v.web.callAsyncJavaScript(body, contentWorld: WebReading.scriptWorld)
  }

  /// What body view leaves out, by id
  func hidden(_ v: WebPageView) async throws -> String? {
    try await v.web.callAsyncJavaScript(
      "return [...document.querySelectorAll('[data-shiyi-hidden]')].map(e => e.id).join(' ')",
      contentWorld: .defaultClient) as? String
  }

  /// A click on the part of the page with that id, as the pointer's would reach the reader
  func click(_ v: WebPageView, _ id: String) async throws {
    _ = try await v.web.callAsyncJavaScript(
      "document.getElementById(id).click()", arguments: ["id": id], contentWorld: .defaultClient)
  }

  func start(_ v: WebPageView) async throws {
    let item = try #require(v.bodyMenu().items.first)
    #expect(item.title == "Correct the Body…" && item.isEnabled)
    v.bodyMenu().performActionForItem(at: 0)
    try await until("picking") { try await reader(v, "return shiyiReader.picking") as? Bool == true }
  }

  /// Done takes the reader's rule file, with the part left out, to the saving service as the site's rule, and the page is
  /// read again with it first among its rule files; while picking, the bar says so and offers Cancel and Done alone
  @Test func doneHandsWhatWasPickedToTheSavingServiceAsTheSitesRule() async throws {
    let (v, tabs) = try await tab()
    defer { done(tabs) }
    try await until("body view") { try await hidden(v) == "nav foot" }
    #expect(v.bar.extract.buttons[0].toolTip?.contains("Click again") == true)
    try await start(v)
    #expect(v.bar.picking == WebBar.Picking() && !v.bar.pickDone.isHidden && !v.bar.pickCancel.isHidden)
    #expect(v.bar.back.isHidden && v.bar.address.isHidden && v.bar.save.isHidden && v.visibility.shown)
    tabs.window.layoutIfNeeded()
    #expect(v.bar.extract.isHidden && v.bar.pickNote.frame.width > 100)
    try await click(v, "aside")
    try await until("the change said") { v.bar.picking?.changed == true }
    #expect(try await hidden(v) == "nav aside foot")
    #expect(v.bar.pickNote.stringValue.contains("Done"))
    v.bar.pickDone.performClick(nil)
    try await until("kept") {
      let put = await store.put
      return v.bar.picking == nil && put.keys.sorted() == ["news.example.org"]
    }
    let kept =
      try JSONSerialization.jsonObject(with: try #require(await store.put["news.example.org"])) as? NSDictionary
    let expected =
      try JSONSerialization.jsonObject(
        with: Data(##"{"variants":[{"body":"main, aside","hide":["#aside"]}]}"##.utf8)) as? NSDictionary
    #expect(kept == expected)
    try await until("read again with it first") {
      try await reader(v, "return shiyiReader.files.map(f => f.origin + ' ' + f.domain).join(', ')") as? String
        == "vault news.example.org, builtin example.org"
    }
    #expect(try await hidden(v) == "nav aside foot")
    #expect(!v.bar.back.isHidden && v.bar.pickDone.isHidden)
    #expect(try await reader(v, "return shiyiReader.state().picking") as? Bool == false)
  }

  /// Cancel, Escape on the page and Done with nothing changed each leave picking with nothing written, and the page
  /// shown with the rules as they were
  @Test func cancelEscapeOrNothingChangedWritesNothing() async throws {
    let (v, tabs) = try await tab()
    defer { done(tabs) }
    try await until("body view") { try await hidden(v) == "nav foot" }
    try await start(v)
    try await click(v, "aside")
    try await until("the change said") { v.bar.picking?.changed == true }
    v.bar.pickCancel.performClick(nil)
    try await until("cancelled") {
      let h = try await hidden(v)
      return v.bar.picking == nil && h == "nav foot"
    }

    try await start(v)
    try await click(v, "main")
    try await until("the change said") { v.bar.picking?.changed == true }
    _ = try await v.web.callAsyncJavaScript(
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))", contentWorld: .defaultClient)
    try await until("left by Escape") {
      let h = try await hidden(v)
      return v.bar.picking == nil && h == "nav foot"
    }

    try await start(v)
    v.bar.pickDone.performClick(nil)
    try await until("left") { v.bar.picking == nil }
    #expect(try await reader(v, "return shiyiReader.picking") as? Bool == false)
    #expect(await store.put.isEmpty)
  }

  /// A rule the service refuses is said on the bar, picking going on
  @Test func aRuleTheServiceRefusesIsSaidAndPickingGoesOn() async throws {
    let (v, tabs) = try await tab()
    defer { done(tabs) }
    try await until("body view") { try await hidden(v) == "nav foot" }
    await store.set(refuses: true)
    try await start(v)
    try await click(v, "aside")
    try await until("the change said") { v.bar.picking?.changed == true }
    v.bar.pickDone.performClick(nil)
    try await until("said") { v.bar.picking?.failure?.contains("could not be kept") == true }
    #expect(await store.put.isEmpty)
  }

  /// The body cannot be corrected without a vault, in full page, or with a reader that cannot pick; the menu says why
  @Test func theMenuSaysWhyTheBodyCannotBeCorrected() async throws {
    let older = try StandInScripts.folder(reader: StandInScripts.olderReader)
    defer { try? FileManager.default.removeItem(at: older) }
    let (v, tabs) = try await tab(scripts: older)
    defer { tabs.close() }
    #expect(v.bodyMenu().items.first?.isEnabled == false)
    #expect(v.bodyMenu().items.first?.toolTip?.contains("newer page scripts") == true)

    let (bare, other) = try await tab(vault: false)
    defer { done(other) }
    #expect(bare.bodyMenu().items.first?.toolTip?.contains("vault") == true)
    bare.bar.extract.selectedSegment = 1
    #expect(bare.bodyMenu().items.first?.toolTip?.contains("body view") == true)
  }

  /// The chosen one of a group pressed again says so; another chosen sends the action alone
  @Test func aChoicePressedAgainSaysSo() {
    let c = WebChoice([("doc.plaintext", "Body"), ("doc.richtext", "Full Page")], "test")
    var again: [Int] = []
    c.onRepress = { again.append($0) }
    c.buttons[0].performClick(nil)
    c.buttons[1].performClick(nil)
    #expect(again == [0] && c.selectedSegment == 1)
  }
}

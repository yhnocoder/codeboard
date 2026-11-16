import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardReading
@testable import CodeBoardShell

// Web tabs through the shell: registered as it starts, opened by New Web Tab, kept across a relaunch with what each
// showed (a saved page in the view it was shown in). Their views are made in a pane view in no window, and no page is fetched from anywhere: the one address is
// a port of the loopback nothing listens on, and the saved page is not on this Mac
@MainActor @Suite(.serialized) struct ShellWebTests {
  let vault = Vault(root: URL(filePath: "/v"))

  @Test func newWebTabOpensABlankTabOfTheWebKind() throws {
    let s = Shell()
    s.open(vault, restoring: nil)
    s.openWeb(nil)
    let pane = ReadingPaneView(pane: s.reading)
    pane.sync()
    let tab = try #require(s.reading.tabs.first)
    #expect(tab.kind == WebReading.kind && tab.icon == "globe" && tab.title == "New Tab" && tab.payload == [:])
    #expect(pane.views[tab.id] is WebPageView)
  }

  @Test func webTabsOpenWhatTheyShowedAgainAfterARelaunch() async throws {
    let s = Shell()
    s.open(vault, restoring: nil)
    let address = URL(string: "http://127.0.0.1:9/a")!
    s.openWeb(address)
    let hash = String(repeating: "ab", count: 32)
    let page = WebReading.Page.saved(hash: hash, address: address, title: "Saved A")
    var payload = page.payload
    payload["view"] = "both"
    s.reading.open("Saved A", key: page.key, kind: WebReading.kind, payload: payload)
    let saved = try JSONDecoder().decode(ShellState.self, from: JSONEncoder().encode(try #require(s.state)))

    let t = Shell()
    t.open(vault, restoring: saved)
    #expect(t.reading.tabs.map(\.kind) == [WebReading.kind, WebReading.kind])
    #expect(t.reading.tabs.map(\.payload) == [["url": address.absoluteString], payload])
    #expect(t.reading.tabs[1].key == "web:" + hash && t.reading.selected == t.reading.tabs[1].id)
    let pane = ReadingPaneView(pane: t.reading)
    pane.sync()
    let v = try #require(pane.views[t.reading.tabs[1].id] as? WebPageView)
    let deadline = ContinuousClock.now + .seconds(10)
    while (v.web.url != WebReading.savedURL(hash) || v.web.isLoading) && ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(v.page == page && t.reading.tabs[1].title == "Saved A" && t.reading.tabs[1].payload == payload)
    #expect(v.language == .both && v.bar.translate.selectedSegment == 1)
  }
}

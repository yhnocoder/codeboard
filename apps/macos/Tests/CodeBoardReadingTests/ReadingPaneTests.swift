import AppKit
import Foundation
import Testing

@testable import CodeBoardReading

@MainActor @Suite struct ReadingPaneTests {
  @Test func thePaneIsHiddenWithNoTabsAtFirst() {
    let p = ReadingPane()
    #expect(!p.shown && p.side == .right && p.tabs.isEmpty && p.selected == nil)
  }

  /// A tab opens after the current one and is selected, the pane shown; the same key goes to the tab it opened
  @Test func tabsOpenSwitchAndCloseAndTheSameKeyGoesToItsTab() {
    let p = ReadingPane()
    let a = p.open("Alpha", key: "r/alpha")
    #expect(p.shown && p.selected == a)
    let b = p.open("Beta", key: "r/beta")
    p.select(a)
    let c = p.open("New Tab")
    #expect(p.tabs.map(\.title) == ["Alpha", "New Tab", "Beta"])
    #expect(p.selected == c)
    #expect(p.open("Alpha again", key: "r/alpha") == a, "no second tab for the same key")
    #expect(p.tabs.count == 3 && p.selected == a && p.tabs[0].title == "Alpha")
    p.selectTab(by: -1)
    #expect(p.selected == b, "wrapping around")
    p.move(b, to: 0)
    #expect(p.tabs.map(\.id) == [b, a, c])
    p.close(b)
    #expect(p.selected == a, "its right neighbour")
    p.close(c)
    #expect(p.selected == a)
    p.close(a)
    #expect(p.tabs.isEmpty && p.selected == nil && p.shown, "the last one closed leaves the pane open")
  }

  /// The split keeps both minimums; a room too narrow for both is shared in proportion to them
  @Test func theWidthStaysWithinBothPanelsMinimums() {
    let room: CGFloat = 1200
    #expect(ReadingPane.fit(500, in: room) == 500)
    #expect(ReadingPane.fit(100, in: room) == ReadingPane.minWidth)
    #expect(ReadingPane.fit(1100, in: room) == room - ReadingPane.boardMinWidth)
    let narrow = ReadingPane.minWidth + ReadingPane.boardMinWidth - 64
    let shared = ReadingPane.fit(500, in: narrow)
    #expect(shared < ReadingPane.minWidth && narrow - shared < ReadingPane.boardMinWidth)
    #expect(abs(shared / narrow - ReadingPane.minWidth / (ReadingPane.minWidth + ReadingPane.boardMinWidth)) < 0.01)
  }

  @Test func theStateRoundTrips() throws {
    let p = ReadingPane()
    p.open("Alpha", key: "r/alpha")
    let b = p.open("Beta")
    p.side = .left
    p.width = 512
    p.shown = false
    let saved = try JSONDecoder().decode(ReadingPane.State.self, from: JSONEncoder().encode(p.state))
    let q = ReadingPane()
    q.restore(saved)
    #expect(q.state == p.state)
    #expect(q.tabs.map(\.title) == ["Alpha", "Beta"] && q.selected == b && q.side == .left && q.width == 512)
    #expect(!q.shown)
    q.closeAll()
    #expect(q.tabs.isEmpty && q.selected == nil && q.side == .left)
  }

  /// A view opening another tab hands its view what it is to be made with; a tab made any other way is handed nothing
  @Test func aTabOpenedFromAnotherIsHandedWhatItWasOpenedWith() throws {
    let p = ReadingPane()
    let v = ReadingPaneView(pane: p)
    var made: [ReadingContext] = []
    ReadingKinds.register("test-hand") { c in
      made.append(c)
      return NSView()
    }
    p.open("First", kind: "test-hand")
    v.sync()
    let token = NSObject()
    try #require(made.first).open("Second", kind: "test-hand", handing: token)
    try #require(made.first).open("Third", kind: "test-hand")
    p.open("Fourth", kind: "test-hand")
    v.sync()
    #expect(made.count == 4 && made[1].handed as? NSObject === token)
    #expect(made[0].handed == nil && made[2].handed == nil && made[3].handed == nil)
    let saved = try JSONDecoder().decode(ReadingPane.State.self, from: JSONEncoder().encode(p.state))
    #expect(saved == p.state && p.tabs.map(\.payload).allSatisfy(\.isEmpty), "nothing of it is saved")
  }

  /// A view clears its tab's key with an empty one; none leaves it as it is
  @Test func anEmptyKeyClearsATabsKey() {
    let p = ReadingPane()
    let a = p.open("Saved", key: "web:1")
    p.update(a, title: "Saved again")
    #expect(p.tabs[0].key == "web:1")
    p.update(a, key: "")
    #expect(p.tabs[0].key == nil && p.tabs[0].title == "Saved again")
    #expect(p.open("Saved", key: "web:1") != a, "the key no longer goes to it")
  }

  /// Each open tab has its view, the current one on screen, kept while the tab is open; an empty tab's is a blank page
  /// (the panel's paper shows through it) and with no tab nothing is left but the pane
  @Test func eachTabHasItsViewWhileItIsOpenAndAnEmptyPaneHasNone() throws {
    let p = ReadingPane()
    let v = ReadingPaneView(pane: p)
    v.frame = NSRect(x: 0, y: 0, width: 400, height: 300)
    let a = p.open("Alpha")
    let b = p.open("Beta")
    v.sync()
    #expect(v.subviews.count == 2)
    let va = try #require(v.views[a])
    #expect(va.isHidden && v.views[b]?.isHidden == false && va.frame == v.bounds)
    #expect(va.layer?.backgroundColor == nil && va.subviews.isEmpty, "a blank page")
    p.select(a)
    v.sync()
    #expect(v.views[a] === va && !va.isHidden && v.views[b]?.isHidden == true)
    p.close(a)
    p.close(b)
    v.sync()
    #expect(v.subviews.isEmpty && v.views.isEmpty)
  }

  /// With the keys, Close Tab and Show Next and Previous Tab are the pane's: enabled while there is a tab to act on
  @Test func theTabKeysActOnThePanesTabs() {
    let p = ReadingPane()
    let v = ReadingPaneView(pane: p)
    let close = NSMenuItem(title: "Close", action: NSSelectorFromString("closeTab:"), keyEquivalent: "w")
    let next = NSMenuItem(title: "", action: NSSelectorFromString("showNextTab:"), keyEquivalent: "")
    #expect(v.responds(to: close.action) && v.responds(to: next.action))
    #expect(!v.validateMenuItem(close) && !v.validateMenuItem(next), "an empty pane stays: nothing to close")
    let a = p.open("Alpha")
    let b = p.open("Beta")
    #expect(v.validateMenuItem(close) && close.title == "Close Tab" && v.validateMenuItem(next))
    NSApplication.shared.sendAction(next.action!, to: v, from: next)
    #expect(p.selected == a)
    NSApplication.shared.sendAction(close.action!, to: v, from: close)
    #expect(p.tabs.map(\.id) == [b])
  }
}

// The reading pane is below the shell and knows nothing of the board: it imports neither the shell nor the canvas
@Test func readingImportsNeitherTheShellNorTheCanvas() throws {
  let sources = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../Sources/CodeBoardReading")
  let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
    .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
  #expect(!files.isEmpty)
  let importLine = /^\s*(?:@\w+\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?(\w+)/
    .anchorsMatchLineEndings()
  for file in files {
    for match in try String(contentsOf: file, encoding: .utf8).matches(of: importLine)
    where ["CodeBoardShell", "CodeBoardCanvas"].contains(match.1) {
      Issue.record("\(file.lastPathComponent) imports \(match.1)")
    }
  }
}

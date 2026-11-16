import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardReading

// What PDF and web tabs share: where the selection bar goes, its buttons, a collected passage on a pasteboard; and the
// kinds of tab, registered by name
@MainActor @Suite struct SelectionBarPlaceTests {
  let bar = CGSize(width: 100, height: 36)
  let visible = CGRect(x: 0, y: 0, width: 400, height: 600)

  /// Lines of a selection, y-down
  let lines = [CGRect(x: 120, y: 200, width: 200, height: 16), CGRect(x: 20, y: 218, width: 300, height: 16)]

  @Test func itGoesSixAboveTheFirstLineFromWhereItStarts() {
    #expect(SelectionBar.origin(size: bar, lines: lines, visible: visible) == CGPoint(x: 120, y: 200 - 6 - 36))
  }

  @Test func withNoRoomAboveItGoesSixBelowTheLastLine() {
    let high = lines.map { $0.offsetBy(dx: 0, dy: -180) }
    #expect(SelectionBar.origin(size: bar, lines: high, visible: visible) == CGPoint(x: 120, y: 234 - 180 + 6))
  }

  @Test func nearAnEdgeItOnlyShiftsSideways() {
    let right = [CGRect(x: 350, y: 300, width: 40, height: 16)]
    #expect(SelectionBar.origin(size: bar, lines: right, visible: visible) == CGPoint(x: 300, y: 258))
    let left = [CGRect(x: -30, y: 300, width: 40, height: 16)]
    #expect(SelectionBar.origin(size: bar, lines: left, visible: visible).x == 0)
  }

  @Test func itIsNeverOverTheSelection() {
    for dy in stride(from: -230.0, through: 400, by: 10) {
      for dx in stride(from: -100.0, through: 300, by: 50) {
        let ls = lines.map { $0.offsetBy(dx: dx, dy: dy) }
        let r = CGRect(origin: SelectionBar.origin(size: bar, lines: ls, visible: visible), size: bar)
        #expect(!ls.contains { $0.intersects(r) }, "\(r) over \(ls)")
      }
    }
  }
}

@MainActor @Suite struct SelectionBarTests {
  @Test func itHasItsButtonsInOrderWithTheirNamesAsTipsAndDoesWhatEachSays() {
    var ran: [String] = []
    let b = SelectionBar([
      SelectionAction(icon: "doc.on.doc", name: "One", id: "ui-one") { ran.append("one") },
      SelectionAction(icon: "highlighter", name: "Two", id: "ui-two") { ran.append("two") },
    ])
    #expect(b.buttons.map(\.toolTip) == ["One", "Two"])
    #expect(b.buttons.map { $0.accessibilityIdentifier() } == ["ui-one", "ui-two"])
    #expect(b.accessibilityIdentifier() == "ui-selectionbar")
    #expect(b.size == CGSize(width: 8 + 2 * 30 + 2, height: ReadingBarLook.warmInk(dark: false).height))
    for i in [1, 0] { NSApp.sendAction(b.buttons[i].action!, to: b.buttons[i].target, from: b.buttons[i]) }
    #expect(ran == ["two", "one"])
  }

  @Test func aCollectedPassageRoundTripsThroughAPasteboardWithItsPlainText() throws {
    let pb = NSPasteboard(name: NSPasteboard.Name("collected-\(UUID().uuidString)"))
    defer { pb.releaseGlobally() }
    let c = Collected(
      body: .note(markdown: "Birds rest on the far bank."),
      source: SourceAnchor(
        entry: EntryID(rawValue: "e1"),
        place: Place(version: VersionID(rawValue: "v1"), block: .page(12), range: 3..<20)),
      title: "Field notes", label: "p. 12")
    c.write(to: pb)
    #expect(Collected(from: pb) == c)
    #expect(pb.string(forType: .string) == "Birds rest on the far bank.")
    #expect(pb.types?.contains(NSPasteboard.PasteboardType("com.yhnocoder.codeboard.collected")) == true)
    let image = Collected(body: .image(alt: "A map", width: 200, height: 120), source: nil, title: "T", label: "p. 1")
    image.write(to: pb)
    #expect(Collected(from: pb) == image)
    pb.clearContents()
    pb.setString("plain", forType: .string)
    #expect(Collected(from: pb) == nil)
  }
}

@MainActor @Suite struct ReadingKindTests {
  @Test func aKindNotRegisteredShowsTheBlankPageAndARegisteredOneItsOwnView() throws {
    let p = ReadingPane()
    let v = ReadingPaneView(pane: p)
    final class Own: NSView {}
    ReadingKinds.register("test-own", icon: "star") { _ in Own() }
    let a = p.open("A", kind: "no-such-kind")
    let b = p.open("B", kind: "test-own", payload: ["x": "1"])
    v.sync()
    #expect(v.views[a].map { type(of: $0) == NSView.self } == true && v.views[a]?.subviews.isEmpty == true)
    #expect(v.views[b] is Own)
    #expect(p.tabs[1].icon == "star" && p.tabs[0].icon == nil)
  }

  /// A tab's view changes its own tab's title, saved payload and key, and stays the same view
  @Test func aViewUpdatesItsOwnTabAndStays() throws {
    let p = ReadingPane()
    let v = ReadingPaneView(pane: p)
    var context: ReadingContext?
    ReadingKinds.register("test-update") { c in
      context = c
      return NSView()
    }
    let a = p.open("Blank", kind: "test-update", payload: ["url": ""])
    v.sync()
    let view = try #require(v.views[a])
    let c = try #require(context)
    #expect(c.tab == a && c.payload == ["url": ""] && c.bar.radius == 14)
    c.update(title: "A page", payload: ["url": "https://example.com/"], key: "web:1")
    v.sync()
    #expect(p.tabs[0].title == "A page" && p.tabs[0].payload == ["url": "https://example.com/"])
    #expect(p.tabs[0].key == "web:1" && v.views[a] === view)
    #expect(c.dataFolder == nil)
    p.machineFolder = URL(filePath: "/tmp/app")
    #expect(c.dataFolder?.lastPathComponent == "Test-update")
  }

  /// A view opens another tab of a kind and gets its view at once; a view that follows the look hears a new theme's
  @Test func aViewOpensAnotherTabAndFollowsTheBarLook() throws {
    let p = ReadingPane()
    let v = ReadingPaneView(pane: p)
    final class Follower: NSView, ReadingLookFollower {
      var heard: [ReadingBarLook] = []
      func barLookChanged(_ look: ReadingBarLook) { heard.append(look) }
    }
    var context: ReadingContext?
    ReadingKinds.register("test-follow") { c in
      if context == nil { context = c }
      return Follower()
    }
    p.open("First", kind: "test-follow")
    v.sync()
    let c = try #require(context)
    let second = try #require(c.open("Second", kind: "test-follow", payload: ["url": "https://example.com/"]))
    #expect(p.tabs.map(\.title) == ["First", "Second"] && v.views[p.tabs[1].id] === second)
    #expect(p.selected == p.tabs[1].id && p.tabs[1].payload == ["url": "https://example.com/"])
    p.barLook = .inkWash(dark: true)
    v.sync()
    #expect(c.bar == .inkWash(dark: true) && c.bar.height == 46)
    #expect(v.views.values.allSatisfy { ($0 as? Follower)?.heard.last == .inkWash(dark: true) })
  }

  /// The keys go to the current tab's view when it takes them, and stay with a view inside it that has them
  @Test func theKeysGoToTheTabsViewAndStayWithAViewInsideIt() throws {
    let p = ReadingPane()
    let v = ReadingPaneView(pane: p)
    let window = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = v
    defer { window.contentView = nil }
    final class Keyed: NSView {
      let field = NSTextField()
      override var acceptsFirstResponder: Bool { true }
    }
    ReadingKinds.register("test-keys") { _ in
      let k = Keyed()
      k.addSubview(k.field)
      return k
    }
    p.open("Blank")
    v.sync()
    v.takeKeys()
    #expect(window.firstResponder === v, "a blank tab: the pane")
    let id = p.open("Keyed", kind: "test-keys")
    v.sync()
    let k = try #require(v.views[id] as? Keyed)
    #expect(window.firstResponder === k)
    window.makeFirstResponder(k.field)
    let editing = window.firstResponder
    v.takeKeys()
    #expect(window.firstResponder === editing, "the field keeps them")
  }

  /// A tab saved before tabs had kinds reads as a blank page, a resource's as its list
  @Test func aTabSavedWithoutAKindIsBlank() throws {
    let json = #"{"id":"6F9619FF-8B86-D011-B42D-00C04FC964FF","key":"r/a","title":"Old","content":{"empty":{}}}"#
    let t = try JSONDecoder().decode(ReadingTab.self, from: Data(json.utf8))
    #expect(t.kind == "" && t.payload == [:] && t.title == "Old" && t.key == "r/a")
    let resource = #"{"id":"6F9619FF-8B86-D011-B42D-00C04FC964FF","key":"resource:r1","title":"Papers"}"#
    let r = try JSONDecoder().decode(ReadingTab.self, from: Data(resource.utf8))
    #expect(r.kind == "list" && r.payload == ["resource": "r1"])
  }
}

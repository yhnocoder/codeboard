import AppKit
import CodeBoardModel
import CodeBoardReading
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// The reading pane in the whole window: hidden at first, shown and hidden by its switch at the far right of the board's
// top bar, moved to the other side by the arrow before it, its width dragged at the divider between the two panels,
// its tabs on the title line with the board's and the traffic lights wherever it is and whether the sidebar is shown

@MainActor @Suite(.serialized) struct FullWindowReadingTests {
  let env = FullWindowEditTests()

  func view<T: NSView>(_ type: T.Type, in v: NSView?) -> T? {
    guard let v else { return nil }
    return v as? T ?? v.subviews.lazy.compactMap { view(type, in: $0) }.first
  }

  func view(_ identifier: String, in v: NSView?) -> NSView? {
    guard let v else { return nil }
    return v.accessibilityIdentifier() == identifier ? v : v.subviews.lazy.compactMap { view(identifier, in: $0) }.first
  }

  struct Parts {
    let controls: ReadingControls
    let pane: ReadingPaneView
    let divider: NSView
    let boardTabs: NSView
    let readingTabs: NSView
    /// The panels: the reading pane's and the board's (the canvas's)
    let reading: NSView
    let board: NSView
  }

  func parts(_ w: FullWindowEditTests.Window) throws -> Parts {
    let root = w.window.contentView
    let pane = try #require(view(ReadingPaneView.self, in: root))
    return Parts(
      controls: try #require(view(ReadingControls.self, in: root)),
      pane: pane,
      divider: try #require(view("ui-readingdivider", in: root)),
      boardTabs: try #require(view("ui-boardtabs", in: root)),
      readingTabs: try #require(view("ui-readingtabs", in: root)),
      reading: try #require(pane.superview?.superview),
      board: try #require(w.panes.superview?.superview))
  }

  /// Where a view is in the window, y-down from its top
  func place(_ v: NSView, _ w: FullWindowEditTests.Window) -> CGRect {
    let r = v.convert(v.bounds, to: nil)
    let height = w.window.contentView?.bounds.height ?? 0
    return CGRect(x: r.minX, y: height - r.maxY, width: r.width, height: r.height)
  }

  /// The window laid out again once the shell changed, and the slide over
  func settle(_ w: FullWindowEditTests.Window, _ what: String, _ f: () -> Bool) async {
    await env.until(what, in: w) {
      w.window.contentView?.layoutSubtreeIfNeeded()
      return f()
    }
    await w.frames(18)
    w.window.contentView?.layoutSubtreeIfNeeded()
  }

  /// A click on a button where the window would hand it: it is the view under the pointer there, and its action is
  /// sent (performClick posts events, which stop the test process's run loop)
  func click(_ b: NSButton, in w: FullWindowEditTests.Window) throws {
    let at = b.convert(CGPoint(x: b.bounds.midX, y: b.bounds.midY), to: nil)
    let frame = try #require(w.window.contentView?.superview)
    let hit = frame.hitTest(frame.convert(at, from: nil))
    #expect(hit === b, "the button is under the pointer: \(String(describing: hit))")
    #expect(b.isEnabled && !b.isHiddenOrHasHiddenAncestor)
    NSApp.sendAction(try #require(b.action), to: b.target, from: b)
  }

  func visible(_ p: Parts, _ w: FullWindowEditTests.Window) -> Bool {
    let r = place(p.reading, w)
    return !p.reading.isHiddenOrHasHiddenAncestor && p.reading.alphaValue == 1 && r.minX >= 0
      && r.maxX <= w.window.contentView?.bounds.width ?? 0
  }

  @Test func thePaneIsHiddenAtFirstAndItsSwitchShowsAndHidesIt() async throws {
    let w = try await env.opened()
    defer { w.close() }
    let p = try parts(w)
    let full = place(p.board, w).width
    #expect(!w.shell.reading.shown && p.reading.isHidden && p.divider.isHidden)
    #expect(p.controls.toggle.toolTip == "Show Reading Pane")
    let bar = place(p.board, w)
    let toggle = place(p.controls.toggle, w)
    #expect(bar.maxX - toggle.maxX < 12, "at the far right of the board's top bar: \(toggle) in \(bar)")
    #expect(place(p.boardTabs, w).maxX <= place(p.controls, w).minX, "the board's tabs end before it")

    try click(p.controls.toggle, in: w)
    await settle(w, "the pane shown") { visible(p, w) }
    #expect(w.shell.reading.shown && !p.divider.isHidden)
    #expect(p.controls.toggle.toolTip == "Hide Reading Pane")
    let reading = place(p.reading, w)
    let board = place(p.board, w)
    #expect(reading.minX > board.maxX, "on the right")
    #expect(abs(reading.width - w.shell.reading.width) < 1 && abs(board.width - (full - 8 - reading.width)) < 1)
    #expect(w.canvas.window != nil && w.canvas.bounds.width < full, "the board panel narrowed")

    try click(p.controls.toggle, in: w)
    await settle(w, "the pane hidden") { p.reading.isHidden }
    #expect(!w.shell.reading.shown && p.divider.isHidden && abs(place(p.board, w).width - full) < 1)
  }

  @Test func theArrowMovesThePaneToTheOtherSideAndTheSwitchsFilledCellFollows() async throws {
    let w = try await env.opened()
    defer { w.close() }
    let p = try parts(w)
    #expect(p.controls.toggle.symbol == "rectangle.righthalf.filled")
    try click(p.controls.toggle, in: w)
    await settle(w, "the pane shown") { visible(p, w) }
    try click(p.controls.flip, in: w)
    await settle(w, "on the left") { place(p.reading, w).maxX < place(p.board, w).minX }
    #expect(w.shell.reading.side == .left && w.shell.reading.shown)
    #expect(p.controls.toggle.symbol == "rectangle.lefthalf.filled")
    #expect(p.controls.flip.toolTip == "Move Reading Pane to the Right")
    let reading = place(p.reading, w)
    let divider = place(p.divider, w)
    #expect(abs(divider.minX - reading.maxX) < 1 && abs(divider.maxX - place(p.board, w).minX) < 1, "between them")
    let toggle = place(p.controls.toggle, w)
    #expect(place(p.board, w).maxX - toggle.maxX < 12, "the switch stays at the board's far right")
    try click(p.controls.flip, in: w)
    await settle(w, "on the right") { place(p.reading, w).minX > place(p.board, w).maxX }
    #expect(p.controls.toggle.symbol == "rectangle.righthalf.filled")
  }

  /// A drag at the divider, as the window hands it: down, moves, up
  func drag(_ divider: NSView, by dx: CGFloat, in w: FullWindowEditTests.Window) {
    let start = divider.convert(CGPoint(x: divider.bounds.midX, y: divider.bounds.midY), to: nil)
    for (type, x) in [(NSEvent.EventType.leftMouseDown, 0), (.leftMouseDragged, dx / 2), (.leftMouseDragged, dx)] {
      let e = NSEvent.mouseEvent(
        with: type, location: CGPoint(x: start.x + x, y: start.y), modifierFlags: [], timestamp: 0,
        windowNumber: w.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
      if type == .leftMouseDown { divider.mouseDown(with: e) } else { divider.mouseDragged(with: e) }
    }
    divider.mouseUp(
      with: NSEvent.mouseEvent(
        with: .leftMouseUp, location: CGPoint(x: start.x + dx, y: start.y), modifierFlags: [], timestamp: 0,
        windowNumber: w.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!)
  }

  @Test func draggingTheDividerChangesTheSplitWithinTheMinimumsAndItIsKept() async throws {
    let w = try await env.opened()
    defer { w.close() }
    let p = try parts(w)
    w.shell.reading.shown = true
    await settle(w, "the pane shown") { visible(p, w) }
    let frame = try #require(w.window.contentView?.superview)
    let mid = p.divider.convert(CGPoint(x: p.divider.bounds.midX, y: p.divider.bounds.midY), to: nil)
    #expect(frame.hitTest(frame.convert(mid, from: nil)) === p.divider, "the divider is under the pointer")
    let before = place(p.reading, w).width
    drag(p.divider, by: -60, in: w)
    await settle(w, "wider") { abs(place(p.reading, w).width - (before + 60)) < 1 }
    #expect(w.shell.reading.width == before + 60)
    let room = place(p.reading, w).width + place(p.board, w).width
    drag(p.divider, by: -2000, in: w)
    await settle(w, "as wide as it goes") { abs(place(p.board, w).width - ReadingPane.boardMinWidth) < 1 }
    drag(p.divider, by: 2000, in: w)
    await settle(w, "as narrow as it goes") { abs(place(p.reading, w).width - ReadingPane.minWidth) < 1 }
    #expect(abs(place(p.reading, w).width + place(p.board, w).width - room) < 1, "the board takes what it gives")
    drag(p.divider, by: -100, in: w)
    await settle(w, "wider again") { abs(place(p.reading, w).width - (ReadingPane.minWidth + 100)) < 1 }

    // relaunched with what was kept: the same split, side and tabs
    w.shell.openReadingTab(title: "Kept", key: "kept")
    let saved = try JSONDecoder().decode(ShellState.self, from: JSONEncoder().encode(try #require(w.shell.state)))
    let shell = Shell()
    shell.open(w.vault, restoring: saved)
    shell.apply(.success(try w.vault.tree()))
    let (window, _) = makeMainWindow(shell: shell)
    window.setFrameAutosaveName("")
    window.setFrame(w.window.frame, display: false)
    window.level = .underDesktop
    window.orderFrontRegardless()
    defer { window.orderOut(nil) }
    window.contentView?.layoutSubtreeIfNeeded()
    let again = try #require(view(ReadingPaneView.self, in: window.contentView)?.superview?.superview)
    #expect(!again.isHidden && abs(again.frame.width - (ReadingPane.minWidth + 100)) < 1)
    #expect(shell.reading.tabs.map(\.title) == ["Kept"])
  }

  /// The traffic lights, the switch and both panels' tabs on one line, the pane on either side, the sidebar shown or not
  @Test(arguments: [(ReadingPane.Side.right, true), (.left, true), (.right, false), (.left, false)])
  func theTabRowsAndTheTrafficLightsShareOneLine(_ side: ReadingPane.Side, _ sidebar: Bool) async throws {
    let w = try await env.opened()
    defer { w.close() }
    let p = try parts(w)
    w.shell.reading.side = side
    w.shell.sidebarShown = sidebar
    w.shell.reading.shown = true
    await settle(w, "the pane shown") {
      visible(p, w) && (place(p.reading, w).minX < place(p.board, w).minX) == (side == .left)
    }
    let zoom = try #require(w.window.standardWindowButton(.zoomButton))
    let line = place(zoom, w).midY
    for (name, v) in [("board tabs", p.boardTabs), ("reading tabs", p.readingTabs), ("switch", p.controls.toggle)] {
      #expect(abs(place(v, w).midY - line) < 0.5, "\(name) at \(place(v, w).midY), the lights at \(line)")
    }
    // with the sidebar hidden, the leftmost panel's tabs begin after the title controls
    if !sidebar {
      let first = side == .left ? p.readingTabs : p.boardTabs
      #expect(place(first, w).minX > place(zoom, w).maxX + 60, "after the sidebar toggle, back and forward")
    }
  }

  /// Tabs open in the pane with the keys, switch and close; the same key goes to the tab it opened; the last one
  /// closed leaves the pane open and empty. With the keys on the board, the tab keys are not the pane's
  @Test func readingTabsOpenSwitchAndCloseAndAnEmptyPaneStaysOpen() async throws {
    let w = try await env.opened()
    defer { w.close() }
    let p = try parts(w)
    w.shell.openReadingTab(title: "Alpha", key: "r/alpha")
    await settle(w, "the pane shown with its tab") { visible(p, w) && p.pane.subviews.count == 1 }
    await env.until("the keys in the pane", in: w) { p.pane.hasKeys }
    w.shell.openReadingTab(title: "Beta", key: "r/beta")
    w.shell.openReadingTab(title: "Alpha", key: "r/alpha")
    await settle(w, "two tabs") { p.pane.subviews.count == 2 }
    #expect(w.shell.reading.tabs.map(\.title) == ["Alpha", "Beta"])
    #expect(w.shell.reading.selected == w.shell.reading.tabs[0].id, "Alpha's key went to its tab")
    let keys = try #require(w.window.firstResponder)
    #expect(keys.tryToPerform(NSSelectorFromString("showNextTab:"), with: nil))
    #expect(w.shell.reading.selected == w.shell.reading.tabs[1].id)
    let boardTabs = w.shell.tabs
    for _ in 0..<3 { _ = w.window.firstResponder?.tryToPerform(NSSelectorFromString("closeTab:"), with: nil) }
    await settle(w, "no tab") { p.pane.subviews.isEmpty }
    #expect(w.shell.reading.tabs.isEmpty && w.shell.reading.shown && visible(p, w), "open and empty")
    #expect(w.shell.tabs == boardTabs, "the board's tabs untouched")
    // the board's keys: the pane is not in their responder chain
    w.shell.openReadingTab(title: "Gamma", key: "r/gamma")
    await settle(w, "Gamma") { p.pane.subviews.count == 1 }
    w.window.makeFirstResponder(w.canvas)
    #expect(!w.canvas.tryToPerform(NSSelectorFromString("closeTab:"), with: nil))
    #expect(w.shell.reading.tabs.count == 1)
    // hidden while it had the keys: they go back to the board
    w.window.makeFirstResponder(p.pane)
    w.shell.reading.shown = false
    await settle(w, "hidden") { p.reading.isHidden }
    #expect(w.keysIn(w.canvas))
  }

  @Test func openingAVaultAndUsingTheReadingPaneWritesNoFile() async throws {
    let writes = OpeningWritesNothingTests()
    let (v, _) = try writes.vault()
    defer { try? FileManager.default.removeItem(at: v.root) }
    let before = writes.files(v.root)
    let w = try await env.opened(v)
    let p = try parts(w)
    try click(p.controls.toggle, in: w)
    await settle(w, "shown") { visible(p, w) }
    try click(p.controls.flip, in: w)
    w.shell.openReadingTab(title: "Alpha", key: "r/alpha")
    drag(p.divider, by: -40, in: w)
    await settle(w, "on the left") { place(p.reading, w).maxX < place(p.board, w).minX }
    try click(p.controls.toggle, in: w)
    await settle(w, "hidden") { p.reading.isHidden }
    for doc in w.panes.documents.values { doc.flush() }
    w.close(keepingVault: true)
    #expect(writes.changed(before, writes.files(v.root)) == [])
  }

  /// View ▸ Show Reading Pane is ⌃⌘R, which nothing else takes; moving it to the other side has no key
  @Test func controlCommandRShowsAndHidesTheReadingPane() {
    let keys = ParityMenuKeysTests()
    #expect(keys.actions("r", [.command, .control]) == [#selector(AppDelegate.flipReadingPane(_:))])
    #expect(keys.actions("s", [.command, .control]) == [#selector(AppDelegate.flipSidebar(_:))])
  }
}

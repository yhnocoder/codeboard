import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardNotes
@testable import CodeBoardShell

// ⌘K and ⌘F in the whole window (keymap.ts search, searchBoard; ui/Palette.tsx): the palette over the board, its
// groups, ↑ ↓ and Return, Tab between all boards and this one, Esc; the toolbar's Search; both keys in the shortcut list

@MainActor @Suite(.serialized) struct FullWindowSearchTests {
  let board = BoardID(rawValue: "w")
  let other = BoardID(rawValue: "o")
  let env = FullWindowEditTests()

  func vault() throws -> Vault {
    let root = FileManager.default.temporaryDirectory.appending(path: "search-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    func note(_ id: String, _ text: String, x: Double = 0, y: Double = 0) -> Card {
      Card(
        id: CardID(rawValue: id), x: x, y: y, width: 240, height: 120,
        content: .own(CardContent(body: .note(Note(text: text)))))
    }
    try vault.newBoard(
      in: "", title: "W",
      board: Board(
        id: board, cards: [note("n", "# A plan"), note("far", "# Waiting list", x: 4000, y: 3000)],
        sidenotes: [
          Sidenote(
            id: SidenoteID(rawValue: "sn"), anchor: .card(CardID(rawValue: "n")),
            body: .text(TextNote(text: "waiting is FIFO")))
        ],
        shelf: [ShelfEntry(id: "e1", at: 0, cards: [note("put", "# Waiting room", x: 300)])]))
    try vault.newBoard(in: "", title: "Other", board: Board(id: other, cards: [note("on", "# Waiting elsewhere")]))
    return vault
  }

  /// Until `f` holds (it may ask the palette's page), the canvas's frames ticking meanwhile
  func until(_ what: String, in w: FullWindowEditTests.Window, _ f: () async -> Bool) async {
    let deadline = ContinuousClock.now + .seconds(30)
    while !(await f()) {
      if ContinuousClock.now > deadline {
        Issue.record("\(what): not within 30 s")
        return
      }
      w.pane?.tick(at: CACurrentMediaTime())
      try? await Task.sleep(for: .milliseconds(5))
    }
  }

  func opened() async throws -> FullWindowEditTests.Window {
    let w = try await env.opened(try vault())
    BoardPanes.search.drawOffScreen()
    return w
  }

  /// A key of the app menu as AppKit gives it: its item's action up the key window's responder chain (the window
  /// here is never key, so from its first responder)
  func menuKey(_ w: FullWindowEditTests.Window, _ key: String) throws {
    func items(_ m: NSMenu) -> [NSMenuItem] { m.items.flatMap { [$0] + ($0.submenu.map(items) ?? []) } }
    let item = try #require(
      items(AppDelegate().mainMenu()).first { $0.keyEquivalent == key && $0.keyEquivalentModifierMask == .command },
      "⌘\(key) is in the menu")
    let r = try #require(w.window.firstResponder)
    #expect(r.tryToPerform(try #require(item.action), with: item), "⌘\(key) is answered")
  }

  struct Shown {
    var here: Bool
    var groups: [String]
    var rows: [String]
    var details: [String]
    var on: Int
    var empty: String?
    var focused: Bool
    var busy: Bool
  }

  func shown() async -> Shown? {
    guard let s = await BoardPanes.search.run("return palette.state()") as? [String: Any] else { return nil }
    let rows = s["rows"] as? [[String: Any]] ?? []
    return Shown(
      here: s["here"] as? Bool ?? false, groups: s["groups"] as? [String] ?? [],
      rows: rows.map { $0["label"] as? String ?? "" }, details: rows.map { $0["detail"] as? String ?? "" },
      on: s["on"] as? Int ?? -1, empty: s["empty"] as? String, focused: s["focused"] as? Bool ?? false,
      busy: s["busy"] as? Bool ?? false)
  }

  func open(_ w: FullWindowEditTests.Window, _ key: String) async throws {
    try menuKey(w, key)
    await until("the palette up", in: w) { !BoardPanes.search.view.isHidden }
    await until("its field ready", in: w) { await shown()?.focused == true }
  }

  func type(_ w: FullWindowEditTests.Window, _ text: String, rows: Int) async -> Shown? {
    _ = await BoardPanes.search.run("palette.type(t)", ["t": text])
    await until("\(rows) rows for “\(text)”", in: w) {
      let s = await shown()
      return s?.busy == false && s?.rows.count == rows
    }
    return await shown()
  }

  func press(_ key: String) async { _ = await BoardPanes.search.run("palette.press(k)", ["k": key]) }

  @Test func commandKSearchesEveryBoardAndReturnOpensTheCardsBoard() async throws {
    let w = try await opened()
    defer { w.close() }
    try await open(w, "k")
    #expect(w.window.firstResponder === BoardPanes.search.view, "the palette takes the keys")
    let s = try #require(await shown())
    #expect(!s.here && s.empty == "Type to search.")
    let found = try #require(await type(w, "waiting", rows: 4))
    // this board's first (the one on its Shelf too), then the other board's; then the sidenote
    #expect(found.groups == ["Cards on Boards", "Sidenotes"])
    #expect(found.rows == ["Waiting list", "Waiting room", "Waiting elsewhere", "waiting is FIFO"])
    #expect(found.details == ["This board", "This board", "Other", "W · A plan"])
    #expect(found.on == 0)
    await press("ArrowDown")
    await press("ArrowDown")
    #expect(await shown()?.on == 2)
    await press("ArrowUp")
    await press("ArrowDown")
    await press("Enter")
    await until("the other board shown", in: w) { w.shows(other) }
    #expect(BoardPanes.search.isOpen == false && BoardPanes.search.view.isHidden)
    await until("its card selected", in: w) { w.pane?.document?.selection == [.card(CardID(rawValue: "on"))] }
  }

  @Test func returnOnACardOfThisBoardBringsItIntoViewSelected() async throws {
    let w = try await opened()
    defer { w.close() }
    try await open(w, "k")
    _ = await type(w, "waiting list", rows: 1)
    await press("Enter")
    let far = CardID(rawValue: "far")
    await until("it is selected", in: w) { w.pane?.document?.selection == [.card(far)] }
    #expect(w.shows(board))
    await until("it is in view", in: w) {
      w.canvas.safeView.contains(CGPoint(x: 4000 + 120, y: 3000 + 10)) && w.canvas.motion.isResting
    }
    #expect(w.window.firstResponder === w.canvas, "the keys back on the board")
  }

  @Test func aShelvedCardPickedIsPutBack() async throws {
    let w = try await opened()
    defer { w.close() }
    try await open(w, "k")
    _ = await type(w, "waiting room", rows: 1)
    await press("Enter")
    let put = CardID(rawValue: "put")
    await until("back on the board, selected", in: w) {
      w.pane?.document?.board.card(put) != nil && w.pane?.document?.selection == [.card(put)]
    }
    #expect(w.pane?.document?.board.shelf.isEmpty == true)
  }

  @Test func commandFSearchesThisBoardTabSwitchesAndEscClosesWithTheCameraWhereItWas() async throws {
    let w = try await opened()
    defer { w.close() }
    let camera = w.canvas.currentCamera
    try await open(w, "f")
    #expect(await shown()?.here == true)
    #expect(await shown()?.empty == "Type to search this board.")
    let found = try #require(await type(w, "waiting", rows: 3))
    #expect(found.groups == ["Cards on This Board", "Sidenotes"])
    #expect(found.rows == ["Waiting list", "Waiting room", "waiting is FIFO"])
    await press("Tab")
    await until("all boards", in: w) { await shown()?.rows.count == 4 }
    #expect(await shown()?.here == false)
    await press("Escape")
    await until("closed", in: w) { !BoardPanes.search.isOpen }
    #expect(BoardPanes.search.view.isHidden)
    #expect(w.window.firstResponder === w.canvas, "the keys back on the board")
    #expect(w.canvas.currentCamera == camera)
    #expect(w.pane?.document?.selection.isEmpty == true)
  }

  @Test func theToolbarsSearchOpensCommandK() async throws {
    let w = try await opened()
    defer { w.close() }
    let pane = try #require(w.pane.flatMap { $0.superview })
    let bar = try #require(pane.subviews.compactMap { $0 as? CanvasToolbar }.first)
    let r = bar.extraRects().search
    let at = bar.convert(CGPoint(x: r.midX, y: r.midY), to: nil)
    let frame = try #require(w.window.contentView?.superview)
    let hit = try #require(frame.hitTest(frame.convert(at, from: nil)))
    #expect(hit === bar, "the button is the toolbar's: \(hit)")
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      let e = NSEvent.mouseEvent(
        with: type, location: at, modifierFlags: [], timestamp: 0, windowNumber: w.window.windowNumber, context: nil,
        eventNumber: 0, clickCount: 1, pressure: 1)!
      if type == .leftMouseDown { hit.mouseDown(with: e) } else { hit.mouseUp(with: e) }
    }
    await until("the palette up", in: w) { !BoardPanes.search.view.isHidden }
    await until("on all boards", in: w) { await shown()?.focused == true }
    #expect(await shown()?.here == false)
    await press("Escape")
    await until("closed", in: w) { !BoardPanes.search.isOpen }
  }

  @Test func bothKeysAreInTheShortcutList() {
    let view = KeysPanel.rows().first { $0.name == "View" }?.rows ?? []
    #expect(view.prefix(2).map(\.key) == ["⌘K", "⌘F"])
    #expect(view.prefix(2).map(\.label) == ["Search", "Search This Board"])
  }
}

import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// Delete Everywhere in the whole window (keymap.ts deleteEverywhere ⌘⌫, menus.ts deleteItems, actions/shared.ts
// deleteEverywhere, host storage/boards.ts deleteEverywhere): a shared card on several boards is asked about in a sheet,
// then goes from this board as one step, from every other board showing it (open or not) and its file to the trash.
// The trash is the test's own folder.

@MainActor @Suite(.serialized) struct FullWindowDeleteEverywhereTests {
  let edit = FullWindowEditTests()
  let s = CardID(rawValue: "s")

  /// Boards A, B and C showing shared card "s" (a Note titled Shared plan, with a sidenote that travels), A with a card of
  /// its own and an arrow to s, D without it
  func vault() throws -> Vault {
    let fm = FileManager.default
    let vault = Vault(root: fm.temporaryDirectory.appending(path: "everywhere-\(UUID().uuidString)"))
    try fm.createDirectory(at: vault.sharedFolderURL, withIntermediateDirectories: true)
    try SharedCard(
      id: s, content: CardContent(body: .note(Note(text: "# Shared plan\n\nsteps"))),
      sidenotes: [Sidenote(id: SidenoteID(rawValue: "n1"), anchor: .card(s), body: .text(TextNote(text: "travels")))]
    ).encoded().write(to: vault.sharedFolderURL.appending(path: "s.json"))
    let shared = Card(id: s, x: 300, y: 0, width: 240, height: 160, content: .shared, isShared: true)
    let own = Card(
      id: CardID(rawValue: "n"), x: 0, y: 0, width: 240, height: 160,
      content: .own(CardContent(body: .note(Note(text: "mine")))))
    try vault.newBoard(
      in: "", title: "A",
      board: Board(
        id: BoardID(rawValue: "a"), cards: [own, shared],
        arrows: [Arrow(id: ArrowID(rawValue: "l"), from: Endpoint(card: own.id), to: Endpoint(card: s))]))
    for name in ["B", "C"] {
      try vault.newBoard(in: "", title: name, board: Board(id: BoardID(rawValue: name.lowercased()), cards: [shared]))
    }
    try vault.newBoard(in: "", title: "D", board: Board(id: BoardID(rawValue: "d"), cards: [own]))
    return vault
  }

  func commandDelete(_ w: FullWindowEditTests.Window) {
    let e = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: w.window.windowNumber,
      context: nil, characters: "\u{8}", charactersIgnoringModifiers: "\u{8}", isARepeat: false, keyCode: 51)!
    w.window.makeFirstResponder(w.canvas)
    _ = w.window.performKeyEquivalent(with: e)
  }

  func answer(_ w: FullWindowEditTests.Window, _ button: String) async throws -> [String] {
    await edit.until("asked", in: w) { w.window.attachedSheet != nil }
    let sheet = try #require(w.window.attachedSheet)
    func all(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap(all) }
    let views = all(try #require(sheet.contentView))
    let texts = views.compactMap { ($0 as? NSTextField)?.stringValue }.filter { !$0.isEmpty }
    let b = try #require(views.compactMap { $0 as? NSButton }.first { $0.title == button })
    b.sendAction(b.action, to: b.target)
    await edit.until("answered", in: w) { w.window.attachedSheet == nil }
    return texts
  }

  @Test func aSharedCardIsDeletedEverywhereAfterTheQuestionAndAnOwnCardSaysWhy() async throws {
    let vault = try vault()
    let w = FullWindowEditTests.Window(vault, board: BoardID(rawValue: "a"))
    defer { w.close() }
    let trash = FileManager.default.temporaryDirectory.appending(path: "trash-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: trash) }
    var trashed: [String] = []
    w.shell.trasher = { url in
      let to = trash.appending(path: url.lastPathComponent)
      try FileManager.default.moveItem(at: url, to: to)
      MainActor.assumeIsolated { trashed.append(url.lastPathComponent) }
      return to
    }
    // B open too: its document is the one changed
    w.shell.show(BoardID(rawValue: "b"))
    w.panes.sync()
    await edit.until("B shown", in: w) { w.pane?.document?.id == BoardID(rawValue: "b") && w.pane?.scene != nil }
    w.shell.show(BoardID(rawValue: "a"))
    w.panes.sync()
    await edit.until("A shown", in: w) { w.pane?.document?.id == BoardID(rawValue: "a") && w.pane?.scene != nil }
    let c = w.canvas
    let doc = try #require(c.document)
    // its menu: what it is and on how many boards, Remove from This Board, Delete Everywhere…
    let r = try #require(c.scene?.items.first { $0.owner == .card(s) }?.rect)
    doc.select([.card(s)])
    let e = NSEvent.mouseEvent(
      with: .rightMouseDown, location: w.at(CGPoint(x: r.midX, y: r.midY)), modifierFlags: [], timestamp: 0,
      windowNumber: w.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    let menu = try #require(c.menu(for: e))
    let titles = menu.items.map { $0.isSeparatorItem ? "-" : $0.title }
    #expect(
      Array(titles.suffix(4)) == ["-", "Shared plan · on 3 boards", "Remove from This Board", "Delete Everywhere…"])
    #expect(menu.items.first { $0.title == "Shared plan · on 3 boards" }?.isEnabled == false)
    let everywhere = try #require(menu.items.first { $0.title == "Delete Everywhere…" })
    #expect(everywhere.keyEquivalent == "\u{8}" && everywhere.keyEquivalentModifierMask == .command)
    // a card of this board's own: why not
    doc.select([.card(CardID(rawValue: "n"))])
    commandDelete(w)
    #expect(c.toastText == "Only linked cards on several boards can be deleted everywhere. Press ⌫ to delete.")
    #expect(w.window.attachedSheet == nil)
    // asked, in main's words; Cancel leaves everything
    doc.select([.card(s)])
    commandDelete(w)
    let asked = try await answer(w, "Cancel")
    #expect(asked.contains("Delete “Shared plan” everywhere?"), "\(asked)")
    #expect(asked.contains("This card is on 3 boards: A, B, C. Its arrows and sidenotes go too, on every board."))
    #expect(doc.board.card(s) != nil && trashed.isEmpty)
    // Delete Everywhere: gone here as one step (its arrow and sidenote too), from B open and C closed, D untouched,
    // its file in the trash
    commandDelete(w)
    _ = try await answer(w, "Delete Everywhere")
    await edit.until("deleted everywhere", in: w) { c.toastText == "Deleted from 3 boards" }
    #expect(doc.board.card(s) == nil && doc.board.arrows.isEmpty && doc.board.sidenotes.isEmpty)
    #expect(doc.history.undoSteps.last?.name == "Delete Everywhere")
    #expect(w.panes.documents[BoardID(rawValue: "b")]?.board.card(s) == nil)
    let tree = try vault.tree()
    for (name, has) in [("B", false), ("C", false), ("D", false)] {
      let b = try #require(tree.allBoards.first { $0.title == name })
      #expect(try vault.board(at: b.path).cards.contains { $0.id == s } == has, "\(name)")
    }
    #expect(try vault.board(at: try #require(tree.allBoards.first { $0.title == "D" }).path).cards.count == 1)
    #expect(trashed == ["s.json"] && !vault.sharedCardExists(s))
    #expect(c.toastText == "Deleted from 3 boards")
  }
}

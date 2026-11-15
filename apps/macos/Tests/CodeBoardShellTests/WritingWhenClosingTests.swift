import AppKit
import CodeBoardModel
import CodeBoardNotes
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// What is being written in a card when its tab closes or another vault opens goes to its board, on disk, before the
// board is let go (needs the built Note page: node web/build.mjs)
@MainActor @Suite(.serialized) struct WritingWhenClosingTests {
  static let notes = NoteRenderer(
    cache: FileManager.default.temporaryDirectory.appending(path: "panes-notes-\(UUID().uuidString)"))

  @MainActor final class Setup {
    let root: URL
    let file: URL
    let shell = Shell()
    let panes: BoardPanes
    let window: NSWindow
    let card = CardID(rawValue: "n")

    init() throws {
      _ = NSApplication.shared
      let page = NoteRenderer.bundledPage.appending(path: "page.html").path(percentEncoded: false)
      try #require(FileManager.default.fileExists(atPath: page), "build the Note page first: node web/build.mjs")
      let fm = FileManager.default
      root = fm.temporaryDirectory.appending(path: "panes-writing-\(UUID().uuidString)")
      let board = Board(
        id: BoardID(rawValue: "b"),
        cards: [
          Card(
            id: card, x: 0, y: 0, width: 240, height: 120,
            content: .own(CardContent(body: .note(Note(text: "Threads wait")))))
        ])
      let package = root.appending(path: "B.board")
      try fm.createDirectory(at: package, withIntermediateDirectories: true)
      file = package.appending(path: Vault.boardFileName)
      try board.encoded().write(to: file)
      let vault = Vault(root: root)
      shell.open(vault, restoring: nil)
      shell.apply(.success(try vault.tree()))
      panes = BoardPanes(shell: shell, notes: WritingWhenClosingTests.notes)
      panes.frame = CGRect(x: 0, y: 0, width: 900, height: 600)
      // under the desktop, never key: the web view runs its animation frames only in a window that is ordered in
      window = NSWindow(
        contentRect: CGRect(x: -30000, y: -30000, width: 900, height: 600), styleMask: [.titled],
        backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      window.level = .underDesktop
      window.contentView = panes
      window.orderFrontRegardless()
      shell.show(board.id)
      panes.sync()
    }

    var canvas: CanvasView { panes.panes.values.first!.canvas }

    /// Writes " and then" in the card and leaves it being written in
    func write() async throws {
      canvas.noteEditor.drawOffScreen()
      let deadline = ContinuousClock.now + .seconds(60)
      while !(canvas.isEditing && canvas.noteEditor.view.shown) {
        try #require(ContinuousClock.now < deadline, "the editor did not mount")
        if !canvas.isEditing { canvas.beginEditing(card) }
        try await Task.sleep(for: .milliseconds(5))
      }
      canvas.noteEditor.type(" and then")
      _ = try await canvas.noteEditor.view.callAsyncJavaScript(
        "await new Promise(r => requestAnimationFrame(r)); return 1", contentWorld: .page)
    }

    func onDisk() throws -> String? {
      try Board(decoding: Data(contentsOf: file), file: file).card(card)?.writing
    }

    /// The board's folder as it is now: each file with its size
    func listing() -> String {
      let folder = file.deletingLastPathComponent()
      let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
      return names.sorted().map { n in
        let size = (try? FileManager.default.attributesOfItem(atPath: folder.appending(path: n).path)[.size]) ?? "?"
        return "\(n) \(size)"
      }.joined(separator: ", ")
    }

    func close() {
      window.close()
      try? FileManager.default.removeItem(at: root)
    }
  }

  @Test func closingTheTabWritesWhatIsBeingTyped() async throws {
    let s = try Setup()
    defer { s.close() }
    try await s.write()
    s.shell.close(try #require(s.shell.selected))
    s.panes.sync()
    // the closed tab's writing still ends after its tab has gone: what quitting (or another vault) asks and waits for
    // right now. The card's writing ends a step before its board is written (Pane.close), so the canvas no longer
    // writing is not yet the board on disk
    #expect(s.panes.isEditing, "still writing what the closed tab had")
    await s.panes.endEditing()
    // read on its own: a value that differs is shown (an expectation with a `try` in it shows none), an error says what
    let got = try s.onDisk()
    #expect(got == "Threads wait and then", "\(s.listing())")
  }

  @Test func anotherVaultWritesWhatIsBeingTypedBeforeTheBoardsAreLetGo() async throws {
    let s = try Setup()
    defer { s.close() }
    try await s.write()
    await s.panes.close()
    #expect(s.panes.documents.isEmpty)
    let got = try s.onDisk()
    #expect(got == "Threads wait and then", "\(s.listing())")
  }

  /// The whole window on `board`, alone in a vault of its own, its editor drawing as the window's own would
  @MainActor final class Whole {
    let w: FullWindowEditTests.Window
    let file: URL

    init(_ board: Board) async throws {
      _ = NSApplication.shared
      let fm = FileManager.default
      let root = fm.temporaryDirectory.appending(path: "closing-window-\(UUID().uuidString)")
      let vault = Vault(root: root)
      try fm.createDirectory(at: root, withIntermediateDirectories: true)
      try vault.newBoard(in: "", title: "C", board: board)
      w = FullWindowEditTests.Window(vault, board: board.id)
      file = try #require(w.shell.board(board.id).map { vault.url(of: $0.path).appending(path: Vault.boardFileName) })
      try await until("the board shown") { self.w.pane?.scene != nil && self.w.pane?.shown?.board.id == board.id }
      // under the desktop the window counts as covered, where WebKit would hold the page's frames; a view hidden in it
      // still counts as not shown, which is what closing a tab does to its pane
      w.canvas.noteEditor.drawOffScreen()
      w.canvas.sidenotePop.drawOffScreen()
    }

    func onDisk() throws -> Board { try Board(decoding: Data(contentsOf: file), file: file) }

    func until(_ what: String, _ f: () async -> Bool) async throws {
      let deadline = ContinuousClock.now + .seconds(30)
      while await !f() {
        try #require(ContinuousClock.now < deadline, "\(what): not within 30 s")
        w.pane?.tick(at: CACurrentMediaTime())
        try await Task.sleep(for: .milliseconds(5))
      }
    }

    /// Writes `text` in `card` and leaves it being written in
    func write(_ text: String, in card: CardID) async throws {
      let c = w.canvas
      try await until("the editor up") {
        if !c.isEditing { c.beginEditing(card) }
        return c.editing?.ready == true && c.noteEditor.view.shown
      }
      c.noteEditor.type(text)
      _ = try await c.noteEditor.view.callAsyncJavaScript(
        "await new Promise(r => requestAnimationFrame(r)); return 1", contentWorld: .page)
    }

    /// ⌘W (AppDelegate closeTab) and the window's tracking taking the pane away, then at once quitting (what
    /// AppDelegate applicationShouldTerminate does) or another vault (BoardPanes.close): whether that ended within 10 s
    func closeTabAndThen(_ then: String) async throws -> Bool {
      w.shell.close(try #require(w.shell.selected))
      try await until("the tab's pane gone") { w.panes.panes.isEmpty }
      var ended = false
      let panes = w.panes
      Task {
        if then == "quit" {
          if panes.isEditing { await panes.endEditing() }
          _ = panes.flush()
        } else {
          await panes.close()
        }
        ended = true
      }
      let deadline = ContinuousClock.now + .seconds(10)
      while !ended, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
      return ended
    }

    func close() { w.close() }
  }

  /// A Note whose header shows its heading (the header folds while it is written in, and unfolds as the writing ends)
  @Test(arguments: ["quit", "vault"])
  func quittingOrAnotherVaultRightAfterClosingTheTabWritesWhatWasTypedInATitledNote(_ then: String) async throws {
    let card = CardID(rawValue: "n")
    let s = try await Whole(
      Board(
        id: BoardID(rawValue: "c"),
        cards: [
          Card(
            id: card, x: 0, y: 0, width: 240, height: 160,
            content: .own(CardContent(body: .note(Note(text: "# Steps\n\nThreads wait")))))
        ]))
    defer { s.close() }
    let c = s.w.canvas
    let i = try #require(c.index(of: .card(card)))
    guard case .note(let n)? = c.scene?.items[i].drawing else {
      Issue.record("not drawn as a Note")
      return
    }
    #expect(n.hideHead, "its header shows its heading")
    try await s.write(" and then", in: card)
    #expect(try await s.closeTabAndThen(then), "\(then) ended")
    let got = try s.onDisk().card(card)?.writing
    #expect(got == "# Steps\n\nThreads wait and then")
  }
}

extension WritingWhenClosingTests {
  @Test func quittingRightAfterClosingTheTabWritesWhatWasTypedInAFreeCodeCard() async throws {
    let card = CardID(rawValue: "f")
    let code = Segment(
      id: SegmentID(rawValue: "s"), source: nil, language: "python", firstLine: 1, lines: ["def step(batch):"])
    let s = try await Whole(
      Board(
        id: BoardID(rawValue: "c"),
        cards: [
          Card(id: card, x: 0, y: 0, width: 320, content: .own(CardContent(body: .code(CodeCard(segments: [code])))))
        ]))
    defer { s.close() }
    // a Free code card is written in the canvas's own code editor, no web page: what is typed is there at once
    let c = s.w.canvas
    c.beginCodeEditing(card)
    let v = try #require(c.editing?.codeView)
    v.insertText("# one step", replacementRange: NSRange(location: NSNotFound, length: 0))
    v.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    #expect(try await s.closeTabAndThen("quit"), "quit ended")
    let got = try s.onDisk().freeCodeSegment(card)?.lines
    #expect(got == ["# one step", "def step(batch):"])
  }

  @Test func quittingRightAfterClosingTheTabAddsTheSidenoteBeingWrittenInThePopup() async throws {
    let card = CardID(rawValue: "t")
    let s = try await Whole(
      Board(
        id: BoardID(rawValue: "c"),
        cards: [Card(id: card, x: 0, y: 0, width: 200, content: .own(CardContent(body: .text(TextCard(text: "a")))))]))
    defer { s.close() }
    let c = s.w.canvas
    let at = PopAt.spot(.card(card))
    c.openPop(at, write: true)
    try await s.until("the popup's input") {
      guard c.popShown == at, c.sidenotePop.view.alphaValue == 1 else { return false }
      return await c.sidenotePop.run("return !!document.querySelector('.ProseMirror')") as? Bool == true
    }
    _ = await c.sidenotePop.run("pop.type(t)", ["t": "why wait"])
    #expect(try await s.closeTabAndThen("quit"), "quit ended")
    let got = try s.onDisk().sidenotes(at: .card(card)).map(\.body)
    #expect(got == [.text(TextNote(text: "why wait"))])
  }
}

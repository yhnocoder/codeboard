import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes
import Foundation
import Testing

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
      // far off screen, never key: the web view runs its animation frames only in a window that is ordered in
      window = NSWindow(
        contentRect: CGRect(x: -30000, y: -30000, width: 900, height: 600), styleMask: [.titled],
        backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
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

    func close() {
      window.close()
      try? FileManager.default.removeItem(at: root)
    }
  }

  @Test func closingTheTabWritesWhatIsBeingTyped() async throws {
    let s = try Setup()
    defer { s.close() }
    try await s.write()
    let canvas = s.canvas
    s.shell.close(try #require(s.shell.selected))
    s.panes.sync()
    let deadline = ContinuousClock.now + .seconds(30)
    while canvas.isEditing, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
    #expect(try s.onDisk() == "Threads wait and then")
  }

  @Test func anotherVaultWritesWhatIsBeingTypedBeforeTheBoardsAreLetGo() async throws {
    let s = try Setup()
    defer { s.close() }
    try await s.write()
    await s.panes.close()
    #expect(s.panes.documents.isEmpty)
    #expect(try s.onDisk() == "Threads wait and then")
  }
}

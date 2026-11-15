import AppKit
import CodeBoardCanvas
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
      let notes = WritingWhenClosingTests.notes
      panes = BoardPanes(
        shell: shell, notes: notes,
        display: NativeNotes(web: notes, pictures: root.appending(path: "pictures")))
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
      // once the board is shown: the native editor is there as soon as the writing begins
      let deadline = ContinuousClock.now + .seconds(60)
      while canvas.scene == nil {
        try #require(ContinuousClock.now < deadline, "the board did not show")
        try await Task.sleep(for: .milliseconds(5))
      }
      canvas.beginEditing(card)
      // keys as the window gives them to the editor that took them
      let v = try #require(canvas.editing?.writer)
      try #require(window.firstResponder === v)
      for ch in " and then" {
        for t in [NSEvent.EventType.keyDown, .keyUp] {
          window.sendEvent(
            NSEvent.keyEvent(
              with: t, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
              windowNumber: window.windowNumber, context: nil, characters: String(ch),
              charactersIgnoringModifiers: String(ch), isARepeat: false, keyCode: 0)!)
        }
      }
      try #require(v.source == "Threads wait and then")
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

  /// The tab closed and the app quitting at once, with no wait between (what AppDelegate applicationShouldTerminate does):
  /// the native editor's text is the card's at any moment
  @Test func quittingRightAfterTheTabClosedHasWhatWasTypedOnDisk() async throws {
    let s = try Setup()
    defer { s.close() }
    try await s.write()
    s.shell.close(try #require(s.shell.selected))
    s.panes.sync()
    if s.panes.isEditing { await s.panes.endEditing() }
    #expect(s.panes.flush().isEmpty)
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

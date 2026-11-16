import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// The app's windows over one session and one table of open boards: each window its own tabs, selection and camera,
// what is the app's (a fresh tree, writing every board) done once for all of them
@MainActor @Suite(.serialized) struct WindowSetTests {
  let a = BoardID(rawValue: "a")
  let b = BoardID(rawValue: "b")
  let n = CardID(rawValue: "n")
  let m = CardID(rawValue: "m")

  /// A vault of boards A (two notes) and B, the first window on A and a second from New Window, never on screen
  func twoWindows() throws -> (WindowSet, WindowSet.Entry, WindowSet.Entry, Vault) {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "windows-\(UUID().uuidString)")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    func note(_ id: CardID, x: Double) -> Card {
      Card(id: id, x: x, y: 0, width: 200, height: 100, content: .own(CardContent(body: .note(Note(text: "n")))))
    }
    try vault.newBoard(in: "", title: "A", board: Board(id: a, cards: [note(n, x: 0), note(m, x: 300)]))
    try vault.newBoard(in: "", title: "B", board: Board(id: b))
    let set = WindowSet()
    set.present = { _ in }
    let s = Shell(session: set.session)
    s.open(vault, restoring: nil)
    s.apply(.success(try vault.tree()))
    s.show(a)
    let first = set.add(s)
    first.window.setFrameAutosaveName("")
    first.panes.sync()
    let second = try #require(set.open())
    return (set, first, second, vault)
  }

  func canvas(_ e: WindowSet.Entry) -> CanvasView? { e.shell.selected.flatMap { e.panes.panes[$0]?.canvas } }

  func until(_ what: String, _ f: () -> Bool) async {
    let deadline = ContinuousClock.now + .seconds(20)
    while !f() {
      if ContinuousClock.now > deadline {
        Issue.record("\(what): not within 20 s")
        return
      }
      try? await Task.sleep(for: .milliseconds(5))
    }
  }

  @Test func aNewWindowShowsTheMainWindowsBoardOnItsDocumentWithASelectionAndCameraOfItsOwn() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    #expect(second.shell.session === first.shell.session && second.shell.tabs.map(\.board) == [a])
    #expect(second.shell.tabs.map(\.id) != first.shell.tabs.map(\.id), "a tab of its own")
    let c1 = try #require(canvas(first))
    let c2 = try #require(canvas(second))
    await until("shown in both") { c1.scene != nil && c2.scene != nil }
    let doc = try #require(set.documents.open[a])
    let s1 = try #require(c1.document)
    let s2 = try #require(c2.document)
    #expect(s1 !== s2 && s1.document === doc && s2.document === doc)
    s1.select([.card(n)])
    s2.select([.card(m)])
    #expect(s1.selection == [.card(n)] && s2.selection == [.card(m)])
    let was = c1.camera
    c2.camera = Camera(origin: CGPoint(x: 400, y: 120), zoom: 2)
    #expect(c1.camera == was)
    // an edit in one is the other's board too
    s2.edit("Move") { $0.move([.card(n)], dx: 50, dy: 0) }
    #expect(s1.board.card(n)?.x == 50 && s1.selection == [.card(n)])
    // menu actions, and the driver's shell(of:), go to the window asked about
    #expect(set.entry(of: second.window) === second && set.entry(of: first.window) === first)
  }

  @Test func closingOneWindowLeavesItsBoardsAndKeepsTheDocumentForTheOther() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let c1 = try #require(canvas(first))
    let c2 = try #require(canvas(second))
    await until("shown in both") { c1.scene != nil && c2.scene != nil }
    let doc = try #require(set.documents.open[a])
    c2.document?.edit("Move") { $0.move([.card(m)], dx: 10, dy: 0) }
    second.window.close()
    #expect(set.all.map(\.window) == [first.window])
    #expect(second.panes.panes.isEmpty && c2.document == nil, "its canvas left its seat")
    #expect(set.documents.open[a] === doc && c1.document?.document === doc)
    let file = vault.url(of: try #require(set.session.board(a)).path).appending(path: Vault.boardFileName)
    #expect(try Board(decoding: Data(contentsOf: file), file: file).card(m)?.x == 310, "written as it closed")
  }

  @Test func aFreshTreeReachesEveryWindowAndQuittingWritesEachBoardOnce() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    second.shell.show(b, newTab: true)
    set.sync()
    #expect(second.panes.panes.count == 2)
    // B goes on disk; the tree read once, through the first window's shell: the second's tab on it closes too
    try FileManager.default.removeItem(at: vault.url(of: try #require(set.session.board(b)).path))
    first.shell.apply(.success(try vault.tree()))
    set.sync(reload: true)
    #expect(second.shell.tabs.map(\.board) == [a] && second.panes.panes.count == 1)

    // a board that would not read back, open in both windows: named once
    let doc = try #require(set.documents.open[a])
    doc.edit("Broken") {
      $0.arrows.append(
        Arrow(id: ArrowID(rawValue: "x"), from: Endpoint(card: n), to: Endpoint(card: CardID(rawValue: "gone"))))
    }
    #expect(set.flush().map(\.title) == ["A"])
  }

  @Test func eachWindowIsSavedAndWhatOneWindowSavedBeforeIsReadAsOne() throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let name = "WindowSetTests-\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: name))
    defer { defaults.removePersistentDomain(forName: name) }
    let old = try #require(first.shell.state)
    defaults.set(try JSONEncoder().encode(old), forKey: WindowSet.oldStateKey)
    #expect(WindowSet.saved(in: defaults) == [SavedWindow(shell: old)])

    second.window.setFrame(CGRect(x: 200, y: 150, width: 900, height: 600), display: false)
    set.save(in: defaults)
    let saved = WindowSet.saved(in: defaults)
    #expect(saved.map(\.shell) == [old, try #require(second.shell.state)])
    #expect(saved[1].frame == CGRect(x: 200, y: 150, width: 900, height: 600))

    // the second closed and opened again from what was saved: its tabs as they were
    second.window.close()
    let again = try #require(set.open(saved[1]))
    #expect(again.shell.tabs == second.shell.tabs && again.shell.selected == second.shell.selected)
    // the last window closed saves nothing over what it saved
    for e in set.all { e.window.close() }
    set.save(in: defaults)
    #expect(WindowSet.saved(in: defaults).count == 2)
  }
}

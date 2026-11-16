import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

@testable import CodeBoardReading

/// A trash of the test's own: what went there, moved into a temporary folder
final class TestTrash: Sendable {
  let dir = FileManager.default.temporaryDirectory.appending(path: "trash-\(UUID().uuidString)")

  init() throws { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }

  var trasher: Vault.Trasher {
    { [dir] url in
      let to = dir.appending(path: url.lastPathComponent)
      try FileManager.default.moveItem(at: url, to: to)
      return to
    }
  }

  var names: [String] { ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).sorted() }

  func remove() { try? FileManager.default.removeItem(at: dir) }
}

/// The list given the test's trash and a question that answers `answer`, keeping the questions asked
@MainActor private func deleting(
  _ list: ListTabView, _ trash: TestTrash, answer: Bool
) -> () -> [NSAlert] {
  var asked: [NSAlert] = []
  list.trasher = trash.trasher
  list.confirm = { alert, _ in
    asked.append(alert)
    return answer
  }
  return { asked }
}

@MainActor private func select(_ list: ListTabView, _ titles: [String]) {
  let rows = IndexSet(list.shown.indices.filter { titles.contains(list.shown[$0].title) })
  list.table.selectRowIndexes(rows, byExtendingSelection: false)
}

@MainActor private let backspace = NSEvent.keyEvent(
  with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
  characters: "\u{7f}", charactersIgnoringModifiers: "\u{7f}", isARepeat: false, keyCode: 51)!

@MainActor @Suite(.serialized) struct ListDeleteTests {
  /// ⌫ on an entry no board uses: no question, its folder to the trash, its row gone and the pane's entries without it
  @Test func anEntryNoBoardUsesGoesToTheTrashUnasked() async throws {
    let v = try ListVault()
    let trash = try TestTrash()
    defer {
      v.remove()
      trash.remove()
    }
    let (_, list) = try await v.openList()
    let asked = deleting(list, trash, answer: false)
    let before = list.rows.count
    select(list, ["Weirs"])
    list.table.keyDown(with: backspace)
    await list.deleting?.value
    #expect(asked().isEmpty)
    #expect(trash.names == ["Weirs"])
    #expect(list.rows.count == before - 1 && !list.rows.contains { $0.title == "Weirs" })
    #expect(v.pane.entries[v.weirs.id] == nil)
  }

  /// Entries used on boards: the question names them (tree order, each once); Cancel changes nothing, Delete sends
  /// them to the trash and leaves the boards as they were
  @Test func entriesUsedOnBoardsAreAskedAboutFirst() async throws {
    let v = try ListVault()
    let trash = try TestTrash()
    defer {
      v.remove()
      trash.remove()
    }
    let alpha = try v.vault.newBoard(
      in: "", title: "Alpha",
      board: Board(id: BoardID(rawValue: "b-a"), cards: [v.note("c1", from: v.paper), v.note("c2", from: v.estuary)]))
    try v.vault.newBoard(
      in: "", title: "Beta", board: Board(id: BoardID(rawValue: "b-b"), cards: [v.note("c3", from: v.estuary)]))
    let boardFile = v.vault.url(of: alpha.path).appending(path: Vault.boardFileName)
    let board = try Data(contentsOf: boardFile)
    let (_, list) = try await v.openList()
    let before = list.rows

    var asked = deleting(list, trash, answer: false)
    select(list, ["Tidal mills", "Estuary flows", "Weirs"])
    list.delete(nil)
    await list.deleting?.value
    let q = try #require(asked().first)
    #expect(asked().count == 1)
    #expect(q.messageText == "3 entries are used on 2 boards")
    #expect(q.informativeText.hasPrefix("Used on: Alpha, Beta."))
    #expect(q.buttons.map(\.title) == ["Delete", "Cancel"] && q.buttons[1].keyEquivalent == "\r")
    #expect(trash.names.isEmpty && list.rows == before)

    asked = deleting(list, trash, answer: true)
    select(list, ["Tidal mills"])
    list.delete(nil)
    await list.deleting?.value
    #expect(asked().map(\.messageText) == ["“Tidal mills” is used on 1 board"])
    #expect(trash.names == [(v.paperPath as NSString).lastPathComponent])
    #expect(!list.rows.contains { $0.title == "Tidal mills" } && list.rows.count == before.count - 1)
    #expect(try Data(contentsOf: boardFile) == board)
  }

  @Test func theQuestionNamesSixBoardsAndHowManyMore() {
    let q = ListTabView.deleteQuestion(["Weirs"], boards: (1...8).map { "B\($0)" })
    #expect(q.messageText == "“Weirs” is used on 8 boards")
    #expect(q.informativeText.hasPrefix("Used on: B1, B2, B3, B4, B5, B6 and 2 more."))
  }

  /// The row menu's Delete is the list's delete, and a right-click outside the selection selects that row
  @Test func theRowMenuDeletes() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    let item = try #require(list.table.menu?.items.first)
    #expect(item.title == "Delete" && item.action == #selector(ListTabView.delete(_:)) && item.target === list)
    let r = list.table.rect(ofRow: 2)
    let click = NSEvent.mouseEvent(
      with: .rightMouseDown, location: list.table.convert(CGPoint(x: r.minX + 40, y: r.midY), to: nil),
      modifierFlags: [], timestamp: 0, windowNumber: list.table.window?.windowNumber ?? 0, context: nil,
      eventNumber: 0, clickCount: 1, pressure: 1)!
    #expect(list.table.menu(for: click) != nil)
    #expect(list.table.selectedRowIndexes == [2])
  }
}

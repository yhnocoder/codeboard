import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

@testable import CodeBoardReading

/// The list's window Undo, each edit a step of its own (the app's are by event; here one group each)
@MainActor private func undoing(_ v: ListVault) throws -> UndoManager {
  let undo = try #require(v.window.undoManager)
  undo.removeAllActions()
  undo.groupsByEvent = false
  return undo
}

@MainActor private func step(_ undo: UndoManager, _ act: () async throws -> Void) async rethrows {
  undo.beginUndoGrouping()
  defer { undo.endUndoGrouping() }
  try await act()
}

@MainActor private func key(_ list: ListTabView, _ title: String) throws -> String {
  try #require(list.rows.first { $0.title == title }).key
}

/// Each of the list's edits is one step of its window's Undo, named for it, and Redo does it again
@MainActor @Suite(.serialized) struct ListUndoTests {
  /// A value changed twice: Undo writes back the one before, Redo the new one; a value cleared comes back on Undo
  @Test func aValueChangedIsWrittenBackOnUndoAndAgainOnRedo() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    let undo = try undoing(v)
    var f: Resource.Field?
    await step(undo) { f = list.addField(.text) }
    let id = try #require(f).id
    let k = try key(list, "Weirs")
    let value = { try v.vault.entry(at: k).fields[id] }
    await step(undo) { list.set(.text("Draft"), of: id, at: k) }
    await step(undo) { list.set(.text("Final"), of: id, at: k) }
    #expect(undo.undoActionName == "Change Text")
    undo.undo()
    #expect(try value() == .text("Draft"))
    #expect(list.rows.first { $0.key == k }?.fields[id] == .text("Draft"))
    #expect(list.selected.map { list.shown[$0].key } == k, "the row changed selected")
    #expect(undo.redoActionName == "Change Text")
    undo.redo()
    #expect(try value() == .text("Final"))
    await step(undo) { list.set(nil, of: id, at: k) }
    #expect(try value() == nil)
    undo.undo()
    #expect(try value() == .text("Final"))
    undo.undo()
    undo.undo()
    #expect(try value() == nil && !(try v.vault.entry(at: k).fields.keys.contains(id)), "no value: no key")
  }

  /// Fields added and deleted: Undo puts back the resource's fields as they were, Redo as they were made
  @Test func fieldsAddedAndDeletedComeBackOnUndo() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    let undo = try undoing(v)
    let fields = { try v.vault.resource(at: v.resource.path).fields }
    var f: Resource.Field?
    await step(undo) { f = list.addField(.number) }
    let added = try #require(f)
    #expect(try fields() == [added] && undo.undoActionName == "Add Field")
    undo.undo()
    #expect(try fields().isEmpty && list.fields.isEmpty)
    #expect(!list.columns.contains { $0.id == "field:" + added.id })
    undo.redo()
    #expect(try fields() == [added] && list.columns.contains { $0.id == "field:" + added.id })
    await step(undo) { list.renameField(added.id, to: "Pages") }
    #expect(undo.undoActionName == "Rename Field")
    await step(undo) { list.removeField(added.id) }
    #expect(try fields().isEmpty && undo.undoActionName == "Delete Field")
    undo.undo()
    #expect(try fields().map(\.name) == ["Pages"])
    undo.undo()
    #expect(try fields() == [added])
    undo.redo()
    undo.redo()
    #expect(try fields().isEmpty)
  }

  /// Two entries deleted at once: one Undo puts both back as they were, selected; Redo sends both again
  @Test func entriesDeletedTogetherComeBackInOneUndo() async throws {
    let v = try ListVault()
    let trash = try TestTrash()
    defer {
      v.remove()
      trash.remove()
    }
    let (_, list) = try await v.openList()
    let undo = try undoing(v)
    list.trasher = trash.trasher
    list.confirm = { _, _ in true }
    let keys = [try key(list, "Weirs"), try key(list, "Estuary flows")]
    let files = keys.map { v.vault.url(of: $0).appending(path: Vault.entryFileName) }
    let before = try files.map { try Data(contentsOf: $0) }
    let rows = list.rows.count
    await step(undo) {
      list.table.selectRowIndexes(
        IndexSet(list.shown.indices.filter { keys.contains(list.shown[$0].key) }), byExtendingSelection: false)
      list.delete(nil)
      await list.deleting?.value
    }
    #expect(trash.names.count == 2 && list.rows.count == rows - 2)
    #expect(undo.undoActionName == "Delete Entries")
    undo.undo()
    #expect(trash.names.isEmpty && list.rows.count == rows)
    #expect(try files.map { try Data(contentsOf: $0) } == before)
    #expect(Set(list.table.selectedRowIndexes.map { list.shown[$0].key }) == Set(keys))
    #expect(v.pane.entries[v.weirs.id] != nil)
    #expect(undo.redoActionName == "Delete Entries")
    undo.redo()
    #expect(trash.names.count == 2 && list.rows.count == rows - 2 && v.pane.entries[v.weirs.id] == nil)
  }

  /// Undo of a delete whose place is taken by then: it stays in the trash, what is there now is left as it is
  @Test func aDeleteWhosePlaceIsTakenIsNotUndoneOverIt() async throws {
    let v = try ListVault()
    let trash = try TestTrash()
    defer {
      v.remove()
      trash.remove()
    }
    let (_, list) = try await v.openList()
    let undo = try undoing(v)
    list.trasher = trash.trasher
    let k = try key(list, "Weirs")
    await step(undo) { list.trash([k], as: "Delete Entry") }
    #expect(undo.undoActionName == "Delete Entry")
    let place = v.vault.url(of: k)
    try FileManager.default.createDirectory(at: place, withIntermediateDirectories: false)
    let other = place.appending(path: "other.txt")
    try Data("other".utf8).write(to: other)
    undo.undo()
    #expect(trash.names == ["Weirs"])
    #expect(try Data(contentsOf: other) == Data("other".utf8))
    #expect(!FileManager.default.fileExists(atPath: place.appending(path: Vault.entryFileName).path))
    #expect(list.note.stringValue.contains("could not be put back"))
    #expect(!undo.canRedo)
  }

  /// Two files added at once: one Undo sends both to the trash, Redo puts them back
  @Test func filesAddedTogetherGoInOneUndo() async throws {
    let v = try ListVault(empty: true)
    let trash = try TestTrash()
    let out = FileManager.default.temporaryDirectory.appending(path: "undo-out-\(UUID().uuidString)")
    defer {
      v.remove()
      trash.remove()
      try? FileManager.default.removeItem(at: out)
    }
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    let pdfs = [out.appending(path: "Weir survey.pdf"), out.appending(path: "Bay survey.pdf")]
    try makePDF(["Weir"]).write(to: pdfs[0])
    try makePDF(["Bay"]).write(to: pdfs[1])
    let (_, list) = try await v.openList()
    let undo = try undoing(v)
    list.trasher = trash.trasher
    await step(undo) { list.add(.files(pdfs)) }
    #expect(list.rows.count == 2 && undo.undoActionName == "Add to Resource")
    undo.undo()
    #expect(list.rows.isEmpty && trash.names == ["Bay survey", "Weir survey"])
    #expect(pdfs.allSatisfy { FileManager.default.fileExists(atPath: $0.path) }, "the files added from stay")
    #expect(undo.redoActionName == "Add to Resource")
    undo.redo()
    #expect(list.rows.map(\.title).sorted() == ["Bay survey", "Weir survey"] && trash.names.isEmpty)
    undo.undo()
    #expect(list.rows.isEmpty)
  }
}

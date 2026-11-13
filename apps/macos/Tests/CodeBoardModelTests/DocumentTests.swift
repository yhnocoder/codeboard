import Foundation
import Testing

@testable import CodeBoardModel

// An open board: saving by itself after a pause, flushing, taking in what another writer changed

@MainActor private func opened() throws -> (BoardDocument, URL) {
  let file = try scratch().appending(path: "board.json")
  try editSample().encoded().write(to: file)
  return (try BoardDocument(file: { file }), file)
}

private func n1(_ b: Board) -> Card? { b.card(CardID(rawValue: "n1")) }

@MainActor @Suite(.serialized) struct DocumentTests {
  @Test func itSavesAPauseAfterTheLastChangeAndNotBefore() async throws {
    let (doc, file) = try opened()
    let original = try Data(contentsOf: file)
    for i in 0..<4 {
      doc.edit("Move") { $0.move([.card(CardID(rawValue: "n1"))], dx: 1, dy: 0) }
      try await Task.sleep(for: .milliseconds(100))
      #expect(try Data(contentsOf: file) == original, "not while changes keep coming (\(i))")
    }
    try await Task.sleep(for: .milliseconds(600))
    #expect(try Data(contentsOf: file) == (try doc.board.encoded()))
    #expect(n1(try Board(decoding: Data(contentsOf: file), file: file))?.x == 54)
    #expect(!doc.isDirty)
  }

  @Test func flushWritesAtOnceAndOnlyWhatChanged() throws {
    let (doc, file) = try opened()
    let date = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date
    doc.flush()
    #expect(try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date == date)
    doc.edit("Lock") { $0.setLocked([.card(CardID(rawValue: "n1"))], true) }
    doc.flush()
    #expect(try Data(contentsOf: file) == (try doc.board.encoded()))
  }

  @Test func undoRedoAndTheSelectionTheyRestore() throws {
    let (doc, _) = try opened()
    let start = doc.board
    doc.select([.card(CardID(rawValue: "c1"))])
    doc.edit("Delete", selection: []) { $0.delete([.card(CardID(rawValue: "c1"))]) }
    #expect(doc.selection.isEmpty && doc.undoName == "Delete")
    doc.undo()
    #expect(doc.board == start && doc.selection == [.card(CardID(rawValue: "c1"))])
    #expect(doc.redoName == "Delete")
    doc.redo()
    #expect(doc.board.card(CardID(rawValue: "c1")) == nil && doc.selection.isEmpty)
  }

  @Test func itsOwnWriteIsNoChangeFromOutside() throws {
    let (doc, _) = try opened()
    var merges = 0
    let stop = doc.observe { if $0 == .merge { merges += 1 } }
    defer { stop() }
    doc.edit("Move") { $0.move([.card(CardID(rawValue: "n1"))], dx: 5, dy: 0) }
    doc.flush()
    doc.diskChanged()
    #expect(merges == 0 && doc.history.canUndo)
  }

  @Test func whatAnotherWriterChangedIsMergedInAndSaved() throws {
    let (doc, file) = try opened()
    doc.edit("Move") { $0.move([.card(CardID(rawValue: "n1"))], dx: 5, dy: 0) }
    doc.edit("Tilt") { $0.setTilted([CardID(rawValue: "t1")], true) }
    // another writer locks n1 and moves t1
    var theirs = editSample()
    theirs.setLocked([.card(CardID(rawValue: "n1"))], true)
    theirs.move([.card(CardID(rawValue: "t1"))], dx: 0, dy: 70)
    try theirs.encoded().write(to: file)
    var merges = 0
    let stop = doc.observe { if $0 == .merge { merges += 1 } }
    defer { stop() }
    doc.diskChanged()
    #expect(merges == 1)
    #expect(n1(doc.board)?.x == 55 && n1(doc.board)?.locked == true)
    #expect(doc.board.card(CardID(rawValue: "t1"))?.tilted == true && doc.board.card(CardID(rawValue: "t1"))?.y == 70)
    #expect(doc.history.undoSteps.map(\.name) == ["Move", "Tilt"], "neither step touched what the other writer did")
    doc.flush()
    #expect(try Board(decoding: Data(contentsOf: file), file: file) == doc.board)
    // undo still takes back only this app's steps
    doc.undo()
    doc.undo()
    #expect(n1(doc.board)?.x == 50 && n1(doc.board)?.locked == true)
  }

  @Test func aFileItCannotReadIsNeverWrittenOver() throws {
    let (doc, file) = try opened()
    doc.edit("Move") { $0.move([.card(CardID(rawValue: "n1"))], dx: 5, dy: 0) }
    let newer = Data(#"{"version": 3, "id": "b"}"#.utf8)
    try newer.write(to: file)
    doc.diskChanged()
    #expect(doc.problem?.contains("newer CodeBoard") == true)
    doc.flush()
    #expect(try Data(contentsOf: file) == newer)
    // readable again: merged and saved
    try editSample().encoded().write(to: file)
    doc.flush()
    let saved = try Board(decoding: Data(contentsOf: file), file: file)
    #expect(doc.problem == nil && n1(saved)?.x == 55)
  }
}

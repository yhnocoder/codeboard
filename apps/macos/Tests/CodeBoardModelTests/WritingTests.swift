import Foundation
import Testing

@testable import CodeBoardModel

// Notes, Texts and Boxes: written, sized, switched between Text and Box, made new and left empty

private func cid(_ s: String) -> CardID { CardID(rawValue: s) }
private func text(_ b: Board, _ id: String) -> TextCard? { b.card(cid(id))?.textCard }

@Test func writingSetsTheMarkdownAndWritingNothingDeletes() {
  var b = editSample()
  b.write(cid("n1"), text: "# New\n\nbody", layout: NoteLayout(wrap: [0]))
  #expect(b.card(cid("n1"))?.writing == "# New\n\nbody")
  b.write(cid("t1"), text: "Short", layout: nil)
  #expect(text(b, "t1")?.text == "Short")
  b.write(cid("t1"), text: "  \n ", layout: nil)
  #expect(b.card(cid("t1")) == nil && !b.arrows.contains { $0.to.card == cid("t1") }, "with what hangs on it")
}

@Test func aSizeKeepsTheTopLeftAndAWrappingTextsLineBreaks() {
  var b = editSample()
  b.setTextSize(cid("t1"), 30)
  #expect(text(b, "t1")?.fontSize == 30 && b.card(cid("t1"))?.width == 120, "not wrapping: its width follows the text")
  b.wrapText(cid("t1"), x: 1600, width: 150)
  b.setTextSize(cid("t1"), 40)
  #expect(b.card(cid("t1"))?.width == 200 && b.card(cid("t1"))?.x == 1600 && b.card(cid("t1"))?.y == 0)
  b.setTextSize(cid("t1"), 400)
  #expect(text(b, "t1")?.fontSize == 240)
}

@Test func aTextBecomesABoxWhereItWasMeasuredAndKeepsItsFill() {
  var b = editSample()
  b.setBoxFill(cid("t1"), .blue)
  #expect(text(b, "t1")?.fill == .yellow, "a Text has no fill to change")
  b.setTextLook(cid("t1"), .box, x: 1590, y: -6, width: nil)
  #expect(text(b, "t1")?.look == .box && b.card(cid("t1"))?.x == 1590 && b.card(cid("t1"))?.y == -6)
  b.setBoxFill(cid("t1"), .green)
  b.setTextLook(cid("t1"), .text, x: 1600, y: 0, width: nil)
  #expect(text(b, "t1")?.fill == .green, "the fill it takes again as a Box")
}

@MainActor @Test func aNewCardLeftEmptyGoesWithNoStepAndWrittenIsOneStep() throws {
  let file = try scratch().appending(path: "board.json")
  try editSample().encoded().write(to: file)
  let doc = try BoardDocument { file }
  let start = doc.board
  doc.select([.card(cid("n1"))])
  doc.addFresh(Board.newCard(.text(.text), id: cid("new"), x: 10, y: 20))
  #expect(doc.selection == [.card(cid("new"))] && !doc.history.canUndo)
  doc.settleWriting(keep: false, "New Text") { _ in }
  #expect(doc.board == start && !doc.history.canUndo)

  doc.addFresh(Board.newCard(.note, id: cid("new2"), x: 10, y: 20))
  doc.settleWriting(keep: true, "New Note") { $0.write(cid("new2"), text: "Hello", layout: nil) }
  #expect(doc.undoName == "New Note" && doc.history.undoSteps.count == 1)
  doc.undo()
  #expect(doc.board == start && doc.selection == [.card(cid("n1"))])
  doc.redo()
  #expect(doc.board.card(cid("new2"))?.writing == "Hello" && doc.board.card(cid("new2"))?.width == Board.newNoteWidth)
}

/// What is typed reaches the board and the disk as drafts with no undo step; the writing is one step from where it began;
/// a step taken meanwhile (the bar's text size) is taken without the drafts, so undoing it never brings one back
@MainActor @Test func draftsAreSavedWithNoStepAndTheWritingIsStillOneStep() throws {
  let file = try scratch().appending(path: "board.json")
  try editSample().encoded().write(to: file)
  let doc = try BoardDocument { file }
  let start = doc.board
  let t1 = cid("t1")
  let was = try #require(start.card(t1)?.writing)
  doc.beginWriting(t1)
  doc.draft { $0.write(t1, text: was + " now", layout: nil) }
  #expect(doc.board.card(t1)?.writing == was + " now" && !doc.history.canUndo)
  doc.flush()
  #expect(try Board(decoding: Data(contentsOf: file), file: file).card(t1)?.writing == was + " now", "on disk")

  doc.edit("Text Size") { $0.setTextSize(t1, 30) }
  #expect(doc.board.card(t1)?.writing == was + " now" && text(doc.board, "t1")?.fontSize == 30)
  doc.draft { $0.write(t1, text: was + " now and then", layout: nil) }
  doc.settleWriting(keep: true, "Edit Text") { $0.write(t1, text: was + " now and then!", layout: nil) }
  #expect(doc.history.undoSteps.map(\.name) == ["Text Size", "Edit Text"])
  doc.undo()
  #expect(doc.board.card(t1)?.writing == was && text(doc.board, "t1")?.fontSize == 30)
  doc.undo()
  #expect(doc.board == start, "the size undone, and no draft back")
  doc.redo()
  doc.redo()
  #expect(doc.board.card(t1)?.writing == was + " now and then!")

  // drafts taken back to what it was: no step
  let before = doc.board
  doc.beginWriting(t1)
  doc.draft { $0.write(t1, text: "something else", layout: nil) }
  doc.settleWriting(keep: true, "Edit Text") { $0.write(t1, text: was + " now and then!", layout: nil) }
  #expect(doc.board == before && doc.history.undoSteps.count == 2)
}

/// A draft never takes the card being written in off the board (a blank text would), and a merge while drafts are on the
/// board keeps the card and what the other writer did
@MainActor @Test func aDraftNeverDeletesTheCardAndAMergeMeanwhileKeepsBoth() throws {
  let file = try scratch().appending(path: "board.json")
  try editSample().encoded().write(to: file)
  let doc = try BoardDocument { file }
  let t1 = cid("t1")
  doc.beginWriting(t1)
  doc.draft { $0.write(t1, text: "  ", layout: nil) }
  #expect(doc.board.card(t1) != nil && doc.board.arrows.contains { $0.to.card == t1 })
  doc.draft { $0.write(t1, text: "typed", layout: nil) }
  // another writer moves it meanwhile
  var theirs = try Board(decoding: Data(contentsOf: file), file: file)
  theirs.move([.card(t1)], dx: 0, dy: 40)
  try theirs.encoded().write(to: file)
  doc.diskChanged()
  #expect(doc.board.card(t1)?.writing == "typed" && doc.board.card(t1)?.y == theirs.card(t1)?.y)
  doc.flush()
  let disk = try Board(decoding: Data(contentsOf: file), file: file)
  #expect(disk.card(t1)?.writing == "typed" && disk.brokenReference == nil)
  doc.settleWriting(keep: true, "Edit Text") { $0.write(t1, text: "typed!", layout: nil) }
  doc.undo()
  #expect(doc.board.card(t1)?.y == theirs.card(t1)?.y && doc.board.card(t1)?.writing == editSample().card(t1)?.writing)
}

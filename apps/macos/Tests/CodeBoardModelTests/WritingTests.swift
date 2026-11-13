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
  doc.settleFresh(keep: false, "New Text") { _ in }
  #expect(doc.board == start && !doc.history.canUndo)

  doc.addFresh(Board.newCard(.note, id: cid("new2"), x: 10, y: 20))
  doc.settleFresh(keep: true, "New Note") { $0.write(cid("new2"), text: "Hello", layout: nil) }
  #expect(doc.undoName == "New Note" && doc.history.undoSteps.count == 1)
  doc.undo()
  #expect(doc.board == start && doc.selection == [.card(cid("n1"))])
  doc.redo()
  #expect(doc.board.card(cid("new2"))?.writing == "Hello" && doc.board.card(cid("new2"))?.width == Board.newNoteWidth)
}

import AppKit
import CodeBoardModel
import CodeBoardNotes
import Testing

@testable import CodeBoardCanvas

// A task's box clicked checks or unchecks it (view.ts mdClick, toggleTask): on a Note at rest, in a sidenote in its
// popup, and in the editor while the Note is written in

private func taskBoard() -> Board {
  Board(
    id: BoardID(rawValue: "tasks"),
    cards: [
      Card(
        id: cid("n1"), x: 100, y: 100, width: 300,
        content: .own(CardContent(body: .note(Note(text: "# Todo\n\n- [ ] one\n- [x] two")))))
    ],
    sidenotes: [
      Sidenote(id: SidenoteID(rawValue: "s1"), anchor: .card(cid("n1")), body: .text(TextNote(text: "- [ ] side")))
    ])
}

@MainActor @Suite struct CanvasTaskTests {
  @Test func aTasksBoxOnANoteAtRestChecksIt() async throws {
    let r = try await Rig(taskBoard(), zoom: 1)
    defer { r.close() }
    let boxes = r.canvas.taskBoxes(cid("n1"))
    #expect(boxes.count == 2)
    let b = try #require(boxes.first)
    r.click(through: CGPoint(x: b.midX, y: b.midY))
    #expect(r.card("n1").writing == "# Todo\n\n- [x] one\n- [x] two")
    #expect(!r.canvas.isEditing, "a click on the box does not start writing")
    // one step, undone as one
    r.doc.undo()
    #expect(r.card("n1").writing == "# Todo\n\n- [ ] one\n- [x] two")
    // the second unchecks
    let b2 = boxes[1]
    r.click(through: CGPoint(x: b2.midX, y: b2.midY))
    #expect(r.card("n1").writing == "# Todo\n\n- [ ] one\n- [ ] two")
  }

  @Test func aTasksBoxInASidenoteChecksIt() async throws {
    let r = try await Rig(taskBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let pop = c.sidenotePop
    c.openPop(.spot(.card(cid("n1"))))
    await r.until("the popup") { c.popShown != nil && pop.size.height > 0 }
    let body = try #require(pop.slips.compactMap(\.body).first)
    let box = try #require(body.layout.taskBoxes.first)
    r.click(pop: pop.view, at: body.convert(CGPoint(x: box.midX, y: box.midY), to: pop.view))
    let side = r.doc.board.sidenotes.first { $0.id.rawValue == "s1" }
    guard case .text(let t)? = side?.body else { return #expect(Bool(false), "no text sidenote") }
    #expect(t.text == "- [x] side")
  }

  @Test func aTasksBoxWhileWritingChecksItAndKeepsTheCaret() async throws {
    let r = try await Rig(taskBoard(), zoom: 1)
    defer { r.close() }
    r.canvas.beginEditing(cid("n1"))
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let v = try #require(r.canvas.writerView)
    let caret = v.selection
    let box = try #require(v.core.layout.taskBoxes.first)
    r.click(in: v, at: CGPoint(x: box.midX * v.zoom, y: box.midY * v.zoom))
    #expect(v.source == "# Todo\n\n- [x] one\n- [x] two")
    #expect(v.selection == caret)
  }
}

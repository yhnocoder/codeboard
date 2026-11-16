import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// One board in two canvases (two windows on it): each canvas has a seat of its own at the board's one document, so
// what is done to the board is drawn in both while each keeps its own selection

@MainActor @Suite(.serialized) struct CanvasSeatTests {
  /// A second canvas over the rig's, showing the rig's document, drawn
  func second(_ r: Rig) async throws -> CanvasView {
    let c = CanvasView(frame: r.canvas.frame, notes: Rig.notes)
    // never the network, never the person's caches
    c.fetchPicture = { _ in nil }
    c.pictureCache = r.root.appending(path: "pictures")
    c.steppedClock = { r.time }
    r.canvas.superview!.addSubview(c)
    let at = VaultBoard(id: r.doc.board.id, title: "B", path: "\(r.doc.board.id.rawValue).board")
    try await c.show(r.doc, at: at, in: Vault(root: r.root), theme: .warmInk)
    await drawn(r, c)
    return c
  }

  /// Until both canvases show the document's board as it is now, the second given its frames too
  func drawn(_ r: Rig, _ c: CanvasView) async {
    await r.until("both drawn") {
      c.tick(at: r.next(1.0 / 60))
      return c.scene != nil && r.canvas.shownBoard == r.doc.board && c.shownBoard == r.doc.board
    }
  }

  func rect(_ c: CanvasView, _ id: String) -> CGRect? {
    c.index(of: .card(cid(id))).map { c.scene!.items[$0].rect }
  }

  @Test func twoCanvasesOnOneDocumentDrawWhatChangesInEitherAndKeepTheirOwnSelections() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = try await second(r)
    defer {
      c.leave()
      c.removeFromSuperview()
    }
    let a = try #require(r.canvas.document)
    let b = try #require(c.document)
    #expect(a !== b && a.document === r.doc && b.document === r.doc)

    // the rig's canvas came first: its selection is the document's; a selection in one leaves the other's
    a.select([.card(cid("n1"))])
    #expect(r.doc.selection == [.card(cid("n1"))] && b.selection.isEmpty)
    b.select([.card(cid("t1"))])
    #expect(a.selection == [.card(cid("n1"))] && b.selection == [.card(cid("t1"))])
    #expect(r.canvas.trace.selection.count == 1 && c.trace.selection.count == 1)
    #expect(r.canvas.trace.selection != c.trace.selection)

    // an edit through one is drawn in the other, and neither selection changes
    let was = try #require(rect(c, "n2"))
    a.edit("Move") { $0.move([.card(cid("n2"))], dx: 40, dy: 0) }
    await drawn(r, c)
    #expect(rect(c, "n2")?.minX == was.minX + 40)
    #expect(a.selection == [.card(cid("n1"))] && b.selection == [.card(cid("t1"))])

    // a card one selects deleted through the other: gone from both, and from that selection only
    b.edit("Delete") { $0.delete([.card(cid("n1"))]) }
    #expect(a.selection.isEmpty && b.selection == [.card(cid("t1"))])
    await drawn(r, c)
    #expect(rect(r.canvas, "n1") == nil && rect(c, "n1") == nil)
    // undone through the one that deleted it: back in both, that canvas's selection the step's
    b.undo()
    #expect(a.selection.isEmpty && b.selection == [.card(cid("t1"))])
    await drawn(r, c)
    #expect(rect(r.canvas, "n1") != nil && rect(c, "n1") != nil)

    // typed in a card through the first canvas's seat (the editor's path: beginWriting, drafts, settleWriting): on
    // the board at once, and drawn in the second when the writing ends with its text
    a.beginWriting(cid("t1"))
    a.draft { $0.write(cid("t1"), text: "Threads wait", layout: nil) }
    #expect(b.board.card(cid("t1"))?.textCard?.text == "Threads wait")
    a.settleWriting(keep: true, "Edit Text") { $0.write(cid("t1"), text: "Threads wait here", layout: nil) }
    await drawn(r, c)
    #expect(c.shownBoard?.card(cid("t1"))?.textCard?.text == "Threads wait here" && r.doc.undoName == "Edit Text")
    #expect(a.selection.isEmpty && b.selection == [.card(cid("t1"))])
  }

  @Test func whatIsTypedThroughOneCanvasIsDrawnInTheOtherAsItIsDraftedAndItsEndIsHeardThereWhenItAddsNothing()
    async throws
  {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = try await second(r)
    defer {
      c.leave()
      c.removeFromSuperview()
    }
    let a = try #require(r.canvas.document)
    let b = try #require(c.document)
    a.beginWriting(cid("t1"))
    a.draft { $0.write(cid("t1"), text: "Threads wait", layout: nil) }
    await r.until("the draft drawn in the other canvas") {
      c.tick(at: r.next(1.0 / 60))
      return c.shownBoard?.card(cid("t1"))?.textCard?.text == "Threads wait"
    }
    // ended with what its drafts put there: the board is as it was, the other seat still hears of the step
    var heard = 0
    let stop = b.observe { _ in heard += 1 }
    a.settleWriting(keep: true, "Edit Text") { $0.write(cid("t1"), text: "Threads wait", layout: nil) }
    stop()
    #expect(heard == 1 && b.undoName == "Edit Text")
  }

  @Test func writingInTheSecondCanvasEndsTheFirstsWritingKeptAsItsOwnStep() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = try await second(r)
    defer {
      c.leave()
      c.removeFromSuperview()
    }
    r.canvas.beginEditing(cid("t1"))
    await r.editorReady()
    await r.type("Later ")
    c.beginEditing(cid("n1"))
    #expect(!r.canvas.isEditing && c.isEditing)
    #expect(r.doc.undoName == "Edit Text" && r.doc.board.card(cid("t1"))?.writing?.contains("Later") == true)
    await c.endEditing()
    #expect(
      !c.isEditing && r.doc.undoName == "Edit Text" && r.doc.board.card(cid("t1"))?.writing?.contains("Later") == true)
  }
}

import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// What comes onto the board out of view is brought into it where main's does so and left where main's leaves it: cards
// added by addCards (Place on Board, a pasted link, Free code or picture) and cards pasted (putCards) are revealed, the
// zoom kept (camera.ts isVisible, fitTop); a new Note (newWriting), a Link List (newLinkList), ⌘D (duplicateSel) and an
// undo move no camera.

@MainActor @Suite(.serialized) struct CanvasRevealTests {
  static func board() -> Board {
    Board(
      id: BoardID(rawValue: "reveal"),
      cards: [
        Card(
          id: cid("c1"), x: 600, y: 200, width: 380, height: 200,
          content: .own(CardContent(body: .note(Note(text: "On the right"))))),
        Card(
          id: cid("edge"), x: 900, y: 500, width: 300, height: 120,
          content: .own(CardContent(body: .note(Note(text: "At the edge"))))),
      ],
      sidenotes: [
        Sidenote(id: SidenoteID(rawValue: "n"), anchor: .card(cid("c1")), body: .text(TextNote(text: "Placed")))
      ])
  }

  func rig() async throws -> (Rig, NSPasteboard) {
    let pb = NSPasteboard(name: NSPasteboard.Name("reveal-\(UUID().uuidString)"))
    pb.clearContents()
    let r = try await Rig(Self.board(), zoom: 1, pasteboard: pb)
    r.canvas.fetchPage = { _ in WebPage(title: "T", description: "", site: "") }
    return (r, pb)
  }

  /// Seen whole (its top, when taller than the view), as main's isVisible
  func seen(_ c: CanvasView, _ r: CGRect) -> Bool {
    let v = c.safeView
    return v.contains(
      CGRect(x: r.minX, y: r.minY, width: r.width, height: min(r.height, v.height)).insetBy(dx: 1, dy: 1))
  }

  func pasted(_ text: String, _ r: Rig, _ pb: NSPasteboard, at p: CGPoint) async throws -> CardID {
    pb.clearContents()
    pb.setString(text, forType: .string)
    r.canvas.mouseMoved(with: r.mouse(.mouseMoved, p))
    let before = Set(r.doc.board.cards.map(\.id))
    r.canvas.paste(nil)
    await r.until("pasted") { r.doc.board.cards.contains { !before.contains($0.id) } }
    await r.settle()
    await r.idle()
    return try #require(r.doc.board.cards.first { !before.contains($0.id) }?.id)
  }

  @Test func placeOnBoardBringsTheNewCardIntoView() async throws {
    let (r, _) = try await rig()
    defer { r.close() }
    let zoom = r.canvas.camera.zoom
    r.canvas.placeSidenote(SidenoteID(rawValue: "n"))
    let id = try #require(r.doc.selection.first?.card)
    await r.settle()
    await r.idle()
    #expect(seen(r.canvas, r.rect(id.rawValue)), "\(r.rect(id.rawValue)) in \(r.canvas.safeView)")
    #expect(r.canvas.camera.zoom == zoom)
  }

  @Test func pastedCodeAndLinksComeIntoViewANoteAndALinkListStay() async throws {
    let (r, pb) = try await rig()
    defer { r.close() }
    let c = r.canvas
    let corner = CGPoint(x: 1000, y: 640)
    // a Note goes where the pointer is, and the camera stays (newWriting)
    var still = c.camera
    let note = try await pasted("A thought, written down.", r, pb, at: corner)
    #expect(c.camera == still && !seen(c, r.rect(note.rawValue)))
    // a Link List stays too (newLinkList)
    let list = try await pasted("https://a.test/1\nhttps://b.test/2", r, pb, at: CGPoint(x: 1010, y: 1000))
    #expect(c.camera == still && !seen(c, r.rect(list.rawValue)))
    // Free code and a link are revealed (addCards)
    let code = try await pasted("import torch\n\ndef step(batch):\n    return run(batch)", r, pb, at: corner)
    #expect(c.camera != still && seen(c, r.rect(code.rawValue)), "\(r.rect(code.rawValue)) in \(c.safeView)")
    still = c.camera
    let v = c.safeView
    let web = try await pasted("https://site.test/post", r, pb, at: CGPoint(x: v.maxX - 20, y: v.maxY - 20))
    #expect(c.camera != still && seen(c, r.rect(web.rawValue)))
  }

  @Test func duplicateAndUndoMoveNoCameraAndPastedCardsAreRevealed() async throws {
    let (r, _) = try await rig()
    defer { r.close() }
    let c = r.canvas
    r.doc.select([.card(cid("edge"))])
    let still = c.camera
    c.duplicate(nil)
    await r.settle()
    await r.idle()
    let copy = try #require(r.doc.selection.first?.card)
    #expect(copy != cid("edge") && c.camera == still && !seen(c, r.rect(copy.rawValue)))
    // undone and done again: the camera stays
    r.doc.undo()
    await r.settle()
    r.doc.redo()
    await r.settle()
    await r.idle()
    #expect(c.camera == still)
    // ⌘C, then ⌘V with the pointer at the view's corner: the copy is brought into view (putCards)
    r.doc.select([.card(cid("edge"))])
    c.copy(nil)
    let v = c.safeView
    c.mouseMoved(with: r.mouse(.mouseMoved, CGPoint(x: v.maxX - 10, y: v.maxY - 10)))
    let before = Set(r.doc.board.cards.map(\.id))
    c.paste(nil)
    await r.settle()
    await r.idle()
    let pasted = try #require(r.doc.board.cards.first { !before.contains($0.id) }?.id)
    #expect(c.camera != still && seen(c, r.rect(pasted.rawValue)))
  }
}

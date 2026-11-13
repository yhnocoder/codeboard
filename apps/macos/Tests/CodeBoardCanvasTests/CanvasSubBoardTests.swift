import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas

/// Sub-board cards on the canvas: Turn into Board and New Board (⌘⇧B) with their name written in place, one undo step
@MainActor @Suite struct CanvasSubBoardTests {
  func note(_ id: String, x: Double, y: Double) -> Card {
    Card(
      id: cid(id), x: x, y: y, width: 240, height: 120,
      content: .own(CardContent(body: .note(Note(text: "# 步骤 \(id)")))))
  }

  @Test func selectedCardsTurnIntoABoardInThisFolderWithTheirNameWrittenInPlaceAsOneUndoStep() async throws {
    let board = Board(
      id: BoardID(rawValue: "here"),
      cards: [note("a", x: 100, y: 100), note("b", x: 420, y: 100), note("c", x: 900, y: 500)],
      arrows: [
        Arrow(id: ArrowID(rawValue: "ab"), from: Endpoint(card: cid("a")), to: Endpoint(card: cid("b"))),
        Arrow(id: ArrowID(rawValue: "ca"), from: Endpoint(card: cid("c")), to: Endpoint(card: cid("a"))),
      ])
    let r = try await Rig(board, zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let vault = Vault(root: r.root)
    r.doc.select([.card(cid("a")), .card(cid("b"))])
    c.turnIntoBoard(nil)
    let frame = try #require(
      r.doc.board.cards.first { if case .own(let x) = $0.content, case .board = x.body { true } else { false } })
    #expect(r.doc.board.cards.map(\.id) == [frame.id, cid("c")])
    #expect(r.doc.board.arrows.map { "\($0.from.card.rawValue)>\($0.to.card.rawValue)" } == ["c>\(frame.id.rawValue)"])
    #expect(r.doc.selection == [.card(frame.id)])
    // the new board beside this one, named after the first card's title
    let made = try #require(try vault.tree().boards.first { $0.id != board.id })
    #expect(made.title == "步骤" && made.path == "步骤.board")
    #expect(try vault.board(at: made.path).cards.map(\.id) == [cid("a"), cid("b")])
    // its name written over the card's head
    await r.until("the name's field") { c.inPlace != nil }
    let field = try #require(c.inPlace?.field)
    #expect(field.stringValue == "步骤")
    field.stringValue = "调度 Plan"
    c.endInPlace(commit: true)
    #expect(try vault.tree().boards.map(\.title).contains("调度 Plan"))
    #expect(try vault.board(at: "调度 Plan.board").id == made.id)
    // one step: undone, the cards are back where they were
    #expect(r.doc.history.undoSteps.map(\.name) == ["Turn into Board"])
    r.doc.undo()
    #expect(r.doc.board == board)
  }

  @Test func withNothingSelectedANewEmptyBoardsCardComesInTheMiddleOfTheView() async throws {
    let r = try await Rig(Board(id: BoardID(rawValue: "here"), cards: [note("a", x: 0, y: 0)]), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    r.doc.select([])
    c.turnIntoBoard(nil)
    let frame = try #require(r.doc.board.cards.last)
    guard case .own(let content) = frame.content, case .board(let s) = content.body, let child = s.board else {
      Issue.record("no sub-board card")
      return
    }
    let mid = c.currentCamera.board(CGPoint(x: c.bounds.midX, y: c.bounds.midY))
    #expect(abs(frame.x + frame.width / 2 - mid.x) <= 1 && abs(frame.y + (frame.height ?? 0) / 2 - mid.y) <= 1)
    let tree = try Vault(root: r.root).tree()
    #expect(tree.boards.first { $0.id == child }?.title == "New Board")
    await r.until("the name's field") { c.inPlace != nil }
    // Esc: the name it was given stays
    c.endInPlace(commit: false)
    #expect(try Vault(root: r.root).tree().boards.contains { $0.title == "New Board" })
    #expect(r.doc.history.undoSteps.map(\.name) == ["New Board"])
  }
}

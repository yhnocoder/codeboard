import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas

/// Sub-board cards on the canvas: Turn into Board (⌘⇧B) with its name written in place, one undo step; with no card
/// selected it makes nothing (ParityKeysTests)
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

  /// Into a sub-board and out (subboards.ts enterFrame, leaveBoard, boardShown; Crumbs.tsx): the card's name hidden
  /// and its copy flying to the breadcrumb while the board fades out; the shell asked once it has; the board entered
  /// fading in from 1.03 with the breadcrumb, its current crumb hidden until the name lands. Esc deselects first, then
  /// leaves: the name flies back, the board fades out growing, and the parent's card hides its name until it lands
  @Test func aSubBoardIsEnteredWithItsNameFlyingToTheBreadcrumbAndEscLeavesIt() async throws {
    let board = Board(id: BoardID(rawValue: "here"), cards: [note("a", x: 100, y: 100), note("c", x: 900, y: 500)])
    let r = try await Rig(board, zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let vault = Vault(root: r.root)
    r.doc.select([.card(cid("a"))])
    c.turnIntoBoard(nil)
    await r.until("the name's field") { c.inPlace != nil }
    c.endInPlace(commit: true)
    let frame = try #require(r.doc.board.cards.first { $0.id != cid("c") }?.id)
    let child = try #require(try vault.tree().boards.first { $0.id != board.id })
    await r.until("the card drawn") { c.index(of: .card(frame)) != nil }
    var entered: (BoardID, CardID, Camera)?
    c.onEnterBoard = { entered = ($0, $1, $2) }
    var left: [Int?] = []
    c.onLeaveBoard = { left.append($0) }
    r.doc.select([])
    let cam = c.currentCamera
    #expect(c.openSubBoard(frame))
    let box = try #require(c.index(of: .card(frame)).map { c.items[$0].box })
    #expect(box.mask != nil, "the card's name hidden while its copy flies")
    #expect(c.crumbsBar.stage.sublayers?.count == 1)
    #expect(c.world.opacity == 0 && c.world.animation(forKey: "opacity") != nil)
    #expect(entered == nil, "asked once the board has faded")
    await r.until("the shell asked") { entered != nil }
    #expect(entered?.0 == child.id && entered?.1 == frame && entered?.2 == cam)
    // the shell gives the crumbs at once; they show with the board entered
    c.crumbs = [CrumbShown(board: board.id, frame: frame, name: "Here")]
    #expect(c.crumbsBar.isHidden)
    let doc = try BoardDocument { vault.url(of: child.path).appending(path: Vault.boardFileName) }
    try await c.show(doc, at: child, in: vault, theme: .warmInk)
    #expect(!c.crumbsBar.isHidden && c.crumbsBar.parents.map(\.name) == ["Here"] && c.crumbsBar.current == child.title)
    #expect(c.crumbsBar.hidesCurrent, "the current crumb waits for the name")
    #expect(c.world.opacity == 1 && c.world.animation(forKey: "transform") != nil)
    await r.until("landed") { c.crumbsBar.move == nil }
    #expect(!c.crumbsBar.hidesCurrent && c.crumbsBar.stage.sublayers?.isEmpty != false)
    // Esc: a selection goes first, then back to the parent
    doc.select([.card(cid("a"))])
    r.key(53)
    #expect(doc.selection.isEmpty && left.isEmpty)
    r.key(53)
    #expect(c.crumbsBar.hidesCurrent && c.crumbsBar.stage.sublayers?.count == 1)
    #expect(c.world.opacity == 0)
    await r.until("the shell asked to leave") { !left.isEmpty }
    #expect(left == [0])
    c.crumbs = []
    c.arriving = cam
    try await c.show(r.doc, at: VaultBoard(id: board.id, title: "B", path: "here.board"), in: vault, theme: .warmInk)
    #expect(c.crumbsBar.isHidden && c.currentCamera == cam)
    let back = try #require(c.index(of: .card(frame)).map { c.items[$0].box })
    #expect(back.mask != nil, "its name hidden until the copy lands on it")
    await r.until("landed back") { c.crumbsBar.move == nil }
    #expect(back.mask == nil && c.crumbsBar.stage.sublayers?.isEmpty != false)
  }
}

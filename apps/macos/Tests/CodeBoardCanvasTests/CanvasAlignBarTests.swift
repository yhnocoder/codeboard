import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// The bar over two or more selected cards (canvas/Canvas.tsx AlignBar): over them in view points, gone while they are
// dragged; Create Section, Create Sub-board and ⋯, whose panel aligns and distributes them in one step (core layout.ts
// align, commands/sections.ts alignCards), each button acting on the release over it

@MainActor @Suite(.serialized) struct CanvasAlignBarTests {
  @Test func cardsLineUpOrSpreadAsMainsAlignAndLockedOnesCountButStay() {
    // core.test.ts "aligns left and distributes": a 10, b 30, c 100 spread out → 10, 55, 100
    var b = sample()
    let rs: [(id: CardID, rect: Rect)] = [
      (cid("n1"), Rect(x: 10, y: 0, width: 10, height: 10)), (cid("n2"), Rect(x: 30, y: 0, width: 10, height: 10)),
      (cid("t1"), Rect(x: 100, y: 0, width: 10, height: 10)),
    ]
    b.align(rs, .hdist)
    #expect(b.card(cid("n1"))!.x == 10 && b.card(cid("n2"))!.x == 55 && b.card(cid("t1"))!.x == 100)
    b.align(rs, .right)
    #expect(b.card(cid("n1"))!.x == 100 && b.card(cid("n2"))!.x == 100)
    // L1 is locked: it counts (the bottom is its), but stays
    let locked = b.card(cid("L1"))!
    b.align(
      [(cid("n1"), Rect(x: 0, y: 0, width: 10, height: 10)), (cid("L1"), Rect(x: 0, y: 500, width: 10, height: 40))],
      .bottom)
    #expect(b.card(cid("n1"))!.y == 530 && b.card(cid("L1"))!.y == locked.y)
  }

  @Test func twoCardsSelectedHaveTheBarOverThemWhosePanelAlignsThemInOneStep() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    r.doc.select([.card(cid("t1"))])
    await r.settle()
    #expect(c.alignBar.isHidden, "one card")
    r.doc.select([.card(cid("t1")), .card(cid("b1"))])
    await r.settle()
    let bar = try #require(c.alignBarFrame())
    #expect(!c.alignBar.isHidden)
    let u = r.rect("t1").union(r.rect("b1"))
    let top = c.camera.view(CGPoint(x: u.midX, y: u.minY))
    let bottom = c.camera.view(CGPoint(x: u.midX, y: u.maxY))
    #expect(abs(bar.midX - top.x) <= 0.5)
    #expect(bar.maxY == top.y - 12 || (top.y - 12 - 38 < 56 && bar.minY == bottom.y + 12), "\(bar) \(top) \(bottom)")
    // a button of the bar or its panel, as a board point
    func on(_ b: AlignBarButton) -> CGPoint {
      let f = c.alignBarFrame()!
      let (rs, at) =
        if case .align = b {
          (AlignBarLayout.more(AlignBarLayout.titleFont(c.theme)).buttons, c.alignMoreFrame(f).origin)
        } else {
          (AlignBarLayout.bar(AlignBarLayout.font(c.theme)).buttons, f.origin)
        }
      let k = rs.first { $0.0 == b }!.1
      return c.camera.board(CGPoint(x: at.x + k.midX, y: at.y + k.midY))
    }
    r.click(on(.more))
    #expect(c.alignMore && !c.alignMoreLayer.isHidden && r.doc.selection.count == 2)
    let steps = r.doc.history.undoSteps.count
    r.click(on(.align(.right)))
    #expect(r.card("b1").x == 540 && r.card("t1").x == 500, "right edges at t1's")
    #expect(r.doc.undoName == "Align" && r.doc.history.undoSteps.count == steps + 1)
    #expect(c.alignMore, "the panel stays")
    // Esc closes the panel, and only that
    r.key(53)
    #expect(!c.alignMore && r.doc.selection.count == 2)
    // pressed on a button, let go off it: nothing
    let sections = r.doc.board.sections.count
    r.send(r.mouse(.leftMouseDown, on(.section)))
    r.send(r.mouse(.leftMouseUp, CGPoint(x: u.midX, y: u.maxY + 300)))
    #expect(r.doc.board.sections.count == sections && r.doc.selection.count == 2)
    // dragged: no bar
    r.drag(r.centre("t1"), CGPoint(x: r.centre("t1").x + 200, y: r.centre("t1").y + 120)) {
      #expect(c.alignBar.isHidden, "while they are dragged")
    }
    await r.settle()
    #expect(!c.alignBar.isHidden)
    // Tidy Up: the two laid out as core's tidy does, one step (Canvas.tsx's bar, edit.ts tidyUp)
    let tidied = r.doc.history.undoSteps.count
    r.click(on(.tidy))
    await r.until("tidied") { r.doc.undoName == "Tidy Up" }
    #expect(r.doc.history.undoSteps.count == tidied + 1 && r.doc.selection.count == 2)
    await r.settle()
    // Create Section: a Section round them, the two in it
    r.click(on(.section))
    await r.settle()
    #expect(r.doc.board.sections.count == sections + 1)
    let made = r.doc.board.sections.last!.id
    #expect(r.doc.board.card(cid("t1"))?.section == made && r.doc.board.card(cid("b1"))?.section == made)
  }
}

import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// Alignment while dragging (interact.ts snapPace / snapMove, core layout.ts): slowed down, what is dragged lines up with
// the edges and middles of the other cards and the Sections within 6 points on screen, a dashed guide along what lines
// up; dragged fast it follows the pointer exactly, ⌘ held it never lines up, and held still it lines up after a moment.
// Resized by its right or bottom edge, a card's edge lines up with the others' edges, or its size takes one of theirs
// with "same width · 240" under it (layout.ts snapResize, interact.ts resizeDown)

@MainActor @Suite(.serialized) struct CanvasSnapTests {
  @Test func theLeftEdgeGoesToAnotherCardsWithItsGuide() {
    // core.test.ts "snaps the left edge to another card"
    let r = Snap.move(
      CGRect(x: 103, y: 300, width: 50, height: 50), to: [CGRect(x: 100, y: 0, width: 80, height: 80)], threshold: 6)
    #expect(r.d.dx == -3 && r.d.dy == 0)
    #expect(r.guides == [Guide(axis: .x, at: 100, from: 0, to: 350)])
    // too far: none (110's middle and right are within 6 of 140 and 180)
    let far = Snap.move(
      CGRect(x: 300, y: 300, width: 50, height: 50), to: [CGRect(x: 100, y: 0, width: 80, height: 80)], threshold: 6)
    #expect(far.d == .zero && far.guides.isEmpty)
  }

  @Test func aSlowDragLinesUpAFastOneDoesNotAndCommandNever() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    // t1 at x 500; b1 below it at x 500 too: dragging b1 left by 3 and down, slowly, its left edge goes back to 500
    let b = r.rect("b1")
    let from = CGPoint(x: b.midX, y: b.midY)
    func drag(dx: CGFloat, step: TimeInterval, _ flags: NSEvent.ModifierFlags = []) {
      r.send(r.mouse(.leftMouseDown, from, flags))
      for i in 1...10 {
        let k = CGFloat(i) / 10
        let e = NSEvent.mouseEvent(
          with: .leftMouseDragged, location: r.at(CGPoint(x: from.x + dx * k, y: from.y + 40 * k)),
          modifierFlags: flags,
          timestamp: r.next(step), windowNumber: r.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
          pressure: 1)!
        r.send(e)
      }
    }
    func drop() -> CGFloat {
      r.send(r.mouse(.leftMouseUp, CGPoint(x: from.x - 3, y: from.y + 40)))
      return r.card("b1").x
    }
    // slowly: 43 points in 10 moves of 50 ms, under 700 points a second
    drag(dx: -3, step: 0.05)
    #expect(c.guideLayer.path != nil, "a guide while it lines up")
    #expect(drop() == 500, "lined up with t1's left edge")
    #expect(c.guideLayer.path == nil, "no guide once let go")
    r.doc.undo()
    await r.settle()
    // fast: 10 moves of 4 ms
    drag(dx: -3, step: 0.004)
    #expect(c.guideLayer.path == nil)
    #expect(drop() == 497, "where the pointer took it")
    r.doc.undo()
    await r.settle()
    // ⌘ held: never
    drag(dx: -3, step: 0.05, .command)
    #expect(c.guideLayer.path == nil)
    #expect(drop() == 497)
  }

  @Test func aFastDragHeldStillLinesUpAfterAMoment() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let b = r.rect("b1")
    let from = CGPoint(x: b.midX, y: b.midY)
    r.send(r.mouse(.leftMouseDown, from))
    for i in 1...10 {
      let k = CGFloat(i) / 10
      r.send(
        NSEvent.mouseEvent(
          with: .leftMouseDragged, location: r.at(CGPoint(x: from.x - 3 * k, y: from.y + 40 * k)), modifierFlags: [],
          timestamp: r.next(0.004), windowNumber: r.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
          pressure: 1)!)
    }
    #expect(c.guideLayer.path == nil, "fast: not yet")
    await r.until("lined up once still") { c.guideLayer.path != nil }
    r.send(r.mouse(.leftMouseUp, CGPoint(x: from.x - 3, y: from.y + 40)))
    #expect(r.card("b1").x == 500)
  }

  @Test func aResizedEdgeGoesToAnotherCardsEdgeOrItsSize() {
    let o = [CGRect(x: 300, y: 0, width: 200, height: 100)]
    // the right edge 3 short of the other's left: there, with a guide down the edge
    let edge = Snap.resize(CGRect(x: 0, y: 0, width: 297, height: 50), right: true, bottom: false, to: o, threshold: 6)
    #expect(edge.size == CGSize(width: 300, height: 50) && edge.same == nil)
    #expect(edge.guides == [Guide(axis: .x, at: 300, from: 0, to: 50)])
    // 4 wider than the other: its width; the bottom 2 short of the other's height: that too, the width named first
    let same = Snap.resize(
      CGRect(x: 0, y: 200, width: 204, height: 98), right: true, bottom: true, to: o, threshold: 6)
    #expect(same.size == CGSize(width: 200, height: 100) && same.same == .x)
    // an edge not dragged stays
    let none = Snap.resize(CGRect(x: 0, y: 0, width: 297, height: 50), right: false, bottom: false, to: o, threshold: 6)
    #expect(none.size == CGSize(width: 297, height: 50) && none.guides.isEmpty)
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func aCardResizedLinesUpWithTheOthersUnlessCommandIsHeld(zoom: CGFloat) async throws {
    let r = try await Rig(zoom: zoom)
    defer { r.close() }
    let c = r.canvas
    r.click(CGPoint(x: 40, y: 40))
    // n1's corner to 244 × 180: n2's width, 240, named under it, and no guide
    r.drag(CGPoint(x: 240, y: 160), CGPoint(x: 244, y: 180)) {
      #expect(!c.sizeHint.isHidden, "the size it took, named")
      #expect(c.guideLayer.path == nil)
      #expect(c.gesture.flatMap { if case .resize(let z) = $0.kind { z.same } else { nil } } == "same width · 240")
    }
    #expect(r.card("n1").width == 240 && r.card("n1").height == 180)
    #expect(c.sizeHint.isHidden)
    await r.settle()
    // to 337 wide: its right edge on n2's, at 340, with a guide
    r.drag(CGPoint(x: 240, y: 180), CGPoint(x: 337, y: 180)) {
      #expect(c.guideLayer.path != nil, "a guide down the edge")
      #expect(c.sizeHint.isHidden)
    }
    #expect(r.card("n1").width == 340)
    #expect(c.guideLayer.path == nil, "none once let go")
    await r.settle()
    // ⌘ held: where the pointer took it
    r.drag(CGPoint(x: 340, y: 180), CGPoint(x: 337, y: 180), .command)
    #expect(r.card("n1").width == 337)
  }
}

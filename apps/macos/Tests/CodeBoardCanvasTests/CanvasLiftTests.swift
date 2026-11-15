import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// A card picked up by the pointer grows to 1.01 (Warm Ink) about 18 below its top left corner, a deeper shadow under
// it (--sh-lift), its selected look in its own layer going with it; let go, it lands back; the keys move without
// lifting (styles.css .card.lift / .landing, themes.css)

@MainActor @Suite(.serialized) struct CanvasLiftTests {
  func box(_ r: Rig, _ id: String) -> CALayer? { r.canvas.index(of: .card(cid(id))).map { r.canvas.items[$0].box } }

  @Test func aCardDraggedIsPickedUpWithItsRingAndLandsWhenLetGo() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    // (n2 lies over n1's middle)
    let from = CGPoint(x: 40, y: 40)
    r.send(r.mouse(.leftMouseDown, from))
    for i in 1...6 {
      r.send(r.mouse(.leftMouseDragged, CGPoint(x: from.x + CGFloat(i) * 12, y: from.y + CGFloat(i) * 5)))
    }
    let b = try #require(box(r, "n1"))
    #expect(CATransform3DEqualToTransform(b.transform, CanvasView.grown(b, tilt: 0, k: 1.01)), "grown to 1.01")
    // the point 18 below the top left corner stays where it was on the card
    let q = CGPoint(x: -b.bounds.width / 2, y: 18 - b.bounds.height / 2)
    let t = CATransform3DGetAffineTransform(b.transform)
    #expect(abs(q.applying(t).x - q.x) < 0.001 && abs(q.applying(t).y - q.y) < 0.001)
    #expect(b.animation(forKey: "lift") != nil && b.zPosition == 1)
    #expect(b.animationKeys() == ["lift"], "no implicit animation with it: \(b.animationKeys() ?? [])")
    let shadows = (b.sublayers ?? []).filter { $0.name == "lift" }
    #expect(shadows.map(\.shadowRadius) == [5, 30] && shadows.map(\.shadowOffset.height) == [4, 30])
    // its ring is in its layer: it moves and grows with it, never a frame behind
    #expect(c.selectedLooks[cid("n1")]?.allSatisfy { $0.superlayer === b } == true)
    r.send(r.mouse(.leftMouseUp, CGPoint(x: from.x + 72, y: from.y + 30)))
    let landed = try #require(box(r, "n1"))
    #expect(CATransform3DIsIdentity(landed.transform), "back to its size")
    #expect(landed.animation(forKey: "lift") != nil, "landing")
    #expect(landed.animationKeys() == ["lift"], "\(landed.animationKeys() ?? [])")
    await r.settle()
    // drawn again after the move: still landing in its new layer (when it is within the landing's time)
    if let again = box(r, "n1"), again !== landed, CACurrentMediaTime() - (c.landings[cid("n1")] ?? 0) < 0.4 {
      #expect(again.animation(forKey: "lift") != nil)
    }
    #expect(c.lifted.isEmpty)
  }

  /// Where a layer is drawn among the world's layers: the index of its ancestor there (later is over)
  func rank(_ r: Rig, _ l: CALayer) -> Int? {
    var a: CALayer? = l
    while let x = a, x.superlayer !== r.canvas.world { a = x.superlayer }
    return a.flatMap { x in r.canvas.world.sublayers?.firstIndex { $0 === x } }
  }

  /// A card or several picked up are over every card, Texts and Boxes too (unlike main, where the keep layer's stay
  /// over them: parity-decisions.md), under what floats over the board (the ports and handles; the toolbar, popups and
  /// panels are views over the canvas); once landed they are among the cards in the board's order again, as main. The
  /// change of layer comes when the landing has ended: where it is drawn then is where it ends, the frame it changes in
  /// and the one before alike
  @Test(arguments: [["n1"], ["n1", "n2"]])
  func cardsDraggedOverATextAreOverItUntilTheyHaveLanded(_ ids: [String]) async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    r.doc.select(Set(ids.map { .card(cid($0)) }))
    // by n1's header: a drag on the body of the one card selected selects its text
    let from = CGPoint(x: 40, y: 15)
    r.send(r.mouse(.leftMouseDown, from))
    for i in 1...8 { r.send(r.mouse(.leftMouseDragged, CGPoint(x: from.x + CGFloat(i) * 60, y: from.y))) }
    let t = try #require(box(r, "t1"))
    let boxes = try ids.map { try #require(box(r, $0)) }
    #expect(boxes[0].frame.intersects(t.frame), "over the Text")
    let top = c.world.sublayers?.firstIndex { $0 === c.chrome } ?? 0
    for (id, b) in zip(ids, boxes) {
      #expect((rank(r, b) ?? -1) > (rank(r, t) ?? .max), "\(id) is drawn over the Text while it is dragged")
      #expect((rank(r, b) ?? .max) < top, "\(id) under the ports and handles")
    }
    r.send(r.mouse(.leftMouseUp, CGPoint(x: from.x + 480, y: from.y)))
    for (id, b) in zip(ids, boxes) {
      #expect((rank(r, b) ?? -1) > (rank(r, t) ?? .max), "\(id) is over it while it lands")
    }
    // each frame until they are home: where each is drawn, and in which layer
    var last: [CALayer?] = boxes.map(\.superlayer)
    var before: [CGRect] = boxes.map { ($0.presentation() ?? $0).frame }
    let deadline = ContinuousClock.now + .seconds(20)
    while boxes.contains(where: { $0.superlayer !== c.cards }), ContinuousClock.now < deadline {
      r.tick()
      for (k, b) in boxes.enumerated() {
        let shown = (b.presentation() ?? b).frame
        if b.superlayer !== last[k] {
          // the frame it changes layer in: at the landing's end, as it was drawn in the frame before
          #expect(b.animation(forKey: "lift") == nil && CATransform3DIsIdentity(b.transform))
          #expect(abs(shown.minX - b.frame.minX) < 0.01 && abs(shown.width - b.frame.width) < 0.01)
          #expect(abs(before[k].minX - b.frame.minX) < 0.5 && abs(before[k].width - b.frame.width) < 0.5)
          last[k] = b.superlayer
        }
        before[k] = shown
      }
      try await Task.sleep(for: .milliseconds(4))
    }
    #expect(boxes.allSatisfy { $0.superlayer === c.cards }, "landed among the cards")
    // in the board's order: under the Text again, n2 over n1
    for b in boxes { #expect((rank(r, t) ?? -1) > (rank(r, b) ?? .max)) }
    if ids.count == 2 {
      let order = c.cards.sublayers ?? []
      #expect((order.firstIndex { $0 === boxes[1] } ?? -1) > (order.firstIndex { $0 === boxes[0] } ?? .max))
    }
  }

  @Test func theArrowKeysMoveACardWithoutPickingItUp() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.click(CGPoint(x: 40, y: 40))
    r.key(124, up: false)
    let b = try #require(box(r, "n1"))
    #expect(CATransform3DIsIdentity(b.transform) && b.animation(forKey: "lift") == nil)
    #expect(r.canvas.lifted.isEmpty)
    r.key(124)
  }
}

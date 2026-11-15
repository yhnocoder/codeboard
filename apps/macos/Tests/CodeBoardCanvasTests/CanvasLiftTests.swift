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

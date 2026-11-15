import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// A selected card's look in Warm Ink (themes.css :root.look-warm-ink .card > .cface::before): a 1.5 px line of the
// accent around the card, on its own squircle corner (the line hugs the card, no gap), over a 4 px blur of the accent at
// 20 % spread 3 px; sizes on the board, so they zoom with it (never thinner on screen than a pixel); it fades in over
// 120 ms growing from 98.5 %, and out over 90 ms. It is part of the card (in its layer, as main's is in .cface), so it
// moves, scales and tilts with it, and stays while the card is written in.

@MainActor @Suite(.serialized) struct CanvasSelectionLookTests {
  func ring(_ c: CanvasView) -> CAShapeLayer? {
    c.selectedLooks[cid("n1")]?.first { $0.name == "ring" } as? CAShapeLayer
  }
  func glow(_ c: CanvasView) -> CALayer? { c.selectedLooks[cid("n1")]?.first { $0.name == "glow" } }
  func box(_ c: CanvasView) -> CALayer? { c.index(of: .card(cid("n1"))).map { c.items[$0].box } }

  @Test func theRingHugsTheCardOnItsOwnCornerOverASoftGlow() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    r.doc.select([.card(cid("n1"))])
    c.drawChrome()
    let card = try #require(box(c)).bounds
    let l = try #require(ring(c))
    #expect(l.superlayer === box(c), "in the card's own layer")
    // the line's middle 0.75 out: its inner edge on the card's edge
    let want = Drawing.squircle(card.insetBy(dx: -0.75, dy: -0.75), c.theme.cardRadius + 0.75)
    #expect(l.path == want, "on the card's own squircle: \(String(describing: l.path?.boundingBox)) for \(card)")
    #expect(l.lineWidth == 1.5 && l.strokeColor == c.theme.accent && l.fillColor == nil)
    let g = try #require(glow(c))
    #expect(g.shadowPath == Drawing.squircle(card.insetBy(dx: -3, dy: -3), c.theme.cardRadius + 3), "spread 3")
    #expect(g.shadowRadius == 2 && g.shadowOffset == .zero, "a 4 px blur")
    #expect(g.shadowColor == c.theme.accent && abs(g.shadowOpacity - 0.2) < 0.001)
    // outside the card only, as a box shadow
    let mask = try #require(g.mask as? CAShapeLayer)
    #expect(
      mask.fillRule == .evenOdd && mask.path?.contains(CGPoint(x: card.midX, y: card.midY), using: .evenOdd) == false)
  }

  @Test(arguments: [0.5, 2.0] as [CGFloat])
  func theRingIsOnTheBoardSoItZoomsWithIt(_ zoom: CGFloat) async throws {
    let r = try await Rig(zoom: zoom)
    defer { r.close() }
    r.doc.select([.card(cid("n1"))])
    r.canvas.drawChrome()
    #expect(ring(r.canvas)?.lineWidth == 1.5, "1.5 on the board at \(zoom)")
  }

  /// Zoomed far out the line stays a pixel wide on screen, so what is selected still shows
  @Test func farOutTheRingIsNeverThinnerThanAPixel() async throws {
    let r = try await Rig(zoom: 0.1)
    defer { r.close() }
    let c = r.canvas
    c.place(zoom: 0.1, centre: CGPoint(x: 150, y: 100))
    r.doc.select([.card(cid("n1"))])
    c.drawChrome()
    let w = try #require(ring(c)?.lineWidth)
    #expect(abs(w * c.camera.zoom * c.backing - max(1, 1.5 * c.camera.zoom * c.backing)) < 0.001, "\(w)")
  }

  /// Written in, the card keeps its ring as main's does, in the paper's layer, without coming in again
  @Test func aCardBeingWrittenInKeepsItsRing() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    r.doubleClick(CGPoint(x: 40, y: 40))
    await r.editorReady()
    await r.until("its paper shown") { ring(c)?.superlayer === box(c) && c.editing?.ready == true }
    let l = try #require(ring(c))
    #expect(l.animation(forKey: "in") == nil || l.animation(forKey: "in")?.beginTime ?? 0 > 0, "not from the start")
    #expect(l.opacity == 1)
    r.press("\u{1b}")
    await r.until("left") { !c.isEditing }
    #expect(ring(c)?.superlayer === box(c) && ring(c)?.opacity == 1, "selected: the ring, in the card's layer")
  }

  @Test func theRingFadesInGrowingAndFadesOut() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    r.doc.select([.card(cid("n1"))])
    c.drawChrome()
    let l = try #require(ring(c))
    let fade = try #require(l.animation(forKey: "in") as? CAAnimationGroup)
    #expect(abs(fade.duration - 0.12) < 0.001)
    c.drawChrome()
    #expect(ring(c)?.animation(forKey: "in")?.beginTime == fade.beginTime, "it goes on coming in, not from the start")
    let shown = try #require(ring(c))
    r.doc.select([])
    c.drawChrome()
    #expect(ring(c) == nil)
    let gone = try #require(shown.animation(forKey: "out"))
    #expect(shown.opacity == 0 && shown.superlayer === box(c), "going out where it was")
    #expect(abs(gone.duration - 0.09) < 0.001)
  }

  /// Under the pointer a Text shows a dashed 1 point line of the faint ink 2 out (styles.css .card.text:hover), a Box a
  /// solid one of the accent at 45 % 3 out (.card.text.box:hover:not(.sel)), in the card's layer; a Note nothing, and
  /// a selected one only its selected look
  @Test func aTextOrBoxUnderThePointerShowsItsHoverLine() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    func hover(_ id: String) -> CAShapeLayer? {
      c.index(of: .card(cid(id))).flatMap { c.items[$0].box.sublayers?.first { $0.name == "hover" } as? CAShapeLayer }
    }
    c.mouseMoved(with: r.mouse(.mouseMoved, r.centre("t1")))
    let t = try #require(hover("t1"))
    let tb = c.items[try #require(c.index(of: .card(cid("t1"))))].box.bounds
    #expect(t.lineDashPattern?.isEmpty == false && t.lineWidth == 1 && t.strokeColor == c.theme.ink3)
    #expect(t.frame == tb.insetBy(dx: -2.5, dy: -2.5), "its line's middle 2.5 out: \(t.frame)")
    c.mouseMoved(with: r.mouse(.mouseMoved, r.centre("b1")))
    #expect(hover("t1") == nil, "gone when the pointer leaves")
    let b = try #require(hover("b1"))
    #expect(b.lineDashPattern == nil && b.strokeColor == c.theme.accent.copy(alpha: 0.45))
    #expect(b.frame == c.items[c.index(of: .card(cid("b1")))!].box.bounds.insetBy(dx: -3.5, dy: -3.5))
    c.mouseMoved(with: r.mouse(.mouseMoved, r.centre("n1")))
    #expect(hover("b1") == nil && hover("n1") == nil, "a Note has none")
    r.click(r.centre("t1"))
    #expect(hover("t1") == nil, "selected: its outline only")
  }
}

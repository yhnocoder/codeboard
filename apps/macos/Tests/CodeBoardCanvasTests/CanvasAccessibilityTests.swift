import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// The cards, Sections, sidenote markers and stickers as accessibility elements: found by their id, where they are
// drawn, also while dragged; one not drawn has none

extension Rig {
  /// The element with this identifier and where it is on the board (its screen frame taken back through the camera)
  func element(_ id: String) -> (NSAccessibilityElement, CGRect)? {
    guard
      let e = (canvas.accessibilityChildren() ?? []).compactMap({ $0 as? NSAccessibilityElement })
        .first(where: { $0.accessibilityIdentifier() == id })
    else { return nil }
    let v = canvas.convert(window.convertFromScreen(e.accessibilityFrame()), from: nil)
    let a = canvas.camera.board(CGPoint(x: v.minX, y: v.minY))
    let b = canvas.camera.board(CGPoint(x: v.maxX, y: v.maxY))
    return (e, CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y))
  }
}

@MainActor @Suite(.serialized) struct CanvasAccessibilityTests {
  func near(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) < 1 && abs(a.minY - b.minY) < 1 && abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func cardsAndSectionsAreElementsWhereTheyAreDrawn(zoom: CGFloat) async throws {
    let r = try await Rig(zoom: zoom)
    defer { r.close() }
    let (e, at) = try #require(r.element("n1"))
    #expect(near(at, r.rect("n1")), "\(at) for \(r.rect("n1"))")
    #expect(e.accessibilityRole() == .group && e.accessibilityRoleDescription() == "card")
    let (s, sat) = try #require(r.element("g1"))
    let frame = try #require(r.canvas.scene?.frames.first { $0.id == SectionID(rawValue: "g1") }?.rect)
    #expect(near(sat, frame), "\(sat) for \(frame)")
    #expect(s.accessibilityLabel() == "Group" && s.accessibilityRoleDescription() == "Section")
  }

  /// An arrow's label is an element under the arrow's id, where the label is drawn, also while its card is dragged; an
  /// arrow with no label has none
  @Test func anArrowsLabelIsAnElementWhereItIsDrawn() async throws {
    var b = sample()
    b.arrows[0].label = "calls"
    let r = try await Rig(b, zoom: 1)
    defer { r.close() }
    let (e, at) = try #require(r.element("a1"))
    let li = try #require(r.canvas.index(of: .arrowLabel(ArrowID(rawValue: "a1"))))
    let drawn = try #require(r.canvas.scene?.items[li].rect)
    #expect(near(at, drawn), "\(at) for \(drawn)")
    #expect(e.accessibilityRoleDescription() == "label" && e.accessibilityLabel() == "calls")
    // m1 (its other end) dragged: the label moves with its arrow, and so does its element
    r.drag(r.centre("m1"), CGPoint(x: r.centre("m1").x + 120, y: r.centre("m1").y)) {
      let now = r.element("a1")?.1 ?? .null
      #expect(abs(now.midX - at.midX) > 10, "mid-drag the element moved: \(now) from \(at)")
    }
    r.doc.edit("Label") { $0.arrows[0].label = nil }
    #expect(r.element("a1") == nil, "no label, no element")
  }

  @Test func aDraggedCardsElementIsWhereTheCardIsNow() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let from = r.rect("b1")
    r.drag(r.centre("b1"), CGPoint(x: r.centre("b1").x + 120, y: r.centre("b1").y + 40)) {
      let at = r.element("b1")?.1 ?? .null
      // picked up: grown about 18 below its top left corner as far as it has grown now
      let box = r.canvas.items[r.canvas.index(of: .card(cid("b1")))!].box
      let k = box.presentation()?.transform.m11 ?? 1
      let to = from.offsetBy(dx: 120, dy: 40)
      let want = CGRect(x: to.minX, y: to.minY + 18 * (1 - k), width: to.width * k, height: to.height * k)
      #expect(near(at, want), "mid-drag: \(at), from \(from)")
    }
  }

  /// A sidenote's marker is an element under the sidenote's id and a sticker one under its own, where each is drawn;
  /// one on a card folded away in its Section, or off the part of the card that shows, has none
  @Test(arguments: [0.5, 1] as [CGFloat])
  func sidenoteMarkersAndStickersAreElementsWhereTheyAreDrawn(zoom: CGFloat) async throws {
    var b = sidenoteBoard()
    b.stickers = [
      Sticker(id: StickerID(rawValue: "k1"), glyph: .builtin(.star), anchor: .canvas(x: 300, y: 700, size: nil)),
      Sticker(id: StickerID(rawValue: "k2"), glyph: .builtin(.flag), anchor: .card(cid("t1"), x: 10, y: 4, size: 20)),
      Sticker(id: StickerID(rawValue: "k3"), glyph: .builtin(.flag), anchor: .card(cid("t1"), x: 10, y: 900, size: 20)),
    ]
    let r = try await Rig(b, zoom: zoom)
    defer { r.close() }
    let c = r.canvas
    let (f, fat) = try #require(r.element("f1"))
    let free = try #require(c.marks.first { $0.notes == [SidenoteID(rawValue: "f1")] }?.frame)
    #expect(near(fat, free), "\(fat) for \(free)")
    #expect(f.accessibilityRoleDescription() == "sidenote")
    // both sidenotes on the Highlight share its marker
    let (_, l1) = try #require(r.element("l1"))
    let (_, l2) = try #require(r.element("l2"))
    #expect(near(l1, l2) && r.rect("c1").intersects(l1), "\(l1) \(l2)")
    for k in ["k1", "k2"] {
      let (e, at) = try #require(r.element(k))
      let drawn = try #require(c.stickerSpots.first { $0.id == StickerID(rawValue: k) }?.board)
      #expect(near(at, drawn), "\(k): \(at) for \(drawn)")
      #expect(e.accessibilityRoleDescription() == "sticker")
    }
    #expect(r.element("k3") == nil, "below the card's end, not drawn")
    #expect(r.element("w1") != nil && r.element("b1") != nil)
    r.doc.edit("Fold") { $0.sections[0].collapsed = true }
    await r.settle()
    #expect(r.element("w1") == nil && r.element("b1") == nil, "folded away with their card")
    #expect(r.element("f1") != nil)
  }
}

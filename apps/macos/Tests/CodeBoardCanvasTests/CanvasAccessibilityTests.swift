import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// The cards and Sections as accessibility elements: found by their id, where they are drawn, also while dragged

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

  @Test func aDraggedCardsElementIsWhereTheCardIsNow() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let from = r.rect("b1")
    r.drag(r.centre("b1"), CGPoint(x: r.centre("b1").x + 120, y: r.centre("b1").y + 40)) {
      let at = r.element("b1")?.1 ?? .null
      #expect(near(at, from.offsetBy(dx: 120, dy: 40)), "mid-drag: \(at), from \(from)")
    }
  }
}

import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// How a board opens with no camera to come back to (a new tab, the app started again, an imported board): at 100 %, what
// it holds with its top left corner 80 points in (main's homeCam, model.ts; a large board fitted whole opened at its
// summaries, or at a zoom too small to read)

private func gid(_ s: String) -> SectionID { SectionID(rawValue: s) }

private func note(_ id: String, x: Double, y: Double, section: String? = nil) -> Card {
  Card(
    id: cid(id), x: x, y: y, width: 360, height: 200, section: section.map(gid),
    content: .own(CardContent(body: .note(Note(text: "# \(id)\n\n每一步先看等待队列。")))))
}

/// `n` × `n` Notes 500 apart
private func grid(_ n: Int) -> [Card] {
  (0..<n * n).map { i in note("n\(i)", x: Double(i % n) * 500, y: Double(i / n) * 500) }
}

@MainActor @Suite(.serialized) struct CanvasOpeningTests {
  nonisolated static let boards: [(String, Board)] = [
    ("small", Board(id: BoardID(rawValue: "small"), cards: grid(2))),
    ("large", Board(id: BoardID(rawValue: "large"), cards: grid(8))),
    (
      "one Section",
      Board(
        id: BoardID(rawValue: "section"),
        cards: grid(5).map {
          var c = $0
          c.section = gid("s")
          return c
        },
        sections: [Section(id: gid("s"), title: "Scheduler", x: -60, y: -60, width: 2580, height: 2420)])
    ),
    // imported: drawn far from the board's origin
    (
      "far from the origin",
      Board(
        id: BoardID(rawValue: "far"),
        cards: grid(3).map {
          var c = $0
          c.x += 40_000
          c.y += 25_000
          return c
        })
    ),
    ("empty", Board(id: BoardID(rawValue: "empty"))),
  ]

  @Test(arguments: boards.indices) func aBoardOpensAt100PercentWithItsTopLeftCorner80In(_ i: Int) async throws {
    let (name, board) = Self.boards[i]
    let rig = try await Rig(board, zoom: nil)
    defer { rig.close() }
    let c = rig.canvas
    let cam = c.currentCamera
    #expect(cam.zoom == 1, "\(name): opens at \(cam.zoom)")
    // its top left corner (an empty board's origin) 80 points in
    let corner = try #require(c.scene).bounds
    let at = corner.isNull || corner.isEmpty ? CGPoint.zero : corner.origin
    let v = cam.view(at)
    #expect(abs(v.x - 80) < 0.5 && abs(v.y - 80) < 0.5, "\(name): its corner at \(v)")
    #expect(c.trace.level == "cards", "\(name): \(c.trace.level)")
    // and shows some of its cards
    if !board.cards.isEmpty {
      #expect(
        c.trace.cards.values.contains { r in c.bounds.intersects(CGRect(x: r[0], y: r[1], width: r[2], height: r[3])) })
    }
  }

  /// Zoomed out as far as it goes, the whole board fills about 77 % of the view (main summaryMinZoom: the fit ÷ 1.3)
  @Test func theFloorIsTheFitShrunk() async throws {
    let rig = try await Rig(Self.boards[1].1, zoom: nil)
    defer { rig.close() }
    let c = rig.canvas
    let b = try #require(c.scene).bounds
    let fit = min(c.bounds.width / b.width, c.bounds.height / b.height) * 0.96
    #expect(abs(c.limits.min - max(0.02, min(0.5, fit / 1.3))) < 0.002, "\(c.limits.min)")
  }
}

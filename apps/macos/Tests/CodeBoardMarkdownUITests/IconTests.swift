import CoreGraphics
import Testing

@testable import CodeBoardMarkdownUI

/// The web's icon paths read as outlines on their 16 grid
@Suite struct IconTests {
  @Test func everyIconReads() {
    for name in MarkdownIcons.paths.keys {
      let b = MarkdownIcons.path(name)!.boundingBoxOfPath
      #expect(b.minX >= 0.5 && b.maxX <= 15.5 && b.minY >= 0.5 && b.maxY <= 15.5, "\(name) \(b)")
      #expect(b.width > 0 || b.height > 0, "\(name)")
    }
    // the grid's frame, its corners rounded inside it
    let g = MarkdownIcons.path("grid")!.boundingBoxOfPath
    #expect(abs(g.minX - 2) < 0.01 && abs(g.maxX - 14) < 0.01 && abs(g.minY - 2) < 0.01 && abs(g.maxY - 14) < 0.01)
  }
}

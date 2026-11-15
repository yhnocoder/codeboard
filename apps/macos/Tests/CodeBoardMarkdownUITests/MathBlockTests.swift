import CodeBoardMarkdown
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// A formula block (editor/mathblock.ts): the caret opens it to its TeX with the formula under it, typing goes into the
/// TeX, leaving draws the formula alone again
@MainActor @Suite(.timeLimit(.minutes(1))) struct MathBlockTests {
  static let src = "Before\n\n$$\nx^2 + 1\n$$\n\nAfter"

  func core() throws -> EditorCore {
    _ = boardFonts
    let l = BlockLayout(
      MarkdownDocument(Self.src), width: 300, theme: testTheme, layout: nil,
      resources: LooksTests.NoResources(math: try MarkdownAssets.engines()))
    return EditorCore(layout: l, caret: 3)
  }

  @Test func arrowsOpenItAndTypingGoesIntoTheTeX() throws {
    let e = try core()
    let closed = e.layout.size.height
    // → from the end of "Before" goes into the TeX
    e.select(MDSelection(6))
    e.move(.character, forward: true, extend: false)
    #expect(e.selection == MDSelection(11))
    #expect(e.layout.size.height > closed)
    e.insert("y")
    #expect(e.source == "Before\n\n$$\nyx^2 + 1\n$$\n\nAfter")
    e.key(.enter)
    #expect(e.source == "Before\n\n$$\ny\nx^2 + 1\n$$\n\nAfter")
    // leaving: the formula alone again
    e.move(.document, forward: true, extend: false)
    #expect(e.layout.pieces.allSatisfy { $0.opened.isEmpty })
  }

  @Test func aClickOnTheFormulaOpensIt() throws {
    let e = try core()
    let frame = e.layout.blockFrames[1]
    e.mouseDown(at: CGPoint(x: frame.midX, y: frame.midY), clicks: 1, extend: false)
    e.mouseUp()
    #expect(e.selection == MDSelection(18))
    #expect(!e.layout.pieces[1].opened.isEmpty)
  }
}

import CodeBoardMarkdown
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The component's half of ⌘ block moves (guideline 6.4)
@Suite struct BlockMoveUITests {
  func core(_ src: String) -> EditorCore {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    return EditorCore(layout: l, caret: 0)
  }

  @Test func blocksAtAPointMarksAndMoves() {
    let e = core("One\n\nTwo\n\nThree")
    let f = e.layout.blockFrames
    #expect(e.blocks(at: CGPoint(x: 10, y: f[1].midY)) == 1..<2)
    // a selection over two blocks: both
    e.select(MDSelection(anchor: 1, head: 7))
    #expect(e.blocks(at: CGPoint(x: 10, y: f[0].midY)) == 0..<2)
    // taken away, the text closes up; dim keeps its room
    let h = e.layout.size.height
    e.mark(1..<2, .away)
    #expect(e.layout.size.height < h && e.layout.blockFrames[2].minY < f[2].minY)
    e.mark(1..<2, .dim)
    #expect(e.layout.size.height == h)
    e.mark(nil, .dim)
    #expect(e.dropIndex(at: CGPoint(x: 0, y: f[2].maxY + 5)).index == 3)
    #expect(e.dropIndex(at: CGPoint(x: 0, y: f[0].minY)).index == 0)
    #expect(e.move(0..<1, to: 3))
    #expect(e.source == "Two\n\nThree\n\nOne")
    e.undo()
    #expect(e.source == "One\n\nTwo\n\nThree")
    let cut = e.take(1..<2)
    #expect(cut?.source == "Two" && e.source == "One\n\nThree")
    let other = core("A\n\nB")
    #expect(other.put(cut!, at: 1))
    #expect(other.source == "A\n\nTwo\n\nB")
  }
}

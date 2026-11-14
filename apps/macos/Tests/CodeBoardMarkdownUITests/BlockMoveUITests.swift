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

/// After a move the other blocks slide to their new places (blockmove.ts's flip), the landed ones stay put
@MainActor @Suite struct BlockSlideTests {
  @Test func theOthersSlideAndSettle() {
    _ = boardFonts
    let l = BlockLayout(
      MarkdownDocument("One\n\nTwo\n\nThree"), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    let before = v.blockPlaces()
    #expect(v.core.move(0..<1, to: 3))
    // Two and Three moved up; One (landed at 2) is left to the host's copy
    v.slideBlocks(from: before, except: 2..<3)
    #expect(v.slidingBlocks == 2)
    let start = v.core.layout.drawOffsets
    #expect(start[0] == before[1].1 - v.blockPlaces()[0].1 && start[0]! > 0 && start[2] == nil)
    v.stepBlocks(at: MarkdownTiming.blockFlip / 2)
    #expect(v.core.layout.drawOffsets[0]! < start[0]! && v.core.layout.drawOffsets[0]! > 0)
    v.stepBlocks(at: MarkdownTiming.blockFlip)
    #expect(v.slidingBlocks == 0 && v.core.layout.drawOffsets.isEmpty)
  }

  @Test func theEaseIsBlockmovesCurve() {
    #expect(MarkdownTiming.ease(0) == 0 && abs(MarkdownTiming.ease(1) - 1) < 1e-9)
    // cubic-bezier(.2, .7, .3, 1) is well past half way at half the time
    let half = MarkdownTiming.ease(0.5)
    #expect(half > 0.85 && half < 0.95)
    #expect(MarkdownTiming.ease(0.25) < half)
  }
}

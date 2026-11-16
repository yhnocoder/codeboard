import MarkdownCore
import Testing

@testable import MarkdownDemoKit

/// ⌘ moves on the demo's own sample: its list mixing plain and task items (two lists on screen) once made every move
/// on the Note do nothing
@Suite struct SampleMoveTests {
  @Test func theSamplesBlocksMove() {
    let part = MarkdownSourceOps.Part(source: sample, layout: nil)
    #expect(MarkdownSourceOps.moveBlocks(part, 1..<2, to: 3) != nil)
  }
}

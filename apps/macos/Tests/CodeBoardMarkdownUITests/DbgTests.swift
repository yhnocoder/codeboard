import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

@Test func dbgGhost() {
  for s in ["Before\n\n", "Before\n\n\n\n", "\n\n## Title", "A\n\n\n\nB", "A\n\n\n\n\n\nB", "A\n\n\nB", "- a\n\n\n\nB"]
  {
    let d = MarkdownDocument(s)
    print(
      "DBG", s.debugDescription,
      d.blocks.map { "\($0.kind) \($0.range) \($0.inlineText.map { "\($0.offsets)" } ?? "nil")" },
      MarkdownSourceOps.blockStarts(s) as Any)
  }
}

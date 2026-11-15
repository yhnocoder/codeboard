import AppKit
import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

@MainActor @Suite(.timeLimit(.minutes(1))) struct MathHintViewTests {
  @Test func typingACommandListsItAndEnterWritesIt() throws {
    _ = boardFonts
    let src = "Sum $x$ here."
    let l = BlockLayout(
      MarkdownDocument(src), width: 300, theme: testTheme, layout: nil,
      resources: LooksTests.NoResources(math: try MarkdownAssets.engines()))
    let v = MarkdownEditorView(layout: l, caret: 6)
    v.selection = MDSelection(6)
    for ch in "+\\fr" { v.insertText(String(ch), replacementRange: NSRange(location: NSNotFound, length: 0)) }
    #expect(v.core.source == "Sum $x+\\fr$ here.")
    #expect(v.hints.shown && v.hints.items.first?.name == "frac")
    #expect(v.preview.isHidden)
    v.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    #expect(v.core.source == "Sum $x+\\frac{}{}$ here.")
    #expect(v.selection == MDSelection(13))
    #expect(!v.hints.shown)
    // Esc closes it for that command
    v.insertText("\\", replacementRange: NSRange(location: NSNotFound, length: 0))
    v.insertText("a", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(v.hints.shown)
    v.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
    #expect(!v.hints.shown)
    v.insertText("l", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(!v.hints.shown)
  }
}

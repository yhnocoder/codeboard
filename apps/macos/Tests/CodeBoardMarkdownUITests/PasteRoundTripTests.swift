import AppKit
import CodeBoardMarkdown
import Testing

@testable import CodeBoardMarkdownUI

/// A copy inside a Note pasted after its last line, as the acceptance driver does it (⌘C, then ⌘V from the menu): the
/// source comes back as it was, == marks and code lines too (the HTML copy beside it lost both)
@MainActor @Suite struct PasteRoundTripTests {
  static let src = "a ==hi== b\n\n```python\ndef step(batch):\n    return len(batch)\n```\n\nLast line."

  func view() -> (MarkdownEditorView, NSPasteboard) {
    _ = boardFonts
    let l = BlockLayout(
      MarkdownDocument(Self.src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    v.isEditing = true
    // a pasteboard of the test's own: the system clipboard is never touched
    v.pasteboard = NSPasteboard(name: NSPasteboard.Name("markdown-tests-\(UUID().uuidString)"))
    return (v, v.pasteboard)
  }

  func copyAndPasteAtEnd(_ v: MarkdownEditorView, _ r: NSRange) {
    v.selection = MDSelection(anchor: r.location, head: NSMaxRange(r))
    v.copy(nil)
    let end = (v.core.source as NSString).length
    v.selection = MDSelection(end)
    let item = NSMenuItem(title: "Paste", action: #selector(MarkdownEditorView.paste(_:)), keyEquivalent: "v")
    v.paste(item)
  }

  /// With no type of the host's, the source goes as Markdown's own
  @Test func theSourceGoesAsMarkdownsOwnTypeUnlessTheHostNamesOne() {
    #expect(MarkdownEditorView.sourceType.rawValue == "net.daringfireball.markdown")
  }

  @Test func highlightedTextKeepsItsMarks() {
    let (v, pb) = view()
    copyAndPasteAtEnd(v, (Self.src as NSString).range(of: "a ==hi== b"))
    #expect(pb.string(forType: MarkdownEditorView.sourceType) == "a ==hi== b")
    #expect(v.core.source.hasSuffix("Last line.a ==hi== b"))
    pb.releaseGlobally()
  }

  @Test func codeLinesKeepTheirLineBreaks() {
    let (v, pb) = view()
    copyAndPasteAtEnd(v, (Self.src as NSString).range(of: "def step(batch):\n    return len(batch)"))
    #expect(pb.string(forType: .html)?.hasPrefix("<pre><code>def step") == true)
    let tail = (v.core.source as NSString).substring(from: (Self.src as NSString).length)
    #expect(tail.contains("def step(batch):\n    return len(batch)"))
    // outside the code block, the lines are code again: a fenced block in their language
    #expect(tail.contains("```python\ndef step"))
    pb.releaseGlobally()
  }
}

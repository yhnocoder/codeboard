import AppKit
import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The selection's toolbar (editor/bubble.tsx)
@MainActor @Suite struct ToolbarTests {
  func view(_ src: String) -> MarkdownEditorView {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    return MarkdownEditorView(layout: l, caret: 0)
  }

  @Test func overTheFirstLineWithItsButtonsPressedAsTheSelectionIs() {
    let v = view("Some words to format here.")
    v.selection = MDSelection(anchor: 5, head: 10)
    v.placeToolbar()
    #expect(!v.toolbar.isHidden)
    #expect(v.toolbar.buttons.map(\.id) == ["bold", "italic", "strike", "highlight", "code", "link", "math", "annot"])
    let line = v.core.selectionRects[0]
    #expect(v.toolbar.frame.maxY <= line.minY || v.toolbar.frame.minY >= line.maxY)
    v.toolbarPress("bold")
    #expect(v.core.source == "Some **words** to format here.")
    v.placeToolbar()
    #expect(v.toolbar.buttons.first { $0.id == "bold" }?.on == true)
    v.toolbarPress("math")
    #expect(v.core.source == "Some **$words$** to format here.")
  }

  @Test func theStaticPictureOffersBoldAndHighlight() {
    let v = view("Some words to format here.")
    v.isEditing = false
    v.core.mouseDown(at: v.core.layout.caretRect(MDCaret(5))!.origin, clicks: 1, extend: false)
    v.core.mouseDragged(to: CGPoint(x: v.core.layout.caretRect(MDCaret(10))!.minX + 0.5, y: 8))
    v.core.mouseUp()
    v.placeToolbar()
    #expect(v.toolbar.buttons.map(\.id) == ["bold", "highlight"])
    v.toolbarPress("highlight")
    #expect(v.core.source.contains("==") && !v.isEditing && v.core.layout.head == nil)
  }
}

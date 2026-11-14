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

@MainActor @Suite struct HeadingChipTests {
  @Test func theChipShowsTheLevelLeftOfTheHeading() {
    _ = boardFonts
    let l = BlockLayout(
      MarkdownDocument("## Title\n\nBody"), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 5)
    v.selection = MDSelection(5)
    #expect(!v.headingChip.isHidden && v.headingChip.level == 2)
    #expect(v.headingChip.frame.maxX <= v.core.layout.caretRect(MDCaret(3))!.minX)
    v.headingChip.onPick(4)
    #expect(v.core.source == "#### Title\n\nBody")
    v.selection = MDSelection(14)
    #expect(v.headingChip.isHidden)
  }
}

@MainActor @Suite struct FindTests {
  @Test func findStepsAndReplaces() {
    _ = boardFonts
    let src = "one two One three one"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    v.findBar.query.stringValue = "one"
    v.refind(go: true)
    #expect(v.matches.count == 3 && v.selection.range == 0..<3)
    v.stepMatch(true)
    #expect(v.selection.range == 8..<11)
    v.findBar.caseSensitive = true
    v.refind(go: false)
    #expect(v.matches.count == 2)
    v.findBar.replacement.stringValue = "1"
    v.replaceMatch(all: true)
    #expect(v.core.source == "1 two One three 1")
    v.core.undo()
    #expect(v.core.source == src)
  }
}

@MainActor @Suite struct SourceModeTests {
  @Test func theWholeNoteAsItsSourceOneUndoStep() {
    _ = boardFonts
    let src = "# Title\n\nSome **bold** and `code`."
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 12)
    v.selection = MDSelection(12)
    v.toggleSourceMode()
    #expect(v.isSourceMode)
    // the caret where it was in the Markdown, every character a place (the #, the ** too)
    v.core.move(.document, forward: false, extend: false)
    v.core.insert("x")
    v.core.move(.character, forward: true, extend: false)
    v.core.insert("y")
    v.toggleSourceMode()
    #expect(!v.isSourceMode)
    #expect(v.core.source == "x#y Title\n\nSome **bold** and `code`.")
    v.core.undo()
    #expect(v.core.source == src)
  }
}

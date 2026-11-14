import AppKit
import CodeBoardMarkdown
import Testing

@testable import CodeBoardMarkdownUI

/// What the acceptance run on the editing chrome found, each as it drives it
@MainActor @Suite struct AcceptanceChromeTests {
  func view(_ src: String, caret: Int) -> MarkdownEditorView {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 400, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: caret)
    v.isEditing = true
    return v
  }

  /// the / menu longer than its panel scrolls inside it: nothing of its last rows is drawn below the panel
  @Test func theSlashMenusRowsStayInsideItsPanel() {
    let v = view("Text", caret: 4)
    v.insertText(" /", replacementRange: NSRange(location: NSNotFound, length: 0))
    let m = v.typedMenu
    #expect(m.shown && CGFloat(m.items.count) * 26 + 8 > m.frame.height)
    #expect(m.clipsToBounds)
  }

  /// a / menu opened on the Note's last line, with no room under it: above the line, inside the Note (the [[ menu ran
  /// off the window's bottom)
  @Test func aMenuNearTheBottomOpensAbove() {
    let v = view((1...20).map { "Line \($0)" }.joined(separator: "\n\n"), caret: 0)
    v.selection = MDSelection((v.core.source as NSString).length)
    v.insertText(" /", replacementRange: NSRange(location: NSNotFound, length: 0))
    let caret = v.core.caretRect!
    #expect(v.typedMenu.shown)
    #expect(v.typedMenu.frame.maxY <= caret.minY * v.zoom)
    #expect(v.typedMenu.frame.minY >= v.bounds.minY)
  }

  /// the toolbar over a selection on the last line: above it, 8 points off, as main places it; never where the pointer
  /// just pressed (a press on the line above went to the toolbar's Link and opened the link box)
  @Test func theToolbarSitsAboveTheSelectionAndAwayFromThePress() {
    let v = view("First line\n\nSecond line\n\nLast words here", caret: 0)
    let ns = v.core.source as NSString
    let r = ns.range(of: "words")
    v.selection = MDSelection(anchor: r.location, head: NSMaxRange(r))
    v.placeToolbar()
    let line = v.core.selectionRects[0]
    #expect(abs(v.toolbar.frame.maxY - (line.minY - 8)) < 0.5)
    // the press was where the toolbar would sit: it goes under the line instead
    v.lastPress = CGPoint(x: v.toolbar.frame.midX, y: v.toolbar.frame.midY)
    v.placeToolbar()
    #expect(abs(v.toolbar.frame.minY - (line.maxY + 8)) < 0.5)
    #expect(!v.toolbar.frame.contains(v.lastPress!))
  }

  /// on the first line, above would leave the Note: under it
  @Test func theToolbarFlipsUnderWhenAboveLeavesTheNote() {
    let v = view("Top words here\n\nmore\n\nand more\n\nand the end", caret: 0)
    v.selection = MDSelection(anchor: 4, head: 9)
    v.placeToolbar()
    #expect(v.toolbar.frame.minY > v.core.selectionRects[0].maxY)
  }

  /// an appearance switched while the selection toolbar is open: the toolbar takes the dark theme (it stayed white)
  @Test func anOpenToolbarTakesANewAppearance() {
    let v = view("Some words here", caret: 0)
    v.selection = MDSelection(anchor: 0, head: 4)
    v.placeToolbar()
    #expect(!v.toolbar.isHidden)
    let dark = MarkdownLooks.theme("warm-ink", dark: true)
    v.core.relayout(
      BlockLayout(v.core.document, width: 400, theme: dark, layout: nil, resources: TestResources()))
    #expect(v.toolbar.theme?.colors.surface == dark.colors.surface)
  }
}

/// A click in the space just below a code block, above a formula block: the gap's caret between them (it went into the
/// formula's source, the formula's slop taking the click)
@MainActor @Suite struct GapClickTests {
  @Test func aClickBelowACodeBlockAboveAFormulaIsTheGap() {
    _ = boardFonts
    let src = "Text\n\n```python\ndef f():\n    return 1\n```\n\n$$\nx^2\n$$\n\nAfter"
    let l = BlockLayout(MarkdownDocument(src), width: 400, theme: testTheme, layout: nil, resources: TestResources())
    let code = l.blockFrames[1]
    let math = l.blockFrames[2]
    for y in [code.maxY + 2, (code.maxY + math.minY) / 2, math.minY - 2] {
      let e = EditorCore(layout: l, caret: 0)
      e.mouseDown(at: CGPoint(x: 100, y: y), clicks: 1, extend: false)
      e.mouseUp()
      #expect(e.selection == MDSelection(41))
    }
  }
}

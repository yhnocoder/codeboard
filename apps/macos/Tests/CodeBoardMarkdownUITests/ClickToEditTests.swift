import AppKit
import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// A card is its static picture until clicked; when the markers show (editor/inline.ts on main): a click that starts
/// editing shows them at once (the editor gets focus with no button held), a click while editing waits
/// REVEAL_AFTER_CLICK (a key in that time shows them first and acts on that layout), keys show them at once
@MainActor @Suite struct ClickToEditTests {
  func view(_ src: String) -> MarkdownEditorView {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 320, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    v.isEditing = false
    return v
  }

  /// a point in the left half of the character at `q` in the static picture
  func point(_ v: MarkdownEditorView, _ q: Int) -> CGPoint {
    let r = v.core.layout.caretRect(MDCaret(q))!
    return CGPoint(x: r.minX + 1, y: r.midY)
  }

  @Test func aClickThatStartsEditingShowsTheMarkersAtOnce() {
    let v = view("Some ==marked== text and more.")
    #expect(v.core.layout.head == nil)
    let still = v.core.layout.blockFrames
    v.enter(at: point(v, 8))
    #expect(v.isEditing)
    #expect(v.selection == MDSelection(8))
    #expect(v.core.layout.head == 8)
    #expect(!v.core.revealPending)
    // nothing moved but the markers' own text: the block keeps its place and height
    #expect(v.core.layout.blockFrames == still)
    // leaving: the static picture again
    v.isEditing = false
    #expect(v.core.layout.head == nil)
  }

  @Test func aClickWhileEditingWaitsAndAKeyRevealsFirst() {
    let v = view("a **b** c")
    v.enter(at: point(v, 0))
    // a click before the bold (its markers hidden now, the caret away from it)
    v.core.mouseDown(at: point(v, 1), clicks: 1, extend: false)
    v.core.mouseUp()
    let q = v.selection.head
    #expect(v.core.revealPending)
    #expect(v.core.layout.head == 0)
    // → right away: the markers at the caret show first, then the caret moves on that layout
    v.revealFirst()
    #expect(v.core.layout.head == q)
    v.doCommand(by: #selector(NSResponder.moveRight(_:)))
    #expect(v.selection.head == q + 1)
  }

  @Test func aDoubleClickTakesTheWordWhereTheFirstPressPutTheCaret() {
    let v = view("one **two** three")
    v.enter(at: point(v, 1))
    let p = point(v, 15)
    v.core.mouseDown(at: p, clicks: 1, extend: false)
    v.core.mouseUp()
    v.core.mouseDown(at: p, clicks: 2, extend: false)
    v.core.mouseUp()
    #expect(v.selection.range == 12..<17)
  }

  @Test func aClickOnAFormulaInThePictureOpensIt() throws {
    _ = boardFonts
    let src = "Energy $E = mc^2$ here."
    let l = BlockLayout(
      MarkdownDocument(src), width: 320, theme: testTheme, layout: nil,
      resources: LooksTests.NoResources(math: try MarkdownAssets.engines()))
    let v = MarkdownEditorView(layout: l, caret: 0)
    v.isEditing = false
    let box = l.rects(forAtom: 7..<17)!
    v.enter(at: CGPoint(x: box.midX, y: box.midY))
    #expect(v.selection == MDSelection(16) && v.core.layout.head == 16)
  }
}

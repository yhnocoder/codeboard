import CodeBoardMarkdown
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// Typing, deleting, undo, input methods and the clipboard through the editor core's one apply path: the source is the
/// only truth, untouched bytes stay, the layout is the whole document laid out afresh after every edit
@Suite struct EditingTests {
  final class Clock: @unchecked Sendable { var t = 0.0 }

  func core(_ src: String, caret: Int? = nil) -> (EditorCore, Clock) {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let e = EditorCore(layout: l, caret: caret)
    let c = Clock()
    e.clock = { c.t }
    return (e, c)
  }

  func type(_ e: EditorCore, _ s: String) { for ch in s { e.insert(String(ch)) } }

  /// the layout kept up to date edit by edit is the document laid out afresh
  func check(_ e: EditorCore) {
    let fresh = MarkdownLayout.make(e.document, width: 300, theme: testTheme, layout: nil, resources: TestResources())
    #expect(e.layout.document == e.document)
    if e.layout.head == nil { #expect(BlockLayoutTests.same(e.layout.blockFrames, fresh.blockFrames)) }
  }

  @Test func typingWritesTheSourceAndNothingElse() {
    let src = "Some *text*  with   odd   spacing\n\n\n\nkept as it is"
    let (e, _) = core(src, caret: 4)
    type(e, " more")
    #expect(e.source == "Some more *text*  with   odd   spacing\n\n\n\nkept as it is")
    #expect(e.selection == MDSelection(9))
    check(e)
  }

  @Test func enterSplitsAndContinuesLists() {
    var (e, _) = core("Hello world", caret: 5)
    e.key(.enter)
    #expect(e.source == "Hello\n\n world")
    (e, _) = core("- one\n- two", caret: 11)
    e.key(.enter)
    #expect(e.source == "- one\n- two\n- ")
    // an empty item ends the list
    e.key(.enter)
    #expect(e.source == "- one\n- two\n")
    (e, _) = core("1. one", caret: 6)
    e.key(.enter)
    #expect(e.source == "1. one\n2. ")
    (e, _) = core("- [x] done", caret: 10)
    e.key(.enter)
    #expect(e.source == "- [x] done\n- [ ] ")
    (e, _) = core("> quoted", caret: 8)
    e.key(.enter)
    #expect(e.source == "> quoted\n>\n> ")
    (e, _) = core("```\n  x\n```", caret: 7)
    e.key(.enter)
    #expect(e.source == "```\n  x\n  \n```")
    check(e)
  }

  @Test func shiftEnterIsABreakExceptInAHeading() {
    var (e, _) = core("ab", caret: 1)
    e.key(.shiftEnter)
    #expect(e.source == "a<br>b")
    (e, _) = core("## ab", caret: 4)
    e.key(.shiftEnter)
    #expect(e.source == "## ab")
  }

  @Test func headingsSplitAndBackspaceMakesBodyText() {
    var (e, _) = core("## Title", caret: 5)
    e.key(.enter)
    #expect(e.source == "## Ti\n\ntle")
    (e, _) = core("## Title", caret: 3)
    e.key(.backspace)
    #expect(e.source == "Title")
    #expect(e.selection == MDSelection(0))
  }

  @Test func backspaceJoinsLiftsAndSelectsImages() {
    var (e, _) = core("one\n\ntwo", caret: 5)
    e.key(.backspace)
    #expect(e.source == "onetwo")
    #expect(e.selection == MDSelection(3))
    (e, _) = core("- item", caret: 2)
    e.key(.backspace)
    #expect(e.source == "item")
    (e, _) = core("> quote", caret: 2)
    e.key(.backspace)
    #expect(e.source == "quote")
    (e, _) = core("a ![x](p.png) b", caret: 13)
    e.key(.backspace)
    #expect(e.source == "a ![x](p.png) b")
    #expect(e.selection == MDSelection(anchor: 2, head: 13))
    e.key(.backspace)
    #expect(e.source == "a  b")
    (e, _) = core("a😀b", caret: 3)
    e.key(.backspace)
    #expect(e.source == "ab")
    (e, _) = core("one\n\ntwo", caret: 3)
    e.key(.delete)
    #expect(e.source == "onetwo")
    check(e)
  }

  @Test func typingIsOneUndoStepUntilAPauseOrAMove() {
    let (e, clock) = core("start", caret: 5)
    type(e, " abc")
    clock.t = 0.3
    type(e, "de")
    #expect(e.source == "start abcde")
    e.undo()
    #expect(e.source == "start")
    #expect(e.selection == MDSelection(5))
    e.redo()
    #expect(e.source == "start abcde")
    // a pause
    clock.t = 2
    type(e, "x")
    e.undo()
    #expect(e.source == "start abcde")
    // a move between
    type(e, "y")
    e.move(.character, forward: false, extend: false)
    e.move(.character, forward: true, extend: false)
    type(e, "z")
    e.undo()
    #expect(e.source == "start abcdey")
    e.undo()
    e.undo()
    #expect(e.source == "start")
    #expect(!e.canUndo)
    check(e)
  }

  @Test func undoTakesBackDeletesAndEnters() {
    let (e, _) = core("one two", caret: 7)
    e.key(.backspace)
    e.key(.backspace)
    e.key(.enter)
    #expect(e.source == "one t\n\n")
    e.undo()
    #expect(e.source == "one two")
    check(e)
  }

  @Test func anInputMethodsTextIsNeverInTheSource() {
    let (e, _) = core("前后", caret: 1)
    e.setMarked("zhong", selected: NSRange(location: 5, length: 0))
    #expect(e.source == "前后")
    #expect(e.layout.document.source == "前zhong后")
    let caretX = e.caretRect!.minX
    e.setMarked("中", selected: NSRange(location: 1, length: 0))
    #expect(e.source == "前后")
    #expect(e.caretRect!.minX < caretX)
    #expect(!e.markedRects.isEmpty)
    e.insert("中")
    #expect(e.source == "前中后")
    #expect(e.marked == nil)
    #expect(e.selection == MDSelection(2))
    e.undo()
    #expect(e.source == "前后")
    // given up: the layout shows the source again
    e.setMarked("ni", selected: NSRange(location: 2, length: 0))
    e.unmark()
    #expect(e.layout.document == e.document)
    // committed as something else
    e.setMarked("ni", selected: NSRange(location: 2, length: 0))
    e.insert("你")
    #expect(e.source == "前你后")
    check(e)
  }

  @Test func composingDoesNotMoveTheTextBeforeIt() {
    let src = "A **bold** word and then some more words to wrap the line somewhere along."
    let (e, _) = core(src, caret: 20)
    let before = e.rects(for: 0..<15)
    e.setMarked("pin", selected: NSRange(location: 3, length: 0))
    #expect(e.rects(for: 0..<15) == before)
    e.unmark()
  }

  @Test func copyCutPaste() {
    let (e, _) = core("## Title\n\nbody", caret: 3)
    e.selectParagraph()
    #expect(e.copy() == "## Title")
    e.select(MDSelection(anchor: 4, head: 6))
    #expect(e.copy() == "it")
    e.select(MDSelection(anchor: 10, head: 14))
    #expect(e.cut() == "body")
    #expect(e.source == "## Title\n\n")
    e.paste("see \\(x^2\\) and <mark>this</mark>")
    #expect(e.source == "## Title\n\nsee $x^2$ and ==this==")
    e.undo()
    #expect(e.source == "## Title\n\n")
    e.undo()
    #expect(e.source == "## Title\n\nbody")
    check(e)
  }
}

/// An empty paragraph after Enter at a paragraph's end or above a heading: the blank line its source keeps, read as an
/// empty paragraph (TipTap's createImplicitEmptyParagraphsFromSpace), the caret at its own line
@Suite struct EmptyParagraphTests {
  func core(_ src: String, caret: Int) -> EditorCore {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    return EditorCore(layout: l, caret: caret)
  }

  @Test func enterAtTheEndMakesALineToTypeOn() {
    let e = core("Before", caret: 6)
    let h0 = e.layout.size.height
    e.key(.enter)
    #expect(e.source == "Before\n\n")
    #expect(e.selection == MDSelection(8))
    #expect(true)
    // a line of its own under the paragraph, the caret on it
    let r = e.caretRect!
    #expect(r.minY > h0 && e.layout.size.height > h0)
    e.insert("#")
    e.insert(" ")
    e.insert("T")
    #expect(e.source == "Before\n\n# T")

    #expect(e.selection == MDSelection(11))
  }

  @Test func theEmptyParagraphIsAPlaceOfItsOwn() {
    let e = core("A\n\nB", caret: 1)
    let still = e.layout.blockFrames
    e.key(.enter)
    #expect(e.source == "A\n\n\n\nB")
    // between A and B a line of its own: B moved down
    #expect(e.layout.blockFrames.last!.minY > still.last!.minY)
    e.move(.character, forward: true, extend: false)
    #expect(e.selection == MDSelection(5))

    e.move(.character, forward: false, extend: false)
    #expect(e.selection == MDSelection(3))
    e.move(.character, forward: false, extend: false)
    #expect(e.selection == MDSelection(1))
    // up and down go through it
    e.moveVertically(down: true, extend: false)
    #expect(e.selection == MDSelection(3))
    // and on into B at the column it came from (A's end, B's end: one letter each)
    e.moveVertically(down: true, extend: false)
    #expect(e.selection == MDSelection(6))
  }

  @Test func backspaceAndDeleteTakeTheEmptyParagraph() {
    var e = core("A", caret: 1)
    e.key(.enter)
    e.key(.backspace)
    #expect(e.source == "A" && e.selection == MDSelection(1))
    e = core("A\n\nB", caret: 1)
    e.key(.enter)
    e.key(.delete)
    #expect(e.source == "A\n\nB" && e.selection == MDSelection(3))
  }

  @Test func enterAtAHeadingsStartPutsAnEmptyParagraphAbove() {
    let e = core("## Title", caret: 3)
    e.key(.enter)
    #expect(e.source == "\n\n## Title")
    #expect(e.selection == MDSelection(0))
    e.insert("x")
    #expect(e.source == "x\n\n## Title")
  }
}

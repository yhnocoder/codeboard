import Foundation
import Testing

@testable import CodeCore

/// The plain-text editing core, as the web side's code editor behaves (CodeMirror, cm/editor.ts, the default keymap).
/// Time is a clock the test steps, never the wall's
@Suite struct CodeEditorTests {
  final class Clock: @unchecked Sendable {
    var now = 100.0
  }

  func editor(_ text: String, _ sel: CodeSelection = CodeSelection(0)) -> (CodeEditor, Clock) {
    let c = Clock()
    return (CodeEditor(text: text, selection: sel, clock: { c.now }), c)
  }

  // MARK: undo

  @Test func typingWithinHalfASecondIsOneStepAndAPauseOrAMoveStartsAnother() {
    var (e, clock) = editor("")
    for ch in ["a", "b", "c"] {
      e.insert(ch)
      clock.now += 0.4
    }
    e.deleteBackward()
    clock.now += 0.6
    e.insert("d")
    clock.now += 0.1
    e.move(.character, forward: false, extend: false)
    e.insert("e")
    #expect(e.text == "abed")
    e.undo()
    #expect(e.text == "abd" && e.selection == CodeSelection(2))
    e.undo()
    #expect(e.text == "ab" && e.selection == CodeSelection(2))
    // typing and ⌫ next to it joined
    e.undo()
    #expect(e.text == "" && e.selection == CodeSelection(0) && !e.canUndo)
    e.redo()
    e.redo()
    #expect(e.text == "abd" && e.selection == CodeSelection(3))
  }

  @Test func typingAwayFromTheLastEditAndCommandsAreStepsOfTheirOwn() {
    var (e, _) = editor("x\ny", CodeSelection(1))
    e.insert("1")
    e.select(CodeSelection(4))
    e.insert("2")
    e.indentMore()
    e.insert("3")
    #expect(e.text == "x1\n    y23")
    e.undo()
    e.undo()
    #expect(e.text == "x1\ny2" && e.selection == CodeSelection(5))
    e.undo()
    #expect(e.text == "x1\ny")
    // a new edit drops what could be redone
    e.insert("!")
    #expect(!e.canRedo)
  }

  // MARK: the mouse

  @Test func oneTwoAndThreeClicks() {
    var (e, _) = editor("let x_1 = 等待(a)  \nnext")
    e.press(at: 5, clicks: 1, extend: false)
    #expect(e.selection == CodeSelection(5))
    e.press(at: 5, clicks: 2, extend: false)
    #expect(e.selection == CodeSelection(anchor: 4, head: 7))
    // CJK is word, the bracket another group, the run of spaces a third
    e.press(at: 11, clicks: 2, extend: false)
    #expect(e.selection == CodeSelection(anchor: 10, head: 12))
    e.press(at: 12, clicks: 2, extend: false, assoc: 1)
    #expect(e.selection == CodeSelection(anchor: 12, head: 13))
    e.press(at: 16, clicks: 2, extend: false)
    #expect(e.selection == CodeSelection(anchor: 15, head: 17))
    // the line and its line end; the last line has none
    e.press(at: 3, clicks: 3, extend: false)
    #expect(e.selection == CodeSelection(anchor: 0, head: 18))
    e.press(at: 19, clicks: 3, extend: false)
    #expect(e.selection == CodeSelection(anchor: 18, head: 22))
  }

  @Test func aDragGoesByThePressesUnitAndShiftExtends() {
    var (e, _) = editor("one two three\nfour")
    e.press(at: 5, clicks: 2, extend: false)
    e.drag(to: 10)
    #expect(e.selection == CodeSelection(anchor: 4, head: 13))
    // back past the press: the word pressed is kept, its end the anchor
    e.drag(to: 1)
    #expect(e.selection == CodeSelection(anchor: 7, head: 0))
    e.release()
    e.press(at: 2, clicks: 1, extend: false)
    e.drag(to: 16)
    #expect(e.selection == CodeSelection(anchor: 2, head: 16))
    e.release()
    e.press(at: 9, clicks: 1, extend: true)
    #expect(e.selection == CodeSelection(anchor: 2, head: 9))
    // a range over the anchor: from its start to its end
    e.press(at: 1, clicks: 2, extend: true)
    #expect(e.selection == CodeSelection(anchor: 0, head: 3))
  }

  // MARK: moving

  @Test func charactersAreClustersAndASelectionCollapsesFirst() {
    var (e, _) = editor("a👍🏽é\nb", CodeSelection(1))
    e.move(.character, forward: true, extend: false)
    #expect(e.selection == CodeSelection(5))
    e.move(.character, forward: true, extend: true)
    #expect(e.selection == CodeSelection(anchor: 5, head: 6))
    e.move(.character, forward: false, extend: false)
    #expect(e.selection == CodeSelection(5))
    // over a line end
    e.select(CodeSelection(6))
    e.move(.character, forward: true, extend: false)
    #expect(e.selection == CodeSelection(7))
  }

  @Test func groupsSkipWhiteSpaceAndLineEnds() {
    var (e, _) = editor("foo.bar  (x)\n  baz")
    var seen: [Int] = []
    for _ in 0..<7 {
      e.move(.group, forward: true, extend: false)
      seen.append(e.selection.head)
    }
    // the bracket stops before the line end; from it, the line end and the indent go with the word after
    #expect(seen == [3, 4, 7, 10, 11, 12, 18])
    e.move(.group, forward: false, extend: false)
    #expect(e.selection.head == 15)
    e.move(.group, forward: false, extend: false)
    #expect(e.selection.head == 11)
  }

  @Test func lineBoundariesGoToTheIndentFirst() {
    var (e, _) = editor("x\n    let a = 1", CodeSelection(10))
    e.move(.lineBoundary, forward: false, extend: false)
    #expect(e.selection.head == 6)
    e.move(.lineBoundary, forward: false, extend: false)
    #expect(e.selection.head == 2)
    e.move(.lineBoundary, forward: false, extend: true)
    #expect(e.selection == CodeSelection(anchor: 2, head: 6))
    e.move(.lineBoundary, forward: true, extend: false)
    #expect(e.selection.head == 15)
    e.move(.document, forward: false, extend: true)
    #expect(e.selection == CodeSelection(anchor: 15, head: 0))
  }

  @Test func upAndDownKeepTheColumnTheyStartedAt() {
    // a tab is four columns, as the rows are laid out
    var (e, _) = editor("abcdefgh\nab\n\tcdefg\nxyz", CodeSelection(6))
    e.move(.line, forward: true, extend: false)
    #expect(e.selection.head == 11)
    e.move(.line, forward: true, extend: false)
    #expect(e.selection.head == 15)
    e.move(.line, forward: true, extend: false)
    #expect(e.selection.head == 22)
    // the last line: its end, and the column is that of the end from there on (in the tab: past it, its nearer side)
    e.move(.line, forward: true, extend: false)
    #expect(e.selection.head == 22)
    e.move(.line, forward: false, extend: false)
    #expect(e.selection.head == 13)
    e.select(CodeSelection(3))
    e.move(.line, forward: false, extend: true)
    #expect(e.selection == CodeSelection(anchor: 3, head: 0))
    // a selection collapses without moving
    e.move(.line, forward: true, extend: false)
    #expect(e.selection == CodeSelection(3))
  }

  // MARK: lines

  @Test func linesMoveUpAndDownWithTheSelection() {
    var (e, _) = editor("a\nbb\ncc\nd", CodeSelection(anchor: 3, head: 6))
    e.moveLines(down: true)
    #expect(e.text == "a\nd\nbb\ncc" && e.selection == CodeSelection(anchor: 5, head: 8))
    e.moveLines(down: true)
    #expect(e.text == "a\nd\nbb\ncc")
    e.moveLines(down: false)
    e.moveLines(down: false)
    #expect(e.text == "bb\ncc\na\nd" && e.selection == CodeSelection(anchor: 1, head: 4))
    // a selection ending at a line's start leaves that line
    e.select(CodeSelection(anchor: 0, head: 3))
    e.moveLines(down: true)
    #expect(e.text == "cc\nbb\na\nd")
  }

  @Test func linesCopyWithTheSelectionInTheTopOrTheBottomCopy() {
    var (e, _) = editor("x\nab\ny", CodeSelection(3))
    e.copyLines(down: true)
    #expect(e.text == "x\nab\nab\ny" && e.selection == CodeSelection(6))
    e.copyLines(down: false)
    #expect(e.text == "x\nab\nab\nab\ny" && e.selection == CodeSelection(6))
    e.undo()
    e.undo()
    #expect(e.text == "x\nab\ny" && e.selection == CodeSelection(3))
  }

  @Test func deletingLinesPutsTheCaretOnTheNextOneAtItsColumn() {
    var (e, _) = editor("one\ntwo\nthree\nf", CodeSelection(6))
    e.deleteLines()
    #expect(e.text == "one\nthree\nf" && e.selection == CodeSelection(6))
    e.select(CodeSelection(1))
    e.deleteLines()
    #expect(e.text == "three\nf" && e.selection == CodeSelection(1))
    e.select(CodeSelection(7))
    e.deleteLines()
    #expect(e.text == "three" && e.selection == CodeSelection(5))
    e.deleteLines()
    #expect(e.text == "" && e.selection == CodeSelection(0))
  }

  @Test func indentMoreAndLessByAUnit() {
    var (e, _) = editor("a\n\n  b\nc", CodeSelection(anchor: 1, head: 7))
    e.indentMore()
    #expect(e.text == "    a\n    \n      b\nc" && e.selection == CodeSelection(anchor: 5, head: 19))
    e.indentLess()
    #expect(e.text == "a\n\n  b\nc" && e.selection == CodeSelection(anchor: 1, head: 7))
    // a unit of columns less: six to two, and a tab and two (six) to two spaces
    var (f, _) = editor("      x\n\t  y", CodeSelection(anchor: 0, head: 12))
    f.indentLess()
    #expect(f.text == "  x\n  y")
    #expect(f.undo() && f.text == "      x\n\t  y")
  }

  @Test func backspaceInTheIndentGoesBackToTheLastStop() {
    var (e, _) = editor("      x", CodeSelection(6))
    e.deleteBackward()
    #expect(e.text == "    x" && e.selection == CodeSelection(4))
    e.deleteBackward()
    #expect(e.text == "x" && e.selection == CodeSelection(0))
    var (t, _) = editor("\t\tx", CodeSelection(2))
    t.deleteBackward()
    #expect(t.text == "\tx")
    // past the indent a code point and what extends it: the skin tone first, then the face; a variation selector with
    // what it selects; at a line's start the line end; forward a whole cluster
    var (c, _) = editor("a\n  b👍🏽", CodeSelection(9))
    c.deleteBackward()
    #expect(c.text == "a\n  b👍")
    c.deleteBackward()
    #expect(c.text == "a\n  b")
    var (v, _) = editor("x❤️", CodeSelection(3))
    v.deleteBackward()
    #expect(v.text == "x")
    c.select(CodeSelection(2))
    c.deleteBackward()
    #expect(c.text == "a  b")
    c.select(CodeSelection(1))
    c.deleteForward()
    #expect(c.text == "a b" && c.selection == CodeSelection(1))
    var (f, _) = editor("b👍🏽", CodeSelection(1))
    f.deleteForward()
    #expect(f.text == "b")
  }

  @Test func theCodeRulesThroughTheEditor() {
    var (e, _) = editor("if x:", CodeSelection(5))
    e.newline()
    e.insert("y")
    #expect(e.text == "if x:\n    y")
    e.select(CodeSelection(anchor: 0, head: 11))
    e.lineComment = "#"
    e.toggleComment()
    #expect(e.text == "# if x:\n#     y")
    e.indent()
    #expect(e.text == "    # if x:\n    #     y")
    e.outdent()
    #expect(e.text == "# if x:\n#     y")
  }

  // MARK: input methods

  @Test func aCompositionIsOutsideTheTextUntilItIsCommitted() {
    var (e, clock) = editor("ab", CodeSelection(anchor: 1, head: 2))
    e.setMarked("n", selected: 1..<1)
    // the selection it replaces is gone; the composition is not in the text
    #expect(e.text == "a" && e.composition == .init(at: 1, text: "n", selected: 1..<1) && !e.canUndo)
    e.setMarked("ni", selected: 2..<2)
    e.setMarked("你", selected: 1..<1)
    clock.now += 0.2
    e.insert("你")
    #expect(e.text == "a你" && e.composition == nil && e.selection == CodeSelection(2))
    // the selection deleted and the commit are one typing step
    e.undo()
    #expect(e.text == "ab" && e.selection == CodeSelection(anchor: 1, head: 2))
  }

  @Test func aCompositionGivenUpWritesNothing() {
    var (e, _) = editor("x", CodeSelection(1))
    e.setMarked("zh", selected: 2..<2)
    e.cancelMarked()
    #expect(e.text == "x" && e.composition == nil && !e.canUndo)
    e.setMarked("a", selected: 1..<1)
    e.setMarked("", selected: 0..<0)
    #expect(e.composition == nil && e.text == "x")
  }

  @Test func findGoesOnFromTheSelectionAndRoundPastTheEnd() {
    var (e, _) = editor("Ab ab AB", CodeSelection(1))
    #expect(e.find("ab") && e.selection == CodeSelection(anchor: 3, head: 5))
    #expect(e.find("ab") && e.selection == CodeSelection(anchor: 6, head: 8))
    #expect(e.find("ab") && e.selection == CodeSelection(anchor: 0, head: 2))
    #expect(e.find("ab", forward: false) && e.selection == CodeSelection(anchor: 6, head: 8))
    #expect(e.find("ab", caseSensitive: true) && e.selection == CodeSelection(anchor: 3, head: 5))
    #expect(!e.find("zz") && e.selection == CodeSelection(anchor: 3, head: 5))
  }

  /// Replace takes the selected match and selects the next (CodeMirror's replaceNext); All takes every match, one step
  @Test func replaceTakesTheSelectedMatchAndAllTakeEveryOneAsOneStep() {
    var (e, _) = editor("Ab ab AB", CodeSelection(1))
    // not on a match: only the next one selected
    #expect(e.replaceMatch("ab", with: "x") && e.text == "Ab ab AB" && e.selection == CodeSelection(anchor: 3, head: 5))
    #expect(e.replaceMatch("ab", with: "x") && e.text == "Ab x AB" && e.selection == CodeSelection(anchor: 5, head: 7))
    #expect(!e.replaceMatch("ab", with: "x", caseSensitive: true) && e.text == "Ab x AB", "no lower-case ab")
    #expect(e.replaceAll("ab", with: "yz") == 2 && e.text == "yz x yz")
    #expect(e.replaceAll("AB", with: "q", caseSensitive: true) == 0)
    e.undo()
    #expect(e.text == "Ab x AB")
    e.undo()
    #expect(e.text == "Ab ab AB")
  }
}

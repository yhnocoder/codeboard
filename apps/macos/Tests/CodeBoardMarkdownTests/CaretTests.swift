import Foundation
import Testing

@testable import CodeBoardMarkdown

/// Where the caret goes and what it reveals, as editor/inline.ts has it: markers show with the caret anywhere in their
/// construct (its edges too), a hidden run of markers is crossed with the next character, a drawn atom is one character
@Suite struct CaretTests {
  /// every place ← → visit from the start to the end, and back
  func walk(_ src: String) -> (forward: [Int], back: [Int]) {
    let d = MarkdownDocument(src)
    var f = [MarkdownEditing.start(of: d)]
    while true {
      let n = MarkdownEditing.caretStep(from: f.last!, forward: true, in: d)
      if n == f.last! { break }
      f.append(n)
    }
    var b = [f.last!]
    while true {
      let n = MarkdownEditing.caretStep(from: b.last!, forward: false, in: d)
      if n == b.last! { break }
      b.append(n)
    }
    return (f, b)
  }

  @Test func markersShowAroundTheCaretAndAreWalkedThroughThere() {
    // a **b** c: from 1 the bold is away from the caret; at 2 (its edge) its markers show and the caret walks them
    let (f, b) = walk("a **b** c")
    #expect(f == [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    #expect(b == [9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
    let d = MarkdownDocument("a **b** c")
    #expect(MarkdownEditing.revealed(at: 1, in: d).isEmpty)
    #expect(MarkdownEditing.revealed(at: 2, in: d) == IndexSet([2, 3, 5, 6]))
    #expect(MarkdownEditing.revealed(at: 7, in: d) == IndexSet([2, 3, 5, 6]))
    #expect(MarkdownEditing.revealed(at: 8, in: d).isEmpty)
  }

  @Test func hiddenMarkersAreCrossedWithTheNextCharacter() {
    // with the layout held still (a selection being extended), the hidden ** is crossed with the b
    let d = MarkdownDocument("a **b** c")
    #expect(MarkdownEditing.caretStep(from: 2, forward: true, in: d, head: nil) == 5)
    #expect(MarkdownEditing.caretStep(from: 5, forward: true, in: d, head: nil) == 8)
    #expect(MarkdownEditing.caretStep(from: 8, forward: false, in: d, head: nil) == 7)
    #expect(MarkdownEditing.caretStep(from: 7, forward: false, in: d, head: nil) == 4)
    #expect(MarkdownEditing.caretStep(from: 4, forward: false, in: d, head: nil) == 1)
  }

  @Test func anImageIsOneStepFromBesideIt() {
    let src = "x ![alt](p.png) y"
    let d = MarkdownDocument(src)
    // beside it the image is drawn: one step over it
    #expect(MarkdownEditing.caretStep(from: 2, forward: true, in: d) == 15)
    #expect(MarkdownEditing.caretStep(from: 15, forward: false, in: d) == 2)
    // inside its source (typed into), it is open and walked through
    #expect(MarkdownEditing.caretStep(from: 4, forward: true, in: d) == 5)
  }

  @Test func aFormulaOpensWithTheCaretAtItsEdge() {
    let d = MarkdownDocument("a $x^2$ b")
    #expect(MarkdownEditing.caretStep(from: 1, forward: true, in: d) == 2)
    #expect(MarkdownEditing.caretStep(from: 2, forward: true, in: d) == 3)
    #expect(MarkdownEditing.revealed(at: 2, in: d) == IndexSet([2, 6]))
    // held still with the caret away, the formula is one character
    #expect(MarkdownEditing.caretStep(from: 2, forward: true, in: d, head: nil) == 7)
    #expect(MarkdownEditing.visible(MarkdownEditing.run(at: 0, in: d)!, head: nil).text == "a \u{FFFC} b")
  }

  @Test func theCaretNeverStandsInAHeadingsHashesOrAListMarker() {
    let d = MarkdownDocument("## Hi\n\n- one\n- two")
    #expect(MarkdownEditing.start(of: d) == 3)
    #expect(MarkdownEditing.snap(0, in: d) == 3)
    let (f, _) = walk("## Hi\n\n- one\n- two")
    // Hi, then one, then two: the end of a run steps to the next run's start
    #expect(f == [3, 4, 5, 9, 10, 11, 12, 15, 16, 17, 18])
  }

  @Test func codeAndCellsAreRunsToo() {
    let src = "```py\nx = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |"
    let d = MarkdownDocument(src)
    let runs = d.blocks.flatMap { MarkdownEditing.runs(of: $0, in: d) }
    let ns = src as NSString
    #expect(
      runs.map { ns.substring(with: NSRange(location: $0.first, length: $0.last - $0.first)) } == [
        "x = 1", "a", "b", "1", "2",
      ])
  }

  @Test func charactersAreWhole() {
    let src = "a😀b👍🏽c"
    let (f, b) = walk(src)
    #expect(f == [0, 1, 3, 4, 8, 9])
    #expect(b == f.reversed())
  }

  @Test func wordsAsTheSystemCutsThem() {
    let d = MarkdownDocument("hello, big world")
    #expect(MarkdownEditing.wordStep(from: 0, forward: true, in: d, head: 0) == 5)
    #expect(MarkdownEditing.wordStep(from: 5, forward: true, in: d, head: 5) == 10)
    #expect(MarkdownEditing.wordStep(from: 16, forward: false, in: d, head: 16) == 11)
    #expect(MarkdownEditing.word(at: 12, in: d, head: nil) == 11..<16)
    let zh = MarkdownDocument("我们今天去公园")
    let first = MarkdownEditing.wordStep(from: 0, forward: true, in: zh, head: 0)
    #expect(first > 0 && first < 7)
  }

  @Test func wordsCrossParagraphs() {
    let d = MarkdownDocument("one\n\ntwo three")
    #expect(MarkdownEditing.wordStep(from: 3, forward: true, in: d, head: 3) == 8)
    #expect(MarkdownEditing.wordStep(from: 5, forward: false, in: d, head: 5) == 0)
  }

  @Test func wordsLeaveHiddenMarkersOut() {
    // **bold**er: one word on screen
    let d = MarkdownDocument("x **bold**er y")
    #expect(MarkdownEditing.word(at: 5, in: d, head: nil) == 4..<12)
  }
}

import CodeBoardMarkdown
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// Keys and the mouse on the headless editor: where the caret goes, what gets selected, when markers show
@Suite struct EditorCoreTests {
  func core(_ src: String, caret: Int? = nil, width: CGFloat = 300) -> EditorCore {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: width, theme: testTheme, layout: nil, resources: TestResources())
    return EditorCore(layout: l, caret: caret)
  }

  @Test func arrowsWalkAndMarkersFollow() {
    let e = core("a **b** c", caret: 0)
    var seen: [Int] = []
    for _ in 0..<12 {
      seen.append(e.selection.head)
      e.move(.character, forward: true, extend: false)
    }
    #expect(seen.prefix(10) == [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    #expect(e.layout.head == 9)
    e.move(.document, forward: false, extend: false)
    #expect(e.selection == MDSelection(0))
  }

  @Test func shiftExtendsWithTheLayoutHeldStill() {
    let e = core("a **b** c", caret: 1)
    e.move(.character, forward: true, extend: true)
    e.move(.character, forward: true, extend: true)
    // the bold's markers stay hidden while selecting: the second step crosses ** with the b
    #expect(e.selection == MDSelection(anchor: 1, head: 5))
    #expect(e.layout.head == 1)
    #expect(e.caretRect == nil)
    #expect(!e.selectionRects.isEmpty)
    // → collapses to the selection's end and the markers there show
    e.move(.character, forward: true, extend: false)
    #expect(e.selection == MDSelection(5))
    #expect(e.layout.head == 5)
  }

  @Test func aClickShowsMarkersOnlyOnceSettled() {
    let src = "Some **bold** text"
    let e = core(src, caret: src.utf16.count)
    let at = e.layout.caretRect(MDCaret(8))!
    e.mouseDown(at: CGPoint(x: at.minX + 0.5, y: at.midY), clicks: 1, extend: false)
    e.mouseUp()
    #expect(e.selection == MDSelection(8))
    #expect(e.revealPending)
    #expect(e.layout.head == src.utf16.count)
    #expect(e.settle())
    #expect(e.layout.head == 8)
  }

  @Test func doubleAndTripleClicks() {
    let src = "alpha beta gamma\n\nsecond paragraph"
    let e = core(src)
    let r = e.layout.caretRect(MDCaret(8))!
    let p = CGPoint(x: r.minX + 1, y: r.midY)
    e.mouseDown(at: p, clicks: 2, extend: false)
    e.mouseUp()
    #expect(e.selection.range == 6..<10)
    e.mouseDown(at: p, clicks: 3, extend: false)
    e.mouseUp()
    #expect(e.selection.range == 0..<16)
    // a double-click then a drag extends by words
    e.mouseDown(at: p, clicks: 2, extend: false)
    let q = e.layout.caretRect(MDCaret(13))!
    e.mouseDragged(to: CGPoint(x: q.minX + 1, y: q.midY))
    e.mouseUp()
    #expect(e.selection.range == 6..<16)
    #expect(!e.revealPending)
  }

  @Test func dragSelectsBackwardsToo() {
    let src = "alpha beta gamma"
    let e = core(src)
    let a = e.layout.caretRect(MDCaret(10))!
    let b = e.layout.caretRect(MDCaret(2))!
    e.mouseDown(at: CGPoint(x: a.minX + 0.5, y: a.midY), clicks: 1, extend: false)
    e.mouseDragged(to: CGPoint(x: b.minX + 0.5, y: b.midY))
    e.mouseUp()
    #expect(e.selection == MDSelection(anchor: 10, head: 2))
    e.move(.character, forward: false, extend: false)
    #expect(e.selection == MDSelection(2))
  }

  @Test func upDownKeepTheirColumnThroughAShortLine() {
    let e = core("A long first paragraph line\n\nab\n\nAnother long paragraph line", caret: 20)
    let x0 = e.caretRect!.minX
    e.moveVertically(down: true, extend: false)
    #expect(e.selection.head == 31)
    e.moveVertically(down: true, extend: false)
    #expect(abs(e.caretRect!.minX - x0) < 8)
  }

  @Test func commandArrowsGoToLineEnds() {
    let src = "First line of a paragraph that wraps onto a second line and maybe a third one too."
    let e = core(src, caret: 3, width: 160)
    e.move(.line, forward: true, extend: false)
    #expect(e.upstream)
    let end = e.selection.head
    e.move(.line, forward: false, extend: false)
    #expect(e.selection.head == 0)
    e.move(.line, forward: true, extend: true)
    #expect(e.selection == MDSelection(anchor: 0, head: end))
    e.selectAll()
    #expect(e.selection.range == 0..<src.utf16.count)
  }
}

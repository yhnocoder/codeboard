import CodeBoardMarkdown
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The caret drawn where its offset is, clicks landing back on it, markers shown only in the block the caret is in
@Suite struct CaretGeometryTests {
  static let sample = """
    # Title with **bold**

    Body with **bold**, *em*, `code`, a [link](https://example.com) and ==hl==. 中文混排一段，看看折行是不是一样。

    - one item
    - two **items**

    | a | b |
    |---|---|
    | 1 | 2 |

    ```python
    x = f(y)
    y = 2
    ```
    """

  func layout(_ src: String, width: CGFloat = 300) -> BlockLayout {
    _ = boardFonts
    return BlockLayout(MarkdownDocument(src), width: width, theme: testTheme, layout: nil, resources: TestResources())
  }

  /// every caret place, walking right from the start
  func places(_ d: MarkdownDocument) -> [Int] {
    var out = [MarkdownEditing.start(of: d)]
    while true {
      let n = MarkdownEditing.caretStep(from: out.last!, forward: true, in: d)
      if n == out.last! { return out }
      out.append(n)
    }
  }

  @Test func aClickOnTheCaretLandsOnItsPlace() {
    let l = layout(Self.sample)
    for q in places(l.document) {
      l.setHead(q)
      guard let r = l.caretRect(MDCaret(q)) else {
        Issue.record("no caret at \(q)")
        continue
      }
      // just right of the caret line, in the middle of it: the left half of the character after it
      let hit = l.caret(at: CGPoint(x: r.minX + 0.5, y: r.midY))
      #expect(hit.offset == q, "at \(q)")
    }
  }

  @Test func theCaretMovesRightAlongALine() {
    let l = layout("Plain words on one line")
    var last = -CGFloat.infinity
    for q in places(l.document) {
      l.setHead(q)
      let x = l.caretRect(MDCaret(q))!.minX
      #expect(x > last)
      last = x
    }
  }

  @Test func markersShowInTheCaretsBlockOnlyAndGoWhenItLeaves() {
    let src = "A **bold** word.\n\nAnother **bold** one."
    let l = layout(src)
    let still = l.blockFrames
    let plain = l.caretRect(MDCaret(4))!.minX
    // the caret at the bold's edge: its ** show, the text after it moves right; the other paragraph keeps its look
    l.setHead(2)
    let open = l.caretRect(MDCaret(4))!.minX
    #expect(open > plain + 4)
    #expect(l.pieces[1].opened.isEmpty)
    l.setHead(nil)
    #expect(l.blockFrames == still)
    #expect(l.caretRect(MDCaret(4))!.minX == plain)
    // with the caret in the second paragraph, the first is the static one again
    l.setHead(src.utf16.count - 3)
    #expect(l.pieces[0].opened.isEmpty)
    #expect(l.caretRect(MDCaret(4))!.minX == plain)
  }

  @Test func theStaticPictureIsTheEditorWithTheCaretNowhere() {
    let d = MarkdownDocument(Self.sample)
    let l = layout(Self.sample)
    let fresh = MarkdownLayout.make(d, width: 300, theme: testTheme, layout: nil, resources: TestResources())
    for q in places(d).prefix(40) { l.setHead(q) }
    l.setHead(nil)
    #expect(BlockLayoutTests.same(l.blockFrames, fresh.blockFrames))
  }

  @Test func upAndDownKeepTheColumn() {
    let src = "First line of a paragraph that wraps onto a second line and maybe a third one too."
    let l = layout(src, width: 160)
    let start = MDCaret(6)
    let r0 = l.caretRect(start)!
    let down = l.vertical(start, x: r0.minX, down: true)
    let r1 = l.caretRect(down)!
    #expect(r1.minY > r0.maxY - 1)
    #expect(abs(r1.minX - r0.minX) < 8)
    let up = l.vertical(down, x: r0.minX, down: false)
    #expect(up.offset == 6)
    // from the last line down: the end; from the first up: the start
    #expect(l.vertical(MDCaret(src.utf16.count), x: 0, down: true).offset == src.utf16.count)
    #expect(l.vertical(MDCaret(3), x: 50, down: false).offset == 0)
  }

  @Test func downGoesIntoTheNextBlockAndCodeLines() {
    let l = layout("Para\n\n```\nab\ncd\n```")
    let a = l.vertical(MDCaret(2), x: l.caretRect(MDCaret(2))!.minX, down: true)
    #expect(a.offset >= 10 && a.offset <= 12)
    let b = l.vertical(a, x: l.caretRect(a)!.minX, down: true)
    #expect(b.offset >= 13 && b.offset <= 15)
  }

  @Test func lineEndsOfAWrappedParagraph() {
    let src = "First line of a paragraph that wraps onto a second line and maybe a third one too."
    let l = layout(src, width: 160)
    let end = l.lineBoundary(MDCaret(2), end: true)
    #expect(end.upstream)
    // shown at the end of the first line, not the start of the second
    #expect(l.caretRect(end)!.minY == l.caretRect(MDCaret(2))!.minY)
    let next = MDCaret(end.offset + 1)
    let start = l.lineBoundary(next, end: false)
    #expect(start.offset > end.offset)
    #expect(l.lineBoundary(MDCaret(5), end: false).offset == 0)
  }

  @Test func aSelectionCoversItsLines() {
    let src = "First line of a paragraph that wraps onto a second line and maybe a third one too."
    let l = layout(src, width: 160)
    let rects = l.selectionRects(3..<60)
    #expect(rects.count >= 2)
    #expect(rects.allSatisfy { $0.width > 0 })
    #expect(l.selectionRects(5..<5).isEmpty)
  }
}

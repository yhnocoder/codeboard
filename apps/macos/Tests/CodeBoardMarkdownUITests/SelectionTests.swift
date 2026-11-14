import CodeBoardMarkdown
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// Selecting in every kind of block, in the static picture and while editing
@MainActor @Suite struct SelectionTests {
  static let src = """
    Prose above the code.

    ```python
    def step(batch):
        return model(batch)
    ```

    | a | b |
    |---|---|
    | one | two |

    Prose below.
    """

  func view() -> MarkdownEditorView {
    _ = boardFonts
    let l = BlockLayout(
      MarkdownDocument(Self.src), width: 320, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    v.isEditing = false
    return v
  }

  func center(_ v: MarkdownEditorView, _ needle: String) -> CGPoint {
    let r = (Self.src as NSString).range(of: needle)
    let box = v.core.rects(for: r.location..<NSMaxRange(r)).first!
    return CGPoint(x: box.midX, y: box.midY)
  }

  @Test func aDragInTheStaticPictureSelectsWithoutEditingOrMoving() {
    let v = view()
    let frames = v.core.layout.blockFrames
    v.core.mouseDown(at: center(v, "Prose above"), clicks: 1, extend: false)
    v.core.mouseDragged(to: center(v, "Prose below"))
    v.core.mouseUp()
    #expect(!v.isEditing)
    #expect(v.core.layout.head == nil)
    #expect(v.core.layout.blockFrames == frames)
    let r = v.selection.range
    #expect(r.lowerBound < 10 && r.upperBound > (Self.src as NSString).range(of: "Prose below").location)
    // across prose, every code line and every cell
    let rects = v.core.selectionRects
    let code = (Self.src as NSString).range(of: "return model(batch)")
    let codeBox = v.core.rects(for: code.location..<NSMaxRange(code)).first!
    #expect(rects.contains { $0.intersects(codeBox) })
    let cell = (Self.src as NSString).range(of: "two")
    let cellBox = v.core.rects(for: cell.location..<NSMaxRange(cell)).first!
    #expect(rects.contains { $0.intersects(cellBox) })
    #expect(v.core.copy()?.contains("def step(batch):") == true)
    // a key on it starts editing with that selection
    v.isEditing = true
    #expect(v.selection.range == r)
  }

  @Test func inACodeBlockWordsLinesAndShiftArrows() {
    let v = view()
    v.isEditing = true
    let p = center(v, "model")
    v.core.mouseDown(at: p, clicks: 1, extend: false)
    v.core.mouseUp()
    v.core.mouseDown(at: p, clicks: 2, extend: false)
    v.core.mouseUp()
    let ns = Self.src as NSString
    let model = ns.range(of: "model")
    #expect(v.selection.range == model.location..<NSMaxRange(model))
    #expect(!v.core.selectionRects.isEmpty)
    v.core.mouseDown(at: p, clicks: 3, extend: false)
    v.core.mouseUp()
    // in code one line, as the web's code editor takes it
    let line = ns.range(of: "    return model(batch)")
    #expect(v.selection.range == line.location..<NSMaxRange(line))
    let body = ns.range(of: "def step(batch):\n    return model(batch)")
    v.core.select(MDSelection(body.location))
    for _ in 0..<5 { v.core.move(.character, forward: true, extend: true) }
    #expect(v.selection.range == body.location..<(body.location + 5))
    #expect(!v.core.selectionRects.isEmpty)
    v.core.selectAll()
    #expect(v.selection.range.count > 60)
  }

  @Test func leavingEditingDropsTheSelection() {
    let v = view()
    v.isEditing = true
    v.core.selectAll()
    v.isEditing = false
    #expect(v.selection.isEmpty && v.core.layout.head == nil)
  }
}

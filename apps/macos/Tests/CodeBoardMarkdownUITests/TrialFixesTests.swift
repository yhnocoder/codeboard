import AppKit
import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// What the first trial of the demo window found: the display switch, lists mixing task items, a click on a formula, a
/// formula's preview, a look switch keeping the undo history
@MainActor @Suite(.timeLimit(.minutes(1))) struct TrialFixesTests {
  func view(_ src: String, caret: Int? = nil, math: Bool = false) throws -> MarkdownEditorView {
    _ = boardFonts
    let resources: MarkdownResources =
      math ? LooksTests.NoResources(math: try MarkdownAssets.engines()) : TestResources()
    let l = BlockLayout(MarkdownDocument(src), width: 320, theme: testTheme, layout: nil, resources: resources)
    return MarkdownEditorView(layout: l, caret: caret)
  }

  @Test func displayIsTheEditorWithTheCaretNowhere() throws {
    let src = "Some **bold** and `code` here.\n\n- a list"
    let v = try view(src, caret: 8)
    let still = MarkdownLayout.make(
      MarkdownDocument(src), width: 320, theme: testTheme, layout: nil, resources: TestResources())
    #expect(v.core.layout.head == 8)
    #expect(!v.core.layout.pieces[0].opened.isEmpty)
    v.isEditing = false
    #expect(v.core.layout.head == nil)
    #expect(BlockLayoutTests.same(v.core.layout.blockFrames, still.blockFrames))
    #expect(v.core.layout.pieces.allSatisfy { $0.opened.isEmpty })
    // back to editing: the caret where it was, its markers again
    v.isEditing = true
    #expect(v.selection == MDSelection(8))
    #expect(v.core.layout.head == 8)
  }

  @Test func aListMixingTaskItemsIsTwoListsEachWithItsIndent() {
    _ = boardFonts
    let mixed = "- prefill first\n  - then **decode**\n- [x] blocks freed\n- [ ] swap back"
    let plain = "- prefill first\n  - then **decode**"
    let tasks = "- [x] blocks freed\n- [ ] swap back"
    func layout(_ s: String) -> MarkdownLayout {
      MarkdownLayout.make(MarkdownDocument(s), width: 320, theme: testTheme, layout: nil, resources: TestResources())
    }
    func texts(_ l: MarkdownLayout) -> [CGFloat] { l.caretTexts.map(\.frame.minX) }
    func boxes(_ l: MarkdownLayout) -> [CGFloat] {
      l.items.compactMap { if case .checkbox(let r, _, _) = $0 { r.minX } else { nil } }
    }
    func bullets(_ l: MarkdownLayout) -> [CGFloat] {
      l.items.compactMap { if case .bullet(let r, _, _) = $0 { r.midX } else { nil } }
    }
    let m = layout(mixed)
    // the bullet items' text and markers sit as in a list of bullets alone, the tasks as in a list of tasks alone
    #expect(Array(texts(m).prefix(2)) == texts(layout(plain)))
    #expect(bullets(m) == bullets(layout(plain)))
    #expect(boxes(m) == boxes(layout(tasks)))
    // every marker inside the column: nothing hangs left of the text's edge
    #expect(bullets(m).allSatisfy { $0 > 0 })
    #expect(boxes(m).allSatisfy { $0 >= 0 })
    // a bullet at 1.3em less 1em, the nested one a level further
    let em = CGFloat(testTheme.metrics.bodySize)
    #expect(abs(bullets(m)[0] - 0.3 * em) < 0.01)
    #expect(abs(bullets(m)[1] - bullets(m)[0] - 1.3 * em) < 0.01)
  }

  @Test func aDollarBeforeASpaceDoesNotCloseAFormula() {
    // mathAt: the closing $ follows a non-space; the web reads "$sss $" as text too
    let d = MarkdownDocument("a $sss $ b and $sss$ c")
    let atoms = d.blocks[0].inlines.filter { if case .atom(.math) = $0.kind { true } else { false } }
    #expect(atoms.map(\.range) == [15..<20])
  }

  @Test func aClickOnAFormulaOpensItsSourceAtOnce() throws {
    let src = "Energy $E = mc^2$ here."
    let v = try view(src, caret: src.utf16.count, math: true)
    let core = v.core
    let box = core.layout.rects(forAtom: 7..<17)
    #expect(box != nil)
    core.mouseDown(at: CGPoint(x: box!.midX, y: box!.midY), clicks: 1, extend: false)
    // the caret before the closing $, the source shown now, not after the click's settle
    #expect(core.selection == MDSelection(16))
    #expect(core.layout.head == 16)
    core.mouseUp()
  }

  @Test func theFormulaUnderTheCaretIsPreviewed() async throws {
    let src = "Energy $E = mc^2$ here."
    let v = try view(src, caret: 10, math: true)
    v.selection = MDSelection(10)
    for _ in 0..<200 where !v.preview.shown.picture { try await Task.sleep(for: .milliseconds(5)) }
    #expect(v.preview.shown.latex == "E = mc^2")
    #expect(v.preview.shown.picture && !v.preview.isHidden)
    // under the formula, not over the text
    let line = v.core.rects(for: 7..<17).first!
    #expect(v.preview.frame.minY >= line.maxY)
    // a TeX that does not typeset keeps the last picture, with the reason
    v.core.insert("\\frac{")
    v.selection = v.selection
    for _ in 0..<200 where v.preview.shown.error == nil { try await Task.sleep(for: .milliseconds(5)) }
    #expect(v.preview.shown.picture && v.preview.shown.error != nil)
    // away from the formula: gone
    v.selection = MDSelection(0)
    #expect(v.preview.isHidden)
  }

  @Test func aNewLayoutKeepsTheSelectionAndTheUndoHistory() throws {
    let v = try view("start", caret: 5)
    v.core.insert("x")
    let other = BlockLayout(v.core.document, width: 200, theme: testTheme, layout: nil, resources: TestResources())
    v.core.relayout(other)
    #expect(v.core.layout === other && v.selection == MDSelection(6))
    v.core.undo()
    #expect(v.core.source == "start")
  }
}

import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// Keys in a table (TipTap's goToNextCell, editor/tablecmds.ts): Tab, ⇧Tab, Enter, rows added and deleted
@Suite struct TableTests {
  static let src = "| a | b |\n|---|---|\n| 1 | 2 |"

  func core(_ caret: Int, _ src: String = TableTests.src) -> EditorCore {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let e = EditorCore(layout: l)
    e.select(MDSelection(caret))
    return e
  }

  func cell(_ e: EditorCore) -> (Int, Int)? {
    MarkdownEditing.tablePlace(at: e.selection.head, in: e.document).map { ($0.row, $0.column) }
  }

  @Test func tabWalksTheCellsAndAddsARowAfterTheLast() {
    let e = core(2)
    #expect(cell(e)! == (0, 0))
    e.key(.tab)
    #expect(cell(e)! == (0, 1))
    e.key(.tab)
    #expect(cell(e)! == (1, 0))
    e.key(.shiftTab)
    #expect(cell(e)! == (0, 1))
    e.key(.tab)
    e.key(.tab)
    e.key(.tab)
    #expect(e.source == Self.src + "\n|   |   |")
    #expect(cell(e)! == (2, 0))
    e.insert("x")
    #expect(e.source == Self.src + "\n|   x|   |")
  }

  @Test func enterGoesDown() {
    let e = core(2)
    e.key(.enter)
    #expect(cell(e)! == (1, 0))
    e.key(.enter)
    #expect(e.source == Self.src + "\n|   |   |")
    #expect(cell(e)! == (2, 0))
  }

  @Test func rowsAddedAndDeleted() {
    let e = core(22)
    #expect(cell(e)! == (1, 0))
    e.command(.addRow(below: true))
    #expect(e.source == Self.src + "\n|   |   |")
    #expect(cell(e)! == (1, 0))
    e.command(.addRow(below: false))
    #expect(e.source == "| a | b |\n|---|---|\n|   |   |\n| 1 | 2 |\n|   |   |")
    #expect(cell(e)! == (2, 0))
    e.command(.deleteRow)
    #expect(e.source == "| a | b |\n|---|---|\n|   |   |\n|   |   |")
    e.undo()
    e.undo()
    e.undo()
    #expect(e.source == Self.src)
    // under the header a row goes after the separator
    let h = core(2)
    h.command(.addRow(below: true))
    #expect(h.source == "| a | b |\n|---|---|\n|   |   |\n| 1 | 2 |")
    #expect(!h.command(.deleteRow))
  }
}

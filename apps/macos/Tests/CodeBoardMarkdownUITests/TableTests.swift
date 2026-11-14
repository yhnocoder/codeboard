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

@Suite struct TableColumnTests {
  func core(_ src: String, _ caret: Int) -> EditorCore {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let e = EditorCore(layout: l)
    e.select(MDSelection(caret))
    return e
  }

  @Test func columnsAddedDeletedAndAligned() {
    let src = "Before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter"
    let e = core(src, 10)
    e.command(.column(.add(after: true)))
    #expect(e.source == "Before\n\n| a |   | b |\n|---|---|---|\n| 1 |   | 2 |\n\nAfter")
    e.undo()
    e.command(.column(.add(after: false)))
    #expect(e.source == "Before\n\n|   | a | b |\n|---|---|---|\n|   | 1 | 2 |\n\nAfter")
    #expect(MarkdownEditing.tablePlace(at: e.selection.head, in: e.document)?.column == 1)
    e.undo()
    e.command(.column(.align(.center)))
    #expect(e.source == "Before\n\n| a | b |\n|:-:|---|\n| 1 | 2 |\n\nAfter")
    e.command(.column(.align(.right)))
    #expect(e.source == "Before\n\n| a | b |\n|--:|---|\n| 1 | 2 |\n\nAfter")
    e.command(.column(.align(.none)))
    #expect(e.source == src)
    e.command(.column(.delete))
    #expect(e.source == "Before\n\n| b |\n|---|\n| 2 |\n\nAfter")
    #expect(!e.command(.column(.delete)) || e.source.contains("|"))
  }
}

@MainActor @Suite struct TableBandTests {
  @Test func theBandShowsWithTheCaretInATable() {
    _ = boardFonts
    let src = "Before\n\n| a | b |\n|---|---|\n| 1 | 2 |"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 2)
    #expect(!v.band.shown)
    v.selection = MDSelection(30)
    #expect(v.band.shown && v.band.table != nil && v.band.block == nil)
    let header = v.core.rects(for: 10..<11).first!
    #expect(v.band.frame.maxY <= header.minY)
  }
}

@Suite struct TableMoveTests {
  func core(_ src: String, _ caret: Int) -> EditorCore {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let e = EditorCore(layout: l)
    e.select(MDSelection(caret))
    return e
  }

  @Test func rowsAndColumnsMove() {
    let src = "| a | b |\n|:--|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |"
    let e = core(src, 22)
    let s = MDEditState(source: e.source, selection: e.selection)
    let r = MarkdownEditing.tableMove(row: 1, to: 3, in: s, document: e.document)!
    e.apply(r)
    #expect(e.source == "| a | b |\n|:--|---|\n| 3 | 4 |\n| 5 | 6 |\n| 1 | 2 |")
    // the caret went with its cell
    #expect((e.source as NSString).substring(with: NSRange(location: e.selection.head, length: 1)) == "1")
    e.undo()
    #expect(e.source == src)
    let c = MarkdownEditing.tableMove(
      column: 0, to: 1, in: MDEditState(source: e.source, selection: e.selection), document: e.document)!
    e.apply(c)
    #expect(e.source == "| b | a |\n|---|:--|\n| 2 | 1 |\n| 4 | 3 |\n| 6 | 5 |")
  }
}

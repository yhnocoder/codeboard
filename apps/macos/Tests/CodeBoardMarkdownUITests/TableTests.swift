import AppKit
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

@MainActor @Suite struct TableDragTests {
  @Test func theDraggedRowLandsWhereThePointerIsAndTheOthersSlide() {
    _ = boardFonts
    let src = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    guard case .table(let t) = l.document.blocks[0].kind else { return }
    let cells = l.cellBoxes(of: t)
    #expect(cells.count == 4 && cells.allSatisfy { $0.count == 2 && $0.allSatisfy { $0.width > 0 } })
    let rows = cells.map { $0[0].union($0[1]) }
    // rows one under another
    #expect(zip(rows, rows.dropFirst()).allSatisfy { $0.maxY <= $1.minY + 1 })
    let pic = CGContext(
      data: nil, width: 10, height: 10, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      .makeImage()!
    let box = rows.dropFirst().reduce(rows[0]) { $0.union($1) }
    let d = TableDrag(axis: .row, from: 1, boxes: rows, table: box, picture: pic, start: rows[1].midY)
    d.move(to: rows[3].midY)
    #expect(d.to == 3)
    // the rows it passed slide up by its height, eased over TABLE_SLIDE
    #expect(d.tick(CACurrentMediaTime()))
    #expect(!d.tick(CACurrentMediaTime() + MarkdownTiming.tableSlide + 0.01))
    // never above the header
    d.move(to: rows[0].minY - 50)
    #expect(d.to == 1)
  }
}

@Suite struct TableSizeTests {
  @Test func columnWidthsAndRowHeightsGoIntoTheLayoutInfo() {
    _ = boardFonts
    let src = "Text\n\n| a | b |\n|---|---|\n| 1 | 2 |"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let e = EditorCore(layout: l)
    e.select(MDSelection(8))
    #expect(e.tableIndex(at: 8) == 0)
    guard case .table(let t) = e.document.blocks[1].kind else { return }
    let before = l.cellBoxes(of: t)[0][0].width
    var kept: MDLayoutInfo?
    e.onLayoutInfo = { kept = $0 }
    e.setTableSize(0, cols: [120, nil], rows: nil, done: false)
    #expect(kept == nil)
    #expect(abs(l.cellBoxes(of: t)[0][0].width - 120) < 1.5 && before != 120)
    e.setTableSize(0, cols: [120, nil], rows: [nil, 60], done: true)
    #expect(kept?.tables?.first??.cols == [120, nil] && kept?.tables?.first??.rows == [nil, 60])
    #expect(e.source == src)
    e.setTableSize(0, cols: nil, rows: nil, done: true)
    #expect(kept == nil && l.info == nil)
  }
}

@Suite struct LayoutInfoUndoTests {
  @Test func sizesAndWrapsAreUndoSteps() {
    _ = boardFonts
    let src = "| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nx\n```"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let e = EditorCore(layout: l)
    e.select(MDSelection(2))
    var kept: MDLayoutInfo? = MDLayoutInfo()
    e.onLayoutInfo = { kept = $0 }
    e.setTableSize(0, cols: [80, nil], rows: nil, done: false)
    e.setTableSize(0, cols: [90, nil], rows: nil, done: false)
    e.setTableSize(0, cols: [100, nil], rows: nil, done: true)
    e.setWrap(true, of: e.codeBlock(at: 33)!)
    #expect(kept?.wrap == [0] && kept?.tables?.first??.cols == [100, nil])
    e.undo()
    #expect(kept?.wrap == nil && kept?.tables?.first??.cols == [100, nil])
    // the whole drag is one step, back to no sizes at all
    e.undo()
    #expect(kept == nil && l.info == nil)
    e.redo()
    #expect(l.info?.tables?.first??.cols == [100, nil])
    #expect(e.source == src)
  }
}

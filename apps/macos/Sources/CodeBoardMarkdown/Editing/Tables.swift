import Foundation

/// Where a caret is in a table: the table block, its structure, and the row and column of the cell
public struct MDTablePlace: Sendable {
  public var block: Range<Int>
  public var table: MDTable
  public var row: Int
  public var column: Int
}

extension MarkdownEditing {
  /// The table cell a caret place is in
  public static func tablePlace(at offset: Int, in document: MarkdownDocument) -> MDTablePlace? {
    guard let bi = blockHolding(offset, in: document) else { return nil }
    var out: MDTablePlace?
    func walk(_ b: MDBlock) {
      switch b.kind {
      case .table(let t):
        for (r, row) in t.rows.enumerated() {
          for (c, cell) in row.enumerated()
          where cell.text.offsets.first! <= offset && offset <= cell.text.offsets.last! {
            out = MDTablePlace(block: b.range, table: t, row: r, column: c)
          }
        }
      case .quote(let children): for c in children { walk(c) }
      case .list(let l): for item in l.items { for c in item.children { walk(c) } }
      default: break
      }
    }
    walk(document.blocks[bi])
    return out
  }

  /// the source line of a table row (row 0 the header; the separator line is not a row)
  static func rowLine(_ t: MDTable, _ r: Int, _ ns: NSString) -> NSRange {
    let at = t.rows[r].first?.range.lowerBound ?? 0
    return ns.lineRange(for: NSRange(location: at, length: 0))
  }

  /// an empty row's source for a table of n columns
  static func emptyRow(_ n: Int) -> String {
    "|" + Array(repeating: "   ", count: max(1, n)).joined(separator: "|") + "|"
  }

  /// the place of a cell's text start after an edit made `row` the given line (its first cell two units in)
  static func cellStart(_ t: MDTable, _ r: Int, _ c: Int) -> Int {
    t.rows[r][min(c, t.rows[r].count - 1)].text.offsets.first!
  }

  /// Tab / ⇧Tab in a table: the next or previous cell (row after row); Tab in the last cell adds a row. Enter: the cell
  /// below, a new row under the last (TipTap's goToNextCell, editor/tablecmds.ts cellDown)
  static func tableKey(_ key: MDKey, _ state: MDEditState, _ d: MarkdownDocument) -> MDEdit? {
    let q = state.selection.head
    guard let p = tablePlace(at: q, in: d) else { return nil }
    let t = p.table
    let ns = state.source as NSString
    let cols = t.rows.map(\.count).max() ?? 1
    func go(_ r: Int, _ c: Int) -> MDEdit {
      MDEdit(range: q..<q, replacement: "", selection: MDSelection(cellStart(t, r, c)), undo: .command)
    }
    func addRowAtEnd() -> MDEdit {
      let last = rowLine(t, t.rows.count - 1, ns)
      var end = NSMaxRange(last)
      let hasBreak = end > last.location && ns.character(at: end - 1) == 0x0A
      if hasBreak { end -= 1 }
      let row = emptyRow(cols)
      // an empty cell's place is after its spaces, before its closing |
      return MDEdit(
        range: end..<end, replacement: "\n" + row, selection: MDSelection(end + 1 + 4 + 4 * p.column), undo: .command)
    }
    switch key {
    case .tab:
      if p.column + 1 < t.rows[p.row].count { return go(p.row, p.column + 1) }
      if p.row + 1 < t.rows.count { return go(p.row + 1, 0) }
      var e = addRowAtEnd()
      e.selection = MDSelection(e.range.lowerBound + 1 + 4)
      return e
    case .shiftTab:
      if p.column > 0 { return go(p.row, p.column - 1) }
      if p.row > 0 { return go(p.row - 1, t.rows[p.row - 1].count - 1) }
      return MDEdit(range: q..<q, replacement: "", selection: state.selection)
    case .enter:
      if p.row + 1 < t.rows.count { return go(p.row + 1, p.column) }
      return addRowAtEnd()
    default:
      return nil
    }
  }

  /// ⌘↵ a row below the caret's, ⌘⇧↵ one above (not above the header), the caret staying in its cell; ⌘⇧⌫ the caret's
  /// row deleted (not the header)
  public static func tableRow(add below: Bool?, in state: MDEditState, document d: MarkdownDocument) -> MDEdit? {
    let q = state.selection.head
    guard let p = tablePlace(at: q, in: d) else { return nil }
    let ns = state.source as NSString
    let t = p.table
    let cols = t.rows.map(\.count).max() ?? 1
    let line = rowLine(t, p.row, ns)
    guard let below else {
      guard p.row > 0 else { return nil }
      var r = line.location..<NSMaxRange(line)
      // the last row: the line break before it goes instead
      if NSMaxRange(line) == ns.length || ns.character(at: NSMaxRange(line) - 1) != 0x0A {
        r = (line.location - 1)..<NSMaxRange(line)
      }
      let target = p.row + 1 < t.rows.count ? p.row + 1 : p.row - 1
      var caret = cellStart(t, target, p.column)
      if caret > r.lowerBound { caret -= r.count }
      return MDEdit(range: r, replacement: "", selection: MDSelection(caret), undo: .command)
    }
    if below {
      // under the header the new row goes after the separator line
      let after = p.row == 0 ? ns.lineRange(for: NSRange(location: NSMaxRange(line), length: 0)) : line
      var end = NSMaxRange(after)
      if end > after.location, ns.character(at: end - 1) == 0x0A { end -= 1 }
      return MDEdit(range: end..<end, replacement: "\n" + emptyRow(cols), selection: state.selection, undo: .command)
    }
    guard p.row >= 1 else { return nil }
    let row = emptyRow(cols) + "\n"
    let n = (row as NSString).length
    return MDEdit(
      range: line.location..<line.location, replacement: row,
      selection: MDSelection(anchor: state.selection.anchor + n, head: state.selection.head + n), undo: .command)
  }
}

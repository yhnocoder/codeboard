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

extension MarkdownEditing {
  /// A column change at the caret's column: a column added after (or before) it, the column deleted, or its alignment
  /// set (none clears it). Each table line is changed only where the column is; the caret stays in its cell's text
  public enum ColumnChange: Sendable, Equatable {
    case add(after: Bool)
    case delete
    case align(MDTable.Align)
  }

  public static func tableColumn(_ change: ColumnChange, in state: MDEditState, document d: MarkdownDocument) -> MDEdit?
  {
    let q = state.selection.head
    guard let p = tablePlace(at: q, in: d) else { return nil }
    let ns = state.source as NSString
    let t = p.table
    let header = rowLine(t, 0, ns)
    let sep = ns.lineRange(for: NSRange(location: NSMaxRange(header), length: 0))
    // every line of the table with its row (nil: the separator), top to bottom
    var lines: [(NSRange, Int?)] = [(header, 0), (sep, nil)]
    for r in 1..<t.rows.count { lines.append((rowLine(t, r, ns), r)) }
    let first = header.location
    let lastLine = lines.last!.0
    var end = NSMaxRange(lastLine)
    if end > lastLine.location, ns.character(at: end - 1) == 0x0A { end -= 1 }
    let c = p.column
    if case .delete = change, t.rows[0].count <= 1 { return nil }
    var out = ""
    var caretShift = 0
    for (k, (line, row)) in lines.enumerated() {
      var text = ns.substring(with: line)
      if text.hasSuffix("\n") { text.removeLast() }
      let u = Array(text.utf16)
      // the pipes of this line that are not escaped and not in code
      var pipes: [Int] = []
      var tick = false
      for (i, ch) in u.enumerated() {
        if ch == 0x60 { tick.toggle() }
        if ch == 0x7C, !tick, i == 0 || u[i - 1] != 0x5C { pipes.append(i) }
      }
      let ns2 = text as NSString
      var piece = text
      // the cell between pipes[j] and pipes[j+1] is column j when the line starts with a pipe
      let lead = pipes.first == 0 ? 0 : -1
      let open = c + lead + (lead < 0 ? 1 : 0)
      func pipe(_ j: Int) -> Int? { j >= 0 && j < pipes.count ? pipes[j] : nil }
      switch change {
      case .add(let after):
        let at = after ? pipe(open + 1) : pipe(open)
        if let at {
          let cell = row == nil ? "---|" : "   |"
          piece = ns2.substring(to: at + 1) + cell + ns2.substring(from: at + 1)
          if row == p.row, !after { caretShift = 4 }
        }
      case .delete:
        if let a = pipe(open), let b = pipe(open + 1) {
          piece = ns2.substring(to: a) + ns2.substring(from: b)
        }
      case .align(let al):
        if row == nil, let a = pipe(open), let b = pipe(open + 1) {
          let w = max(3, b - a - 1)
          let dash = String(repeating: "-", count: max(1, w - (al == .center ? 2 : al == .none ? 0 : 1)))
          let cell =
            switch al {
            case .none: dash
            case .left: ":" + dash
            case .center: ":" + dash + ":"
            case .right: dash + ":"
            }
          piece = ns2.substring(to: a + 1) + cell + ns2.substring(from: b)
        }
      }
      out += piece + (k + 1 < lines.count ? "\n" : "")
    }
    let range = first..<end
    var caret = q + caretShift
    if case .delete = change {
      // the caret to the start of the table: its column is gone
      caret = first
    }
    let n = (out as NSString).length
    caret = min(caret, first + n)
    return MDEdit(range: range, replacement: out, selection: MDSelection(caret), undo: .command)
  }
}

extension MarkdownEditing {
  /// A body row moved to another place among the body rows (the header stays first), or a column to another place; the
  /// lines keep their own text, only their order or their cells' order changes. One undo step; the caret moves with its
  /// cell (editor/tablemove.ts)
  public static func tableMove(row from: Int, to: Int, in state: MDEditState, document d: MarkdownDocument) -> MDEdit? {
    guard let (t, lines, range) = tableLines(state, d), from >= 1, to >= 1, from < t.rows.count, to < t.rows.count,
      from != to
    else { return nil }
    // lines[0] header, lines[1] separator, lines[1 + r] row r
    var rows = Array(lines[2...])
    let moved = rows.remove(at: from - 1)
    rows.insert(moved, at: to - 1)
    let out = ([lines[0], lines[1]] + rows).joined(separator: "\n")
    return MDEdit(
      range: range, replacement: out, selection: movedCaret(state, d, out, range, row: (from, to)), undo: .command)
  }

  public static func tableMove(column from: Int, to: Int, in state: MDEditState, document d: MarkdownDocument)
    -> MDEdit?
  {
    guard let (t, lines, range) = tableLines(state, d), from >= 0, to >= 0, from != to else { return nil }
    let cols = t.rows.map(\.count).max() ?? 0
    guard from < cols, to < cols else { return nil }
    let out = lines.map { line -> String in
      let (pre, cells, post) = splitCells(line)
      guard from < cells.count, to < cells.count else { return line }
      var c = cells
      let m = c.remove(at: from)
      c.insert(m, at: to)
      return pre + c.joined(separator: "|") + post
    }.joined(separator: "\n")
    return MDEdit(range: range, replacement: out, selection: MDSelection(range.lowerBound), undo: .command)
  }

  /// the caret's table's lines (header, separator, rows) and their source range
  static func tableLines(_ state: MDEditState, _ d: MarkdownDocument) -> (MDTable, [String], Range<Int>)? {
    guard let p = tablePlace(at: state.selection.head, in: d) else { return nil }
    let ns = state.source as NSString
    let t = p.table
    let header = rowLine(t, 0, ns)
    let sep = ns.lineRange(for: NSRange(location: NSMaxRange(header), length: 0))
    var ranges = [header, sep]
    for r in 1..<t.rows.count { ranges.append(rowLine(t, r, ns)) }
    let last = ranges.last!
    var end = NSMaxRange(last)
    if end > last.location, ns.character(at: end - 1) == 0x0A { end -= 1 }
    let lines = ranges.map { r -> String in
      var s = ns.substring(with: r)
      if s.hasSuffix("\n") { s.removeLast() }
      return s
    }
    return (t, lines, header.location..<end)
  }

  /// a table line cut at its pipes (escaped ones and those in code kept): what is before the first cell, the cells,
  /// what is after the last
  static func splitCells(_ line: String) -> (String, [String], String) {
    let u = Array(line.utf16)
    var pipes: [Int] = []
    var tick = false
    for (i, ch) in u.enumerated() {
      if ch == 0x60 { tick.toggle() }
      if ch == 0x7C, !tick, i == 0 || u[i - 1] != 0x5C { pipes.append(i) }
    }
    let ns = line as NSString
    guard pipes.count >= 2 else { return ("", [line], "") }
    var cells: [String] = []
    for k in 0..<(pipes.count - 1) {
      cells.append(ns.substring(with: NSRange(location: pipes[k] + 1, length: pipes[k + 1] - pipes[k] - 1)))
    }
    return (ns.substring(to: pipes[0] + 1), cells, ns.substring(from: pipes.last!))
  }

  /// the caret after a row move: in the same cell of the row that moved, or of the row now at its place
  private static func movedCaret(
    _ state: MDEditState, _ d: MarkdownDocument, _ out: String, _ range: Range<Int>, row: (Int, Int)
  ) -> MDSelection {
    guard let p = tablePlace(at: state.selection.head, in: d) else { return state.selection }
    let old = p.row
    var now = old
    if old == row.0 {
      now = row.1
    } else if row.0 < old, old <= row.1 {
      now = old - 1
    } else if row.1 <= old, old < row.0 {
      now = old + 1
    }
    // the same column offset into the line now at that row
    let lines = out.components(separatedBy: "\n")
    var at = range.lowerBound
    for k in 0..<(now + 1) { at += (lines[k] as NSString).length + 1 }
    let ns = state.source as NSString
    let oldLine = ns.lineRange(for: NSRange(location: state.selection.head, length: 0)).location
    return MDSelection(at + (state.selection.head - oldLine))
  }
}

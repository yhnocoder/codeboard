import CodeCore
import CoreGraphics
import CoreText
import Foundation

/// A whole text laid out as CodeLines lays code out (tabs as spaces, long lines wrapped, room inserted after lines), with
/// what an editor asks of it: where each offset is drawn, which offset a point is at, the rows of a range. x is in the
/// context the code is drawn into, the code starting at `x`; each row's glyphs are measured as CodeDraw draws them
public struct CodeTextLayout: CodeLayout {
  public let lines: CodeLines
  /// Where the code starts across
  public let x: CGFloat
  public var pageRows: Int = 20

  /// A line row: its offsets, and at the start of each character in it the offset and where it is in the row's text
  struct Row {
    var index: Int
    var range: ClosedRange<Int>
    var stops: [(src: Int, u16: Int, tab: Bool)]
  }

  let rows: [Row]
  /// The line rows, in order (CodeLines' rows without folds and room)
  public let lineRows: [CodeLines.Row]
  let text: String
  let style: CodeStyle
  let tabWidth: Int
  private let cache = Cache()

  final class Cache {
    var lines: [Int: CTLine] = [:]
  }

  /// `runs`: each line's (CodeLines'); `insertions`: room after lines, as CodeLines.insert takes them
  public init(
    text: String, firstNumber: Int = 1, runs: [[CodeRun]] = [], wrapColumns: Int? = nil,
    insertions: [CodeLines.Insertion] = [], top: CGFloat = 0, x: CGFloat, metrics m: CodeLineMetrics, style: CodeStyle
  ) {
    let source = text.components(separatedBy: "\n")
    var lines = CodeLines(
      lines: source, firstNumber: firstNumber, runs: runs, wrapColumns: wrapColumns, top: top, metrics: m)
    lines.insert(insertions)
    self.lines = lines
    self.x = x
    self.text = text
    self.style = style
    tabWidth = m.tabWidth
    var out: [Row] = []
    var start = 0
    for line in source {
      // each character's expanded columns, cut into rows as CodeLines cuts them; a tab cut there has its offset on the
      // row it starts on, the rest of its spaces drawn at the start of the next
      var row: [(src: Int, u16: Int, tab: Bool)] = []
      var cols = 0
      var u16 = 0
      var src = start
      func cut(_ end: Int) {
        out.append(Row(index: out.count, range: (row.first?.src ?? end)...end, stops: row + [(end, u16, false)]))
        (row, u16) = ([], 0)
      }
      for ch in line {
        let tab = ch == "\t"
        for k in 0..<(tab ? m.tabWidth : 1) {
          if let w = wrapColumns, cols > 0, cols % w == 0 { cut(k == 0 ? src : src + 1) }
          if k == 0 { row.append((src, u16, tab)) }
          cols += 1
          u16 += tab ? 1 : ch.utf16.count
        }
        src += ch.utf16.count
      }
      cut(src)
      start = src + 1
    }
    rows = out
    lineRows = lines.rows.filter { if case .line = $0.kind { true } else { false } }
  }

  // MARK: CodeLayout

  public var rowCount: Int { rows.count }

  public func row(of q: Int, assoc: Int) -> Int {
    var lo = 0
    var hi = rows.count - 1
    // the last row starting at or before q
    while lo < hi {
      let mid = (lo + hi + 1) / 2
      if rows[mid].range.lowerBound <= q { lo = mid } else { hi = mid - 1 }
    }
    // a wrap point: the end of the row before, when asked
    if assoc < 0, lo > 0, rows[lo].range.lowerBound == q, rows[lo - 1].range.upperBound == q { return lo - 1 }
    return lo
  }

  public func x(of q: Int, assoc: Int) -> Double { Double(at(q, row: row(of: q, assoc: assoc))) }

  public func offsets(inRow r: Int) -> ClosedRange<Int> { rows[r].range }

  public func offset(inRow r: Int, x px: Double) -> Int {
    let row = rows[r]
    let line = ctLine(r)
    let i = CTLineGetStringIndexForPosition(line, CGPoint(x: CGFloat(px) - x, y: 0))
    guard let k = row.stops.lastIndex(where: { $0.u16 <= i }) else { return row.range.lowerBound }
    let s = row.stops[k]
    if i == s.u16 || k + 1 >= row.stops.count { return s.src }
    // in a tab's spaces: the side of the tab nearer
    if s.tab {
      let mid = (Double(at(s.src, row: r)) + Double(at(row.stops[k + 1].src, row: r))) / 2
      return px < mid ? s.src : row.stops[k + 1].src
    }
    return min(s.src + (i - s.u16), row.stops[k + 1].src)
  }

  // MARK: What an editor draws

  /// The row's place: its line (and whether it continues one), y and height
  public func placed(_ r: Int) -> CodeLines.Row { lineRows[r] }

  /// The caret at an offset: a line's height, at its x, in the row `assoc` says at a wrap point
  public func caret(_ q: Int, assoc: Int) -> CGRect {
    let r = row(of: q, assoc: assoc)
    let p = lineRows[r]
    return CGRect(x: at(q, row: r), y: p.y, width: 1, height: p.height)
  }

  /// A range's boxes, a row each; past a row's end (its line end, or where it wraps) out to `right`
  public func rects(_ range: Range<Int>, right: CGFloat) -> [CGRect] {
    guard !range.isEmpty else { return [] }
    var out: [CGRect] = []
    let first = row(of: range.lowerBound, assoc: 1)
    for r in first..<rows.count {
      let rr = rows[r].range
      if rr.lowerBound > range.upperBound || (rr.lowerBound == range.upperBound && r > first) { break }
      let a = at(max(range.lowerBound, rr.lowerBound), row: r)
      let b = range.upperBound > rr.upperBound ? right : at(min(range.upperBound, rr.upperBound), row: r)
      let p = lineRows[r]
      if b > a { out.append(CGRect(x: a, y: p.y, width: b - a, height: p.height)) }
    }
    return out
  }

  /// The offset a point is at, and the side of a wrap point it is drawn on: the row under it (the first above the
  /// rows, the last under them), the character boundary nearest across
  public func offset(at p: CGPoint) -> (offset: Int, assoc: Int) {
    var r = 0
    for (k, row) in lineRows.enumerated() where row.y <= p.y { r = k }
    let q = offset(inRow: r, x: Double(p.x))
    return (q, q == rows[r].range.upperBound && rows[r].range.count > 1 ? -1 : 1)
  }

  // MARK: Measuring

  /// x of an offset in a row it is in
  func at(_ q: Int, row r: Int) -> CGFloat {
    let row = rows[r]
    guard let s = row.stops.last(where: { $0.src <= q }) else { return x }
    let u16 = s.tab ? s.u16 + (q > s.src ? tabWidth : 0) : s.u16 + (q - s.src)
    return x + CTLineGetOffsetForStringIndex(ctLine(r), u16, nil)
  }

  func ctLine(_ r: Int) -> CTLine {
    if let l = cache.lines[r] { return l }
    guard case .line(_, _, let s, let runs) = lineRows[r].kind else { return CodeDraw.line("", style.font) }
    let l = CTLineCreateWithAttributedString(CodeDraw.attributed(s, runs: runs, style: style))
    cache.lines[r] = l
    return l
  }
}

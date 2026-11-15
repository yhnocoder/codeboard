import CoreGraphics

/// Part of a line drawn in one style: `columns` in UTF-16 units of the line, `style` the host's own number for it (its
/// style table gives the font and colour)
public struct CodeRun: Hashable, Sendable {
  public var columns: Range<Int>
  public var style: UInt8

  public init(columns: Range<Int>, style: UInt8) {
    self.columns = columns
    self.style = style
  }
}

/// Sizes of laid out code, in points
public struct CodeLineMetrics: Equatable, Sendable {
  public var row: CGFloat
  /// A run of folded lines' one row
  public var fold: CGFloat
  /// Left of the line numbers
  public var padLeft: CGFloat
  /// Between the line numbers and the code
  public var numberGap: CGFloat
  public var padRight: CGFloat
  /// Advance of one character of the code font: the code is laid out on a grid of it
  public var charWidth: CGFloat
  /// The spaces a tab is drawn as
  public var tabWidth: Int
  /// With indentation every line has taken off, how far right of the gutter the code still starts
  public var dedentPad: CGFloat

  public init(
    row: CGFloat, fold: CGFloat, padLeft: CGFloat, numberGap: CGFloat, padRight: CGFloat, charWidth: CGFloat,
    tabWidth: Int = 4, dedentPad: CGFloat = 16
  ) {
    self.row = row
    self.fold = fold
    self.padLeft = padLeft
    self.numberGap = numberGap
    self.padRight = padRight
    self.charWidth = charWidth
    self.tabWidth = tabWidth
    self.dedentPad = dedentPad
  }
}

/// Lines of code laid out in rows, top to bottom: tabs as spaces to the next stop (CSS tab-size), a line too long for `wrapColumns` cut into more rows,
/// folded lines one row each run, blank lines left out when asked, and room the host fills after a line (`insert`).
/// Line numbers are the caller's: `firstNumber` is the first line's.
public struct CodeLines: Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    /// A line's text, or (`wrapped`) what did not fit on its row before; runs in UTF-16 columns of `text`
    case line(number: Int, wrapped: Bool, text: String, runs: [CodeRun])
    case fold(ClosedRange<Int>)
    /// Room for the host's own content: the index of its `Insertion` in the `insert` call that put it
    case inserted(Int)
  }

  public struct Row: Equatable, Sendable {
    public var kind: Kind
    public var y: CGFloat
    public var height: CGFloat
  }

  public struct Insertion: Equatable, Sendable {
    public var afterLine: Int
    public var height: CGFloat

    public init(afterLine: Int, height: CGFloat) {
      self.afterLine = afterLine
      self.height = height
    }
  }

  public private(set) var rows: [Row] = []
  /// Under the last row
  public private(set) var bottom: CGFloat

  /// `runs`: each line's, in UTF-16 columns of the line as given; `folds`: line numbers, a line in more than one folded
  /// with the first that has it; `top`: where the first row is
  public init(
    lines: [String], firstNumber: Int = 1, runs: [[CodeRun]] = [], folds: [ClosedRange<Int>] = [],
    hideBlankLines: Bool = false, wrapColumns: Int? = nil, top: CGFloat = 0, metrics m: CodeLineMetrics
  ) {
    var y = top
    var rows: [Row] = []
    func put(_ k: Kind, _ h: CGFloat) {
      rows.append(Row(kind: k, y: y, height: h))
      y += h
    }
    let last = firstNumber + lines.count - 1
    var l = firstNumber
    while l <= last {
      if let r = folds.first(where: { $0.contains(l) }) {
        let to = min(r.upperBound, last)
        put(.fold(l...to), m.fold)
        l = to + 1
        continue
      }
      let i = l - firstNumber
      if hideBlankLines && lines[i].allSatisfy(\.isWhitespace) {
        l += 1
        continue
      }
      var rest = CodeLines.expand(lines[i], i < runs.count ? runs[i] : [], tabWidth: m.tabWidth)[...]
      var wrapped = false
      repeat {
        let piece = rest.prefix(wrapColumns ?? rest.count)
        put(.line(number: l, wrapped: wrapped, text: String(piece.map(\.char)), runs: CodeLines.runs(piece)), m.row)
        rest = rest.dropFirst(piece.count)
        wrapped = true
      } while !rest.isEmpty
      l += 1
    }
    self.rows = rows
    bottom = y
  }

  /// Puts each insertion's room after the last row that starts at or before its line (and after what is inserted there
  /// already), moving the rows under it down. Those put at the same place stay in the order given
  public mutating func insert(_ items: [Insertion]) {
    guard !items.isEmpty else { return }
    // each row's first line; an inserted row takes the one of the row it follows
    var starts: [Int] = []
    starts.reserveCapacity(rows.count)
    for r in rows {
      switch r.kind {
      case .line(let n, _, _, _): starts.append(n)
      case .fold(let f): starts.append(f.lowerBound)
      case .inserted: starts.append(starts.last ?? .min)
      }
    }
    // the row each goes before: the first starting past its line
    func place(_ line: Int) -> Int {
      var lo = 0
      var hi = starts.count
      while lo < hi {
        let mid = (lo + hi) / 2
        if starts[mid] > line { hi = mid } else { lo = mid + 1 }
      }
      return lo
    }
    let order = items.indices.map { (at: place(items[$0].afterLine), k: $0) }.sorted { ($0.at, $0.k) < ($1.at, $1.k) }
    var out: [Row] = []
    out.reserveCapacity(rows.count + items.count)
    var shift: CGFloat = 0
    var next = 0
    for i in 0...rows.count {
      let y = i < rows.count ? rows[i].y : bottom
      while next < order.count, order[next].at == i {
        let h = items[order[next].k].height
        out.append(Row(kind: .inserted(order[next].k), y: y + shift, height: h))
        shift += h
        next += 1
      }
      if i < rows.count {
        var r = rows[i]
        r.y += shift
        out.append(r)
      }
    }
    rows = out
    bottom += shift
  }

  /// Left edge of the code: the numbers' padding and room for `lastNumber`'s digits, then the gap
  public static func gutter(lastNumber: Int, metrics m: CodeLineMetrics) -> CGFloat {
    m.padLeft + CGFloat(String(lastNumber).count) * m.charWidth + m.numberGap
  }

  /// The characters that fit a row `width` wide right of `gutter`, at least one
  public static func columns(width: CGFloat, gutter: CGFloat, metrics m: CodeLineMetrics) -> Int {
    max(1, Int((width - gutter - m.padRight) / m.charWidth))
  }

  /// Indentation all of the rows' texts have (their blank ones aside), to take off: in columns, and how far the code
  /// moves right of the gutter then (negative: left). None (0, 0) under two columns
  public static func dedent(_ texts: some Sequence<String>, metrics m: CodeLineMetrics) -> (
    columns: Int, shift: CGFloat
  ) {
    var common = Int.max
    for text in texts where !text.allSatisfy(\.isWhitespace) {
      common = min(common, text.prefix { $0 == " " || $0 == "\t" }.count)
      if common < 2 { break }
    }
    guard common != Int.max && common >= 2 else { return (0, 0) }
    return (common, m.dedentPad - CGFloat(common) * m.charWidth)
  }

  /// A line's indentation in columns, its tabs as `tabWidth` spaces
  public static func indent(_ line: String, tabWidth: Int) -> Int {
    var n = 0
    for ch in line {
      if ch == " " {
        n += 1
      } else if ch == "\t" {
        n += tabWidth
      } else {
        break
      }
    }
    return n
  }

  /// The line's characters with tabs as spaces to their stops, each with the style of its first UTF-16 unit
  static func expand(_ line: String, _ runs: [CodeRun], tabWidth: Int) -> [(char: Character, style: UInt8?)] {
    var styles = [UInt8?](repeating: nil, count: line.utf16.count)
    for t in runs {
      for c in t.columns.clamped(to: 0..<styles.count) { styles[c] = t.style }
    }
    var out: [(char: Character, style: UInt8?)] = []
    var col = 0
    for ch in line {
      let k = col < styles.count ? styles[col] : nil
      if ch == "\t" {
        // to the next tab stop, as tab-size does
        out += Array(repeating: (" ", k), count: tabWidth - out.count % tabWidth)
      } else {
        out.append((ch, k))
      }
      col += ch.utf16.count
    }
    return out
  }

  /// Runs in UTF-16 columns of the piece's text
  static func runs(_ piece: ArraySlice<(char: Character, style: UInt8?)>) -> [CodeRun] {
    var out: [CodeRun] = []
    var col = 0
    for (ch, k) in piece {
      let end = col + ch.utf16.count
      if let k {
        if let last = out.last, last.style == k, last.columns.upperBound == col {
          out[out.count - 1].columns = last.columns.lowerBound..<end
        } else {
          out.append(CodeRun(columns: col..<end, style: k))
        }
      }
      col = end
    }
    return out
  }
}

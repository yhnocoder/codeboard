import CodeBoardModel
import CodeBoardSyntax
import CoreGraphics

/// Sizes of a code card's body, the same in every theme (the board's: 11 px code on 20 px rows): a card holds the same
/// code whatever the look.
struct CodeMetrics: Equatable, Sendable {
  var row: CGFloat = 20
  /// A run of hidden lines: 22 px and 1 px above and below
  var gap: CGFloat = 24
  /// A change of file between segments
  var file: CGFloat = 28
  /// A change of function between segments
  var function: CGFloat = 26
  var padTop: CGFloat = 6
  var padBottom: CGFloat = 8
  /// Left of the line numbers
  var padLeft: CGFloat = 17
  /// Between the line numbers and the code
  var numberGap: CGFloat = 22
  var padRight: CGFloat = 18
  /// A card without a stored height grows with its code up to this
  var maxAutoHeight: CGFloat = 460
  /// Advance of one character of the code font
  var charWidth: CGFloat
}

/// A code card's rows and where they sit in its body (y from the body's top).
struct CodeLayout: Equatable, Sendable {
  enum Row: Equatable, Sendable {
    /// A line, or (`number` nil) the continuation of a wrapped one; tokens in UTF-16 columns of `text`
    case line(segment: Int, number: Int?, text: String, tokens: [Token] = [])
    case gap(from: Int, to: Int)
    case file(String)
    case function(String)
  }

  struct Placed: Equatable, Sendable {
    var row: Row
    var y: CGFloat
    var height: CGFloat
  }

  var rows: [Placed] = []
  /// Left edge of the code
  var gutter: CGFloat
  /// Spaces of indentation every shown line has, hidden: the code moves left by them, less a small pad (the board's
  /// CodeBody `ded`, DED_PAD)
  var dedent = 0
  /// How far the code is moved right of the gutter (negative: left)
  var shift: CGFloat = 0
  /// Highlights as y ranges of their rows
  var bands: [ClosedRange<CGFloat>] = []
  /// The body's natural height
  var height: CGFloat

  /// Hiding comments and docstrings needs the language analysis, which comes later: only blank lines and hidden ranges are
  /// left out for now. `tokens`: the highlighter's, per segment and line
  init(_ code: CodeCard, tokens: [[[Token]]] = [], width: CGFloat, metrics m: CodeMetrics) {
    var last = 1
    for s in code.segments { last = max(last, s.lastLine) }
    gutter = m.padLeft + CGFloat(String(last).count) * m.charWidth + m.numberGap
    let cols = max(1, Int((width - gutter - m.padRight) / m.charWidth))
    var y = m.padTop
    var rows: [Placed] = []
    var bands: [ClosedRange<CGFloat>] = []
    func put(_ r: Row, _ h: CGFloat) {
      rows.append(Placed(row: r, y: y, height: h))
      y += h
    }
    for (si, s) in code.segments.enumerated() {
      if si > 0 {
        let prev = code.segments[si - 1]
        if CodeLayout.path(prev) != CodeLayout.path(s) {
          put(.file(CodeLayout.path(s) ?? "Free code"), m.file)
        } else if let scope = s.scope, prev.scope != scope {
          put(.function("def " + (scope.split(separator: ".").last.map(String.init) ?? scope)), m.function)
        } else if s.firstLine > prev.lastLine + 1 {
          put(.gap(from: prev.lastLine + 1, to: s.firstLine - 1), m.gap)
        }
      }
      var top: [Int: CGFloat] = [:]
      var bottom: [Int: CGFloat] = [:]
      var l = s.firstLine
      while l <= s.lastLine {
        if let r = s.hidden.first(where: { $0.contains(l) }) {
          let to = min(r.upperBound, s.lastLine)
          put(.gap(from: l, to: to), m.gap)
          l = to + 1
          continue
        }
        let i = l - s.firstLine
        if code.hide.blankLines && s.lines[i].allSatisfy(\.isWhitespace) {
          l += 1
          continue
        }
        top[l] = y
        let lineTokens = si < tokens.count && i < tokens[si].count ? tokens[si][i] : []
        var rest = CodeLayout.expand(s.lines[i], lineTokens)[...]
        var number: Int? = l
        repeat {
          let piece = rest.prefix(code.wrap ? cols : rest.count)
          put(
            .line(segment: si, number: number, text: String(piece.map(\.char)), tokens: CodeLayout.runs(piece)), m.row)
          rest = rest.dropFirst(piece.count)
          number = nil
        } while !rest.isEmpty
        bottom[l] = y
        l += 1
      }
      for h in s.highlights {
        let shown = h.filter { top[$0] != nil }
        if let a = shown.first, let b = shown.last, let t = top[a], let e = bottom[b] { bands.append(t...e) }
      }
    }
    self.rows = rows
    self.bands = bands
    height = y + m.padBottom
    // core lines.ts commonIndent, over the rows shown
    var common = Int.max
    for p in rows {
      guard case .line(_, _, let text, _) = p.row, !text.allSatisfy(\.isWhitespace) else { continue }
      common = min(common, text.prefix { $0 == " " || $0 == "\t" }.count)
      if common < 2 { break }
    }
    if common != Int.max && common >= 2 {
      dedent = common
      shift = 16 - CGFloat(common) * m.charWidth
    }
  }

  /// The middle of the row of a segment's line, when it is shown
  func lineY(segment: Int, line: Int) -> CGFloat? {
    for p in rows {
      if case .line(let s, let n?, _, _) = p.row, s == segment, n == line { return p.y + p.height / 2 }
    }
    return nil
  }

  /// The line's characters with tabs as four spaces, each with the class of its first UTF-16 unit
  static func expand(_ line: String, _ tokens: [Token]) -> [(char: Character, kind: TokenClass?)] {
    var kinds = [TokenClass?](repeating: nil, count: line.utf16.count)
    for t in tokens {
      for c in t.columns.clamped(to: 0..<kinds.count) { kinds[c] = t.kind }
    }
    var out: [(char: Character, kind: TokenClass?)] = []
    var col = 0
    for ch in line {
      let k = col < kinds.count ? kinds[col] : nil
      if ch == "\t" {
        out += Array(repeating: (" ", k), count: 4)
      } else {
        out.append((ch, k))
      }
      col += ch.utf16.count
    }
    return out
  }

  /// Tokens in UTF-16 columns of the piece's text
  static func runs(_ piece: ArraySlice<(char: Character, kind: TokenClass?)>) -> [Token] {
    var out: [Token] = []
    var col = 0
    for (ch, k) in piece {
      let end = col + ch.utf16.count
      if let k {
        if let last = out.last, last.kind == k, last.columns.upperBound == col {
          out[out.count - 1].columns = last.columns.lowerBound..<end
        } else {
          out.append(Token(columns: col..<end, kind: k))
        }
      }
      col = end
    }
    return out
  }

  static func path(_ s: Segment) -> String? {
    switch s.source {
    case .git(_, _, let p, _, _), .package(_, _, let p), .file(let p, _): p
    case nil: nil
    }
  }
}

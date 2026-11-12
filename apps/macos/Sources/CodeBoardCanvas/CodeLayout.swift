import CodeBoardModel
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
    /// A line, or (`number` nil) the continuation of a wrapped one
    case line(segment: Int, number: Int?, text: String)
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
  /// Highlights as y ranges of their rows
  var bands: [ClosedRange<CGFloat>] = []
  /// The body's natural height
  var height: CGFloat

  /// Hiding comments and docstrings needs the language analysis, which comes later: only blank lines and hidden ranges are
  /// left out for now
  init(_ code: CodeCard, width: CGFloat, metrics m: CodeMetrics) {
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
        let text = s.lines[l - s.firstLine].replacing("\t", with: "    ")
        if code.hide.blankLines && text.allSatisfy(\.isWhitespace) {
          l += 1
          continue
        }
        top[l] = y
        var rest = Substring(text)
        var number: Int? = l
        repeat {
          let n = code.wrap ? cols : rest.count
          put(.line(segment: si, number: number, text: String(rest.prefix(n))), m.row)
          rest = rest.dropFirst(n)
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
  }

  /// The middle of the row of a segment's line, when it is shown
  func lineY(segment: Int, line: Int) -> CGFloat? {
    for p in rows {
      if case .line(let s, let n?, _) = p.row, s == segment, n == line { return p.y + p.height / 2 }
    }
    return nil
  }

  static func path(_ s: Segment) -> String? {
    switch s.source {
    case .git(_, _, let p, _, _), .package(_, _, let p), .file(let p, _): p
    case nil: nil
    }
  }
}

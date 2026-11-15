import CodeBoardModel
import CodeBoardSyntax
import CodeUI
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

  /// What the code component lays the lines out with
  var lines: CodeLineMetrics {
    CodeLineMetrics(
      row: row, fold: gap, padLeft: padLeft, numberGap: numberGap, padRight: padRight, charWidth: charWidth)
  }
}

/// A code card's rows and where they sit in its body (y from the body's top).
struct CodeLayout: Equatable, Sendable {
  enum Row: Equatable, Sendable {
    /// A line, or (`number` nil) the continuation of a wrapped one; tokens in UTF-16 columns of `text`
    case line(segment: Int, number: Int?, text: String, tokens: [Token] = [])
    /// Lines not shown (hidden, or between two segments), of the segment they belong to (the next one, between two)
    case gap(segment: Int, from: Int, to: Int)
    case file(String)
    case function(String)
    /// A Highlight's Always Show sidenotes, under its last row (`inline` has where each is)
    case notes(segment: Int)
  }

  /// The Always Show sidenotes of one of a segment's Highlights (its lines), each with its height at the width it is
  /// drawn at (the Note renderer's: 0 until measured)
  struct Always: Equatable, Sendable {
    var lines: ClosedRange<Int>
    var notes: [Measured]
    struct Measured: Equatable, Sendable {
      var id: SidenoteID
      var height: CGFloat
    }
  }

  /// Where a Highlight's Always Show sidenotes are drawn (CodeBody .inotes): from `x` right of the gutter (where its
  /// least indented line's code starts, .inotes --hx-in), one under the other from `y`
  struct Inline: Equatable, Sendable {
    var segment: Int
    var always: Always
    var x: CGFloat
    var y: CGFloat
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
  /// Highlights as y ranges of their rows (and of the sidenotes shown under them)
  var bands: [ClosedRange<CGFloat>] = []
  var inline: [Inline] = []
  /// The body's natural height
  var height: CGFloat

  /// Hiding comments and docstrings needs the language analysis, which comes later: only blank lines and hidden ranges are
  /// left out for now. `tokens`: the highlighter's, per segment and line; `always`: per segment, its Highlights' Always
  /// Show sidenotes, drawn under the Highlight's last row, a line's or a hidden run's (highlights.ts useHighlights
  /// endRow); none where the Highlight has no row (all its lines blank, blank lines hidden)
  init(
    _ code: CodeCard, tokens: [[[Token]]] = [], width: CGFloat, metrics m: CodeMetrics, always: [[Always]] = []
  ) {
    let lm = m.lines
    var last = 1
    for s in code.segments { last = max(last, s.lastLine) }
    gutter = CodeLines.gutter(lastNumber: last, metrics: lm)
    let cols = CodeLines.columns(width: width, gutter: gutter, metrics: lm)
    var y = m.padTop
    var rows: [Placed] = []
    var bands: [ClosedRange<CGFloat>] = []
    var inline: [Inline] = []
    // the least indent of each Inline's shown lines, in columns
    var leads: [Int] = []
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
          put(.gap(segment: si, from: prev.lastLine + 1, to: s.firstLine - 1), m.gap)
        }
      }
      let runs =
        si < tokens.count ? tokens[si].map { $0.map { CodeRun(columns: $0.columns, style: $0.kind.rawValue) } } : []
      var lines = CodeLines(
        lines: s.lines, firstNumber: s.firstLine, runs: runs, folds: s.hidden, hideBlankLines: code.hide.blankLines,
        wrapColumns: code.wrap ? cols : nil, top: y, metrics: lm)
      // a Highlight's Always Show sidenotes go under its last row (its lines' or a hidden run's), in the order their
      // rows come, and none where it has no row
      let groups = si < always.count ? always[si] : []
      var under: [(k: Int, row: Int, lead: Int)] = []
      for (k, g) in groups.enumerated() {
        var first: Int?
        var lead = Int.max
        for (j, r) in lines.rows.enumerated() {
          switch r.kind {
          case .line(let n, false, _, _) where g.lines.contains(n):
            first = first ?? j
            let text = s.lines[n - s.firstLine]
            if !text.allSatisfy(\.isWhitespace) { lead = min(lead, CodeLines.indent(text, tabWidth: lm.tabWidth)) }
          case .fold(let f) where f.overlaps(g.lines):
            first = first ?? j
          default: break
          }
        }
        if let first { under.append((k, first, lead)) }
      }
      under.sort { ($0.row, $0.k) < ($1.row, $1.k) }
      lines.insert(
        under.map { u in
          CodeLines.Insertion(
            afterLine: groups[u.k].lines.upperBound, height: groups[u.k].notes.reduce(0) { $0 + $1.height })
        })
      var top: [Int: CGFloat] = [:]
      var bottom: [Int: CGFloat] = [:]
      for r in lines.rows {
        switch r.kind {
        case .line(let n, let wrapped, let text, let runs):
          let tokens = runs.compactMap { run in
            TokenClass(rawValue: run.style).map { Token(columns: run.columns, kind: $0) }
          }
          rows.append(
            Placed(
              row: .line(segment: si, number: wrapped ? nil : n, text: text, tokens: tokens), y: r.y, height: r.height))
          if !wrapped { top[n] = r.y }
          bottom[n] = r.y + r.height
        case .fold(let f):
          rows.append(Placed(row: .gap(segment: si, from: f.lowerBound, to: f.upperBound), y: r.y, height: r.height))
        case .inserted(let i):
          inline.append(Inline(segment: si, always: groups[under[i].k], x: 0, y: r.y))
          leads.append(under[i].lead)
          rows.append(Placed(row: .notes(segment: si), y: r.y, height: r.height))
        }
      }
      y = lines.bottom
      for h in s.highlights {
        let shown = h.filter { top[$0] != nil }
        // down to the end of the sidenotes shown under it (CodeBody bandStyle: ends, the .hx-end's bottom)
        let under = inline.last { $0.segment == si && $0.always.lines == h }.map { i in
          i.y + i.always.notes.reduce(0) { $0 + $1.height }
        }
        if let a = shown.first, let b = shown.last, let t = top[a], let e = bottom[b] {
          bands.append(t...max(e, under ?? e))
        }
      }
    }
    self.rows = rows
    self.bands = bands
    height = y + m.padBottom
    // core lines.ts commonIndent, over the rows shown
    (dedent, shift) = CodeLines.dedent(
      rows.lazy.compactMap { if case .line(_, _, let text, _) = $0.row { text } else { nil } }, metrics: lm)
    // where the Highlight's code starts: its least indented line's, after the hidden indent (CodeBody codeStart)
    for k in inline.indices {
      inline[k].x = leads[k] == .max ? 0 : max(0, CGFloat(leads[k]) * m.charWidth + shift)
    }
    self.inline = inline
  }

  /// How wide an Always Show sidenote is drawn from `x` right of the gutter in a card `card` wide: the card's room right of
  /// the gutter less the code's right padding, its indent and 20 more, at most 600 (styles.css .inote max-width)
  func inlineWidth(card: CGFloat, x: CGFloat, metrics m: CodeMetrics) -> CGFloat {
    max(1, min(600, card - gutter - m.padRight - x - 20))
  }

  /// The row of a segment's line (its first, when it wraps), when it is shown
  func row(segment: Int, line: Int) -> Placed? {
    rows.first { if case .line(let s, let n?, _, _) = $0.row { s == segment && n == line } else { false } }
  }

  /// Where something on a segment's line shows: its row, or the hidden run's row when it is hidden (main marks.ts: a
  /// sticker on a hidden line sits on the "N lines hidden" row)
  func shownRow(segment: Int, line: Int) -> Placed? {
    row(segment: segment, line: line)
      ?? rows.first {
        if case .gap(let s, let a, let b) = $0.row { s == segment && (a...b).contains(line) } else { false }
      }
  }

  /// The middle of the row of a segment's line, when it is shown
  func lineY(segment: Int, line: Int) -> CGFloat? {
    for p in rows {
      if case .line(let s, let n?, _, _) = p.row, s == segment, n == line { return p.y + p.height / 2 }
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

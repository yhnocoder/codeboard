import CoreGraphics
import Foundation

/// What a host marks on lines, drawn under the code, in colours it resolved itself: a line's background (on its first
/// row, across the width), bands over runs of lines, a picture in the gutter. Lines are the numbers CodeLines was given;
/// room after a line is CodeLines' `insert`
public struct CodeDecorations: @unchecked Sendable {
  /// A rounded band from the top of the first shown line of `lines` to the bottom of the last one's rows, or down to the
  /// end of the room inserted `through` (its index in `insert`) when that is lower
  public struct Band: @unchecked Sendable {
    public var lines: ClosedRange<Int>
    public var through: Int?
    public var color: CGColor

    public init(lines: ClosedRange<Int>, through: Int? = nil, color: CGColor) {
      self.lines = lines
      self.through = through
      self.color = color
    }
  }

  public var backgrounds: [Int: CGColor]
  public var bands: [Band]
  /// Drawn in the gutter's left padding, in the middle of the line's first row
  public var marks: [Int: CGImage]
  /// A line number's own colour
  public var numbers: [Int: CGColor]

  public init(
    backgrounds: [Int: CGColor] = [:], bands: [Band] = [], marks: [Int: CGImage] = [:], numbers: [Int: CGColor] = [:]
  ) {
    self.backgrounds = backgrounds
    self.bands = bands
    self.marks = marks
    self.numbers = numbers
  }
}

/// Where a band sits: from `left` past the gutter's edge (negative: into it) to `right` short of the width, `inset` in
/// from its rows' top and bottom, its corners rounded by `radius`
public struct CodeBandShape: Equatable, Sendable {
  public var left: CGFloat
  public var right: CGFloat
  public var inset: CGFloat
  public var radius: CGFloat

  public init(left: CGFloat, right: CGFloat, inset: CGFloat, radius: CGFloat) {
    self.left = left
    self.right = right
    self.inset = inset
    self.radius = radius
  }
}

extension CodeLines {
  /// A line's first row
  public struct LineRow: Equatable, Sendable {
    public var line: Int
    public var y: CGFloat
    public var height: CGFloat

    public init(line: Int, y: CGFloat, height: CGFloat) {
      self.line = line
      self.y = y
      self.height = height
    }
  }

  /// Each shown line's first row
  public var lineRows: [LineRow] {
    rows.compactMap { r in
      if case .line(let n, false, _, _) = r.kind { LineRow(line: n, y: r.y, height: r.height) } else { nil }
    }
  }

  /// From the top of the first shown line of `lines` to the bottom of the last one's rows, or of the room inserted
  /// `through` when lower; nil when none of them is shown (folded, or blank and left out)
  public func span(_ lines: ClosedRange<Int>, through: Int? = nil) -> ClosedRange<CGFloat>? {
    var top: CGFloat?
    var first: Int?
    var last: Int?
    var bottom: [Int: CGFloat] = [:]
    var room: CGFloat?
    for r in rows {
      switch r.kind {
      case .line(let n, let wrapped, _, _) where lines.contains(n):
        if !wrapped {
          if first == nil { (first, top) = (n, r.y) }
          last = n
        }
        bottom[n] = r.y + r.height
      case .inserted(let i) where i == through: room = r.y + r.height
      default: break
      }
    }
    guard let top, let last, let end = bottom[last] else { return nil }
    return top...max(end, room ?? end)
  }
}

extension CodeLines {
  /// Where a range of lines is drawn, for the host to put something against them
  public struct LineFrame: Equatable, Sendable {
    /// From the top of the range's first row to the bottom of its last: a wrapped line's rows, and the folds and room
    /// between its lines, with them; across `width`
    public var rect: CGRect
    /// The first row of the range's first shown line (a fold's row when it is folded)
    public var first: CGRect
    /// Every line of the range is folded away: `rect` is the rows of the folds that hold them
    public var folded: Bool
  }

  /// Where `lines` are drawn, across a body `width` wide; nil when none of them has a row (blank lines left out)
  public func frame(of lines: ClosedRange<Int>, width: CGFloat) -> LineFrame? {
    var top: CGFloat?
    var bottom: CGFloat = 0
    var first: CGRect?
    var shown = false
    for r in rows {
      let on: Bool
      switch r.kind {
      case .line(let n, _, _, _): on = lines.contains(n)
      case .fold(let f): on = f.overlaps(lines)
      case .inserted: on = false
      }
      guard on else { continue }
      let row = CGRect(x: 0, y: r.y, width: width, height: r.height)
      if case .line = r.kind, !shown {
        shown = true
        first = row
      }
      first = first ?? row
      top = top ?? r.y
      bottom = r.y + r.height
    }
    guard let top, let first else { return nil }
    return LineFrame(
      rect: CGRect(x: 0, y: top, width: width, height: bottom - top), first: first, folded: !shown)
  }
}

extension CodeDraw {
  /// The backgrounds of the rows' lines that have one, across `width`
  public static func backgrounds(
    _ colors: [Int: CGColor], rows: some Sequence<CodeLines.LineRow>, in ctx: CGContext, width: CGFloat
  ) {
    guard !colors.isEmpty else { return }
    for r in rows {
      guard let c = colors[r.line] else { continue }
      ctx.setFillColor(c)
      ctx.fill(CGRect(x: 0, y: r.y, width: width, height: r.height))
    }
  }

  /// A band over `span` (CodeLines.span) of code whose gutter ends at `gutter`, in a body `width` wide
  public static func band(
    _ span: ClosedRange<CGFloat>, color: CGColor, in ctx: CGContext, gutter: CGFloat, width: CGFloat,
    shape s: CodeBandShape
  ) {
    let r = CGRect(
      x: gutter + s.left, y: span.lowerBound + s.inset, width: width - s.right - (gutter + s.left),
      height: span.upperBound - span.lowerBound - 2 * s.inset)
    ctx.addPath(CGPath(roundedRect: r, cornerWidth: s.radius, cornerHeight: s.radius, transform: nil))
    ctx.setFillColor(color)
    ctx.fillPath()
  }

  /// All of a host's marks on laid out lines, under their code: backgrounds, then bands, then the gutter's pictures
  /// (`markSize` square, from `markX`)
  public static func decorations(
    _ d: CodeDecorations, of lines: CodeLines, in ctx: CGContext, gutter: CGFloat, width: CGFloat,
    band shape: CodeBandShape, markX: CGFloat, markSize: CGFloat
  ) {
    let first = lines.lineRows
    backgrounds(d.backgrounds, rows: first, in: ctx, width: width)
    for b in d.bands {
      if let s = lines.span(b.lines, through: b.through) {
        band(s, color: b.color, in: ctx, gutter: gutter, width: width, shape: shape)
      }
    }
    guard !d.marks.isEmpty else { return }
    for r in first {
      guard let image = d.marks[r.line] else { continue }
      let box = CGRect(x: markX, y: r.y + (r.height - markSize) / 2, width: markSize, height: markSize)
      // the context is y-down: the picture drawn upright
      ctx.saveGState()
      ctx.translateBy(x: 0, y: box.maxY + box.minY)
      ctx.scaleBy(x: 1, y: -1)
      ctx.draw(image, in: box)
      ctx.restoreGState()
    }
  }
}

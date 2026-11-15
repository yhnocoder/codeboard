import CoreGraphics
import CoreText
import Foundation

/// A font and the extra space after each character (CSS letter-spacing), in points. CTFont is immutable and documented
/// safe to use from any thread, but the SDK does not mark it Sendable
public struct CodeFont: @unchecked Sendable {
  public let ct: CTFont
  public var tracking: CGFloat

  public init(_ f: CTFont, tracking: CGFloat = 0) {
    ct = f
    self.tracking = tracking
  }
}

extension CodeFont: Equatable {
  public static func == (a: CodeFont, b: CodeFont) -> Bool { CFEqual(a.ct, b.ct) && a.tracking == b.tracking }
}

/// How code is drawn, resolved by the host into plain values once: nothing is asked of it while drawing
public struct CodeStyle: @unchecked Sendable {
  /// What a run with a style of its own is drawn in: its colour, and its font where it is not the code's
  public struct Run: @unchecked Sendable {
    public var color: CGColor
    public var font: CTFont?

    public init(color: CGColor, font: CTFont? = nil) {
      self.color = color
      self.font = font
    }
  }

  /// The code font, the one the lines are laid out on
  public var font: CodeFont
  /// Text in no run, and runs with a style `runs` has nothing for
  public var ink: CGColor
  /// By `CodeRun.style`
  public var runs: [Run?]

  public init(font: CodeFont, ink: CGColor, runs: [Run?]) {
    self.font = font
    self.ink = ink
    self.runs = runs
  }
}

/// How a row of folded lines is drawn: a band between two dashed lines, a label and after it the action that opens it
public struct CodeFoldStyle: @unchecked Sendable {
  public var fill: CGColor
  public var line: CGColor
  public var label: CodeFont
  public var labelColor: CGColor
  public var action: CodeFont
  public var actionColor: CGColor

  public init(
    fill: CGColor, line: CGColor, label: CodeFont, labelColor: CGColor, action: CodeFont, actionColor: CGColor
  ) {
    self.fill = fill
    self.line = line
    self.label = label
    self.labelColor = labelColor
    self.action = action
    self.actionColor = actionColor
  }
}

/// Drawing laid out code into a y-down context whose text matrix is flipped (scale 1, -1)
public enum CodeDraw {
  /// A row of code in its runs' styles, its middle at `midY`
  public static func line(_ s: String, runs: [CodeRun], in ctx: CGContext, x: CGFloat, midY: CGFloat, style: CodeStyle)
  {
    guard !s.isEmpty else { return }
    let f = style.font.ct
    ctx.textPosition = CGPoint(x: x, y: midY + (CTFontGetAscent(f) - CTFontGetDescent(f)) / 2)
    CTLineDraw(CTLineCreateWithAttributedString(attributed(s, runs: runs, style: style)), ctx)
  }

  /// A row's text in its runs' fonts and colours, as `line` draws it
  public static func attributed(_ s: String, runs: [CodeRun], style: CodeStyle) -> NSAttributedString {
    let font = NSAttributedString.Key(kCTFontAttributeName as String)
    let color = NSAttributedString.Key(kCTForegroundColorAttributeName as String)
    let a = NSMutableAttributedString(string: s, attributes: [font: style.font.ct, color: style.ink])
    apply(runs, style: style, to: a)
    return a
  }

  /// The runs' colours and fonts put on a line already in the code font (a host's own text, with attributes of its
  /// own), as `attributed` puts them
  public static func apply(_ runs: [CodeRun], style: CodeStyle, to a: NSMutableAttributedString) {
    let font = NSAttributedString.Key(kCTFontAttributeName as String)
    let color = NSAttributedString.Key(kCTForegroundColorAttributeName as String)
    let units = a.length
    for run in runs {
      let r = run.columns.clamped(to: 0..<units)
      guard !r.isEmpty else { continue }
      let range = NSRange(location: r.lowerBound, length: r.count)
      let look = Int(run.style) < style.runs.count ? style.runs[Int(run.style)] : nil
      a.addAttribute(color, value: look?.color ?? style.ink, range: range)
      if let f = look?.font { a.addAttribute(font, value: f, range: range) }
    }
  }

  /// A line number ending at `right`, its middle at `midY`
  public static func number(_ n: Int, in ctx: CGContext, right: CGFloat, midY: CGFloat, font: CodeFont, color: CGColor)
  {
    let s = String(n)
    text(s, in: ctx, font: font, color: color, x: right - width(s, font), midY: midY, width: .infinity)
  }

  /// A row of folded lines across `row`: the band a unit inside it, `label` from `x`, `action` after it
  public static func fold(
    in ctx: CGContext, row r: CGRect, x: CGFloat, label: String, action: String?, style: CodeFoldStyle
  ) {
    let band = CGRect(x: r.minX, y: r.minY + 1, width: r.width, height: r.height - 2)
    ctx.setFillColor(style.fill)
    ctx.fill(band)
    ctx.setStrokeColor(style.line)
    ctx.setLineWidth(1)
    ctx.setLineDash(phase: 0, lengths: [3, 3])
    ctx.strokeLineSegments(between: [
      CGPoint(x: band.minX, y: band.minY + 0.5), CGPoint(x: band.maxX, y: band.minY + 0.5),
      CGPoint(x: band.minX, y: band.maxY - 0.5), CGPoint(x: band.maxX, y: band.maxY - 0.5),
    ])
    ctx.setLineDash(phase: 0, lengths: [])
    let mid = r.midY
    text(label, in: ctx, font: style.label, color: style.labelColor, x: x, midY: mid, width: r.maxX - x - 8)
    guard let action else { return }
    let after = x + width(label, style.label) + 5
    text(action, in: ctx, font: style.action, color: style.actionColor, x: after, midY: mid, width: r.maxX - after - 8)
  }

  /// One line of text with its middle at `midY`, cut with an ellipsis to `width`
  public static func text(
    _ s: String, in ctx: CGContext, font: CodeFont, color: CGColor, x: CGFloat, midY: CGFloat, width w: CGFloat
  ) {
    guard !s.isEmpty, w > 0 else { return }
    var l = line(s, font, color)
    if w.isFinite, CTLineGetTypographicBounds(l, nil, nil, nil) > w + 0.5 {
      l = CTLineCreateTruncatedLine(l, w, .end, line("…", font, color)) ?? l
    }
    let f = font.ct
    ctx.textPosition = CGPoint(x: x, y: midY + (CTFontGetAscent(f) - CTFontGetDescent(f)) / 2)
    CTLineDraw(l, ctx)
  }

  public static func line(_ s: String, _ font: CodeFont, _ color: CGColor? = nil) -> CTLine {
    var attrs: [CFString: Any] = [kCTFontAttributeName: font.ct]
    if let color { attrs[kCTForegroundColorAttributeName] = color }
    if font.tracking != 0 { attrs[kCTKernAttributeName] = font.tracking }
    return CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, s as CFString, attrs as CFDictionary))
  }

  public static func width(_ s: String, _ font: CodeFont) -> CGFloat {
    CTLineGetTypographicBounds(line(s, font), nil, nil, nil)
  }
}

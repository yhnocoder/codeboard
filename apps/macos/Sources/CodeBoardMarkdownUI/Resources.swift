import CoreGraphics
import Foundation

/// What layout and drawing need from outside: the component reads no files and knows nothing of the host's data
public protocol MarkdownResources: Sendable {
  /// An image address → its size in pixels; nil when it cannot be had (drawn as a fixed-size broken-image box). The host
  /// has these ready before laying out: this must not wait or read anything but the file's header (guideline 5.4)
  func imageSize(_ src: String) -> CGSize?
  /// What a [[reference]] points at now; nil: not found
  func ref(label: String, target: String?) -> MarkdownRefHit?
  /// Code colouring: each line's tokens; nil for a language without colouring
  func highlight(lines: [String], language: String) -> [[MarkdownToken]]?
  /// The math preamble (\newcommand, \def lines)
  var mathPreamble: String { get }
  /// Formulas: nil draws each formula as its TeX in the code font
  var math: MathTypesetter? { get }
  /// Mermaid diagrams: nil shows their source as a code block
  var diagrams: DiagramRenderer? { get }
}

extension MarkdownResources {
  public var math: MathTypesetter? { nil }
  public var diagrams: DiagramRenderer? { nil }
}

/// Draws Mermaid (pele in JavaScriptCore, guideline 5.8)
public protocol DiagramRenderer: Sendable {
  /// the diagram with its labels measured in `fonts`; maxWidth turns a too wide one vertical; nodes' corners rounded by
  /// `cornerRadius` (pele's --_r: half the board's --md-radius)
  func diagram(_ source: String, fonts: [String], maxWidth: Int?, cornerRadius: Double) -> DiagramResult
}

public enum DiagramResult: Sendable, Hashable {
  /// width and height in points; paths and texts in points from its top left
  case ok(width: Double, height: Double, paths: [MDPath], texts: [MDGlyphText])
  case error(String)
}

/// A code token's colour class, one to one with CodeBoardSyntax's TokenClass
public enum MarkdownTokenKind: Sendable, Hashable {
  case keyword, `operator`, function, string, comment, number, receiver, punctuation
}

public struct MarkdownToken: Sendable, Hashable {
  /// UTF-16 columns in its line
  public var columns: Range<Int>
  public var kind: MarkdownTokenKind
  public init(columns: Range<Int>, kind: MarkdownTokenKind) {
    self.columns = columns
    self.kind = kind
  }
}

public struct MarkdownSeal: Sendable, Hashable {
  public var text: String
  /// a key of MarkdownTheme.MarkColors.seals
  public var color: String
  /// the reference is to that place itself: only the seal is drawn
  public var alone: Bool
  public init(text: String, color: String, alone: Bool) {
    self.text = text
    self.color = color
    self.alone = alone
  }
}

public enum MarkdownRefHit: Sendable, Equatable {
  /// title: the target's title now; seal: drawn before it
  case found(title: String, seal: MarkdownSeal?)
  /// gone: place false is a place still there with the item gone (grey, struck through), true the place gone too (warn)
  case broken(place: Bool, title: String, badge: String?)
}

/// Typesets formulas (MathJax in JavaScriptCore, guideline 5.3)
public protocol MathTypesetter: Sendable {
  /// The formula's size and paths, from the cache or converted now
  func typeset(_ latex: String, display: Bool, preamble: String) -> MathResult
}

public enum MathResult: Sendable, Hashable {
  case ok(MathPicture)
  /// what went wrong, where in the latex (UTF-16), and a fixed latex when one is known
  case error(message: String, at: Range<Int>?, fix: String?)
}

/// A typeset formula at 1 em: width, height and baseline (from the top) in em; drawn scaled by the font size, coloured by
/// the theme
public struct MathPicture: Sendable, Hashable {
  public var width, height, baseline: Double
  public var paths: [MDPath]
  public var texts: [MDGlyphText]
  public init(width: Double, height: Double, baseline: Double, paths: [MDPath], texts: [MDGlyphText]) {
    self.width = width
    self.height = height
    self.baseline = baseline
    self.paths = paths
    self.texts = texts
  }
}

/// One shape of a drawn SVG subset (formulas, Mermaid): a path in its own units, the transform onto the picture, and how
/// it is painted
public struct MDPath: Sendable, Hashable {
  public enum Paint: Sendable, Hashable {
    /// the text colour (formulas)
    case ink
    /// a theme colour by role (Mermaid's --pele-*), or a fixed one
    case role(String)
    case color(MDColor)
    case none
  }
  /// SVG path data ("M0 0L10 0Z"); rects come as paths too
  public var data: String
  public var transform: CGAffineTransform
  public var fill: Paint
  public var stroke: Paint
  public var strokeWidth: Double
  public init(data: String, transform: CGAffineTransform, fill: Paint, stroke: Paint = .none, strokeWidth: Double = 0) {
    self.data = data
    self.transform = transform
    self.fill = fill
    self.stroke = stroke
    self.strokeWidth = strokeWidth
  }
  public static func == (a: MDPath, b: MDPath) -> Bool {
    a.data == b.data && a.transform == b.transform && a.fill == b.fill && a.stroke == b.stroke
      && a.strokeWidth == b.strokeWidth
  }
  public func hash(into h: inout Hasher) {
    h.combine(data)
    h.combine(fill)
    h.combine(stroke)
  }
}

/// Text a drawn SVG holds that native fonts draw (Chinese in \text{…}, Mermaid labels)
public struct MDGlyphText: Sendable, Hashable {
  public var text: String
  /// where its baseline starts, in picture units
  public var origin: CGPoint
  public var size: Double
  public var fill: MDPath.Paint
  public var bold: Bool
  /// where the origin is along the text: 0 its start, 0.5 its middle (text-anchor: middle), 1 its end
  public var anchor: Double
  public init(text: String, origin: CGPoint, size: Double, fill: MDPath.Paint, bold: Bool = false, anchor: Double = 0) {
    self.text = text
    self.origin = origin
    self.size = size
    self.fill = fill
    self.bold = bold
    self.anchor = anchor
  }
  public static func == (a: MDGlyphText, b: MDGlyphText) -> Bool {
    a.text == b.text && a.origin == b.origin && a.size == b.size && a.fill == b.fill && a.bold == b.bold
      && a.anchor == b.anchor
  }
  public func hash(into h: inout Hasher) {
    h.combine(text)
    h.combine(size)
  }
}

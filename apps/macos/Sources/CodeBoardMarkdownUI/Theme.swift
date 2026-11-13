import CoreGraphics
import Foundation

/// A colour in sRGB, 0–1. Not a CGColor, so that a theme hashes the same way every time and can be part of a cache key.
public struct MDColor: Sendable, Hashable {
  public var r, g, b, a: Double
  public init(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) {
    self.r = r
    self.g = g
    self.b = b
    self.a = a
  }
  /// #rrggbb, #rrggbbaa
  public init(hex: String, alpha: Double = 1) {
    var v: UInt64 = 0
    Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&v)
    if hex.count > 7 {
      self.init(
        Double((v >> 24) & 255) / 255, Double((v >> 16) & 255) / 255, Double((v >> 8) & 255) / 255,
        Double(v & 255) / 255)
    } else {
      self.init(Double((v >> 16) & 255) / 255, Double((v >> 8) & 255) / 255, Double(v & 255) / 255, alpha)
    }
  }
  public static let clear = MDColor(0, 0, 0, 0)
  public var cg: CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: a) }
  public func alpha(_ k: Double) -> MDColor { MDColor(r, g, b, a * k) }
}

/// Everything a piece of Markdown is drawn with. It is part of every cache key: two equal themes draw the same picture.
/// The fields follow @yhnocoder/markdown's CSS variables (README, Theming) and the values its stylesheet writes itself
/// (markdown.css); the host converts its own theme into this. Metrics default to that stylesheet's values, as the Note
/// page computes them (tools/markdown/styles.mjs measures them).
public struct MarkdownTheme: Sendable, Hashable {
  public struct Colors: Sendable, Hashable {
    /// --ink --ink-2 --ink-3: text, from dark to light
    public var ink, ink2, ink3: MDColor
    /// --surface: the paper; --hlrow: header rows, inline code, kbd backgrounds
    public var surface, fill: MDColor
    /// a code block's background (.md pre.md-code: opaque in Warm Ink, --hlrow in Ink Wash)
    public var codeBlock: MDColor
    /// --hair (table and quote lines, rules) and --line
    public var hair, line: MDColor
    /// --accent and the text on it (a checked task box)
    public var accent, accentInk: MDColor
    /// --warn: a reference whose place is gone
    public var warn: MDColor
    /// --k-fn: links and references
    public var link: MDColor
    public init(
      ink: MDColor, ink2: MDColor, ink3: MDColor, surface: MDColor, fill: MDColor, codeBlock: MDColor, hair: MDColor,
      line: MDColor, accent: MDColor, accentInk: MDColor, warn: MDColor, link: MDColor
    ) {
      self.ink = ink
      self.ink2 = ink2
      self.ink3 = ink3
      self.surface = surface
      self.fill = fill
      self.codeBlock = codeBlock
      self.hair = hair
      self.line = line
      self.accent = accent
      self.accentInk = accentInk
      self.warn = warn
      self.link = link
    }
  }

  /// Code token colours; a kind with no colour is drawn in `plain`
  public struct CodeColors: Sendable, Hashable {
    public var plain: MDColor
    public var kinds: [MarkdownTokenKind: MDColor]
    public init(plain: MDColor, kinds: [MarkdownTokenKind: MDColor] = [:]) {
      self.plain = plain
      self.kinds = kinds
    }
  }

  public struct MarkColors: Sendable, Hashable {
    /// How ==text== is marked: a highlighter band over its lower part (markdown.css mark), or a brush stroke under it
    /// (Ink Wash: --hl-brush, .42em tall at the bottom)
    public enum HighlightStyle: Sendable, Hashable {
      case band
      case brush(height: Double)
    }
    /// --md-hl, or the brush's colour
    public var highlight: MDColor
    public var highlightStyle: HighlightStyle = .band
    /// --md-annot-blue / purple / orange / green, by name
    public var annotations: [String: MDColor]
    /// a [[reference]]'s seal colours, by the names MarkdownSeal uses
    public var seals: [String: MDColor]
    public init(
      highlight: MDColor, highlightStyle: HighlightStyle = .band, annotations: [String: MDColor],
      seals: [String: MDColor] = [:]
    ) {
      self.highlight = highlight
      self.highlightStyle = highlightStyle
      self.annotations = annotations
      self.seals = seals
    }
  }

  /// --pele-*: Mermaid diagrams
  public struct DiagramColors: Sendable, Hashable {
    public var background, foreground, muted, line, surface, surfaceAlt, border, accent: MDColor
    public var series: [MDColor]
    public init(
      background: MDColor, foreground: MDColor, muted: MDColor, line: MDColor, surface: MDColor, surfaceAlt: MDColor,
      border: MDColor, accent: MDColor, series: [MDColor]
    ) {
      self.background = background
      self.foreground = foreground
      self.muted = muted
      self.line = line
      self.surface = surface
      self.surfaceAlt = surfaceAlt
      self.border = border
      self.accent = accent
      self.series = series
    }
  }

  /// Font families as CSS lists them: the first one that exists draws, the rest are its fallbacks in order (Chinese text
  /// falls back as the web page's does, not as the system would). "-apple-system" is the system font.
  public struct Fonts: Sendable, Hashable {
    /// --sys, --mono, --md-hand
    public var body, mono, hand: [String]
    /// each heading level's family (Warm Ink sets h1 apart); --md-heading-font
    public var headings: [[String]]
    public init(body: [String], mono: [String], headings: [[String]], hand: [String]) {
      self.body = body
      self.mono = mono
      self.headings = headings
      self.hand = hand
    }
  }

  /// Sizes in points at 100 %; a relative size is a multiple of the body size (CSS em)
  public struct Metrics: Sendable, Hashable {
    /// --md-fs
    public var bodySize: Double = 13.5
    /// line-height of body text, as a multiple of its size
    public var lineHeight: Double = 1.6
    /// --md-h1 … --md-h6, em
    public var headingSizes: [Double] = [1.8, 1.35, 1.1, 1, 1, 1]
    /// line-height of each heading level
    public var headingLineHeights: [Double] = [1.25, 1.3, 1.4, 1.4, 1.4, 1.4]
    /// margin-top and margin-bottom of each heading level, px
    public var headingMargins: [[Double]] = [[0, 6], [4, 4], [2, 4], [2, 2], [2, 2], [2, 2]]
    /// font-weight of headings and of strong
    public var headingWeight: Double = 600
    public var strongWeight: Double = 650
    /// a stroke around bold text to thicken it, em (Ink Wash: -webkit-text-stroke .015em; 0: none)
    public var strongStroke: Double = 0
    /// a link's underline: how far below the baseline it sits, px, and its colour's share of the link colour
    /// (.md-link: text-underline-offset 2px, 40 %)
    public var linkUnderlineOffset: Double = 2
    public var linkUnderlineAlpha: Double = 0.4
    /// between a paragraph and the paragraph or block next to it (.md-pp, .md-gap), em
    public var paragraphGap: Double = 0.5
    /// ul/ol padding-left, em; their own margins, px
    public var listIndent: Double = 1.3
    public var listMargin: Double = 2
    /// a task list's padding-left, the box's size and radius, and the gap after it, px
    public var taskIndent: Double = 2
    public var taskBox: Double = 13
    public var taskBoxRadius: Double = 3.5
    public var taskGap: Double = 6
    /// blockquote: padding-left, the bar's width, margins, px
    public var quotePadding: Double = 8
    public var quoteBar: Double = 2
    public var quoteMargin: Double = 2
    /// pre.md-code: font size px, line height, padding (vertical, horizontal), radius, margins
    public var codeSize: Double = 12.5
    public var codeLineHeight: Double = 1.7
    public var codePadding: [Double] = [18, 22]
    public var codeRadius: Double = 12
    public var codeMargin: Double = 10
    /// inline code: font size em, horizontal padding, radius
    public var inlineCodeSize: Double = 11 / 13.5
    public var inlineCodePadding: Double = 3
    public var inlineCodeRadius: Double = 4
    /// kbd: font size em, horizontal padding, radius
    public var kbdSize: Double = 0.85
    public var kbdPadding: Double = 4
    /// table: font size em, cell padding (vertical, horizontal), frame radius, margins, least width
    public var tableSize: Double = 0.95
    public var cellPadding: [Double] = [3, 8]
    public var tableRadius: Double = 6
    public var tableMargin: Double = 4
    public var tableMinWidth: Double = 128
    /// hr: margins
    public var ruleMargin: Double = 8
    /// ==highlight==: where the highlighter starts, as a share of the line from its top
    public var highlightFrom: Double = 0.58
    /// images: margin above and below, corner radius; a caption's size (em), line height and margins
    public var imageMargin: Double = 4
    public var imageRadius: Double = 5
    public var captionSize: Double = 0.76
    public var captionLineHeight: Double = 1.45
    public var captionMargin: [Double] = [5, 2]
    /// an HTML block shown as source: size em
    public var htmlSize: Double = 0.85
    /// --md-radius
    public var radius: Double = 10
    public init() {}

    func em(_ v: Double) -> CGFloat { CGFloat(v * bodySize) }
  }

  public struct Chrome: Sendable, Hashable {
    public var caret, selection, selectionRing: MDColor
    public var popoverBackground, popoverInk, popoverShadow: MDColor
    public init(
      caret: MDColor, selection: MDColor, selectionRing: MDColor, popoverBackground: MDColor, popoverInk: MDColor,
      popoverShadow: MDColor
    ) {
      self.caret = caret
      self.selection = selection
      self.selectionRing = selectionRing
      self.popoverBackground = popoverBackground
      self.popoverInk = popoverInk
      self.popoverShadow = popoverShadow
    }
  }

  public var colors: Colors
  public var code: CodeColors
  public var marks: MarkColors
  public var diagrams: DiagramColors?
  public var fonts: Fonts
  public var metrics: Metrics
  public var chrome: Chrome?

  public init(
    colors: Colors, code: CodeColors, marks: MarkColors, diagrams: DiagramColors? = nil, fonts: Fonts,
    metrics: Metrics = Metrics(), chrome: Chrome? = nil
  ) {
    self.colors = colors
    self.code = code
    self.marks = marks
    self.diagrams = diagrams
    self.fonts = fonts
    self.metrics = metrics
    self.chrome = chrome
  }
}

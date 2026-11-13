import CodeBoardMarkdownUI
import CodeBoardModel
import CoreGraphics

/// The board's looks (Warm Ink, Ink Wash, light and dark) as MarkdownThemes, with the values the web board computes for
/// them (tools/markdown/styles.mjs reads them off the reference page), and each card style's type and box in them
public enum NoteLooks {
  static let sys = ["-apple-system", "PingFang SC"]
  static let serif = ["Source Serif 4", "Songti SC"]
  static let mono = ["JetBrains Mono", "SF Mono", "Menlo"]
  // the variable font names its family after its default instance
  static let hand = ["Shantell Sans Light", "Yozai", "Kaiti SC"]
  /// --display: titles and h1
  static let display = ["Source Serif 4", "Songti SC"]

  public static func theme(_ look: String, dark: Bool) -> MarkdownTheme {
    let c: (String) -> MDColor = { MDColor(hex: $0) }
    let rgba: (Double, Double, Double, Double) -> MDColor = { MDColor($0 / 255, $1 / 255, $2 / 255, $3) }
    let warm = look == "warm-ink"
    let colors: MarkdownTheme.Colors
    switch (warm, dark) {
    case (true, false):
      colors = .init(
        ink: c("#211f1b"), ink2: c("#625e56"), ink3: c("#9a958b"), surface: c("#fdfcfa"), fill: rgba(60, 45, 20, 0.07),
        codeBlock: rgba(245, 243, 239, 1), hair: rgba(60, 45, 20, 0.16), line: rgba(60, 45, 20, 0.09),
        accent: c("#b5552d"),
        accentInk: c("#ffffff"), warn: c("#c48a1f"), link: c("#2e5d86"))
    case (true, true):
      colors = .init(
        ink: c("#ece8e0"), ink2: c("#aca79d"), ink3: c("#78746c"), surface: c("#252422"),
        fill: rgba(255, 240, 220, 0.07),
        codeBlock: rgba(43, 42, 39, 1), hair: rgba(255, 240, 220, 0.11), line: rgba(255, 240, 220, 0.07),
        accent: c("#e3895f"),
        accentInk: c("#1d1c1a"), warn: c("#e0b055"), link: c("#86b4de"))
    case (false, false):
      colors = .init(
        ink: c("#1d1c1a"), ink2: c("#4c4943"), ink3: c("#9a958b"), surface: c("#fdfdfb"), fill: rgba(29, 28, 26, 0.06),
        codeBlock: rgba(29, 28, 26, 0.06), hair: rgba(29, 28, 26, 0.16), line: rgba(29, 28, 26, 0.08),
        accent: c("#b8321f"),
        accentInk: c("#fdfdfb"), warn: c("#b8321f"), link: c("#2d5b70"))
    case (false, true):
      colors = .init(
        ink: c("#e9e5da"), ink2: c("#e9e5da"), ink3: c("#6e6a62"), surface: c("#1c1b19"),
        fill: rgba(233, 229, 218, 0.07),
        codeBlock: rgba(233, 229, 218, 0.07), hair: rgba(233, 229, 218, 0.14), line: rgba(233, 229, 218, 0.07),
        accent: c("#d6533a"), accentInk: c("#131312"), warn: c("#d6533a"), link: c("#8fb7c9"))
    }
    let body = warm ? sys : serif
    let headings = warm ? [serif] + Array(repeating: sys, count: 5) : Array(repeating: serif, count: 6)
    let hl =
      warm
      ? (dark ? rgba(224, 176, 85, 0.28) : rgba(238, 200, 100, 0.3))
      : (dark ? rgba(214, 180, 110, 0.24) : rgba(226, 190, 110, 0.3))
    let annots: [String: MDColor] =
      dark
      ? ["blue": c("#7fb0e0"), "purple": c("#b89be6"), "orange": c("#e3955a"), "green": c("#96c47e")]
      : ["blue": c("#3a72aa"), "purple": c("#7d55b0"), "orange": c("#c46a2a"), "green": c("#4c8a3a")]
    var metrics = MarkdownTheme.Metrics()
    // --md-radius is the board's --r-card: Warm Ink's rounded cards, Ink Wash's nearly square sheets
    metrics.radius = warm ? 12.5 : 2
    if !warm {
      // Ink Wash: bold at 700 with a thin stroke (themes.css), ==text== as a vermilion brush stroke
      metrics.strongWeight = 700
      metrics.strongStroke = 0.015
    }
    let marks: MarkdownTheme.MarkColors =
      warm
      ? .init(highlight: hl, annotations: annots, seals: seals(dark: dark))
      : .init(
        highlight: colors.accent.alpha(0.55), highlightStyle: .brush(height: 0.42), annotations: annots,
        seals: seals(dark: dark))
    // markdown.css .mmd: pele's colours from the theme (surfaces are the ink mixed into the paper)
    func mix(_ k: Double) -> MDColor {
      let a = colors.ink
      let b = colors.surface
      return MDColor(b.r + (a.r - b.r) * k, b.g + (a.g - b.g) * k, b.b + (a.b - b.b) * k, 1)
    }
    let diagrams = MarkdownTheme.DiagramColors(
      background: colors.surface, foreground: colors.ink, muted: colors.ink2, line: colors.ink2, surface: mix(0.05),
      surfaceAlt: mix(0.1), border: mix(0.2), accent: colors.accent, series: [])
    return MarkdownTheme(
      colors: colors, code: code(warm: warm, dark: dark, plain: colors.ink), marks: marks, diagrams: diagrams,
      fonts: .init(body: body, mono: mono, headings: headings, hand: hand),
      metrics: metrics)
  }

  /// --seal-<name> (styles.css), the same in every look
  static func seals(dark: Bool) -> [String: MDColor] {
    let light = [
      "vermilion": "#945b4a", "amber": "#7d6635", "olive": "#59633f", "teal": "#3b6461", "ink": "#4c6383",
      "plum": "#715474", "rose": "#94616e", "graphite": "#5b5752",
    ]
    let night = [
      "vermilion": "#c69281", "amber": "#baa475", "olive": "#9ea67f", "teal": "#7ca7a2", "ink": "#9cb0ca",
      "plum": "#b79cb9", "rose": "#cea4ae", "graphite": "#aba69e",
    ]
    return (dark ? night : light).mapValues { MDColor(hex: $0) }
  }

  /// A Note's code block colours: Warm Ink's own (--nc-*, comments upright), else the look's code colours (--k-*, the
  /// canvas's code cards use the same), comments in italic
  static func code(warm: Bool, dark: Bool, plain: MDColor) -> MarkdownTheme.CodeColors {
    let c: (String) -> MDColor = { MDColor(hex: $0) }
    let k: [MarkdownTokenKind: String]
    switch (warm, dark) {
    case (true, false):
      k = [
        .keyword: "#1f6fa8", .operator: "#9a6a2c", .function: "#d03b5c", .string: "#4a7a2c", .comment: "#66758a",
        .number: "#a3166b", .receiver: "#7a4f9a", .punctuation: "#8a857c",
      ]
    case (true, true):
      k = [
        .keyword: "#7db4e4", .operator: "#d6a86a", .function: "#f07c95", .string: "#a3c98c", .comment: "#8b95a5",
        .number: "#e08cc0", .receiver: "#c8a3e6", .punctuation: "#8f8a80",
      ]
    case (false, false):
      k = [
        .keyword: "#1d1c1a", .operator: "#1d1c1a", .function: "#2d5b70", .string: "#9a5a2c", .comment: "#9a958b",
        .number: "#9a5a2c", .receiver: "#4c4943", .punctuation: "#9a958b",
      ]
    case (false, true):
      k = [
        .keyword: "#e9e5da", .operator: "#e9e5da", .function: "#8fb7c9", .string: "#d39a6c", .comment: "#6e6a62",
        .number: "#d39a6c", .receiver: "#b9b4a8", .punctuation: "#8a857c",
      ]
    }
    // Ink Wash's keywords are semibold (--kw-w)
    return .init(plain: plain, kinds: k.mapValues(c), italicComments: !warm, keywordWeight: warm ? nil : 600)
  }

  /// How a card style sets its text: the theme it is laid out in, where the text sits in the card (the header the canvas
  /// draws, the padding: top, right, bottom, left), whether it is Markdown, and whether it is centred down a taller box
  public struct Card: Sendable, Hashable {
    public var theme: MarkdownTheme
    public var header: CGFloat
    public var padding: [CGFloat]
    /// a Free Text: the text as written, not Markdown, as wide as its widest line
    public var plain: Bool
    /// a Box: its text in the middle of a box taller than it
    public var middle: Bool
    /// the least height of its content: a line of the text's size (the editor's 1.6em, a Free Text's 1.4em)
    public var minContent: CGFloat
  }

  /// the levels of a Free Text: body, H1, H2, H3, and each one's default size
  static let freeTextSizes: [Double] = [20, 40, 30, 24]
  static let handWeights: [NoteStyle.HandWeight: Double] = [.light: 300, .regular: 400, .bold: 700]

  /// The card a style draws (styles.css .card.note / .text / .box / .mark / .freetext and their .tx type, themes.css)
  public static func card(_ style: NoteStyle, look: String, dark: Bool) -> Card {
    var t = theme(look, dark: dark)
    let warm = look == "warm-ink"
    let sys = warm ? Self.sys : Self.serif
    // .tx h1 is --display, the others --note-h (the body's family in Ink Wash)
    let textHeadings = [display] + Array(repeating: warm ? Self.sys : display, count: 5)
    func type(_ families: [String], _ size: Double, _ lineHeight: Double, _ weight: Double, tracking: Double = 0) {
      t.fonts.body = families
      t.fonts.headings = textHeadings
      t.metrics.bodySize = size
      t.metrics.lineHeight = lineHeight
      t.metrics.bodyWeight = weight
      t.metrics.tracking = tracking
      // inline code is 11px whatever the text's size (.tx code)
      t.metrics.inlineCodeSize = 11 / size
    }
    /// .st-title: Warm Ink's semibold serif, Ink Wash's regular one spaced out
    func title(_ size: Double, weight: Double? = nil) {
      if warm {
        type(display, size, 1.25, weight ?? 600, tracking: -0.01 * size)
      } else {
        type(display, size, 1.2, weight ?? 400, tracking: 0.02 * size)
      }
    }
    let text: [CGFloat] = [2, 4, 2, 4]
    /// the editor's least height: one line of the text's size at 1.6 (.md-pm)
    func line(_ t: MarkdownTheme) -> CGFloat { 1.6 * t.metrics.bodySize }
    switch style {
    case .note:
      return Card(theme: t, header: 36, padding: [10, 14, 12, 14], plain: false, middle: false, minContent: 1.6 * 13.5)
    case .text(let size, let bold):
      switch size {
      // .st-title: 26px in Warm Ink, 30px in Ink Wash
      case .title: title(warm ? 26 : 30)
      case .heading: type(sys, 16, 1.4, 600)
      case .body: type(sys, 13.5, 1.6, bold ? 650 : 400)
      }
      if bold && size != .body { t.metrics.bodyWeight = 650 }
      return Card(theme: t, header: 0, padding: text, plain: false, middle: false, minContent: line(t))
    case .box:
      type(sys, 13.5, 1.45, 500)
      t.metrics.center = true
      return Card(theme: t, header: 0, padding: [8, 14, 8, 14], plain: false, middle: true, minContent: line(t))
    case .mark(let color, let weight, let fontSize):
      let w = handWeights[weight] ?? 400
      type(hand, fontSize ?? 18, 1.3, w)
      // a heading takes the Mark's weight, in the board's ink
      t.metrics.headingWeight = w
      t.colors.heading = t.colors.ink
      t.colors.ink = t.marks.annotations[color.rawValue] ?? t.colors.ink
      return Card(theme: t, header: 0, padding: text, plain: false, middle: false, minContent: line(t))
    case .freeText(let level, let bold, let fontSize):
      let l = min(3, max(0, level))
      let size = fontSize ?? freeTextSizes[l]
      switch l {
      case 1, 2: title(size, weight: bold ? 700 : nil)
      case 3: type(sys, size, 1.4, bold ? 700 : 600)
      default: type(sys, size, 1.6, bold ? 700 : 400)
      }
      return Card(theme: t, header: 0, padding: text, plain: true, middle: false, minContent: 1.4 * size)
    }
  }
}

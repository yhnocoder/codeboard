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

  /// --hlrow: the faint band behind code in a Text or Box (and inline code everywhere)
  static func hlrow(warm: Bool, dark: Bool) -> MDColor {
    switch (warm, dark) {
    case (true, false): MDColor(60 / 255, 45 / 255, 20 / 255, 0.07)
    case (true, true): MDColor(1, 240 / 255, 220 / 255, 0.07)
    case (false, false): MDColor(29 / 255, 28 / 255, 26 / 255, 0.06)
    case (false, true): MDColor(233 / 255, 229 / 255, 218 / 255, 0.07)
    }
  }

  /// The canvas's code colours (--k-kw, --k-fn, --k-str, --k-com, --k-num, --k-self, --k-p), which a Text's or Box's code
  /// block takes; an operator is a keyword's colour
  static func boardCode(warm: Bool, dark: Bool, plain: MDColor) -> MarkdownTheme.CodeColors {
    let v: [String]
    switch (warm, dark) {
    case (true, false): v = ["#9a3f22", "#2e5d86", "#4a7536", "#9a958a", "#8a6416", "#7a4f9a", "#6f6a62"]
    case (true, true): v = ["#e59572", "#86b4de", "#a3c98c", "#7d786e", "#d9b36a", "#c8a3e6", "#a39e93"]
    case (false, false): v = ["#1d1c1a", "#2d5b70", "#9a5a2c", "#9a958b", "#9a5a2c", "#4c4943", "#9a958b"]
    case (false, true): v = ["#e9e5da", "#8fb7c9", "#d39a6c", "#6e6a62", "#d39a6c", "#b9b4a8", "#8a857c"]
    }
    let c = v.map { MDColor(hex: $0) }
    let kinds: [MarkdownTokenKind: MDColor] = [
      .keyword: c[0], .operator: c[0], .function: c[1], .string: c[2], .comment: c[3], .number: c[4],
      .receiver: c[5], .punctuation: c[6],
    ]
    return .init(plain: plain, kinds: kinds, italicComments: !warm, keywordWeight: warm ? nil : 600)
  }

  /// How a card style sets its text: the theme it is laid out in, where the text sits in the card (the header the canvas
  /// draws, the padding: top, right, bottom, left), whether it is as wide as its text, and whether it keeps a stored height
  public struct Card: Sendable, Hashable {
    public var theme: MarkdownTheme
    public var header: CGFloat
    public var padding: [CGFloat]
    /// a Text or Box that does not wrap: as wide as its widest line (styles.css .card.text:not(.wrapw), max-content)
    public var natural: Bool
    /// a Note: a stored height is its height; a Text's or Box's height always follows its text
    public var fixedHeight: Bool
    /// the least height of its content: a line of the text's size (the editor's 1.6em)
    public var minContent: CGFloat
  }

  /// The card a style draws (styles.css .card.note, and .card.text .tx.tb for a Text or Box: Markdown at the card's own
  /// size --tfs, headings 1.8 / 1.35 / 1.1 em, code 0.82 em; themes.css for the look's fonts)
  public static func card(_ style: NoteStyle, look: String, dark: Bool) -> Card {
    var t = theme(look, dark: dark)
    let warm = look == "warm-ink"
    let sys = warm ? Self.sys : Self.serif
    switch style {
    case .note:
      return Card(
        theme: t, header: 36, padding: [10, 14, 12, 14], natural: false, fixedHeight: true, minContent: 1.6 * 13.5)
    case .text, .box:
      let size = style.textSize ?? NoteStyle.defaultTextSize
      // .tx.st-body at --tfs: the look's body family, 1.6, regular; .tx h1 is --display, the others --note-h (the
      // body's family in Ink Wash)
      t.fonts.body = sys
      t.fonts.headings = [display] + Array(repeating: warm ? Self.sys : display, count: 5)
      t.metrics.bodySize = size
      t.metrics.lineHeight = 1.6
      t.metrics.bodyWeight = 400
      t.metrics.tracking = 0
      // :root .card.text .tx.tb :is(code, pre) { font-size: 0.82em }; a code block is the plain .tx pre (padding 6px 8px,
      // radius 7, margin 4px 0, line-height 1.5, --hlrow) in the canvas's code colours (--k-*), not a Note's panel
      t.metrics.inlineCodeSize = 0.82
      t.metrics.codeSize = 0.82 * size
      t.metrics.codeLineHeight = 1.5
      t.metrics.codePadding = [6, 8]
      t.metrics.codeRadius = 7
      t.metrics.codeMargin = 4
      t.colors.codeBlock = hlrow(warm: warm, dark: dark)
      t.code = boardCode(warm: warm, dark: dark, plain: t.colors.ink)
      let box: Bool
      if case .box = style { box = true } else { box = false }
      // .card.text.box .tx.tb { text-align: center } (lists, code, tables and quotes stay left)
      t.metrics.center = box
      return Card(
        theme: t, header: 0, padding: box ? [8, 14, 8, 14] : [2, 4, 2, 4], natural: !style.wraps, fixedHeight: false,
        minContent: 1.6 * size)
    }
  }
}

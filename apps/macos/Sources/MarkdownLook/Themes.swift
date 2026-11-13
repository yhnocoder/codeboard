import AppKit
import CodeBoardMarkdownUI
import CoreText

/// The board's looks as MarkdownThemes, with the values the Note page computes (tools/markdown/styles.mjs); the canvas
/// will make these from its own Theme
enum Looks {
  static let sys = ["-apple-system", "PingFang SC"]
  static let serif = ["Source Serif 4", "Songti SC"]
  static let mono = ["JetBrains Mono", "SF Mono", "Menlo"]
  static let hand = ["Shantell Sans", "Kaiti SC"]

  static func theme(_ look: String, dark: Bool) -> MarkdownTheme {
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
    if !warm {
      // Ink Wash: bold at 700 with a thin stroke (themes.css), ==text== as a vermilion brush stroke
      metrics.strongWeight = 700
      metrics.strongStroke = 0.015
    }
    let marks: MarkdownTheme.MarkColors =
      warm
      ? .init(highlight: hl, annotations: annots)
      : .init(highlight: colors.accent.alpha(0.55), highlightStyle: .brush(height: 0.42), annotations: annots)
    return MarkdownTheme(
      colors: colors, code: .init(plain: colors.ink), marks: marks,
      fonts: .init(body: body, mono: mono, headings: headings, hand: hand),
      metrics: metrics)
  }

  /// the board's font files, from the Note page build (apps/macos/web/dist/assets), for this process. Registered by URL,
  /// which is synchronous: CTFontManagerRegisterFontDescriptors finishes later, and a layout made before then falls back
  /// to other fonts
  static func registerFonts(_ folder: URL) {
    let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
    for f in files where f.pathExtension == "woff2" && !f.lastPathComponent.hasPrefix("KaTeX") {
      CTFontManagerRegisterFontsForURL(f as CFURL, .process, nil)
    }
  }
}

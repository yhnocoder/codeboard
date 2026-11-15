import Foundation

extension MarkdownTheme {
  /// A plain look to start from, light or dark: the theme of @yhnocoder/markdown's demo page (its demo.css),
  /// in the system's fonts only, so it needs no font files. For trying the component, its bench and its tests; a host
  /// gives its own
  public static func sample(dark: Bool) -> MarkdownTheme {
    let c: (String) -> MDColor = { MDColor(hex: $0) }
    let tint: (Double) -> MDColor = {
      dark ? MDColor(1, 245 / 255, 225 / 255, $0) : MDColor(60 / 255, 45 / 255, 20 / 255, $0)
    }
    let colors =
      dark
      ? Colors(
        ink: c("#ece8e1"), ink2: c("#b4aea3"), ink3: c("#7d786f"), surface: c("#252421"), fill: tint(0.07),
        codeBlock: tint(0.07), hair: tint(0.15), line: tint(0.08), accent: c("#e0835a"), accentInk: c("#1b1a18"),
        warn: c("#e0a83c"), link: c("#7fb0de"))
      : Colors(
        ink: c("#211f1b"), ink2: c("#625e56"), ink3: c("#9a958b"), surface: c("#fdfcfa"), fill: tint(0.07),
        codeBlock: tint(0.07), hair: tint(0.16), line: tint(0.09), accent: c("#b5552d"), accentInk: c("#ffffff"),
        warn: c("#c48a1f"), link: c("#2e5d86"))
    // --k-kw --k-fn --k-str --k-com --k-num --k-self; an operator a keyword's colour, punctuation the faint ink
    let k =
      (dark
      ? ["#e08a6a", "#7fb0de", "#9ccc7e", "#7d786f", "#d9b45f", "#c19be0"]
      : ["#9a3f22", "#2e5d86", "#4a7536", "#9a958a", "#8a6416", "#7a4f9a"]).map(c)
    let code = CodeColors(
      plain: colors.ink,
      kinds: [
        .keyword: k[0], .operator: k[0], .function: k[1], .string: k[2], .comment: k[3], .number: k[4],
        .receiver: k[5], .punctuation: colors.ink3,
      ])
    let annotations: [String: MDColor] =
      (dark
      ? ["blue": "#7fa9d9", "purple": "#b89be6", "orange": "#e0905a", "green": "#8cc070"]
      : ["blue": "#3a72aa", "purple": "#7d55b0", "orange": "#c46a2a", "green": "#4c8a3a"]).mapValues(c)
    let marks = MarkColors(
      highlight: dark ? MDColor(224 / 255, 176 / 255, 85 / 255, 0.28) : MDColor(238 / 255, 200 / 255, 100 / 255, 0.3),
      annotations: annotations)
    func mix(_ t: Double) -> MDColor {
      let (a, b) = (colors.ink, colors.surface)
      return MDColor(b.r + (a.r - b.r) * t, b.g + (a.g - b.g) * t, b.b + (a.b - b.b) * t, 1)
    }
    let diagrams = DiagramColors(
      background: colors.surface, foreground: colors.ink, muted: colors.ink2, line: colors.ink2, surface: mix(0.05),
      surfaceAlt: mix(0.1), border: mix(0.2), accent: colors.accent, series: [])
    let sys = ["-apple-system", "PingFang SC"]
    return MarkdownTheme(
      colors: colors, code: code, marks: marks, diagrams: diagrams,
      fonts: .init(
        body: sys, mono: ["SF Mono", "Menlo"], headings: Array(repeating: sys, count: 6), hand: []))
  }
}

// Warm Ink with Liquid Glass: the system's sidebar material and glass toolbar, ⌘K on glass under a mostly solid backdrop.
import AppKit

extension Chrome {
  static let warmInkGlass = Chrome(
    id: "warm-ink-glass", name: "Warm Ink + Liquid Glass", board: "warm-ink", glass: true, glassStyle: .clear,
    accent: Theme.c("accent", look: "warm-ink"),
    tint: Theme.c("accent", look: "warm-ink", alpha: (0.13, 0.20)),
    content: Theme.c("bg", look: "warm-ink", mix: ("surface", 0.5)),
    sidebar: nil,
    toolbar: nil,
    panel: .clear,
    surface: Theme.c("surface", look: "warm-ink"),
    hair: Theme.c("hair", look: "warm-ink"),
    serif: false)
}

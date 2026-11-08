// Ink Wash with Liquid Glass: the system's sidebar material and glass toolbar, ⌘K on glass under a mostly solid backdrop.
import AppKit

extension Chrome {
  static let inkWashGlass = Chrome(
    id: "ink-wash-glass", name: "Ink Wash + Liquid Glass", board: "ink-wash", glass: true, glassStyle: .clear,
    accent: Theme.c("accent", look: "ink-wash"),
    tint: Theme.c("accent", look: "ink-wash", alpha: (0.13, 0.20)),
    content: Theme.c("bg", look: "ink-wash", mix: ("surface", 0.5)),
    sidebar: nil,
    toolbar: nil,
    panel: .clear,
    surface: Theme.c("surface", look: "ink-wash"),
    hair: Theme.c("hair", look: "ink-wash"),
    serif: false)
}

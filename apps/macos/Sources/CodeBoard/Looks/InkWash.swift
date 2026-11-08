// Ink Wash with solid chrome: the board's paper and ink, no glass (the designer's values replace these when they come).
import AppKit

extension Chrome {
  static let inkWash = Chrome(
    id: "ink-wash", name: "Ink Wash", board: "ink-wash", glass: false, glassStyle: .regular,
    accent: Theme.c("accent", look: "ink-wash"),
    tint: Theme.c("accent", look: "ink-wash", alpha: (0.13, 0.20)),
    content: Theme.c("bg", look: "ink-wash", mix: ("surface", 0.5)),
    sidebar: Theme.c("bg", look: "ink-wash"),
    toolbar: Theme.c("bg", look: "ink-wash", mix: ("surface", 0.5)),
    panel: Theme.c("surface", look: "ink-wash"),
    surface: Theme.c("surface", look: "ink-wash"),
    hair: Theme.c("hair", look: "ink-wash"),
    serif: true)
}

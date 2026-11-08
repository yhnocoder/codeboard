// Warm Ink with solid chrome: the board's paper and ink, no glass (the designer's values replace these when they come).
import AppKit

extension Chrome {
  static let warmInk = Chrome(
    id: "warm-ink", name: "Warm Ink", board: "warm-ink", glass: false, glassStyle: .regular,
    accent: Theme.c("accent", look: "warm-ink"),
    tint: Theme.c("accent", look: "warm-ink", alpha: (0.13, 0.20)),
    content: Theme.c("bg", look: "warm-ink", mix: ("surface", 0.5)),
    sidebar: Theme.c("bg", look: "warm-ink"),
    toolbar: Theme.c("bg", look: "warm-ink", mix: ("surface", 0.5)),
    panel: Theme.c("surface", look: "warm-ink"),
    surface: Theme.c("surface", look: "warm-ink"),
    hair: Theme.c("hair", look: "warm-ink"),
    serif: false)
}

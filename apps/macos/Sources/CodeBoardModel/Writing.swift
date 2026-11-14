import Foundation

// Notes, Texts and Boxes: making one, writing it, and a Text's or Box's size, look and fill (core commands/notes.ts and
// cards.ts writeNote). Pure, as the other commands: the shell measures (where the first letter of a Text lands as a Box)
// and passes what it measured.

extension Board {
  /// A new Note's width, and a new Text's or Box's (as wide as its text until a side is dragged; notes.ts NEW_CARD_W,
  /// NEW_TEXT_W)
  public static let newNoteWidth = 381.0
  public static let newTextWidth = 200.0

  /// What a new card is
  public enum Writing: Sendable {
    case note
    case text(TextCard.Look)
  }

  /// An empty Note, Text or Box with its top left corner at (x, y)
  public static func newCard(_ kind: Writing, id: CardID, x: Double, y: Double) -> Card {
    switch kind {
    case .note:
      Card(id: id, x: x, y: y, width: newNoteWidth, content: .own(CardContent(body: .note(Note(text: "")))))
    case .text(let look):
      Card(
        id: id, x: x, y: y, width: newTextWidth, content: .own(CardContent(body: .text(TextCard(text: "", look: look))))
      )
    }
  }

  /// A Note's, Text's or Box's Markdown and layout as written; one written empty goes (cards.ts writeNote)
  public mutating func write(_ id: CardID, text: String, layout: NoteLayout?) {
    guard let i = cards.firstIndex(where: { $0.id == id }), case .own(var c) = cards[i].content else { return }
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      delete([.card(id)])
      return
    }
    switch c.body {
    case .note(var n):
      n.text = text
      n.layout = layout
      c.body = .note(n)
    case .text(var t):
      t.text = text
      t.layout = layout
      c.body = .text(t)
    default: return
    }
    cards[i].content = .own(c)
    selfCheck()
  }

  /// A Text's or Box's own content, changed by `f` with its card (the card's placement only)
  private mutating func changeText(_ id: CardID, _ f: (inout TextCard, inout Card) -> Void) {
    guard let i = cards.firstIndex(where: { $0.id == id }), case .own(var c) = cards[i].content,
      case .text(var t) = c.body
    else { return }
    var card = cards[i]
    f(&t, &card)
    c.body = .text(t)
    card.content = .own(c)
    cards[i] = card
    selfCheck()
  }

  /// S, M, L, XL or any size: a Text that wraps keeps its line breaks (its width scales with it); its top left stays
  /// (notes.ts setTextSize)
  public mutating func setTextSize(_ id: CardID, _ fontSize: Double) {
    changeText(id) { t, card in
      let fs = min(TextCard.fontSizes.upperBound, max(TextCard.fontSizes.lowerBound, fontSize))
      guard fs != t.fontSize else { return }
      if t.wrap { card.width = max(1, (card.width * fs / t.fontSize).rounded()) }
      t.fontSize = fs
    }
  }

  /// A Text into a Box or back, its top left at (x, y) and, when it wraps, `width` wide, as measured so its first
  /// letter does not move (notes.ts setTextLook). A Text keeps the fill it had as a Box
  public mutating func setTextLook(_ id: CardID, _ look: TextCard.Look, x: Double, y: Double, width: Double?) {
    changeText(id) { t, card in
      guard t.look != look else { return }
      t.look = look
      card.x = (x * 100).rounded() / 100
      card.y = (y * 100).rounded() / 100
      if let width { card.width = (width * 100).rounded() / 100 }
    }
  }

  /// A Box's fill (a Text has none to change)
  public mutating func setBoxFill(_ id: CardID, _ fill: BoxFill) {
    changeText(id) { t, _ in
      guard t.look == .box else { return }
      t.fill = fill
    }
  }
}

extension Card {
  /// A Note's, Text's or Box's Markdown; nil for any other kind
  public var writing: String? {
    guard case .own(let c) = content else { return nil }
    switch c.body {
    case .note(let n): return n.text
    case .text(let t): return t.text
    default: return nil
    }
  }

  /// A Text's or Box's own content
  public var textCard: TextCard? {
    if case .own(let c) = content, case .text(let t) = c.body { t } else { nil }
  }
}

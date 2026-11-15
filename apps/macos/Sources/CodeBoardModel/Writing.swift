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

  /// An empty Free code card with its top left corner at (x, y): a Note's width, Python (create.ts newFreeCode)
  public static func newFreeCode(id: CardID, x: Double, y: Double) -> Card {
    let seg = Segment(
      id: SegmentID(rawValue: Board.newID("s")), source: nil, language: "python", firstLine: 1, lines: [""])
    return Card(
      id: id, x: x, y: y, width: newNoteWidth, content: .own(CardContent(body: .code(CodeCard(segments: [seg])))))
  }

  /// A card's title as written; blank or the card's own title is none. [[references]] to its old name follow
  /// (cards.ts renameCard)
  public mutating func renameCard(_ id: CardID, _ title: String) {
    guard let i = cards.firstIndex(where: { $0.id == id }), case .own(var c) = cards[i].content else { return }
    let old = cardTitle(c).trimmingCharacters(in: .whitespacesAndNewlines)
    let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
    c.title = nil
    if !t.isEmpty && t != cardTitle(c) { c.title = t }
    cards[i].content = .own(c)
    renameTitleRefs(from: old, to: cardTitle(c).trimmingCharacters(in: .whitespacesAndNewlines))
  }

  /// A card's description as written, its Markdown trimmed; blank is none (cards.ts setCardDesc)
  public mutating func setDescription(_ id: CardID, _ text: String) {
    guard let i = cards.firstIndex(where: { $0.id == id }), case .own(var c) = cards[i].content else { return }
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    c.description = t.isEmpty ? nil : t
    cards[i].content = .own(c)
  }

  /// edit/notes.ts renameTitleRefs: references by title to the old name ([[old]], no id, any case) follow wherever the
  /// board keeps Markdown (mdrefs.ts eachMarkdown), and only where a reference is read, so not in code
  mutating func renameTitleRefs(from: String, to: String) {
    guard !from.isEmpty, from != to, !to.contains(where: { "[]\n".contains($0) }) else { return }
    let old = from.lowercased()
    func follow(_ md: String) -> String {
      LegacyUpgrade.mapRefs(md) { label, target in target == nil && label.lowercased() == old ? "[[\(to)]]" : nil }
    }
    for i in cards.indices {
      guard case .own(var c) = cards[i].content else { continue }
      switch c.body {
      case .note(var n):
        n.text = follow(n.text)
        c.body = .note(n)
      case .text(var t):
        t.text = follow(t.text)
        c.body = .text(t)
      default: break
      }
      c.description = c.description.map(follow)
      cards[i].content = .own(c)
    }
    for i in sidenotes.indices {
      guard case .text(var n) = sidenotes[i].body else { continue }
      n.text = follow(n.text)
      if var q = n.question {
        for k in q.answers.indices { q.answers[k].text = follow(q.answers[k].text) }
        n.question = q
      }
      sidenotes[i].body = .text(n)
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

/// A Note's leading heading, its inline marks taken off ("" when its first line with text is not an ATX heading): the
/// title its header shows when it has none of its own (core mdHeading)
public func mdHeading(_ md: String) -> String {
  guard let line = md.components(separatedBy: "\n").lazy.map(jsTrim).first(where: { !$0.isEmpty }),
    let m = re(#"^#{1,6}\s+(.*?)(?:\s+#+)?$"#).exec(line)
  else { return "" }
  var t = re(#"!?\[([^\]]*)\]\([^)]*\)"#).replace(m[1]) { $0[1] }
  t = re(#"(\*\*|__|~~|`|\*|_)(?=\S)(.+?)(?<=\S)\1"#).replace(t) { $0[2] }
  return jsTrim(re(#"\$+"#).replace(t) { _ in "" })
}

extension CardContent {
  /// What a Note's header shows: its own title, else its leading heading; nil for neither (a Note shows "Note")
  public var noteTitle: String? {
    guard case .note(let n) = body else { return nil }
    if let t = title, !t.isEmpty { return t }
    let h = mdHeading(n.text)
    return h.isEmpty ? nil : h
  }

  /// A Note whose header shows its leading heading: the body does not show it again; it is there when written in
  /// (board NoteBody hidesHeading, with Settings → Notes → heading in body off)
  public var hidesHeading: Bool {
    guard case .note(let n) = body, (title ?? "").isEmpty else { return false }
    return !mdHeading(n.text).isEmpty
  }
}

import Foundation

/// What Copy puts on the pasteboard: cards (main's copies take only cards: actions/shared.ts copyCardsSel, selHosts),
/// the arrows between them and the sidenotes that travel with them (not one kept to the board), every card with its
/// content (a shared card's content and travelling sidenotes copied in), and the board they were copied from. No
/// sticker: main's copies take none (core placeCards).
/// Pasted on that board they are copies; on another, by default, the same cards shared by both (FORMAT.md)
public struct Clip: Codable, Equatable, Sendable {
  public static let pasteboardType = "com.yhnocoder.codeboard.clip"

  /// The board it was copied from
  public var board: BoardID?
  public var cards: [Card]
  public var arrows: [Arrow]
  public var sidenotes: [Sidenote]

  public var isEmpty: Bool { cards.isEmpty }

  public func encoded() throws -> Data { try canonicalJSON(self) }
  public init(decoding data: Data) throws { self = try JSONDecoder().decode(Clip.self, from: data) }

  init(cards: [Card], arrows: [Arrow], sidenotes: [Sidenote]) {
    self.cards = cards
    self.arrows = arrows
    self.sidenotes = sidenotes
  }

  /// Where it covers, in board units
  public var bounds: (x: Double, y: Double, maxX: Double, maxY: Double)? {
    let rects = cards.map { ($0.x, $0.y, $0.x + $0.width, $0.y + ($0.height ?? $0.measuredHeight ?? 0)) }
    guard let first = rects.first else { return nil }
    return rects.dropFirst().reduce(first) { a, r in (min(a.0, r.0), min(a.1, r.1), max(a.2, r.2), max(a.3, r.3)) }
  }
}

extension Board {
  /// A copy of the cards `ids`: the arrows with both ends among them, or with `touching` every arrow with an end on one
  /// (what a cut takes: actions/shared.ts cutCardsSel), and their sidenotes but those kept to this board (core
  /// cardCopies: sharedOf, travels). `shared` reads a shared card's file; one that cannot be read is left out
  public func clip(_ ids: Set<CardID>, touching: Bool = false, shared: (CardID) -> SharedCard?) -> Clip {
    var ids = ids.filter { card($0) != nil }
    var out: [Card] = []
    var notes: [Sidenote] = []
    for c in cards where ids.contains(c.id) {
      var copy = c
      copy.same = nil
      copy.section = nil
      // a copy of an automatic card is a plain one (a subfolder's has no plain form, and is not copied)
      if case .own(var content) = c.content, case .board(var s) = content.body, s.auto {
        guard s.board != nil else {
          ids.remove(c.id)
          continue
        }
        s.auto = false
        content.body = .board(s)
        copy.content = .own(content)
      }
      if case .shared = c.content {
        guard let sc = shared(c.id) else {
          ids.remove(c.id)
          continue
        }
        copy.content = .own(sc.content)
        notes += sc.sidenotes
      }
      out.append(copy)
    }
    notes += sidenotes.filter { n in n.anchor.card.map(ids.contains) == true && !n.boardOnly }
    let taken = arrows.filter {
      touching
        ? ids.contains($0.from.card) || ids.contains($0.to.card)
        : ids.contains($0.from.card) && ids.contains($0.to.card)
    }
    var clip = Clip(cards: out, arrows: taken, sidenotes: notes)
    clip.board = id
    return clip
  }

  /// Puts copies of the cards `clip` holds on the board, moved by (dx, dy), on top, unlocked and with no summary (both
  /// the place's on the board it came from: core placeCards takes a place's x, y, w, h), every id new (`newID` gives
  /// them; segment ids stay, as they are a card's own), with the arrows among them and their sidenotes (core placeCards,
  /// copy true). `back`: the cards put back where they were cut from, with their ids, and the arrows with both ends on
  /// the board again (core placeCards, copy false). `shared`: its cards are the same cards as on the board it was copied
  /// from (their source board made them shared cards first, `share`): they keep their ids and are shared, the sidenotes
  /// that travel with them come along as they are, and one already on this board is left as it is. Returns the cards
  /// made, to select, and each with the one in the clip it was made from (core pasteCards pairs: [new id, original id])
  @discardableResult
  public mutating func paste(
    _ clip: Clip, dx: Double, dy: Double, shared: Bool = false, back: Bool = false,
    newID: (String) -> String = Board.newID
  ) -> (made: Set<Item>, copies: [(copy: CardID, of: CardID)]) {
    let keep = shared || back
    var cardIDs: [CardID: CardID] = [:]
    for c in clip.cards where !(keep && card(c.id) != nil) {
      cardIDs[c.id] = keep ? c.id : CardID(rawValue: newID("c"))
    }
    let had = Set(cards.map(\.id))
    for c in clip.cards {
      guard let id = cardIDs[c.id] else { continue }
      var n = c
      n.id = id
      n.isShared = shared
      n.same = nil
      n.section = nil
      n.x += dx
      n.y += dy
      n.locked = false
      n.summary = nil
      cards.append(n)
    }
    // an end on a card placed now, or put back next to one still here
    func end(_ c: CardID) -> CardID? { cardIDs[c] ?? (back && had.contains(c) ? c : nil) }
    for a in clip.arrows {
      guard let from = end(a.from.card), let to = end(a.to.card) else { continue }
      var n = a
      n.id = ArrowID(rawValue: newID("l"))
      n.from.card = from
      n.to.card = to
      arrows.append(n)
    }
    let noteIDs = Set(sidenotes.map(\.id))
    for s in clip.sidenotes {
      guard case .card(let c, let seg, let lines, let block) = s.anchor, let to = cardIDs[c] else { continue }
      if keep {
        // a shared card's own sidenotes are the same ones on every board it is on; a cut card's come back as they were
        if !s.boardOnly && !noteIDs.contains(s.id) { sidenotes.append(s) }
        continue
      }
      var n = s
      n.anchor = .card(to, segment: seg, lines: lines, block: block)
      n.id = SidenoteID(rawValue: newID("n"))
      n.boardOnly = false
      sidenotes.append(n)
    }
    selfCheck()
    return (
      Set(cardIDs.values.map(Item.card)),
      clip.cards.compactMap { c in cardIDs[c.id].map { ($0, c.id) } }
    )
  }

  /// A new id: the prefix and eight random letters and digits
  public static func newID(_ prefix: String) -> String {
    let chars = Array("abcdefghijklmnopqrstuvwxyz0123456789")
    return prefix + String((0..<8).map { _ in chars.randomElement()! })
  }
}

extension Clip {
  /// Its cards as they are on the board it was copied from once they became shared cards there (`Board.share`), some
  /// with a new id (old → new): what hangs on them following
  public func renamed(_ ids: [CardID: CardID]) -> Clip {
    guard !ids.isEmpty else { return self }
    var b = Board(id: board ?? BoardID(rawValue: ""), cards: cards, arrows: arrows, sidenotes: sidenotes)
    for (old, new) in ids { b.renameCard(old, to: new) }
    var out = self
    (out.cards, out.arrows, out.sidenotes) = (b.cards, b.arrows, b.sidenotes)
    return out
  }
}

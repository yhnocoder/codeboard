import Foundation

/// What Copy puts on the pasteboard: cards and Sections with what hangs on them and the arrows between them, every card
/// with its content (a shared card's content and travelling sidenotes copied in), and the board they were copied from.
/// Pasted on that board they are copies; on another, by default, the same cards shared by both (FORMAT.md)
public struct Clip: Codable, Equatable, Sendable {
  public static let pasteboardType = "com.yhnocoder.codeboard.clip"

  /// The board it was copied from
  public var board: BoardID?
  public var cards: [Card]
  public var sections: [Section]
  public var arrows: [Arrow]
  public var sidenotes: [Sidenote]
  public var stickers: [Sticker]

  public var isEmpty: Bool { cards.isEmpty && sections.isEmpty }

  public func encoded() throws -> Data { try canonicalJSON(self) }
  public init(decoding data: Data) throws { self = try JSONDecoder().decode(Clip.self, from: data) }

  init(cards: [Card], sections: [Section], arrows: [Arrow], sidenotes: [Sidenote], stickers: [Sticker]) {
    self.cards = cards
    self.sections = sections
    self.arrows = arrows
    self.sidenotes = sidenotes
    self.stickers = stickers
  }

  /// Where it covers, in board units
  public var bounds: (x: Double, y: Double, maxX: Double, maxY: Double)? {
    let rects =
      cards.map { ($0.x, $0.y, $0.x + $0.width, $0.y + ($0.height ?? $0.measuredHeight ?? 0)) }
      + sections.map { ($0.x, $0.y, $0.x + $0.width, $0.y + $0.height) }
    guard let first = rects.first else { return nil }
    return rects.dropFirst().reduce(first) { a, r in (min(a.0, r.0), min(a.1, r.1), max(a.2, r.2), max(a.3, r.3)) }
  }
}

extension Board {
  /// A copy of `items`: the cards, each Section with what is inside it, the arrows with both ends among them, the
  /// sidenotes on them and the stickers on their cards. `shared` reads a shared card's file; one that cannot be read is
  /// left out
  public func clip(_ items: Set<Item>, shared: (CardID) -> SharedCard?) -> Clip {
    var secs = Set<SectionID>()
    for case .section(let id) in items where section(id) != nil { secs.formUnion(sectionTree(id)) }
    var ids = Set(members(of: secs))
    for case .card(let id) in items where card(id) != nil { ids.insert(id) }
    var out: [Card] = []
    var notes: [Sidenote] = []
    for c in cards where ids.contains(c.id) {
      var copy = c
      copy.same = nil
      if c.section.map(secs.contains) != true { copy.section = nil }
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
    let sectionList = sections.filter { secs.contains($0.id) }.map { s -> Section in
      var s = s
      if s.parent.map(secs.contains) != true { s.parent = nil }
      return s
    }
    notes += sidenotes.filter { n in
      switch n.anchor {
      case .card(let c, _, _, _): ids.contains(c)
      case .section(let s): secs.contains(s)
      case .point: false
      }
    }
    var clip = Clip(
      cards: out, sections: sectionList,
      arrows: arrows.filter { ids.contains($0.from.card) && ids.contains($0.to.card) }, sidenotes: notes,
      stickers: stickers.filter { $0.anchor.card.map(ids.contains) == true })
    clip.board = id
    return clip
  }

  /// Puts copies of what `clip` holds on the board, moved by (dx, dy), on top, unlocked, every id new (`newID` gives
  /// them; segment ids stay, as they are a card's own). `shared`: its cards are the same cards as on the board it was
  /// copied from (their source board made them shared cards first, `share`): they keep their ids and are shared, the
  /// sidenotes that travel with them come along as they are, and one already on this board is left as it is (core
  /// placeCards, copy false). Returns the cards and Sections made, to select
  @discardableResult
  public mutating func paste(
    _ clip: Clip, dx: Double, dy: Double, shared: Bool = false, newID: (String) -> String = Board.newID
  ) -> Set<Item> {
    var cardIDs: [CardID: CardID] = [:]
    var sectionIDs: [SectionID: SectionID] = [:]
    for c in clip.cards where !(shared && card(c.id) != nil) {
      cardIDs[c.id] = shared ? c.id : CardID(rawValue: newID("c"))
    }
    for s in clip.sections { sectionIDs[s.id] = SectionID(rawValue: newID("g")) }
    for s in clip.sections {
      var n = s
      n.id = sectionIDs[s.id]!
      n.parent = s.parent.flatMap { sectionIDs[$0] }
      n.x += dx
      n.y += dy
      n.locked = false
      sections.append(n)
    }
    for c in clip.cards {
      guard let id = cardIDs[c.id] else { continue }
      var n = c
      n.id = id
      n.isShared = shared
      n.same = nil
      n.section = c.section.flatMap { sectionIDs[$0] }
      n.x += dx
      n.y += dy
      n.locked = false
      cards.append(n)
    }
    for a in clip.arrows {
      guard let from = cardIDs[a.from.card], let to = cardIDs[a.to.card] else { continue }
      var n = a
      n.id = ArrowID(rawValue: newID("l"))
      n.from.card = from
      n.to.card = to
      arrows.append(n)
    }
    let noteIDs = Set(sidenotes.map(\.id))
    for s in clip.sidenotes {
      var n = s
      switch s.anchor {
      case .card(let c, let seg, let lines, let block):
        guard let to = cardIDs[c] else { continue }
        // a shared card's own sidenotes are the same ones on every board it is on
        if shared {
          if !s.boardOnly && !noteIDs.contains(s.id) { sidenotes.append(s) }
          continue
        }
        n.anchor = .card(to, segment: seg, lines: lines, block: block)
      case .section(let sec):
        guard let to = sectionIDs[sec] else { continue }
        n.anchor = .section(to)
      case .point: continue
      }
      n.id = SidenoteID(rawValue: newID("n"))
      n.boardOnly = false
      sidenotes.append(n)
    }
    for k in clip.stickers {
      var n = k
      switch k.anchor {
      case .canvas: continue
      case .card(let c, let x, let y, let size):
        guard let to = cardIDs[c] else { continue }
        n.anchor = .card(to, x: x, y: y, size: size)
      case .line(let c, let seg, let line):
        guard let to = cardIDs[c] else { continue }
        n.anchor = .line(to, segment: seg, line: line)
      }
      n.id = StickerID(rawValue: newID("k"))
      stickers.append(n)
    }
    selfCheck()
    return Set(cardIDs.values.map(Item.card)).union(sectionIDs.values.map(Item.section))
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
    var b = Board(
      id: board ?? BoardID(rawValue: ""), cards: cards, arrows: arrows, sidenotes: sidenotes, stickers: stickers)
    for (old, new) in ids { b.renameCard(old, to: new) }
    var out = self
    (out.cards, out.arrows, out.sidenotes, out.stickers) = (b.cards, b.arrows, b.sidenotes, b.stickers)
    return out
  }
}

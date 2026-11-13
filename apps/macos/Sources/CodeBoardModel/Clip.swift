import Foundation

/// What Copy puts on the pasteboard: cards and Sections with what hangs on them and the arrows between them, every card
/// with its own content (a shared card's content and travelling sidenotes copied in: a paste makes plain copies, FORMAT.md)
public struct Clip: Codable, Equatable, Sendable {
  public static let pasteboardType = "com.yhnocoder.codeboard.clip"

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
      if c.section.map(secs.contains) != true { copy.section = nil }
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
    return Clip(
      cards: out, sections: sectionList,
      arrows: arrows.filter { ids.contains($0.from.card) && ids.contains($0.to.card) }, sidenotes: notes,
      stickers: stickers.filter { $0.anchor.card.map(ids.contains) == true })
  }

  /// Puts copies of what `clip` holds on the board, moved by (dx, dy), on top, unlocked, every id new (`newID` gives
  /// them; segment ids stay, as they are a card's own). Returns the cards and Sections made, to select
  @discardableResult
  public mutating func paste(_ clip: Clip, dx: Double, dy: Double, newID: (String) -> String = Board.newID)
    -> Set<Item>
  {
    var cardIDs: [CardID: CardID] = [:]
    var sectionIDs: [SectionID: SectionID] = [:]
    for c in clip.cards { cardIDs[c.id] = CardID(rawValue: newID("c")) }
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
      var n = c
      n.id = cardIDs[c.id]!
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
    for s in clip.sidenotes {
      var n = s
      switch s.anchor {
      case .card(let c, let seg, let lines, let block):
        guard let to = cardIDs[c] else { continue }
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

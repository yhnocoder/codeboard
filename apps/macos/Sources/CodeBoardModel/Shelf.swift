import Foundation

// The Shelf (core edit/shelf.ts, commands/shelf.ts): cards and Sections put aside with the board, off the canvas, and
// put back. Putting in and taking out move the items between the board and an entry, ids kept, so their sidenotes and
// what refers to them stay as they were.

extension Board {
  /// What putting these on the Shelf takes (shelfPick): the Sections with every Section inside them, the cards given
  /// and the cards in those Sections, in the board's order
  public func shelfPick(cards: Set<CardID>, sections: Set<SectionID>) -> (cards: [CardID], sections: [SectionID]) {
    var secs = sections.filter { section($0) != nil }
    var grew = true
    while grew {
      grew = false
      for s in self.sections where s.parent.map(secs.contains) == true && !secs.contains(s.id) {
        secs.insert(s.id)
        grew = true
      }
    }
    let picked = self.cards.filter { cards.contains($0.id) || $0.section.map(secs.contains) == true }.map(\.id)
    return (picked, self.sections.filter { secs.contains($0.id) }.map(\.id))
  }

  /// Move to Shelf: these cards and Sections (with what is in them) go onto the Shelf as one new entry, with the arrows
  /// touching those cards and the stickers on them. `heights`: what the canvas measured of cards with no height of
  /// their own, kept so their place is known after a reload (Place.mh). False when none of them is on the canvas
  @discardableResult
  public mutating func shelve(
    cards: Set<CardID>, sections: Set<SectionID>, id: String, at: Double, heights: [CardID: Double] = [:]
  ) -> Bool {
    let pick = shelfPick(cards: cards, sections: sections)
    guard !pick.cards.isEmpty || !pick.sections.isEmpty else { return false }
    let ids = Set(pick.cards)
    let secs = Set(pick.sections)
    var e = ShelfEntry(id: id, at: at)
    e.cards = self.cards.filter { ids.contains($0.id) }
    for i in e.cards.indices where e.cards[i].height == nil {
      if let h = heights[e.cards[i].id] { e.cards[i].measuredHeight = h }
    }
    self.cards.removeAll { ids.contains($0.id) }
    e.sections = self.sections.filter { secs.contains($0.id) }
    self.sections.removeAll { secs.contains($0.id) }
    let touches = { (a: Arrow) in ids.contains(a.from.card) || ids.contains(a.to.card) }
    e.arrows = arrows.filter(touches)
    arrows.removeAll(where: touches)
    let goes = { (k: Sticker) in k.anchor.card.map(ids.contains) == true }
    e.stickers = stickers.filter(goes)
    stickers.removeAll(where: goes)
    shelf.append(e)
    selfCheck()
    return true
  }

  /// Put Back, or let go on the board moved by (dx, dy): entry `id` comes off the Shelf, its cards in front of every
  /// card. What was in a Section of the board goes back into it when it returns to its place and that Section is
  /// there; moved, it is in none, or in the one `into` gives it (by card or Section id). An arrow to a card still on
  /// the Shelf stays hidden with that card's entry. The ids that came back, or nil
  @discardableResult
  public mutating func unshelve(
    _ id: String, dx: Double = 0, dy: Double = 0, into: [String: SectionID] = [:]
  ) -> (cards: [CardID], sections: [SectionID])? {
    guard let k = shelf.firstIndex(where: { $0.id == id }) else { return nil }
    let e = shelf.remove(at: k)
    let dx = dx.rounded()
    let dy = dy.rounded()
    let moved = dx != 0 || dy != 0
    let own = Set(e.sections.map(\.id))
    let onBoard = Set(sections.map(\.id))
    func home(_ key: String, _ now: SectionID?) -> SectionID? {
      if let now, own.contains(now) || (!moved && onBoard.contains(now)) { return now }
      return into[key].flatMap { onBoard.contains($0) ? $0 : nil }
    }
    for var s in e.sections {
      s.x += dx
      s.y += dy
      s.parent = home(s.id.rawValue, s.parent)
      sections.append(s)
    }
    // in front of every card: the end of the list
    for var c in e.cards {
      c.x += dx
      c.y += dy
      c.section = home(c.id.rawValue, c.section)
      cards.append(c)
    }
    var held: [CardID: Int] = [:]
    for (i, x) in shelf.enumerated() { for c in x.cards { held[c.id] = i } }
    for a in e.arrows {
      if let i = held[a.from.card] ?? held[a.to.card] {
        shelf[i].arrows.append(a)
      } else {
        arrows.append(a)
      }
    }
    stickers += e.stickers
    selfCheck()
    return (e.cards.map(\.id), e.sections.map(\.id))
  }

  /// Remove from the Shelf: the entry and what is in it are deleted, as Delete deletes cards
  public mutating func removeShelfEntry(_ id: String) {
    shelf.removeAll { $0.id == id }
    prune()
    selfCheck()
  }
}

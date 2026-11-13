import Foundation

// The board's edits as named commands on the model, the rules of core's commands and edit/ (refs.ts, ops.ts) for what the
// app can change so far: move, resize, delete, copy and paste, stacking order, lock, tilt, Section membership. Pure: a
// shell (the canvas, a test, a script) decides what to change and calls these; reference upkeep (what hangs on a deleted
// card or Section, what a merge left dangling) is here and nowhere else. Every command ends with the self-check in debug
// builds and tests: the board must still be one `problem()` accepts.

/// What can be selected and changed as a whole on the canvas
public enum Item: Hashable, Sendable {
  case card(CardID)
  case section(SectionID)
  case arrow(ArrowID)

  public var card: CardID? { if case .card(let id) = self { id } else { nil } }
  public var section: SectionID? { if case .section(let id) = self { id } else { nil } }
  public var arrow: ArrowID? { if case .arrow(let id) = self { id } else { nil } }
}

extension Board {
  // MARK: Looking up

  public func card(_ id: CardID) -> Card? { cards.first { $0.id == id } }
  public func section(_ id: SectionID) -> Section? { sections.first { $0.id == id } }

  /// A Section is locked when it or a Section it is in is (core sectionLocked)
  public func isLocked(section id: SectionID) -> Bool {
    var at: SectionID? = id
    var seen = Set<SectionID>()
    while let s = at.flatMap(section), seen.insert(s.id).inserted {
      if s.locked { return true }
      at = s.parent
    }
    return false
  }

  /// A card is locked when it is, or a Section it is in is
  public func isLocked(_ item: Item) -> Bool {
    switch item {
    case .card(let id):
      guard let c = card(id) else { return false }
      return c.locked || c.section.map { isLocked(section: $0) } == true
    case .section(let id): return isLocked(section: id)
    // an arrow has no lock of its own (the web board's links have none)
    case .arrow: return false
    }
  }

  /// The Section and every Section inside it, at any depth
  public func sectionTree(_ id: SectionID) -> Set<SectionID> {
    var out: Set<SectionID> = [id]
    var grew = true
    while grew {
      grew = false
      for s in sections where !out.contains(s.id) {
        if let p = s.parent, out.contains(p) {
          out.insert(s.id)
          grew = true
        }
      }
    }
    return out
  }

  /// The cards in these Sections (directly)
  public func members(of sections: Set<SectionID>) -> [CardID] {
    cards.compactMap { c in c.section.map(sections.contains) == true ? c.id : nil }
  }

  /// What a change of `items` takes along: the cards themselves, and each Section with the Sections inside it and their
  /// cards. Locked ones are left out (a Section's own cards go with it, locked or not: it is the Section that moves)
  public func carried(_ items: Set<Item>) -> (cards: Set<CardID>, sections: Set<SectionID>) {
    var secs = Set<SectionID>()
    for case .section(let id) in items where section(id) != nil && !isLocked(section: id) {
      secs.formUnion(sectionTree(id))
    }
    var cs = Set(members(of: secs))
    for case .card(let id) in items where card(id) != nil && !isLocked(.card(id)) { cs.insert(id) }
    return (cs, secs)
  }

  // MARK: Commands

  /// Moves cards and Sections (with what is in them) by (dx, dy)
  public mutating func move(_ items: Set<Item>, dx: Double, dy: Double) {
    let (cs, secs) = carried(items)
    for i in cards.indices where cs.contains(cards[i].id) {
      cards[i].x += dx
      cards[i].y += dy
    }
    for i in sections.indices where secs.contains(sections[i].id) {
      sections[i].x += dx
      sections[i].y += dy
    }
    selfCheck()
  }

  /// A card's frame from a resize: its place, width and height (nil: as tall as its content). A Text or Box never has
  /// a height
  public mutating func resize(_ id: CardID, x: Double, y: Double, width: Double, height: Double?) {
    guard let i = cards.firstIndex(where: { $0.id == id }) else { return }
    cards[i].x = x
    cards[i].y = y
    cards[i].width = width
    if !cards[i].isText { cards[i].height = height }
    selfCheck()
  }

  /// A Text's or Box's side edge: it wraps at `width` from now on (core resizeDown on a Text)
  public mutating func wrapText(_ id: CardID, x: Double, width: Double) {
    guard let i = cards.firstIndex(where: { $0.id == id }), case .own(var c) = cards[i].content,
      case .text(var t) = c.body
    else { return }
    t.wrap = true
    c.body = .text(t)
    cards[i].content = .own(c)
    cards[i].x = x
    cards[i].width = width
    selfCheck()
  }

  /// A Text's or Box's corner: its text size and its width scale together, where it wraps unchanged (core scaleText)
  public mutating func scaleText(_ id: CardID, fontSize: Double, width: Double) {
    guard let i = cards.firstIndex(where: { $0.id == id }), case .own(var c) = cards[i].content,
      case .text(var t) = c.body
    else { return }
    t.fontSize = min(TextCard.fontSizes.upperBound, max(TextCard.fontSizes.lowerBound, fontSize))
    c.body = .text(t)
    cards[i].content = .own(c)
    cards[i].width = width
    selfCheck()
  }

  /// A Section's frame from a resize
  public mutating func resize(section id: SectionID, x: Double, y: Double, width: Double, height: Double) {
    guard let i = sections.firstIndex(where: { $0.id == id }) else { return }
    sections[i].x = x
    sections[i].y = y
    sections[i].width = width
    sections[i].height = height
    selfCheck()
  }

  /// Where cards and Sections now are: each card in the Section given (nil: none), each Section in the parent given. A
  /// Section never goes inside itself, and one that is gone is none
  public mutating func setHomes(cards homes: [CardID: SectionID?], sections parents: [SectionID: SectionID?] = [:]) {
    for i in cards.indices {
      guard let to = homes[cards[i].id] else { continue }
      cards[i].section = to.flatMap { section($0) == nil ? nil : $0 }
    }
    for (id, to) in parents {
      guard let i = sections.firstIndex(where: { $0.id == id }) else { continue }
      let inside = sectionTree(id)
      sections[i].parent = to.flatMap { section($0) == nil || inside.contains($0) ? nil : $0 }
    }
    selfCheck()
  }

  /// Deletes cards, Sections and arrows, with what hangs on them: a card's arrows (on the canvas and on the shelf),
  /// sidenotes and stickers; a Section's sidenotes. A Section's cards and inner Sections stay, in the Section it was in
  /// (core deleteItems). Locked ones stay
  public mutating func delete(_ items: Set<Item>) {
    let goneArrows = Set(items.compactMap(\.arrow))
    arrows.removeAll { goneArrows.contains($0.id) }
    // a folder board's automatic cards go only with what they are for
    let goneCards = Set(items.compactMap(\.card).filter { card($0) != nil && !isLocked(.card($0)) && !isAuto($0) })
    let goneSections = Set(items.compactMap(\.section).filter { section($0) != nil && !isLocked(section: $0) })
    // up out of the deleted Sections, to the nearest one that stays
    func up(_ id: SectionID?) -> SectionID? {
      var at = id
      var steps = 0
      while let s = at, goneSections.contains(s), steps < 64 {
        at = section(s)?.parent
        steps += 1
      }
      return at.flatMap { goneSections.contains($0) ? nil : $0 }
    }
    for i in cards.indices where cards[i].section.map(goneSections.contains) == true {
      cards[i].section = up(cards[i].section)
    }
    for i in sections.indices where sections[i].parent.map(goneSections.contains) == true {
      sections[i].parent = up(sections[i].parent)
    }
    for e in shelf.indices {
      for i in shelf[e].cards.indices where shelf[e].cards[i].section.map(goneSections.contains) == true {
        shelf[e].cards[i].section = up(shelf[e].cards[i].section)
      }
      for i in shelf[e].sections.indices where shelf[e].sections[i].parent.map(goneSections.contains) == true {
        shelf[e].sections[i].parent = up(shelf[e].sections[i].parent)
      }
    }
    cards.removeAll { goneCards.contains($0.id) }
    sections.removeAll { goneSections.contains($0.id) }
    prune()
    selfCheck()
  }

  /// Bring to Front / Send to Back: the cards keep their order among themselves (core arrangeCards)
  public mutating func arrange(_ ids: Set<CardID>, toFront: Bool) {
    let moving = cards.filter { ids.contains($0.id) }
    guard !moving.isEmpty else { return }
    let rest = cards.filter { !ids.contains($0.id) }
    cards = toFront ? rest + moving : moving + rest
    selfCheck()
  }

  public mutating func setLocked(_ items: Set<Item>, _ locked: Bool) {
    for i in cards.indices where items.contains(.card(cards[i].id)) { cards[i].locked = locked }
    for i in sections.indices where items.contains(.section(sections[i].id)) { sections[i].locked = locked }
    selfCheck()
  }

  public mutating func setTilted(_ ids: Set<CardID>, _ tilted: Bool) {
    for i in cards.indices where ids.contains(cards[i].id) { cards[i].tilted = tilted }
    selfCheck()
  }

  // MARK: Reference upkeep

  /// What points at a card, segment or Section that is not there goes, as deleting it would take it (core pruneRefs):
  /// arrows, sidenotes and stickers on it; a card's or Section's home that is gone is none; a shelved card that is on
  /// the canvas too leaves the shelf, and a shelf entry left empty goes. After a delete and after a merge
  public mutating func prune() {
    var segments: [CardID: Set<SegmentID>?] = [:]
    for c in cards {
      if case .own(let content) = c.content, case .code(let code) = content.body {
        segments[c.id] = Set(code.segments.map(\.id))
      } else {
        segments[c.id] = .some(nil)
      }
    }
    let onCanvas = Set(cards.map(\.id))
    var shelved: [CardID: Set<SegmentID>?] = [:]
    for e in shelf {
      for c in e.cards where !onCanvas.contains(c.id) {
        if case .own(let content) = c.content, case .code(let code) = content.body {
          shelved[c.id] = Set(code.segments.map(\.id))
        } else {
          shelved[c.id] = .some(nil)
        }
      }
    }
    let all = segments.merging(shelved) { a, _ in a }
    func holds(_ card: CardID, _ segment: SegmentID?) -> Bool {
      guard let known = all[card] else { return false }
      guard let segment, let segs = known else { return true }
      return segs.contains(segment)
    }
    let sectionIDs = Set(sections.map(\.id)).union(shelf.flatMap { $0.sections.map(\.id) })
    arrows.removeAll { !holds($0.from.card, $0.from.segment) || !holds($0.to.card, $0.to.segment) }
    sidenotes.removeAll { n in
      switch n.anchor {
      case .card(let c, let s, _, _): !holds(c, s)
      case .section(let s): !sectionIDs.contains(s)
      case .point: false
      }
    }
    func stickerHolds(_ k: Sticker) -> Bool {
      switch k.anchor {
      case .canvas: true
      case .card(let c, _, _, _): holds(c, nil)
      case .line(let c, let s, _): holds(c, s)
      }
    }
    stickers.removeAll { !stickerHolds($0) }
    for i in cards.indices where cards[i].section.map(sectionIDs.contains) == false { cards[i].section = nil }
    for i in sections.indices where sections[i].parent.map(sectionIDs.contains) == false { sections[i].parent = nil }
    for e in shelf.indices {
      shelf[e].cards.removeAll { onCanvas.contains($0.id) }
      shelf[e].arrows.removeAll { !holds($0.from.card, $0.from.segment) || !holds($0.to.card, $0.to.segment) }
      shelf[e].stickers.removeAll { !stickerHolds($0) }
      for i in shelf[e].cards.indices where shelf[e].cards[i].section.map(sectionIDs.contains) == false {
        shelf[e].cards[i].section = nil
      }
      for i in shelf[e].sections.indices where shelf[e].sections[i].parent.map(sectionIDs.contains) == false {
        shelf[e].sections[i].parent = nil
      }
    }
    shelf.removeAll { $0.cards.isEmpty && $0.sections.isEmpty }
  }

  /// In debug builds and tests every command ends here: the board must hold together (no dangling reference, no
  /// duplicate id, no value the format refuses)
  func selfCheck() {
    #if DEBUG
      if let p = problem() { preconditionFailure("an edit broke the board: \(p)") }
    #endif
  }

  /// The self-check as a value, for a shell's own checks
  public var brokenReference: String? { problem() }
}

extension Card {
  /// A Text or a Box (always as tall as its text)
  public var isText: Bool {
    if case .own(let c) = content, case .text = c.body { true } else { false }
  }
}

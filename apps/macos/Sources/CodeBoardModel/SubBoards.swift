import Foundation

// Sub-board cards: a folder board's automatic cards kept in step with its folder, and Turn into Board (core subboard.ts
// extractBoard, edit/ops.ts cardsToFrame).

extension Board {
  /// An automatic card's size, and the room between them across and down (a card's title sits 46 above it)
  public static let autoWidth = 400.0
  public static let autoHeight = 300.0
  public static let autoGap = 80.0
  public static let autoRowGap = 120.0
  /// Automatic cards in a row before the next row starts
  public static let autoPerRow = 4

  /// The automatic cards, in board order, with what each is for
  public var autoCards: [(card: Card, target: SubBoard.Target)] {
    cards.compactMap { c in
      guard case .own(let content) = c.content, case .board(let s) = content.body, s.auto else { return nil }
      return (c, s.target)
    }
  }

  /// Whether a card is a folder board's automatic card
  public func isAuto(_ id: CardID) -> Bool {
    guard case .own(let c)? = card(id)?.content, case .board(let s) = c.body else { return false }
    return s.auto
  }

  /// Something on a card that would go with it: an arrow's end, a sidenote, a sticker
  public func hasAttached(_ id: CardID) -> Bool {
    arrows.contains { $0.from.card == id || $0.to.card == id } || sidenotes.contains { $0.anchor.card == id }
      || stickers.contains { $0.anchor.card == id }
  }

  /// The folder board's automatic cards kept in step with its folder (`entries`, in sidebar order), conservatively: a
  /// card for what came is added after the last automatic card (gaps are not filled), and a card whose board or
  /// subfolder is not there now stays where it is with all on it (drawn as missing), since it may be back (a git
  /// checkout, a sync); when it is, the same card shows it again. A missing card for a board whose last known title
  /// (`known`) is the title of a board that came (`titles`) is that board's card again. Only the app's own Delete and
  /// move take a card away (`dropAutoCard`). A second card for the same goes when nothing is on it. Whether it changed
  /// anything
  @discardableResult
  public mutating func keepUp(
    with entries: [FolderEntry], titles: [BoardID: String] = [:], known: [BoardID: String] = [:]
  ) -> Bool {
    let want = Set(entries.map(\.target))
    var seen = Set<SubBoard.Target>()
    var gone = Set<CardID>()
    for (c, t) in autoCards where want.contains(t) {
      if !seen.insert(t).inserted && !hasAttached(c.id) { gone.insert(c.id) }
    }
    if !gone.isEmpty {
      cards.removeAll { gone.contains($0.id) }
      prune()
    }
    var changed = !gone.isEmpty
    for e in entries where !seen.contains(e.target) {
      // a missing card for a board of the same title: that board's again, where it is
      if case .board(let b) = e, let title = titles[b],
        let i = cards.firstIndex(where: { c in
          guard case .own(let content) = c.content, case .board(let s) = content.body, s.auto,
            case .board(let old) = s.target, !want.contains(s.target)
          else { return false }
          return known[old] == title
        }), case .own(var content) = cards[i].content, case .board(var s) = content.body
      {
        s.target = .board(b)
        content.body = .board(s)
        cards[i].content = .own(content)
      } else {
        let at = nextAutoPlace()
        let body: SubBoard =
          switch e {
          case .board(let b): SubBoard(board: b, auto: true)
          case .folder(let f): SubBoard(folder: f)
          }
        cards.append(
          Card(
            id: CardID(rawValue: Board.newID("card-")), x: at.x, y: at.y, width: Board.autoWidth,
            height: Board.autoHeight, content: .own(CardContent(body: .board(body)))))
      }
      seen.insert(e.target)
      changed = true
    }
    if changed { selfCheck() }
    return changed
  }

  /// The app deleted or moved away what an automatic card is for: its card goes, unless something is on it (then it
  /// stays, drawn as missing, until the user deletes it). Whether it went
  @discardableResult
  public mutating func dropAutoCard(for target: SubBoard.Target) -> Bool {
    let ids = Set(autoCards.filter { $0.target == target && !hasAttached($0.card.id) }.map(\.card.id))
    guard !ids.isEmpty else { return false }
    cards.removeAll { ids.contains($0.id) }
    prune()
    selfCheck()
    return true
  }

  /// Where the next automatic card goes: right of the last one, the next row once a row has `autoPerRow` (counted from
  /// the first one's left); the first below what the board has, or at 0, 0 on an empty board
  public func nextAutoPlace() -> (x: Double, y: Double) {
    let autos = autoCards.map(\.card)
    guard let last = autos.last, let first = autos.first else {
      // below all that is on the board, its Sections too
      let bottom = (cards.map { $0.y + ($0.height ?? $0.measuredHeight ?? 200) } + sections.map { $0.y + $0.height })
        .max()
      let left = (cards.map(\.x) + sections.map(\.x)).min()
      guard let bottom, let left else { return (0, 0) }
      return (left, bottom + Board.autoRowGap)
    }
    let x = last.x + last.width + Board.autoGap
    let rowEnd = first.x + Double(Board.autoPerRow) * (Board.autoWidth + Board.autoGap) - Board.autoGap
    if x + last.width <= rowEnd + 0.5 { return (x, last.y) }
    return (first.x, last.y + (last.height ?? Board.autoHeight) + Board.autoRowGap)
  }

  /// A subfolder renamed in the app: its card keeps its place
  @discardableResult
  public mutating func renameFolderCard(_ old: String, to new: String) -> Bool {
    var changed = false
    for i in cards.indices {
      guard case .own(var content) = cards[i].content, case .board(var s) = content.body, s.target == .folder(old)
      else { continue }
      s.target = .folder(new)
      content.body = .board(s)
      cards[i].content = .own(content)
      changed = true
    }
    return changed
  }

  /// An automatic card placed where a board dragged in from the sidebar was let go (keepUp then finds it there)
  public mutating func placeAutoCard(for e: FolderEntry, x: Double, y: Double) {
    guard !autoCards.contains(where: { $0.target == e.target }) else { return }
    let body: SubBoard =
      switch e {
      case .board(let b): SubBoard(board: b, auto: true)
      case .folder(let f): SubBoard(folder: f)
      }
    cards.append(
      Card(
        id: CardID(rawValue: Board.newID("card-")), x: x.rounded(), y: y.rounded(), width: Board.autoWidth,
        height: Board.autoHeight, content: .own(CardContent(body: .board(body)))))
    selfCheck()
  }

  // MARK: Turn into Board

  /// The cards `ids` (as drawn: `rects`) taken out into a new board `child`: they go with the arrows between them, the
  /// sidenotes and stickers on them, and the Sections whose cards all go (positions moved to start at 80, 80); here a
  /// sub-board card `frame` takes their place, the arrows that crossed now ending on it (extractBoard, cardsToFrame).
  /// Nil when none of them is here
  public mutating func extract(
    _ ids: Set<CardID>, rects: (CardID) -> Rect?, child: BoardID, frame: CardID
  ) -> Board? {
    let top = cards.filter { ids.contains($0.id) }.map(\.id)
    let boxes = top.compactMap(rects)
    guard !top.isEmpty, !boxes.isEmpty else { return nil }
    let minX = boxes.map(\.x).min()!
    let minY = boxes.map(\.y).min()!
    let box = Rect(
      x: minX, y: minY, width: boxes.map { $0.x + $0.width }.max()! - minX,
      height: boxes.map { $0.y + $0.height }.max()! - minY)
    let want = Set(top)
    let dx = 80 - box.x
    let dy = 80 - box.y
    // Sections whose cards all go, and inner ones of those whose cards all go too
    var secs = Set<SectionID>()
    func members(_ s: SectionID) -> [CardID] { cards.filter { $0.section == s }.map(\.id) }
    for s in sections {
      let m = members(s.id)
      if !m.isEmpty, m.allSatisfy(want.contains) { secs.insert(s.id) }
    }
    var grew = true
    while grew {
      grew = false
      for s in sections where !secs.contains(s.id) {
        if let p = s.parent, secs.contains(p), members(s.id).allSatisfy(want.contains) {
          secs.insert(s.id)
          grew = true
        }
      }
    }

    var out = Board(
      id: child, cards: cards, arrows: arrows, sections: sections, sidenotes: sidenotes, stickers: stickers)
    out.drop(cards: Set(out.cards.map(\.id)).subtracting(want), sections: Set(out.sections.map(\.id)).subtracting(secs))
    // what is free on the canvas stays here
    out.stickers.removeAll { if case .canvas = $0.anchor { true } else { false } }
    out.sidenotes.removeAll { if case .point = $0.anchor { true } else { false } }
    for i in out.cards.indices {
      out.cards[i].x += dx
      out.cards[i].y += dy
    }
    for i in out.sections.indices {
      out.sections[i].x += dx
      out.sections[i].y += dy
    }
    out.selfCheck()

    // here: the cards become the frame, smaller than they were (about half as wide, as tall as their proportions make it)
    let fw = (max(360, min(640, box.width * 0.45))).rounded()
    let fh = (max(220, min(560, (fw - 32) * (box.height / max(1, box.width)) + 32))).rounded()
    var home = cards.first { $0.id == top[0] }?.section
    if let h = home, secs.contains(h) { home = nil }
    for i in arrows.indices {
      let a = want.contains(arrows[i].from.card)
      let t = want.contains(arrows[i].to.card)
      guard a != t else { continue }
      if t { arrows[i].to = Endpoint(card: frame) } else { arrows[i].from = Endpoint(card: frame) }
    }
    // in the first one's place in the stacking order, there before the cards go so the arrows to it stay
    let at = cards.firstIndex { want.contains($0.id) } ?? 0
    cards.insert(
      Card(
        id: frame, x: box.x.rounded(), y: box.y.rounded(), width: fw, height: fh, section: home,
        content: .own(CardContent(body: .board(SubBoard(board: child))))),
      at: at)
    drop(cards: want, sections: secs)
    selfCheck()
    return out
  }

  /// Cards and Sections taken off whatever they are (locked ones too), what is on them going with them; a Section's cards
  /// and inner Sections go up to the nearest Section that stays (core removeCards, removeSections)
  mutating func drop(cards gone: Set<CardID>, sections goneSections: Set<SectionID>) {
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
    arrows.removeAll { gone.contains($0.from.card) || gone.contains($0.to.card) }
    cards.removeAll { gone.contains($0.id) }
    sections.removeAll { goneSections.contains($0.id) }
    prune()
  }
}

extension FolderEntry {
  public var target: SubBoard.Target {
    switch self {
    case .board(let b): .board(b)
    case .folder(let f): .folder(f)
    }
  }
}

/// A rectangle on a board (the model has no CoreGraphics)
public struct Rect: Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }
}

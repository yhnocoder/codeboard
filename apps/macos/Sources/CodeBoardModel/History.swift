import Foundation

// Undo and redo for one board, and the three-way merge of a board with what another writer put on disk. Both work item
// by item (cards, arrows, sections, sidenotes, stickers, shelf entries, by id), as core's patch.ts mergeFile and the
// board's history do: a step holds the items it changed, before and after, so it can be undone on a board that changed
// elsewhere meanwhile, and a merge that touched its items drops it instead.

extension Card: Identifiable {}
extension Arrow: Identifiable {}
extension Section: Identifiable {}
extension Sidenote: Identifiable {}
extension Sticker: Identifiable {}
extension ShelfEntry: Identifiable {}

/// The items of one list that changed, before and after (nil: not there), and its order before and after when that
/// changed
struct ListChange<T: Identifiable & Equatable & Sendable & Codable>: Equatable, Sendable
where T.ID: Hashable & Sendable {
  var before: [T.ID: T] = [:]
  var after: [T.ID: T] = [:]
  var touched: [T.ID] = []
  var orderBefore: [T.ID]?
  var orderAfter: [T.ID]?

  init(_ a: [T], _ b: [T]) {
    let old = Dictionary(a.map { ($0.id, $0) }, uniquingKeysWith: { x, _ in x })
    let new = Dictionary(b.map { ($0.id, $0) }, uniquingKeysWith: { x, _ in x })
    for x in b where old[x.id] != x {
      touched.append(x.id)
      before[x.id] = old[x.id]
      after[x.id] = x
    }
    for x in a where new[x.id] == nil {
      touched.append(x.id)
      before[x.id] = x
    }
    // the order of what both have, and where new items went
    let ao = a.map(\.id)
    let bo = b.map(\.id)
    if ao.filter({ new[$0] != nil }) != bo.filter({ old[$0] != nil }) || !touched.isEmpty && ao != bo {
      orderBefore = ao
      orderAfter = bo
    }
  }

  var isEmpty: Bool { touched.isEmpty && orderBefore == nil }

  /// The list with this change applied (forward) or taken back. An item it changed on both sides gets back only the
  /// fields it changed (another writer may have changed others meanwhile); items it does not touch stay where they are
  func apply(to list: [T], forward: Bool) -> [T] where T: Codable {
    let want = forward ? after : before
    let was = forward ? before : after
    var out = list.filter { x in !touched.contains(x.id) || want[x.id] != nil }
    for (i, x) in out.enumerated() where touched.contains(x.id) {
      out[i] = was[x.id].map { mergeFields($0, x, want[x.id]!) } ?? want[x.id]!
    }
    let have = Set(out.map(\.id))
    for id in touched where !have.contains(id) { if let x = want[id] { out.append(x) } }
    guard let order = forward ? orderAfter : orderBefore else { return out }
    let rank = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
    // what the order does not know (added elsewhere meanwhile) keeps its place after it
    return out.enumerated().sorted { a, b in
      (rank[a.element.id] ?? order.count + a.offset, a.offset) < (
        rank[b.element.id] ?? order.count + b.offset, b.offset
      )
    }.map(\.element)
  }

  /// Whether `list` is as this change left it (forward) or found it, in what it changed: then it can be taken back (or
  /// done again). Of an item it changed on both sides only the fields it changed count
  func holds(on list: [T], forward: Bool) -> Bool where T: Codable {
    let want = forward ? after : before
    let was = forward ? before : after
    let now = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { x, _ in x })
    return touched.allSatisfy { id in
      guard let w = want[id], let x = was[id], let n = now[id] else { return now[id] == want[id] }
      return fieldsHold(n, from: x, to: w)
    }
  }
}

/// What one edit changed on a board
public struct BoardChange: Equatable, Sendable {
  var cards: ListChange<Card>
  var arrows: ListChange<Arrow>
  var sections: ListChange<Section>
  var sidenotes: ListChange<Sidenote>
  var stickers: ListChange<Sticker>
  var shelf: ListChange<ShelfEntry>
  var seal: (Seal?, Seal?)?
  var hideComments: (Bool, Bool)?

  public init(from a: Board, to b: Board) {
    cards = ListChange(a.cards, b.cards)
    arrows = ListChange(a.arrows, b.arrows)
    sections = ListChange(a.sections, b.sections)
    sidenotes = ListChange(a.sidenotes, b.sidenotes)
    stickers = ListChange(a.stickers, b.stickers)
    shelf = ListChange(a.shelf, b.shelf)
    seal = a.seal == b.seal ? nil : (a.seal, b.seal)
    hideComments = a.hideComments == b.hideComments ? nil : (a.hideComments, b.hideComments)
  }

  public var isEmpty: Bool {
    cards.isEmpty && arrows.isEmpty && sections.isEmpty && sidenotes.isEmpty && stickers.isEmpty && shelf.isEmpty
      && seal == nil && hideComments == nil
  }

  public func apply(to b: inout Board, forward: Bool) {
    b.cards = cards.apply(to: b.cards, forward: forward)
    b.arrows = arrows.apply(to: b.arrows, forward: forward)
    b.sections = sections.apply(to: b.sections, forward: forward)
    b.sidenotes = sidenotes.apply(to: b.sidenotes, forward: forward)
    b.stickers = stickers.apply(to: b.stickers, forward: forward)
    b.shelf = shelf.apply(to: b.shelf, forward: forward)
    if let (x, y) = seal { b.seal = forward ? y : x }
    if let (x, y) = hideComments { b.hideComments = forward ? y : x }
  }

  /// Whether `b` is as this change left it (forward) or found it
  public func holds(on b: Board, forward: Bool) -> Bool {
    cards.holds(on: b.cards, forward: forward) && arrows.holds(on: b.arrows, forward: forward)
      && sections.holds(on: b.sections, forward: forward) && sidenotes.holds(on: b.sidenotes, forward: forward)
      && stickers.holds(on: b.stickers, forward: forward) && shelf.holds(on: b.shelf, forward: forward)
      && seal.map { b.seal == (forward ? $0.1 : $0.0) } != false
      && hideComments.map { b.hideComments == (forward ? $0.1 : $0.0) } != false
  }

  public static func == (x: BoardChange, y: BoardChange) -> Bool {
    x.cards == y.cards && x.arrows == y.arrows && x.sections == y.sections && x.sidenotes == y.sidenotes
      && x.stickers == y.stickers && x.shelf == y.shelf && x.seal?.0 == y.seal?.0 && x.seal?.1 == y.seal?.1
      && x.hideComments?.0 == y.hideComments?.0 && x.hideComments?.1 == y.hideComments?.1
  }
}

/// One board's undo and redo, in memory. A step is a whole gesture or command, with the selection before and after it
public struct History: Sendable {
  public struct Step: Sendable {
    public var name: String
    var change: BoardChange
    public var selectionBefore: Set<Item>
    public var selectionAfter: Set<Item>
  }

  public private(set) var undoSteps: [Step] = []
  public private(set) var redoSteps: [Step] = []
  /// As many steps as the web board keeps
  public static let limit = 200

  public init() {}

  public var canUndo: Bool { !undoSteps.isEmpty }
  public var canRedo: Bool { !redoSteps.isEmpty }

  /// Records the change from `before` to `after` as one step (none when nothing changed); redo is gone
  public mutating func record(
    _ name: String, from before: Board, to after: Board, selection: (before: Set<Item>, after: Set<Item>)
  ) {
    let change = BoardChange(from: before, to: after)
    guard !change.isEmpty else { return }
    undoSteps.append(
      Step(name: name, change: change, selectionBefore: selection.before, selectionAfter: selection.after))
    if undoSteps.count > History.limit { undoSteps.removeFirst(undoSteps.count - History.limit) }
    redoSteps = []
  }

  /// Takes the last step back on `board`; returns the selection to restore, nil when there was nothing to undo
  public mutating func undo(_ board: inout Board) -> Set<Item>? {
    guard let s = undoSteps.popLast() else { return nil }
    s.change.apply(to: &board, forward: false)
    board.selfCheck()
    redoSteps.append(s)
    return s.selectionBefore
  }

  public mutating func redo(_ board: inout Board) -> Set<Item>? {
    guard let s = redoSteps.popLast() else { return nil }
    s.change.apply(to: &board, forward: true)
    board.selfCheck()
    undoSteps.append(s)
    return s.selectionAfter
  }

  /// After `board` changed outside the history (a merge): from the newest step back, each step must still hold on the
  /// board as undoing the ones after it leaves it; the first that does not is dropped with every step before it (they
  /// may have built on it). The same for redo
  public mutating func keep(holdingOn board: Board) {
    var b = board
    for i in undoSteps.indices.reversed() {
      guard undoSteps[i].change.holds(on: b, forward: true) else {
        undoSteps.removeFirst(i + 1)
        break
      }
      undoSteps[i].change.apply(to: &b, forward: false)
    }
    b = board
    for i in redoSteps.indices.reversed() {
      guard redoSteps[i].change.holds(on: b, forward: false) else {
        redoSteps.removeFirst(i + 1)
        break
      }
      redoSteps[i].change.apply(to: &b, forward: true)
    }
  }
}

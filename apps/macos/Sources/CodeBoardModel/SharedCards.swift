import Foundation

// Shared cards on an open board, and 同一块白板的共享卡 (the same card placed several times on one board).
//
// Shared cards: as main reads a board (packages/core/src/patch.ts inflate / deflate), an open board holds each shared
// card's content and its travelling sidenotes (those on it that are not board-only, patch.ts travels) as if they were its
// own, so every edit works on them as on any card; writing the board puts them back in the card's own file. Twins: core
// edit/twins.ts makeTwin, detachTwin, syncTwins.

extension Board {
  /// The shared cards' content and travelling sidenotes read in from `shared` (by id; nil: not there or unreadable, and
  /// the card stays `.shared`)
  public func inflated(_ shared: (CardID) -> SharedCard?) -> Board {
    var b = self
    var have = Set(sidenotes.map(\.id))
    var notes: [Sidenote] = []
    func inflate(_ c: inout Card) {
      guard c.content == .shared, let s = shared(c.id) else { return }
      c.content = .own(s.content)
      for n in s.sidenotes where have.insert(n.id).inserted { notes.append(n) }
    }
    for i in b.cards.indices { inflate(&b.cards[i]) }
    for e in b.shelf.indices { for i in b.shelf[e].cards.indices { inflate(&b.shelf[e].cards[i]) } }
    b.sidenotes += notes
    return b
  }

  /// What the files hold: the board with each shared card read in as `.shared` and without its travelling sidenotes,
  /// and those cards as their own files hold them
  public func deflated() -> (board: Board, shared: [SharedCard]) {
    var b = self
    var out: [SharedCard] = []
    var gone = Set<SidenoteID>()
    func deflate(_ c: inout Card) {
      guard c.isShared, case .own(let content) = c.content else { return }
      let notes = sidenotes.filter { $0.anchor.card == c.id && !$0.boardOnly }
      gone.formUnion(notes.map(\.id))
      out.append(SharedCard(id: c.id, content: content, sidenotes: notes))
      c.content = .shared
    }
    for i in b.cards.indices { deflate(&b.cards[i]) }
    for e in b.shelf.indices { for i in b.shelf[e].cards.indices { deflate(&b.shelf[e].cards[i]) } }
    if !gone.isEmpty { b.sidenotes.removeAll { gone.contains($0.id) } }
    return (b, out)
  }

  /// A shared card's file as it is now on this board (core patch.ts putShared): the content of the card of its id, if
  /// that is shared, and its travelling sidenotes
  public mutating func putShared(_ card: SharedCard) {
    var found = false
    for i in cards.indices where cards[i].id == card.id && cards[i].isShared {
      cards[i].content = .own(card.content)
      found = true
    }
    for e in shelf.indices {
      for i in shelf[e].cards.indices where shelf[e].cards[i].id == card.id && shelf[e].cards[i].isShared {
        shelf[e].cards[i].content = .own(card.content)
        found = true
      }
    }
    guard found else { return }
    let next = Dictionary(card.sidenotes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var out: [Sidenote] = []
    var placed = Set<SidenoteID>()
    for n in sidenotes {
      if let m = next[n.id] {
        out.append(m)
        placed.insert(n.id)
      } else if n.anchor.card != card.id || n.boardOnly {
        out.append(n)
      }
    }
    sidenotes = out + card.sidenotes.filter { !placed.contains($0.id) }
  }

  /// These cards become shared cards (main's paste onto another board, host storage/boards.ts share): their content and
  /// travelling sidenotes go to their own files when the board is written. A card whose id `taken` says a shared card
  /// already has gets a new one first, what points at it following. Returns the ids that changed, old → new
  @discardableResult
  public mutating func share(_ ids: Set<CardID>, taken: (CardID) -> Bool, newID: (String) -> String = Board.newID)
    -> [CardID: CardID]
  {
    var renamed: [CardID: CardID] = [:]
    for i in cards.indices where ids.contains(cards[i].id) && !cards[i].isShared {
      guard case .own = cards[i].content else { continue }
      let old = cards[i].id
      if taken(old) {
        var new = CardID(rawValue: newID("c"))
        while taken(new) || card(new) != nil { new = CardID(rawValue: newID("c")) }
        renameCard(old, to: new)
        renamed[old] = new
      }
      cards[i].isShared = true
      cards[i].same = nil
    }
    selfCheck()
    return renamed
  }

  /// A card's id changed, with every arrow end, sidenote and sticker on it
  mutating func renameCard(_ old: CardID, to new: CardID) {
    for i in cards.indices where cards[i].id == old { cards[i].id = new }
    for i in arrows.indices {
      if arrows[i].from.card == old { arrows[i].from.card = new }
      if arrows[i].to.card == old { arrows[i].to.card = new }
    }
    for i in sidenotes.indices {
      if case .card(old, let s, let l, let b) = sidenotes[i].anchor {
        sidenotes[i].anchor = .card(new, segment: s, lines: l, block: b)
      }
    }
    for i in stickers.indices {
      switch stickers[i].anchor {
      case .card(old, let x, let y, let size): stickers[i].anchor = .card(new, x: x, y: y, size: size)
      case .line(old, let s, let l): stickers[i].anchor = .line(new, segment: s, line: l)
      default: break
      }
    }
  }

  // MARK: 同一块白板的共享卡

  /// Every place of a card placed several times shows what the one changed since `before` shows (one changed: the
  /// others follow it; one new to its group, undone or pasted back: it follows the ones that were there). Run after every
  /// change of the board (core syncTwins, from the store's mutate, sync and live)
  public mutating func syncTwins(since before: Board) {
    var groups: [String: [(entry: Int?, i: Int)]] = [:]
    for (i, c) in cards.enumerated() { if let g = c.same { groups[g, default: []].append((nil, i)) } }
    for (e, entry) in shelf.enumerated() {
      for (i, c) in entry.cards.enumerated() { if let g = c.same { groups[g, default: []].append((e, i)) } }
    }
    let old = Dictionary(
      (before.cards + before.shelf.flatMap(\.cards)).map { ($0.id, $0.content) }, uniquingKeysWith: { a, _ in a })
    func at(_ p: (entry: Int?, i: Int)) -> Card { p.entry.map { shelf[$0].cards[p.i] } ?? cards[p.i] }
    for places in groups.values where places.count > 1 {
      let src =
        places.first { p in old[at(p).id].map { $0 != at(p).content } ?? false }
        ?? places.first { old[at($0).id] != nil } ?? places[0]
      let content = at(src).content
      for p in places where at(p).content != content {
        if let e = p.entry { shelf[e].cards[p.i].content = content } else { cards[p.i].content = content }
      }
    }
  }

  /// Reference: the pasted copy `id` becomes another place of `of` (core makeTwin): its content becomes `of`'s, segment
  /// ids too, and both get the same `same`. Its own place, tilt, arrows, sidenotes and stickers stay; those on its
  /// segments move to `of`'s segments in order (an arrow or sidenote with none to go to goes to the whole card, a
  /// sticker on a line goes). False: nothing done
  @discardableResult
  public mutating func makeTwin(_ id: CardID, of: CardID, newID: (String) -> String = Board.newID) -> Bool {
    guard let ci = cards.firstIndex(where: { $0.id == id }), let oi = cards.firstIndex(where: { $0.id == of }),
      ci != oi, cards[ci].same == nil || cards[ci].same != cards[oi].same, case .own = cards[ci].content,
      case .own = cards[oi].content
    else { return false }
    let segs = { (c: Card) -> [SegmentID] in
      if case .own(let x) = c.content, case .code(let code) = x.body { code.segments.map(\.id) } else { [] }
    }
    let was = segs(cards[ci])
    let now = segs(cards[oi])
    let group = cards[oi].same ?? newID("t")
    cards[oi].same = group
    cards[ci].same = group
    cards[ci].content = cards[oi].content
    var map: [SegmentID: SegmentID?] = [:]
    for (i, s) in was.enumerated() { map[s] = i < now.count ? now[i] : nil }
    reseg(id, map)
    // the copy's sidenotes on lines bring their Highlights into the content, which every place of the card shows
    for n in sidenotes where !n.boardOnly {
      if case .card(id, let seg?, let lines?, _) = n.anchor { _ = addHighlight(id, seg, lines) }
    }
    for i in cards.indices where cards[i].same == group { cards[i].content = cards[ci].content }
    selfCheck()
    return true
  }

  /// Detach: this place of a card placed several times becomes a card of its own (core detachTwin): no `same`, new
  /// segment ids, what is on its segments following; a group left with one place loses its `same` too. Returns old →
  /// new segment ids
  @discardableResult
  public mutating func detachTwin(_ id: CardID, newID: (String) -> String = Board.newID) -> [SegmentID: SegmentID] {
    guard let ci = cards.firstIndex(where: { $0.id == id }), let g = cards[ci].same else { return [:] }
    cards[ci].same = nil
    let rest = cards.indices.filter { cards[$0].same == g }
    if rest.count == 1 { cards[rest[0]].same = nil }
    guard case .own(var content) = cards[ci].content, case .code(var code) = content.body else { return [:] }
    var out: [SegmentID: SegmentID] = [:]
    for i in code.segments.indices {
      let n = SegmentID(rawValue: newID("s"))
      out[code.segments[i].id] = n
      code.segments[i].id = n
    }
    content.body = .code(code)
    cards[ci].content = .own(content)
    reseg(id, out.mapValues { $0 })
    selfCheck()
    return out
  }

  /// What is on card `id`'s segments moved to the segments `map` gives (nil: none; an arrow or sidenote goes to the whole
  /// card, a sticker on a line goes)
  private mutating func reseg(_ id: CardID, _ map: [SegmentID: SegmentID?]) {
    guard !map.isEmpty else { return }
    for i in arrows.indices {
      for end in [\Arrow.from, \Arrow.to] where arrows[i][keyPath: end].card == id {
        guard let s = arrows[i][keyPath: end].segment, let n = map[s] else { continue }
        arrows[i][keyPath: end].segment = n
        if n == nil { arrows[i][keyPath: end].line = nil }
      }
    }
    for i in sidenotes.indices {
      guard case .card(id, let s?, let lines, let block) = sidenotes[i].anchor, let n = map[s] else { continue }
      sidenotes[i].anchor = .card(id, segment: n, lines: n == nil ? nil : lines, block: block)
    }
    stickers.removeAll { k in
      if case .line(id, let s, _) = k.anchor, let n = map[s], n == nil { return true }
      return false
    }
    for i in stickers.indices {
      if case .line(id, let s, let l) = stickers[i].anchor, case let n?? = map[s] {
        stickers[i].anchor = .line(id, segment: n, line: l)
      }
    }
  }
}

extension CardContent {
  /// The file names of the images it shows from its images folder: Markdown `images/<file>` (its text and description),
  /// an image card's file, a web card's or link's picture and icon
  public var imageFiles: Set<String> {
    var out = Set<String>()
    func md(_ s: String?) {
      for m in (s ?? "").matches(of: /images\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)/) { out.insert(String(m.output.1)) }
    }
    func meta(_ m: WebMeta?) {
      for case .file(let f)? in [m?.image, m?.icon] { out.insert(f) }
    }
    md(description)
    switch body {
    case .note(let n): md(n.text)
    case .text(let t): md(t.text)
    case .image(let i): if case .file(let f) = i.source { out.insert(f) }
    case .web(let w): meta(w.meta)
    case .links(let l): for item in l.items { meta(item.meta) }
    case .code, .board: break
    }
    return out
  }
}

extension SharedCard {
  /// The images its file shows: its content's and those in its sidenotes' Markdown
  public var imageFiles: Set<String> {
    var out = content.imageFiles
    for n in sidenotes {
      guard case .text(let t) = n.body else { continue }
      let texts = [t.text] + (t.question?.answers.map(\.text) ?? [])
      for s in texts {
        for m in s.matches(of: /images\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)/) { out.insert(String(m.output.1)) }
      }
    }
    return out
  }
}

import Foundation

// A board as an open document holds it: on each code card of the canvas whose segment has a repository (a key), not
// showing its annotations hidden, the segment's Highlights and the text sidenotes on its lines are the repository's
// (`show`), each sidenote once on the board, on the first card that shows its lines. What the board writes leaves them
// out (`stripped`); what a change of the board did to them is done to the repository's (`settle`), and what an older
// board, a card pasted or a key learned brings is taken in (`adopt`). Anything else (Free code, a card whose repository
// has no key, a card with its annotations hidden, a code sidenote) stays on the card, in the board's file.

/// A code card's segment on a board
public struct CodeSpot: Hashable, Sendable {
  public var card: CardID
  public var segment: SegmentID
}

extension CodeNotes {
  /// A segment whose annotations are its repository's: its key and its path from the repository's root
  struct Shown {
    var spot: CodeSpot
    var seg: Segment
    var key: String
    var path: String
  }

  /// The board's segments whose annotations are their repository's, in the order of its cards
  func shown(_ b: Board) -> [Shown] { Self.shown(b, key: key) }

  nonisolated static func shown(_ b: Board, key: (CodeSource) -> String?) -> [Shown] {
    b.cards.flatMap { c -> [Shown] in
      guard case .own(let k) = c.content, case .code(let code) = k.body, code.annotationsHidden != true else {
        return []
      }
      return code.segments.compactMap { s in
        guard case .git(_, _, let path, _, _)? = s.source, let key = key(s.source!) else { return nil }
        return Shown(spot: CodeSpot(card: c.id, segment: s.id), seg: s, key: key, path: path)
      }
    }
  }

  /// The board's segments whose annotations are their repository's now
  public func spotsShown(_ b: Board) -> Set<CodeSpot> { Set(shown(b).map(\.spot)) }

  private func spots(_ b: Board) -> [CodeSpot: Shown] {
    Dictionary(shown(b).map { ($0.spot, $0) }, uniquingKeysWith: { a, _ in a })
  }

  /// A text sidenote on lines of one of `spots`
  private nonisolated static func codeSpot(_ n: Sidenote, _ spots: [CodeSpot: Shown]) -> Shown? {
    guard case .text = n.body, case .card(let c, let s?, _?, nil) = n.anchor else { return nil }
    return spots[CodeSpot(card: c, segment: s)]
  }

  private static func notes(_ b: Board, _ spots: [CodeSpot: Shown]) -> [SidenoteID: (Sidenote, Shown)] {
    var out: [SidenoteID: (Sidenote, Shown)] = [:]
    for n in b.sidenotes { if let s = codeSpot(n, spots) { out[n.id] = (n, s) } }
    return out
  }

  private nonisolated static func lines(_ rs: [ClosedRange<Int>], in s: Segment) -> Set<Int> {
    Set(rs.flatMap { r in max(r.lowerBound, s.firstLine)...max(min(r.upperBound, s.lastLine), s.firstLine - 1) })
  }

  private static func sameCode(_ a: Segment, _ b: Segment) -> Bool {
    a.source == b.source && a.firstLine == b.firstLine && a.lines == b.lines
  }

  private nonisolated static var now: Double { (Date().timeIntervalSince1970 * 1000).rounded() }

  // MARK: The board's file

  /// What an import writes (LegacyImport): the board without what is its repositories', and that by key, as `adopt`
  /// adds it (ids made from the board, card, segment and lines)
  nonisolated static func extract(_ b: Board, key: (CodeSource) -> String?) -> (
    board: Board, notes: [String: RepositoryNotes]
  ) {
    let all = shown(b, key: key)
    guard !all.isEmpty else { return (b, [:]) }
    let spots = Dictionary(all.map { ($0.spot, $0) }, uniquingKeysWith: { a, _ in a })
    var out: [String: RepositoryNotes] = [:]
    func file(_ s: Shown, _ f: (inout CodeFileNotes) -> Void) {
      f(&out[s.key, default: RepositoryNotes(repository: s.key)].files[s.path, default: CodeFileNotes()])
    }
    for s in all {
      for r in runs(lines(s.seg.highlights, in: s.seg)) {
        guard let p = CodePlace(s.seg, r) else { continue }
        let id = "h" + codeHash("\(b.id.rawValue)\0\(s.spot.card.rawValue)\0\(s.spot.segment.rawValue)\0\(r)")
        file(s) { $0.highlights.append(CodeHighlight(id: id, place: p, at: now)) }
      }
    }
    for n in b.sidenotes {
      guard let s = codeSpot(n, spots), let l = n.anchor.lines?.range, case .text(let t) = n.body,
        let p = CodePlace(s.seg, l)
      else { continue }
      file(s) {
        $0.sidenotes.append(
          CodeSidenote(id: n.id, place: p, text: t.text, alwaysShow: t.alwaysShow, question: t.question))
      }
    }
    var stripped = b
    stripped.sidenotes.removeAll { codeSpot($0, spots) != nil }
    stripped.updateSegments { card, seg in
      if spots[CodeSpot(card: card, segment: seg.id)] != nil { seg.highlights = [] }
    }
    return (stripped, out)
  }

  /// What the board's file keeps: the board without what is its repositories'
  public func stripped(_ b: Board) -> Board {
    var out = b
    strip(&out, spots(b))
    return out
  }

  private func strip(_ b: inout Board, _ spots: [CodeSpot: Shown]) {
    guard !spots.isEmpty else { return }
    b.sidenotes.removeAll { Self.codeSpot($0, spots) != nil }
    b.updateSegments { card, seg in if spots[CodeSpot(card: card, segment: seg.id)] != nil { seg.highlights = [] } }
  }

  // MARK: Showing

  /// The board's segments show their repositories' annotations as they are now: their Highlights those whose lines
  /// they have as they were, with the lines of the sidenotes on them; each sidenote on the first card showing its lines
  /// (one of an id the board has for something else is not shown). A sidenote kept keeps what the board marks on it
  public func show(_ b: inout Board) {
    let all = shown(b)
    let spots = Dictionary(all.map { ($0.spot, $0) }, uniquingKeysWith: { a, _ in a })
    let existing = Self.notes(b, spots)
    var taken = Set(b.sidenotes.filter { existing[$0.id] == nil }.map(\.id))
    var wanted: [SidenoteID: Sidenote] = [:]
    var order: [SidenoteID] = []
    var highlights: [CodeSpot: [ClosedRange<Int>]] = [:]
    for s in all {
      let have = notes(s.key, s.path)
      var hs = have.highlights.filter { $0.place.isOn(s.seg) }.map(\.place.lines)
      for c in have.sidenotes where c.place.isOn(s.seg) && taken.insert(c.id).inserted {
        var n = existing[c.id]?.0 ?? Sidenote(id: c.id, anchor: .point(x: 0, y: 0), body: .text(c.note))
        n.anchor = .card(s.spot.card, segment: s.spot.segment, lines: c.place.lines)
        n.body = .text(c.note)
        n.lineRemoved = false
        n.boardOnly = false
        wanted[c.id] = n
        order.append(c.id)
        hs.append(c.place.lines)
      }
      highlights[s.spot] = Board.union(hs)
    }
    var out: [Sidenote] = []
    var placed = Set<SidenoteID>()
    for n in b.sidenotes {
      if existing[n.id] == nil {
        out.append(n)
      } else if let w = wanted[n.id] {
        out.append(w)
        placed.insert(n.id)
      }
    }
    for id in order where !placed.contains(id) { out.append(wanted[id]!) }
    if out != b.sidenotes { b.sidenotes = out }
    b.updateSegments { card, seg in
      if let h = highlights[CodeSpot(card: card, segment: seg.id)], seg.highlights != h { seg.highlights = h }
    }
  }

  // MARK: Taking in

  /// What the board shows on its repositories' code that they do not have, added to them (an older board, a card
  /// pasted, a repository whose key became known; `only`: these segments): a Highlight's lines no Highlight of theirs
  /// on those lines and text has (its id made from the board, card, segment and lines), a sidenote unless one of its
  /// id is there the same (else under an id made from the board and its own)
  public func adopt(_ b: Board, only: Set<CodeSpot>? = nil) {
    let all = shown(b).filter { only?.contains($0.spot) ?? true }
    guard !all.isEmpty else { return }
    let spots = Dictionary(all.map { ($0.spot, $0) }, uniquingKeysWith: { a, _ in a })
    batch {
      for s in all {
        addHighlights(Self.lines(s.seg.highlights, in: s.seg), on: s, board: b.id)
      }
      for n in b.sidenotes {
        guard let s = Self.codeSpot(n, spots), let l = n.anchor.lines?.range else { continue }
        add(n, l, on: s, board: b.id)
      }
    }
  }

  /// Lines of a shown segment highlighted in its repository's file, those no Highlight there has already
  private func addHighlights(_ lines: Set<Int>, on s: Shown, board: BoardID) {
    let covered = Self.lines(
      notes(s.key, s.path).highlights.filter { $0.place.isOn(s.seg) }.map(\.place.lines), in: s.seg)
    let runs = Self.runs(lines.subtracting(covered))
    guard !runs.isEmpty else { return }
    change(s.key) { n in
      for r in runs {
        guard let p = CodePlace(s.seg, r) else { continue }
        var id = "h" + codeHash("\(board.rawValue)\0\(s.spot.card.rawValue)\0\(s.spot.segment.rawValue)\0\(r)")
        if n.has(highlight: id) { id = Board.newID("h") }
        n.files[s.path, default: CodeFileNotes()].highlights.append(CodeHighlight(id: id, place: p, at: Self.now))
      }
    }
  }

  /// A board's text sidenote on lines `l` of a shown segment, added to its repository's file unless there the same
  private func add(_ n: Sidenote, _ l: ClosedRange<Int>, on s: Shown, board: BoardID) {
    guard case .text(let t) = n.body, let p = CodePlace(s.seg, l) else { return }
    var c = CodeSidenote(id: n.id, place: p, text: t.text, alwaysShow: t.alwaysShow, question: t.question)
    let have = repository(s.key)
    func same(_ x: CodeSidenote) -> Bool {
      x.place.lines == c.place.lines && x.place.text == c.place.text && x.text == c.text
        && x.alwaysShow == c.alwaysShow && x.question == c.question
    }
    for candidate in [n.id, SidenoteID(rawValue: "n" + codeHash("\(board.rawValue)\0\(n.id.rawValue)"))] {
      c.id = candidate
      if let there = have.files[s.path]?.sidenotes.first(where: { $0.id == candidate }), same(there) { return }
      if !have.has(sidenote: candidate) { break }
      c.id = SidenoteID(rawValue: Board.newID("n"))
    }
    change(s.key) { $0.files[s.path, default: CodeFileNotes()].sidenotes.append(c) }
  }

  /// Consecutive lines as runs, in order
  nonisolated static func runs(_ lines: Set<Int>) -> [ClosedRange<Int>] {
    var out: [ClosedRange<Int>] = []
    for l in lines.sorted() {
      if let last = out.last, last.upperBound == l - 1 {
        out[out.count - 1] = last.lowerBound...l
      } else {
        out.append(l...l)
      }
    }
    return out
  }

  // MARK: Settling a change

  /// What a change of the board (`before` → `after`) did to what is its repositories' done to them, and `after` brought
  /// in step with them: a sidenote written, moved to other lines or deleted on a card that still shows its lines; lines
  /// highlighted or no longer; lines followed to a new version of a segment (`lineMap`), what is on lines gone kept in
  /// the file and shown nowhere; a card deleted, shelved or with its annotations hidden leaves them as they are
  public func settle(_ before: Board, _ after: inout Board) {
    let was = spots(before)
    let now = spots(after)
    let bNotes = Self.notes(before, was)
    let aNotes = Self.notes(after, now)
    let board = after.id
    var toAdopt = Set(
      now.keys.filter { was[$0] == nil || was[$0]!.key != now[$0]!.key || was[$0]!.path != now[$0]!.path })
    var gone: Set<SidenoteID> = []
    batch {
      for (id, (n, s)) in aNotes.sorted(by: { $0.key.rawValue < $1.key.rawValue }) where !toAdopt.contains(s.spot) {
        guard let l = n.anchor.lines?.range, case .text(let t) = n.body else { continue }
        guard let (bn, bs) = bNotes[id], bs.key == s.key, bs.path == s.path else {
          if let (_, bs) = bNotes[id] { change(bs.key) { $0.removeSidenote(id, bs.path) } }
          add(n, l, on: s, board: board)
          continue
        }
        if bn == n && Self.sameCode(bs.seg, s.seg) { continue }
        let moved = bn.anchor != n.anchor || !Self.sameCode(bs.seg, s.seg)
        change(s.key) { r in
          guard let i = r.files[s.path]?.sidenotes.firstIndex(where: { $0.id == id }) else { return }
          r.files[s.path]!.sidenotes[i].text = t.text
          r.files[s.path]!.sidenotes[i].alwaysShow = t.alwaysShow
          r.files[s.path]!.sidenotes[i].question = t.question
          if moved, let p = CodePlace(s.seg, l) { r.files[s.path]!.sidenotes[i].place = p }
        }
      }
      for (id, (_, bs)) in bNotes where aNotes[id] == nil {
        // the card gone, shelved or not showing them: the repository keeps it
        guard let a = now[bs.spot] else { continue }
        if let n = after.sidenote(id), n.lineRemoved, n.anchor == .card(a.spot.card) {
          // its lines gone with a new version: kept in the file, shown nowhere
          gone.insert(id)
          continue
        }
        change(bs.key) { $0.removeSidenote(id, bs.path) }
      }
      for (spot, a) in now where !toAdopt.contains(spot) {
        let b = was[spot]!
        if Self.sameCode(b.seg, a.seg) {
          let had = Self.lines(b.seg.highlights, in: b.seg)
          let has = Self.lines(a.seg.highlights, in: a.seg)
          let off = had.subtracting(has)
          if !off.isEmpty { change(a.key) { $0.unhighlight(off, on: a.seg, a.path) } }
          addHighlights(has.subtracting(had), on: a, board: board)
        } else {
          let map = lineMap(b.seg.lines, b.seg.firstLine, a.seg.lines, a.seg.firstLine)
          change(a.key) { r in
            for (i, h) in (r.files[a.path]?.highlights ?? []).enumerated() where h.place.isOn(b.seg) {
              guard let to = Board.mapRange({ map[$0] }, h.place.lines), let p = CodePlace(a.seg, to) else { continue }
              r.files[a.path]!.highlights[i].place = p
            }
          }
          toAdopt.insert(spot)
        }
      }
      adopt(after, only: toAdopt)
    }
    if !gone.isEmpty { after.sidenotes.removeAll { gone.contains($0.id) } }
    // what was shown on cards that left the canvas or hid them is the repository's, not theirs
    let left = Dictionary(uniqueKeysWithValues: was.filter { now[$0.key] == nil }.map { ($0.key, $0.value) })
    if !left.isEmpty {
      after.sidenotes.removeAll { n in bNotes[n.id].map { left[$0.1.spot] != nil } == true && aNotes[n.id] == nil }
      after.updateSegments(shelf: true) { card, seg in
        if left[CodeSpot(card: card, segment: seg.id)] != nil { seg.highlights = [] }
      }
    }
    show(&after)
  }
}

extension RepositoryNotes {
  mutating func removeSidenote(_ id: SidenoteID, _ path: String) {
    files[path]?.sidenotes.removeAll { $0.id == id }
    if files[path]?.isEmpty == true { files[path] = nil }
  }

  /// Lines no longer highlighted on a segment: the Highlights there shown on it lose them, cut in two when that leaves
  /// two runs (the second under a new id), gone when it leaves none
  mutating func unhighlight(_ off: Set<Int>, on s: Segment, _ path: String) {
    guard var f = files[path] else { return }
    var out: [CodeHighlight] = []
    for h in f.highlights {
      guard h.place.isOn(s), h.place.lines.contains(where: off.contains) else {
        out.append(h)
        continue
      }
      for (k, r) in CodeNotes.runs(Set(h.place.lines).subtracting(off)).enumerated() {
        guard let p = CodePlace(s, r) else { continue }
        out.append(CodeHighlight(id: k == 0 ? h.id : Board.newID("h"), place: p, at: h.at))
      }
    }
    f.highlights = out
    files[path] = f.isEmpty ? nil : f
  }
}

extension Board {
  /// Every code card's segments (`shelf`: the shelved ones' too) changed by `f`, given the card
  mutating func updateSegments(shelf alsoShelf: Bool = false, _ f: (CardID, inout Segment) -> Void) {
    func update(_ c: inout Card) {
      guard case .own(var k) = c.content, case .code(var code) = k.body else { return }
      let was = code
      for i in code.segments.indices { f(c.id, &code.segments[i]) }
      guard code != was else { return }
      k.body = .code(code)
      c.content = .own(k)
    }
    for i in cards.indices { update(&cards[i]) }
    if alsoShelf { for e in shelf.indices { for i in shelf[e].cards.indices { update(&shelf[e].cards[i]) } } }
  }
}

extension Board {
  /// Show Annotations on or off for a code card: off, it shows none of its repository's Highlights and sidenotes
  public mutating func setAnnotationsHidden(_ card: CardID, _ hidden: Bool) {
    guard let i = cards.firstIndex(where: { $0.id == card }), case .own(var k) = cards[i].content,
      case .code(var code) = k.body
    else { return }
    code.annotationsHidden = hidden ? true : nil
    k.body = .code(code)
    cards[i].content = .own(k)
  }
}

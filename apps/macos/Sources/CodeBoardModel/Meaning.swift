import Foundation

// ⌘K's Related by Meaning (host meaning.ts, ui/Palette.tsx): every card and every sidenote on a card, of every board,
// handed to box (BoxService) as the vault's items, and box's hits as the rows the palette shows. As VS Code, except
// that shelved cards and their sidenotes are indexed too, and no pictures are. The source is the vault's folder, its ref
// "_" (the vault runs no git).

public enum Meaning {
  /// Rows in the group
  public static let top = 8
  /// Closeness below which a card is not related at all (meaning.ts MIN_SCORE, measured there)
  public static let minScore = 0.55
  /// Closeness below which a row is shown faint, as a "maybe" (meaning.ts FAINT_BELOW)
  public static let faintBelow = 0.635
  public static let ref = "_"

  /// Where a row goes
  public struct Target: Equatable, Sendable {
    public enum Kind: String, Sendable { case card, sidenote }
    public var kind: Kind
    /// A card's title; a sidenote's first line
    public var label: String
    /// The board a pick opens: the board searched from when it is there, else the first that shows it
    public var board: BoardID
    /// Every board that shows it
    public var boards: [BoardID]
    /// The card, or the card the sidenote is on
    public var card: CardID
    public var sidenote: SidenoteID?
    /// The card is on `board`'s Shelf: the entry that putting it back takes out
    public var shelf: String?
  }

  /// The vault's items as handed to box, and what each one is
  public struct Docs: Sendable {
    public var source: String
    public var ref: String
    var order: [String] = []
    var docs: [String: Doc] = [:]

    public var items: [BoxItem] {
      order.compactMap { id in
        docs[id].map { BoxItem(id: id, title: $0.title, text: $0.text, groups: $0.boards.map(\.rawValue)) }
      }
    }
  }

  struct Doc: Sendable {
    var kind: Target.Kind
    var title: String
    var label: String
    var text: String
    var card: CardID
    var sidenote: SidenoteID?
    var boards: [BoardID]
    /// The Shelf entry it is in, per board
    var shelf: [BoardID: String]
  }

  public struct Row: Equatable, Sendable {
    public var target: Target
    public var score: Double
    /// Below faintBelow: shown as a "maybe"
    public var faint: Bool
    /// The paragraph that matched; nil when the whole item did
    public var passage: String?
  }

  public struct Answer: Equatable, Sendable {
    public var rows: [Row]
    /// Pieces still to embed: "indexing, N left", and ask again a little later
    public var left: Int
    public var error: String?
    public var model: String?
  }

  /// The items of every board (shared cards read in), the board searched from first so it is indexed first
  public static func docs(_ boards: [BoardSearch.Source], vault: Vault, here: BoardID?) -> Docs {
    var out = Docs(source: vault.root.standardizedFileURL.path, ref: ref)
    func add(_ id: String, _ doc: Doc, on board: BoardID, shelf: String?) {
      if out.docs[id] == nil {
        out.order.append(id)
        out.docs[id] = doc
      } else if !out.docs[id]!.boards.contains(board) {
        out.docs[id]!.boards.append(board)
      }
      if let shelf { out.docs[id]!.shelf[board] = shelf }
    }
    let ordered = boards.enumerated().sorted {
      ($0.element.id == here ? 0 : 1, $0.offset) < ($1.element.id == here ? 0 : 1, $1.offset)
    }
    for src in ordered.map(\.element) {
      let b = src.board
      let cards = b.cards.map { (card: $0, entry: String?.none) } + b.shelf.flatMap { e in e.cards.map { ($0, e.id) } }
      var entry: [CardID: String] = [:]
      var titles: [CardID: String] = [:]
      for (c, e) in cards {
        guard case .own(let content) = c.content else { continue }
        let title = cardTitle(content)
        titles[c.id] = title
        entry[c.id] = e
        add(
          "card:\(c.id.rawValue)",
          Doc(
            kind: .card, title: title, label: title, text: text(content, summary: c.summary?.text), card: c.id,
            boards: [src.id], shelf: [:]),
          on: src.id, shelf: e)
      }
      for n in b.sidenotes {
        guard let on = n.anchor.card else { continue }
        let t = BoardSearch.sidenoteText(n)
        guard !jsTrim(t).isEmpty else { continue }
        let line = jsTrim(t.components(separatedBy: "\n").first { !jsTrim($0).isEmpty } ?? "")
        add(
          "sidenote:\(n.id.rawValue)",
          Doc(
            kind: .sidenote, title: titles[on] ?? "",
            label: String(decoding: Array(line.utf16.prefix(80)), as: UTF16.self),
            text: t, card: on, sidenote: n.id, boards: [src.id], shelf: [:]),
          on: src.id, shelf: entry[on])
      }
    }
    return out
  }

  /// What a card says (meaning.ts cardText): its description and summary, then its own text
  static func text(_ c: CardContent, summary: String?) -> String {
    let own: String
    switch c.body {
    case .note(let n): own = n.text
    case .text(let t): own = t.text
    case .code(let code):
      own = code.segments.map { s in
        ([s.symbol?.name ?? s.scope ?? "", BoardSearch.path(s)] + s.annotations.map(\.text)
          + [s.lines.joined(separator: "\n")]).joined(separator: "\n")
      }.joined(separator: "\n")
    case .image(let i): own = i.alt ?? ""
    case .web(let w):
      own = [w.url, w.meta?.title, w.meta?.description, w.meta?.site].compactMap { $0 }.filter { !$0.isEmpty }
        .joined(separator: "\n")
    case .links(let l):
      own = l.items.map { [$0.title ?? $0.meta?.title ?? "", $0.url].joined(separator: " ") }.joined(separator: "\n")
    case .board: own = ""
    }
    return [c.description, summary, own].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
  }

  /// box's question for `q`: twice the rows shown, so the ones gone since the sync still leave enough
  public static func query(_ q: String, in docs: Docs, here: BoardID?, onlyHere: Bool, model: String? = nil) -> BoxQuery
  {
    BoxQuery(
      source: docs.source, ref: docs.ref, q: q, k: top * 2, groups: onlyHere ? here.map { [$0.rawValue] } : nil,
      minScore: minScore, model: model)
  }

  /// box's hits as rows, in its order: the first `top` whose item is still there (onlyHere: on the board here, going
  /// there), less those the word search already lists (`found`)
  public static func rows(
    _ hits: [BoxHit], in docs: Docs, here: BoardID?, onlyHere: Bool, found: [BoardSearch.Item] = []
  ) -> [Row] {
    var out: [Row] = []
    for h in hits {
      guard let d = docs.docs[h.id] else { continue }
      if onlyHere, here.map(d.boards.contains) != true { continue }
      let board = onlyHere ? here! : d.boards[0]
      // a paragraph matched: it is the passage to show; the whole item matched: none
      let passage = h.piece > 0 ? h.range.flatMap { slice(d.text, $0) } : nil
      out.append(
        Row(
          target: Target(
            kind: d.kind, label: d.label, board: board, boards: d.boards, card: d.card, sidenote: d.sidenote,
            shelf: d.shelf[board]),
          score: h.score, faint: h.score < faintBelow, passage: passage))
      if out.count >= top { break }
    }
    let seen = Set(found.map { $0.sidenote.map { "s:\($0)" } ?? "c:\($0.card)" })
    return out.filter {
      !seen.contains($0.target.sidenote.map { "s:\($0.rawValue)" } ?? "c:\($0.target.card.rawValue)")
    }
  }

  /// Related by Meaning for `q`: what is indexed so far. A service that has no endpoint for the vault (it started since
  /// the last sync) is synced and asked again
  public static func search(
    _ q: String, index: some MeaningIndex, docs: Docs, embedder: BoxEmbedder, here: BoardID?, onlyHere: Bool = false,
    found: [BoardSearch.Item] = []
  ) async throws -> Answer {
    guard !jsTrim(q).isEmpty else { return Answer(rows: [], left: 0) }
    let question = query(q, in: docs, here: here, onlyHere: onlyHere)
    var r = try await index.search(question)
    if r.unsynced == true {
      try await index.sync(docs, embedder: embedder)
      r = try await index.search(question)
    }
    return Answer(
      rows: rows(r.hits, in: docs, here: here, onlyHere: onlyHere, found: found), left: r.left ?? 0,
      error: r.error?.isEmpty == false ? r.error : nil, model: r.model)
  }

  /// The rows in the reranker's order, to reorder to once search's answer is whole (left 0); empty: keep the order shown
  /// (a newer query's rerank began, or nothing is left). Ask only while the gate is open, and tell it of an error
  public static func rerank(
    _ q: String, index: some MeaningIndex, docs: Docs, here: BoardID?, onlyHere: Bool = false,
    found: [BoardSearch.Item] = [], model: String? = nil
  ) async throws -> [Row] {
    let r = try await index.rerank(query(q, in: docs, here: here, onlyHere: onlyHere, model: model))
    if r.superseded == true { return [] }
    return rows(r.hits, in: docs, here: here, onlyHere: onlyHere, found: found)
  }

  /// UTF-16 offsets [from, to] of `s`
  private static func slice(_ s: String, _ r: [Int]) -> String? {
    let u = Array(s.utf16)
    guard r.count == 2, 0 <= r[0], r[0] <= r[1], r[1] <= u.count else { return nil }
    return String(decoding: u[r[0]..<r[1]], as: UTF16.self)
  }
}

/// Whether box's rerank is worth asking (meaning.ts RerankGate): not once the embedding server was found to have no
/// reranking model. A new gate, made when the embedding settings change, asks again
public struct RerankGate: Sendable {
  public private(set) var open = true

  public init() {}

  /// A rerank failed: true when it says the server has no reranking model (the gate shuts); any other error (the
  /// server down) changes nothing
  public mutating func answered(_ error: Error) -> Bool {
    guard case BoxError.service(let m) = error, m.hasPrefix(boxNoReranker) else { return false }
    open = false
    return true
  }
}

extension MeaningIndex {
  /// Hands box the vault's items as they are now; it answers at once and embeds in the background
  public func sync(_ docs: Meaning.Docs, embedder: BoxEmbedder) async throws {
    _ = try await sync(source: docs.source, ref: docs.ref, embedder: embedder, items: docs.items)
  }
}

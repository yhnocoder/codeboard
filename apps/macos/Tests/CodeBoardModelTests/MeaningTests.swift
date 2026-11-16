import Foundation
import Testing

@testable import CodeBoardModel

// ⌘K's Related by Meaning (host meaning.ts): the vault's items handed to box, and box's hits as rows

private func cid(_ s: String) -> CardID { CardID(rawValue: s) }
private func note(_ id: String, _ text: String, shared: Bool = false, summary: String? = nil) -> Card {
  Card(
    id: cid(id), x: 0, y: 0, width: 240,
    summary: summary.map { Summary(text: $0, at: 0, sig: "") },
    content: .own(CardContent(body: .note(Note(text: text)))), isShared: shared)
}
private func sidenote(_ id: String, on card: String, _ text: String) -> Sidenote {
  Sidenote(id: SidenoteID(rawValue: id), anchor: .card(cid(card)), body: .text(TextNote(text: text)))
}

private let here = BoardID(rawValue: "here")
private let other = BoardID(rawValue: "other")

/// Two boards: a shared card (and the sidenote travelling with it) on both, a shelved card with a sidenote on `here`
private func docs() -> Meaning.Docs {
  let seg = Segment(
    id: SegmentID(rawValue: "s1"), source: .file(path: "nanovllm/engine/scheduler.py", hash: nil), language: "python",
    firstLine: 12, lines: ["def schedule(self):", "    return self.waiting"],
    symbol: Symbol(name: "Scheduler.schedule", kind: .function),
    annotations: [Annotation(line: 12, from: 0, to: 3, text: "the loop")])
  let code = Card(
    id: cid("c1"), x: 0, y: 0, width: 400,
    content: .own(CardContent(description: "Picks what runs", body: .code(CodeCard(segments: [seg])))))
  let web = Card(
    id: cid("w"), x: 0, y: 0, width: 300,
    content: .own(
      CardContent(
        body: .web(WebCard(url: "https://example.com/kv", meta: WebMeta(title: "KV", description: "Paged", site: "Ex")))
      )))
  let a = Board(
    id: here, cards: [code, note("sh", "# Block table", shared: true, summary: "**blocks**"), web],
    sidenotes: [
      sidenote("sn1", on: "c1", "\n  waiting queue is FIFO\nlast"), sidenote("empty", on: "c1", "  \n"),
      sidenote("travel", on: "sh", "Freed at the end"), sidenote("put-note", on: "put", "Aside note"),
      Sidenote(id: SidenoteID(rawValue: "free"), anchor: .point(x: 0, y: 0), body: .text(TextNote(text: "on canvas"))),
    ],
    shelf: [ShelfEntry(id: "e1", at: 0, cards: [note("put", "# Waiting room")])])
  let b = Board(
    id: other, cards: [note("n2", "# Waiting list"), note("sh", "# Block table", shared: true)],
    sidenotes: [sidenote("travel", on: "sh", "Freed at the end")])
  let src = { (id: BoardID, name: String, board: Board) in
    BoardSearch.Source(id: id, name: name, board: board, images: URL(filePath: "/v/\(name).board/images"))
  }
  return Meaning.docs(
    [src(other, "Other", b), src(here, "Here", a)], vault: Vault(root: URL(filePath: "/v")), here: here)
}

@Suite struct MeaningTests {
  @Test func itemsAreEveryCardAndSidenoteOnACardShelvedOnesToo() {
    let d = docs()
    #expect(d.source == "/v" && d.ref == "_")
    let items = Dictionary(uniqueKeysWithValues: d.items.map { ($0.id, $0) })
    // here's board first; the canvas sidenote and the empty one are not items
    #expect(
      d.items.map(\.id) == [
        "card:c1", "card:sh", "card:w", "card:put", "sidenote:sn1", "sidenote:travel", "sidenote:put-note", "card:n2",
      ])
    #expect(items["card:sh"]?.groups == ["here", "other"])
    #expect(items["sidenote:travel"]?.groups == ["here", "other"])
    #expect(items["sidenote:travel"]?.title == "Block table")
    #expect(items["card:put"]?.groups == ["here"])
    #expect(items["card:c1"]?.title == "Scheduler.schedule")
    #expect(
      items["card:c1"]?.text
        == "Picks what runs\nScheduler.schedule\nnanovllm/engine/scheduler.py\nthe loop\ndef schedule(self):\n    return self.waiting"
    )
    #expect(items["card:sh"]?.text == "**blocks**\n# Block table")
    #expect(items["card:w"]?.text == "https://example.com/kv\nKV\nPaged\nEx")
  }

  @Test func hitsBecomeRowsThatGoToTheirCard() throws {
    let d = docs()
    let rows = Meaning.rows(
      [
        BoxHit(id: "card:gone", score: 0.9), BoxHit(id: "sidenote:put-note", score: 0.8),
        BoxHit(id: "card:sh", score: 0.7, piece: 1, range: [2, 7]), BoxHit(id: "card:n2", score: 0.6),
      ], in: d, here: here, onlyHere: false)
    // a hit whose item is gone is left out; box's order is kept
    #expect(rows.map(\.target.card) == [cid("put"), cid("sh"), cid("n2")])
    let shelved = rows[0].target
    #expect(shelved.kind == .sidenote && shelved.sidenote == SidenoteID(rawValue: "put-note"))
    #expect(shelved.board == here && shelved.shelf == "e1" && shelved.label == "Aside note")
    #expect(rows[1].passage == "block" && rows[1].target.boards == [here, other] && rows[1].target.shelf == nil)
    #expect(rows[2].target.board == other && rows[2].passage == nil)
    #expect(rows.map(\.faint) == [false, false, true])
    // this board only: what is not on it goes
    #expect(
      Meaning.rows(
        [BoxHit(id: "card:n2", score: 0.7), BoxHit(id: "card:sh", score: 0.7)], in: d, here: here, onlyHere: true
      )
      .map(\.target.card) == [cid("sh")])
  }

  @Test func eightAreKeptThenWhatTheWordsFoundGoes() {
    let b = Board(id: here, cards: (0..<12).map { note("n\($0)", "# Note \($0)") })
    let src = [BoardSearch.Source(id: here, name: "Here", board: b, images: URL(filePath: "/i"))]
    let d = Meaning.docs(src, vault: Vault(root: URL(filePath: "/v")), here: here)
    let hits = (0..<12).map { BoxHit(id: "card:n\($0)", score: 0.9 - Double($0) / 100) }
    #expect(Meaning.rows(hits, in: d, here: here, onlyHere: false).count == 8)
    let words = BoardSearch.search("Note 1", in: src, here: here, thisBoard: false)
    let rows = Meaning.rows(hits, in: d, here: here, onlyHere: false, found: words)
    // "Note 1" finds n1, n10 and n11; of the first eight only n1 is among them
    #expect(rows.map(\.target.card.rawValue) == ["n0", "n2", "n3", "n4", "n5", "n6", "n7"])
  }

  @Test func searchSyncsAgainWhenTheServiceHasNoEndpointAndRerankReorders() async throws {
    let d = docs()
    let index = FakeIndex()
    let e = BoxEmbedder(base: "http://127.0.0.1:1/v1")
    let a = try await Meaning.search("waiting", index: index, docs: d, embedder: e, here: here)
    #expect(index.calls == ["search", "sync", "search"])
    #expect(index.synced == d.items.count && index.asked?.k == 16 && index.asked?.minScore == 0.55)
    #expect(a.rows.map(\.target.card) == [cid("sh"), cid("n2")] && a.left == 3)
    let r = try await Meaning.rerank("waiting", index: index, docs: d, here: here)
    #expect(r.map(\.target.card) == [cid("n2"), cid("sh")])
    index.supersede = true
    #expect(try await Meaning.rerank("waiting", index: index, docs: d, here: here).isEmpty)
  }

  @Test func theGateShutsOnlyWhenTheServerHasNoReranker() {
    var gate = RerankGate()
    #expect(!gate.answered(BoxError.timedOut) && gate.open)
    #expect(!gate.answered(BoxError.service("connection refused")) && gate.open)
    #expect(gate.answered(BoxError.service("\(boxNoReranker) at http://x")) && !gate.open)
  }
}

/// Answers unsynced to the first search, then two hits; rerank swaps them
private final class FakeIndex: MeaningIndex, @unchecked Sendable {
  var calls: [String] = []
  var synced = 0
  var asked: BoxQuery?
  var supersede = false

  func sync(source: String, ref: String, embedder: BoxEmbedder, items: [BoxItem]) async throws -> Int {
    calls.append("sync")
    synced = items.count
    return items.count
  }

  func search(_ q: BoxQuery) async throws -> BoxResult {
    calls.append("search")
    asked = q
    let hits = [BoxHit(id: "card:sh", score: 0.7), BoxHit(id: "card:n2", score: 0.6)]
    return BoxResult(
      hits: calls.count == 1 ? [] : hits, left: 3, unsynced: calls.count == 1 ? true : nil, source: q.source, ref: q.ref
    )
  }

  func rerank(_ q: BoxQuery) async throws -> BoxResult {
    if supersede { return BoxResult(hits: [], left: nil, superseded: true, source: q.source, ref: q.ref) }
    return BoxResult(
      hits: [BoxHit(id: "card:n2", score: 0.6, rerank: 0.9), BoxHit(id: "card:sh", score: 0.7, rerank: 0.2)],
      source: q.source, ref: q.ref)
  }

  func status(source: String, ref: String) async throws -> BoxStatus {
    BoxStatus(items: 0, pieces: 0, left: 0, indexing: false, synced: true)
  }
}

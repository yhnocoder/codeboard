import Foundation
import Testing

@testable import CodeBoardModel

// ⌘K's word matches (host search.ts, core rank.ts fuzzy, host preview.ts): the cards and sidenotes of every board, this
// board's first; ⌘F only this board's

private func cid(_ s: String) -> CardID { CardID(rawValue: s) }
private func own(_ body: CardContent.Body, title: String? = nil, description: String? = nil) -> Card.Content {
  .own(CardContent(title: title, description: description, body: body))
}
private func note(_ id: String, _ text: String, section: String? = nil) -> Card {
  Card(id: cid(id), x: 0, y: 0, width: 240, section: section.map(SectionID.init), content: own(.note(Note(text: text))))
}

private let here = BoardID(rawValue: "here")
private let other = BoardID(rawValue: "other")

private func boards() -> [BoardSearch.Source] {
  let seg = Segment(
    id: SegmentID(rawValue: "s1"), source: .file(path: "nanovllm/engine/scheduler.py", hash: nil), language: "python",
    firstLine: 12, lines: ["def schedule(self):", "    return self.waiting"],
    symbol: Symbol(name: "Scheduler.schedule", kind: .function))
  let shared = Card(
    id: cid("sh"), x: 0, y: 0, width: 240, content: own(.note(Note(text: "# Block table"))), isShared: true)
  let a = Board(
    id: here,
    cards: [
      note("n1", "# KV cache\n\nThe scheduler frees blocks", section: "g2"),
      Card(id: cid("c1"), x: 0, y: 0, width: 400, content: own(.code(CodeCard(segments: [seg])))),
      shared,
    ],
    sections: [
      Section(id: SectionID(rawValue: "g1"), title: "Engine", x: 0, y: 0, width: 900, height: 900),
      Section(
        id: SectionID(rawValue: "g2"), title: "Memory", x: 0, y: 0, width: 500, height: 500,
        parent: SectionID(rawValue: "g1")),
    ],
    sidenotes: [
      Sidenote(
        id: SidenoteID(rawValue: "sn1"), anchor: .card(cid("c1")),
        body: .text(TextNote(text: "First line\nwaiting queue is FIFO\nlast"))),
      Sidenote(
        id: SidenoteID(rawValue: "sn2"), anchor: .point(x: 0, y: 0), body: .text(TextNote(text: "waiting free"))),
    ],
    shelf: [ShelfEntry(id: "e1", at: 0, cards: [note("put", "# Waiting room")])])
  let b = Board(
    id: other,
    cards: [note("n2", "# Waiting list"), shared],
    shelf: [ShelfEntry(id: "e2", at: 0, cards: [note("gone", "# Waiting aside")])])
  return [
    BoardSearch.Source(id: other, name: "Other", board: b, images: URL(filePath: "/v/Other.board/images")),
    BoardSearch.Source(id: here, name: "Here", board: a, images: URL(filePath: "/v/Here.board/images")),
  ]
}

private func found(_ q: String, thisBoard: Bool = false) -> [String] {
  BoardSearch.search(q, in: boards(), here: here, thisBoard: thisBoard).map { $0.sidenote ?? $0.card }
}

@Test func theFuzzyMatchTakesSubstringsAndTightSubsequencesOnly() {
  #expect(BoardSearch.fuzzy("ca", "can_allocate") > 0)
  #expect(BoardSearch.fuzzy("bm", "BlockManager") > 0)
  #expect(BoardSearch.fuzzy("step", "main") < 0)
  // a substring at a word start scores over one inside a word, and over any subsequence
  #expect(BoardSearch.fuzzy("man", "BlockManager") > BoardSearch.fuzzy("man", "command"))
  #expect(BoardSearch.fuzzy("blm", "BlockManager") < BoardSearch.fuzzy("block", "BlockManager"))
  #expect(BoardSearch.fuzzy("", "x") == 0)
}

@Test func cardsAreFoundByTitleAndBodyThisBoardFirst() {
  // a title match (fuzzy) ranks over a match in the body (20); this board's over another's at the same score
  #expect(found("waiting") == ["put", "n2", "sn1"])
  #expect(found("scheduler") == ["c1", "n1"])
  let items = BoardSearch.search("scheduler", in: boards(), here: here, thisBoard: false)
  #expect(items.map(\.label) == ["Scheduler.schedule", "KV cache"])
  #expect(items.map(\.detail) == ["This board", "This board"])
  #expect(items.allSatisfy { $0.kind == .card && $0.board == "here" })
}

@Test func aSharedCardIsListedOnceWithTheBoardsItIsOn() {
  let items = BoardSearch.search("block table", in: boards(), here: here, thisBoard: false)
  #expect(items.count == 1)
  #expect(items.first?.board == "here" && items.first?.detail == "⧉ This board · Other")
}

@Test func thisBoardOnlyListsThisBoardsCardsAndSidenotes() {
  #expect(found("waiting", thisBoard: true) == ["put", "sn1"])
  #expect(found("list", thisBoard: true).isEmpty)
}

@Test func aSidenoteIsFoundByItsTextOnACardOnly() {
  let s = BoardSearch.search("fifo", in: boards(), here: here, thisBoard: false)
  #expect(s.count == 1)
  let n = try! #require(s.first)
  #expect(n.kind == .sidenote && n.sidenote == "sn1" && n.card == "c1")
  #expect(n.label == "waiting queue is FIFO")
  #expect(n.detail == "Here · Scheduler.schedule")
  #expect(n.preview.md == "First line\nwaiting queue is FIFO\nlast")
  // the one free on the board is not looked through
  #expect(!found("free").contains("sn2"))
}

@Test func aShelvedCardIsFoundOnItsOwnBoardOnlyWithItsEntry() {
  let items = BoardSearch.search("waiting", in: boards(), here: here, thisBoard: false)
  #expect(items.first { $0.card == "put" }?.shelf == "e1")
  #expect(items.first { $0.card == "n2" }?.shelf == nil)
  #expect(!items.contains { $0.card == "gone" })
}

@Test func thePreviewIsTheCardAsMarkdownAndWhereItSits() {
  let items = BoardSearch.search("scheduler", in: boards(), here: here, thisBoard: false)
  let code = try! #require(items.first)
  #expect(
    code.preview.md
      == "`nanovllm/engine/scheduler.py:12`\n\n```python\ndef schedule(self):\n    return self.waiting\n```")
  #expect(code.preview.where == "Here")
  #expect(items[1].preview.where == "Here › Engine › Memory")
  #expect(items[1].images == URL(filePath: "/v/Here.board/images").absoluteString)
  // a long card: its first 2000 characters, then …
  let long = BoardSearch.Source(
    id: here, name: "Here", board: Board(id: here, cards: [note("l", "long " + String(repeating: "x", count: 3000))]),
    images: URL(filePath: "/v"))
  let md = try! #require(BoardSearch.search("long", in: [long], here: here, thisBoard: false).first?.preview.md)
  #expect(md.utf16.count == 2000 + 3 && md.hasSuffix("\n\n…"))
}

@Test func atMostSixtyAreListed() {
  let many = BoardSearch.Source(
    id: here, name: "Here", board: Board(id: here, cards: (0..<80).map { note("n\($0)", "# Step \($0)") }),
    images: URL(filePath: "/v"))
  #expect(BoardSearch.search("step", in: [many], here: here, thisBoard: false).count == 60)
}

@Test func everyWordMustBeFoundInAnyOrderAndPlace() {
  // "kv" in the title, "frees" in the body
  #expect(found("kv frees") == ["n1"])
  #expect(found("frees kv") == ["n1"])
  #expect(found("kv nowhere").isEmpty)
  // a sidenote's words on different lines; its row is the first line with one
  let s = BoardSearch.search("fifo first", in: boards(), here: here, thisBoard: false)
  #expect(s.map { $0.sidenote ?? $0.card } == ["sn1"] && s.first?.label == "First line")
}

import Foundation
import Testing

@testable import CodeBoardModel

// Shared cards edited on an open board, pasted onto another board as the same card, and 同一块白板的共享卡

private func cid(_ s: String) -> CardID { CardID(rawValue: s) }

private func noteCard(_ id: String, _ text: String, x: Double = 0, same: String? = nil) -> Card {
  Card(id: cid(id), x: x, y: 0, width: 200, content: .own(CardContent(body: .note(Note(text: text)))), same: same)
}

private func text(_ c: Card?) -> String? {
  if case .own(let o)? = c?.content, case .note(let n) = o.body { n.text } else { nil }
}

/// A vault with boards "A" and "B" that both show shared card "s" (a Note with a travelling sidenote)
private func sharedVault() throws -> (Vault, URL, URL) {
  let vault = Vault(root: try scratch())
  let shared = SharedCard(
    id: cid("s"), content: CardContent(body: .note(Note(text: "shared"))),
    sidenotes: [Sidenote(id: SidenoteID(rawValue: "n1"), anchor: .card(cid("s")), body: .text(TextNote(text: "on it")))]
  )
  try FileManager.default.createDirectory(at: vault.sharedFolderURL, withIntermediateDirectories: true)
  try shared.encoded().write(to: vault.sharedFolderURL.appending(path: "s.json"))
  var files: [URL] = []
  for name in ["A", "B"] {
    let dir = vault.root.appending(path: "\(name).board")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let b = Board(
      id: BoardID(rawValue: name.lowercased()),
      cards: [Card(id: cid("s"), x: 0, y: 0, width: 200, content: .shared), noteCard("own", "mine", x: 300)])
    try b.encoded().write(to: dir.appending(path: Vault.boardFileName))
    files.append(dir.appending(path: Vault.boardFileName))
  }
  return (vault, files[0], files[1])
}

@MainActor @Suite(.serialized) struct SharedCardTests {
  @Test func aSharedCardIsEditedOnTheBoardAndWrittenToItsOwnFile() throws {
    let (vault, a, b) = try sharedVault()
    let docA = try BoardDocument(file: { a }, vault: vault)
    let docB = try BoardDocument(file: { b }, vault: vault)
    // read in, with the sidenote that travels with it
    #expect(text(docA.board.card(cid("s"))) == "shared")
    #expect(docA.board.sidenotes.map(\.id.rawValue) == ["n1"])
    #expect(!docA.isDirty)
    docA.edit("Write") { $0.write(cid("s"), text: "edited on A", layout: nil) }
    docA.flush()
    // the board file keeps only the reference; the shared card's file has the edit and its sidenote
    let fileA = try Board(decoding: Data(contentsOf: a), file: a)
    #expect(fileA.cards[0].content == .shared && fileA.cards[0].isShared && fileA.sidenotes.isEmpty)
    let s = try vault.sharedCard(cid("s"))
    #expect(s.content.body == .note(Note(text: "edited on A")))
    #expect(s.sidenotes.map(\.id.rawValue) == ["n1"])
    // the other board takes it in when the vault changes
    var merges = 0
    let stop = docB.observe { if $0 == .merge { merges += 1 } }
    defer { stop() }
    docB.diskChanged()
    #expect(text(docB.board.card(cid("s"))) == "edited on A")
    #expect(merges == 1 && !docB.isDirty)
    // undo on A puts it back, in the file too
    docA.undo()
    docA.flush()
    #expect(try vault.sharedCard(cid("s")).content.body == .note(Note(text: "shared")))
  }

  @Test func aBoardFileWithASharedCardsContentIsRefused() throws {
    let file = try scratch().appending(path: "board.json")
    var c = noteCard("s", "x")
    c.isShared = true
    let b = Board(id: BoardID(rawValue: "b"), cards: [c])
    try canonicalJSON(b).write(to: file)
    #expect(throws: VaultError.malformed(file, "card s: a shared card's content is in its own file")) {
      try Board(decoding: Data(contentsOf: file), file: file)
    }
  }

  @Test func pastedOntoAnotherBoardItIsTheSameSharedCard() throws {
    let vault = Vault(root: try scratch())
    let dirs = ["A", "B"].map { vault.root.appending(path: "\($0).board") }
    for d in dirs { try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true) }
    try FileManager.default.createDirectory(at: dirs[0].appending(path: "images"), withIntermediateDirectories: true)
    try Data("png".utf8).write(to: dirs[0].appending(path: "images/p.png"))
    var a = Board(
      id: BoardID(rawValue: "a"),
      cards: [noteCard("c1", "with ![](images/p.png)"), noteCard("c2", "taken")],
      sidenotes: [
        Sidenote(id: SidenoteID(rawValue: "n1"), anchor: .card(cid("c1")), body: .text(TextNote(text: "travels")))
      ])
    try a.encoded().write(to: dirs[0].appending(path: Vault.boardFileName))
    try Board(id: BoardID(rawValue: "b")).encoded().write(to: dirs[1].appending(path: Vault.boardFileName))
    // c2's id is a shared card's already: sharing it gives it a new one
    try FileManager.default.createDirectory(at: vault.sharedFolderURL, withIntermediateDirectories: true)
    try SharedCard(id: cid("c2"), content: CardContent(body: .note(Note(text: "other"))))
      .encoded().write(to: vault.sharedFolderURL.appending(path: "c2.json"))
    let docA = try BoardDocument(file: { dirs[0].appending(path: Vault.boardFileName) }, vault: vault)
    let docB = try BoardDocument(file: { dirs[1].appending(path: Vault.boardFileName) }, vault: vault)
    a = docA.board
    let clip = a.clip([.card(cid("c1")), .card(cid("c2"))]) { _ in nil }
    #expect(clip.board == BoardID(rawValue: "a"))
    var renamed: [CardID: CardID] = [:]
    docA.sync {
      renamed = $0.share([cid("c1"), cid("c2")], taken: { vault.sharedCardExists($0) }) { _ in "c9" }
    }
    docA.flush()
    #expect(renamed == [cid("c2"): cid("c9")])
    let pasted = clip.renamed(renamed)
    docB.edit("Paste") { $0.paste(pasted, dx: 10, dy: 0, shared: true) }
    docB.flush()
    #expect(docB.board.cards.map(\.id) == [cid("c1"), cid("c9")] && docB.board.cards.allSatisfy(\.isShared))
    #expect(docB.board.sidenotes.map(\.id.rawValue) == ["n1"])
    // one file each, its images copied into the shared images folder; both boards refer to it
    #expect(try vault.sharedCard(cid("c1")).sidenotes.map(\.id.rawValue) == ["n1"])
    #expect(try vault.sharedCard(cid("c9")).content.body == .note(Note(text: "taken")))
    #expect(try vault.sharedCard(cid("c2")).content.body == .note(Note(text: "other")), "never written over")
    #expect(FileManager.default.fileExists(atPath: vault.sharedFolderURL.appending(path: "images/p.png").path))
    for d in dirs {
      let f = try Board(decoding: Data(contentsOf: d.appending(path: Vault.boardFileName)), file: d)
      #expect(f.cards.filter { $0.content == .shared }.map(\.id) == [cid("c1"), cid("c9")])
      #expect(f.sidenotes.isEmpty)
    }
    // pasted again it is already there
    docB.edit("Paste") { $0.paste(pasted, dx: 10, dy: 0, shared: true) }
    #expect(docB.board.cards.count == 2)
  }

  @Test func onTheSameBoardAPasteIsACopyThatReferenceMakesTheSameCard() throws {
    let file = try scratch().appending(path: "board.json")
    try Board(id: BoardID(rawValue: "b"), cards: [noteCard("c1", "one")]).encoded().write(to: file)
    let doc = try BoardDocument(file: { file })
    let clip = doc.board.clip([.card(cid("c1"))]) { _ in nil }
    doc.edit("Paste") { $0.paste(clip, dx: 24, dy: 24) { _ in "c2" } }
    #expect(doc.board.cards.map(\.same) == [nil, nil] && !doc.board.cards[1].isShared)
    // Reference
    doc.edit("Reference") { $0.makeTwin(cid("c2"), of: cid("c1")) { _ in "t1" } }
    #expect(doc.board.cards.map(\.same) == ["t1", "t1"])
    // editing one place edits the other, in one step
    doc.edit("Write") { $0.write(cid("c2"), text: "both", layout: nil) }
    #expect(doc.board.cards.map(text) == ["both", "both"])
    doc.undo()
    #expect(doc.board.cards.map(text) == ["one", "one"])
    doc.flush()
    let f = try Board(decoding: Data(contentsOf: file), file: file)
    #expect(f.cards.map(\.same) == ["t1", "t1"])
    // Copy again: its own card, the other one too as it is alone now
    doc.edit("Copy") { $0.detachTwin(cid("c2")) }
    #expect(doc.board.cards.map(\.same) == [nil, nil])
    doc.edit("Write") { $0.write(cid("c2"), text: "apart", layout: nil) }
    #expect(doc.board.cards.map(text) == ["one", "apart"])
  }

  @Test func makingTwinsMovesWhatIsOnTheCopysSegments() {
    let seg = { (id: String) in
      Segment(id: SegmentID(rawValue: id), source: nil, language: "python", firstLine: 1, lines: ["a", "b"])
    }
    let code = { (s: String) in
      CardContent(body: .code(CodeCard(segments: [seg(s)], hide: HideFlags(), wrap: false, framed: true)))
    }
    var b = Board(
      id: BoardID(rawValue: "b"),
      cards: [
        Card(id: cid("c1"), x: 0, y: 0, width: 200, content: .own(code("s1"))),
        Card(id: cid("c2"), x: 300, y: 0, width: 200, content: .own(code("s2"))),
      ],
      arrows: [
        Arrow(
          id: ArrowID(rawValue: "l"), from: Endpoint(card: cid("c2"), segment: SegmentID(rawValue: "s2"), line: 2),
          to: Endpoint(card: cid("c1")))
      ],
      sidenotes: [
        Sidenote(
          id: SidenoteID(rawValue: "n"), anchor: .card(cid("c2"), segment: SegmentID(rawValue: "s2"), lines: 2...2),
          body: .text(TextNote(text: "why")))
      ],
      stickers: [
        Sticker(
          id: StickerID(rawValue: "k"), glyph: .builtin(.star),
          anchor: .line(cid("c2"), segment: SegmentID(rawValue: "s2"), line: 1))
      ])
    #expect(b.makeTwin(cid("c2"), of: cid("c1")) { _ in "t" })
    #expect(b.cards[1].content == b.cards[0].content)
    // its sidenote on lines moved to the shared segment, with its Highlight, which both places show
    #expect(b.sidenotes[0].anchor == .card(cid("c2"), segment: SegmentID(rawValue: "s1"), lines: 2...2))
    #expect(b.segment(cid("c1"), SegmentID(rawValue: "s1"))?.highlights == [2...2])
    #expect(b.arrows[0].from.segment == SegmentID(rawValue: "s1") && b.arrows[0].from.line == 2)
    #expect(b.stickers.map(\.anchor) == [.line(cid("c2"), segment: SegmentID(rawValue: "s1"), line: 1)])
    // detached: new segment ids, what is on them following
    let map = b.detachTwin(cid("c2")) { _ in "s9" }
    #expect(map == [SegmentID(rawValue: "s1"): SegmentID(rawValue: "s9")])
    #expect(b.arrows[0].from.segment == SegmentID(rawValue: "s9"))
    #expect(b.cards.allSatisfy { $0.same == nil })
  }

  @Test func twinsThatDifferAreRefused() throws {
    let file = try scratch().appending(path: "board.json")
    let b = Board(id: BoardID(rawValue: "b"), cards: [noteCard("c1", "a", same: "t"), noteCard("c2", "b", same: "t")])
    try canonicalJSON(b).write(to: file)
    #expect(throws: VaultError.malformed(file, "card c2: not the same as its twins")) {
      try Board(decoding: Data(contentsOf: file), file: file)
    }
  }
}

import CodeBoardModel
import Foundation
import Testing

/// Imports `boards` (relative path → old board) and `shared` (id → old shared card file) from a fresh storage folder
private func importing(
  _ boards: [String: [String: Any]], shared: [String: [String: Any]] = [:], assets: [String: Data] = [:],
  before: (URL) throws -> Void = { _ in }
) throws -> (vault: Vault, report: ImportReport, source: URL) {
  let root = try scratch()
  let source = root.appending(path: "storage")
  for (path, b) in boards { try put(b, at: source.appending(path: path)) }
  for (id, c) in shared { try put(c, at: source.appending(path: "cards/\(id).json")) }
  for (name, data) in assets {
    try FileManager.default.createDirectory(at: source.appending(path: "assets"), withIntermediateDirectories: true)
    try data.write(to: source.appending(path: "assets/\(name)"))
  }
  try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
  let vault = Vault(root: root.appending(path: "vault"))
  try before(vault.root)
  return (vault, try LegacyImport.run(from: source, to: vault.root), source)
}

private func skipped(_ r: ImportReport, _ source: String) -> [SkipKind: [String]] {
  let entry = r.imported.first { $0.source == source }
  return Dictionary(uniqueKeysWithValues: (entry?.skipped ?? []).map { ($0.kind, $0.ids) })
}

private func onlyCard(_ v: Vault, _ path: String) throws -> CardContent {
  let card = try #require(try v.board(at: path).cards.first)
  guard case .own(let content) = card.content else { throw CancellationError() }
  return content
}

@Test func fixtureStorageImportsToTheExpectedVault() throws {
  let source = try fixtureStorage()
  let before = try files(under: source)
  let dst = try scratch().appending(path: "vault")
  let report = try LegacyImport.run(from: source, to: dst)
  #expect(report.failed.isEmpty)
  let expected = try #require(Bundle.module.url(forResource: "Fixtures", withExtension: nil)).appending(path: "vault")
  let got = try files(under: dst)
  #expect(got.keys.sorted() == (try files(under: expected)).keys.sorted())
  for (path, data) in try files(under: expected) {
    #expect(got[path] == data, "\(path) differs from Fixtures/vault")
  }
  #expect(try files(under: source) == before, "the old storage folder is never changed")
}

@Test func fixtureReportListsWhatWasLeftOut() throws {
  let dst = try scratch().appending(path: "vault")
  let report = try LegacyImport.run(from: try fixtureStorage(), to: dst)
  #expect(report.imported.map(\.source) == ["bflow1.json", "cards/cshared.json", "engine/bsched.json"])
  #expect(
    skipped(report, "bflow1.json") == [
      .variants: ["cfree"], .messageNote: ["cmsg"], .processes: ["cstep"], .callMark: ["lcall"],
      .missingImage: ["ffffffffffffffff-1x1.png"],
      .field: [
        "bflow1.born", "bflow1.hideNumbers", "bflow1.seq", "sstep.keep", "cgh.collapsed",
      ],
    ])
  // the sidenote that travels with the shared card is in its library file
  #expect(skipped(report, "cards/cshared.json").isEmpty)
  #expect(try Vault(root: dst).sharedCard(CardID(rawValue: "cshared")).sidenotes.map(\.id.rawValue) == ["n9"])
  #expect(report.imported.first { $0.source == "cards/cshared.json" }?.destination == ".codeboard/shared/cshared.json")
}

@Test func fixtureVaultReadsBack() throws {
  let dst = try scratch().appending(path: "vault")
  _ = try LegacyImport.run(from: try fixtureStorage(), to: dst)
  let vault = Vault(root: dst)
  let tree = try vault.tree()
  #expect(tree.boards.map(\.title) == ["Engine step"])
  #expect(tree.folders.map(\.name) == ["engine"])
  #expect(
    tree.folders[0].boards == [
      VaultBoard(
        id: BoardID(rawValue: "bsched"), title: "Scheduler- prefill-decode",
        path: "engine/Scheduler- prefill-decode.board")
    ])
  let board = try vault.board(at: "Engine step.board")
  #expect(board.cards.count == 13)
  let shared = try vault.sharedCard(CardID(rawValue: "cshared"))
  #expect(shared.content.body == .note(Note(text: "Shared: ![](images/5f1a2b3c4d5e6f70-1x1.png)")))
  // tilt was the shared card's; in a vault it is the placement's, on every board
  #expect(try vault.board(at: "engine/Scheduler- prefill-decode.board").cards[0].tilted)
}

@Test func codeCardSourcesMapToGitPackageAndFile() throws {
  let board = try Vault(root: try fixtureVaultCopy()).board(at: "Engine step.board")
  let segments = board.cards.compactMap { c -> [Segment]? in
    guard case .own(let content) = c.content, case .code(let code) = content.body else { return nil }
    return code.segments
  }.flatMap { $0 }
  #expect(
    segments.map(\.source) == [
      .git(
        repository: nil, commit: "bb823b3e06983d71485a8e1f23715ebd87d98ef8", path: "nanovllm/engine/llm_engine.py",
        uncommitted: false, checkout: ""),
      .git(
        repository: "https://github.com/GeeeekExplorer/nano-vllm", commit: "0123456789abcdef0123456789abcdef01234567",
        path: "nanovllm/engine/scheduler.py", uncommitted: false, checkout: nil),
      .package(name: "torch", version: "2.9.0", path: "torch/nn/functional.py"),
      .file(path: "third_party/kernels/notes.txt", hash: "4f2a"),
      nil,
    ])
  let step = segments[0]
  #expect(step.firstLine == 49 && step.lastLine == 52)
  #expect(step.highlights == [50...51] && step.hidden == [52...52])
  #expect(step.symbol == Symbol(name: "LLMEngine.step", kind: .function))
  #expect(step.annotations[1] == Annotation(line: 51, from: 0, to: 4, text: "rpc", color: .blue, below: true))
}

private func fixtureVaultCopy() throws -> URL {
  let dst = try scratch().appending(path: "vault")
  _ = try LegacyImport.run(from: try fixtureStorage(), to: dst)
  return dst
}

@Test func oldLooksBecomeNotesTextsAndBoxes() throws {
  // a version 15 board: the upgrade turns its Text, Mark and Free Text into Texts at the sizes they had
  let looks: [[String: Any]] = [
    oldNote("n", "# Hi"),
    oldNote("t", look: "text"),
    ["id": "t2", "kind": "note", "look": "text", "md": "x", "size": "heading", "bold": true],
    oldNote("b", look: "box"),
    ["id": "m", "kind": "note", "look": "mark", "md": "x", "hand": "purple", "weight": "light", "fs": 32],
    oldNote("m2", look: "mark"),
    oldNote("f", look: "freetext"),
    ["id": "f3", "kind": "note", "look": "freetext", "md": "x", "level": 3, "bold": true, "fs": 50],
  ]
  var places: [String: Any] = [:]
  for (i, c) in looks.enumerated() { places[c["id"] as! String] = ["x": i, "y": 0, "w": 100, "h": 40] }
  let (vault, report, _) = try importing([
    "b.json": oldBoard("b", cards: looks, place: places, extra: ["version": 15])
  ])
  #expect(report.failed.isEmpty)
  let board = try vault.board(at: "Board.board")
  let bodies = board.cards.map { c -> CardContent.Body? in
    if case .own(let content) = c.content { content.body } else { nil }
  }
  #expect(
    bodies == [
      .note(Note(text: "# Hi")), .text(TextCard(text: "text", fontSize: 13.5, wrap: true)),
      .text(TextCard(text: "## x", fontSize: 12, wrap: true)),
      .text(TextCard(text: "text", look: .box, fontSize: 13.5, wrap: true)),
      .text(TextCard(text: "x", fontSize: 32, wrap: true)), .text(TextCard(text: "text", fontSize: 18, wrap: true)),
      .text(TextCard(text: "text")), .text(TextCard(text: "## **x**", fontSize: 37)),
    ])
  // a Box's height (the least it was) goes in the upgrade; the others keep theirs, as main's board draws them
  // (migrate.ts textAndBox, cards/Card.tsx)
  #expect(board.cards.map(\.height) == [40, 40, 40, nil, 40, 40, 40, 40])
  #expect(skipped(report, "b.json").isEmpty)
}

/// Main keeps the height a version 17 file gives a Text or a Box (an old Mark's, an old Free Text's, a Text turned into a
/// Box since) and draws it; a library Text from a board file before 16 loses it once its content is read in
/// (migrate.ts sharedTextHeights), one from 16 on keeps it
@Test func aTextOrBoxKeepsTheHeightItsFileGivesIt() throws {
  let cards: [[String: Any]] = [
    ["id": "t", "kind": "note", "look": "text", "md": "a", "fs": 24],
    ["id": "b", "kind": "note", "look": "box", "md": "b"],
    ["id": "s", "kind": "shared"],
  ]
  let place: [String: Any] = [
    "t": ["x": 0, "y": 0, "w": 100, "h": 80], "b": ["x": 200, "y": 0, "w": 100, "h": 120],
    "s": ["x": 400, "y": 0, "w": 100, "h": 60],
  ]
  let shared: [String: Any] = [
    "version": 17, "card": ["id": "s", "kind": "note", "look": "text", "md": "s"], "sidenotes": [Any](),
  ]
  // before 16 a Box's height (the least it was) goes in the upgrade too (migrate.ts textAndBox)
  for (version, heights) in [(17, [80, 120, 60] as [Double?]), (15, [80, nil, nil])] {
    let (vault, report, _) = try importing(
      ["b.json": oldBoard("b", cards: cards, place: place, extra: ["version": version])], shared: ["s": shared])
    #expect(report.failed.isEmpty)
    let board = try vault.board(at: "Board.board")
    #expect(board.cards.map(\.height) == heights, "version \(version)")
    #expect(skipped(report, "b.json").isEmpty)
  }
}

@Test func textAndBoxKeepTheirLookAtVersion17() throws {
  let cards: [[String: Any]] = [
    ["id": "t", "kind": "note", "look": "text", "md": "a", "fill": "pink", "fs": 24, "wrap": true],
    ["id": "b", "kind": "note", "look": "box", "md": "b", "fill": "green"],
    ["id": "n", "kind": "note", "look": "note", "md": "c", "fill": "blue", "fs": 30],
  ]
  let (vault, report, _) = try importing(["b.json": oldBoard("b", cards: cards)])
  #expect(report.failed.isEmpty)
  let bodies = try vault.board(at: "Board.board").cards.map { c -> CardContent.Body? in
    if case .own(let content) = c.content { content.body } else { nil }
  }
  #expect(
    bodies == [
      .text(TextCard(text: "a", fill: .pink, fontSize: 24, wrap: true)),
      .text(TextCard(text: "b", look: .box, fill: .green)), .note(Note(text: "c")),
    ])
  #expect(skipped(report, "b.json") == [.field: ["n.fill", "n.fs"]])
}

@Test func imagesAreCopiedPerBoardAndReferencesRewritten() throws {
  let png = Data([0x89, 0x50, 0x4e, 0x47])
  let (vault, report, _) = try importing(
    [
      "a.json": oldBoard(
        "a", name: "A",
        cards: [
          ["id": "i", "kind": "image", "src": "pic.png"],
          oldNote("n", "![x](assets/note.png) and ![y](<assets/note.png>) and https://h/assets/no.png"),
          ["id": "d", "kind": "image", "src": "data:image/png;base64,\(png.base64EncodedString())"],
          ["id": "u", "kind": "image", "src": "https://example.com/p.png"],
        ]),
      "b.json": oldBoard("b", name: "B", cards: [["id": "i", "kind": "image", "src": "pic.png"]]),
    ], assets: ["pic.png": Data("pic".utf8), "note.png": Data("note".utf8)])
  #expect(report.failed.isEmpty)
  let a = vault.url(of: "A.board/images")
  #expect(try Data(contentsOf: a.appending(path: "pic.png")) == Data("pic".utf8))
  #expect(try Data(contentsOf: a.appending(path: "note.png")) == Data("note".utf8))
  #expect(
    try Data(contentsOf: vault.url(of: "B.board/images/pic.png")) == Data("pic".utf8), "each board has its own copy")
  #expect(!FileManager.default.fileExists(atPath: vault.url(of: "B.board/images/note.png").path))
  let cards = try vault.board(at: "A.board").cards.map { c -> CardContent.Body? in
    if case .own(let content) = c.content { content.body } else { nil }
  }
  #expect(cards[0] == .image(ImageCard(source: .file("pic.png"))))
  #expect(
    cards[1] == .note(Note(text: "![x](images/note.png) and ![y](<images/note.png>) and https://h/assets/no.png")))
  guard case .image(let data)? = cards[2], case .file(let name) = data.source else {
    Issue.record("a data: URL image becomes a file")
    return
  }
  #expect(name.hasSuffix(".png") && name.count == 20)
  #expect(try Data(contentsOf: a.appending(path: name)) == png)
  #expect(cards[3] == .image(ImageCard(source: .url("https://example.com/p.png"))))
}

@Test func onlyImageAndLinkAddressesAreRewritten() throws {
  let md = [
    "![a](assets/one.png) [link](assets/two.png \"t\") ![b]( <assets/one.png> ){width=50%}",
    "[ref]: assets/three.png",
    "the folder assets/one.png and `![c](assets/four.png)` stay, as does ``x](assets/four.png``",
    "```md",
    "![d](assets/four.png)",
    "[r]: assets/four.png",
    "```",
    "<img src=\"assets/four.png\">",
  ].joined(separator: "\n")
  let files = ["one.png", "two.png", "three.png", "four.png"]
  let (vault, report, _) = try importing(
    ["a.json": oldBoard("a", name: "A", cards: [oldNote("n", md)])],
    assets: Dictionary(uniqueKeysWithValues: files.map { ($0, Data($0.utf8)) }))
  #expect(report.failed.isEmpty)
  let want = [
    "![a](images/one.png) [link](images/two.png \"t\") ![b]( <images/one.png> ){width=50%}",
    "[ref]: images/three.png",
    "the folder assets/one.png and `![c](assets/four.png)` stay, as does ``x](assets/four.png``",
    "```md",
    "![d](assets/four.png)",
    "[r]: assets/four.png",
    "```",
    "<img src=\"assets/four.png\">",
  ].joined(separator: "\n")
  #expect(try vault.board(at: "A.board").cards[0].content == .own(CardContent(body: .note(Note(text: want)))))
  let copied = try FileManager.default.contentsOfDirectory(atPath: vault.url(of: "A.board/images").path).sorted()
  #expect(copied == ["one.png", "three.png", "two.png"], "only what the Markdown shows or links to")
}

@Test func sharedCardsGoToTheAppDataFolderAndBoardsReferToThem() throws {
  let shared: [String: Any] = [
    "version": 17, "card": oldNote("s1", "shared ![](assets/s.png)"),
    "sidenotes": [
      ["id": "n1", "kind": "text", "at": ["card": "s1"], "md": "travels ![](assets/s.png)"],
      ["id": "n2", "kind": "text", "at": ["card": "elsewhere"], "md": "not this card's"],
    ],
  ]
  let ref: [String: Any] = ["id": "s1", "kind": "shared"]
  let (vault, report, _) = try importing(
    [
      "a.json": oldBoard(
        "a", name: "A", cards: [ref, ["id": "gone", "kind": "shared"], oldNote("n")],
        links: [
          ["id": "l1", "from": ["card": "n"], "to": ["card": "s1"]],
          ["id": "l2", "from": ["card": "n"], "to": ["card": "gone"]],
        ]),
      "b.json": oldBoard("b", name: "B", cards: [ref]),
    ], shared: ["s1": shared], assets: ["s.png": Data("s".utf8)])
  #expect(report.failed.isEmpty)
  let a = try vault.board(at: "A.board")
  #expect(a.cards.map(\.content) == [.shared, .own(CardContent(body: .note(Note(text: "text"))))])
  #expect(a.arrows.map(\.id.rawValue) == ["l1"])
  #expect(skipped(report, "a.json") == [.missingSharedCard: ["gone"], .arrowWithoutEnd: ["l2"]])
  #expect(try vault.board(at: "B.board").cards.map(\.content) == [.shared])
  let s1 = try vault.sharedCard(CardID(rawValue: "s1"))
  #expect(s1.content.body == .note(Note(text: "shared ![](images/s.png)")))
  #expect(s1.sidenotes.map(\.body) == [.text(TextNote(text: "travels ![](images/s.png)"))])
  #expect(skipped(report, "cards/s1.json") == [.sidenoteWithoutAnchor: ["n2"]])
  #expect(FileManager.default.fileExists(atPath: vault.sharedFolderURL.appending(path: "images/s.png").path))
}

@Test func outOfScopeKindsAreReportedNotDropped() throws {
  let code: [String: Any] = [
    "id": "c", "kind": "code", "same": "g1", "members": ["shown": []], "gen": ["what": "CUDA source"],
    "mergedFrom": [], "keepOld": true,
    "segments": [
      [
        "id": "s", "src": ["kind": "free"], "path": "", "lang": "c", "start": 1, "end": 1, "text": ["x"],
        "version": ["kind": "none"],
      ]
    ],
  ]
  let board = oldBoard(
    "b",
    cards: [
      code.merging(["procs": [["text": "rank 0"]]]) { $1 },
      ["id": "cmp", "kind": "compare", "cols": ["x1", "x2"]], oldNote("x1"), oldNote("x2"), oldNote("nowhere"),
    ],
    place: ["c": ["x": 0, "y": 0, "w": 1, "collapsed": true], "cmp": ["x": 0, "y": 0, "w": 1]],
    links: [
      [
        "id": "l", "from": ["card": "c"], "to": ["card": "c"], "call": ["name": "f", "col": 0],
        "rpc": ["mech": "zmq"],
      ],
      ["id": "l2", "from": ["card": "c"], "to": ["card": "x1"]],
    ],
    extra: ["mystery": 1, "born": ["c": 0], "seq": 1, "hideNumbers": true])
  let (_, report, _) = try importing(["b.json": board])
  #expect(report.failed.isEmpty)
  #expect(
    skipped(report, "b.json") == [
      .compareCard: ["cmp", "x1", "x2"], .unplacedCard: ["nowhere"], .mergedFrom: ["c"], .generated: ["c"],
      .classMembers: ["c"], .processes: ["c"], .callMark: ["l"], .arrowWithoutEnd: ["l2"],
      .field: ["b.born", "b.hideNumbers", "b.mystery", "b.seq", "c.keepOld", "c.collapsed"],
    ])
}

@Test func arrowsAndSectionsKeepTheirReferences() throws {
  let code: [String: Any] = [
    "id": "c", "kind": "code",
    "segments": [
      [
        "id": "s", "src": ["kind": "free"], "path": "", "lang": "c", "start": 5, "end": 5, "text": ["x"],
        "version": ["kind": "none"],
      ]
    ],
  ]
  let (vault, report, _) = try importing([
    "b.json": oldBoard(
      "b", cards: [code, oldNote("n")],
      place: [
        "c": ["x": 1, "y": 2, "w": 3, "section": "inner"], "n": ["x": 0, "y": 0, "w": 1, "section": "nowhere"],
      ],
      links: [
        ["id": "ok", "from": ["card": "c", "seg": "s", "line": 5], "to": ["card": "n"]],
        ["id": "badseg", "from": ["card": "c", "seg": "zz"], "to": ["card": "n"]],
        ["id": "nocard", "from": ["card": "c"], "to": ["card": "zz"]],
      ],
      sections: [
        ["id": "outer", "title": "O", "x": 0, "y": 0, "w": 10, "h": 10],
        ["id": "inner", "title": "I", "x": 0, "y": 0, "w": 5, "h": 5, "parent": "outer"],
        ["id": "lost", "title": "L", "x": 0, "y": 0, "w": 5, "h": 5, "parent": "deleted"],
      ])
  ])
  #expect(report.failed.isEmpty)
  let b = try vault.board(at: "Board.board")
  #expect(b.arrows.map(\.id.rawValue) == ["ok"])
  #expect(b.arrows[0].from == Endpoint(card: CardID(rawValue: "c"), segment: SegmentID(rawValue: "s"), line: 5))
  #expect(b.cards.map(\.section) == [SectionID(rawValue: "inner"), nil])
  #expect(b.sections.map(\.parent) == [nil, SectionID(rawValue: "outer"), nil])
  #expect(
    skipped(report, "b.json") == [
      .arrowWithoutEnd: ["badseg", "nocard"], .danglingReference: ["lost.parent", "n.section"],
    ])
}

@Test func titlesCollideCaseInsensitivelyAndIllegalCharactersAreReplaced() throws {
  let (vault, report, _) = try importing([
    "1.json": oldBoard("b1", name: "a/b"),
    "2.json": oldBoard("b2", name: "A:B"),
    "3.json": oldBoard("b3", name: ".hidden"),
    "4.json": oldBoard("b4", name: "  "),
    "5.json": oldBoard("b5", name: "x.board"),
    "g/6.json": oldBoard("b6", name: "a/b"),
  ])
  #expect(report.failed.isEmpty)
  #expect(
    report.imported.map(\.destination) == [
      "a-b.board", "A-B 2.board", "hidden.board", "Untitled.board", "x.board.board", "g/a-b.board",
    ])
  #expect(try vault.tree().allBoards.map(\.title).sorted() == ["A-B 2", "Untitled", "a-b", "a-b", "hidden", "x.board"])
}

@Test func packageNamesAreSafeFileNames() {
  #expect(Vault.packageName(for: "Scheduler: prefill/decode") == "Scheduler- prefill-decode")
  #expect(Vault.packageName(for: "a\\b*c?d\"e<f>g|h") == "a-b-c-d-e-f-g-h")
  #expect(Vault.packageName(for: "tab\there\nnewline") == "tabherenewline")
  #expect(Vault.packageName(for: "...dots...") == "dots")
  #expect(Vault.packageName(for: "") == "Untitled")
  #expect(Vault.packageName(for: "调度器 prefill") == "调度器 prefill")
  #expect(Vault.packageName(for: "e\u{301}") == "\u{e9}", "names are stored precomposed")
  let long = Vault.packageName(for: String(repeating: "长", count: 300))
  #expect(long.utf8.count <= 200 && long.allSatisfy { $0 == "长" })
}

/// The first import's files, as the user may have changed them since, byte for byte
private func unchanged(_ before: [String: Data], _ after: [String: Data]) -> [String] {
  before.keys.sorted().filter { after[$0] != before[$0] }
}

@Test func importingTwiceLeavesTheFirstImportAloneAndMakesCopies() throws {
  let source = try fixtureStorage()
  let dst = try scratch().appending(path: "vault")
  _ = try LegacyImport.run(from: source, to: dst)
  let first = try files(under: dst)
  let second = try LegacyImport.run(from: source, to: dst)
  #expect(second.failed.isEmpty)
  #expect(unchanged(first, try files(under: dst)).isEmpty)
  // the boards came in as copies beside where they were; the shared card, the same as the vault's, is used as it is
  #expect(
    second.imported.map { [$0.source, $0.destination ?? "-", $0.copyOf ?? "-"] } == [
      ["bflow1.json", "Engine step copy.board", "Engine step.board"],
      ["cards/cshared.json", ".codeboard/shared/cshared.json", "-"],
      [
        "engine/bsched.json", "engine/Scheduler- prefill-decode copy.board",
        "engine/Scheduler- prefill-decode.board",
      ],
    ])
  let vault = Vault(root: dst)
  let original = try vault.board(at: "Engine step.board")
  let copy = try vault.board(at: "Engine step copy.board")
  #expect(copy.id.rawValue == "bflow1-copy")
  var same = copy
  same.id = original.id
  #expect(same == original, "a copy of the same old board is the same board under another id")
  // a third import: copy 2, with its own id
  let third = try LegacyImport.run(from: source, to: dst)
  #expect(third.imported.first?.destination == "Engine step copy 2.board")
  #expect(try vault.board(at: "Engine step copy 2.board").id.rawValue == "bflow1-copy-2")
  #expect(try vault.tree().allBoards.count == 6)
}

@Test func importingAgainAfterTheUserChangedTheVaultChangesNothingOfIt() throws {
  let source = try fixtureStorage()
  let dst = try scratch().appending(path: "vault")
  _ = try LegacyImport.run(from: source, to: dst)
  let fm = FileManager.default
  // the user moves and renames a board, edits it and the shared card, and deletes an image
  try fm.createDirectory(at: dst.appending(path: "Mine/Deep"), withIntermediateDirectories: true)
  try fm.moveItem(at: dst.appending(path: "Engine step.board"), to: dst.appending(path: "Mine/Deep/Renamed.board"))
  let vault = Vault(root: dst)
  var edited = try vault.board(at: "Mine/Deep/Renamed.board")
  edited.hideComments.toggle()
  try edited.encoded().write(to: dst.appending(path: "Mine/Deep/Renamed.board/board.json"))
  var card = try vault.sharedCard(CardID(rawValue: "cshared"))
  card.content.title = "Changed here"
  try card.encoded().write(to: vault.sharedFolderURL.appending(path: "cshared.json"))
  try fm.removeItem(at: dst.appending(path: "Mine/Deep/Renamed.board/images/0a1b2c3d4e5f6071-1x1.png"))
  let before = try files(under: dst)

  let report = try LegacyImport.run(from: source, to: dst)
  #expect(report.failed.isEmpty)
  #expect(unchanged(before, try files(under: dst)).isEmpty)
  #expect(!fm.fileExists(atPath: dst.appending(path: "Mine/Deep/Renamed.board/images/0a1b2c3d4e5f6071-1x1.png").path))
  #expect(
    report.imported.map { [$0.source, $0.destination ?? "-", $0.copyOf ?? "-"] } == [
      ["bflow1.json", "Engine step copy.board", "Mine/Deep/Renamed.board"],
      ["cards/cshared.json", ".codeboard/shared/cshared-copy.json", ".codeboard/shared/cshared.json"],
      [
        "engine/bsched.json", "engine/Scheduler- prefill-decode copy.board",
        "engine/Scheduler- prefill-decode.board",
      ],
    ])
  // the shared card the user changed stays theirs; the copies show the incoming one, under its new id
  let copied = try vault.sharedCard(CardID(rawValue: "cshared-copy"))
  #expect(copied.content.title == nil && copied.sidenotes.map(\.anchor.card) == [CardID(rawValue: "cshared-copy")])
  for path in ["Engine step copy.board", "engine/Scheduler- prefill-decode copy.board"] {
    let b = try vault.board(at: path)
    #expect(b.cards.contains { $0.id.rawValue == "cshared-copy" && $0.content == .shared })
    #expect(!b.cards.contains { $0.id.rawValue == "cshared" })
  }
  #expect(try vault.board(at: "engine/Scheduler- prefill-decode.board").cards.contains { $0.id.rawValue == "cshared" })
}

@Test func whatCameInTogetherRefersToTheCopies() throws {
  let sub = oldBoard("bsub", name: "Inner")
  let outer = oldBoard(
    "bout", name: "Outer",
    cards: [
      ["id": "s", "kind": "board", "board": "bsub"],
      oldNote("n").merging(["md": "see [[Inner#^bsub]] and [[Card#^bsub/x]] and [[Shared#^lib]]"]) { $1 },
      ["id": "lib", "kind": "shared"],
    ])
  let lib = ["version": 17, "card": oldNote("lib").merging(["md": "mine is [[Shared#^lib]]"]) { $1 }] as [String: Any]
  let (vault, _, source) = try importing(["a.json": sub, "b.json": outer], shared: ["lib": lib])
  var card = try vault.sharedCard(CardID(rawValue: "lib"))
  card.content.title = "Edited"
  try card.encoded().write(to: vault.sharedFolderURL.appending(path: "lib.json"))
  let report = try LegacyImport.run(from: source, to: vault.root)
  #expect(report.failed.isEmpty)
  // the board Outer shows is in Outer's folder, Outer its folder board; the copies the same, side by side
  let copy = try vault.board(at: "Outer copy/.folder.board")
  #expect(
    copy.cards[0].content
      == .own(CardContent(body: .board(SubBoard(board: BoardID(rawValue: "bsub-copy"), auto: true)))))
  #expect(try vault.board(at: "Outer copy/Inner copy.board").id.rawValue == "bsub-copy")
  let refs = "see [[Inner#^bsub-copy]] and [[Card#^bsub-copy/x]] and [[Shared#^lib-copy]]"
  #expect(copy.cards[1].content == .own(CardContent(body: .note(Note(text: refs)))))
  let lib2 = try vault.sharedCard(CardID(rawValue: "lib-copy"))
  #expect(lib2.content.body == .note(Note(text: "mine is [[Shared#^lib-copy]]")))
  // the originals refer to the originals
  let first = try vault.board(at: "Outer/.folder.board")
  #expect(
    first.cards[0].content == .own(CardContent(body: .board(SubBoard(board: BoardID(rawValue: "bsub"), auto: true)))))
}

@Test func otherVersionsAndMalformedFilesFailOneByOne() throws {
  let (vault, report, source) = try importing([
    "good.json": oldBoard("good"),
    "v12.json": ["version": 12, "name": "Old", "cards": []],
    "v1.json": ["name": "Oldest", "cards": []],
    "v18.json": ["version": 18, "name": "Newer"],
    "nocards.json": ["version": 16, "name": "Empty"],
    "broken.json": oldBoard("br", cards: [oldNote("n").merging(["md": 5]) { $1 }]),
    "badlines.json": oldBoard(
      "bl",
      cards: [
        [
          "id": "c", "kind": "code",
          "segments": [
            [
              "id": "s", "src": ["kind": "free"], "path": "", "lang": "c", "start": 1, "end": 3, "text": ["x"],
              "version": ["kind": "none"],
            ]
          ],
        ]
      ]),
  ])
  try Data("{ not json".utf8).write(to: source.appending(path: "garbage.json"))
  let again = try LegacyImport.run(from: source, to: vault.root)
  #expect(report.imported.map(\.source) == ["good.json"])
  let file = { (name: String) in source.appending(path: name) }
  #expect(
    again.failed == [
      .malformed(file("badlines.json"), "cards[0].segments[0]: lines 1–3 but 1 lines of text"),
      .malformed(file("broken.json"), "cards[0].md: expected a string"),
      .malformed(file("garbage.json"), "not JSON"),
      .malformed(file("nocards.json"), "cards: missing"),
      .oldVersion(file("v1.json"), 1),
      .oldVersion(file("v12.json"), 12),
      .newerVersion(file("v18.json"), 18),
    ])
  #expect(LegacyImportError.oldVersion(file("v12.json"), 12).description.contains("VS Code extension"))
}

@Test func duplicateBoardIDsImportTheFirstOnly() throws {
  let (_, report, source) = try importing([
    "a.json": oldBoard("same", name: "A"), "g/b.json": oldBoard("same", name: "B"),
  ])
  #expect(report.imported.map(\.destination) == ["A.board"])
  #expect(
    report.failed == [
      .duplicateBoardID(
        source.appending(path: "g/b.json"), BoardID(rawValue: "same"), other: source.appending(path: "a.json"))
    ])
}

/// A group folder named like a package would be taken for one: a board's or a resource's
@Test func aGroupNamedLikeAPackageGetsADash() throws {
  let (vault, report, _) = try importing([
    "Papers.board/1.json": oldBoard("b1", name: "One"), "Papers.resource/2.json": oldBoard("b2", name: "Two"),
  ])
  #expect(report.failed.isEmpty)
  #expect(report.imported.map(\.destination) == ["Papers.board-/One.board", "Papers.resource-/Two.board"])
  #expect(try vault.tree().folders.map(\.name) == ["Papers.board-", "Papers.resource-"])
}

@Test func boardIDFallsBackToTheFileName() throws {
  var b = oldBoard("x")
  b["id"] = nil
  let (vault, _, _) = try importing(["fromname.json": b])
  #expect(try vault.tree().boards.map(\.id) == [BoardID(rawValue: "fromname")])
}

@Test func trashAndOwnFoldersAreNotBoards() throws {
  let (_, report, _) = try importing([
    "a.json": oldBoard("a"), ".trash/a.1700000000000.json": oldBoard("t"), "runs/r.json": ["x": 1],
    "github/g.json": ["x": 1], "assets/a.json": ["x": 1],
  ])
  #expect(report.imported.map(\.source) == ["a.json"])
  #expect(report.failed.isEmpty)
}

@Test func theVaultIsAFolderOfItsOwn() throws {
  let root = try scratch()
  let storage = root.appending(path: "repo/.codeboard")
  try put(oldBoard("a"), at: storage.appending(path: "a.json"))
  #expect(throws: LegacyImportError.destinationInsideSource(storage)) {
    try LegacyImport.run(from: storage, to: storage)
  }
  let inside = storage.appending(path: "vault")
  #expect(throws: LegacyImportError.destinationInsideSource(inside)) {
    try LegacyImport.run(from: storage, to: inside)
  }
  #expect(throws: LegacyImportError.sourceInsideAppData(storage)) {
    try LegacyImport.run(from: storage, to: root.appending(path: "repo"))
  }
  #expect(throws: LegacyImportError.notAStorageFolder(root.appending(path: "none"))) {
    try LegacyImport.run(from: root.appending(path: "none"), to: root.appending(path: "vault"))
  }
  #expect(!FileManager.default.fileExists(atPath: inside.path), "nothing is made in the old folder")
  #expect(try LegacyImport.run(from: storage, to: root.appending(path: "vault")).failed.isEmpty)
}

/// Free code has no source; where it was pasted from and a language picked by hand come along (main's free source
/// `url`, `langPicked`)
@Test func freeCodeKeepsWhereItCameFromAndItsPickedLanguage() throws {
  let code: [String: Any] = [
    "id": "c", "kind": "code",
    "segments": [
      [
        "id": "s", "src": ["kind": "free", "url": "https://gist.github.com/x", "langPicked": true], "path": "",
        "lang": "python", "start": 1, "end": 1, "text": ["pass"], "version": ["kind": "none"],
      ],
      [
        "id": "t", "src": ["kind": "free"], "path": "", "lang": "cpp", "start": 1, "end": 1, "text": ["int x;"],
        "version": ["kind": "none"],
      ],
    ],
  ]
  let (vault, report, _) = try importing(["b.json": oldBoard("b", cards: [code])])
  let content = try onlyCard(vault, "Board.board")
  var s = Segment(id: SegmentID(rawValue: "s"), source: nil, language: "python", firstLine: 1, lines: ["pass"])
  s.url = "https://gist.github.com/x"
  s.languagePicked = true
  let t = Segment(id: SegmentID(rawValue: "t"), source: nil, language: "cpp", firstLine: 1, lines: ["int x;"])
  #expect(content.body == .code(CodeCard(segments: [s, t])))
  #expect(skipped(report, "b.json").isEmpty)
}

@Test func sidenotesStickersShelfAndTheOtherKindsAreImported() throws {
  let code: [String: Any] = [
    "id": "c", "kind": "code", "active": "up",
    "segments": [
      [
        "id": "s", "src": ["kind": "free"], "path": "", "lang": "c", "start": 5, "end": 7, "text": ["a", "b", "c"],
        "version": ["kind": "none"], "hl": [[6, 6]],
      ]
    ],
  ]
  let summary: [String: Any] = [
    "text": "**key** words", "at": 1, "sig": "x", "edited": true, "pairs": [["ai": "a", "user": "u", "at": 2]],
  ]
  let meta: [String: Any] = ["title": "Page", "image": "og.png", "icon": "https://e/favicon.ico", "at": 3]
  let board = oldBoard(
    "b",
    cards: [
      code, oldNote("n"),
      ["id": "w", "kind": "web", "url": "https://e/p", "meta": meta, "style": "side"],
      [
        "id": "ll", "kind": "links", "rich": true,
        "items": [["id": "i1", "url": "https://a", "title": "A", "rich": false], ["id": "i2", "url": "https://b"]],
      ],
      ["id": "sb", "kind": "board", "board": "other", "pcols": 2],
      oldNote("put", "on the shelf"),
    ],
    place: [
      "c": ["x": 0, "y": 0, "w": 300, "summary": summary], "n": ["x": 0, "y": 0, "w": 1, "mh": 80],
      "w": ["x": 0, "y": 0, "w": 1], "ll": ["x": 0, "y": 0, "w": 1], "sb": ["x": 0, "y": 0, "w": 1, "h": 200],
    ],
    links: [["id": "l", "from": ["card": "c"], "to": ["card": "n"]]],
    sections: [["id": "sec", "title": "S", "x": 0, "y": 0, "w": 10, "h": 10, "directSummary": summary]],
    extra: [
      "sidenotes": [
        [
          "id": "n1", "kind": "text", "at": ["card": "c", "seg": "s", "lines": [6, 6]], "md": "the text",
          "why": "the reason", "review": "widened", "alwaysShow": true,
        ],
        [
          "id": "n2", "kind": "text", "at": ["section": "sec"], "md": "a question ![](assets/q.png)",
          "q": ["at": 9, "done": true, "answers": [["id": "a1", "md": "[[N#^n]]", "at": 10]]],
        ],
        ["id": "n3", "kind": "text", "at": ["x": 4, "y": 5], "md": "", "why": "only a reason"],
        [
          "id": "n4", "kind": "code", "at": ["card": "n"], "why": "where it is called",
          "code": [
            "id": "cs", "src": ["kind": "free"], "path": "", "lang": "py", "start": 1, "end": 1, "text": ["x"],
            "version": ["kind": "none"],
          ],
        ],
        ["id": "n5", "kind": "text", "at": ["card": "c", "seg": "s", "lines": [5, 5]], "md": "v", "variant": "mine"],
        ["id": "n6", "kind": "text", "at": ["card": "gone"], "md": "orphan"],
        ["id": "n7", "kind": "text", "at": ["card": "put"], "md": "on a shelved card", "boardOnly": true],
      ],
      "stickers": [
        ["id": "k1", "icon": ["pack": "builtin", "name": "todo-text"], "at": ["kind": "canvas", "x": 1, "y": 2]],
        [
          "id": "k2", "icon": ["pack": "emoji", "name": "🔥"], "color": "#E3A132",
          "at": ["kind": "canvas", "x": 1, "y": 2, "size": 22, "on": ["card": "n"]],
        ],
        [
          "id": "k3", "icon": ["pack": "builtin", "name": "star"],
          "at": ["kind": "line", "card": "c", "seg": "s", "line": 6],
        ],
        ["id": "k4", "icon": ["pack": "mypack", "name": "cat"], "at": ["kind": "canvas", "x": 1, "y": 2]],
        [
          "id": "k5", "icon": ["pack": "builtin", "name": "zap"],
          "at": ["kind": "canvas", "x": 1, "y": 2, "on": ["link": "l", "t": 1.5]],
        ],
        [
          "id": "k6", "icon": ["pack": "builtin", "name": "bug"],
          "at": ["kind": "line", "card": "c", "seg": "zz", "line": 6],
        ],
        // on an arrow of the shelf, not the board's
        [
          "id": "k8", "icon": ["pack": "builtin", "name": "flag"],
          "at": ["kind": "canvas", "x": 0, "y": 0, "on": ["link": "l9", "t": 0.5]],
        ],
      ],
      "shelf": [
        [
          "id": "e1", "at": 100, "place": ["put": ["x": 7, "y": 8, "w": 90, "mh": 44, "section": "inner"]],
          "sections": [["id": "inner", "title": "I", "x": 0, "y": 0, "w": 9, "h": 9, "parent": "sec"]],
          "links": [["id": "l9", "from": ["card": "put"], "to": ["card": "n"]]],
          "stickers": [
            [
              "id": "k7", "icon": ["pack": "builtin", "name": "heart"],
              "at": ["kind": "canvas", "x": 1, "y": 1, "on": ["card": "put"]],
            ],
            [
              "id": "k9", "icon": ["pack": "builtin", "name": "check"],
              "at": ["kind": "canvas", "x": -16, "y": -40, "size": 24, "on": ["link": "l9", "t": 0.42]],
            ],
          ],
        ]
      ],
      "seal": ["text": "引用", "color": "teal"],
    ])
  let (vault, report, _) = try importing(
    ["b.json": board], assets: ["og.png": Data("og".utf8), "q.png": Data("q".utf8)])
  #expect(report.failed.isEmpty)
  let b = try vault.board(at: "Board.board")
  let c = CardID(rawValue: "c")
  #expect(b.cards.map(\.id.rawValue) == ["c", "n", "w", "ll", "sb"])
  #expect(b.cards[0].summary?.pairs == [Summary.Pair(ai: "a", user: "u", at: 2)])
  #expect(b.cards[1].measuredHeight == nil, "a measured height on the canvas is not kept")
  #expect(b.sections[0].directSummary?.text == "**key** words")
  let body = { (i: Int) -> CardContent.Body? in
    if case .own(let content) = b.cards[i].content { content.body } else { nil }
  }
  #expect(
    body(2)
      == .web(
        WebCard(
          url: "https://e/p",
          meta: WebMeta(title: "Page", image: .file("og.png"), icon: .url("https://e/favicon.ico"), fetchedAt: 3),
          style: .side)))
  #expect(
    body(3)
      == .links(
        LinkList(
          items: [
            LinkList.Item(id: "i1", url: "https://a", title: "A", rich: false), .init(id: "i2", url: "https://b"),
          ],
          rich: true)))
  #expect(body(4) == .board(SubBoard(board: BoardID(rawValue: "other"), twoColumnPreview: true)))
  #expect(b.cards[4].height == 200)
  #expect(FileManager.default.fileExists(atPath: vault.url(of: "Board.board/images/og.png").path))
  #expect(FileManager.default.fileExists(atPath: vault.url(of: "Board.board/images/q.png").path))

  #expect(b.sidenotes.map(\.id.rawValue) == ["n1", "n2", "n3", "n4", "n7"])
  // a code sidenote's "why" is its own line over the code (notes.tsx sn-why)
  #expect(b.sidenotes[3].why == "where it is called")
  #expect(b.sidenotes[0].anchor == .card(c, segment: SegmentID(rawValue: "s"), lines: 6...6))
  #expect(b.sidenotes[0].body == .text(TextNote(text: "the reason\n\nthe text", alwaysShow: true)))
  #expect(b.sidenotes[0].review == "widened")
  #expect(b.sidenotes[1].anchor == .section(SectionID(rawValue: "sec")))
  #expect(
    b.sidenotes[1].body
      == .text(
        TextNote(
          text: "a question ![](images/q.png)",
          question: Question(at: 9, done: true, answers: [Question.Answer(id: "a1", text: "[[N#^n]]", at: 10)]))))
  #expect(b.sidenotes[2].anchor == .point(x: 4, y: 5))
  #expect(b.sidenotes[2].body == .text(TextNote(text: "only a reason")))
  #expect(b.sidenotes[4].boardOnly && b.sidenotes[4].anchor == .card(CardID(rawValue: "put")))

  #expect(
    b.stickers == [
      Sticker(id: StickerID(rawValue: "k1"), glyph: .builtin(.todoText), anchor: .canvas(x: 1, y: 2, size: nil)),
      Sticker(
        id: StickerID(rawValue: "k2"), glyph: .emoji("🔥"), color: "#E3A132",
        anchor: .card(CardID(rawValue: "n"), x: 1, y: 2, size: 22)),
      Sticker(
        id: StickerID(rawValue: "k3"), glyph: .builtin(.star),
        anchor: .line(c, segment: SegmentID(rawValue: "s"), line: 6)),
      // its place along the arrow kept within 0…1
      Sticker(
        id: StickerID(rawValue: "k5"), glyph: .builtin(.zap),
        anchor: .arrow(ArrowID(rawValue: "l"), position: 1, x: 1, y: 2, size: nil)),
    ])
  #expect(b.shelf.count == 1)
  let e = b.shelf[0]
  #expect(e.id == "e1" && e.at == 100 && e.cards.map(\.id.rawValue) == ["put"])
  #expect(e.cards[0].measuredHeight == 44 && e.cards[0].section == SectionID(rawValue: "inner"))
  #expect(e.sections.map(\.parent) == [SectionID(rawValue: "sec")])
  #expect(e.arrows.map(\.id.rawValue) == ["l9"] && e.stickers.map(\.id.rawValue) == ["k7", "k9"])
  #expect(e.stickers[1].anchor == .arrow(ArrowID(rawValue: "l9"), position: 0.42, x: -16, y: -40, size: 24))
  #expect(b.seal == Seal(text: "引用", color: .teal))
  #expect(
    skipped(report, "b.json") == [
      .variants: ["c"], .sidenoteWithoutAnchor: ["n5", "n6"], .stickerWithoutAnchor: ["k6", "k8"],
      .stickerPack: ["k4"],
    ])
}

@Test func boardsShownByOthersGoIntoTheirFolderWhoseFolderBoardTheyAre() throws {
  // Top shows Mid and Leaf; Mid shows Leaf and Deep; Other (later) shows Leaf too; Loop and Back show each other;
  // a folder named Top is there already
  let (vault, report, _) = try importing(
    [
      "a-top.json": oldBoard(
        "top", name: "Top",
        cards: [
          ["id": "m", "kind": "board", "board": "mid"], ["id": "l", "kind": "board", "board": "leaf"], oldNote("own"),
          ["id": "m2", "kind": "board", "board": "mid"],
        ],
        place: [
          "m": ["x": 10, "y": 20, "w": 300], "l": ["x": 500, "y": 20, "w": 300], "own": ["x": 0, "y": 400, "w": 200],
          "m2": ["x": 900, "y": 20, "w": 300],
        ]),
      "b-mid.json": oldBoard(
        "mid", name: "Mid",
        cards: [["id": "l", "kind": "board", "board": "leaf"], ["id": "d", "kind": "board", "board": "deep"]]),
      "c-leaf.json": oldBoard("leaf", name: "Leaf"),
      "d-deep.json": oldBoard("deep", name: "Deep 深"),
      "e-other.json": oldBoard("other", name: "Other", cards: [["id": "l", "kind": "board", "board": "leaf"]]),
      "f-loop.json": oldBoard("loop", name: "Loop", cards: [["id": "b", "kind": "board", "board": "back"]]),
      "g-back.json": oldBoard("back", name: "Back", cards: [["id": "l", "kind": "board", "board": "loop"]]),
    ],
    before: {
      try FileManager.default.createDirectory(at: $0.appending(path: "Top"), withIntermediateDirectories: true)
    })
  #expect(report.failed.isEmpty)
  #expect(
    report.imported.map(\.destination) == [
      "Top 2/.folder.board", "Top 2/Mid/.folder.board", "Top 2/Leaf.board", "Top 2/Mid/Deep 深.board", "Other.board",
      "Loop/.folder.board", "Loop/Back.board",
    ])
  // the folder board keeps its content and where its cards are; its cards for its own boards are automatic
  let top = try vault.board(at: "Top 2/.folder.board")
  #expect(top.id.rawValue == "top" && top.cards.count == 4)
  #expect(top.cards[0].content == .own(CardContent(body: .board(SubBoard(folder: "Mid")))))
  #expect(top.cards[0].x == 10 && top.cards[0].y == 20)
  #expect(
    top.cards[1].content == .own(CardContent(body: .board(SubBoard(board: BoardID(rawValue: "leaf"), auto: true)))))
  #expect(
    top.cards[3].content == .own(CardContent(body: .board(SubBoard(board: BoardID(rawValue: "mid"))))), "a second")
  // Mid shows Leaf, which is Top's: a plain card; Other's too
  let mid = try vault.board(at: "Top 2/Mid/.folder.board")
  #expect(mid.cards[0].content == .own(CardContent(body: .board(SubBoard(board: BoardID(rawValue: "leaf"))))))
  #expect(
    mid.cards[1].content == .own(CardContent(body: .board(SubBoard(board: BoardID(rawValue: "deep"), auto: true)))))
  #expect(
    try vault.board(at: "Other.board").cards[0].content
      == .own(CardContent(body: .board(SubBoard(board: BoardID(rawValue: "leaf"))))))
  // the tree: titles from the folders, nothing in the folder that was there
  let tree = try vault.tree()
  #expect(tree.folder(at: "Top 2")?.folderBoard?.title == "Top 2" && tree.folder(at: "Top")?.allBoards.isEmpty == true)
  #expect(tree.folder(at: "Top 2/Mid")?.folderBoard?.id.rawValue == "mid")
  // on its folder board, what the folder has: nothing to add or take away
  var t = top
  #expect(!t.keepUp(with: try #require(tree.folder(at: "Top 2")).entries))
}

// A version 13 library card of free code shown on two boards: its one segment is in the shared card's file, and both
// boards show that file (a count of board.json files alone finds one segment fewer than the old folder holds)
@Test func libraryFreeCodeKeepsItsSegment() throws {
  let seg: [String: Any] = [
    "id": "s", "src": ["kind": "free", "langPicked": true], "path": "", "lang": "python", "start": 1, "end": 2,
    "text": ["a", "b"], "version": ["kind": "none"],
  ]
  let lib: [String: Any] = ["version": 13, "card": ["id": "f", "kind": "code", "segments": [seg]]]
  let ref: [String: Any] = ["id": "f", "kind": "shared"]
  let (vault, report, _) = try importing(
    [
      "a.json": oldBoard("a", name: "A", cards: [ref], extra: ["version": 13]),
      "b.json": oldBoard("b", name: "B", cards: [ref], extra: ["version": 13]),
    ], shared: ["f": lib])
  #expect(report.failed.isEmpty)
  #expect(try vault.board(at: "A.board").cards.map(\.content) == [.shared])
  #expect(try vault.board(at: "B.board").cards.map(\.content) == [.shared])
  guard case .code(let code) = try vault.sharedCard(CardID(rawValue: "f")).content.body else {
    Issue.record("not code")
    return
  }
  #expect(code.segments.map(\.lines) == [["a", "b"]])
  #expect(code.segments[0].source == nil)
}

// The extension keeps each board's camera in VS Code's workspace state (packages/host/src/storage/place.ts camsOf), the
// world drawn at translate(x, y) scale(z): it comes in as the board point at the top left and the zoom, by the id each
// board has in the vault (a copy's its own)
@Test func camerasComeFromTheWorkspaceStateOfTheFolderHoldingTheBoards() throws {
  let root = try scratch()
  let project = root.appending(path: "project")
  let source = project.appending(path: ".codeboard")
  try put(oldBoard("b1", name: "One"), at: source.appending(path: "one.json"))
  try put(oldBoard("b2", name: "Two"), at: source.appending(path: "two.json"))
  let workspaces = root.appending(path: "workspaceStorage")
  func workspace(_ name: String, folder: URL, cams: [String: Any]) throws {
    let dir = workspaces.appending(path: name)
    try put(["folder": folder.absoluteString], at: dir.appending(path: "workspace.json"))
    let state = String(
      decoding: try JSONSerialization.data(withJSONObject: ["codeboard.cams": cams, "codeboard.open": []]),
      as: UTF8.self)
    let p = Process()
    p.executableURL = URL(filePath: "/usr/bin/sqlite3")
    p.arguments = [
      dir.appending(path: "state.vscdb").path,
      "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); INSERT INTO ItemTable VALUES "
        + "('yhnocoder.codeboard-vscode', '\(state)'), ('other', 'x');",
    ]
    try p.run()
    p.waitUntilExit()
  }
  try workspace("a", folder: root, cams: ["b1": ["x": 1, "y": 1, "z": 1]])
  try workspace("b", folder: project, cams: ["b1": ["x": 80, "y": -40, "z": 2], "b2": ["x": 0, "y": 0, "z": 0]])
  let cams = LegacyImport.cameras(for: source, in: workspaces)
  // the deepest workspace holding the folder; a camera that cannot be (zoom 0) is left out
  #expect(cams == ["b1": BoardCamera(x: -40, y: 20, zoom: 2)])
  #expect(LegacyImport.cameras(for: source, in: root.appending(path: "none")).isEmpty)

  let vault = root.appending(path: "vault")
  try FileManager.default.createDirectory(at: vault.appending(path: "Old.board"), withIntermediateDirectories: true)
  try Board(id: BoardID(rawValue: "b1"), cards: []).encoded().write(to: vault.appending(path: "Old.board/board.json"))
  let state = workspaces.appending(path: "b/state.vscdb")
  let stateBefore = try Data(contentsOf: state)
  let store = CameraStore(folder: root.appending(path: "app-state"))
  let report = try LegacyImport.run(from: source, to: vault, cameras: cams, store: store)
  #expect(report.cameras == [BoardID(rawValue: "b1-copy"): BoardCamera(x: -40, y: 20, zoom: 2)])
  // kept in this machine's state for the vault they came into, for the board to open there; not in the vault, and
  // VS Code's state is only read
  #expect(store.cameras(for: Vault(root: vault)) == report.cameras)
  #expect(store.cameras(for: Vault(root: root.appending(path: "other"))).isEmpty)
  #expect(
    try FileManager.default.subpathsOfDirectory(atPath: vault.path).allSatisfy { !$0.contains("camera") })
  #expect(try Data(contentsOf: state) == stateBefore)
}

// Cameras are this machine's state, kept under the running app's own identity: a test or acceptance build never reads
// or writes the app's
@Test func camerasAreKeptUnderTheRunningAppsOwnName() throws {
  let folder = try #require(CameraStore.ofThisApp()?.folder)
  #expect(!folder.path.contains("com.yhnocoder.codeboard"))
  #expect(folder.path.contains("Application Support/"))
  let root = try scratch()
  let store = CameraStore(folder: root.appending(path: "state"))
  let a = Vault(root: root.appending(path: "a"))
  try store.keep([BoardID(rawValue: "x"): BoardCamera(x: 1, y: 2, zoom: 3)], for: a)
  try store.keep([BoardID(rawValue: "y"): BoardCamera(x: 4, y: 5, zoom: 1)], for: a)
  #expect(store.cameras(for: a).count == 2)
  #expect(store.cameras(for: Vault(root: root.appending(path: "a/"))).count == 2, "by the standardized path")
  #expect(store.cameras(for: Vault(root: root.appending(path: "b"))).isEmpty)
  #expect(try FileManager.default.contentsOfDirectory(atPath: store.folder.path).count == 1, "no side file left")
}

// 同一块白板的共享卡: main's cards with the same `same` (packages/core/src/edit/twins.ts) come in as one card placed
// twice, each with its own id, place and tilt, their content the same
@Test func twinsComeInAsTheSameCardPlacedTwice() throws {
  let note = { (id: String, tilt: Bool) -> [String: Any] in
    var n = oldNote(id, "same text")
    n["same"] = "t1"
    if tilt { n["tilt"] = true }
    return n
  }
  let (vault, report, _) = try importing([
    "b.json": oldBoard("b", name: "B", cards: [note("n1", false), note("n2", true)])
  ])
  #expect(report.failed.isEmpty)
  #expect(skipped(report, "b.json").isEmpty)
  let b = try vault.board(at: "B.board")
  #expect(b.cards.map(\.same) == ["t1", "t1"])
  #expect(b.cards.map(\.tilted) == [false, true])
  #expect(b.cards[0].content == b.cards[1].content)
}

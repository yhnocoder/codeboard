import CodeBoardModel
import Foundation
import Testing

/// Imports `boards` (relative path → old board) and `shared` (id → old shared card file) from a fresh storage folder
private func importing(
  _ boards: [String: [String: Any]], shared: [String: [String: Any]] = [:], assets: [String: Data] = [:]
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
  let report = try LegacyImport.run(from: try fixtureStorage(), to: try scratch().appending(path: "vault"))
  #expect(report.imported.map(\.source) == ["bflow1.json", "cards/cshared.json", "engine/bsched.json"])
  let s = skipped(report, "bflow1.json")
  #expect(s[.sidenote] == ["n1", "n2"])
  #expect(s[.sticker] == ["k1"])
  #expect(s[.webCard] == ["cweb"])
  #expect(s[.variants] == ["cfree"])
  #expect(s[.messageNote] == ["cmsg"])
  #expect(s[.summary] == ["sec-outer", "cshared"])
  #expect(s[.callMark] == ["lcall"])
  #expect(s[.arrowWithoutEnd] == ["lweb"])
  #expect(s[.missingImage] == ["ffffffffffffffff-1x1.png"])
  #expect(
    s[.field] == [
      "bflow1.born", "bflow1.hideNumbers", "bflow1.seq", "sstep.keep", "cgh.collapsed", "sfree.src.langPicked",
      "cbox.bold",
    ])
  // the sidenote that travels with the shared card is in its library file
  #expect(skipped(report, "cards/cshared.json") == [.sidenote: ["n9"]])
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
  #expect(board.cards.count == 12)
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

@Test func noteLooksBecomeNoteStyles() throws {
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
  let (vault, report, _) = try importing(["b.json": oldBoard("b", cards: looks)])
  #expect(report.failed.isEmpty)
  let styles = try vault.board(at: "Board.board").cards.map { c -> NoteStyle? in
    guard case .own(let content) = c.content, case .note(let note) = content.body else { return nil }
    return note.style
  }
  #expect(
    styles == [
      .note, .text(size: .body, bold: false), .text(size: .heading, bold: true), .box(fill: .yellow),
      .mark(color: .purple, weight: .light, fontSize: 32), .mark(color: .blue, weight: .regular, fontSize: nil),
      .freeText(level: 0, bold: false, fontSize: nil), .freeText(level: 3, bold: true, fontSize: 50),
    ])
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

@Test func sharedCardsGoToTheAppDataFolderAndBoardsReferToThem() throws {
  let shared: [String: Any] = [
    "version": 14, "card": oldNote("s1", "shared ![](assets/s.png)"), "sidenotes": [],
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
  #expect(try vault.sharedCard(CardID(rawValue: "s1")).content.body == .note(Note(text: "shared ![](images/s.png)")))
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
      code, ["id": "w", "kind": "links", "items": []], ["id": "sb", "kind": "board", "board": "other"],
      ["id": "cmp", "kind": "compare", "cols": ["x1", "x2"]], oldNote("x1"), oldNote("x2"), oldNote("shelved"),
    ],
    place: [
      "c": ["x": 0, "y": 0, "w": 1], "w": ["x": 0, "y": 0, "w": 1], "sb": ["x": 0, "y": 0, "w": 1],
      "cmp": ["x": 0, "y": 0, "w": 1],
    ],
    extra: [
      "shelf": [["id": "sh1", "at": 1, "place": [:], "sections": [], "links": [], "stickers": []]],
      "seal": ["text": "引"], "mystery": 1,
    ])
  let (_, report, _) = try importing(["b.json": board])
  #expect(report.failed.isEmpty)
  #expect(
    skipped(report, "b.json") == [
      .shelf: ["sh1"], .linksCard: ["w"], .compareCard: ["cmp", "x1", "x2"], .subBoardCard: ["sb"],
      .unplacedCard: ["shelved"], .mergedFrom: ["c"], .generated: ["c"], .classMembers: ["c"], .twin: ["c"],
      .field: ["b.mystery", "b.seal", "c.keepOld"],
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

@Test func reimportIsByteIdentical() throws {
  let source = try fixtureStorage()
  let dst = try scratch().appending(path: "vault")
  let first = try LegacyImport.run(from: source, to: dst)
  let after = try files(under: dst)
  let second = try LegacyImport.run(from: source, to: dst)
  #expect(try files(under: dst) == after)
  #expect(second == first)
}

@Test func reimportFindsARenamedAndMovedBoardByID() throws {
  let source = try fixtureStorage()
  let dst = try scratch().appending(path: "vault")
  _ = try LegacyImport.run(from: source, to: dst)
  let fm = FileManager.default
  try fm.createDirectory(at: dst.appending(path: "Mine/Deep"), withIntermediateDirectories: true)
  try fm.moveItem(at: dst.appending(path: "Engine step.board"), to: dst.appending(path: "Mine/Deep/Renamed.board"))
  // the old board changes in VS Code meanwhile
  let file = source.appending(path: "bflow1.json")
  var old = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
  old["hideAllComments"] = true
  try put(old, at: file)
  let report = try LegacyImport.run(from: source, to: dst)
  #expect(report.imported.first { $0.source == "bflow1.json" }?.destination == "Mine/Deep/Renamed.board")
  #expect(!fm.fileExists(atPath: dst.appending(path: "Engine step.board").path))
  let vault = Vault(root: dst)
  #expect(try vault.board(at: "Mine/Deep/Renamed.board").hideComments)
  #expect(try vault.tree().allBoards.count == 2)
}

@Test func otherVersionsAndMalformedFilesFailOneByOne() throws {
  let (vault, report, source) = try importing([
    "good.json": oldBoard("good"),
    "v13.json": ["version": 13, "name": "Old", "cards": []],
    "v1.json": ["name": "Oldest", "cards": []],
    "v15.json": ["version": 15, "name": "Newer"],
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
      .oldVersion(file("v1.json"), 1),
      .oldVersion(file("v13.json"), 13),
      .newerVersion(file("v15.json"), 15),
    ])
  #expect(LegacyImportError.oldVersion(file("v13.json"), 13).description.contains("VS Code extension"))
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

@Test func freeCodeHasNoSource() throws {
  let code: [String: Any] = [
    "id": "c", "kind": "code",
    "segments": [
      [
        "id": "s", "src": ["kind": "free", "url": "https://gist.github.com/x"], "path": "", "lang": "python",
        "start": 1, "end": 1, "text": ["pass"], "version": ["kind": "none"],
      ]
    ],
  ]
  let (vault, report, _) = try importing(["b.json": oldBoard("b", cards: [code])])
  let content = try onlyCard(vault, "Board.board")
  #expect(
    content.body
      == .code(
        CodeCard(segments: [
          Segment(id: SegmentID(rawValue: "s"), source: nil, language: "python", firstLine: 1, lines: ["pass"])
        ])))
  #expect(skipped(report, "b.json") == [.field: ["s.src.url"]])
}

import Foundation
import Testing

@testable import CodeBoardModel

// The annotations of sourced code, kept in their repository's file in `.codeboard/code/` (FORMAT.md, Code annotations)

private let repo = "https://github.com/GeeeekExplorer/nano-vllm"
private let key = "github.com/geeeekexplorer/nano-vllm"
private let path = "nanovllm/engine/scheduler.py"

/// The nano-vllm fixture's scheduler, as a card would show its lines
private func scheduler() throws -> [String] {
  let url = URL(filePath: #filePath).deletingLastPathComponent()
    .appending(path: "../CodeBoardAnalysisTests/Fixtures/nano-vllm/nanovllm/engine/scheduler.py")
  return try String(contentsOf: url, encoding: .utf8).components(separatedBy: "\n")
}

private func segment(
  _ id: String, first: Int = 8, count: Int = 12, commit: String = "c1", highlights: [ClosedRange<Int>] = [],
  lines: [String]? = nil
) throws -> Segment {
  let all = try scheduler()
  return Segment(
    id: SegmentID(rawValue: id),
    source: .git(repository: repo, commit: commit, path: path, uncommitted: false, checkout: nil),
    language: "python", firstLine: first, lines: lines ?? Array(all[(first - 1)..<(first - 1 + count)]),
    highlights: highlights)
}

private func card(_ id: String, _ seg: Segment, x: Double = 0, hidden: Bool = false) -> Card {
  Card(
    id: CardID(rawValue: id), x: x, y: 0, width: 400,
    content: .own(CardContent(body: .code(CodeCard(segments: [seg], annotationsHidden: hidden ? true : nil)))))
}

private func note(_ id: String, on c: String, _ s: String, _ lines: ClosedRange<Int>, _ text: String) -> Sidenote {
  Sidenote(
    id: SidenoteID(rawValue: id), anchor: .card(CardID(rawValue: c), segment: SegmentID(rawValue: s), lines: lines),
    body: .text(TextNote(text: text)))
}

/// Identical lines matched in order (the workspace's diff, for these tests)
private func sameLines(_ a: [String], _ x: Int, _ b: [String], _ y: Int) -> [Int: Int] {
  var out: [Int: Int] = [:]
  var j = 0
  for (i, l) in a.enumerated() {
    guard let k = b[j...].firstIndex(of: l) else { continue }
    out[x + i] = y + k
    j = k + 1
  }
  return out
}

@MainActor private func store(_ vault: Vault) -> CodeNotes {
  CodeNotes(
    vault: vault,
    key: { s in
      guard case .git(let r?, _, _, _, _) = s else { return nil }
      return r == repo ? key : nil
    }, lineMap: sameLines)
}

/// A board written as version 2 wrote it: its code's annotations on its cards
private func writeOld(_ b: Board, to package: URL) throws {
  try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
  var json = try #require(try JSONSerialization.jsonObject(with: canonicalJSON(b)) as? [String: Any])
  json["version"] = 2
  try JSONSerialization.data(withJSONObject: json).write(to: package.appending(path: Vault.boardFileName))
}

private func codeFiles(_ vault: Vault) throws -> [String] {
  ((try? FileManager.default.contentsOfDirectory(atPath: CodeFiles.folder(vault).path)) ?? []).sorted()
}

private func readNotes(_ vault: Vault, _ name: String) throws -> RepositoryNotes {
  var dropped: [String] = []
  let url = CodeFiles.folder(vault).appending(path: name)
  return try RepositoryNotes(decoding: Data(contentsOf: url), file: url, dropped: &dropped)
}

/// A vault with one board package holding `b` as version 2 wrote it
private func oldVault(_ b: Board, name: String = "A") throws -> (Vault, URL) {
  let vault = Vault(root: try scratch())
  let package = vault.root.appending(path: "\(name).board")
  try writeOld(b, to: package)
  return (vault, package.appending(path: Vault.boardFileName))
}

private func codeBoard(_ id: String) throws -> Board {
  Board(
    id: BoardID(rawValue: id), cards: [card("c", try segment("s", highlights: [10...11]))],
    sidenotes: [note("n1", on: "c", "s", 10...11, "why the max")])
}

@MainActor @Suite(.serialized) struct CodeNotesTests {
  @Test func aPlaceWhoseTextIsNotOneStringPerLineIsLeftOutOfWhatIsRead() throws {
    let vault = Vault(root: try scratch())
    let folder = CodeFiles.folder(vault)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let json = """
      {"version": 1, "repository": "\(key)", "files": {"\(path)": {"highlights": [
        {"id": "h1", "place": {"commit": "c1", "lines": [10, 11], "text": ["a"]}, "at": 1},
        {"id": "h2", "place": {"commit": "c1", "lines": [10, 11], "text": ["a", "b"]}, "at": 1}
      ], "sidenotes": []}}}
      """
    try Data(json.utf8).write(to: folder.appending(path: "r1.json"))
    var said: [String] = []
    let s = store(vault)
    s.onProblem = { said.append($0) }
    s.reload()
    #expect(s.notes(key, path).highlights.map(\.id) == ["h2"])
    #expect(said.contains { $0.contains("highlights[0]") })
  }

  @Test func twoFilesOfOneRepositoryAreOneUntilItsNextChangeWritesThemAsOne() throws {
    let vault = Vault(root: try scratch())
    let folder = CodeFiles.folder(vault)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let seg = try segment("s")
    let a = CodePlace(seg, 10...10)!
    let b = CodePlace(seg, 12...12)!
    var one = RepositoryNotes(repository: key)
    one.files[path] = CodeFileNotes(sidenotes: [CodeSidenote(id: SidenoteID(rawValue: "n1"), place: a, text: "mine")])
    var two = RepositoryNotes(repository: key)
    two.files[path] = CodeFileNotes(
      highlights: [CodeHighlight(id: "h1", place: b, at: 5)],
      sidenotes: [CodeSidenote(id: SidenoteID(rawValue: "n1"), place: a, text: "theirs")])
    try one.encoded().write(to: folder.appending(path: "a.json"))
    try two.encoded().write(to: folder.appending(path: "b.json"))
    let before = try files(under: folder)
    let s = store(vault)
    let notes = s.notes(key, path)
    #expect(notes.highlights.map(\.id) == ["h1"])
    #expect(notes.sidenotes.map(\.text) == ["mine", "theirs"], "the same id with other content: both kept")
    #expect(Set(notes.sidenotes.map(\.id)).count == 2)
    #expect(try files(under: folder) == before, "reading writes nothing")
    s.change(key) { $0.files[path]!.highlights[0].at = 6 }
    try s.flush()
    #expect(try codeFiles(vault) == ["a.json", "b.json\(CodeFiles.mergedSuffix)"])
    #expect(try readNotes(vault, "a.json").files[path]?.sidenotes.count == 2)
  }

  @Test func anOldBoardsCodeAnnotationsMoveToTheRepositoryFileBeforeTheBoardIsWritten() throws {
    let (vault, file) = try oldVault(try codeBoard("A"))
    let s = store(vault)
    let doc = try BoardDocument(file: { file }, vault: vault, code: s)
    #expect(doc.board.sidenote(SidenoteID(rawValue: "n1")) != nil, "shown on the card as before")
    doc.flush()
    let name = try #require(try codeFiles(vault).first)
    let n = try readNotes(vault, name)
    #expect(n.files[path]?.highlights.map(\.place.lines) == [10...11])
    #expect(n.files[path]?.sidenotes.map(\.id.rawValue) == ["n1"])
    let written = try Board(decoding: Data(contentsOf: file), file: file)
    #expect(written.sidenotes.isEmpty)
    #expect(written.segment(CardID(rawValue: "c"), SegmentID(rawValue: "s"))?.highlights == [])
    #expect(String(decoding: try Data(contentsOf: file), as: UTF8.self).contains("\"version\": 3"))
  }

  @Test func theUpgradeRunAgainAfterAFailureHalfwayAddsNothingTwice() throws {
    let old = try codeBoard("A")
    let (vault, file) = try oldVault(old)
    let s = store(vault)
    let doc = try BoardDocument(file: { file }, vault: vault, code: s)
    doc.flush()
    // the board file not written after all: the repository's file is there, the old board too
    try writeOld(old, to: file.deletingLastPathComponent())
    let again = store(vault)
    let doc2 = try BoardDocument(file: { file }, vault: vault, code: again)
    doc2.flush()
    let n = try readNotes(vault, try #require(try codeFiles(vault).first))
    #expect(n.files[path]?.highlights.count == 1)
    #expect(n.files[path]?.sidenotes.count == 1)
    #expect(doc2.board.sidenotes.count == 1)
  }

  @Test func aRepositoryFileThatCannotBeWrittenLeavesTheBoardFileAsItWas() throws {
    let (vault, file) = try oldVault(try codeBoard("A"))
    let before = try Data(contentsOf: file)
    // where the folder would be, a file: nothing can be written in it
    let folder = CodeFiles.folder(vault)
    try FileManager.default.createDirectory(at: folder.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data().write(to: folder)
    let doc = try BoardDocument(file: { file }, vault: vault, code: store(vault))
    doc.flush()
    #expect(try Data(contentsOf: file) == before)
    #expect(doc.problem != nil)
    try FileManager.default.removeItem(at: folder)
    let doc2 = try BoardDocument(file: { file }, vault: vault, code: store(vault))
    doc2.flush()
    #expect(try codeFiles(vault).count == 1)
    #expect(try Board(decoding: Data(contentsOf: file), file: file).sidenotes.isEmpty)
  }

  @Test func twoBoardsUpgradingAtOnceBothKeepTheirAnnotations() throws {
    let (vault, a) = try oldVault(try codeBoard("A"), name: "A")
    var other = Board(id: BoardID(rawValue: "B"), cards: [card("d", try segment("t", highlights: [14...15]))])
    other.sidenotes = [note("m1", on: "d", "t", 14...15, "the queues")]
    let b = vault.root.appending(path: "B.board")
    try writeOld(other, to: b)
    let s = store(vault)
    let docA = try BoardDocument(file: { a }, vault: vault, code: s)
    let docB = try BoardDocument(file: { b.appending(path: Vault.boardFileName) }, vault: vault, code: store(vault))
    docB.flush()
    docA.flush()
    let n = try readNotes(vault, try #require(try codeFiles(vault).first))
    #expect(Set(n.files[path]?.sidenotes.map(\.id.rawValue) ?? []) == ["n1", "m1"])
    #expect(n.files[path]?.highlights.count == 2)
    #expect(try codeFiles(vault).count == 1)
  }

  @Test func theSameAnnotationOnTwoBoardsIsOneAndAnotherUnderTheSameIdIsKept() throws {
    let (vault, a) = try oldVault(try codeBoard("A"), name: "A")
    var copy = try codeBoard("B")
    copy.cards[0] = card("e", try segment("u", commit: "c2", highlights: [10...11]))
    copy.sidenotes = [note("n1", on: "e", "u", 10...11, "why the max"), note("n9", on: "e", "u", 10...11, "x")]
    var changed = try codeBoard("C")
    changed.sidenotes[0].body = .text(TextNote(text: "another why"))
    let b = vault.root.appending(path: "B.board")
    let c = vault.root.appending(path: "C.board")
    try writeOld(copy, to: b)
    try writeOld(changed, to: c)
    let s = store(vault)
    for f in [a, b.appending(path: Vault.boardFileName), c.appending(path: Vault.boardFileName)] {
      try BoardDocument(file: { f }, vault: vault, code: s).flush()
    }
    let n = s.notes(key, path)
    #expect(n.highlights.count == 1, "the same lines and text at another commit: one")
    #expect(n.sidenotes.map(\.text).sorted() == ["another why", "why the max", "x"])
    #expect(Set(n.sidenotes.map(\.id)).count == 3)
  }

  @Test func aFileWithNoAnnotationsLeftIsDeleted() throws {
    let (vault, file) = try oldVault(try codeBoard("A"))
    let doc = try BoardDocument(file: { file }, vault: vault, code: store(vault))
    doc.flush()
    #expect(try codeFiles(vault).count == 1)
    let l = Lines(card: CardID(rawValue: "c"), segment: SegmentID(rawValue: "s"), range: 10...11)
    doc.edit("Remove Highlight") { $0.removeHighlight(l) }
    doc.flush()
    #expect(try codeFiles(vault).isEmpty)
  }

  @Test func aRepositoryFileIsReplacedWholeNotWrittenInPlace() throws {
    let (vault, file) = try oldVault(try codeBoard("A"))
    let s = store(vault)
    let doc = try BoardDocument(file: { file }, vault: vault, code: s)
    doc.flush()
    let name = try #require(try codeFiles(vault).first)
    let url = CodeFiles.folder(vault).appending(path: name)
    let held = url.deletingLastPathComponent().appending(path: "held")
    try FileManager.default.linkItem(at: url, to: held)
    let was = try Data(contentsOf: held)
    doc.edit("Edit Sidenote") { $0.writeSidenote(SidenoteID(rawValue: "n1"), "changed") }
    doc.flush()
    #expect(try Data(contentsOf: held) == was, "a new file renamed over it: the old one is untouched")
    #expect(try readNotes(vault, name).files[path]?.sidenotes.first?.text == "changed")
  }

  @Test func aHighlightOnOneBoardShowsOnEveryBoardShowingThoseLines() throws {
    let vault = Vault(root: try scratch())
    let s = store(vault)
    var docs: [BoardDocument] = []
    for (name, c) in [("A", "a"), ("B", "b")] {
      let package = vault.root.appending(path: "\(name).board")
      try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
      let b = Board(id: BoardID(rawValue: name), cards: [card(c, try segment("s\(c)"))])
      try b.encoded().write(to: package.appending(path: Vault.boardFileName))
      docs.append(try BoardDocument(file: { package.appending(path: Vault.boardFileName) }, vault: vault, code: s))
    }
    docs[0].edit("Add Sidenote") {
      _ = $0.addSidenote(
        SidenoteID(rawValue: "q"), text: "shared",
        at: .card(CardID(rawValue: "a"), segment: SegmentID(rawValue: "sa"), lines: 12...13))
    }
    #expect(docs[1].board.segment(CardID(rawValue: "b"), SegmentID(rawValue: "sb"))?.highlights == [12...13])
    #expect(docs[1].board.sidenote(SidenoteID(rawValue: "q"))?.anchor.card == CardID(rawValue: "b"))
    docs[1].edit("Edit Sidenote") { $0.writeSidenote(SidenoteID(rawValue: "q"), "written on B") }
    guard case .text(let t)? = docs[0].board.sidenote(SidenoteID(rawValue: "q"))?.body else {
      Issue.record("not on A")
      return
    }
    #expect(t.text == "written on B")
    for d in docs { d.flush() }
    let written = vault.root.appending(path: "A.board").appending(path: Vault.boardFileName)
    #expect(try Board(decoding: Data(contentsOf: written), file: written).sidenotes.isEmpty)
  }

  @Test func aCardWithItsAnnotationsHiddenShowsNoneAndKeepsItsOwn() throws {
    let (vault, file) = try oldVault(try codeBoard("A"))
    let doc = try BoardDocument(file: { file }, vault: vault, code: store(vault))
    let c = CardID(rawValue: "c")
    let s = SegmentID(rawValue: "s")
    doc.edit("Show Annotations") { $0.setAnnotationsHidden(c, true) }
    #expect(doc.board.segment(c, s)?.highlights == [])
    #expect(doc.board.sidenotes.isEmpty)
    doc.flush()
    #expect(doc.board.segment(c, s) != nil)
    doc.edit("Show Annotations") { $0.setAnnotationsHidden(c, false) }
    #expect(doc.board.segment(c, s)?.highlights == [10...11])
    #expect(doc.board.sidenotes.count == 1)
    doc.undo()
    #expect(doc.board.sidenotes.isEmpty)
  }

  @Test func aNewVersionTakesTheAnnotationsAlongAndKeepsWhatIsOnLinesGone() throws {
    var b = try codeBoard("A")
    b.sidenotes.append(note("n2", on: "c", "s", 17...17, "on a line that goes"))
    b.cards[0] = card("c", try segment("s", highlights: [10...11, 17...17]))
    let (vault, file) = try oldVault(b)
    let s = store(vault)
    let doc = try BoardDocument(file: { file }, vault: vault, code: s)
    let old = try #require(doc.board.segment(CardID(rawValue: "c"), SegmentID(rawValue: "s")))
    // two lines added above, line 17 gone
    var lines = old.lines
    lines.remove(at: 17 - old.firstLine)
    lines.insert(contentsOf: ["# a", "# b"], at: 0)
    var ns = old
    ns.lines = lines
    ns.source = .git(repository: repo, commit: "c2", path: path, uncommitted: false, checkout: nil)
    let map = sameLines(old.lines, old.firstLine, ns.lines, ns.firstLine)
    doc.edit("Update to New Version") { $0.rebaseSegment(CardID(rawValue: "c"), ns, map: { map[$0] }) }
    let n = s.notes(key, path)
    let moved = try #require(n.highlights.first { $0.place.lines == 12...13 })
    #expect(moved.place.commit == "c2")
    #expect(n.highlights.contains { $0.place.lines == 17...17 && $0.place.commit == "c1" }, "kept as it was")
    #expect(n.sidenotes.first { $0.id.rawValue == "n2" }?.place.lines == 17...17)
    #expect(doc.board.sidenote(SidenoteID(rawValue: "n2")) == nil, "shown nowhere")
    #expect(doc.board.sidenote(SidenoteID(rawValue: "n1"))?.anchor.lines?.range == 12...13)
  }

  @Test func anImportWritesTheRepositoryFileAndTheBoardWithoutWhatIsInIt() throws {
    let dst = try scratch().appending(path: "vault")
    let report = try LegacyImport.run(
      from: try fixtureStorage(), to: dst,
      key: { s in if case .git(_, _, _, _, let checkout?) = s, checkout.isEmpty { "root:test" } else { nil } })
    #expect(report.failed.isEmpty)
    let vault = Vault(root: dst)
    let n = try readNotes(vault, try #require(try codeFiles(vault).first))
    #expect(n.repository == "root:test")
    let f = try #require(n.files["nanovllm/engine/llm_engine.py"])
    #expect(f.highlights.map(\.place.lines) == [50...51])
    #expect(f.sidenotes.map(\.id.rawValue) == ["n1"])
    let board = try vault.board(at: "Engine step.board")
    #expect(board.sidenote(SidenoteID(rawValue: "n1")) == nil)
    #expect(board.segment(CardID(rawValue: "cstep"), SegmentID(rawValue: "sstep"))?.highlights == [])
  }
}

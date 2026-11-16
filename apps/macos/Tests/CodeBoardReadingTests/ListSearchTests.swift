import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

@testable import CodeBoardReading

// ⌘K's Resources group (ListSearch.swift): entries found by title, by authors and by their text, every word needed,
// one row an entry at its best passage with how many matched, and ⌘F's entries those a board's cards take from

@Suite struct ListSearchTests {
  let mills = EntryID(rawValue: "e-mills")
  let estuary = EntryID(rawValue: "e-estuary")

  /// Papers: Tidal mills by Ana Ruíz (a plain PDF of two pages, the wheel on both) and Estuary flows by Cai Lun (no
  /// version)
  func entries() throws -> (Vault, [EntryIndex.Found]) {
    let root = FileManager.default.temporaryDirectory.appending(path: "listsearch-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    let r = try vault.newResource(in: "", title: "Papers", preset: .papers)
    let e = Entry(
      id: mills, title: "Tidal mills", added: 1, authors: ["Ana Ruíz"],
      versions: [Version(id: VersionID(rawValue: "v1"), added: 1, content: .pdf(file: "v1.pdf"))])
    let pdf = makePDF([
      "The grain store.\n\nThe wheel turns.", "Every mill on the coast had a wheel and ran on the tide.",
    ])
    _ = try vault.newEntry(e, in: r.path, with: ["v1.pdf": pdf])
    _ = try vault.newEntry(
      Entry(id: estuary, title: "Estuary flows", added: 2, authors: ["Cai Lun"], year: 2023), in: r.path)
    return (vault, EntryIndex(vault, try vault.tree()).all)
  }

  @Test func theTitleAndTheAuthorsFindAnEntry() async throws {
    let (vault, all) = try entries()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let texts = ResourceTexts()
    let byTitle = await texts.search("ESTUARY", in: all, vault: vault)
    #expect(byTitle.map(\.entry) == [estuary])
    let h = try #require(byTitle.first)
    #expect(h.context == "Cai Lun" && h.label == nil && h.count == 0 && h.collect == nil)
    #expect(h.anchor == SourceAnchor(entry: estuary) && h.where == "Papers")
    #expect(h.preview == "**Estuary flows**\n\nCai Lun\n\n2023")
    #expect(await texts.search("ruíz", in: all, vault: vault).map(\.entry) == [mills])
  }

  @Test func theTextFindsTheBestPassageAndCountsThemAll() async throws {
    let (vault, all) = try entries()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let found = await ResourceTexts().search("wheel", in: all, vault: vault)
    let h = try #require(found.first)
    #expect(found.count == 1 && h.entry == mills && h.count == 2, "both pages, one row")
    // the shorter, earlier sentence of page 1 scores higher than page 2's
    #expect(h.label == "p. 1" && h.context == "The wheel turns.")
    guard case .page(1, nil)? = h.anchor.place?.block, let range = h.anchor.place?.range else {
      Issue.record("not a place on page 1: \(h.anchor)")
      return
    }
    #expect(h.collect?.body == .note(markdown: "The wheel turns.") && h.collect?.source == h.anchor)
    #expect(h.collect?.label == "p. 1" && h.collect?.title == "Tidal mills" && h.where == "Tidal mills › p. 1")
    #expect(range.count >= "The wheel turns.".utf16.count)
  }

  @Test func everyWordMustBeInTheTitleAndAuthorsOrInOnePassage() async throws {
    let (vault, all) = try entries()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let texts = ResourceTexts()
    // "tide" is in the text only, with "mill" on page 2
    let both = await texts.search("mill tide", in: all, vault: vault)
    #expect(both.map(\.entry) == [mills] && both.first?.label == "p. 2" && both.first?.count == 1)
    // grain on page 1, tide on page 2: no one passage has both
    #expect(await texts.search("grain tide", in: all, vault: vault).isEmpty)
    #expect(await texts.search("estuary zzz", in: all, vault: vault).isEmpty)
  }

  @Test func thisBoardsEntriesAreThoseItsCardsTakeFrom() async throws {
    let (vault, all) = try entries()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let card = Card(
      id: CardID(rawValue: "c"), x: 0, y: 0, width: 200,
      content: .own(CardContent(source: SourceAnchor(entry: estuary), body: .note(Note(text: "x")))))
    let here = ResourceTexts.entries(on: Board(id: BoardID(rawValue: "b"), cards: [card]))
    #expect(here == [estuary])
    let texts = ResourceTexts()
    #expect(await texts.search("mills", in: all, vault: vault, only: here).isEmpty)
    #expect(await texts.search("estuary", in: all, vault: vault, only: here).map(\.entry) == [estuary])
  }
}

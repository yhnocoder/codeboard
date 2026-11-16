import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

// A saved page's translations in its entry's folder: the file round trips, is written the same every time with its
// keys sorted, is read strictly, and is nothing when it is not there; its first write lists it in the entry as a
// Version of its own, once for each page version and language.

@Suite struct PageTranslationsTests {
  let dir = FileManager.default.temporaryDirectory.appending(path: "codeboard-translations-\(UUID().uuidString)")
  let vault: Vault
  /// The folder of an entry with one saved page, v2 (a link's entry, then the page saved twice: v1 and v2)
  let entry: String
  let v2 = VersionID(rawValue: "v2")

  init() throws {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    vault = Vault(root: dir)
    let resource = try vault.newResource(in: "", title: "Web", preset: .web).path
    let saved = { (n: Int) in
      SavedItem(
        id: "p\(n)", kind: .page, url: "https://example.org/a", title: "A page", savedAt: 1_000,
        pageHash: String(repeating: "\(n)", count: 64), bytes: 100)
    }
    try vault.save(saved(1), in: resource)
    entry = try vault.save(saved(2), in: resource)
  }

  var file: URL { vault.url(of: entry).appending(path: "v2.zh.json") }

  let some = PageTranslations(
    scheme: 1,
    blocks: [
      "1.b2": .init(hash: "h2", text: "第二段"), "1.b10": .init(hash: "h10", text: "标题 **粗** 1.5"),
      "1.b1": .init(hash: "h1", text: "第一段\n\"引号\""),
    ])

  @Test func translationsRoundTripInTheirFileBesideTheEntry() throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    #expect(try vault.translations(of: v2, language: "zh", in: entry) == nil)
    try vault.write(some, of: v2, language: "zh", in: entry)
    #expect(PageTranslations.fileName(of: v2, language: "zh") == "v2.zh.json")
    #expect(FileManager.default.fileExists(atPath: file.path))
    #expect(try vault.translations(of: v2, language: "zh", in: entry) == some)
    #expect(try vault.translations(of: v2, language: "en", in: entry) == nil, "another language's file")
    #expect(try vault.translations(of: VersionID(rawValue: "v1"), language: "zh", in: entry) == nil)
  }

  @Test func theFileIsWrittenTheSameEveryTimeWithItsKeysSorted() throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    try vault.write(some, of: v2, language: "zh", in: entry)
    let first = try Data(contentsOf: file)
    var again = PageTranslations(scheme: 1)
    for (id, b) in some.blocks.reversed() { again.blocks[id] = b }
    try vault.write(again, of: v2, language: "zh", in: entry)
    #expect(try Data(contentsOf: file) == first)
    let text = String(decoding: first, as: UTF8.self)
    let keys = ["\"blocks\"", "\"1.b1\"", "\"1.b10\"", "\"1.b2\"", "\"scheme\"", "\"version\""]
    let at = keys.map { text.range(of: $0)?.lowerBound }
    #expect(at.allSatisfy { $0 != nil } && at.map { $0! } == at.map { $0! }.sorted(), "\(text)")
    let json = try #require(try JSONSerialization.jsonObject(with: first) as? [String: Any])
    #expect(json["version"] as? Int == 1 && json["scheme"] as? Int == 1)
    let b1 = (json["blocks"] as? [String: Any])?["1.b1"] as? [String: String]
    #expect(b1 == ["hash": "h1", "text": "第一段\n\"引号\""])
  }

  @Test func aFileThatIsNotWhatTheWriterWritesIsRefused() throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    for bad in [
      #"{"version": 2, "scheme": 1, "blocks": {}}"#,
      #"{"scheme": 1, "blocks": {}}"#,
      #"{"version": 1, "scheme": 1, "blocks": {"a": {"hash": "h"}}}"#,
      #"{"version": 1, "scheme": 1, "blocks": {}, "extra": true}"#,
      "not json",
    ] {
      try Data(bad.utf8).write(to: file)
      #expect(throws: VaultError.self, "\(bad)") { try vault.translations(of: v2, language: "zh", in: entry) }
    }
  }

  @Test func theFirstWriteListsTheTranslationsAsAVersionOfThePageAndLaterOnesNone() throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    let listed = try #require(try vault.write(some, of: v2, language: "zh", in: entry))
    let t = Version(
      id: VersionID(rawValue: "v3"), label: "v2 中文", added: listed.versions[2].added, language: "zh", of: v2,
      content: .translation(file: "v2.zh.json"))
    #expect(listed.versions.map(\.id.rawValue) == ["v1", "v2", "v3"] && listed.versions[2] == t)
    #expect(try vault.entry(at: entry) == listed, "written to entry.json")
    #expect(try vault.write(some, of: v2, language: "zh", in: entry) == nil)
    #expect(try vault.listTranslations(of: v2, language: "zh", in: entry) == nil)
    #expect(try vault.entry(at: entry).versions.count == 3, "never a second one")
    let en = try #require(try vault.write(some, of: v2, language: "en", in: entry))
    #expect(en.versions.last?.label == "v2 en" && en.versions.last?.content == .translation(file: "v2.en.json"))
    var e = try vault.entry(at: entry)
    e.versions[0].label = "First"
    try vault.write(e, at: entry)
    let first = try #require(try vault.write(some, of: VersionID(rawValue: "v1"), language: "zh", in: entry))
    #expect(first.versions.last?.label == "First 中文" && first.versions.last?.id.rawValue == "v5")
  }

  /// A file written before translations were listed gets its Version when asked, once
  @Test func anUnlistedFileIsListedOnce() throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    try Data(#"{"blocks": {}, "scheme": 1, "version": 1}"#.utf8).write(to: file)
    #expect(try vault.entry(at: entry).versions.count == 2)
    let listed = try #require(try vault.listTranslations(of: v2, language: "zh", in: entry))
    #expect(listed.versions.last?.of == v2 && listed.versions.last?.language == "zh")
    #expect(try vault.listTranslations(of: v2, language: "zh", in: entry) == nil)
  }

  @Test func onlyASavedPageIsTranslated() throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    #expect(throws: VaultError.self) {
      try vault.listTranslations(of: VersionID(rawValue: "v9"), language: "zh", in: entry)
    }
  }

  @Test func aFolderThatCannotBeWrittenSaysSo() throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    #expect(throws: VaultError.self) { try vault.write(some, of: v2, language: "zh", in: "Web.resource/Gone") }
  }
}

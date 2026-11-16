import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

// A saved page's translations in its entry's folder: the file round trips, is written the same every time with its
// keys sorted, is read strictly, and is nothing when it is not there.

@Suite struct PageTranslationsTests {
  let dir = FileManager.default.temporaryDirectory.appending(path: "codeboard-translations-\(UUID().uuidString)")
  let vault: Vault
  let entry = "Web.resource/A page"
  let v2 = VersionID(rawValue: "v2")

  init() throws {
    vault = Vault(root: dir)
    try FileManager.default.createDirectory(at: vault.url(of: entry), withIntermediateDirectories: true)
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

  @Test func aFolderThatCannotBeWrittenSaysSo() throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    #expect(throws: VaultError.self) { try vault.write(some, of: v2, language: "zh", in: "Web.resource/Gone") }
  }
}

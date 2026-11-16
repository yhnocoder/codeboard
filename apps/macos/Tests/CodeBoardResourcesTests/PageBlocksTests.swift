import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

// A saved page's blocks file in its entry's folder: written once with the version naming it, the same every time,
// read strictly; a version that names a file already, or is not a saved page, is left as it is.

@Suite struct PageBlocksTests {
  let dir = FileManager.default.temporaryDirectory.appending(path: "codeboard-page-blocks-\(UUID().uuidString)")
  let vault: Vault
  /// The folder of an entry with one saved page, v1
  let entry: String
  let v1 = VersionID(rawValue: "v1")

  init() throws {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    vault = Vault(root: dir)
    let resource = try vault.newResource(in: "", title: "Web", preset: .web).path
    entry = try vault.save(
      SavedItem(
        id: "p1", kind: .page, url: "https://example.org/a", title: "A page", savedAt: 1_000,
        pageHash: String(repeating: "1", count: 64), bytes: 100),
      in: resource)
  }

  var file: URL { vault.url(of: entry).appending(path: "v1.blocks.json") }

  let some = [
    PageBlock(id: "1.b1", kind: "heading", level: 1, hash: "h1", text: "A heading"),
    PageBlock(id: "1.b2", kind: "paragraph", hash: "h2", text: "第一段\n\"引号\""),
  ]

  @Test func theBlocksAreWrittenOnceAndTheVersionNamesThem() throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    let e = try #require(try vault.writePageBlocks(some, of: v1, in: entry))
    #expect(PageBlock.fileName(of: v1) == "v1.blocks.json")
    let page = Version.Content.page(hash: String(repeating: "1", count: 64), bytes: 100, blocks: "v1.blocks.json")
    #expect(e.versions[0].content == page)
    #expect(try vault.entry(at: entry) == e)
    #expect(try vault.pageBlocks("v1.blocks.json", in: entry) == some)
    let written = try Data(contentsOf: file)
    #expect(
      String(decoding: written, as: UTF8.self) == """
        [
          {
            "hash": "h1",
            "id": "1.b1",
            "kind": "heading",
            "level": 1,
            "text": "A heading"
          },
          {
            "hash": "h2",
            "id": "1.b2",
            "kind": "paragraph",
            "text": "第一段\\n\\"引号\\""
          }
        ]

        """)
    let entryFile = vault.url(of: entry).appending(path: Vault.entryFileName)
    let before = try Data(contentsOf: entryFile)
    #expect(try vault.writePageBlocks([some[1]], of: v1, in: entry) == nil, "once")
    #expect(try Data(contentsOf: file) == written)
    #expect(try Data(contentsOf: entryFile) == before)
  }

  @Test func aVersionNamingAFileAlreadyOrNotAPageIsLeftAsItIs() throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    var e = try vault.entry(at: entry)
    e.versions[0].content = .page(hash: String(repeating: "1", count: 64), bytes: 100, blocks: "other.json")
    try vault.write(e, at: entry)
    #expect(try vault.writePageBlocks(some, of: v1, in: entry) == nil)
    #expect(try vault.writePageBlocks(some, of: VersionID(rawValue: "v9"), in: entry) == nil)
    #expect(!FileManager.default.fileExists(atPath: file.path))
    #expect(try vault.entry(at: entry) == e)
  }

  @Test func aFileThatIsNotWhatTheWriterWritesIsRefused() throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    try vault.writePageBlocks(some, of: v1, in: entry)
    let written = String(decoding: try Data(contentsOf: file), as: UTF8.self)
    for bad in [
      written.replacingOccurrences(of: #""level": 1,"#, with: #""level": null,"#),
      written.replacingOccurrences(of: #""level": 1,"#, with: #""level": 1, "seen": true,"#),
      written.replacingOccurrences(of: #""hash": "h2","#, with: ""),
      written.replacingOccurrences(of: "\n", with: ""),
      #"{"blocks": []}"#,
      "not json",
    ] {
      try Data(bad.utf8).write(to: file)
      #expect(throws: VaultError.self, "\(bad)") { try vault.pageBlocks("v1.blocks.json", in: entry) }
    }
    #expect(throws: VaultError.self) { try vault.pageBlocks("../v1.blocks.json", in: entry) }
    try FileManager.default.removeItem(at: file)
    #expect(throws: VaultError.self, "not there") { try vault.pageBlocks("v1.blocks.json", in: entry) }
  }
}

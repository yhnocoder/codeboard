import Foundation
import Testing

@testable import CodeBoardModel

// An import that fails halfway (a full disk, a folder it may not write) leaves nothing partial and the vault as it was

/// The hidden files and folders an import builds before moving them into place, left anywhere under `dir`
private func leftovers(under dir: URL) -> [String] {
  let all = FileManager.default.enumerator(atPath: dir.path)?.allObjects as? [String] ?? []
  return all.filter { $0.contains(".import-") }
}

/// An old storage folder with these boards, shared cards and assets
private func storage(
  _ boards: [String: [String: Any]], shared: [String: [String: Any]] = [:], assets: [String: Data] = [:]
) throws -> URL {
  let source = try scratch().appending(path: "storage")
  for (path, b) in boards { try put(b, at: source.appending(path: path)) }
  for (id, c) in shared { try put(c, at: source.appending(path: "cards/\(id).json")) }
  for (name, data) in assets {
    try FileManager.default.createDirectory(at: source.appending(path: "assets"), withIntermediateDirectories: true)
    try data.write(to: source.appending(path: "assets/\(name)"))
  }
  try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
  return source
}

@Test func aFailingImageWriteLeavesNoPartOfItsBoardOrSharedCard() throws {
  let source = try storage(
    [
      "a.json": oldBoard("a", name: "A", cards: [["id": "i", "kind": "image", "src": "pic.png"]]),
      "b.json": oldBoard("b", name: "B", cards: [oldNote("n"), ["id": "s1", "kind": "shared"]]),
      "g/c.json": oldBoard("c", name: "C", cards: [["id": "i", "kind": "image", "src": "pic.png"]]),
    ],
    shared: ["s1": ["version": 17, "card": oldNote("s1", "![](assets/s.png)")]],
    assets: ["pic.png": Data("pic".utf8), "s.png": Data("s".utf8)])
  let dst = try scratch().appending(path: "vault")
  let failing: @Sendable (URL) -> Bool = { ["pic.png", "s.png"].contains($0.lastPathComponent) }
  let report = try LegacyImport.$failing.withValue(failing, operation: { try LegacyImport.run(from: source, to: dst) })
  #expect(report.failed.count == 3)
  #expect(report.imported.map(\.source) == ["b.json"])
  let fm = FileManager.default
  #expect(!fm.fileExists(atPath: dst.appending(path: "A.board").path))
  #expect(!fm.fileExists(atPath: dst.appending(path: "g").path), "the group folder it made for the board goes too")
  #expect(!fm.fileExists(atPath: dst.appending(path: ".codeboard/shared/s1.json").path))
  #expect(!fm.fileExists(atPath: dst.appending(path: ".codeboard/shared/images/s.png").path))
  #expect(leftovers(under: dst).isEmpty)
  // the board that shows the shared card that failed has it as missing
  #expect(report.imported[0].skipped.first { $0.kind == .missingSharedCard }?.ids == ["s1"])
}

@Test func anUnwritableVaultFolderLeavesTheVaultAsItWasAndNoUnusedCopy() throws {
  let source = try fixtureStorage()
  let dst = try scratch().appending(path: "vault")
  _ = try LegacyImport.run(from: source, to: dst)
  // the shared card changed in the vault, so importing again copies it for the boards
  let vault = Vault(root: dst)
  var card = try vault.sharedCard(CardID(rawValue: "cshared"))
  card.content.title = "Changed here"
  try card.encoded().write(to: vault.sharedFolderURL.appending(path: "cshared.json"))
  let before = try files(under: dst)
  let fm = FileManager.default
  let closed = [dst, dst.appending(path: "engine")]
  for d in closed { try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: d.path) }
  defer { for d in closed { try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: d.path) } }

  let report = try LegacyImport.run(from: source, to: dst)
  for d in closed { try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: d.path) }
  #expect(report.failed.count == 2, "both boards")
  #expect(report.imported.allSatisfy { $0.copyOf == nil }, "the shared card's copy no board was written with is gone")
  #expect(try files(under: dst) == before)
  #expect(leftovers(under: dst).isEmpty)
}

@Test func aFailingWriteOfTheBoardFileLeavesNoPackage() throws {
  let source = try storage(["a.json": oldBoard("a", name: "A", cards: [oldNote("n")])])
  let dst = try scratch().appending(path: "vault")
  let failing: @Sendable (URL) -> Bool = { $0.lastPathComponent == Vault.boardFileName }
  let report = try LegacyImport.$failing.withValue(failing, operation: { try LegacyImport.run(from: source, to: dst) })
  #expect(report.failed.count == 1 && report.imported.isEmpty)
  #expect(try FileManager.default.contentsOfDirectory(atPath: dst.path).isEmpty)
}

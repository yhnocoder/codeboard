import CodeBoardModel
import Foundation
import Testing

// Resource packages in the vault's tree: listed with their id, preset and entry count, their entries counted without
// being read, after a folder's boards and never as a folder; renamed, moved and trashed as boards are.

private var fm: FileManager { .default }

private func resource(_ id: String, preset: String = "papers", at package: URL) throws {
  try fm.createDirectory(at: package, withIntermediateDirectories: true)
  try Data(#"{"fields": [], "id": "\#(id)", "preset": "\#(preset)", "version": 1}"#.utf8)
    .write(to: package.appending(path: Vault.resourceFileName))
}

/// An entry folder whose entry file is never read by the tree (it is not even JSON)
private func entry(_ name: String, in package: URL) throws {
  try fm.createDirectory(at: package.appending(path: name), withIntermediateDirectories: true)
  try Data("not read".utf8).write(to: package.appending(path: name).appending(path: Vault.entryFileName))
}

@Test func resourcesAreListedWithTheirEntriesCountedAfterTheBoards() throws {
  let root = try scratch()
  let v = Vault(root: root)
  try v.newBoard(in: "", title: "Engine")
  let papers = root.appending(path: "Papers.resource")
  try resource("r1", at: papers)
  try entry("Attention Is All You Need", in: papers)
  try entry("BERT", in: papers)
  try Data("%PDF".utf8).write(to: papers.appending(path: "notes.pdf"))
  try Data().write(to: papers.appending(path: ".DS_Store"))
  try fm.createDirectory(at: papers.appending(path: "Scans"), withIntermediateDirectories: false)
  try fm.createDirectory(at: papers.appending(path: ".hidden"), withIntermediateDirectories: false)
  try Data().write(to: papers.appending(path: ".hidden/entry.json"))
  try resource("r2", preset: "web", at: root.appending(path: "Articles 10.resource"))
  try resource("r3", preset: "files", at: root.appending(path: "Articles 9.resource"))
  try resource("r4", at: root.appending(path: "Kernels/Reading.resource"))

  let tree = try v.tree()
  #expect(tree.folders.map(\.name) == ["Kernels"], "a resource package is not a folder")
  #expect(tree.boards.map(\.title) == ["Engine"])
  #expect(
    tree.resources == [
      VaultResource(
        id: ResourceID(rawValue: "r3"), title: "Articles 9", path: "Articles 9.resource", preset: .files, entryCount: 0),
      VaultResource(
        id: ResourceID(rawValue: "r2"), title: "Articles 10", path: "Articles 10.resource", preset: .web, entryCount: 0),
      VaultResource(
        id: ResourceID(rawValue: "r1"), title: "Papers", path: "Papers.resource", preset: .papers, entryCount: 3),
    ], "in Finder's order by title; its folders with an entry file and its files, not hidden ones")
  #expect(tree.folders[0].resources.map(\.path) == ["Kernels/Reading.resource"])
  #expect(tree.boardCount == 1)
}

@Test func aResourceThatCannotBeReadIsListedApart() throws {
  let root = try scratch()
  try resource("r1", at: root.appending(path: "Good.resource"))
  let bad = root.appending(path: "Bad.resource")
  try fm.createDirectory(at: bad, withIntermediateDirectories: true)
  try Data(#"{"version": 1, "id": "r2"}"#.utf8).write(to: bad.appending(path: Vault.resourceFileName))
  try fm.createDirectory(at: root.appending(path: "Empty.resource"), withIntermediateDirectories: true)
  // of a newer version it is listed all the same: only its id and preset are read
  try fm.createDirectory(at: root.appending(path: "Newer.resource"), withIntermediateDirectories: true)
  try Data(#"{"version": 9, "id": "r3", "preset": "web", "later": true}"#.utf8)
    .write(to: root.appending(path: "Newer.resource/resource.json"))
  let tree = try Vault(root: root).tree()
  #expect(tree.resources.map(\.title) == ["Good", "Newer"])
  #expect(tree.unreadableResources.map(\.title) == ["Bad", "Empty"])
  #expect(tree.unreadableResources.map(\.path) == ["Bad.resource", "Empty.resource"])
  #expect(tree.unreadableResources.allSatisfy { !$0.reason.isEmpty })
  #expect(tree.unreadable.isEmpty && tree.folders.isEmpty)
}

@Test func listingResourcesWritesNothing() throws {
  let root = try scratch()
  let papers = root.appending(path: "Papers.resource")
  try resource("r1", at: papers)
  try entry("Attention Is All You Need", in: papers)
  try Data("%PDF".utf8).write(to: papers.appending(path: "notes.pdf"))
  let before = try files(under: root)
  _ = try Vault(root: root).tree()
  #expect(try files(under: root) == before)
}

@Test func aResourceIsRenamedMovedAndTrashedAsABoardIs() throws {
  let root = try scratch()
  let v = Vault(root: root)
  try resource("r1", at: root.appending(path: "Papers.resource"))
  try resource("r2", at: root.appending(path: "Taken.resource"))
  try v.newFolder(in: "", name: "Reading")
  var r = try #require(try v.tree().resources.first { $0.title == "Papers" })

  #expect(throws: VaultError.exists(v.url(of: "Taken.resource"))) { try v.rename(resource: r, to: "Taken") }
  #expect(try v.rename(resource: r, to: "Papers: 2017") == "Papers- 2017.resource")
  r = try #require(try v.tree().resources.first { $0.id == r.id })
  #expect(try v.move(r.path, into: "Reading") == "Reading/Papers- 2017.resource")
  #expect(try v.tree().folder(at: "Reading")?.resources.map(\.id) == [r.id])
  // a change of case alone
  try v.rename(resource: try #require(try v.tree().folders[0].resources.first), to: "papers- 2017")
  #expect(try v.tree().folders[0].resources.map(\.title) == ["papers- 2017"])

  let bin = try scratch()
  let gone = try v.trash("Reading/papers- 2017.resource") { url in
    let to = bin.appending(path: url.lastPathComponent)
    try FileManager.default.moveItem(at: url, to: to)
    return to
  }
  #expect(gone?.lastPathComponent == "papers- 2017.resource")
  #expect(try v.tree().folder(at: "Reading")?.resources == [])
  // a folder is never named like a package
  #expect(Vault.folderName(for: "Notes.resource") == "Notes")
}

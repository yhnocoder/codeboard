import CodeBoardModel
import Foundation
import Testing

private func board(_ id: String, in package: URL) throws {
  try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
  try Board(id: BoardID(rawValue: id)).encoded().write(to: package.appending(path: Vault.boardFileName))
}

@Test func treeIsTheFolderTree() throws {
  let root = try scratch()
  try board("b1", in: root.appending(path: "Top.board"))
  try board("b2", in: root.appending(path: "Papers/Attention/Heads.board"))
  try board("b3", in: root.appending(path: "Papers/Attention 10.board"))
  try board("b4", in: root.appending(path: "Papers/Attention 9.board"))
  try board("hidden", in: root.appending(path: ".codeboard/x.board"))
  try FileManager.default.createDirectory(at: root.appending(path: "Empty"), withIntermediateDirectories: true)
  try Data().write(to: root.appending(path: "notes.txt"))
  let tree = try Vault(root: root).tree()
  #expect(tree.path == "")
  #expect(tree.boards == [VaultBoard(id: BoardID(rawValue: "b1"), title: "Top", path: "Top.board")])
  #expect(tree.folders.map(\.name) == ["Empty", "Papers"])
  let papers = tree.folders[1]
  #expect(papers.boards.map(\.title) == ["Attention 9", "Attention 10"], "in Finder's order")
  #expect(papers.folders.map(\.path) == ["Papers/Attention"])
  #expect(tree.allBoards.map(\.id.rawValue) == ["b1", "b4", "b3", "b2"])
  #expect(try Vault(root: root).board(at: "Papers/Attention/Heads.board").id == BoardID(rawValue: "b2"))
}

/// A board whose file cannot be read is listed as one that cannot be opened, with why; the rest of the tree reads as
/// ever (host sidebar.ts: "Can't open"). A folder's own board that cannot be read leaves the folder without one
@Test func aBoardThatCannotBeReadIsListedApartAndTheTreeStillReads() throws {
  let root = try scratch()
  try board("b1", in: root.appending(path: "Good.board"))
  let bad = root.appending(path: "Papers/Bad.board")
  try FileManager.default.createDirectory(at: bad, withIntermediateDirectories: true)
  try Data("{ not json".utf8).write(to: bad.appending(path: Vault.boardFileName))
  try FileManager.default.createDirectory(
    at: root.appending(path: "Papers/\(Vault.folderBoardName)"), withIntermediateDirectories: true)
  try board("b2", in: root.appending(path: "Papers/Fine.board"))
  let tree = try Vault(root: root).tree()
  #expect(tree.allBoards.map(\.id.rawValue) == ["b1", "b2"])
  let papers = try #require(tree.folders.first)
  #expect(papers.folderBoard == nil)
  #expect(papers.unreadable.map(\.title) == ["Bad"] && papers.unreadable.first?.path == "Papers/Bad.board")
  #expect(papers.unreadable.first?.reason.isEmpty == false)
}

@Test func boardsOfOtherVersionsAreListedAndRefusedWhenOpened() throws {
  let root = try scratch()
  var files: [URL] = []
  for (name, version) in [("A", 1), ("B", 4)] {
    let package = root.appending(path: "\(name).board")
    try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
    let file = package.appending(path: Vault.boardFileName)
    try Data(#"{"version": \#(version), "id": "\#(name)"}"#.utf8).write(to: file)
    files.append(file)
  }
  let vault = Vault(root: root)
  #expect(try vault.tree().allBoards.map(\.title) == ["A", "B"])
  #expect(throws: VaultError.olderFormat(files[0], 1)) { try vault.board(at: "A.board") }
  #expect(throws: VaultError.newerFormat(files[1], 4)) { try vault.board(at: "B.board") }
  #expect(VaultError.newerFormat(files[1], 4).description.contains("Update CodeBoard"))
}

@Test func sharedCardIDsCannotLeaveTheirFolder() throws {
  #expect(throws: VaultError.badSharedCardID("../x")) {
    try Vault(root: try scratch()).sharedCard(CardID(rawValue: "../x"))
  }
}

@Test func sharedCardFileNameIsItsID() throws {
  let vault = Vault(root: try scratch())
  try FileManager.default.createDirectory(at: vault.sharedFolderURL, withIntermediateDirectories: true)
  let file = vault.sharedFolderURL.appending(path: "a.json")
  try SharedCard(id: CardID(rawValue: "b"), content: CardContent(body: .note(Note(text: "x")))).encoded().write(
    to: file)
  #expect(throws: VaultError.malformed(file, "its id is b, not its file name")) {
    try vault.sharedCard(CardID(rawValue: "a"))
  }
}

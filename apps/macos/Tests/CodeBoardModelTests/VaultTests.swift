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

@Test func treeRefusesABoardOfAnotherVersion() throws {
  let root = try scratch()
  let package = root.appending(path: "A.board")
  try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
  let file = package.appending(path: Vault.boardFileName)
  try Data(#"{"version": 1, "id": "a"}"#.utf8).write(to: file)
  #expect(throws: VaultError.unsupportedVersion(file, 1)) { try Vault(root: root).tree() }
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

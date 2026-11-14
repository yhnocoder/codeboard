import CodeBoardModel
import CryptoKit
import Foundation
import Testing

@testable import CodeBoardShell

// Delete Board, Delete Folder and Delete Folder Board: to the trash, never removed outright, nothing else touched; only
// something in the vault. A stand-in for the system Trash (a folder of the test's own), and one that fails: the real
// Trash is never touched by a test.
@MainActor @Suite(.serialized) struct DeleteTests {
  let fm = FileManager.default

  struct Failure: Error {}

  /// A vault with a book (its folder board, two boards, a subfolder with one) and a top-level board, and a trash
  func vault() throws -> (Vault, URL, Shell) {
    let base = fm.temporaryDirectory.appending(path: "delete-\(UUID().uuidString)")
    let root = base.appending(path: "vault")
    let trash = base.appending(path: "Trash")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    try fm.createDirectory(at: trash, withIntermediateDirectories: true)
    let v = Vault(root: root)
    try v.newFolder(in: "", name: "书")
    try v.newFolderBoard(in: "书")
    try v.newBoard(in: "书", title: "Prefill 预填充")
    try v.newBoard(in: "书", title: "Decode")
    try v.newFolder(in: "书", name: "Kernels")
    try v.newBoard(in: "书/Kernels", title: "Flash")
    try v.newBoard(in: "", title: "Overview")
    let shell = Shell()
    shell.open(v, restoring: nil)
    shell.apply(.success(try v.tree()))
    shell.trasher = { url in
      let to = trash.appending(path: url.lastPathComponent)
      try FileManager.default.moveItem(at: url, to: to)
      return to
    }
    return (v, trash, shell)
  }

  /// Every file under a folder, by path, with a hash of its bytes
  func files(_ root: URL) -> [String: String] {
    var out: [String: String] = [:]
    let e = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey])
    while let u = e?.nextObject() as? URL {
      guard (try? u.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
      let d = (try? Data(contentsOf: u)) ?? Data()
      out[String(u.standardizedFileURL.path.dropFirst(root.standardizedFileURL.path.count))] =
        SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined()
    }
    return out
  }

  /// `before` without what was under `path`
  func without(_ before: [String: String], _ path: String) -> [String: String] {
    before.filter { !$0.key.hasPrefix("/" + path + "/") && $0.key != "/" + path }
  }

  @Test func aDeletedBoardGoesToTheTrashWholeAndNothingElseChanges() throws {
    let (v, trash, shell) = try vault()
    defer { try? fm.removeItem(at: v.root.deletingLastPathComponent()) }
    let board = try #require(try v.tree().folder(at: "书")?.boards.first { $0.title == "Decode" })
    let before = files(v.root)
    let inside = files(v.url(of: board.path))
    shell.show(board.id)
    #expect(shell.trash(board.path))
    #expect(!fm.fileExists(atPath: v.url(of: board.path).path))
    #expect(files(trash.appending(path: "Decode.board")) == inside, "in the trash as it was")
    #expect(files(v.root) == without(before, board.path))
    #expect(shell.board(board.id) == nil && shell.tabs.isEmpty, "its tab closes")
  }

  @Test func aDeletedFolderGoesToTheTrashWithAllInIt() throws {
    let (v, trash, shell) = try vault()
    defer { try? fm.removeItem(at: v.root.deletingLastPathComponent()) }
    let before = files(v.root)
    let inside = files(v.url(of: "书/Kernels"))
    shell.expanded = ["书", "书/Kernels"]
    #expect(shell.trash("书/Kernels"))
    #expect(files(trash.appending(path: "Kernels")) == inside)
    #expect(files(v.root) == without(before, "书/Kernels"))
    #expect(shell.expanded == ["书"])
  }

  @Test func deletingTheFolderBoardLeavesItsFolderAndBoardsAsTheyWere() throws {
    let (v, trash, shell) = try vault()
    defer { try? fm.removeItem(at: v.root.deletingLastPathComponent()) }
    let fb = try #require(try v.tree().folder(at: "书")?.folderBoard)
    let before = files(v.root)
    #expect(shell.trash(fb.path))
    #expect(fm.fileExists(atPath: trash.appending(path: Vault.folderBoardName).path))
    #expect(files(v.root) == without(before, fb.path))
    let folder = try #require(try v.tree().folder(at: "书"))
    #expect(folder.folderBoard == nil && folder.boards.count == 2 && folder.folders.map(\.name) == ["Kernels"])
  }

  @Test func onlySomethingInTheVaultIsDeletedAndATrashThatFailsChangesNothing() throws {
    let (v, trash, shell) = try vault()
    let base = v.root.deletingLastPathComponent()
    defer { try? fm.removeItem(at: base) }
    // a file beside the vault, which a path out of it would reach
    try Data("keep".utf8).write(to: base.appending(path: "outside.txt"))
    let before = files(base)
    for path in ["", "/", ".", "..", "../outside.txt", "书/../..", "/tmp", "Nothing.board"] {
      #expect(!shell.trash(path), "\(path)")
      #expect(shell.fileError != nil)
      #expect(throws: VaultError.self) { try v.trash(path, with: shell.trasher) }
    }
    #expect(files(base) == before)
    // the trash refuses: everything stays, and why is said
    shell.trasher = { _ in throw Failure() }
    #expect(!shell.trash("Overview.board"))
    #expect(shell.fileError?.contains("Overview.board") == true)
    #expect(files(base) == before)
    #expect(try fm.contentsOfDirectory(atPath: trash.path).isEmpty)
  }
}

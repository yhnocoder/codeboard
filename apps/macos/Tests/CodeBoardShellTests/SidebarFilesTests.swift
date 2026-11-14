import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardShell

// What the sidebar does to the vault's files, through the shell and the open boards: renames and moves that open tabs,
// expanded folders and folder boards follow, never writing over anything; and seals edited live, one undo step
@MainActor @Suite(.serialized) struct SidebarFilesTests {
  let fm = FileManager.default

  func vault() throws -> (Vault, Shell, BoardPanes) {
    let root = fm.temporaryDirectory.appending(path: "sidebar-\(UUID().uuidString)")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    let shell = Shell()
    shell.open(vault, restoring: nil)
    return (vault, shell, BoardPanes(shell: shell))
  }

  @Test func aRenamedFolderKeepsItsStateItsTabsAndItsCardOnTheFolderBoardAbove() throws {
    let (vault, shell, panes) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    try vault.newFolder(in: "", name: "书")
    try vault.newFolder(in: "书", name: "调度")
    let step = try vault.newBoard(in: "书/调度", title: "Step")
    let book = try vault.newFolderBoard(in: "书")
    shell.apply(.success(try vault.tree()))
    shell.expanded = ["书", "书/调度"]
    shell.show(book.id)
    shell.show(step.id, newTab: true)
    panes.sync()
    let doc = try #require(panes.documents[book.id])
    let card = try #require(doc.board.autoCards.first { $0.target == .folder("调度") }?.card)
    doc.edit("Move") { $0.move([.card(card.id)], dx: 700, dy: 40) }

    shell.rename(folder: "书/调度", to: "Kernels")
    #expect(shell.expanded == ["书", "书/Kernels"])
    #expect(shell.board(step.id)?.path == "书/Kernels/Step.board")
    #expect(shell.tabs.map(\.board) == [book.id, step.id], "both tabs stay")
    // the folder board above keeps the card where the user put it, now for the new name
    let moved = try #require(doc.board.autoCards.first { $0.card.id == card.id })
    #expect(moved.target == .folder("Kernels"))
    #expect(moved.card.x == card.x + 700 && moved.card.y == card.y + 40)
    #expect(doc.board.autoCards.count == 1)

    // the book renamed: its folder board's title is the folder's name, and it is written where it now is
    shell.rename(folder: "书", to: "卷")
    #expect(shell.board(book.id)?.title == "卷" && shell.board(book.id)?.path == "卷/.folder.board")
    #expect(shell.expanded == ["卷", "卷/Kernels"])
    doc.edit("Move") { $0.move([.card(card.id)], dx: 10, dy: 0) }
    panes.flush()
    #expect(try vault.board(at: "卷/.folder.board").card(card.id)?.x == card.x + 710)

    // a name taken: nothing changes, nothing is written over
    try vault.newFolder(in: "卷", name: "Other")
    shell.apply(.success(try vault.tree()))
    shell.rename(folder: "卷/Other", to: "Kernels")
    #expect(try vault.tree().folder(at: "卷")?.folders.map(\.name).sorted() == ["Kernels", "Other"])
    #expect(try vault.tree().folder(at: "卷/Kernels")?.boards.map(\.id) == [step.id])
  }

  @Test func aBoardLetGoOnAnOpenFolderBoardGoesIntoItsFolderWithItsCardWhereItWasLetGo() throws {
    let (vault, shell, panes) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    try vault.newFolder(in: "", name: "Engine")
    let fb = try vault.newFolderBoard(in: "Engine")
    let loose = try vault.newBoard(in: "", title: "预填充")
    let taken = try vault.newBoard(in: "", title: "Same")
    let there = try vault.newBoard(in: "Engine", title: "Same")
    shell.apply(.success(try vault.tree()))
    shell.show(fb.id)
    panes.sync()
    let doc = try #require(panes.documents[fb.id])

    panes.vaultDrop(loose.path, at: CGPoint(x: 1000, y: 800), on: fb.id)
    #expect(shell.board(loose.id)?.path == "Engine/预填充.board")
    let card = try #require(doc.board.autoCards.first { $0.target == .board(loose.id) }?.card)
    #expect(card.x + card.width / 2 == 1000 && card.y + (card.height ?? 0) / 2 == 800)
    #expect(doc.history.undoSteps.isEmpty)

    // one of the same name is there already: it stays where it was, and so does its card
    panes.vaultDrop(taken.path, at: CGPoint(x: 0, y: 0), on: fb.id)
    #expect(shell.board(taken.id)?.path == "Same.board" && shell.board(there.id)?.path == "Engine/Same.board")
    #expect(Set(doc.board.autoCards.map(\.target)) == [.board(there.id), .board(loose.id)])

    // moved out again from the sidebar: its card goes
    #expect(shell.move("Engine/预填充.board", into: "") == "预填充.board")
    #expect(doc.board.autoCards.map(\.target) == [.board(there.id)])
  }

  @Test func aSealChangedWhileEditingIsShownAtOnceAndIsOneUndoStepAndEscPutsItBack() throws {
    let (vault, shell, panes) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    try vault.newFolder(in: "", name: "书")
    let book = try vault.newFolderBoard(in: "书")
    let a = try vault.newBoard(in: "书", title: "Prefill Plan")
    let b = try vault.newBoard(in: "书", title: "解码")
    let top = try vault.newBoard(in: "", title: "Loose")
    shell.apply(.success(try vault.tree()))
    shell.show(a.id)
    panes.sync()
    let doc = try #require(panes.documents[a.id])
    #expect(shell.board(a.id)?.drawnSeal.text == "PP")

    // each change is in the tree and the file at once, no step yet
    panes.setSeal(a.id, Seal(text: "P"), done: false)
    #expect(shell.board(a.id)?.seal == Seal(text: "P"))
    #expect(try vault.board(at: a.path).seal == Seal(text: "P"))
    panes.setSeal(a.id, Seal(text: "PX", color: .teal), done: false)
    #expect(doc.history.undoSteps.isEmpty)
    panes.setSeal(a.id, Seal(text: "PX", color: .teal), done: true)
    #expect(doc.history.undoSteps.map(\.name) == ["Edit Mark"])
    #expect(try vault.board(at: a.path).seal == Seal(text: "PX", color: .teal))
    doc.undo()
    #expect(doc.board.seal == nil)
    doc.redo()

    // Esc: back to what it was, no step
    panes.setSeal(a.id, Seal(text: "Q"), done: false)
    panes.setSeal(a.id, Seal(text: "PX", color: .teal), done: true)
    #expect(doc.history.undoSteps.map(\.name) == ["Edit Mark"])
    #expect(try vault.board(at: a.path).seal == Seal(text: "PX", color: .teal))

    // a board that is not open is written too
    panes.setSeal(b.id, Seal(text: "PX", color: .teal), done: true)
    #expect(try vault.board(at: b.path).seal == Seal(text: "PX", color: .teal))
    // the same seal in the same book is named; in another book it is not
    let tree = try #require(shell.tree)
    #expect(tree.sealClash(b.id, "PX", .teal)?.id == a.id)
    #expect(tree.sealClash(top.id, "PX", .teal) == nil)
    #expect(tree.sealClash(book.id, "PX", .teal).map { [a.id, b.id].contains($0.id) } == true)
  }
}

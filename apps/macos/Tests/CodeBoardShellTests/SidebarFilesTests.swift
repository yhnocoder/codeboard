import AppKit
import CodeBoardModel
import CodeBoardReading
import Foundation
import TestGuard
import Testing

@testable import CodeBoardCanvas
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

  /// A board that cannot be read does not take the tree with it: it is listed with why, and its menu shows it in
  /// Finder, copies its file's path or deletes it. A board's menu has Reveal in Finder and Copy Path too
  /// (host commands.ts revealInFolder, copyBoardPath: the board file's path)
  @Test func aBoardThatCannotBeReadIsListedAndBoardsRevealAndCopyTheirPath() throws {
    let (vault, shell, _) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    let good = try vault.newBoard(in: "", title: "Good")
    let bad = vault.root.appending(path: "Bad.board")
    try fm.createDirectory(at: bad, withIntermediateDirectories: true)
    try Data("{ not json".utf8).write(to: bad.appending(path: Vault.boardFileName))
    let pb = NSPasteboard(name: NSPasteboard.Name("sidebar-\(UUID().uuidString)"))
    shell.pasteboard = pb
    shell.apply(Result { try vault.tree() })
    #expect(shell.treeError == nil && shell.tree?.boards.map(\.title) == ["Good"])
    let row = try #require(shell.tree?.unreadable.first)
    let menu = shell.menu(unreadable: row)
    #expect(menu.map { $0?.title ?? "-" } == ["Reveal in Finder", "Copy Path", "-", "Delete"])
    TestGuard.shown = []
    menu[0]?.run()
    #expect(TestGuard.shown == ["reveal: \(bad.path(percentEncoded: false))"], "\(TestGuard.shown)")
    menu[1]?.run()
    #expect(pb.string(forType: .string) == bad.appending(path: Vault.boardFileName).path(percentEncoded: false))
    let vb = try #require(shell.tree?.boards.first)
    let titles = shell.menu(board: vb).map { $0?.title ?? "-" }
    #expect(
      titles == [
        "Rename", "Edit Mark…", "Duplicate Board", "Move to", "-", "Reveal in Finder", "Copy Path", "-", "Delete",
      ], "\(titles)")
    shell.menu(board: vb)[6]?.run()
    #expect(
      pb.string(forType: .string)
        == vault.url(of: good.path).appending(path: Vault.boardFileName).path(percentEncoded: false))
  }

  /// Delete Folder says how many boards go to the Trash with it, those that cannot be read and those in its folders
  /// counted, one in the singular
  @Test func deleteFolderSaysHowManyBoardsGoWithIt() async throws {
    let (vault, shell, _) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    try vault.newFolder(in: "", name: "F")
    try vault.newFolder(in: "F", name: "G")
    _ = try vault.newBoard(in: "F", title: "One")
    _ = try vault.newBoard(in: "F/G", title: "Two")
    let bad = vault.root.appending(path: "F/Bad.board")
    try fm.createDirectory(at: bad, withIntermediateDirectories: true)
    try Data("{".utf8).write(to: bad.appending(path: Vault.boardFileName))
    try vault.newFolder(in: "", name: "H")
    _ = try vault.newBoard(in: "H", title: "Three")
    shell.apply(Result { try vault.tree() })
    var asked: [String] = []
    shell.confirm = { a in
      asked.append(a.informativeText)
      return false
    }
    for name in ["F", "H"] {
      let f = try #require(shell.tree?.folders.first { $0.name == name })
      shell.menu(folder: f).compactMap { $0 }.first { $0.title == "Delete Folder" }?.run()
    }
    while asked.count < 2 { try await Task.sleep(for: .milliseconds(5)) }
    #expect(asked == ["Its 3 boards go to the Trash with it.", "Its 1 board goes to the Trash with it."])
  }

  /// Duplicate Board (host boards.ts duplicate): a copy beside it named "… copy", a board of its own (new id), its own
  /// cards new ids with their arrows following, shared cards the same cards, its pictures copied; not opened. Move to:
  /// the top level and every other folder; chosen, the board goes there
  @Test func duplicateBoardCopiesItBesideItAndMoveToTakesItToAFolder() throws {
    let (vault, shell, _) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    try vault.newFolder(in: "", name: "A")
    try vault.newFolder(in: "A", name: "B")
    let note = { (id: String) in
      Card(id: CardID(rawValue: id), x: 0, y: 0, width: 200, content: .own(CardContent(body: .note(Note(text: id)))))
    }
    let orig = try vault.newBoard(
      in: "A", title: "Plan",
      board: Board(
        id: BoardID(rawValue: "plan"), cards: [note("n1"), note("n2")],
        arrows: [
          Arrow(
            id: ArrowID(rawValue: "a1"), from: Endpoint(card: CardID(rawValue: "n1")),
            to: Endpoint(card: CardID(rawValue: "n2")))
        ]))
    let images = vault.url(of: orig.path).appending(path: "images")
    try fm.createDirectory(at: images, withIntermediateDirectories: true)
    try Data("png".utf8).write(to: images.appending(path: "p.png"))
    shell.apply(Result { try vault.tree() })
    let vb = try #require(shell.tree?.allBoards.first { $0.id == orig.id })
    shell.menu(board: vb).compactMap { $0 }.first { $0.title == "Duplicate Board" }?.run()
    let a = try #require(shell.tree?.folders.first { $0.name == "A" })
    #expect(a.boards.map(\.title) == ["Plan", "Plan copy"], "by their names, as Finder lists them")
    let copy = try #require(a.boards.first { $0.title == "Plan copy" })
    #expect(copy.id != orig.id && shell.current?.board != copy.id)
    let b = try vault.board(at: copy.path)
    #expect(b.cards.count == 2 && Set(b.cards.map(\.id.rawValue)).isDisjoint(with: ["n1", "n2"]))
    #expect(b.arrows.first.map { [$0.from.card, $0.to.card] } == b.cards.map(\.id))
    #expect(fm.fileExists(atPath: vault.url(of: copy.path).appending(path: "images/p.png").path(percentEncoded: false)))
    // Move to: everywhere but where it is
    let targets = shell.moveTargets(board: copy)
    #expect(targets.map(\.title) == ["Top Level", "A › B"])
    targets[1].run()
    #expect(shell.tree?.folders.first { $0.name == "A" }?.folders.first?.boards.map(\.title) == ["Plan copy"])
  }

  /// A resource package as the format writes it, with a folder entry and a file alone in it
  func resource(_ vault: Vault, _ path: String, id: String) throws {
    let pkg = vault.url(of: path)
    try fm.createDirectory(at: pkg.appending(path: "Attention Is All You Need"), withIntermediateDirectories: true)
    try Data(#"{"fields": [], "id": "\#(id)", "preset": "papers", "version": 1}"#.utf8)
      .write(to: pkg.appending(path: Vault.resourceFileName))
    try Data("{}".utf8).write(to: pkg.appending(path: "Attention Is All You Need/\(Vault.entryFileName)"))
    try Data("%PDF".utf8).write(to: pkg.appending(path: "notes.pdf"))
  }

  /// Resources are listed after a folder's boards with how many entries each has, and one that cannot be read apart;
  /// their menu renames, moves, reveals, copies the path of and deletes them as a board's does
  @Test func resourcesAreListedWithTheirEntriesAndRenamedMovedAndDeletedAsBoardsAre() async throws {
    let (vault, shell, _) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    try vault.newBoard(in: "", title: "Engine")
    try vault.newFolder(in: "", name: "Reading")
    try resource(vault, "Papers.resource", id: "r1")
    let broken = vault.root.appending(path: "Broken.resource")
    try fm.createDirectory(at: broken, withIntermediateDirectories: true)
    try Data("{".utf8).write(to: broken.appending(path: Vault.resourceFileName))
    let pb = NSPasteboard(name: NSPasteboard.Name("sidebar-\(UUID().uuidString)"))
    shell.pasteboard = pb
    let trash = vault.root.deletingLastPathComponent().appending(path: "trash-\(UUID().uuidString)")
    try fm.createDirectory(at: trash, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: trash) }
    shell.trasher = { url in
      let to = trash.appending(path: url.lastPathComponent)
      try FileManager.default.moveItem(at: url, to: to)
      return to
    }
    shell.apply(Result { try vault.tree() })
    #expect(shell.tree?.boards.map(\.title) == ["Engine"])
    #expect(shell.tree?.resources.map { "\($0.title): \($0.entryCount)" } == ["Papers: 2"])
    #expect(shell.tree?.unreadableResources.map(\.title) == ["Broken"])
    #expect(shell.tree?.folders.map(\.name) == ["Reading"])

    let r = try #require(shell.tree?.resources.first)
    let menu = shell.menu(resource: r)
    #expect(
      menu.map { $0?.title ?? "-" } == [
        "Add PDF…", "Add arXiv Paper…", "-", "Rename", "Move to", "-", "Reveal in Finder", "Copy Path", "-", "Delete",
      ])
    menu[7]?.run()
    #expect(
      pb.string(forType: .string)
        == vault.url(of: r.path).appending(path: Vault.resourceFileName).path(percentEncoded: false))
    let bad = try #require(shell.tree?.unreadableResources.first)
    shell.menu(unreadable: bad)[1]?.run()
    #expect(pb.string(forType: .string) == broken.appending(path: Vault.resourceFileName).path(percentEncoded: false))

    // renamed in place
    menu[3]?.run()
    #expect(shell.renaming == .resource(r.id))
    shell.renaming = nil
    shell.rename(resource: r, to: "Papers 2017")
    let renamed = try #require(shell.tree?.resources.first { $0.id == r.id })
    #expect(renamed.path == "Papers 2017.resource" && renamed.entryCount == 2)
    // Move to: every folder but where it is
    let targets = shell.moveTargets(resource: renamed)
    #expect(targets.map(\.title) == ["Reading"])
    targets[0].run()
    #expect(shell.tree?.folder(at: "Reading")?.resources.map(\.id) == [r.id])

    // deleted: asked first, saying how many entries go with it, then to the trash whole
    var asked: [String] = []
    shell.confirm = { a in
      asked.append("\(a.messageText) \(a.informativeText)")
      return true
    }
    let moved = try #require(shell.tree?.folder(at: "Reading")?.resources.first)
    shell.menu(resource: moved).compactMap { $0 }.first { $0.title == "Delete" }?.run()
    while shell.tree?.folder(at: "Reading")?.resources.isEmpty == false { try await Task.sleep(for: .milliseconds(5)) }
    #expect(asked == ["Delete resource “Papers 2017”? Its 2 entries go to the Trash with it."])
    #expect(fm.fileExists(atPath: trash.appending(path: "Papers 2017.resource/notes.pdf").path(percentEncoded: false)))
    #expect(shell.tree?.boards.map(\.title) == ["Engine"])
  }

  /// A click on a resource's row opens its tab in the reading pane, a second goes to the same tab; renamed, the tab
  /// takes the new name; gone from the vault, it closes
  @Test func aResourcesRowOpensItsTabOnceAndTheTabFollowsTheResource() throws {
    let (vault, shell, _) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    try resource(vault, "Papers.resource", id: "r1")
    try resource(vault, "Notes.resource", id: "r2")
    shell.apply(Result { try vault.tree() })
    let papers = try #require(shell.tree?.resources.first { $0.title == "Papers" })
    let notes = try #require(shell.tree?.resources.first { $0.title == "Notes" })
    #expect(!shell.reading.shown)
    shell.openResource(papers)
    #expect(shell.reading.shown && shell.reading.tabs.map(\.title) == ["Papers"])
    #expect(shell.reading.tabs[0].kind == "list" && shell.reading.tabs[0].payload == ["resource": "r1"])
    shell.openResource(notes)
    shell.openResource(papers)
    #expect(shell.reading.tabs.map(\.title) == ["Papers", "Notes"])
    #expect(shell.reading.selected == shell.reading.tabs[0].id, "the same tab")
    shell.rename(resource: papers, to: "Papers 2017")
    #expect(shell.reading.tabs.map(\.title) == ["Papers 2017", "Notes"])
    try fm.removeItem(at: vault.url(of: notes.path))
    shell.apply(Result { try vault.tree() })
    #expect(shell.reading.tabs.map(\.title) == ["Papers 2017"] && shell.reading.shown)
  }

  /// A resource's tab hears every read of the tree through its kind's follow, keeping the resource's name
  @Test func aResourcesTabsKindFollowsEveryTreeRead() throws {
    let (vault, shell, _) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    try resource(vault, "Papers.resource", id: "r1")
    var heard: [String] = []
    ReadingKinds.register(
      "test-resource-follow",
      follow: { tab, _ in
        heard.append(tab.title)
        return "not this"
      }, make: { _ in NSView() })
    shell.reading.open("Papers", key: "resource:r1", kind: "test-resource-follow")
    shell.apply(Result { try vault.tree() })
    shell.apply(Result { try vault.tree() })
    #expect(heard == ["Papers", "Papers"] && shell.reading.tabs.map(\.title) == ["Papers"])
  }

  /// New Resource, beside New Board and New Folder: a package with its resource file and no entries, its row with 0,
  /// its tab open and its name written in place; Delete Folder says the resources that go with the folder
  @Test func newResourceMakesAnEmptyPackageWhoseNameIsWrittenAtOnce() async throws {
    let (vault, shell, _) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    try vault.newFolder(in: "", name: "Reading")
    shell.apply(Result { try vault.tree() })
    let folder = try #require(shell.tree?.folder(at: "Reading"))
    let menu = shell.menu(folder: folder)
    #expect(menu.prefix(4).map { $0?.title ?? "-" } == ["New Board", "New Folder", "New Resource", "-"])
    menu[2]?.run()
    let made = try #require(shell.tree?.folder(at: "Reading")?.resources.first)
    #expect(made.title == "New Resource" && made.path == "Reading/New Resource.resource" && made.entryCount == 0)
    #expect(made.preset == .files)
    #expect(fm.fileExists(atPath: vault.url(of: made.path).appending(path: Vault.resourceFileName).path))
    #expect(shell.renaming == .resource(made.id) && shell.expanded.contains("Reading"))
    #expect(shell.reading.tabs.map(\.title) == ["New Resource"])
    shell.newResource(in: "")
    #expect(shell.tree?.resources.map(\.title) == ["New Resource"], "at the top, a name of its own")
    shell.newResource(in: "Reading")
    #expect(shell.tree?.folder(at: "Reading")?.resources.map(\.title).sorted() == ["New Resource", "New Resource 2"])

    try vault.newBoard(in: "Reading", title: "Plan")
    shell.apply(Result { try vault.tree() })
    var asked: [String] = []
    shell.confirm = { a in
      asked.append(a.informativeText)
      return false
    }
    shell.menu(folder: try #require(shell.tree?.folder(at: "Reading"))).compactMap { $0 }
      .first { $0.title == "Delete Folder" }?.run()
    while asked.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
    #expect(asked == ["Its 1 board and 2 resources go to the Trash with it."])
    #expect(
      BoardPanes.deleteFolderQuestion("F", boards: 0, resources: 1).informativeText
        == "Its 1 resource goes to the Trash with it.")
  }
}

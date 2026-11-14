import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// Questions the app asks, as a person meets them in the whole window: a sheet on the window (window.attachedSheet), the
// other windows not held, its buttons pressed as they are. The Trash is a folder of the test's.

/// A view that counts the presses the window gives it
@MainActor final class Presses: NSView {
  var count = 0
  override func mouseDown(with e: NSEvent) { count += 1 }
  // the test process is never the active app: its windows are never key and would keep a first press for themselves
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor @Suite(.serialized) struct FullWindowSheetTests {
  @MainActor final class Setup {
    let base: URL
    let vault: Vault
    let child: VaultBoard
    let parent: VaultBoard
    let w: FullWindowEditTests.Window
    let other: NSWindow
    let presses = Presses()

    init() throws {
      let fm = FileManager.default
      base = fm.temporaryDirectory.appending(path: "sheets-\(UUID().uuidString)")
      let root = base.appending(path: "vault")
      try fm.createDirectory(at: root, withIntermediateDirectories: true)
      try fm.createDirectory(at: base.appending(path: "Trash"), withIntermediateDirectories: true)
      vault = Vault(root: root)
      parent = try vault.newBoard(in: "", title: "Parent")
      child = try vault.newBoard(in: "", title: "Child")
      var c = try vault.board(at: child.path)
      c.cards = ["a", "b"].map {
        Card(id: CardID(rawValue: $0), x: 0, y: 0, width: 200, content: .own(CardContent(body: .note(Note(text: $0)))))
      }
      try c.encoded().write(to: vault.url(of: child.path).appending(path: Vault.boardFileName))
      var p = try vault.board(at: parent.path)
      p.cards = [
        Card(
          id: CardID(rawValue: "sub"), x: 0, y: 0, width: 300, height: 200,
          content: .own(CardContent(body: .board(SubBoard(board: child.id)))))
      ]
      try p.encoded().write(to: vault.url(of: parent.path).appending(path: Vault.boardFileName))
      w = FullWindowEditTests.Window(vault, board: parent.id)
      let trash = base.appending(path: "Trash")
      w.shell.trasher = { url in
        let to = trash.appending(path: url.lastPathComponent)
        try FileManager.default.moveItem(at: url, to: to)
        return to
      }
      other = NSWindow(
        contentRect: CGRect(x: 0, y: 0, width: 200, height: 120), styleMask: [.titled], backing: .buffered, defer: false
      )
      other.isReleasedWhenClosed = false
      other.level = .underDesktop
      presses.frame = CGRect(x: 0, y: 0, width: 200, height: 120)
      other.contentView = presses
      other.orderFrontRegardless()
    }

    func close() {
      w.window.attachedSheet.map { w.window.endSheet($0) }
      other.orderOut(nil)
      w.close()
      try? FileManager.default.removeItem(at: base)
    }

    /// A press in the other window, as the window server would hand it over
    func pressOther() {
      for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
        other.sendEvent(
          NSEvent.mouseEvent(
            with: type, location: CGPoint(x: 100, y: 60), modifierFlags: [], timestamp: 0,
            windowNumber: other.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!)
      }
    }
  }

  func button(_ title: String, in v: NSView) -> NSButton? {
    if let b = v as? NSButton, b.title == title { return b }
    for s in v.subviews { if let b = button(title, in: s) { return b } }
    return nil
  }

  func text(in v: NSView) -> [String] {
    (v as? NSTextField).map { [$0.stringValue] } ?? [] + v.subviews.flatMap { text(in: $0) }
  }

  /// Delete Board… on the sub-board card's menu: main's question as a sheet on the window, the other windows going on;
  /// Cancel keeps the board and the card, Delete sends the board to the Trash and takes the card off as one step; Return
  /// presses nothing (the sheet has no default button: what undo does not bring back takes a press on Delete) and Esc is
  /// Cancel's
  @Test(arguments: ["Cancel", "Delete", "Return"]) func deleteBoardAsksInASheetOnTheWindow(_ answer: String)
    async throws
  {
    let s = try Setup()
    defer { s.close() }
    let w = s.w
    await FullWindowEditTests().until("the board shown", in: w) { w.pane?.scene != nil }
    let c = w.canvas
    let r = try #require(c.scene?.items.first { $0.owner == .card(CardID(rawValue: "sub")) }?.rect)
    let e = NSEvent.mouseEvent(
      with: .rightMouseDown, location: w.at(CGPoint(x: r.midX, y: r.maxY - 12)), modifierFlags: [], timestamp: 0,
      windowNumber: w.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    let item = try #require(c.menu(for: e)?.items.first { $0.title == "Delete Board…" })
    try #require(item.representedObject as? MenuAction).run()
    await FullWindowEditTests().until("the question up", in: w) { w.window.attachedSheet != nil }
    let sheet = try #require(w.window.attachedSheet)
    let content = try #require(sheet.contentView)
    #expect(text(in: content).contains("Delete board “Child”?"), "\(text(in: content))")
    #expect(text(in: content).contains("2 cards and their links will be removed. Your code is not affected."))
    #expect(NSApp.modalWindow == nil, "not the whole app's: \(String(describing: NSApp.modalWindow))")
    s.pressOther()
    #expect(s.presses.count == 1, "the other window takes its press")
    if answer == "Return" {
      // Return goes to the key window's default button: there is none
      #expect(sheet.defaultButtonCell == nil, "\(String(describing: sheet.defaultButtonCell?.title))")
      #expect(button("Delete", in: content)?.hasDestructiveAction == true)
      let cancel = try #require(button("Cancel", in: content))
      #expect(cancel.keyEquivalent == "\u{1b}")
      cancel.performClick(nil)
    } else {
      try #require(button(answer, in: content)).performClick(nil)
    }
    await FullWindowEditTests().until("the question gone", in: w) { w.window.attachedSheet == nil }
    let fm = FileManager.default
    if answer != "Delete" {
      #expect(
        fm.fileExists(atPath: s.vault.url(of: s.child.path).path)
          && c.document?.board.card(CardID(rawValue: "sub")) != nil)
    } else {
      await FullWindowEditTests().until("the card gone", in: w) {
        c.document?.board.card(CardID(rawValue: "sub")) == nil
      }
      let there = fm.fileExists(atPath: s.vault.url(of: s.child.path).path)
      #expect(!there && fm.fileExists(atPath: s.base.appending(path: "Trash/Child.board").path))
      #expect(c.document?.undoName == "Delete Board")
    }
  }

  /// Quitting with changes that could not be written: the question is a sheet on the window, not the whole app's;
  /// Cancel keeps the app, Quit Anyway quits
  @Test(arguments: ["Cancel", "Quit Anyway"]) func quittingWithUnsavedChangesAsksInASheet(_ answer: String) async throws
  {
    let s = try Setup()
    defer { s.close() }
    let w = s.w
    var quit: Bool?
    AppDelegate.askToQuit([(title: "Parent", why: "the disk is full")], on: w.window) { quit = $0 }
    let sheet = try #require(w.window.attachedSheet, "a sheet on the window")
    let content = try #require(sheet.contentView)
    #expect(text(in: content).contains("Changes to “Parent” could not be saved"), "\(text(in: content))")
    #expect(text(in: content).contains("Parent: the disk is full"))
    #expect(NSApp.modalWindow == nil, "not the whole app's: \(String(describing: NSApp.modalWindow))")
    s.pressOther()
    #expect(s.presses.count == 1, "the other window takes its press")
    #expect(quit == nil, "nothing answered yet")
    try #require(button(answer, in: content)).performClick(nil)
    await FullWindowEditTests().until("answered", in: w) { quit != nil }
    #expect(quit == (answer == "Quit Anyway") && w.window.attachedSheet == nil)
  }

  /// A folder board's automatic card (FORMAT.md, board): main's sub-board card menu but Remove from This Board (it
  /// follows its folder); Delete Board… asks, then the board goes to the Trash and its card with it
  @Test func aFolderBoardsCardHasMainsMenuButRemoveAndDeleteBoardTakesItsBoard() async throws {
    let fm = FileManager.default
    let base = fm.temporaryDirectory.appending(path: "auto-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: base) }
    let root = base.appending(path: "vault")
    let trash = base.appending(path: "Trash")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    try fm.createDirectory(at: trash, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    let folder = try vault.newFolder(in: "", name: "F")
    let fb = try vault.newFolderBoard(in: folder)
    let child = try vault.newBoard(in: folder, title: "Child")
    let w = FullWindowEditTests.Window(vault, board: fb.id)
    defer { w.close() }
    w.shell.trasher = { url in
      let to = trash.appending(path: url.lastPathComponent)
      try FileManager.default.moveItem(at: url, to: to)
      return to
    }
    await FullWindowEditTests().until("its card", in: w) {
      w.pane?.scene != nil && w.pane?.document?.board.autoCards.isEmpty == false
    }
    let c = w.canvas
    let card = try #require(c.document?.board.autoCards.first { $0.target == .board(child.id) }?.card.id)
    await FullWindowEditTests().until("drawn", in: w) { c.scene?.items.contains { $0.owner == .card(card) } == true }
    let r = try #require(c.scene?.items.first { $0.owner == .card(card) }?.rect)
    let e = NSEvent.mouseEvent(
      with: .rightMouseDown, location: w.at(CGPoint(x: r.midX, y: r.maxY - 12)), modifierFlags: [], timestamp: 0,
      windowNumber: w.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    let m = try #require(c.menu(for: e))
    #expect(
      m.items.map { $0.isSeparatorItem ? "-" : $0.title } == [
        "Add Sidenote", "-", "Open", "-", "Arrange", "Copy Path", "-", "Delete Board…",
      ])
    #expect(
      m.item(withTitle: "Open")?.keyEquivalent == "\r"
        && m.item(withTitle: "Open")?.keyEquivalentModifierMask == .command)
    try #require(m.item(withTitle: "Delete Board…")?.representedObject as? MenuAction).run()
    await FullWindowEditTests().until("the question up", in: w) { w.window.attachedSheet != nil }
    let content = try #require(w.window.attachedSheet?.contentView)
    #expect(text(in: content).contains("Delete board “Child”?"), "\(text(in: content))")
    try #require(button("Delete", in: content)).performClick(nil)
    await FullWindowEditTests().until("the card gone", in: w) { c.document?.board.card(card) == nil }
    #expect(
      !fm.fileExists(atPath: vault.url(of: child.path).path) && fm.fileExists(atPath: trash.path + "/Child.board"))
  }

  enum Row: String, CaseIterable {
    case board, folderBoard, folder
  }

  /// The sidebar's Delete, Delete Folder Board and Delete Folder ask first in a sheet on the window, as main's Delete
  /// Board and Delete Group do (host handlers.ts deleteBoardAsked, actions.ts deleteGroup): Cancel keeps it, the answer
  /// sends it to the Trash
  @Test(arguments: Row.allCases) func theSidebarsDeletesAskInASheet(_ row: Row) async throws {
    let fm = FileManager.default
    let base = fm.temporaryDirectory.appending(path: "sidebar-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: base) }
    let root = base.appending(path: "vault")
    let trash = base.appending(path: "Trash")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    try fm.createDirectory(at: trash, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    let folder = try vault.newFolder(in: "", name: "F")
    let fb = try vault.newFolderBoard(in: folder)
    let child = try vault.newBoard(in: folder, title: "Child")
    var b = try vault.board(at: child.path)
    b.cards = [
      Card(id: CardID(rawValue: "a"), x: 0, y: 0, width: 200, content: .own(CardContent(body: .note(Note(text: "a")))))
    ]
    try b.encoded().write(to: vault.url(of: child.path).appending(path: Vault.boardFileName))
    try vault.newBoard(in: "", title: "Other")
    let w = FullWindowEditTests.Window(vault, board: fb.id)
    defer { w.close() }
    w.shell.trasher = { url in
      let to = trash.appending(path: url.lastPathComponent)
      try FileManager.default.moveItem(at: url, to: to)
      return to
    }
    let tree = try #require(w.shell.tree)
    let f = try #require(tree.folder(at: folder))
    let (entries, title, path, words, yes): ([Shell.MenuEntry], String, String, [String], String) =
      switch row {
      case .board:
        (
          w.shell.menu(board: try #require(tree.allBoards.first { $0.id == child.id })), "Delete", child.path,
          ["Delete board “Child”?", "1 cards and their links will be removed. Your code is not affected."], "Delete"
        )
      case .folderBoard:
        (
          w.shell.menu(folder: f), "Delete Folder Board", fb.path,
          ["Delete board “F”?", "0 cards and their links will be removed. Your code is not affected."], "Delete"
        )
      case .folder:
        (
          w.shell.menu(folder: f), "Delete Folder", folder,
          ["Delete folder “F”?", "Its 2 boards go to the Trash with it."], "Delete Folder"
        )
      }
    let run = try #require(entries.compactMap { $0 }.first { $0.title == title }?.run)
    for answer in ["Cancel", yes] {
      run()
      await FullWindowEditTests().until("the question up", in: w) { w.window.attachedSheet != nil }
      let content = try #require(w.window.attachedSheet?.contentView)
      for t in words { #expect(text(in: content).contains(t), "\(t) in \(text(in: content))") }
      #expect(NSApp.modalWindow == nil)
      try #require(button(answer, in: content)).performClick(nil)
      await FullWindowEditTests().until("the question gone", in: w) { w.window.attachedSheet == nil }
      if answer == "Cancel" {
        #expect(fm.fileExists(atPath: vault.url(of: path).path), "Cancel keeps it")
      } else {
        await FullWindowEditTests().until("in the Trash", in: w) { !fm.fileExists(atPath: vault.url(of: path).path) }
      }
    }
    #expect(fm.fileExists(atPath: vault.url(of: "Other.board").path), "nothing else")
  }
}

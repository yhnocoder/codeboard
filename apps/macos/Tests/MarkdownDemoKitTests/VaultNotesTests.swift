import AppKit
import CodeBoardMarkdown
import CodeBoardModel
import Foundation
import Testing

@testable import MarkdownDemoKit

/// The demo's Open Vault on a vault made here: a board's Note cards in reading order, shared ones from the shared folder
@MainActor @Suite struct VaultNotesTests {
  func vault() throws -> Vault {
    let root = FileManager.default.temporaryDirectory.appending(path: "demo-vault-\(UUID().uuidString)")
    let v = Vault(root: root)
    func note(_ text: String, _ style: NoteStyle = .note, layout: NoteLayout? = nil) -> CardContent {
      CardContent(body: .note(Note(text: text, style: style, layout: layout)))
    }
    let board = Board(
      id: BoardID(rawValue: "b1"),
      cards: [
        Card(id: CardID(rawValue: "low"), x: 0, y: 300, width: 300, content: .own(note("Lower"))),
        Card(
          id: CardID(rawValue: "label"), x: 0, y: 0, width: 300,
          content: .own(note("A label", .text(size: .body, bold: false)))),
        Card(
          id: CardID(rawValue: "pic"), x: 0, y: 10, width: 300,
          content: .own(CardContent(body: .image(ImageCard(source: .file("a.png")))))),
        Card(id: CardID(rawValue: "right"), x: 400, y: 20, width: 300, content: .own(note("Right"))),
        Card(
          id: CardID(rawValue: "top"), x: 0, y: 20, width: 300,
          content: .own(
            note("| a |\n|---|\n| 1 |", layout: NoteLayout(tables: [NoteLayout.Table(cols: [120])], wrap: [0])))),
        Card(id: CardID(rawValue: "sh"), x: 0, y: 100, width: 300, content: .shared),
        Card(id: CardID(rawValue: "gone"), x: 0, y: 200, width: 300, content: .shared),
      ])
    let package = v.url(of: "Topic/Step.board")
    try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
    try board.encoded().write(to: package.appending(path: Vault.boardFileName))
    try FileManager.default.createDirectory(at: v.sharedFolderURL, withIntermediateDirectories: true)
    try SharedCard(id: CardID(rawValue: "sh"), content: note("Shared")).encoded().write(
      to: v.sharedFolderURL.appending(path: "sh.json"))
    return v
  }

  @Test func aBoardsNotesInReadingOrder() throws {
    let v = try vault()
    defer { try? FileManager.default.removeItem(at: v.root) }
    #expect(try v.tree().allBoards.map(\.path) == ["Topic/Step.board"])
    let (notes, skipped) = try VaultNotes.notes(of: "Topic/Step.board", in: v)
    #expect(notes.map(\.id) == ["label", "top", "right", "sh", "low"])
    #expect(notes[0].style == .text(size: 20, wrap: true), "\(notes[0].style)")
    #expect(notes[1].style == .note, "\(notes[1].style)")
    let rest = Array(notes.dropFirst())
    #expect(rest[0].info == MDLayoutInfo(tables: [MDLayoutInfo.Table(cols: [120])], wrap: [0]))
    #expect(rest[0].folder == v.url(of: "Topic/Step.board"))
    #expect(rest[2].text == "Shared" && rest[2].folder == v.sharedFolderURL)
    #expect(skipped.count == 1 && skipped[0].hasPrefix("gone"))
  }

  @Test func theDemoStacksABoardsNotes() throws {
    let v = try vault()
    defer { try? FileManager.default.removeItem(at: v.root) }
    _ = NSApplication.shared
    let demo = try Demo(text: "# A file", folder: FileManager.default.temporaryDirectory, cardWidth: 420)
    demo.setUp()
    // a board package opens in its vault (the folder holding the app's data)
    #expect(demo.open(any: v.url(of: "Topic/Step.board")))
    #expect(demo.vault?.root.standardizedFileURL == v.root.standardizedFileURL && demo.boardPath == "Topic/Step.board")
    #expect(demo.window.title.hasSuffix("not saved"))
    #expect(demo.cards.map(\.source) == ["A label", "| a |\n|---|\n| 1 |", "Right", "Shared", "Lower"])
    // one column, top to bottom, the table's width from the Note's layout info
    let rects = demo.page.cardRects
    #expect(rects.count == 5 && zip(rects, rects.dropFirst()).allSatisfy { $0.maxY < $1.minY && $0.minX == $1.minX })
    #expect(demo.cards[1].core.layout.info == MDLayoutInfo(tables: [MDLayoutInfo.Table(cols: [120])], wrap: [0]))
    // the board menu lists the board under its folder
    #expect(demo.boardMenu.items.first?.submenu?.items.first?.representedObject as? String == "Topic/Step.board")
    DemoWindowTests.kept.append(demo)
  }
}

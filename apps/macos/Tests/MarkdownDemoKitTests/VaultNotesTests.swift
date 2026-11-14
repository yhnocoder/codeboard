import CodeBoardMarkdown
import CodeBoardModel
import Foundation
import Testing

@testable import MarkdownDemoKit

/// The demo's Open Vault on a vault made here: a board's Note cards in reading order, shared ones from the shared folder
@Suite struct VaultNotesTests {
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
    #expect(notes.map(\.id) == ["top", "right", "sh", "low"])
    #expect(notes[0].info == MDLayoutInfo(tables: [MDLayoutInfo.Table(cols: [120])], wrap: [0]))
    #expect(notes[0].folder == v.url(of: "Topic/Step.board"))
    #expect(notes[2].text == "Shared" && notes[2].folder == v.sharedFolderURL)
    #expect(skipped.count == 1 && skipped[0].hasPrefix("gone"))
  }
}

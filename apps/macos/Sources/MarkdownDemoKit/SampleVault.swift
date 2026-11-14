import AppKit
import CodeBoardModel
import Foundation

/// `MarkdownDemo --make-sample-vault <folder>`: a made-up vault to try boards on (and the smoke run's): one board with a
/// Text title, the demo's sample Note with its picture, a Box, a second Note and a long Note, and a board in a folder
enum SampleVault {
  /// a small made-up SVG, as an exported diagram would be
  static let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">
    <rect x="4" y="4" width="232" height="112" rx="12" fill="#e8d5b5" stroke="#8a5a2b" stroke-width="3"/>
    <circle cx="60" cy="60" r="30" fill="#c0603a"/><text x="110" y="68" font-size="22" fill="#3a2a1a">step</text>
    </svg>
    """

  static func write(to root: URL) throws {
    let v = Vault(root: root)
    func card(_ id: String, _ y: Double, _ text: String, _ style: NoteStyle = .note, width: Double = 420) -> Card {
      Card(
        id: CardID(rawValue: id), x: 0, y: y, width: width,
        content: .own(CardContent(body: .note(Note(text: text, style: style)))))
    }
    let long = (1...120).map { "Paragraph \($0): the scheduler picks the sequences that fit and runs one step." }
      .joined(separator: "\n\n")
    let board = Board(
      id: BoardID(rawValue: "sample-step"),
      cards: [
        card("title", 0, "Engine step", .text(size: .title, bold: true), width: 420),
        card("sample", 80, sample.replacingOccurrences(of: "(picture.png", with: "(images/picture.png")),
        card("box", 1400, "A **box** with a note on it", .box(fill: .yellow), width: 300),
        card("svg", 1450, "A drawing:\n\n![a made-up diagram](images/diagram-240x120.svg)"),
        card("second", 1500, secondSample),
        card("long", 1800, "# A long Note\n\n" + long),
      ])
    let package = v.url(of: "Sample step.board")
    try FileManager.default.createDirectory(
      at: package.appending(path: Vault.imagesFolder), withIntermediateDirectories: true)
    try board.encoded().write(to: package.appending(path: Vault.boardFileName))
    try FileManager.default.copyItem(
      at: sampleFolder().appending(path: "picture.png"),
      to: package.appending(path: Vault.imagesFolder).appending(path: "picture.png"))
    try Data(svg.utf8).write(to: package.appending(path: Vault.imagesFolder).appending(path: "diagram-240x120.svg"))
    let other = Board(id: BoardID(rawValue: "sample-other"), cards: [card("only", 0, "## Another board\n\nOne Note.")])
    let folder = v.url(of: "Folder/Another.board")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try other.encoded().write(to: folder.appending(path: Vault.boardFileName))
    try FileManager.default.createDirectory(at: v.sharedFolderURL, withIntermediateDirectories: true)
  }
}

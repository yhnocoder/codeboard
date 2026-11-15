import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CodeBoardModel
import Foundation

/// A Note of a vault's board as the demo shows it: its Markdown, the folder its images resolve against (the package for
/// its own content, the shared folder for a shared card: FORMAT.md's one rule), and its layout info
struct VaultNote: Equatable {
  var id: String
  var title: String?
  var text: String
  var folder: URL
  var info: MDLayoutInfo?
  /// how it is set: a Note card, or a Text or Box at its size; how wide it is on the board; a Box's fill
  var style: MarkdownLooks.Style = .note
  var width: Double = 420
  var fill: NoteStyle.BoxFill?
}

/// Reading a vault for the demo, never writing it
enum VaultNotes {
  /// A Text's size in points for the format's three sizes (the web board's Text is 20 by default; the demo's choice for
  /// the larger two)
  static let textSizes: [NoteStyle.TextSize: Double] = [.title: 32, .heading: 24, .body: 20]

  /// The Markdown cards of the board in the package at `path` (Note, Text, Box), top to bottom (then left to right) as
  /// they sit on the board, stacked into one column. Mark and Free Text are handwriting and labels, left out as code and
  /// image cards are. A shared card that cannot be read is left out too, with why in `skipped`
  static func notes(of path: String, in vault: Vault) throws -> (notes: [VaultNote], skipped: [String]) {
    let board = try vault.board(at: path)
    let package = vault.url(of: path)
    var skipped: [String] = []
    let placed = board.cards.sorted { ($0.y, $0.x) < ($1.y, $1.x) }
    let notes = placed.compactMap { card -> VaultNote? in
      let content: CardContent
      let folder: URL
      switch card.content {
      case .own(let c):
        content = c
        folder = package
      case .shared:
        do {
          content = try vault.sharedCard(card.id).content
          folder = vault.sharedFolderURL
        } catch {
          skipped.append("\(card.id.rawValue): \(error)")
          return nil
        }
      }
      guard case .note(let note) = content.body else { return nil }
      let style: MarkdownLooks.Style
      var fill: NoteStyle.BoxFill?
      switch note.style {
      case .note: style = .note
      case .text(let size, _): style = .text(size: textSizes[size] ?? 20, wrap: true)
      case .box(let f):
        style = .box(size: 20, wrap: true)
        fill = f
      case .mark, .freeText: return nil
      }
      return VaultNote(
        id: card.id.rawValue, title: content.title, text: note.text, folder: folder,
        info: note.layout.map { l in
          MDLayoutInfo(
            tables: l.tables?.map { $0.map { MDLayoutInfo.Table(cols: $0.cols, rows: $0.rows) } }, wrap: l.wrap)
        }, style: style, width: card.width, fill: fill)
    }
    return (notes, skipped)
  }
}

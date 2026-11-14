import CodeBoardMarkdown
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
}

/// Reading a vault for the demo, never writing it
enum VaultNotes {
  /// The Note cards of the board in the package at `path`, top to bottom (then left to right) as they sit on the board,
  /// stacked into one column. Text, Box, Mark and Free Text are Notes drawn their own way, not Note cards: left out, as
  /// code and image cards are. A shared card that cannot be read is left out too, with why in `skipped`
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
      guard case .note(let note) = content.body, note.style == .note else { return nil }
      return VaultNote(
        id: card.id.rawValue, title: content.title, text: note.text, folder: folder,
        info: note.layout.map { l in
          MDLayoutInfo(
            tables: l.tables?.map { $0.map { MDLayoutInfo.Table(cols: $0.cols, rows: $0.rows) } }, wrap: l.wrap)
        })
    }
    return (notes, skipped)
  }
}

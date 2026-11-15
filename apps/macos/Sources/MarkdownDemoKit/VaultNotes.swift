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
  var fill: BoxFill?
}

/// Reading a vault for the demo, never writing it
enum VaultNotes {
  /// The Markdown cards of the board in the package at `path` (Note, Text, Box), top to bottom (then left to right) as
  /// they sit on the board, stacked into one column; code and image cards are left out. A shared card that cannot be read is left out too, with why in `skipped`
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
      let style: MarkdownLooks.Style
      let text: String
      let layout: NoteLayout?
      var fill: BoxFill?
      switch content.body {
      case .note(let n):
        (style, text, layout) = (.note, n.text, n.layout)
      case .text(let t):
        (text, layout) = (t.text, t.layout)
        switch t.look {
        case .text: style = .text(size: t.fontSize, wrap: t.wrap)
        case .box:
          style = .box(size: t.fontSize, wrap: t.wrap)
          fill = t.fill
        }
      default: return nil
      }
      return VaultNote(
        id: card.id.rawValue, title: content.title, text: text, folder: folder,
        info: layout.map { l in
          MDLayoutInfo(
            tables: l.tables?.map { $0.map { MDLayoutInfo.Table(cols: $0.cols, rows: $0.rows) } }, wrap: l.wrap)
        }, style: style, width: card.width, fill: fill)
    }
    return (notes, skipped)
  }
}

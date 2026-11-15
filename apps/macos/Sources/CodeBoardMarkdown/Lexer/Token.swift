import Foundation

/// A marked token, with the fields this package reads. A class because marked's lexer edits tokens it already made
/// (a paragraph swallows the line after it, a list item turns loose).
final class Token {
  /// marked's token type ("paragraph", "list", "strong", …) or the extension's ("blockMath", "taskList", "x_highlight", …)
  var type: String
  var raw: Mapped
  /// marked's text field: the content a block's inline tokens are read from, or an inline token's text
  var text: Mapped
  var tokens: [Token] = []
  /// how much longer marked's raw is than `raw` (TipTap's task list adds a \n the source does not have)
  var phantom = 0

  // blocks
  var depth = 0
  var lang: String?
  var codeIndented = false
  var ordered = false
  var start: Int?
  var loose = false
  var items: [Token] = []
  var task = false
  var checked: Bool?
  var header: [Token] = []
  var rows: [[Token]] = []
  var align: [String?] = []
  /// a block that inline tokens are read from (paragraph, text, heading, a cell, a task item's first line)
  var inline = false
  /// the text inline tokens are read from when it is not `text` (a loose task item's paragraph, whose text marked
  /// starts with the checkbox)
  var inlineText: Mapped?
  /// a task list item's nested blocks (TipTap's taskItem keeps them apart from its first line)
  var nested: [Token] = []
  var tag = ""

  // inline
  var href = ""
  var title: String?
  var latex = ""
  var display = false
  var name = ""
  var label = ""
  var target: String?
  var note = ""
  var color = "blue"
  var below = false
  var textEnd = 0
  var broken = false
  var imageAttrs: ImageAttributes?

  init(_ type: String, raw: Mapped, text: Mapped? = nil) {
    self.type = type
    self.raw = raw
    self.text = text ?? raw
  }
}

/// `{width=40% frame=3 loop=true}` after an image (imageattrs.ts)
struct ImageAttributes: Equatable, Sendable {
  var width: Double?
  var frame: Int?
  var loop = false
}

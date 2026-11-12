import CodeBoardModel
import Foundation

/// What the Note page draws (`web/src/page.ts`, type `Note`). Its JSON is both the page's argument and, in the snapshot
/// key, the description of everything the page draws: the look among it, so no picture or size is shared across looks.
struct PageNote: Encodable {
  var text: String
  var layout: NoteLayout?
  var style: NoteStyle
  var width: Double
  var height: Double?
  /// The board theme's id: the page applies the board's own stylesheet for it
  var look: String

  init(_ note: Note, width: Double, height: Double?, look: String) {
    text = note.text
    layout = note.layout
    style = note.style
    self.width = width
    self.height = height
    self.look = look
  }

  private enum Keys: String, CodingKey {
    case text, layout, style, width, height, look
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(text, forKey: .text)
    try c.encode(layout, forKey: .layout)
    try c.encode(PageStyle(style), forKey: .style)
    try c.encode(width, forKey: .width)
    try c.encode(height, forKey: .height)
    try c.encode(look, forKey: .look)
  }

  /// Sorted keys: the same Note always gives the same bytes
  func json() throws -> String {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try e.encode(self), as: UTF8.self)
  }
}

/// A style as board.json writes it: an object with one key naming the case
private struct PageStyle: Encodable {
  let style: NoteStyle
  init(_ style: NoteStyle) { self.style = style }

  private struct Key: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    var fields = c.nestedContainer(keyedBy: Key.self, forKey: Key(name))
    switch style {
    case .note:
      break
    case .text(let size, let bold):
      try fields.encode(size, forKey: Key("size"))
      try fields.encode(bold, forKey: Key("bold"))
    case .box(let fill):
      try fields.encode(fill, forKey: Key("fill"))
    case .mark(let color, let weight, let fontSize):
      try fields.encode(color, forKey: Key("color"))
      try fields.encode(weight, forKey: Key("weight"))
      try fields.encodeIfPresent(fontSize, forKey: Key("fontSize"))
    case .freeText(let level, let bold, let fontSize):
      try fields.encode(level, forKey: Key("level"))
      try fields.encode(bold, forKey: Key("bold"))
      try fields.encodeIfPresent(fontSize, forKey: Key("fontSize"))
    }
  }

  private var name: String {
    switch style {
    case .note: "note"
    case .text: "text"
    case .box: "box"
    case .mark: "mark"
    case .freeText: "freeText"
    }
  }
}

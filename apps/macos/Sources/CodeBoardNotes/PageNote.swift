import CodeBoardModel
import Foundation

/// What the Note page draws: a Note's Markdown, or a Text's or Box's
public enum NoteBody: Equatable, Sendable {
  case note(Note)
  case text(TextCard)

  public var markdown: String {
    switch self {
    case .note(let n): n.text
    case .text(let t): t.text
    }
  }

  public var layout: NoteLayout? {
    switch self {
    case .note(let n): n.layout
    case .text(let t): t.layout
    }
  }
}

/// What the Note page draws (`web/src/page.ts`, type `Note`). Its JSON is both the page's argument and, in the snapshot
/// key, the description of everything the page draws: the look and appearance among it, so no picture or size is
/// shared across looks or between light and dark.
struct PageNote: Encodable {
  var body: NoteBody
  var width: Double
  var height: Double?
  /// The board theme's id: the page applies the board's own stylesheet for it
  var look: String
  /// Its dark variant: the page sets html[data-theme="dark"] and draws in a dark appearance
  var dark: Bool
  /// What its [[refs]] point at, in the order written
  var refs: [NoteRef]
  /// A Note whose header shows its leading heading: the body does not show it again (CardContent.hidesHeading)
  var hideHead: Bool

  init(
    _ body: NoteBody, width: Double, height: Double?, look: String, dark: Bool, refs: [NoteRef], hideHead: Bool = false
  ) {
    self.body = body
    self.width = width
    self.height = height
    self.look = look
    self.dark = dark
    self.refs = refs
    self.hideHead = hideHead
  }

  private enum Keys: String, CodingKey {
    case text, layout, style, width, height, look, dark, refs
  }

  /// `style`: {"note": {}} or {"text": {look, fill, fontSize, wrap}}, as board.json writes a card's kind
  private struct Style: Encodable {
    let body: NoteBody
    let hideHead: Bool
    private enum Keys: String, CodingKey {
      case note, text
    }
    private enum TextKeys: String, CodingKey {
      case look, fill, fontSize, wrap, hideHead
    }

    func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: Keys.self)
      switch body {
      case .note:
        // only when set: the pictures of every other Note keep their keys
        var n = c.nestedContainer(keyedBy: TextKeys.self, forKey: .note)
        if hideHead { try n.encode(true, forKey: .hideHead) }
      case .text(let t):
        var f = c.nestedContainer(keyedBy: TextKeys.self, forKey: .text)
        try f.encode(t.look, forKey: .look)
        try f.encode(t.fill, forKey: .fill)
        try f.encode(t.fontSize, forKey: .fontSize)
        try f.encode(t.wrap, forKey: .wrap)
      }
    }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(body.markdown, forKey: .text)
    try c.encode(body.layout, forKey: .layout)
    try c.encode(Style(body: body, hideHead: hideHead), forKey: .style)
    try c.encode(width, forKey: .width)
    try c.encode(height, forKey: .height)
    try c.encode(look, forKey: .look)
    try c.encode(dark, forKey: .dark)
    try c.encode(refs, forKey: .refs)
  }

  /// Sorted keys: the same Note always gives the same bytes
  func json() throws -> String {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try e.encode(self), as: UTF8.self)
  }
}

/// A [[ref]] in a Note and what it points at now, as the web board resolves it: the canvas works it out from the board
/// and the vault, the page only draws it (the Markdown package's `refs.resolve`, `paintRef`). A ref the canvas found
/// nothing for is left out and drawn as not found.
public struct NoteRef: Equatable, Sendable, Encodable {
  public enum Hit: Equatable, Sendable {
    /// Its title now, after the seal of the board it is on when that is another board
    case found(title: String, seal: Seal?)
    /// That board has no such card (`place` false: greyed, struck through) or there is no board of that name (`place`
    /// true: the warning colour); `badge`: the board's name as written
    case broken(place: Bool, title: String, badge: String)
  }

  /// Another board's mark: a few letters on one of the board theme's seal colours (`--seal-<color>`); `alone`: the ref
  /// names that board itself, so only the seal is drawn
  public struct Seal: Equatable, Sendable {
    public var text: String
    public var color: String
    public var alone: Bool

    public init(text: String, color: String, alone: Bool) {
      self.text = text
      self.color = color
      self.alone = alone
    }
  }

  /// As written: the label and the id after `#^`
  public var label: String
  public var target: String?
  public var hit: Hit

  public init(label: String, target: String?, hit: Hit) {
    self.label = label
    self.target = target
    self.hit = hit
  }

  private struct Key: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
  }

  /// `{label, target, hit}`, hit as view.ts types it: RefTarget `{id, title, seal?}` or RefBroken `{broken, title, badge}`
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    try c.encode(label, forKey: Key("label"))
    try c.encode(target, forKey: Key("target"))
    var h = c.nestedContainer(keyedBy: Key.self, forKey: Key("hit"))
    switch hit {
    case .found(let title, let seal):
      try h.encode("", forKey: Key("id"))
      try h.encode(title, forKey: Key("title"))
      if let seal {
        var s = h.nestedContainer(keyedBy: Key.self, forKey: Key("seal"))
        try s.encode(seal.text, forKey: Key("text"))
        try s.encode("var(--seal-\(seal.color))", forKey: Key("color"))
        if seal.alone { try s.encode(true, forKey: Key("alone")) }
      }
    case .broken(let place, let title, let badge):
      try h.encode(place ? "place" : "item", forKey: Key("broken"))
      try h.encode(title, forKey: Key("title"))
      try h.encode(badge, forKey: Key("badge"))
    }
  }
}

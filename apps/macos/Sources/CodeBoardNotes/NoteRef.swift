import CoreGraphics

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
    /// The book it is in, when that is another book than the one the ref is written in: drawn as the first half
    public var outer: Outer?

    public struct Outer: Equatable, Sendable {
      public var text: String
      public var color: String

      public init(text: String, color: String) {
        self.text = text
        self.color = color
      }
    }

    public init(text: String, color: String, alone: Bool, outer: Outer? = nil) {
      self.text = text
      self.color = color
      self.alone = alone
      self.outer = outer
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

  /// `{label, target, hit}`
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    try c.encode(label, forKey: Key("label"))
    try c.encode(target, forKey: Key("target"))
    try c.encode(hit, forKey: Key("hit"))
  }
}

extension NoteRef.Hit: Encodable {
  private struct Key: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
  }

  /// As view.ts types it: RefTarget `{id, title, seal?}` or RefBroken `{broken, title, badge}`
  public func encode(to encoder: Encoder) throws {
    var h = encoder.container(keyedBy: Key.self)
    switch self {
    case .found(let title, let seal):
      try h.encode("", forKey: Key("id"))
      try h.encode(title, forKey: Key("title"))
      if let seal {
        var s = h.nestedContainer(keyedBy: Key.self, forKey: Key("seal"))
        try s.encode(seal.text, forKey: Key("text"))
        try s.encode("var(--seal-\(seal.color))", forKey: Key("color"))
        if seal.alone { try s.encode(true, forKey: Key("alone")) }
        if let o = seal.outer {
          var oc = s.nestedContainer(keyedBy: Key.self, forKey: Key("outer"))
          try oc.encode(o.text, forKey: Key("text"))
          try oc.encode("var(--seal-\(o.color))", forKey: Key("color"))
        }
      }
    case .broken(let place, let title, let badge):
      try h.encode(place ? "place" : "item", forKey: Key("broken"))
      try h.encode(title, forKey: Key("title"))
      try h.encode(badge, forKey: Key("badge"))
    }
  }
}

/// What the editor's [[ list offers (the web board's md/load.ts refCandidates and md/refs.ts refGroups): this board's
/// cards with a title of their own and its Sections with a title, then each other board of the vault as a group of its
/// own titled cards, the board itself the group's head. Each carries what a ref to it shows, for a ref picked while the
/// Note is being written
public struct RefCandidates: Encodable, Equatable, Sendable {
  /// A candidate: `label` is written in the [[…]] (nil: its title), `target` after `#^`; `crumb` the Section it is in
  public struct Item: Encodable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var kind: String
    public var label: String?
    public var crumb: String?
    public var target: String
    public var hit: NoteRef.Hit

    public init(
      id: String, title: String, kind: String, label: String? = nil, crumb: String? = nil, target: String,
      hit: NoteRef.Hit
    ) {
      self.id = id
      self.title = title
      self.kind = kind
      self.label = label
      self.crumb = crumb
      self.target = target
      self.hit = hit
    }
  }

  /// Another board: its head refs the board itself
  public struct Group: Encodable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var label: String
    public var target: String
    public var note: String
    public var items: [Item]
    public var hit: NoteRef.Hit

    public init(
      id: String, title: String, label: String, target: String, note: String, items: [Item], hit: NoteRef.Hit
    ) {
      self.id = id
      self.title = title
      self.label = label
      self.target = target
      self.note = note
      self.items = items
      self.hit = hit
    }
  }

  /// One picked lately: `group` the board it is on when that is another
  public struct Pick: Encodable, Equatable, Sendable {
    public var group: String?
    public var id: String

    public init(group: String?, id: String) {
      self.group = group
      self.id = id
    }
  }

  public var items: [Item]
  public var groups: [Group]
  /// Listed first while nothing is typed
  public var recent: [Pick]
  /// The line under the list: how many titled cards on how many boards ("" with no other board)
  public var foot: String

  public init(items: [Item], groups: [Group], recent: [Pick], foot: String) {
    self.items = items
    self.groups = groups
    self.recent = recent
    self.foot = foot
  }
}

/// A press on a drawn [[ref]] in a web view (refclick.ts): its label and the id written with it, its box in the web
/// view's points, whether ⌘ was held
public struct RefPress: Equatable, Sendable {
  public var ref: String
  public var target: String?
  public var rect: CGRect
  public var go: Bool
  /// In an editor (not a sidenote's text shown): its caret stays, nothing is selected
  public var writing: Bool

  public init(ref: String, target: String?, rect: CGRect, go: Bool = false, writing: Bool = true) {
    self.ref = ref
    self.target = target
    self.rect = rect
    self.go = go
    self.writing = writing
  }

  init?(_ m: [String: Any]) {
    guard let ref = m["ref"] as? String else { return nil }
    self.ref = ref
    target = m["target"] as? String
    rect = CGRect(
      x: m["x"] as? Double ?? 0, y: m["y"] as? Double ?? 0, width: m["width"] as? Double ?? 0,
      height: m["height"] as? Double ?? 0)
    go = m["go"] as? Bool ?? false
    writing = m["writing"] as? Bool ?? true
  }
}

/// A [[ref]] in a Note and what it points at now, as the web board resolves it: the canvas works it out from the board
/// and the vault (the Markdown package's `refs.resolve` on the web board). A ref the canvas found
/// nothing for is left out and drawn as not found.
public struct NoteRef: Hashable, Sendable {
  public enum Hit: Hashable, Sendable {
    /// Its title now, after the seal of the board it is on when that is another board
    case found(title: String, seal: Seal?)
    /// That board has no such card (`place` false: greyed, struck through) or there is no board of that name (`place`
    /// true: the warning colour); `badge`: the board's name as written
    case broken(place: Bool, title: String, badge: String)
  }

  /// Another board's mark: a few letters on one of the board theme's seal colours (`--seal-<color>`); `alone`: the ref
  /// names that board itself, so only the seal is drawn
  public struct Seal: Hashable, Sendable {
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
}

import Foundation

/// A selection in UTF-16 offsets of the text: where it was started and where it ends now (the caret)
public struct CodeSelection: Hashable, Sendable {
  public var anchor: Int
  public var head: Int

  public init(anchor: Int, head: Int) {
    self.anchor = anchor
    self.head = head
  }

  public init(_ caret: Int) { self.init(anchor: caret, head: caret) }

  public var range: Range<Int> { min(anchor, head)..<max(anchor, head) }
  public var isEmpty: Bool { anchor == head }
}

/// How an edit joins the undo history: typing joins the step before it, a command is a step of its own
public enum CodeUndo: Hashable, Sendable {
  case typing, command
}

/// One change: the range replaced (UTF-16 offsets), what by, and the selection after it
public struct CodeEdit: Hashable, Sendable {
  public var range: Range<Int>
  public var replacement: String
  public var selection: CodeSelection
  public var undo: CodeUndo

  public init(range: Range<Int>, replacement: String, selection: CodeSelection, undo: CodeUndo = .typing) {
    self.range = range
    self.replacement = replacement
    self.selection = selection
    self.undo = undo
  }

  /// `text` with the change made
  public func applied(to text: String) -> String {
    (text as NSString).replacingCharacters(
      in: NSRange(location: range.lowerBound, length: range.count), with: replacement)
  }
}

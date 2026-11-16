import AppKit
import CodeBoardModel
import CodeBoardResources

/// The popup that annotates a passage: the board's sidenote popup, which the shell makes (ReadingPane.makePop), so a
/// passage's annotations look and take keys as a card's sidenotes do. The tab hears what is done in it and places it;
/// where it goes beside the passage is worked out here
@MainActor public struct AnnotationPop {
  /// What it shows: the passage's annotations under the title bar (its title, the pages in its pill)
  public struct Shown: Equatable {
    public var title: String
    public var range: String?
    public var notes: [EntrySidenote]
    /// Opened to write a new one, the input ready
    public var write: Bool
    /// The entry's folder, where the Markdown's relative images are
    public var folder: URL
    public var look: ReadingBarLook
    public var maxHeight: CGFloat

    public init(
      title: String, range: String?, notes: [EntrySidenote], write: Bool, folder: URL, look: ReadingBarLook,
      maxHeight: CGFloat
    ) {
      self.title = title
      self.range = range
      self.notes = notes
      self.write = write
      self.folder = folder
      self.look = look
      self.maxHeight = maxHeight
    }
  }

  /// What was done in it: an annotation written (a question when asked), changed, deleted; a question resolved or
  /// opened again, answered, an answer changed (written empty: deleted); the title bar's Remove Highlight; Close
  public enum Action: Equatable {
    case add(String, ask: Bool)
    case write(SidenoteID, String)
    case delete(SidenoteID)
    case done(SidenoteID, Bool)
    case answer(SidenoteID, String)
    case writeAnswer(SidenoteID, answer: String, String)
    case remove
    case close
  }

  /// The popup and room around it; the pointer goes through it but on the popup
  public var view: NSView
  /// The popup's size now
  public var size: @MainActor () -> CGSize
  /// The view's frame in a flipped view for the popup's top left at a point there
  public var frame: @MainActor (CGPoint) -> CGRect
  public var show: @MainActor (Shown) -> Void
  /// The input, or the popup, takes the keys
  public var focus: @MainActor () -> Void
  /// What is being written in it added, and what it shows let go
  public var end: @MainActor () -> Void
  /// The side of the passage it went on when it opened (below: true), kept while it is open so it grows away from the
  /// passage instead of jumping to the other side
  public var below: Bool?

  public init(
    view: NSView, size: @escaping @MainActor () -> CGSize, frame: @escaping @MainActor (CGPoint) -> CGRect,
    show: @escaping @MainActor (Shown) -> Void, focus: @escaping @MainActor () -> Void,
    end: @escaping @MainActor () -> Void
  ) {
    self.view = view
    self.size = size
    self.frame = frame
    self.show = show
    self.focus = focus
    self.end = end
  }

  /// How much one more annotation of a line adds (a slip: 10 above, a line of 20, 11 below): what the side it opens on
  /// leaves room for
  public static let oneMoreNote: CGFloat = 41

  /// Whether a popup `height` tall goes below a passage whose lines are `lines` (y-down) in the part of the view where
  /// it may go, `visible`: when it fits under the last line, or fits above the first no better
  public static func below(height: CGFloat, lines: [CGRect], visible: CGRect, gap: CGFloat = 6) -> Bool {
    guard let first = lines.min(by: { $0.minY < $1.minY }), let last = lines.max(by: { $0.maxY < $1.maxY })
    else { return true }
    let under = visible.maxY - last.maxY - gap
    let over = first.minY - gap - visible.minY
    return height <= under || (height > over && under >= over)
  }

  /// Where the popup goes for a passage whose lines are `lines` (y-down) in the part of the view where it may go,
  /// `visible`: `gap` below its last line, starting where its first line starts, or `gap` above its first line, on
  /// the side `below` says (none given: below unless there is no room there); near the edges shifted sideways only.
  /// Neither place is over a line of the passage
  public static func origin(size: CGSize, lines: [CGRect], visible: CGRect, gap: CGFloat = 6, below: Bool? = nil)
    -> CGPoint
  {
    guard let first = lines.min(by: { $0.minY < $1.minY }), let last = lines.max(by: { $0.maxY < $1.maxY })
    else { return visible.origin }
    let x = max(visible.minX, min(first.minX, visible.maxX - size.width))
    let under = last.maxY + gap
    let goesBelow = below ?? (under + size.height <= visible.maxY)
    return CGPoint(x: x, y: goesBelow ? under : first.minY - gap - size.height)
  }
}

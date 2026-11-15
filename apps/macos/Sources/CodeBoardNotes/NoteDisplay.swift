import CoreGraphics
import Foundation

/// How the canvas gets the Markdown it shows at rest (a Note's, a Text's or Box's, an Always Show sidenote's in a code
/// card) and SVG pictures drawn and measured: a picture at a scale, what a Note measures at 100 %, where a Text's first
/// glyph is. Editing is not part of it (`NoteEditor`).
public protocol NoteDisplay: AnyObject, Sendable {
  /// What draws: a picture or size kept for one build is not reused by another
  var build: String { get }

  /// `note` on a card `width` wide (and `height` tall; nil: as tall as its content), its images resolving against
  /// `folder` (the board package or `.codeboard/shared`), as `scale` device pixels per point, in the board theme `look`
  /// (its id: warm-ink, ink-wash) and its `dark` variant or not, its [[refs]] drawn as `refs` resolve them. Among the
  /// requests waiting a higher `priority` goes first; a request cancelled before its turn draws nothing.
  func snapshot(
    of note: NoteBody, width: Double, height: Double?, folder: URL, scale: Double, look: String, dark: Bool,
    refs: [NoteRef], hideHead: Bool, priority: Int
  ) async throws -> NoteSnapshot

  /// The picture `snapshot` would give, when it can be had without waiting for a turn
  func cached(
    of note: NoteBody, width: Double, height: Double?, folder: URL, scale: Double, look: String, dark: Bool,
    refs: [NoteRef], hideHead: Bool
  ) async -> NoteSnapshot?

  /// An SVG file drawn as the board's image card shows it, `width` pixels wide and as tall as its proportions make it, on
  /// a `dark` board or not
  func picture(of file: URL, width: Int, dark: Bool, priority: Int) async throws -> NoteSnapshot

  /// The picture `picture` would give, when it can be had without waiting for a turn
  func cachedPicture(of file: URL, width: Int, dark: Bool) async -> NoteSnapshot?

  /// The size at 100 % of each Note (a Free Text: as wide as its text too), in order, with its blocks as laid out and
  /// where its [[refs]] are: what `snapshot` with no height gives as its size, without drawing it; nil for one that
  /// could not be measured
  func metrics(of notes: [NoteSizeRequest], priority: Int) async throws -> [NoteMetrics?]

  /// Each Note's size at 100 % and where its first glyph is from its top left (nil when it has none), measured now: what
  /// a Text keeps in place when it becomes a Box (the board measures it the same way, notes.ts setTextLook)
  func firstGlyphs(of notes: [NoteSizeRequest]) async throws -> [(size: CGSize, first: CGPoint?)?]
}

extension NoteDisplay {
  /// The sizes `metrics` gives
  public func sizes(of notes: [NoteSizeRequest], priority: Int) async throws -> [CGSize?] {
    try await metrics(of: notes, priority: priority).map { $0?.size }
  }
}

/// A Note to measure: on a card `width` wide that is as tall as its content, its images resolving against `folder`
public struct NoteSizeRequest: Sendable {
  public var note: NoteBody
  public var width: Double
  public var folder: URL
  public var look: String
  public var dark: Bool
  public var refs: [NoteRef]
  public var hideHead: Bool

  public init(
    note: NoteBody, width: Double, folder: URL, look: String, dark: Bool, refs: [NoteRef] = [], hideHead: Bool = false
  ) {
    self.note = note
    self.width = width
    self.folder = folder
    self.look = look
    self.dark = dark
    self.refs = refs
    self.hideHead = hideHead
  }
}

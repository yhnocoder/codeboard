// The board model, as stored in a board package's board.json (FORMAT.md). Property names are the JSON keys.
// A board's title is not in here: it is the package's folder name.

public struct Board: Equatable, Sendable {
  public static let version = 1

  public var id: BoardID
  /// In stacking order, the last one on top
  public var cards: [Card]
  public var arrows: [Arrow]
  public var sections: [Section]
  public var hideComments: Bool

  public init(
    id: BoardID, cards: [Card] = [], arrows: [Arrow] = [], sections: [Section] = [], hideComments: Bool = false
  ) {
    self.id = id
    self.cards = cards
    self.arrows = arrows
    self.sections = sections
    self.hideComments = hideComments
  }
}

/// A card as placed on one board. Its content is either its own or a shared card's, kept once in the vault's app-data folder.
public struct Card: Equatable, Sendable {
  public enum Content: Equatable, Sendable {
    case own(CardContent)
    case shared
  }

  public var id: CardID
  public var x: Double
  public var y: Double
  public var width: Double
  /// nil: as tall as its content. A code card's height leaves out its header and footer, whose size depends on the theme
  public var height: Double?
  public var section: SectionID?
  public var locked: Bool
  public var tilted: Bool
  public var content: Content

  public init(
    id: CardID, x: Double, y: Double, width: Double, height: Double? = nil, section: SectionID? = nil,
    locked: Bool = false, tilted: Bool = false, content: Content
  ) {
    self.id = id
    self.x = x
    self.y = y
    self.width = width
    self.height = height
    self.section = section
    self.locked = locked
    self.tilted = tilted
    self.content = content
  }
}

/// What a card shows, the same on every board it is on
public struct CardContent: Equatable, Sendable {
  public enum Body: Equatable, Sendable {
    case code(CodeCard)
    case note(Note)
    case image(ImageCard)
  }

  /// nil: the default title of its kind (a code card's symbol, a Note's first line)
  public var title: String?
  /// Markdown, drawn under the card's body
  public var description: String?
  public var processes: [ProcessTag]
  public var body: Body

  public init(title: String? = nil, description: String? = nil, processes: [ProcessTag] = [], body: Body) {
    self.title = title
    self.description = description
    self.processes = processes
    self.body = body
  }
}

/// A process label on a card's header (rank 0, Scheduler × TP); light: a thread or CUDA stream
public struct ProcessTag: Codable, Equatable, Sendable {
  public var text: String
  public var light: Bool

  public init(text: String, light: Bool = false) {
    self.text = text
    self.light = light
  }
}

public struct CodeCard: Codable, Equatable, Sendable {
  public var segments: [Segment]
  public var hide: HideFlags
  public var wrap: Bool
  /// false: the code is drawn on the canvas with no card frame
  public var framed: Bool

  public init(segments: [Segment], hide: HideFlags = HideFlags(), wrap: Bool = false, framed: Bool = true) {
    self.segments = segments
    self.hide = hide
    self.wrap = wrap
    self.framed = framed
  }
}

public struct HideFlags: Codable, Equatable, Sendable {
  public var comments: Bool
  public var docstrings: Bool
  public var blankLines: Bool

  public init(comments: Bool = false, docstrings: Bool = false, blankLines: Bool = false) {
    self.comments = comments
    self.docstrings = docstrings
    self.blankLines = blankLines
  }
}

/// Consecutive lines of one file. Line numbers are the file's own, 1-based
public struct Segment: Codable, Equatable, Sendable {
  public var id: SegmentID
  /// nil: written or pasted by hand, pinned to no source
  public var source: CodeSource?
  /// A VS Code language id: python, cpp, cuda-cpp, c…
  public var language: String
  public var firstLine: Int
  /// The code as it was at the source's version, so the card shows without the source
  public var lines: [String]
  public var symbol: Symbol?
  /// The function the lines are in (for the title), as Scheduler.schedule
  public var scope: String?
  public var hidden: [ClosedRange<Int>]
  /// Sorted, never overlapping
  public var highlights: [ClosedRange<Int>]
  public var annotations: [Annotation]

  public var lastLine: Int { firstLine + lines.count - 1 }

  public init(
    id: SegmentID, source: CodeSource?, language: String, firstLine: Int, lines: [String], symbol: Symbol? = nil,
    scope: String? = nil, hidden: [ClosedRange<Int>] = [], highlights: [ClosedRange<Int>] = [],
    annotations: [Annotation] = []
  ) {
    self.id = id
    self.source = source
    self.language = language
    self.firstLine = firstLine
    self.lines = lines
    self.symbol = symbol
    self.scope = scope
    self.hidden = hidden
    self.highlights = highlights
    self.annotations = annotations
  }
}

/// Where a segment's lines come from. A later kind (a resource: item, page, paragraph) is one more case
public enum CodeSource: Equatable, Sendable {
  /// repository: the git remote URL, nil when the old data did not have it. checkout: where the VS Code extension read the
  /// file (a folder relative to its workspace, "" for the first root, or an absolute path), kept to find the remote later
  case git(repository: String?, commit: String, path: String, uncommitted: Bool, checkout: String?)
  /// An installed package (pip, conda); path is inside the package's install folder
  case package(name: String, version: String, path: String)
  /// A file in no git repository, pinned by a fingerprint of its content when there is one
  case file(path: String, hash: String?)
}

public struct Symbol: Codable, Equatable, Sendable {
  public enum Kind: String, Codable, Sendable {
    case function, `class`, module
  }

  /// The qualified name, as Scheduler.schedule
  public var name: String
  public var kind: Kind

  public init(name: String, kind: Kind) {
    self.name = name
    self.kind = kind
  }
}

/// A hand-drawn label on characters from..<to (0-based, a tab counts one) of a line, written above it (below: under it)
public struct Annotation: Codable, Equatable, Sendable {
  public var line: Int
  public var from: Int
  public var to: Int
  public var text: String
  public var color: HandColor
  public var below: Bool

  public init(line: Int, from: Int, to: Int, text: String, color: HandColor = .blue, below: Bool = false) {
    self.line = line
    self.from = from
    self.to = to
    self.text = text
    self.color = color
    self.below = below
  }
}

public enum HandColor: String, Codable, Hashable, Sendable {
  case blue, purple, orange, green
}

public struct Note: Codable, Equatable, Sendable {
  /// Markdown; plain text for a free text
  public var text: String
  public var style: NoteStyle
  /// What Markdown cannot hold; the shape of @yhnocoder/markdown's MdLayout, handed to the editor as it is
  public var layout: NoteLayout?

  public init(text: String, style: NoteStyle = .note, layout: NoteLayout? = nil) {
    self.text = text
    self.style = style
    self.layout = layout
  }
}

/// How a Note is drawn. The old Text, Box, Mark and Free Text cards are Notes drawn their way, so they can later become
/// Note looks or annotations without a new card kind
public enum NoteStyle: Hashable, Sendable {
  public enum TextSize: String, Codable, Sendable {
    case title, heading, body
  }
  public enum BoxFill: String, Codable, Sendable {
    case yellow, paper, blue, green, pink
  }
  public enum HandWeight: String, Codable, Sendable {
    case light, regular, bold
  }

  /// A card with a frame and a title bar
  case note
  /// Frameless text in the theme's title, heading or body style
  case text(size: TextSize, bold: Bool)
  /// Frameless text on a coloured box
  case box(fill: BoxFill)
  /// Handwriting; fontSize nil: the Mark default (18 px)
  case mark(color: HandColor, weight: HandWeight, fontSize: Double?)
  /// Plain text written on the board; level 1–3 = H1–H3, 0 = body; fontSize nil: that level's default
  case freeText(level: Int, bold: Bool, fontSize: Double?)
}

/// By position: the nth table, the nth code block
public struct NoteLayout: Codable, Hashable, Sendable {
  public struct Table: Codable, Hashable, Sendable {
    public var cols: [Double?]?
    public var rows: [Double?]?

    public init(cols: [Double?]? = nil, rows: [Double?]? = nil) {
      self.cols = cols
      self.rows = rows
    }
  }

  public var tables: [Table?]?
  public var wrap: [Int]?

  public init(tables: [Table?]? = nil, wrap: [Int]? = nil) {
    self.tables = tables
    self.wrap = wrap
  }
}

public struct ImageCard: Codable, Equatable, Sendable {
  public var source: ImageSource
  public var alt: String?
  public var framed: Bool
  /// An animated image stands still on this frame (from 1); nil: the first
  public var stillFrame: Int?
  /// Always plays; otherwise only while selected
  public var loops: Bool

  public init(
    source: ImageSource, alt: String? = nil, framed: Bool = false, stillFrame: Int? = nil, loops: Bool = false
  ) {
    self.source = source
    self.alt = alt
    self.framed = framed
    self.stillFrame = stillFrame
    self.loops = loops
  }
}

/// A later kind (an image in a resource item, referenced and not copied) is one more case
public enum ImageSource: Equatable, Sendable {
  /// A file in the images folder next to the JSON that names it
  case file(String)
  case url(String)
}

public struct Arrow: Codable, Equatable, Sendable {
  public var id: ArrowID
  public var from: Endpoint
  public var to: Endpoint
  public var label: String?
  /// Where the label sits along the arrow, 0…1; nil: the middle
  public var labelPosition: Double?
  public var dashed: Bool
  /// 1, 2 or 3
  public var width: Int
  public var startHead: Bool
  public var endHead: Bool
  /// nil: the theme's arrow colour
  public var color: String?

  public init(
    id: ArrowID, from: Endpoint, to: Endpoint, label: String? = nil, labelPosition: Double? = nil, dashed: Bool = false,
    width: Int = 2, startHead: Bool = false, endHead: Bool = true, color: String? = nil
  ) {
    self.id = id
    self.from = from
    self.to = to
    self.label = label
    self.labelPosition = labelPosition
    self.dashed = dashed
    self.width = width
    self.startHead = startHead
    self.endHead = endHead
    self.color = color
  }
}

/// A whole card, a line of one of its segments, or a block of a Note
public struct Endpoint: Codable, Equatable, Sendable {
  public enum Side: String, Codable, Sendable {
    case left, right, top, bottom
  }

  public var card: CardID
  public var segment: SegmentID?
  public var line: Int?
  public var block: BlockRef?
  /// nil: chosen when drawn
  public var side: Side?
  /// The line it was on is gone from the code: drawn red at the card's header
  public var lost: Bool

  public init(
    card: CardID, segment: SegmentID? = nil, line: Int? = nil, block: BlockRef? = nil, side: Side? = nil,
    lost: Bool = false
  ) {
    self.card = card
    self.segment = segment
    self.line = line
    self.block = block
    self.side = side
    self.lost = lost
  }
}

/// A top-level block of a Note: its index and a fingerprint of its Markdown (blockSig), so the end follows edits above it
public struct BlockRef: Codable, Equatable, Sendable {
  public var index: Int
  public var hash: String

  public init(index: Int, hash: String) {
    self.index = index
    self.hash = hash
  }
}

public struct Section: Codable, Equatable, Sendable {
  public var id: SectionID
  public var title: String
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double
  public var parent: SectionID?
  /// nil: no colour
  public var color: String?
  public var collapsed: Bool
  public var locked: Bool
  public var description: String?

  public init(
    id: SectionID, title: String, x: Double, y: Double, width: Double, height: Double, parent: SectionID? = nil,
    color: String? = nil, collapsed: Bool = false, locked: Bool = false, description: String? = nil
  ) {
    self.id = id
    self.title = title
    self.x = x
    self.y = y
    self.width = width
    self.height = height
    self.parent = parent
    self.color = color
    self.collapsed = collapsed
    self.locked = locked
    self.description = description
  }
}

/// A shared card's content, in .codeboard/shared/<id>.json; every board that shows it has a Card with content .shared
public struct SharedCard: Equatable, Sendable {
  public static let version = 1

  public var id: CardID
  public var content: CardContent

  public init(id: CardID, content: CardContent) {
    self.id = id
    self.content = content
  }
}

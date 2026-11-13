// The board model, as stored in a board package's board.json (FORMAT.md). Property names are the JSON keys.
// A board's title is not in here: it is the package's folder name.

public struct Board: Equatable, Sendable {
  public static let version = 2

  public var id: BoardID
  /// On the canvas, in stacking order, the last one on top
  public var cards: [Card]
  public var arrows: [Arrow]
  public var sections: [Section]
  public var sidenotes: [Sidenote]
  public var stickers: [Sticker]
  /// What was put aside, newest last
  public var shelf: [ShelfEntry]
  /// What a [[ref]] to this board from another one is drawn with; nil: the defaults (initials of its title, a colour by id)
  public var seal: Seal?
  public var hideComments: Bool

  public init(
    id: BoardID, cards: [Card] = [], arrows: [Arrow] = [], sections: [Section] = [], sidenotes: [Sidenote] = [],
    stickers: [Sticker] = [], shelf: [ShelfEntry] = [], seal: Seal? = nil, hideComments: Bool = false
  ) {
    self.id = id
    self.cards = cards
    self.arrows = arrows
    self.sections = sections
    self.sidenotes = sidenotes
    self.stickers = stickers
    self.shelf = shelf
    self.seal = seal
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
  /// nil: as tall as its content (always, for a Text or Box). A code card's height leaves out its header and footer, whose
  /// size depends on the theme
  public var height: Double?
  /// How tall the board last drew it: kept for shelved cards, whose thumbnails are laid out without drawing them
  public var measuredHeight: Double?
  public var section: SectionID?
  public var locked: Bool
  public var tilted: Bool
  /// Its zoomed-out summary while it is in no section; per placement, so a shared card has one per board
  public var summary: Summary?
  public var content: Content

  public init(
    id: CardID, x: Double, y: Double, width: Double, height: Double? = nil, measuredHeight: Double? = nil,
    section: SectionID? = nil, locked: Bool = false, tilted: Bool = false, summary: Summary? = nil, content: Content
  ) {
    self.id = id
    self.x = x
    self.y = y
    self.width = width
    self.height = height
    self.measuredHeight = measuredHeight
    self.section = section
    self.locked = locked
    self.tilted = tilted
    self.summary = summary
    self.content = content
  }
}

/// What a card shows, the same on every board it is on
public struct CardContent: Equatable, Sendable {
  public enum Body: Equatable, Sendable {
    case code(CodeCard)
    case note(Note)
    /// A Text or a Box
    case text(TextCard)
    case image(ImageCard)
    case web(WebCard)
    case links(LinkList)
    /// Another board, shown inside this one
    case board(SubBoard)
  }

  /// nil: the default title of its kind (a code card's symbol, a Note's first line)
  public var title: String?
  /// Markdown, drawn under the card's body
  public var description: String?
  public var body: Body

  public init(title: String? = nil, description: String? = nil, body: Body) {
    self.title = title
    self.description = description
    self.body = body
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

public enum HandColor: String, Codable, Sendable {
  case blue, purple, orange, green
}

/// A card with a frame, a header and the board's Note text size
public struct Note: Codable, Equatable, Sendable {
  /// Markdown
  public var text: String
  /// What Markdown cannot hold; the shape of @yhnocoder/markdown's MdLayout, handed to the editor as it is
  public var layout: NoteLayout?

  public init(text: String, layout: NoteLayout? = nil) {
    self.text = text
    self.layout = layout
  }
}

/// Markdown written straight on the board (a Text) or on a coloured box (a Box): one card in two looks, switched back and
/// forth; never stored with a height, as tall as its text
public struct TextCard: Codable, Equatable, Sendable {
  public enum Look: String, Codable, Sendable {
    case text, box
  }

  /// The sizes a toolbar offers (px); a corner drag sets any size in fontSizes
  public static let sizes: [Double] = [20, 24, 30, 40]
  public static let fontSizes: ClosedRange<Double> = 10...240

  /// Markdown
  public var text: String
  public var look: Look
  /// A Box's fill; on a Text, the one it takes again when it turns back into a Box
  public var fill: BoxFill
  /// Its text size in px, which its headings and code scale with
  public var fontSize: Double
  /// It wraps at the card's width (set by dragging a side edge); otherwise it is as wide as its text
  public var wrap: Bool
  public var layout: NoteLayout?

  public init(
    text: String, look: Look = .text, fill: BoxFill = .yellow, fontSize: Double = 20, wrap: Bool = false,
    layout: NoteLayout? = nil
  ) {
    self.text = text
    self.look = look
    self.fill = fill
    self.fontSize = fontSize
    self.wrap = wrap
    self.layout = layout
  }
}

public enum BoxFill: String, Codable, CaseIterable, Sendable {
  case yellow, paper, blue, green, pink
}

/// By position: the nth table, the nth code block
public struct NoteLayout: Codable, Equatable, Sendable {
  public struct Table: Codable, Equatable, Sendable {
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
  /// Its zoomed-out summary; with sections inside it, the overview in its header
  public var summary: Summary?
  /// With sections inside it: the summary of the cards in it directly, in none of them
  public var directSummary: Summary?

  public init(
    id: SectionID, title: String, x: Double, y: Double, width: Double, height: Double, parent: SectionID? = nil,
    color: String? = nil, collapsed: Bool = false, locked: Bool = false, description: String? = nil,
    summary: Summary? = nil, directSummary: Summary? = nil
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
    self.summary = summary
    self.directSummary = directSummary
  }
}

/// A zoomed-out summary written by the AI (core summary.ts), up to three **key phrases**
public struct Summary: Codable, Equatable, Sendable {
  /// One of the user's edits: the AI text shown when they edited it, and what they made of it
  public struct Pair: Codable, Equatable, Sendable {
    public var ai: String
    public var user: String
    public var at: Double

    public init(ai: String, user: String, at: Double) {
      self.ai = ai
      self.user = user
      self.at = at
    }
  }

  public var text: String
  /// The AI's short title (cards only)
  public var title: String?
  /// When it was written (ms since 1970)
  public var at: Double
  /// A fingerprint of what it was written from: another one now means it is out of date
  public var sig: String
  /// The text is the user's own
  public var edited: Bool
  /// The user's edits, newest first, at most three: later rewrites follow them
  public var pairs: [Pair]
  /// What it was written from: while the content is the same, it is not asked for again
  public var input: String?

  public init(
    text: String, title: String? = nil, at: Double, sig: String, edited: Bool = false, pairs: [Pair] = [],
    input: String? = nil
  ) {
    self.text = text
    self.title = title
    self.at = at
    self.sig = sig
    self.edited = edited
    self.pairs = pairs
    self.input = input
  }
}

/// A web page, with what was read from it when it was added
public struct WebCard: Codable, Equatable, Sendable {
  public enum Style: String, Codable, Sendable {
    /// A wide picture above the text, a square one beside it
    case automatic
    case banner, side, text, compact
  }

  public var url: String
  public var meta: WebMeta?
  public var style: Style

  public init(url: String, meta: WebMeta? = nil, style: Style = .automatic) {
    self.url = url
    self.meta = meta
    self.style = style
  }
}

/// What was read from a page once, so it shows offline
public struct WebMeta: Codable, Equatable, Sendable {
  public var title: String?
  public var description: String?
  public var site: String?
  /// Its picture (og:image), a file next to the JSON that names it or, when it could not be fetched, its address
  public var image: ImageSource?
  public var icon: ImageSource?
  /// When it was read (ms since 1970)
  public var fetchedAt: Double?
  /// Nothing could be read (a sign-in page, offline)
  public var failed: Bool

  public init(
    title: String? = nil, description: String? = nil, site: String? = nil, image: ImageSource? = nil,
    icon: ImageSource? = nil, fetchedAt: Double? = nil, failed: Bool = false
  ) {
    self.title = title
    self.description = description
    self.site = site
    self.image = image
    self.icon = icon
    self.fetchedAt = fetchedAt
    self.failed = failed
  }
}

/// Several links in one card
public struct LinkList: Codable, Equatable, Sendable {
  public struct Item: Codable, Equatable, Sendable {
    public var id: String
    public var url: String
    public var title: String?
    public var meta: WebMeta?
    /// Shown with its picture and description; nil: as the card's `rich`
    public var rich: Bool?

    public init(id: String, url: String, title: String? = nil, meta: WebMeta? = nil, rich: Bool? = nil) {
      self.id = id
      self.url = url
      self.title = title
      self.meta = meta
      self.rich = rich
    }
  }

  public var items: [Item]
  /// How its items show unless they say otherwise
  public var rich: Bool

  public init(items: [Item], rich: Bool = false) {
    self.items = items
    self.rich = rich
  }
}

/// Another board, drawn inside this one
public struct SubBoard: Codable, Equatable, Sendable {
  public var board: BoardID

  public init(board: BoardID) {
    self.board = board
  }
}

/// A note beside a card, its lines or blocks, a section, or free on the board
public struct Sidenote: Equatable, Sendable {
  public enum Body: Equatable, Sendable {
    case text(TextNote)
    case code(Segment)
  }

  public var id: SidenoteID
  public var anchor: Anchor
  public var body: Body
  /// The lines it was on are gone from the code: it is on the whole card now
  public var lineRemoved: Bool
  /// On a shared card, but this board's alone: it does not travel with the card
  public var boardOnly: Bool
  /// The lines it is on changed (a new version's label) or its Highlight grew ("widened"): shown for a second look
  public var review: String?

  public init(
    id: SidenoteID, anchor: Anchor, body: Body, lineRemoved: Bool = false, boardOnly: Bool = false,
    review: String? = nil
  ) {
    self.id = id
    self.anchor = anchor
    self.body = body
    self.lineRemoved = lineRemoved
    self.boardOnly = boardOnly
    self.review = review
  }
}

public struct TextNote: Codable, Equatable, Sendable {
  /// Markdown, [[refs]] included
  public var text: String
  /// Shown open on the board, not only as a badge
  public var alwaysShow: Bool
  /// It asks something
  public var question: Question?

  public init(text: String, alwaysShow: Bool = false, question: Question? = nil) {
    self.text = text
    self.alwaysShow = alwaysShow
    self.question = question
  }
}

public struct Question: Codable, Equatable, Sendable {
  public struct Answer: Codable, Equatable, Sendable {
    public var id: String
    /// Markdown, [[refs]] included
    public var text: String
    /// When it was written (ms since 1970)
    public var at: Double

    public init(id: String, text: String, at: Double) {
      self.id = id
      self.text = text
      self.at = at
    }
  }

  /// When it was asked (ms since 1970)
  public var at: Double
  /// Resolved: only the user's check sets it, not an answer
  public var done: Bool
  /// Oldest first
  public var answers: [Answer]

  public init(at: Double, done: Bool = false, answers: [Answer] = []) {
    self.at = at
    self.done = done
    self.answers = answers
  }
}

/// Where a sidenote is
public enum Anchor: Equatable, Sendable {
  /// A whole card, lines of one of its segments, or a block of a Note
  case card(CardID, segment: SegmentID? = nil, lines: ClosedRange<Int>? = nil, block: BlockRef? = nil)
  case section(SectionID)
  /// Free on the board, at a point in board units
  case point(x: Double, y: Double)

  public var card: CardID? {
    if case .card(let id, _, _, _) = self { id } else { nil }
  }
}

/// A small mark stuck on the board, a card or a line of code
public struct Sticker: Equatable, Sendable {
  public enum Glyph: Equatable, Sendable {
    case builtin(BuiltinSticker)
    /// One emoji, as the system draws it
    case emoji(String)
  }

  public enum Anchor: Equatable, Sendable {
    /// Its top left at a point of the board; size nil: 32
    case canvas(x: Double, y: Double, size: Double?)
    /// Moves with the card: its top left this far from the card's
    case card(CardID, x: Double, y: Double, size: Double?)
    /// In the line numbers of a code line, following the line through new versions
    case line(CardID, segment: SegmentID, line: Int)

    public var card: CardID? {
      switch self {
      case .canvas: nil
      case .card(let id, _, _, _), .line(let id, _, _): id
      }
    }
  }

  public var id: StickerID
  public var glyph: Glyph
  /// "#RRGGBB"; nil: the glyph's own
  public var color: String?
  public var anchor: Anchor

  public init(id: StickerID, glyph: Glyph, color: String? = nil, anchor: Anchor) {
    self.id = id
    self.glyph = glyph
    self.color = color
    self.anchor = anchor
  }
}

/// The board's own glyphs (the web board's stickers/glyphs.tsx, the ones its picker offers)
public enum BuiltinSticker: String, Codable, CaseIterable, Sendable {
  case star, exclaim, check, flag, zap, bug, todo, heart, hourglass, warning
  case todoText = "todo-text"
}

/// What was put aside together: cards, a section with what is in it, a selection. Their sidenotes stay in the board's
public struct ShelfEntry: Codable, Equatable, Sendable {
  public var id: String
  /// When it was shelved (ms since 1970)
  public var at: Double
  /// Where they were, in stacking order, each with the height it was drawn at
  public var cards: [Card]
  /// Outermost first
  public var sections: [Section]
  /// Every arrow that touches one of its cards: hidden while it is shelved
  public var arrows: [Arrow]
  /// The stickers on its cards
  public var stickers: [Sticker]

  public init(
    id: String, at: Double, cards: [Card] = [], sections: [Section] = [], arrows: [Arrow] = [],
    stickers: [Sticker] = []
  ) {
    self.id = id
    self.at = at
    self.cards = cards
    self.sections = sections
    self.arrows = arrows
    self.stickers = stickers
  }
}

/// A board's seal: the few characters and the colour a [[ref]] to it from another board is drawn with. What is nil takes
/// the default
public struct Seal: Codable, Equatable, Sendable {
  public enum Color: String, Codable, CaseIterable, Sendable {
    case vermilion, amber, olive, teal, ink, plum, rose, graphite
  }

  /// 1–5 CJK and 1–12 other characters, no spaces
  public var text: String?
  public var color: Color?

  public init(text: String? = nil, color: Color? = nil) {
    self.text = text
    self.color = color
  }
}

/// A shared card's content, in .codeboard/shared/<id>.json; every board that shows it has a Card with content .shared
public struct SharedCard: Equatable, Sendable {
  public static let version = 2

  public var id: CardID
  public var content: CardContent
  /// The sidenotes that travel with it to every board
  public var sidenotes: [Sidenote]

  public init(id: CardID, content: CardContent, sidenotes: [Sidenote] = []) {
    self.id = id
    self.content = content
    self.sidenotes = sidenotes
  }
}

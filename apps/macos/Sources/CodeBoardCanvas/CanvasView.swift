import AppKit
import CodeBoardDiagnostics
import CodeBoardModel
import CodeBoardNotes
import MarkdownCore
import MarkdownUI
import QuartzCore
import TestGuard
import TreeSitterHighlight

/// What to go to on a board once it is shown: a question (the question list), a card (a ref to it)
public enum Arrival: Equatable, Sendable {
  case question(SidenoteID)
  case card(CardID)
}

/// One board, read-only, panned and zoomed. While a gesture runs (its glide and rubber band included) Core Animation
/// only moves and scales the bitmaps the items already have; at rest they are redrawn at fixed levels (`Levels`,
/// `RestPlan`), off the main thread, and swapped in a few per frame (`RedrawQueue`). A Note's bitmap at each level is
/// its paper drawn here with the Note renderer's picture over it, so Notes go through the same levels, queue and
/// budgets; until its first picture comes in a Note shows its paper (`NoteFace`). An SVG picture is drawn by the Note
/// renderer too (WebKit draws it as the web board does), and goes the same way. Every canvas shares one bitmap budget
/// (`BudgetShare`): only the canvas on screen draws, and a hidden one keeps its overviews.
public final class CanvasView: NSView {
  /// The design allows one snapshot web view in the app, so every canvas shares one renderer
  static let sharedNotes = NoteRenderer()
  /// What draws the app's Notes: the native component (warmed up off the main thread from the app's launch, `warmUp`)
  static let sharedDisplay: NativeNotes = {
    NativeNotes.warmUp()
    return NativeNotes(web: sharedNotes, images: sharedImages, kept: NativeNotes.defaultKept)
  }()
  /// Starts what draws Notes as the app launches, so its fonts and engines are ready sooner for the first board
  public static func warmUp() { _ = sharedDisplay }
  /// Pictures decoded for drawing, by file: one cache for every canvas, as tabs often show the same images
  static let sharedImages = DecodeCache(cap: 128 << 20)
  /// Every canvas alive, for the one budget they share
  static let all = NSHashTable<CanvasView>.weakObjects()
  static var clock = 0
  /// When it was last on screen and at rest (the clock's time)
  var shownAt = 0
  /// The web page's other work: pastes, added pictures, Free code's language
  let notes: NoteRenderer
  /// What draws and measures the Markdown shown at rest and SVG pictures, and lays out what is written in a Note
  let display: NativeNotes
  var theme = Theme.warmInk
  /// The board shown, to show again in another theme
  package var shown: (board: VaultBoard, vault: Vault)?
  /// What is drawn; every change of it (a card added, gone, moved or resized, a Section folded, an undo, another
  /// board) has what is under a resting pointer hovered again on the next frame
  var scene: Scene? {
    didSet {
      rehoverDue = true
      wake()
    }
  }
  var rehoverDue = false
  var items: [ItemLayers] = []
  let world = CALayer()
  /// The theme's picture behind the board, fixed to the view
  let backdrop = CALayer()
  var backdropImage: CGImage?
  let sections = CALayer()
  let below = CALayer()
  let arrows = CALayer()
  let above = CALayer()
  let cards = CALayer()
  /// Everything the summary level fades out as one: Section frames and titles, arrows, cards, stickers, marks
  let cardLevel = CALayer()
  /// Sub-board cards, Texts and Boxes, which the summary level shows as they are (main's .keeplay): always over the card
  /// level, never faded
  let kept = CALayer()
  /// The alignment guides while something is dragged (CanvasEditing.swift showGuides), over the ports and handles
  let guideLayer = CAShapeLayer()
  /// A resize's "same width · 240" under the card, in view points (CanvasEditing.swift showSizeHint)
  let sizeHint = CALayer()
  /// A drag held still lines up after a moment
  var snapSettle: Task<Void, Never>?
  /// Cards picked up by the pointer, until they have landed: over every card, Texts and Boxes too (main's .card.lift)
  let liftedLayer = CALayer()
  /// Where the board shown last is kept as a picture when it is left (nil: nowhere; the app's panes keep it in its
  /// caches, BoardPanes.pictures), and that picture over the view while the board opens again (CanvasPicture.swift)
  package var picturesFolder: URL?
  let picture = CALayer()
  /// The camera the picture was taken at: moved from it, the picture goes
  var pictureCamera: Camera?
  package internal(set) var pictureShownAt: CFTimeInterval?
  /// Another board is being opened: what is shown is the board left (or its picture), so input goes nowhere
  var opening = false
  /// Awaited before a load's work starts, so that a test looks at the canvas while a board is still opening
  var loadHold: (@Sendable () async -> Void)?
  /// The summary level's columns (CanvasSummaries.swift)
  let summaryLayer = CALayer()
  /// Which level is shown and how it changes (SummaryLevels.swift)
  var levels = SummaryLevels()
  /// The level the canvas last acted on (levelChanged)
  var levelShown = SummaryLevels.Level.cards
  /// The summary level as laid out, its columns and their pictures (kept while their text, width and look stay)
  var summaryLayout: SumLayout?
  var summaryColumns: [SummaryColumn] = []
  var summaryPictures: [SummaryPictureKey: SummaryArt.Drawn] = [:]
  var summaryMeasures: [SummaryPictureKey: SumMeasure] = [:]
  var summaryHover: SummaryKey?
  /// The hovered column's ↻, dot and ✓ 保留, kept their size on screen
  let summaryButtons = CALayer()
  /// The one of them under the pointer, whose tip shows
  var summaryButtonHover: (key: SummaryKey, keep: Bool)?
  /// A body pressed, edited when let go where it was pressed (view points)
  var summaryPress: (key: SummaryKey, at: CGPoint)?
  var summaryEditor: SummaryEditor?
  /// Summaries the AI is writing
  var summaryWriting: Set<SummaryKey> = []
  /// Writes a summary again when its ↻ is clicked; nil (no AI key set): no ↻
  public var summaryWriter: (any SummaryWriter)? {
    didSet {
      if let k = summaryHover, let c = summaryColumns.first(where: { $0.col.key == k }) { placeSummaryButtons(c) }
    }
  }
  /// The zoom the summaries take over below (0: none on this board)
  package var summaryCut: CGFloat { levels.cut }
  /// 摘要切换
  public var summarySwitch: SummarySwitch {
    get { levels.mode }
    set { levels.mode = newValue }
  }
  package var camera = Camera(origin: .zero, zoom: 1)
  /// The camera the world was last put on device pixels at, at rest (`settleOnPixels`)
  var settledAt: Camera?
  /// Where the next board shown is shown from (back to a board: where it was), instead of all of it in view
  public var arriving: Camera?
  /// This canvas changed the vault's files (a board made or renamed): the shell reads the tree again
  public var onVaultChanged: (() -> Void)?
  /// A board's seal set from a ref's Edit Mark… (nil: the default); `done`: its popover closed
  public var onSetSeal: ((BoardID, Seal?, _ done: Bool) -> Void)?
  /// A board or folder from the sidebar let go on this folder board: its path, where on the board
  public var onVaultDrop: ((String, CGPoint) -> Void)?
  /// The Edit Mark… popover open over a ref
  var sealPopover: NSPopover?
  /// Bumped when the vault changes on disk, which sub-board cards show
  var vaultSeen = 0
  /// Where the view is now
  public var currentCamera: Camera { camera }
  /// Where this machine keeps each board's camera (nil: nowhere, as in tests that give none)
  public var cameras: CameraStore?
  /// The camera last kept for the board shown (or that it opened at)
  var cameraKept: Camera?
  /// A camera to be written once things are still for `cameraDelay`, never during a gesture
  var cameraToKeep: (store: CameraStore, vault: Vault, board: BoardID, camera: Camera)?
  var cameraSave: Task<Void, Never>?
  package var cameraDelay = Duration.milliseconds(500)
  var limits = ZoomLimits(min: 0.1)
  var motion = Motion()
  /// The scroll and pinch gestures the board took (CanvasWheel.swift), and the app's event monitor that routes them
  var wheel = WheelOwner()
  var wheelMonitor: Any?
  var queue = RedrawQueue<IOSurface>()
  /// Rest bitmaps are drawn for this zoom; nil once a zoom has cleared them
  var restZoom: CGFloat?
  var tasks: [Int: Task<Void, Never>] = [:]
  var nextTask = 0
  /// Notes' renderer priority: plan order, nearest the view's centre and the pointer first
  var nextNote = 0
  var loads = 0
  /// Rest work was started since the queue was last idle
  var worked = false
  var link: CADisplayLink?
  /// A clock of the interaction driver's (Sources/Drive): the display link stops and the driver steps every frame
  /// (`tick(at:)`) on its own time, so a recording is the same each run
  package var steppedClock: (() -> TimeInterval)? {
    didSet { link?.isPaused = steppedClock != nil }
  }
  /// Frames are wanted: the display link runs, unless the driver steps them
  func wake() { link?.isPaused = steppedClock != nil }
  /// Under the driver the app is never activated, so its window is never key, and a press would only be the click that
  /// brings it forward
  public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { steppedClock != nil }
  /// Now, on the display's clock or the driver's
  var now: TimeInterval { steppedClock?() ?? CACurrentMediaTime() }
  let images = CanvasView.sharedImages
  /// Made by the first board shown, off the main thread (compiling its queries takes tens of milliseconds and as many
  /// megabytes), and kept for every canvas
  static var highlighter: Highlighter?

  /// Called at the start of every display-link frame, before the canvas moves (CanvasBench drives and measures from it).
  /// While set, the display link never pauses
  package var onFrame: ((CADisplayLink) -> Void)? {
    didSet { wake() }
  }
  // MARK: Editing state (CanvasEditing.swift)

  /// This canvas's seat at the open board it edits (its own selection there); nil: it only shows a board read from the
  /// vault
  package var document: BoardDocument.Seat?
  var stopObserving: (() -> Void)?
  /// The board the scene was made from
  var shownBoard: Board?
  /// What the Note renderer measured, by card, with what it measured: a later scene measures only what changed
  var measured: [CardID: (note: NoteBody, width: Double, preamble: String, size: NoteMetrics)] = [:]
  /// What the Note renderer measured of each Always Show sidenote in a code card, and for what
  var measuredInline: [SidenoteID: (note: NoteBody, width: Double, size: NoteMetrics)] = [:]
  /// The pointer or key gesture under way; while one runs nothing is redrawn or swapped
  var gesture: Gesture? {
    didSet { if oldValue == nil && gesture != nil { gestureStarts += 1 } }
  }
  /// Gestures begun, pointer, key or camera: a redraw that ends cancelled counts against the gesture rule only when one
  /// began while it ran (one cancelled by anything else, a camera placed or a tab hidden, ran into no gesture)
  var gestureStarts = 0
  /// The board changed during a gesture: the scene follows once it ends
  var pendingRefresh = false
  var refreshes = 0
  /// How long the last refresh's swap took on the main thread, and how many items it drew anew
  package var lastInstall: (seconds: Double, drawn: Int) = (0, 0)
  /// The card being written in, and the layers it had before (shown again when nothing was written)
  var editing: Editing?
  /// Text selected in a Note at rest (CanvasRestText), drawn in `restLayer`; its bar once it settles
  var restText: RestText?
  var restSettle: Timer?
  let restLayer = CAShapeLayer()
  let restBar = SelectionToolbar()
  var editingOriginal: ItemLayers?
  var editingEnds: Task<Void, Never>?
  /// A card's description being written in place (CanvasDesc)
  var descWriting: DescWriting?
  /// An editor is on its way (a double-click, a new card): the keys typed until it is there, for it
  var keysAhead: [NSEvent]?
  /// The floating bar's bitmap and what it shows
  var barImage: (key: String, image: CGImage)?
  /// A Section title's controls (CanvasSectionActs): the title hovered and its control, the Section whose swatches are
  /// open, the Section whose controls show, their bitmap
  var hoveredTitle: SectionID?
  /// The Section titles shown in another colour (toneTitles)
  var toned: [SectionID: Tone] = [:]
  var hoveredAct: SectionAct?
  var swatchesOpen: SectionID?
  var actsShown: SectionID?
  var actsImage: (key: String, image: CGImage)?
  /// Cards' header buttons (CanvasHeadActs): the one under the pointer, each card's strip and what it was drawn for, the
  /// hovered card's grip, and what puts a menu up when tests look at it instead
  var hoveredHead: (CardID, HeadAct)?
  /// The sticker under the pointer, its label the tip (Picker.tsx .stk data-tip)
  var hoveredSticker: StickerID?
  /// The buttons' tips (main's one TooltipLayer, shared with the toolbar and the dock); tests give a canvas its own
  var tips = Tips.shared
  var headShown: [CardID: (layer: CALayer, key: String, out: CFTimeInterval)] = [:]
  var gripShown: (id: CardID, layer: CALayer)?
  package var menuShown: ((NSMenu, CGPoint) -> Void)?
  /// The Text or Box raised over its neighbours (its item index)
  var raised: Int?
  /// The handles drawn on the selected Texts and Boxes, in their cards' layers
  var textHandleLayers: [CALayer] = []
  /// The latest refresh (tests wait for it)
  package var refreshing: Task<Void, Never>?
  /// Selection rings, handles: over the cards, in board units
  let chrome = CALayer()
  /// Each selected card's look (ring and glow, seal, outline), in the card's own layer as main's .cface::before is:
  /// it moves, scales and tilts with the card
  var selectedLooks: [CardID: [CALayer]] = [:]
  /// The cards a pointer drag has picked up (CanvasLift.swift), and those landing since when
  var lifted: Set<CardID> = []
  var landings: [CardID: CFTimeInterval] = [:]
  /// The rubber band, in the view's units
  let marquee = CAShapeLayer()
  /// The arrows' layers, as `scene.arrows`
  var arrowGroups: [[CALayer]] = []
  /// Arrows routed again while their cards move, by index in `scene.arrows`
  var routedArrows: [Int: Scene.Arrow] = [:]
  /// The arrow under the pointer, drawn as selected
  var hoveredArrow: ArrowID?
  /// The card under the pointer, which shows its ports, the code line under it and the port under it
  var hoveredCard: CardID?
  /// The hovered Text's or Box's line (drawHoverLine)
  var hoverLine: CALayer?
  var hoveredLine: Endpoint?
  var hoveredPort: Port? {
    didSet { showTip() }
  }
  /// The label or title being written in place, and a written one's field until the board shows what it says
  var inPlace: InPlace?
  var closingField: NSTextField?
  /// The mode the board is in (the toolbar's Arrow or Section), shown as the toolbar's tool in use
  var mode: CanvasMode? {
    didSet { if mode != oldValue { onMode?(activeTool) } }
  }
  /// Told the toolbar's tool in use when it changes
  public var onMode: ((Tool?) -> Void)?
  /// A short line over the bottom of the board, in the view's units
  let toastLayer = CALayer()
  package var toastText: String?
  var toastShown = 0
  /// The Sections a drag would drop cards into, tinted under the cards
  let dropLayer = CALayer()
  /// The Link List row under the pointer (tinted, its ⋮⋮ and tools shown), its layer, and the bookmark a Compact row
  /// shows beside the card after WEB_PEEK_DELAY
  var hoveredRow: RowHover?
  var rowHoverShown: (layer: CALayer, key: String)?
  var rowPeek: (layer: CALayer, row: RowHover)?
  var rowPeekWait: Task<Void, Never>?
  /// Arms a merge once the dragged Web cards have stayed over a card's title MERGE_HOLD
  var mergeHold: Task<Void, Never>?
  /// "Release to merge" over the card it would merge into, in the view's units
  let mergeHint = CALayer()
  /// The frames as the drop tint was worked out (the dragged Sections moved)
  var dropFrames: [SectionID: CGRect] = [:]
  /// Sidenote markers free on the board (a card's and a Section's are in their own layers)
  let freeMarks = CALayer()
  /// Stickers free on the board, over the cards (a card's are in its own layer), as laid out, their layers in order
  let freeStickers = CALayer()
  var stickerSpots: [StickerSpot] = []
  var stickerLayers: [CALayer] = []
  /// The selected sticker's tether to the place on its arrow, under the stickers (Picker.tsx .tether)
  let tether = CALayer()
  /// The glyph picked in the palette, following the pointer (its ghost, in the view's units) until a click
  package var placing: Sticker.Glyph?
  let stickerGhost = CALayer()
  /// A card collected from a reading pane, in hand while its drag is over the board (CanvasCollect.swift)
  var inHand: InHand?
  package var stickerPalette: StickerPalette?
  /// The Shelf: its button, its panel, the entry shown large, the pictures drawn of each entry, what flies in, the
  /// outline of where a hovered entry returns and of one dragged out (board units)
  package let dock = CanvasDock(theme: .warmInk)
  package var shelfPanel: ShelfPanel?
  /// Space held, and where the pointer was last in a drag it pans (CanvasKeys)
  var spaceHeld = false
  /// The shortcut list, while open
  package var keysPanel: KeysPanel?
  var spacePan: CGPoint?
  package var shelfPreview: ShelfPreview?
  package var previewing: String?
  package var shelfPictures: [String: (key: ShelfPictureKey, image: CGImage)] = [:]
  var shelfFlights: [CALayer] = []
  /// Put back, waiting for the scene that shows it
  var flyingOut: FlyOut?
  package var shelfHovered: String?
  let shelfHome = CALayer()
  let shelfDrag = CALayer()
  /// How a Web card's page is read and opened (tests give their own: never the network or a browser)
  package var fetchPage: WebFetch = WebFetcher.live
  package var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
  /// Where a double-click opens a Web card's page, with its title when it has one (the shell: its reading pane); nil,
  /// and with ⌘, the browser
  public var onOpenWeb: ((URL, String?) -> Void)?
  /// Where the pointer is in the window (tests give their own: never the person's pointer); nil: the window's
  package var pointerInWindow: CGPoint?
  /// How an image card's picture at a web address is read (tests give their own: never the network), and the folder the
  /// pictures read are kept in, each once
  package var fetchPicture: @Sendable (URL) async -> Data? = { try? await URLSession.shared.data(from: $0).0 }
  package var pictureCache = CanvasView.pictures
  nonisolated static let pictures = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appending(path: "CodeBoard/Pictures")
  /// The pictures at web addresses read so far, by address: their files; and the addresses asked for
  var remotePictures: [String: URL] = [:]
  var remoteAsked: Set<String> = []
  /// What says where the cards' sources are and what they are called (the shell's reading side; CanvasSources.swift)
  public var sources: SourceProvider? {
    didSet {
      // one provider serves every tab's canvas: each adds itself to those it tells
      // ponytail: a closed tab's link stays in the chain (doing nothing); a list in the provider if tabs number thousands
      let others = sources?.onSourcesChanged
      sources?.onSourcesChanged = { [weak self] in
        others?()
        self?.sourcesChanged()
      }
      sourcesChanged()
    }
  }
  /// What says which calls the code cards' lines have (the shell; CanvasCalls.swift)
  public weak var callHost: CallHost? {
    didSet {
      let others = callHost?.onCallsChanged
      callHost?.onCallsChanged = { [weak self] in
        others?()
        self?.callsChanged()
      }
      callsChanged()
    }
  }
  /// A press on a card's source, which shows it when let go where it was pressed
  var sourcePress: SourceAnchor?
  /// Where a code card's file name clicked opens its file, with the name's place in this view (the shell: its reading
  /// pane, or what is missing to open it there); nil: the name is no button
  public var onOpenCode: ((Segment, CGRect) -> Void)?
  /// A press on a code card's file name, which opens it when let go where it was pressed
  var codePathPress: CardID?
  /// The pictures of resource blocks the provider gave, and those asked for
  var sourcePictures = SourcePictures()
  /// The pages being read now, by card ("card/row" for a list's row), and their tasks
  package var webFetching: Set<String> = []
  package var webTasks: [String: Task<Void, Never>] = [:]
  /// A dragged row's place in its list, and its label by the pointer
  let rowLine = CALayer()
  let rowGhost = CALayer()
  /// The sidenote markers shown, their layers in the same order, and the zoom they were placed at
  var marks: [Mark] = []
  var markLayers: [CALayer] = []
  var marksZoom: CGFloat = 0
  var hoveredMark: Int?
  /// The sidenote popups open, the newest last (state/pop.ts pops)
  var pops: [Popup] = []
  /// The popup the next one opened takes, made before (tests hold it before it opens)
  var nextPop: SidenotePop?
  /// A sidenote popup opened or closed: the newest one open now (tests)
  package var onPop: ((PopAt?) -> Void)?
  /// The popups' showing, updating and closing, one after another
  var popTask: Task<Void, Never>?
  /// The popup the [[ref]] previewed was pressed in
  var refPop: Popup?
  /// The open questions the toolbar was told of; the question list open, under the toolbar button at that rect, with
  /// the other boards' questions it lists
  var shownQuestions = -1
  package var listShown = false
  var listButton = CGRect.zero
  var listOthers: [(VaultBoard, [QuestionListView.Shown.Item])] = []
  /// How many of this board's questions are open, as it changes
  public var onQuestions: ((Int) -> Void)?
  /// A question on another board picked in the list: that board is to open and go to it
  /// Another board to open, and what to go to on it once shown
  public var onOpenBoard: ((BoardID, Arrival?) -> Void)?
  /// Over a sub-board: the breadcrumb, and the move in or out under way (CanvasCrumbs.swift)
  let crumbsBar = CrumbsBar()
  /// Back on a board after a while with questions still open on it (CanvasQuestions.swift)
  let welcomeHint = WelcomeHint()
  /// The time a board is opened at (tests give their own)
  package var clock: () -> Date = { Date() }
  /// A board to delete (a sub-board card's Delete Board…): the shell asks first; whether it went
  public var onDeleteBoard: (@MainActor (BoardID) async -> Bool)?
  /// The titles of the boards showing a shared card now, this one among them
  package var boardsShowing: (CardID) -> [String] = { _ in [] }
  /// Delete Everywhere of a shared card (its title): the shell asks, runs `here` (this board's step) and takes it from
  /// the other boards; how many boards it was on, nil when not asked or not done
  package var onDeleteEverywhere: (@MainActor (CardID, String, _ here: @MainActor () -> Void) async -> Int?)?
  /// A ref clicked: what goes there once the double-click time is over
  var refGo: Task<Void, Never>?
  /// How long a click on a ref waits for a second (tests shorten it)
  package var refWait = Duration.milliseconds(Int(NSEvent.doubleClickInterval * 1000))
  /// The preview a ref's click opened
  package var refPeek: RefPeek?
  /// A press on a ref of a card at rest, clicked when let go where it was pressed
  var refPress: (card: CardID, box: NoteRefBox)?
  /// The card last flashed (tests), its ring and how it is drawn some way out
  package var flashed: CardID?
  var flashRing: (CAShapeLayer, (CGFloat) -> CGPath)?
  /// The previews open beside sub-board cards (CanvasSubPreviews.swift)
  var subPreviews = SubPreviews()
  /// Lines selected by their numbers in a code card
  package var lineSel: Lines?
  /// A free marker pressed (its index in `marks`), where, and whether it has moved; what it would land on, tinted
  var markDrag: (index: Int, from: CGPoint, moved: Bool)?
  var dropAim: CALayer?
  /// The selected and hovered arrows in the accent: over the arrows, under their labels
  let litArrows = CALayer()
  var dropLit: Set<SectionID> = []
  /// The frames a card drag has redrawn, where it drew them (CanvasSections followDrag)
  var dragShown: [SectionID: CGRect] = [:]
  /// The accessibility elements of what is drawn on the board, kept while it is there (CanvasAccessibility)
  var axElements: [BoardThing: BoardElement] = [:]
  /// The latest frame's time (a test's own clock goes on from it)
  package private(set) var lastTick: TimeInterval = 0
  /// The frames easing towards where the drag has them, each a spring that keeps its speed as the target moves
  var frameEase: [SectionID: FrameEase] = [:]
  var frameEaseAt: TimeInterval?
  /// Tidy Up's slide (CanvasTidySlide.swift)
  var tidySlide: TidySlide?
  /// The zoom that fits the board, which overviews are drawn for
  var fitZoom: CGFloat = 1
  /// The framed cards' shadow, made once per theme
  var cardShadow: (IOSurface, margin: CGFloat)?
  /// Where Copy writes and Paste reads; tests give their own
  package var pasteboard = NSPasteboard.general
  /// The picture file New Image adds, asked in the open panel as a sheet on the window; tests answer it (a panel made
  /// in the test process stops its main run loop)
  package var pickImage: (NSWindow) async -> URL? = CanvasView.askImageFile
  /// Cards copied on another board, pasted here: the shell makes them shared cards on that board (`Board.share`) and
  /// gives the ids they have there now (old → new) and its title; nil: that board cannot take it now (they come as
  /// copies). With no cards it only gives the title
  public var shareOnBoard: ((BoardID, Set<CardID>) -> (ids: [CardID: CardID], title: String)?)?
  /// Where a card drag's pointer out of the view goes (the app's windows); nil: it stays the view's drag
  public weak var cardDragging: CardDragging?
  /// The cards of a drag while its pointer is out of the view
  public internal(set) var cardsOut: CardsOut?
  /// Where cards from another window would land
  var cardsDropLayer: CAShapeLayer?
  /// The Copy ✓ | Reference chip under copies just made (CanvasPasteChip.swift)
  var pasteChip: PasteChip?
  var chipTimer: Task<Void, Never>?
  var chipHovered: ChipButton?
  /// The chip's button pressed, until the release (it acts if let go over it)
  var chipPressed: ChipButton?
  /// A button drawn on the board pressed (a Section's control, a sidenote's marker, a card's mark of its other places,
  /// the Text bar's, a summary's, a Web card's Retry or Edit Title), until the release: as main's <button>, it acts
  /// when let go over it (`over`), and does nothing when let go off it
  var held: (over: (CGPoint) -> Bool, act: () -> Void)?
  var chipInside = false
  /// The bar over two or more selected cards, in view points (CanvasAlignBar.swift), its ⋯ panel in it
  let alignBar = CALayer()
  let alignMoreLayer = CALayer()
  var alignMore = false
  var alignFor: [CardID] = []
  var alignHovered: AlignBarButton?
  var alignPressed: AlignBarButton?
  var alignBarDrawn: AlignBarLook?
  /// A press the canvas was sent over the editor (the second of a double-click), handed on to it with its release
  var pressToEditor = false
  var choosingChip = false
  /// How long the chip stays once the pointer is not over it (timing.ts PASTE_CHIP_IDLE)
  package var chipIdle = Duration.milliseconds(6000)
  /// The marks of cards placed several times on the board, where they take the pointer
  var twinSpots: [(card: CardID, hit: CGRect)] = []
  var hoveredTwin: CardID?
  /// Each Text's narrowest width (its longest word), once measured
  var leastWidths: [CardID: CGFloat] = [:]
  /// Arrow keys held for the nudge under way
  var nudgeHold: NudgeHold?
  /// The cards ⌘C copied on this board (the pasteboard data that stands for them) and how many times they were pasted
  /// since (actions/shared.ts copied)
  var copied: (board: BoardID, data: Data, n: Int)?
  /// The cards ⌘X cut on this board with every arrow that touched them, and the pasteboard data that stands for them
  /// (actions/shared.ts cutClip)
  var cutClip: (board: BoardID, data: Data, clip: Clip)?
  /// The text Copy Code last put on the pasteboard, the card it came from and how many times it was pasted since: ⌘V of
  /// the same text lands beside that card (actions/clipboard.ts lastCopy)
  var lastCopy: (card: CardID, text: String, n: Int)?

  /// Work begun while a gesture was active; the gesture rule says all stay 0
  package private(set) var ruleBreaks = (redraws: 0, decodes: 0, swaps: 0, noteRequests: 0, noteSwaps: 0)

  public convenience override init(frame: NSRect) {
    self.init(frame: frame, notes: CanvasView.sharedNotes, display: CanvasView.sharedDisplay)
  }

  /// With a Note renderer of its own, its snapshots, measured sizes, formulas and diagrams kept in `noteCache`
  /// (CanvasBench and tests: not the app's cache), as the app keeps them
  package convenience init(frame: NSRect, noteCache: URL) {
    let web = NoteRenderer(cache: noteCache)
    self.init(frame: frame, notes: web, display: NativeNotes(web: web, kept: noteCache.appending(path: "native")))
  }

  /// With that Note renderer (CanvasBench: one for several canvases, as the app's), and its Markdown drawn by `display`
  /// (by default one of its own, with nothing kept on disk)
  /// The pasteboard type of a Note's source as copied
  static let markdownSource = NSPasteboard.PasteboardType("com.yhnocoder.codeboard.markdown")

  package init(frame: NSRect, notes: NoteRenderer, display: NativeNotes? = nil) {
    self.notes = notes
    self.display = display ?? NativeNotes(web: notes)
    super.init(frame: frame)
    // in a test process: no menu, alert or panel ever comes up
    TestGuard.install()
    // what a Note copies is read back as its source by every Note, those copied by earlier versions too
    MarkdownEditorView.sourceType = CanvasView.markdownSource
    // a Note's [[reference]] points at a card
    MarkdownEditing.referenceTitle = "Link to Card"
    CanvasView.all.add(self)
    registerForDraggedTypes([.string, .URL, .fileURL, CanvasView.collectedType])
    // layer-hosting: the canvas owns its layer tree, y-down like the board
    let root = CALayer()
    root.isGeometryFlipped = true
    // never transparent before the first board: whatever is behind would show for a frame
    root.backgroundColor = theme.canvas
    layer = root
    wantsLayer = true
    for l in [
      world, cardLevel, kept, liftedLayer, summaryLayer, sections, dropLayer, below, arrows, litArrows, above, cards,
      freeStickers,
      freeMarks, shelfHome, shelfDrag, chrome,
    ] {
      l.anchorPoint = .zero
    }
    for l in [sections, dropLayer, below, arrows, litArrows, above, cards, freeStickers, freeMarks] {
      cardLevel.addSublayer(l)
    }
    tether.anchorPoint = .zero
    tether.zPosition = 3
    freeStickers.addSublayer(tether)
    // faded as one: cards over one another do not show through each other halfway
    cardLevel.allowsGroupOpacity = true
    summaryLayer.allowsGroupOpacity = true
    summaryLayer.isHidden = true
    // the ports and handles over Texts and Boxes too (main's .eport is over its card's face); faded with the card level
    for l in [cardLevel, kept, liftedLayer, chrome, guideLayer, summaryLayer, shelfHome, shelfDrag] {
      world.addSublayer(l)
    }
    guideLayer.fillColor = nil
    guideLayer.opacity = 0.9
    backdrop.anchorPoint = .zero
    root.addSublayer(backdrop)
    root.addSublayer(world)
    picture.anchorPoint = .zero
    picture.isHidden = true
    root.addSublayer(picture)
    marquee.fillColor = nil
    root.addSublayer(marquee)
    sizeHint.isHidden = true
    root.addSublayer(sizeHint)
    toastLayer.isHidden = true
    alignBar.isHidden = true
    alignMoreLayer.isHidden = true
    alignBar.addSublayer(alignMoreLayer)
    root.addSublayer(alignBar)
    root.addSublayer(toastLayer)
    stickerGhost.anchorPoint = .zero
    stickerGhost.isHidden = true
    root.addSublayer(stickerGhost)
    dock.isHidden = true
    dock.onPart = { [weak self] in self?.useDock($0) }
    addSubview(dock)
  }

  @available(*, unavailable)
  public required init?(coder: NSCoder) {
    fatalError("CanvasView is not loaded from nibs")
  }

  public override var isFlipped: Bool { true }
  public override var acceptsFirstResponder: Bool { true }

  /// Shows a board of the vault, fitted to the view. Returns once every item is on screen (each at least as its
  /// overview bitmap, so nothing is ever blank); a later call supersedes an earlier one still loading. Notes without a
  /// stored height are measured first (the renderer keeps what it measured with its snapshots), so no card moves once
  /// shown; a Note's overview is its picture when the snapshot cache has it, else its paper.
  public func show(_ board: VaultBoard, in vault: Vault, theme: Theme) async throws {
    try await load(board, in: vault, theme: theme, keepCamera: false)
  }

  /// Draws the board shown in another theme (or the same in the other appearance) where the camera is, once it rests:
  /// what is on screen stays until every item has its picture in the new look (a Note its paper, until the Note
  /// renderer has drawn it in that look)
  public func show(theme: Theme) async throws {
    await rest()
    guard let (board, vault) = shown, !theme.same(as: self.theme) else { return }
    try await load(board, in: vault, theme: theme, keepCamera: true)
    // an open shortcut list is drawn again in the new theme, where it was
    if keysPanel != nil {
      toggleKeys()
      toggleKeys()
    }
  }

  /// Waiting for the camera to come to rest
  var resting: [CheckedContinuation<Void, Never>] = []

  /// Returns once no gesture or glide moves the camera
  func rest() async {
    guard !motion.isResting else { return }
    await withCheckedContinuation { resting.append($0) }
  }

  /// The theme the canvas draws in
  public var currentTheme: Theme { theme }

  func load(_ board: VaultBoard, in vault: Vault, theme: Theme, keepCamera: Bool) async throws {
    // before its first board the canvas is its colour in the look it will show
    if scene == nil {
      self.theme = theme
      layer?.backgroundColor = theme.canvas
    }
    loads += 1
    // a refresh under way is of what this load replaces
    refreshes += 1
    let load = loads
    if !keepCamera {
      opening = true
      showPicture(board, in: vault, theme: theme)
    }
    defer { if load == loads { opening = false } }
    let size =
      bounds.isEmpty ? (window?.screen ?? NSScreen.main)?.frame.size ?? CGSize(width: 1440, height: 900) : bounds.size
    let backing = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
    let images = self.images
    let known = CanvasView.highlighter
    let display = self.display
    let open = document?.board
    let sources = open.map(sourceInfo) ?? [:]
    let calls = open.map(callInfo) ?? [:]
    // where the camera will be once it is installed (install: arriving, else kept, else the board's top left at 100 %)
    let opensAt = keepCamera ? camera : arriving ?? keptCamera(of: board, in: vault)
    let hold = loadHold
    let work = Task.detached(priority: .userInitiated) {
      await hold?()
      let package = vault.url(of: board.path)
      let b = try open ?? vault.board(at: board.path)
      let measures = Scene.measures(b, package: package, vault: vault, sources: sources)
      let sizes = await CanvasView.measure(measures, theme: theme, display: display)
      display.prepare(
        CanvasView.inView(measures, of: b, sizes: sizes, camera: opensAt, size: size, theme: theme, backing: backing))
      let inlines = Scene.inlineMeasures(b, package: package, vault: vault, theme: theme)
      let inline = await CanvasView.measureInline(inlines, theme: theme, display: display)
      // the Note display's, compiled as the app starts: one in the app
      let highlighter = known ?? NativeNotes.highlighter
      let scene = Scene(
        b, package: package, vault: vault, theme: theme, highlighter: highlighter, sizes: sizes, inline: inline,
        sources: sources, calls: calls)
      let fit = Camera.fit(scene.bounds, in: size).zoom
      let limits = ZoomLimits(view: size, content: scene.bounds)
      let first =
        opensAt.map { Camera(origin: $0.origin, zoom: limits.clamp($0.zoom)) } ?? Camera.opening(scene.bounds)
      let firstView = first.visible(size)
      let overviews = await withTaskGroup(of: (Int, Overview).self) { g in
        for (i, it) in scene.items.enumerated() {
          g.addTask {
            let inView = it.rect.insetBy(dx: -it.bleed, dy: -it.bleed).intersects(firstView)
            // in view: at the zoom it opens at, sharp from the first frame, rather than the board's overview size
            // enlarged until its own bitmap comes
            let opening = Levels.scale(
              inView ? max(fit, min(first.zoom, limits.max)) : fit, backing: backing, size: it.bitmapSize)
            guard it.drawing.byRenderer else {
              return (i, (CanvasView.render(it, scale: opening, theme: theme, images: images).surface, opening, .drawn))
            }
            // A Note drawn natively is drawn now when in view, as the other items are: shown with its paper alone it
            // would read as blank until its picture came. Out of view its overview is the one kept on disk, else its
            // paper at first, and the queue draws it right after the board shows (RestPlan), so the board does not
            // wait for every Note's
            if inView,
              let snap = await CanvasView.picture(it, scale: opening, theme: theme, display: display, priority: 1),
              let drawn = CanvasView.compose(it, snap, scale: opening, theme: theme, images: images)
            {
              return (i, (drawn, opening, .drawn))
            }
            let s = Levels.noteOverview(fit, backing: backing, size: it.bitmapSize)
            // only from the disk cache here
            if let snap = await CanvasView.picture(it, scale: s, theme: theme, display: display, priority: nil),
              let drawn = CanvasView.compose(it, snap, scale: s, theme: theme, images: images)
            {
              return (i, (drawn, s, .drawn))
            }
            return (i, (CanvasView.render(it, scale: s, theme: theme, images: images).surface, s, .paper))
          }
        }
        var out = [Overview](repeating: (nil, 1, .drawn), count: scene.items.count)
        for await (i, o) in g { out[i] = o }
        return out
      }
      // drawn here once, so installing it on the main thread finds it ready
      _ = theme.backdrop.flatMap(Backdrop.image)
      return (scene, overviews, CanvasView.shadow(theme), highlighter, b, measures, sizes, inlines, inline)
    }
    // the board left is kept where it was (and as it was), also when its camera never came to rest: while the new one
    // is read and laid out, as its picture takes the main thread tens of milliseconds
    if !keepCamera { self.keepCamera(now: true) }
    let (scene, overviews, shadow, highlighter, b, measures, sizes, inlines, inline) = try await work.value
    CanvasView.highlighter = highlighter
    guard load == loads else { return }
    shownBoard = b
    measured = [:]
    for m in measures { if let size = sizes[m.card] { measured[m.card] = (m.note, m.width, m.preamble, size) } }
    measuredInline = [:]
    for m in inlines {
      if let id = m.sidenote, let size = inline[id] { measuredInline[id] = (m.note, m.width, size) }
    }
    // the same board in another look: swapped in at rest, as a gesture may have started while it was drawn
    if keepCamera {
      await rest()
      guard load == loads else { return }
    }
    let other = shown?.board.id != board.id
    shown = (board, vault)
    install(scene, overviews: overviews, shadow: shadow, theme: theme, keepCamera: keepCamera)
    if other { boardOpened(now: clock()) }
    askSourcePictures()
    if keepCamera { showCrumbs() } else { boardArrived() }
    // its pictures at web addresses: read now, or already kept from before (then drawn at once)
    let kept = remotePictures.count
    fetchPictures(b)
    if remotePictures.count > kept { refresh() }
  }

  /// The Notes of a board that will be in view where it opens, nearest the middle first, from where its cards are
  /// (`camera`, else its top left at 100 % as Camera.opening puts it, of the cards alone): for drawing them ahead, with
  /// their stored heights and the scale the board opens them at unless its zoom is clamped (the overview's `opening`)
  nonisolated static func inView(
    _ ms: [Scene.Measure], of b: Board, sizes: [CardID: NoteMetrics], camera: Camera?, size: CGSize, theme: Theme,
    backing: CGFloat
  ) -> [(note: NoteSizeRequest, height: Double?, scale: Double)] {
    var at: [CardID: CGPoint] = [:]
    var stored: [CardID: Double] = [:]
    for c in b.cards {
      at[c.id] = CGPoint(x: c.x, y: c.y)
      stored[c.id] = c.height
    }
    let corner = CGPoint(x: at.values.map(\.x).min() ?? 0, y: at.values.map(\.y).min() ?? 0)
    let view = (camera ?? Camera.opening(CGRect(origin: corner, size: CGSize(width: 1, height: 1)))).visible(size)
    let mid = CGPoint(x: view.midX, y: view.midY)
    let zoom = camera?.zoom ?? 1
    return ms.compactMap { m -> (CGFloat, (NoteSizeRequest, Double?, Double))? in
      guard m.sidenote == nil, m.width > 0, let p = at[m.card],
        let h = stored[m.card] ?? sizes[m.card].map({ Double($0.size.height) })
      else { return nil }
      let r = CGRect(x: p.x, y: p.y, width: m.width, height: h)
      guard r.intersects(view) else { return nil }
      let request = NoteSizeRequest(
        note: m.note, width: m.width, folder: m.folder, look: theme.id.rawValue, dark: theme.dark, refs: m.refs,
        hideHead: m.hideHead, preamble: m.preamble)
      // its bitmap's size without the shadow's bleed: only a Note too big for the zoom's scale is capped by it
      let scale = Levels.scale(zoom, backing: backing, size: r.size)
      return (hypot(r.midX - mid.x, r.midY - mid.y), (request, stored[m.card], Double(scale)))
    }.sorted { $0.0 < $1.0 }.map(\.1)
  }

  /// The sizes the Note renderer gives the Notes without a stored height: from what it kept, else measured in the web
  /// view all together. A Note it could not measure is left out (`Scene` gives it a height of its own)
  nonisolated static func measure(_ ms: [Scene.Measure], theme: Theme, display: any NoteDisplay) async -> [CardID:
    NoteMetrics]
  {
    var out: [CardID: NoteMetrics] = [:]
    let sizes = await metrics(ms, theme: theme, display: display)
    for (m, s) in zip(ms, sizes) { if let s { out[m.card] = s } }
    return out
  }

  /// The heights of the Always Show sidenotes in code cards (`Scene.inlineMeasures`), measured as `measure` does
  nonisolated static func measureInline(_ ms: [Scene.Measure], theme: Theme, display: any NoteDisplay) async
    -> [SidenoteID:
    NoteMetrics]
  {
    var out: [SidenoteID: NoteMetrics] = [:]
    let sizes = await metrics(ms, theme: theme, display: display)
    for (m, s) in zip(ms, sizes) { if let id = m.sidenote, let s { out[id] = s } }
    return out
  }

  private nonisolated static func metrics(_ ms: [Scene.Measure], theme: Theme, display: any NoteDisplay) async
    -> [NoteMetrics?]
  {
    guard !ms.isEmpty else { return [] }
    let requests = ms.map {
      NoteSizeRequest(
        note: $0.note, width: $0.width, folder: $0.folder, look: theme.id.rawValue, dark: theme.dark, refs: $0.refs,
        hideHead: $0.hideHead, preamble: $0.preamble)
    }
    // before any picture: the board waits for these
    let sizes = try? await display.metrics(of: requests, priority: 1)
    return sizes ?? []
  }

  // MARK: Layers

  /// An item's overview bitmap, its scale, and whether a Note's is its picture or its paper
  typealias Overview = (surface: IOSurface?, scale: CGFloat, face: NoteFace)

  /// An item's layers: its shadow (framed cards), the held bitmap and the rest bitmap over it
  @MainActor final class ItemLayers {
    let box = CALayer()
    let held = CALayer()
    let rest = CALayer()
    var overview: IOSurface?
    let overviewScale: CGFloat
    /// The held slot's own bitmap; nil: it shows the overview
    var heldSurface: IOSurface?
    var heldScale: CGFloat
    var restScale: CGFloat?
    let note: Bool
    var face: NoteFace
    let bleed: CGFloat

    init(_ item: Scene.Item, overview o: Overview, shadow: (IOSurface, margin: CGFloat)?) {
      overview = o.surface
      overviewScale = o.scale
      bleed = item.bleed
      face = o.face
      note = item.drawing.byRenderer
      heldScale = o.scale
      let r = item.rect
      box.bounds = CGRect(origin: .zero, size: r.size)
      box.position = CGPoint(x: r.midX, y: r.midY)
      if item.tilt != 0 {
        box.setAffineTransform(CGAffineTransform(rotationAngle: item.tilt))
        box.allowsEdgeAntialiasing = true
      }
      if let shadow { box.addSublayer(CanvasView.shadowLayer(shadow, around: box.bounds)) }
      for l in [held, rest] {
        l.frame = box.bounds.insetBy(dx: -item.bleed, dy: -item.bleed)
        l.contentsGravity = .resize
        l.magnificationFilter = .linear
        box.addSublayer(l)
      }
      held.minificationFilter = .trilinear
      fill(held, overview, scale: o.scale)
      rest.minificationFilter = .linear
    }

    /// A slot's bitmap over as much of the board as its pixels cover at its scale (its sides are rounded up to whole
    /// pixels), not stretched over the item's own size: so at the zoom it was drawn for it is shown pixel for pixel,
    /// where the stretch by a fraction of a pixel would resample it all
    func fill(_ l: CALayer, _ s: IOSurface?, scale: CGFloat) {
      l.contents = s
      guard let s, scale > 0 else {
        l.frame = box.bounds.insetBy(dx: -bleed, dy: -bleed)
        return
      }
      let b = Raster.bleed(bleed, at: scale)
      let whole = box.bounds.insetBy(dx: -b, dy: -b)
      let covers = CGSize(width: CGFloat(s.width) / scale, height: CGFloat(s.height) / scale)
      // one drawn at another size (a picture of other proportions) stays stretched over the item
      let near = abs(covers.width - whole.width) * scale < 1.5 && abs(covers.height - whole.height) * scale < 1.5
      l.frame = near ? CGRect(origin: whole.origin, size: covers) : whole
    }

    /// What its bitmaps cover on the board
    var bitmapFrame: CGRect { box.frame.insetBy(dx: -bleed, dy: -bleed) }

    var bytes: Int { (overview?.allocationSize ?? 0) + sharpBytes }

    /// Its bitmaps but the overview
    var sharpBytes: Int { (heldSurface?.allocationSize ?? 0) + ((rest.contents as? IOSurface)?.allocationSize ?? 0) }

    func showOverview() {
      guard face.mayShowOverview(holdsOwn: heldSurface != nil) else { return }
      fill(held, overview, scale: overviewScale)
      heldSurface = nil
      heldScale = overviewScale
      coverHeld()
    }

    /// A finished redraw into one of its slots; a Note's first picture fades in
    func take(_ job: RestPlan.Job, _ s: IOSurface) {
      let fades = job.note && face.picture(overview: job.slot == .overview)
      switch job.slot {
      case .held:
        if fades { CanvasView.fadeIn(held, over: held.contents) }
        fill(held, s, scale: job.scale)
        heldSurface = s
        heldScale = job.scale
      case .rest:
        if fades { CanvasView.fadeIn(rest, over: rest.contents) }
        fill(rest, s, scale: job.scale)
        restScale = job.scale
      case .overview:
        overview = s
        if heldSurface == nil {
          if fades { CanvasView.fadeIn(held, over: held.contents) }
          fill(held, s, scale: job.scale)
        }
      }
      coverHeld()
    }

    /// The rest bitmap is the whole item at the zoom: where the item is transparent (a frameless Note, an image, a label)
    /// the held bitmap under it would add its text a second time and make it look bold. Only a Note's paper stays under
    /// it, for its first picture to fade in over
    private func coverHeld() {
      held.isHidden = rest.contents != nil && (heldSurface != nil || !face.paperOverview)
    }

    func clearRest() {
      if let s = rest.contents as? IOSurface, let scale = restScale, face.keepsRest(holdsOwn: heldSurface != nil) {
        fill(held, s, scale: scale)
        heldSurface = s
        heldScale = scale
      }
      fill(rest, nil, scale: 0)
      restScale = nil
      coverHeld()
    }

    /// The highest scale it shows its picture at: 0 while a Note shows only paper
    var pictureScale: CGFloat {
      max(heldSurface != nil ? heldScale : face.paperOverview ? 0 : overviewScale, restScale ?? 0)
    }
  }

  func install(
    _ s: Scene, overviews: [Overview], shadow: (IOSurface, margin: CGFloat)?, theme: Theme, keepCamera: Bool
  ) {
    cancelRedraws()
    endInPlace(commit: true)
    fieldShown()
    self.theme = theme
    cardShadow = shadow
    scene = s
    routedArrows = [:]
    tidySlide = nil
    hoveredArrow = nil
    mode = nil
    dropLit = []
    withoutAnimation {
      layer?.backgroundColor = theme.canvas
      backdropImage = theme.backdrop.flatMap(Backdrop.image)
      backdrop.contents = backdropImage
      placeBackdrop()
      for l in [sections, dropLayer, below, arrows, above, cards, kept, liftedLayer] { l.sublayers = nil }
      for f in s.frames { sections.addSublayer(CanvasView.frameLayer(f, theme)) }
      items = s.items.enumerated().map { i, it in
        ItemLayers(it, overview: overviews[i], shadow: it.drawing.framed ? shadow : nil)
      }
      for (i, l) in items.enumerated() { home(of: i, in: s).addSublayer(l.box) }
      // cards let go a moment ago go on landing in their new layers
      relanding()
      arrowGroups = s.arrows.map { a in
        let ls = CanvasView.arrowLayers(a, theme)
        for l in ls { arrows.addSublayer(l) }
        return ls
      }
    }
    let view = bounds.isEmpty ? CGSize(width: 1440, height: 900) : bounds.size
    fitZoom = Camera.fit(s.bounds, in: view).zoom
    limits = ZoomLimits(view: view, content: s.bounds)
    motion = Motion()
    restZoom = nil
    hoveredMark = nil
    // the summary cut first: the level shown at the zoom it opens at depends on it
    summariesChanged()
    if !keepCamera {
      camera = arriving ?? storedCamera ?? Camera.opening(s.bounds)
      cameraKept = camera
      arriving = nil
      levels.show(zoom: camera.zoom)
    }
    applyLevels(levels.frame(at: now))
    applyCamera()
    arrive()
    // another board: its popup goes; the same one drawn again (another theme): it follows
    if openPop != nil, !keepCamera { openPop(nil) }
    placeMarks()
    if openPop != nil { refreshPop() }
    if listShown, !keepCamera { closeQuestionList() }
    welcomeHint.theme = theme
    if !keepCamera {
      subPreviews = SubPreviews()
      closeWelcome()
      closeChip()
      cancelPlacing()
      closeStickerPalette()
      closeShelf()
      shelfPictures = [:]
    }
    shelfChanged()
    questionsChanged()
    subPreviewsChanged()
    drawChrome()
  }

  /// The layer an item's box goes in: Section titles below the cards, arrow labels above them, sub-boards, Texts and Boxes
  /// on the kept layer over the card level (they stay at the summary level), the other cards in between
  func home(of i: Int, in s: Scene) -> CALayer {
    i < s.cardsFrom ? below : i >= s.labelsFrom ? above : s.items[i].kept ? kept : cards
  }

  /// The soft shadow under a framed card, nine-sliced onto every one: only the shadow, the card's own area left clear
  /// (a deckled sheet's torn edge must not show a card-shaped shadow fill through it)
  nonisolated static func shadow(_ t: Theme) -> (IOSurface, margin: CGFloat)? {
    let m: CGFloat = 80
    let k = t.shadowRadius
    let side = 2 * (m + max(k, t.cardRadius) + 1)
    let card = CGRect(x: m, y: m, width: side - 2 * m, height: side - 2 * m)
    let s = Raster.surface(size: CGSize(width: side, height: side), scale: 2) { ctx in
      Shadow.draw(t, card: card, scale: 2, in: ctx)
    }
    return s.map { ($0, m) }
  }

  /// The shadow nine-sliced round `r`
  static func shadowLayer(_ shadow: (IOSurface, margin: CGFloat), around r: CGRect) -> CALayer {
    let l = CALayer()
    l.frame = r.insetBy(dx: -shadow.margin, dy: -shadow.margin)
    l.contents = shadow.0
    l.contentsScale = 2
    let side = CGFloat(shadow.0.width) / 2
    l.contentsCenter = CGRect(x: (side / 2 - 1) / side, y: (side / 2 - 1) / side, width: 2 / side, height: 2 / side)
    return l
  }

  /// A Section's frame: a tray (fill, hairline, light inner top line) or the fill under its brush strokes
  static func frameLayer(_ f: Scene.Frame, _ t: Theme) -> CALayer {
    let l = CALayer()
    l.frame = f.rect
    l.backgroundColor = f.fill
    if let strokes = f.strokes {
      let brush = CAShapeLayer()
      brush.path = strokes.cg
      brush.fillColor = t.sectionEdge
      l.addSublayer(brush)
      return l
    }
    // the web's squircle corners, which Core Animation's own corner curves are not; folded, min(13.5, 10) (.sect.shut)
    let r = CGRect(origin: .zero, size: f.rect.size)
    let radius = f.folded ? min(t.sectionRadius, 10) : t.sectionRadius
    let tray = CAShapeLayer()
    tray.frame = f.rect
    tray.path = Drawing.squircle(r, radius)
    tray.fillColor = f.fill
    let top = CAShapeLayer()
    top.path = Shadow.innerTop(r.size, radius: radius)
    top.fillColor = t.sectionEdge
    let edge = CAShapeLayer()
    edge.path = Drawing.squircle(r.insetBy(dx: 0.25, dy: 0.25), radius - 0.25)
    edge.fillColor = nil
    edge.strokeColor = t.hair
    edge.lineWidth = 0.5
    tray.addSublayer(top)
    tray.addSublayer(edge)
    return tray
  }

  /// An arrow's layers: the filled line and heads, a dashed line, the dry brush. Core Animation scales filled paths as
  /// cheaply as stroked ones: each is one path rasterised by the render server at the zoom shown
  static func arrowLayers(_ a: Scene.Arrow, _ t: Theme) -> [CALayer] {
    var out: [CALayer] = []
    if !a.fill.isEmpty {
      let l = CAShapeLayer()
      l.path = a.fill.cg
      l.fillColor = a.color
      out.append(l)
    }
    if let p = a.stroke {
      let l = CAShapeLayer()
      l.path = p.cg
      l.fillColor = nil
      l.strokeColor = a.color
      l.lineWidth = a.width
      l.lineCap = .round
      l.lineDashPattern = [4, 4]
      out.append(l)
    }
    if let p = a.dry {
      let l = CAShapeLayer()
      l.path = p.cg
      l.fillColor = nil
      l.strokeColor = t.dryBrush
      l.lineWidth = 0.6
      l.lineCap = .round
      out.append(l)
    }
    if !a.heads.isEmpty {
      let l = CAShapeLayer()
      l.path = a.heads.cg
      l.fillColor = a.headColor
      l.strokeColor = a.headColor
      l.lineWidth = a.headStroke
      l.lineJoin = .round
      out.append(l)
    }
    return out
  }

  func placeBackdrop() {
    guard let img = backdropImage, !bounds.isEmpty else { return }
    backdrop.frame = CanvasView.backdropFrame(img, in: bounds.size)
  }

  /// The backdrop covers the view, its bottom on the view's bottom (CSS `center bottom / cover`); y-down. The shell
  /// draws it the same way where the canvas runs on under its chrome
  package static func backdropFrame(_ img: CGImage, in view: CGSize) -> CGRect {
    let k = max(view.width / CGFloat(img.width), view.height / CGFloat(img.height))
    let size = CGSize(width: CGFloat(img.width) * k, height: CGFloat(img.height) * k)
    return CGRect(
      x: (view.width - size.width) / 2, y: view.height - size.height, width: size.width, height: size.height)
  }

  func withoutAnimation(_ f: () -> Void) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    f()
    CATransaction.commit()
  }

  var backing: CGFloat { window?.backingScaleFactor ?? 2 }

  // MARK: Camera

  func applyCamera() {
    var m = CATransform3DIdentity
    m.m11 = camera.zoom
    m.m22 = camera.zoom
    m.m41 = -camera.origin.x * camera.zoom
    m.m42 = -camera.origin.y * camera.zoom
    // at rest on device pixels (settleOnPixels): the camera itself stays where it is
    if settledAt == camera {
      let b = backing
      m.m41 = (m.m41 * b).rounded() / b
      m.m42 = (m.m42 * b).rounded() / b
    }
    withoutAnimation {
      world.sublayerTransform = m
      if chrome.sublayers?.isEmpty == false { drawChrome() } else { placeAlignBar() }
      if editing != nil { cameraMovedWhileEditing() }
      if descWriting != nil { placeDesc() }
      if !pops.isEmpty { positionPop() }
      if refPeek != nil { placeRefPeek() }
      if summaryButtons.superlayer != nil {
        summaryButtons.setAffineTransform(CGAffineTransform(scaleX: 1 / camera.zoom, y: 1 / camera.zoom))
      }
      if summaryEditor != nil { placeSummaryEditor() }
      dock.zoom = camera.zoom
      // a label or title being written goes on where it is (Editable.tsx ends only on blur)
      if inPlace != nil { withoutAnimation { placeField() } }
      // a zoom (not a pan) away from the rest zoom: the held bitmaps take over, with mipmaps
      if let z = restZoom, z != camera.zoom {
        restZoom = nil
        for l in items {
          l.clearRest()
          l.held.minificationFilter = .trilinear
        }
        placeItems()
      }
      // the pointer at rest over what moved under it
      if let w = pointerInWindow { rehover(convert(w, from: nil)) }
    }
  }

  public override func setFrameSize(_ newSize: NSSize) {
    let unsized = bounds.isEmpty
    let same = frame.size == newSize
    super.setFrameSize(newSize)
    // a layout pass that changes no size (the window runs one after each committed transaction) changes nothing
    guard !same else { return }
    withoutAnimation { placeBackdrop() }
    placeShelf()
    placeWelcome()
    guard let scene, newSize.width > 0, newSize.height > 0 else { return }
    limits = ZoomLimits(view: newSize, content: scene.bounds)
    // shown before the view had a size: opened now
    if unsized {
      camera = storedCamera ?? Camera.opening(scene.bounds)
      cameraKept = camera
      levels.show(zoom: camera.zoom)
    }
    applyCamera()
    if motion.isResting { arrive() }
  }

  /// On screen: in a window, neither it nor a view it is in hidden. Only then does it draw
  var onScreen: Bool { window != nil && !isHiddenOrHasHiddenAncestor && !miniaturized }
  /// Its window in the Dock: nothing is drawn until it is back, then what is in view once
  var miniaturized = false
  /// The backing scale the items were last planned for at rest
  var restBacking: CGFloat?
  /// How long the window must stay put on a screen of another scale before the board is drawn again for it
  package var backingDelay = Duration.milliseconds(250)
  var backingSettle: Task<Void, Never>?

  /// On a screen of another scale (dragged across two, it changes back and forth): nothing now, one redraw once the
  /// window has stopped moving there
  public override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    backingChanged()
  }

  func backingChanged() {
    backingSettle?.cancel()
    let delay = backingDelay
    backingSettle = Task { [weak self] in
      try? await Task.sleep(for: delay)
      guard let self, !Task.isCancelled else { return }
      backingSettle = nil
      if scene != nil, restBacking != backing, motion.isResting { arrive() }
    }
  }

  @objc private func windowMoved() {
    if backingSettle != nil { backingChanged() }
  }

  @objc private func windowMiniaturized() {
    miniaturized = true
    cancelRedraws()
    link?.isPaused = true
  }

  @objc private func windowDeminiaturized() {
    miniaturized = false
    if scene != nil, motion.isResting { arrive() } else { wake() }
  }

  /// Hidden (its tab is not the one shown): what it was drawing is dropped, what it has stays
  public override func viewDidHide() {
    super.viewDidHide()
    cancelRedraws()
    dropEditing()
  }

  public override func viewDidUnhide() {
    super.viewDidUnhide()
    if motion.isResting && scene != nil { arrive() }
  }

  public override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    // Space let go while another window had the keys: its key up never comes here
    let center = NotificationCenter.default
    for (name, action) in [
      (NSWindow.didResignKeyNotification, #selector(windowResignedKey)),
      (NSWindow.didMoveNotification, #selector(windowMoved)),
      (NSWindow.didMiniaturizeNotification, #selector(windowMiniaturized)),
      (NSWindow.didDeminiaturizeNotification, #selector(windowDeminiaturized)),
    ] {
      center.removeObserver(self, name: name, object: nil)
      center.addObserver(self, selector: action, name: name, object: window)
    }
    miniaturized = window?.isMiniaturized == true
    link?.invalidate()
    link = nil
    watchWheel()
    guard window != nil else { return }
    let l = displayLink(target: self, selector: #selector(step(_:)))
    l.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
    l.add(to: .main, forMode: .common)
    l.isPaused = steppedClock != nil
    link = l
  }

  // MARK: Input

  public override func scrollWheel(with e: NSEvent) { _ = take(e, at: e.locationInWindow) }

  public override func magnify(with e: NSEvent) { _ = take(e, at: e.locationInWindow) }

  func scrollBoard(_ e: NSEvent) {
    // the system's momentum: the canvas glides on its own
    guard e.momentumPhase.isEmpty else { return }
    if e.modifierFlags.contains(.command) {
      let d = e.scrollingDeltaY * (e.hasPreciseScrollingDeltas ? 0.01 : 0.1)
      wheelZoom(
        by: d, precise: e.hasPreciseScrollingDeltas, at: convert(e.locationInWindow, from: nil), time: e.timestamp)
    } else {
      let k: CGFloat = e.hasPreciseScrollingDeltas ? 1 : 10
      scroll(
        by: CGVector(dx: e.scrollingDeltaX * k, dy: e.scrollingDeltaY * k), at: e.timestamp,
        began: !e.phase.isDisjoint(with: [.began, .mayBegin]), ended: !e.phase.isDisjoint(with: [.ended, .cancelled]))
    }
  }

  func pinchBoard(_ e: NSEvent) {
    pinch(
      by: 1 + e.magnification, around: convert(e.locationInWindow, from: nil), at: e.timestamp,
      began: e.phase.contains(.began), ended: !e.phase.isDisjoint(with: [.ended, .cancelled]))
  }

  package func scroll(by d: CGVector, at t: TimeInterval, began: Bool, ended: Bool) {
    if began || ended { Diag.event(began ? "pan.began" : "pan.ended", camera.diag) }
    motion.scroll(d, at: t, began: began, ended: ended, camera: &camera)
    moved()
  }

  package func pinch(by f: CGFloat, around p: CGPoint, at t: TimeInterval, began: Bool, ended: Bool) {
    if began || ended { Diag.event(began ? "pinch.began" : "pinch.ended", camera.diag) }
    let before = camera
    motion.pinch(by: f, at: p, time: t, began: began, ended: ended, limits: limits, camera: &camera)
    zoomStep(from: before, around: p, wheelNotch: false, at: t)
    moved()
  }

  /// ⌘-scroll by `d` (the zoom's logarithm); `precise`: a trackpad or Magic Mouse, else a mouse wheel's notches
  package func wheelZoom(by d: CGFloat, precise: Bool, at p: CGPoint, time t: TimeInterval) {
    let before = camera
    motion.wheelZoom(by: exp(d), at: p, time: t, limits: limits, camera: &camera)
    zoomStep(from: before, around: p, wheelNotch: !precise, at: t)
    moved()
  }

  /// A zoom gesture's step through the summary switch: held at the switch point while pushing or fading (原地)
  private func zoomStep(from before: Camera, around p: CGPoint, wheelNotch: Bool, at t: TimeInterval) {
    let z = levels.step(from: before.zoom, to: camera.zoom, wheelNotch: wheelNotch, at: t)
    guard z != camera.zoom else { return }
    var c = before
    c.zoom(to: z, at: p)
    camera = c
    motion.hold(zoom: z)
  }

  /// The two levels' opacities, set only when they change (opacity alone: nothing is drawn or laid out again)
  func applyLevels(_ o: (cards: CGFloat, summaries: CGFloat)) {
    let (c, s) = (Float(o.cards), Float(o.summaries))
    guard
      c != cardLevel.opacity || s != summaryLayer.opacity || cardLevel.isHidden != (c == 0)
        || summaryLayer.isHidden != (s == 0)
    else { return }
    withoutAnimation {
      for l in [cardLevel, chrome] {
        l.opacity = c
        l.isHidden = c == 0
      }
      summaryLayer.opacity = s
      summaryLayer.isHidden = s == 0
    }
    if levels.level != levelShown {
      levelShown = levels.level
      levelChanged()
    }
  }

  /// A glide stopped at once (by anything pressed in the window: `BoardWindow`); what is under the pointer is worked out
  /// again for the camera there
  func stopGlide() {
    guard case .glide = motion.phase else { return }
    motion.stopGlide(at: lastTick)
    if let w = pointerInWindow { rehover(convert(w, from: nil)) }
  }

  /// Input moved the camera: rest work is cancelled
  func moved() {
    gestureStarts += 1
    if !queue.isIdle || !tasks.isEmpty { cancelRedraws() }
    applyCamera()
    wake()
  }

  func cancelRedraws() {
    queue.cancel()
    for t in tasks.values { t.cancel() }
  }

  // MARK: Frames

  @objc private func step(_ l: CADisplayLink) {
    onFrame?(l)
    tick(at: l.timestamp)
  }

  /// One frame's work (the display link's; tests drive it themselves where the display sleeps and the link does not run)
  package func tick(at time: CFTimeInterval) {
    lastTick = max(lastTick, time)
    if rehoverDue {
      rehoverDue = false
      if let w = pointerInWindow { rehover(convert(w, from: nil)) }
    }
    var cam = camera
    let rested = motion.step(at: time, camera: &cam)
    if cam != camera {
      // the app's own move (a fly, a spring back): crossing the switch point cross-fades at once
      levels.moved(from: camera.zoom, to: cam.zoom)
      camera = cam
      applyCamera()
    }
    applyLevels(levels.frame(at: time))
    if rested { arrive() }
    if motion.isResting && !resting.isEmpty {
      let waiting = resting
      resting = []
      for w in waiting { w.resume() }
    }
    if motion.isResting && gesture == nil { pump() }
    if motion.isResting && queue.isIdle && worked {
      worked = false
      // decoding and drawing free large blocks that the allocator would otherwise keep, counted in the footprint
      DispatchQueue.global(qos: .utility).async { _ = malloc_zone_pressure_relief(nil, 0) }
    }
    glideNudge(at: time)
    stepFrameEase(at: time)
    pictureCheck()
    stepTidySlide(at: time)
    if motion.isResting && queue.isIdle && onFrame == nil && gesture == nil && !levels.isAnimating
      && frameEase.isEmpty && picture.isHidden && tidySlide?.started != true
    {
      link?.isPaused = true
    }
  }

  /// Where the board shown was last left on this machine (main camsOf), a camera not written yet first
  var storedCamera: Camera? {
    guard let (board, vault) = shown, let c = keptCamera(of: board, in: vault) else { return nil }
    return Camera(origin: c.origin, zoom: limits.clamp(c.zoom))
  }

  /// The camera a board was left at, its zoom not yet held to the board's limits
  func keptCamera(of board: VaultBoard, in vault: Vault) -> Camera? {
    if let k = cameraToKeep, k.board == board.id, k.vault.root == vault.root { return k.camera }
    guard let c = cameras?.cameras(for: vault)[board.id] else { return nil }
    return Camera(origin: CGPoint(x: c.x, y: c.y), zoom: c.zoom)
  }

  /// The camera come to rest is kept for the board, to open there next time: written once nothing has moved it for
  /// `cameraDelay`, and not while a gesture is under way; `now`: the board is being left (another board, its tab or
  /// window closed, the app quitting), written at once, where a gesture under way has it
  package func keepCamera(now: Bool = false) {
    if now { keepPicture() }
    if let (board, vault) = shown, let store = cameras, scene != nil, camera != cameraKept {
      cameraKept = camera
      cameraToKeep = (store, vault, board.id, camera)
    }
    guard cameraToKeep != nil else { return }
    cameraSave?.cancel()
    cameraSave = nil
    if now { return writeCamera() }
    let delay = cameraDelay
    cameraSave = Task { [weak self] in
      try? await Task.sleep(for: delay)
      guard let self, !Task.isCancelled else { return }
      if gesture != nil || !motion.isResting { keepCamera() } else { writeCamera() }
    }
  }

  private func writeCamera() {
    guard let k = cameraToKeep else { return }
    cameraToKeep = nil
    try? k.store.keep(
      [k.board: BoardCamera(x: k.camera.origin.x, y: k.camera.origin.y, zoom: k.camera.zoom)], for: k.vault)
  }

  /// At rest: what each item should hold now, within what the other canvases leave of the budget
  func arrive() {
    Diag.event("camera.rest", camera.diag)
    if scene != nil, onScreen { settleOnPixels() }
    keepCamera()
    guard scene != nil, onScreen else { return }
    restBacking = backing
    CanvasView.clock += 1
    shownAt = CanvasView.clock
    let others = CanvasView.all.allObjects.filter { $0 !== self }
    let held = others.map {
      BudgetShare.Other(
        overviews: $0.items.reduce(0) { $0 + ($1.overview?.allocationSize ?? 0) },
        sharp: $0.items.reduce(0) { $0 + $1.sharpBytes }, shown: $0.shownAt)
    }
    let pointer = window.map { camera.board(convert($0.mouseLocationOutsideOfEventStream, from: nil)) }
    let plan = RestPlan(
      items: items.map {
        RestPlan.Item(
          rect: $0.bitmapFrame, held: $0.heldScale, rest: $0.restScale, overview: $0.overviewScale, note: $0.note,
          overviewDrawn: !$0.face.paperOverview)
      },
      view: camera.visible(bounds.size), zoom: camera.zoom, backing: backing, pointer: pointer,
      budget: BudgetShare.planning(Levels.budget, others: held))
    for (other, keeps) in zip(others, BudgetShare.keeps(Levels.budget, others: held, used: plan.bytes)) where !keeps {
      other.dropSharp()
    }
    withoutAnimation {
      for i in plan.dropHeld { items[i].showOverview() }
      for i in plan.dropRest { items[i].clearRest() }
      let linear = Set(plan.linear)
      for (i, l) in items.enumerated() { l.held.minificationFilter = linear.contains(i) ? .linear : .trilinear }
    }
    restZoom = camera.zoom
    // the markers' strip and hit areas follow the zoom at rest
    if marksZoom != camera.zoom { placeMarks() }
    // the card being written in keeps its paper: the editor draws its text
    let writing = editingIndex
    queue.replace(with: plan.jobs.filter { $0.item != writing })
    restAfterEditingZoom()
    wake()
  }

  /// At rest every item's bitmaps start on a device pixel: Core Animation resamples a layer placed between two, which
  /// softens all of it (half a pixel off kept 55 % of a line of text's edge contrast at 100 % on a 2x screen, 44 % on a
  /// 1x one). The world's translation goes to the nearest device pixel (the camera itself does not move: what is
  /// pressed and where the board opens next are where they were), then each item that is not tilted is moved by what is
  /// left of its own position at this zoom: each by less than half a device pixel, with no animation. The camera moving
  /// takes the world's translation back, a zoom the items too (`placeItems`), and the next rest settles them again; a
  /// pan keeps the items' moves, as it moves everything by the same amount
  func settleOnPixels() {
    if settledAt != camera {
      settledAt = camera
      applyCamera()
    }
    placeItems(onPixels: camera.zoom * backing)
  }

  /// Each item's box where the scene has it, or (`onPixels`: device pixels per board unit) its corner moved to the
  /// nearest of them
  func placeItems(onPixels k: CGFloat? = nil) {
    guard let scene, scene.items.count == items.count else { return }
    func off(_ v: CGFloat) -> CGFloat { k.map { ((v * $0).rounded() - v * $0) / $0 } ?? 0 }
    // the cards Tidy Up is sliding are where the slide has them (it settles them when it ends)
    let slid = tidySlide?.started == true ? tidySlide?.from ?? [:] : [:]
    withoutAnimation {
      for (it, l) in zip(scene.items, items) where it.tilt == 0 && l.box.animation(forKey: "position") == nil {
        if case .card(let id)? = it.owner, slid[id] != nil { continue }
        let r = it.rect
        // the item's own corner: its bitmaps' bleed is whole pixels at the scale they are drawn for
        l.box.position = CGPoint(x: r.midX + off(r.minX), y: r.midY + off(r.minY))
      }
    }
  }

  /// Each frame at rest: start redraws up to the limit, swap in finished ones within the frame's budget
  func pump() {
    startRedraws()
    swapIn()
  }

  /// Redraws started up to the limit: each frame at rest, and as soon as one finishes (most of a Note's pictures take a
  /// few ms; a lane waiting for the next frame stood idle most of the time)
  func startRedraws() {
    guard let scene else { return }
    for (job, generation) in queue.start() {
      worked = true
      if !motion.isResting || gesture != nil {
        ruleBreaks.redraws += 1
        if job.note { ruleBreaks.noteRequests += 1 }
      }
      let item = scene.items[job.item]
      // a resource block's picture drawn sharper than the one held: a wider one asked for
      if case .image(let p) = item.drawing, let a = p.resource {
        askSourcePicture(a, pixels: Int((item.rect.width * job.scale).rounded(.up)))
      }
      let theme = self.theme
      let images = self.images
      let id = nextTask
      nextTask += 1
      let epoch = gestureStarts
      if job.note {
        let display = self.display
        let priority = nextNote
        nextNote -= 1
        tasks[id] = Task.detached(priority: .userInitiated) { [weak self] in
          let r = await CanvasView.drawNote(
            item, scale: job.scale, theme: theme, images: images, display: display, priority: priority)
          await self?.finished(
            job, generation: generation, surface: r.surface, decodes: 0, cancelled: r.late, epoch: epoch, task: id)
        }
      } else {
        tasks[id] = Task.detached(priority: .userInitiated) { [weak self] in
          let r = CanvasView.render(item, scale: job.scale, theme: theme, images: images)
          await self?.finished(
            job, generation: generation, surface: r.surface, decodes: r.decodes, cancelled: Task.isCancelled,
            epoch: epoch, task: id)
        }
      }
    }
  }

  /// Finished redraws swapped in within the frame's budget
  func swapIn() {
    let writing = editingIndex
    let view = camera.visible(bounds.size)
    let swaps = queue.takeSwaps { self.items[$0.job.item].bitmapFrame.intersects(view) }.filter {
      $0.job.item != writing
    }
    guard !swaps.isEmpty else { return }
    if !motion.isResting || gesture != nil {
      ruleBreaks.swaps += swaps.count
      ruleBreaks.noteSwaps += swaps.count { $0.job.note }
    }
    withoutAnimation {
      for s in swaps { items[s.job.item].take(s.job, s.payload) }
    }
    // a swap made in the display-link callback otherwise reaches the screen a frame later
    CATransaction.flush()
  }

  /// cancelled: it was cancelled while it drew (its result is dropped); counted against the gesture rule when a gesture
  /// began since it started (`epoch`), as the work ran on into the gesture
  func finished(
    _ job: RestPlan.Job, generation: Int, surface s: IOSurface?, decodes: Int, cancelled: Bool, epoch: Int, task: Int
  ) {
    tasks[task] = nil
    queue.finish(job, generation: generation, payload: s, pixels: s.map { $0.width * $0.height } ?? 0)
    if cancelled && gestureStarts != epoch {
      ruleBreaks.redraws += 1
      ruleBreaks.decodes += decodes
    }
    if motion.isResting && gesture == nil { startRedraws() }
    wake()
  }

  /// Fades the picture about to be set on `l` in over what it shows now (`old`), which stays under it until the fade is
  /// done: a crossfade would fade the old one out meanwhile, and halfway through the board would show through the card
  static func fadeIn(_ l: CALayer, over old: Any?) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    var under: CALayer?
    if let old, let parent = l.superlayer {
      let u = CALayer()
      u.frame = l.frame
      u.contents = old
      u.contentsGravity = l.contentsGravity
      u.magnificationFilter = l.magnificationFilter
      u.minificationFilter = l.minificationFilter
      parent.insertSublayer(u, below: l)
      under = u
    }
    CATransaction.setCompletionBlock { under?.removeFromSuperlayer() }
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = 0
    a.toValue = 1
    a.duration = 0.15
    l.add(a, forKey: "picture")
    CATransaction.commit()
  }

  /// The bitmap at a scale of an item the Note renderer draws (a Note, an SVG picture): its picture over its paper. No
  /// bitmap when cancelled (a gesture started: a picture the web view was drawing still finishes, into the renderer's
  /// cache) or when the renderer failed. late: cancelled while the paper was being drawn under the picture
  nonisolated static func drawNote(
    _ item: Scene.Item, scale: CGFloat, theme: Theme, images: DecodeCache, display: any NoteDisplay, priority: Int
  ) async -> (surface: IOSurface?, late: Bool) {
    guard !Task.isCancelled,
      let snap = await picture(item, scale: scale, theme: theme, display: display, priority: priority),
      !Task.isCancelled
    else { return (nil, false) }
    let s = compose(item, snap, scale: scale, theme: theme, images: images)
    return Task.isCancelled ? (nil, true) : (s, false)
  }

  /// The Note renderer's picture of an item it draws, at a scale; with no priority only from its disk cache
  nonisolated static func picture(
    _ item: Scene.Item, scale: CGFloat, theme: Theme, display: any NoteDisplay, priority: Int?
  ) async -> NoteSnapshot? {
    switch item.drawing {
    case .note(let n):
      let look = theme.id.rawValue
      guard let priority else {
        return await display.cached(
          of: n.content, width: item.rect.width, height: n.height, folder: n.folder, scale: scale, look: look,
          dark: theme.dark, refs: n.refs, hideHead: n.hideHead, preamble: n.preamble)
      }
      return try? await display.snapshot(
        of: n.content, width: item.rect.width, height: n.height, folder: n.folder, scale: scale, look: look,
        dark: theme.dark, refs: n.refs, hideHead: n.hideHead, preamble: n.preamble, priority: priority)
    case .image(let p):
      guard p.svg, let url = p.url else { return nil }
      let width = Int((item.rect.width * scale).rounded(.up))
      guard let priority else { return await display.cachedPicture(of: url, width: width, dark: theme.dark) }
      return try? await display.picture(of: url, width: width, dark: theme.dark, priority: priority)
    case .code(let c) where !c.inline.isEmpty:
      // each Always Show sidenote drawn by the renderer as a Note is, put where it goes in the card; none until all are
      var shots: [(NoteSnapshot, CGPoint)] = []
      for n in c.inline {
        let look = theme.id.rawValue
        let snap: NoteSnapshot?
        if let priority {
          snap = try? await display.snapshot(
            of: .inline(n.text), width: n.frame.width, height: nil, folder: n.folder, scale: scale, look: look,
            dark: theme.dark, refs: n.refs, hideHead: false, preamble: "", priority: priority)
        } else {
          snap = await display.cached(
            of: .inline(n.text), width: n.frame.width, height: nil, folder: n.folder, scale: scale, look: look,
            dark: theme.dark, refs: n.refs, hideHead: false, preamble: "")
        }
        guard let snap, !Task.isCancelled else { return nil }
        shots.append((snap, n.frame.origin))
      }
      guard
        let s = Raster.surface(
          size: item.rect.size, scale: scale,
          { ctx in
            for (snap, at) in shots {
              let px = snap.surface
              Raster.draw(
                px, in: CGRect(x: at.x, y: at.y, width: CGFloat(px.width) / scale, height: CGFloat(px.height) / scale),
                of: ctx)
            }
          })
      else { return nil }
      return NoteSnapshot(surface: s, size: item.rect.size)
    case .code, .label, .board, .web, .links:
      return nil
    }
  }

  /// The paper the canvas draws for the card, with the renderer's picture over it
  nonisolated static func compose(
    _ item: Scene.Item, _ snap: NoteSnapshot, scale: CGFloat, theme: Theme, images: DecodeCache
  ) -> IOSurface? {
    Raster.surface(size: item.rect.size, scale: scale, bleed: item.bleed) { ctx in
      _ = item.drawing.draw(
        in: ctx, size: item.rect.size, scale: scale, theme: theme, images: images, picture: snap.surface)
    }
  }

  /// Draws an item off the main thread: no bitmap when cancelled (a gesture started) or when it could not be made
  nonisolated static func render(_ item: Scene.Item, scale: CGFloat, theme: Theme, images: DecodeCache) -> (
    surface: IOSurface?, decodes: Int
  ) {
    guard !Task.isCancelled else { return (nil, 0) }
    var decodes = 0
    let s = Raster.surface(size: item.rect.size, scale: scale, bleed: item.bleed) { ctx in
      decodes = item.drawing.draw(in: ctx, size: item.rect.size, scale: scale, theme: theme, images: images)
    }
    return (Task.isCancelled ? nil : s, decodes)
  }

  // MARK: Measuring (CanvasBench)

  package var isResting: Bool { motion.isResting }
  package var isSettled: Bool { motion.isResting && queue.isIdle }
  package var zoom: CGFloat { camera.zoom }
  package var shownRect: CGRect { camera.visible(bounds.size) }
  package var boardBounds: CGRect { scene?.bounds ?? .zero }
  package var bitmapBytes: Int { items.reduce(0) { $0 + $1.bytes } }
  package var decodedBytes: Int { images.bytes }

  /// The Notes in view, those of them showing a picture and those showing it at display resolution; Notes whose
  /// overview is their picture, of all Notes
  package var noteProgress: (inView: Int, present: Int, sharp: Int, overviews: Int, notes: Int) {
    let view = camera.visible(bounds.size)
    let z = min(camera.zoom, limits.max)
    var p = (inView: 0, present: 0, sharp: 0, overviews: 0, notes: 0)
    for l in items where l.note {
      p.notes += 1
      if !l.face.paperOverview { p.overviews += 1 }
      let r = l.bitmapFrame
      guard r.intersects(view) else { continue }
      p.inView += 1
      let s = l.pictureScale
      if s > 0 { p.present += 1 }
      if s >= Levels.scale(z, backing: backing, size: r.size) * 0.98 { p.sharp += 1 }
    }
    return p
  }

  /// The items in view (by index): those showing something, those showing nothing at all, and the Notes showing only
  /// their paper (none of their text yet). Read only, for CanvasBench
  package var blankInView: (inView: Int, drawn: Set<Int>, empty: Set<Int>, paper: Set<Int>) {
    let view = camera.visible(bounds.size)
    var out = (inView: 0, drawn: Set<Int>(), empty: Set<Int>(), paper: Set<Int>())
    for (i, l) in items.enumerated() where l.bitmapFrame.intersects(view) {
      out.inView += 1
      if l.held.contents == nil && l.rest.contents == nil {
        out.empty.insert(i)
      } else if l.note && l.pictureScale == 0 {
        out.paper.insert(i)
      } else {
        out.drawn.insert(i)
      }
    }
    return out
  }

  /// The items in view (by index) showing a bitmap at the display's resolution (`sharp`) and those showing one below it,
  /// enlarged (`soft`); items showing nothing, or a Note only its paper, are in neither. Read only, for CanvasBench
  package var resolutionInView: (sharp: Set<Int>, soft: Set<Int>) {
    let view = camera.visible(bounds.size)
    let z = min(camera.zoom, limits.max)
    var out = (sharp: Set<Int>(), soft: Set<Int>())
    for (i, l) in items.enumerated() where l.bitmapFrame.intersects(view) {
      // what shows: the rest bitmap over the held one
      let shown: CGFloat? = l.rest.contents != nil ? l.restScale : l.held.contents != nil ? l.heldScale : nil
      guard let s = shown, !(l.note && l.pictureScale == 0) else { continue }
      if s >= Levels.scale(z, backing: backing, size: l.bitmapFrame.size) * 0.98 {
        out.sharp.insert(i)
      } else {
        out.soft.insert(i)
      }
    }
    return out
  }

  /// Of the items in view: those whose bitmap's top left falls between device pixels (resampled: softened by up to half a
  /// pixel) and those whose size caps their bitmap below the display's resolution (Levels.cap: enlarged). For CanvasBench
  package var placementInView: (inView: Int, between: Int, capped: Int) {
    let view = camera.visible(bounds.size)
    let z = min(camera.zoom, limits.max)
    var out = (inView: 0, between: 0, capped: 0)
    let t = world.sublayerTransform
    for l in items where l.bitmapFrame.intersects(view) {
      out.inView += 1
      let o = CGPoint(x: t.m41 + l.bitmapFrame.minX * t.m11, y: t.m42 + l.bitmapFrame.minY * t.m22)
      let (x, y) = (o.x * backing, o.y * backing)
      if abs(x - x.rounded()) > 0.02 || abs(y - y.rounded()) > 0.02 { out.between += 1 }
      if Levels.cap(l.bitmapFrame.size) < z * backing * 0.98 { out.capped += 1 }
    }
    return out
  }

  /// Anything in view drawn below display resolution
  package var lowRes: Bool {
    let view = camera.visible(bounds.size)
    let z = min(camera.zoom, limits.max)
    return items.contains { l in
      let r = l.bitmapFrame
      guard r.intersects(view) else { return false }
      return max(l.heldScale, l.restScale ?? 0) < Levels.scale(z, backing: backing, size: r.size) * 0.98
    }
  }

  /// The centre of the card nearest a board point: a zoom around empty canvas would measure nothing
  package func cardCentre(nearest p: CGPoint) -> CGPoint? {
    func distance(_ r: CGRect) -> CGFloat {
      hypot(max(r.minX - p.x, 0, p.x - r.maxX), max(r.minY - p.y, 0, p.y - r.maxY))
    }
    let cards = scene?.items.filter { if case .label = $0.drawing { false } else { true } } ?? []
    return cards.min { distance($0.rect) < distance($1.rect) }.map { CGPoint(x: $0.rect.midX, y: $0.rect.midY) }
  }

  /// Every item back to its overview (a hidden canvas giving its room to the one on screen; CanvasBench: Note
  /// throughput from cold)
  package func dropSharp() {
    cancelRedraws()
    withoutAnimation {
      for l in items {
        l.clearRest()
        l.showOverview()
      }
    }
  }

  /// Jumps to a zoom with the board point `centre` in the middle of the view, at rest
  package func place(zoom: CGFloat, centre: CGPoint) {
    let z = limits.clamp(zoom)
    // a jump, not a move: its level at once
    levels.show(zoom: z)
    camera = Camera(origin: CGPoint(x: centre.x - bounds.width / 2 / z, y: centre.y - bounds.height / 2 / z), zoom: z)
    motion = Motion()
    applyLevels(levels.frame(at: now))
    cancelRedraws()
    applyCamera()
    arrive()
  }
}

/// A window boards are shown in. Anything pressed in it (any mouse button, a key) and fingers put on the trackpad stop
/// its boards' glides before the event goes on, whatever view it goes to: the canvas, what floats over it, a web view
/// on it or a field that takes the press for itself (main: any input stops the board where it is)
open class BoardWindow: NSWindow {
  open override func sendEvent(_ e: NSEvent) {
    if BoardWindow.stopsGlide(e), let v = contentView?.superview ?? contentView { BoardWindow.stopGlides(in: v) }
    // A press while an input method composes commits what it shows first, as a text view does: the Markdown editor
    // takes a press against its source, which does not have the marked text yet
    if [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(e.type),
      let v = firstResponder as? NSView, let client = v as? NSTextInputClient, client.hasMarkedText()
    {
      client.unmarkText()
      v.inputContext?.discardMarkedText()
    }
    super.sendEvent(e)
  }

  static func stopsGlide(_ e: NSEvent) -> Bool {
    switch e.type {
    case .leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .smartMagnify: true
    case .scrollWheel: !e.phase.isDisjoint(with: [.mayBegin, .began])
    case .magnify: e.phase.contains(.began)
    default: false
    }
  }

  @MainActor static func stopGlides(in v: NSView) {
    if let c = v as? CanvasView { c.stopGlide() }
    for s in v.subviews { stopGlides(in: s) }
  }
}

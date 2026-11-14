import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import QuartzCore

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
  /// Pictures decoded for drawing, by file: one cache for every canvas, as tabs often show the same images
  static let sharedImages = DecodeCache(cap: 128 << 20)
  /// Every canvas alive, for the one budget they share
  static let all = NSHashTable<CanvasView>.weakObjects()
  static var clock = 0
  /// When it was last on screen and at rest (the clock's time)
  var shownAt = 0
  let notes: NoteRenderer
  var theme = Theme.warmInk
  /// The board shown, to show again in another theme
  var shown: (board: VaultBoard, vault: Vault)?
  var scene: Scene?
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
  /// The summary level's columns (CanvasSummaries.swift)
  let summaryLayer = CALayer()
  /// Which level is shown and how it changes (SummaryLevels.swift)
  var levels = SummaryLevels()
  var camera = Camera(origin: .zero, zoom: 1)
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
  var limits = ZoomLimits(fit: 1)
  var motion = Motion()
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
  let images = CanvasView.sharedImages
  /// Made by the first board shown, off the main thread (compiling its queries takes tens of milliseconds and as many
  /// megabytes), and kept for every canvas
  static var highlighter: Highlighter?

  /// Called at the start of every display-link frame, before the canvas moves (CanvasBench drives and measures from it).
  /// While set, the display link never pauses
  package var onFrame: ((CADisplayLink) -> Void)? {
    didSet { link?.isPaused = false }
  }
  // MARK: Editing state (CanvasEditing.swift)

  /// The open board this canvas edits; nil: it only shows a board read from the vault
  var document: BoardDocument?
  var stopObserving: (() -> Void)?
  /// The board the scene was made from
  var shownBoard: Board?
  /// What the Note renderer measured, by card, with what it measured: a later scene measures only what changed
  var measured: [CardID: (note: NoteBody, width: Double, size: NoteMetrics)] = [:]
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
  var editingOriginal: ItemLayers?
  /// The editor showing itself at rest at a new zoom
  var editingRests: Task<Void, Never>?
  var editingEnds: Task<Void, Never>?
  /// The floating bar's bitmap and what it shows
  var barImage: (key: String, image: CGImage)?
  /// The Text or Box raised over its neighbours (its item index)
  var raised: Int?
  /// The latest refresh (tests wait for it)
  package var refreshing: Task<Void, Never>?
  /// Selection rings, handles: over the cards, in board units
  let chrome = CALayer()
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
  var hoveredLine: Endpoint?
  var hoveredPort: Port?
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
  /// Sidenote markers free on the board (a card's and a Section's are in their own layers)
  let freeMarks = CALayer()
  /// Stickers free on the board, over the cards (a card's are in its own layer), as laid out, their layers in order
  let freeStickers = CALayer()
  var stickerSpots: [StickerSpot] = []
  var stickerLayers: [CALayer] = []
  /// The glyph picked in the palette, following the pointer (its ghost, in the view's units) until a click
  package var placing: Sticker.Glyph?
  let stickerGhost = CALayer()
  package var stickerPalette: StickerPalette?
  /// The Shelf: its button, its panel, the entry shown large, the pictures drawn of each entry, what flies in, the
  /// outline of where a hovered entry returns and of one dragged out (board units)
  package var shelfDock: ShelfDock?
  package var shelfPanel: ShelfPanel?
  package var shelfPreview: ShelfPreview?
  package var previewing: String?
  package var shelfPictures: [String: (key: ShelfPictureKey, image: CGImage)] = [:]
  var shelfFlights: [CALayer] = []
  package var shelfHovered: String?
  let shelfHome = CALayer()
  let shelfDrag = CALayer()
  /// How a Web card's page is read and opened (tests give their own: never the network or a browser)
  package var fetchPage: WebFetch = WebFetcher.live
  package var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
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
  /// The sidenote popup open, by what it shows
  var openPop: PopAt?
  /// A sidenote popup opened or closed (tests)
  package var onPop: ((PopAt?) -> Void)?
  /// What the popup web view shows (kept until it lets it go: what a closing ends is still added there), the key it
  /// shows it under, and the [[ list for its inputs
  var popShown: PopAt?
  var popKey = ""
  var popRefList: RefCandidates?
  /// Dragged away: its top left from its marker's, in board units
  package var popHeld: CGVector?
  /// Its top left in the view now, and where a drag of it began
  package var popAt = CGPoint.zero
  var popDragFrom: CGPoint?
  /// The dashed line back to the marker of a popup dragged away, in the view's units
  let popLine = CAShapeLayer()
  /// The popup's showing and updating, one after another
  var popTask: Task<Void, Never>?
  /// The open questions the toolbar was told of; the question list open, under the toolbar button at that rect, with
  /// the other boards' questions it lists
  var shownQuestions = -1
  package var listShown = false
  var listButton = CGRect.zero
  var listOthers: [(VaultBoard, [QuestionListView.Shown.Item])] = []
  /// How many of this board's questions are open, as it changes (the toolbar's ?); the list opened or closed
  public var onQuestions: ((Int) -> Void)?
  public var onListOpen: ((Bool) -> Void)?
  /// A question on another board picked in the list: that board is to open and go to it
  /// Another board to open, and what to go to on it once shown
  public var onOpenBoard: ((BoardID, Arrival?) -> Void)?
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
  /// The zoom as the camera moves (the toolbar's figure)
  public var onZoom: ((CGFloat) -> Void)?
  /// Lines selected by their numbers in a code card
  package var lineSel: Lines?
  /// A free marker pressed (its index in `marks`), where, and whether it has moved; what it would land on, tinted
  var markDrag: (index: Int, from: CGPoint, moved: Bool)?
  var dropAim: CALayer?
  /// The selected and hovered arrows in the accent: over the arrows, under their labels
  let litArrows = CALayer()
  var dropLit: Set<SectionID> = []
  /// The zoom that fits the board, which overviews are drawn for
  var fitZoom: CGFloat = 1
  /// The framed cards' shadow, made once per theme
  var cardShadow: (IOSurface, margin: CGFloat)?
  /// Where Copy writes and Paste reads; tests give their own
  package var pasteboard = NSPasteboard.general
  /// Each Text's narrowest width (its longest word), once measured
  var leastWidths: [CardID: CGFloat] = [:]
  /// Arrow keys held for the nudge under way
  var nudging: Set<UInt16> = []
  /// Where the last paste went, to step the next one on
  var lastPaste: (clip: Data, dx: Double, dy: Double)?

  /// Work begun while a gesture was active; the gesture rule says all stay 0
  package private(set) var ruleBreaks = (redraws: 0, decodes: 0, swaps: 0, noteRequests: 0, noteSwaps: 0)

  public convenience override init(frame: NSRect) {
    self.init(frame: frame, notes: CanvasView.sharedNotes)
  }

  /// With a Note renderer of its own, its snapshots cached in `noteCache` (CanvasBench and tests: not the app's cache)
  package convenience init(frame: NSRect, noteCache: URL) {
    self.init(frame: frame, notes: NoteRenderer(cache: noteCache))
  }

  /// With that Note renderer (CanvasBench: one for several canvases, as the app's)
  package init(frame: NSRect, notes: NoteRenderer) {
    self.notes = notes
    super.init(frame: frame)
    CanvasView.all.add(self)
    registerForDraggedTypes([.string])
    // layer-hosting: the canvas owns its layer tree, y-down like the board
    let root = CALayer()
    root.isGeometryFlipped = true
    // never transparent before the first board: whatever is behind would show for a frame
    root.backgroundColor = theme.canvas
    layer = root
    wantsLayer = true
    for l in [
      world, cardLevel, kept, summaryLayer, sections, dropLayer, below, arrows, litArrows, above, cards, freeStickers,
      freeMarks, shelfHome, shelfDrag, chrome,
    ] {
      l.anchorPoint = .zero
    }
    for l in [sections, dropLayer, below, arrows, litArrows, above, cards, freeStickers, freeMarks, chrome] {
      cardLevel.addSublayer(l)
    }
    // faded as one: cards over one another do not show through each other halfway
    cardLevel.allowsGroupOpacity = true
    summaryLayer.allowsGroupOpacity = true
    summaryLayer.isHidden = true
    for l in [cardLevel, kept, summaryLayer, shelfHome, shelfDrag] { world.addSublayer(l) }
    backdrop.anchorPoint = .zero
    root.addSublayer(backdrop)
    root.addSublayer(world)
    marquee.fillColor = nil
    root.addSublayer(marquee)
    toastLayer.isHidden = true
    root.addSublayer(toastLayer)
    stickerGhost.anchorPoint = .zero
    stickerGhost.isHidden = true
    root.addSublayer(stickerGhost)
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
    let size =
      bounds.isEmpty ? (window?.screen ?? NSScreen.main)?.frame.size ?? CGSize(width: 1440, height: 900) : bounds.size
    let backing = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
    let images = self.images
    let known = CanvasView.highlighter
    let notes = self.notes
    let open = document?.board
    let (scene, overviews, shadow, highlighter, b, measures, sizes) = try await Task.detached(
      priority: .userInitiated
    ) {
      let package = vault.url(of: board.path)
      let b = try open ?? vault.board(at: board.path)
      let measures = Scene.measures(b, package: package, vault: vault)
      let sizes = await CanvasView.measure(measures, theme: theme, notes: notes)
      let highlighter = known ?? Highlighter()
      let scene = Scene(b, package: package, vault: vault, theme: theme, highlighter: highlighter, sizes: sizes)
      let fit = Camera.fit(scene.bounds, in: size).zoom
      let overviews = await withTaskGroup(of: (Int, Overview).self) { g in
        for (i, it) in scene.items.enumerated() {
          g.addTask {
            guard it.drawing.byRenderer else {
              let s = Levels.scale(fit, backing: backing, size: it.bitmapSize)
              return (i, (CanvasView.render(it, scale: s, theme: theme, images: images).surface, s, .drawn))
            }
            let s = Levels.noteOverview(fit, backing: backing, size: it.bitmapSize)
            if let snap = await CanvasView.picture(it, scale: s, theme: theme, notes: notes, priority: nil),
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
      return (scene, overviews, CanvasView.shadow(theme), highlighter, b, measures, sizes)
    }.value
    CanvasView.highlighter = highlighter
    guard load == loads else { return }
    shownBoard = b
    measured = [:]
    for m in measures { if let size = sizes[m.card] { measured[m.card] = (m.note, m.width, size) } }
    // the same board in another look: swapped in at rest, as a gesture may have started while it was drawn
    if keepCamera {
      await rest()
      guard load == loads else { return }
    }
    shown = (board, vault)
    install(scene, overviews: overviews, shadow: shadow, theme: theme, keepCamera: keepCamera)
  }

  /// The sizes the Note renderer gives the Notes without a stored height: from what it kept, else measured in the web
  /// view all together. A Note it could not measure is left out (`Scene` gives it a height of its own)
  nonisolated static func measure(_ ms: [Scene.Measure], theme: Theme, notes: NoteRenderer) async -> [CardID:
    NoteMetrics]
  {
    let requests = ms.map {
      NoteRenderer.SizeRequest(
        note: $0.note, width: $0.width, folder: $0.folder, look: theme.id.rawValue, dark: theme.dark, refs: $0.refs)
    }
    // before any picture: the board waits for these
    let sizes = (try? await notes.metrics(of: requests, priority: 1)) ?? []
    var out: [CardID: NoteMetrics] = [:]
    for (m, s) in zip(ms, sizes) { out[m.card] = s }
    return out
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
      if let shadow {
        let l = CALayer()
        l.frame = box.bounds.insetBy(dx: -shadow.margin, dy: -shadow.margin)
        l.contents = shadow.0
        l.contentsScale = 2
        let side = CGFloat(shadow.0.width) / 2
        l.contentsCenter = CGRect(x: (side / 2 - 1) / side, y: (side / 2 - 1) / side, width: 2 / side, height: 2 / side)
        box.addSublayer(l)
      }
      for l in [held, rest] {
        l.frame = box.bounds.insetBy(dx: -item.bleed, dy: -item.bleed)
        l.contentsGravity = .resize
        l.magnificationFilter = .linear
        box.addSublayer(l)
      }
      held.minificationFilter = .trilinear
      held.contents = overview
      rest.minificationFilter = .linear
    }

    /// What its bitmaps cover on the board
    var bitmapFrame: CGRect { box.frame.insetBy(dx: -bleed, dy: -bleed) }

    var bytes: Int { (overview?.allocationSize ?? 0) + sharpBytes }

    /// Its bitmaps but the overview
    var sharpBytes: Int { (heldSurface?.allocationSize ?? 0) + ((rest.contents as? IOSurface)?.allocationSize ?? 0) }

    func showOverview() {
      guard face.mayShowOverview(holdsOwn: heldSurface != nil) else { return }
      held.contents = overview
      heldSurface = nil
      heldScale = overviewScale
      coverHeld()
    }

    /// A finished redraw into one of its slots; a Note's first picture fades in
    func take(_ job: RestPlan.Job, _ s: IOSurface) {
      let fades = job.note && face.picture(overview: job.slot == .overview)
      switch job.slot {
      case .held:
        held.contents = s
        heldSurface = s
        heldScale = job.scale
        if fades { CanvasView.fadeIn(held) }
      case .rest:
        rest.contents = s
        restScale = job.scale
        if fades { CanvasView.fadeIn(rest) }
      case .overview:
        overview = s
        if heldSurface == nil {
          held.contents = s
          if fades { CanvasView.fadeIn(held) }
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
        held.contents = s
        heldSurface = s
        heldScale = scale
      }
      rest.contents = nil
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
    hoveredArrow = nil
    mode = nil
    dropLit = []
    withoutAnimation {
      layer?.backgroundColor = theme.canvas
      backdropImage = theme.backdrop.flatMap(Backdrop.image)
      backdrop.contents = backdropImage
      placeBackdrop()
      for l in [sections, dropLayer, below, arrows, above, cards, kept] { l.sublayers = nil }
      for f in s.frames { sections.addSublayer(CanvasView.frameLayer(f, theme)) }
      items = s.items.enumerated().map { i, it in
        ItemLayers(it, overview: overviews[i], shadow: it.drawing.framed ? shadow : nil)
      }
      for (i, l) in items.enumerated() { home(of: i, in: s).addSublayer(l.box) }
      arrowGroups = s.arrows.map { a in
        let ls = CanvasView.arrowLayers(a, theme)
        for l in ls { arrows.addSublayer(l) }
        return ls
      }
    }
    let fit = Camera.fit(s.bounds, in: bounds.isEmpty ? CGSize(width: 1440, height: 900) : bounds.size)
    fitZoom = fit.zoom
    limits = ZoomLimits(fit: fit.zoom)
    if !keepCamera {
      camera = arriving ?? fit
      arriving = nil
    }
    motion = Motion()
    restZoom = nil
    hoveredMark = nil
    applyCamera()
    arrive()
    stylePopLine()
    // another board: its popup goes; the same one drawn again (another theme): it follows
    if openPop != nil, !keepCamera { openPop(nil) }
    placeMarks()
    if openPop != nil { refreshPop() }
    if listShown, !keepCamera { closeQuestionList() }
    if !keepCamera {
      cancelPlacing()
      closeStickerPalette()
      closeShelf()
      shelfPictures = [:]
    }
    shelfChanged()
    questionsChanged()
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
    withoutAnimation {
      world.sublayerTransform = m
      if chrome.sublayers?.isEmpty == false { drawChrome() }
      if editing != nil { cameraMovedWhileEditing() }
      if popShown != nil { positionPop() }
      if refPeek != nil { placeRefPeek() }
      onZoom?(camera.zoom)
      // a label or title being written is kept when the camera moves
      if inPlace != nil { endInPlace(commit: true) }
      // a zoom (not a pan) away from the rest zoom: the held bitmaps take over, with mipmaps
      if let z = restZoom, z != camera.zoom {
        restZoom = nil
        for l in items {
          l.clearRest()
          l.held.minificationFilter = .trilinear
        }
      }
    }
  }

  public override func setFrameSize(_ newSize: NSSize) {
    let unsized = bounds.isEmpty
    super.setFrameSize(newSize)
    withoutAnimation { placeBackdrop() }
    placeShelf()
    guard let scene, newSize.width > 0, newSize.height > 0 else { return }
    let fit = Camera.fit(scene.bounds, in: newSize)
    limits = ZoomLimits(fit: fit.zoom)
    // shown before the view had a size: fit now
    if unsized { camera = fit }
    applyCamera()
    if motion.isResting { arrive() }
  }

  public override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    if motion.isResting && scene != nil { arrive() }
  }

  /// On screen: in a window, neither it nor a view it is in hidden. Only then does it draw
  var onScreen: Bool { window != nil && !isHiddenOrHasHiddenAncestor }

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
    link?.invalidate()
    link = nil
    guard window != nil else { return }
    let l = displayLink(target: self, selector: #selector(step(_:)))
    l.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
    l.add(to: .main, forMode: .common)
    link = l
  }

  // MARK: Input

  public override func scrollWheel(with e: NSEvent) {
    // the system's momentum: the canvas glides on its own
    guard scene != nil, e.momentumPhase.isEmpty else { return }
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

  public override func magnify(with e: NSEvent) {
    guard scene != nil else { return }
    pinch(
      by: 1 + e.magnification, around: convert(e.locationInWindow, from: nil), at: e.timestamp,
      began: e.phase.contains(.began), ended: !e.phase.isDisjoint(with: [.ended, .cancelled]))
  }

  package func scroll(by d: CGVector, at t: TimeInterval, began: Bool, ended: Bool) {
    motion.scroll(d, at: t, began: began, ended: ended, camera: &camera)
    moved()
  }

  package func pinch(by f: CGFloat, around p: CGPoint, at t: TimeInterval, began: Bool, ended: Bool) {
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
      cardLevel.opacity = c
      cardLevel.isHidden = c == 0
      summaryLayer.opacity = s
      summaryLayer.isHidden = s == 0
    }
  }

  /// Input moved the camera: rest work is cancelled
  func moved() {
    gestureStarts += 1
    if !queue.isIdle || !tasks.isEmpty { cancelRedraws() }
    applyCamera()
    link?.isPaused = false
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
    if motion.isResting && queue.isIdle && onFrame == nil && gesture == nil && !levels.isAnimating {
      link?.isPaused = true
    }
  }

  /// At rest: what each item should hold now, within what the other canvases leave of the budget
  func arrive() {
    guard scene != nil, onScreen else { return }
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
    link?.isPaused = false
  }

  /// Each frame at rest: start redraws up to the limit, swap in finished ones within the frame's budget
  func pump() {
    guard let scene else { return }
    for (job, generation) in queue.start() {
      worked = true
      if !motion.isResting || gesture != nil {
        ruleBreaks.redraws += 1
        if job.note { ruleBreaks.noteRequests += 1 }
      }
      let item = scene.items[job.item]
      let theme = self.theme
      let images = self.images
      let id = nextTask
      nextTask += 1
      let epoch = gestureStarts
      if job.note {
        let notes = self.notes
        let priority = nextNote
        nextNote -= 1
        tasks[id] = Task.detached(priority: .userInitiated) { [weak self] in
          let r = await CanvasView.drawNote(
            item, scale: job.scale, theme: theme, images: images, notes: notes, priority: priority)
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
    let writing = editingIndex
    let swaps = queue.takeSwaps().filter { $0.job.item != writing }
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
    link?.isPaused = false
  }

  /// The first picture of a Note fades in over its paper
  static func fadeIn(_ l: CALayer) {
    let t = CATransition()
    t.type = .fade
    t.duration = 0.15
    l.add(t, forKey: "picture")
  }

  /// The bitmap at a scale of an item the Note renderer draws (a Note, an SVG picture): its picture over its paper. No
  /// bitmap when cancelled (a gesture started: a picture the web view was drawing still finishes, into the renderer's
  /// cache) or when the renderer failed. late: cancelled while the paper was being drawn under the picture
  nonisolated static func drawNote(
    _ item: Scene.Item, scale: CGFloat, theme: Theme, images: DecodeCache, notes: NoteRenderer, priority: Int
  ) async -> (surface: IOSurface?, late: Bool) {
    guard !Task.isCancelled,
      let snap = await picture(item, scale: scale, theme: theme, notes: notes, priority: priority),
      !Task.isCancelled
    else { return (nil, false) }
    let s = compose(item, snap, scale: scale, theme: theme, images: images)
    return Task.isCancelled ? (nil, true) : (s, false)
  }

  /// The Note renderer's picture of an item it draws, at a scale; with no priority only from its disk cache
  nonisolated static func picture(
    _ item: Scene.Item, scale: CGFloat, theme: Theme, notes: NoteRenderer, priority: Int?
  ) async -> NoteSnapshot? {
    switch item.drawing {
    case .note(let n):
      let look = theme.id.rawValue
      guard let priority else {
        return await notes.cached(
          of: n.content, width: item.rect.width, height: n.height, folder: n.folder, scale: scale, look: look,
          dark: theme.dark, refs: n.refs)
      }
      return try? await notes.snapshot(
        of: n.content, width: item.rect.width, height: n.height, folder: n.folder, scale: scale, look: look,
        dark: theme.dark, refs: n.refs, priority: priority)
    case .image(let p):
      guard p.svg, let url = p.url else { return nil }
      let width = Int((item.rect.width * scale).rounded(.up))
      guard let priority else { return await notes.cachedPicture(of: url, width: width, dark: theme.dark) }
      return try? await notes.picture(of: url, width: width, dark: theme.dark, priority: priority)
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
    levels.moved(from: camera.zoom, to: z)
    camera = Camera(origin: CGPoint(x: centre.x - bounds.width / 2 / z, y: centre.y - bounds.height / 2 / z), zoom: z)
    motion = Motion()
    if levels.isAnimating { link?.isPaused = false }
    cancelRedraws()
    applyCamera()
    arrive()
  }
}

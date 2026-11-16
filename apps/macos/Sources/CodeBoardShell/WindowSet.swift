import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardReading
import Observation

/// One window as saved: its shell's state and where it was, on which screen (the display's UUID), and where it goes
/// back to when that screen is plugged in again. Its frame is the one it has out of full screen
struct SavedWindow: Codable, Equatable {
  var shell: ShellState
  var frame: CGRect?
  var display: String?
  var home: ScreenPlace?
}

/// The app's board windows, each with its own shell and panes, over the one session and the one table of open boards.
/// What is the app's, not a window's, is done here once: a fresh tree taken in by every window, writing every board,
/// letting go of every board. Menu actions act on `main`.
@MainActor @Observable final class WindowSet {
  let session: VaultSession
  let documents: BoardDocuments
  private(set) var all: [Entry] = []
  /// The windows by when they were last made key or main, the latest first: `main` when AppKit has none (the app not
  /// active, or under a driver), and where what has no place in one window goes
  @ObservationIgnored private var recent: [Entry] = []
  /// Whether a window is on screen: not miniaturized, not covered whole. Tests, whose windows never are, say
  @ObservationIgnored var onScreen: (NSWindow) -> Bool = {
    $0.isVisible && !$0.isMiniaturized && $0.occlusionState.contains(.visible)
  }
  /// The screens there are now; tests make them up
  @ObservationIgnored var screens: () -> [Screen] = { Screen.current() }
  /// Each shell before its window is made, and each window's panes once made (the app delegate's settings)
  @ObservationIgnored var prepare: (Shell) -> Void = { _ in }
  @ObservationIgnored var configure: (BoardPanes) -> Void = { _ in }
  @ObservationIgnored var repositories: RepositoriesModel?
  /// Puts a window made after the first on screen; a driver keeps it behind everything
  @ObservationIgnored var present: (NSWindow) -> Void = { $0.makeKeyAndOrderFront(nil) }
  /// Gives a window the keys (a board tab moved into it); a driver never brings it in front
  @ObservationIgnored var focus: (NSWindow) -> Void = { $0.makeKeyAndOrderFront(nil) }
  /// A board tab dragged out of its row, every window's, and a reading tab
  @ObservationIgnored private(set) var tabDrag: TabDrag!
  @ObservationIgnored private(set) var readingDrag: TabDrag!
  static let stateKey = "windows"
  /// What one window saved before there were several
  static let oldStateKey = "shell"

  init(session: VaultSession = VaultSession()) {
    self.session = session
    documents = BoardDocuments(session: session)
    tabDrag = TabDrag(set: self, kind: .board)
    readingDrag = TabDrag(set: self, kind: .reading)
    NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
    ) { [weak self] _ in MainActor.assumeIsolated { self?.screensChanged() } }
  }

  @MainActor final class Entry: NSObject, NSWindowDelegate {
    let window: NSWindow
    let shell: Shell
    let panes: BoardPanes
    fileprivate weak var set: WindowSet?

    fileprivate init(window: NSWindow, shell: Shell, panes: BoardPanes, set: WindowSet) {
      self.window = window
      self.shell = shell
      self.panes = panes
      self.set = set
    }

    /// What is being written in it goes to its board first; then it closes
    func windowShouldClose(_ sender: NSWindow) -> Bool {
      guard panes.isEditing else { return true }
      Task {
        await panes.endEditing()
        window.close()
      }
      return false
    }

    /// Where it is on its screen, while that screen is there (a move the system makes as its screen goes is not one)
    var placed: ScreenPlace?
    /// Where it goes back to when that screen is back
    var home: ScreenPlace?
    /// Its frame before it went full screen, while it is
    var windowed: CGRect?

    func windowDidMove(_ notification: Notification) { set?.moved(self) }
    func windowDidResize(_ notification: Notification) { set?.moved(self) }
    func windowWillEnterFullScreen(_ notification: Notification) { windowed = window.frame }
    func windowDidExitFullScreen(_ notification: Notification) {
      windowed = nil
      set?.moved(self)
    }

    func windowWillClose(_ notification: Notification) { set?.closed(self) }
    func windowDidBecomeKey(_ notification: Notification) { set?.cameToFront(self) }
    func windowDidBecomeMain(_ notification: Notification) { set?.cameToFront(self) }
  }

  /// The window menu actions act on: AppKit's main window, else the one last in front, else the first
  var main: Entry? { all.first { $0.window === NSApplication.shared.mainWindow } ?? recent.first ?? all.first }

  fileprivate func cameToFront(_ e: Entry) {
    recent.removeAll { $0 === e }
    recent.insert(e, at: 0)
  }

  /// Every window but `e` on screen, the latest used first
  private func others(than e: Entry) -> [Entry] {
    (recent + all.filter { w in !recent.contains { $0 === w } }).filter { $0 !== e && onScreen($0.window) }
  }

  /// The window other than `e` that shows `board` (its selected tab on it, its canvas drawing it, on screen)
  func showing(_ board: BoardID, besides e: Entry) -> Entry? {
    others(than: e).first { $0.shell.current?.board == board && $0.panes.shownCanvas?.document?.id == board }
  }

  /// The board window `window` is (or a sheet on it); nil: `main`, and so for a window that is none of them
  func entry(of window: NSWindow?) -> Entry? {
    let w = window?.sheetParent ?? window
    return all.first { $0.window === w } ?? main
  }

  /// A board window over `shell`: the first keeps its frame as "main", the others theirs in the saved state
  /// `frameName`: the frame a window saved under that name before windows were saved with their state
  @discardableResult func add(_ shell: Shell, frameName: String? = nil) -> Entry {
    let (window, panes) = makeMainWindow(
      shell: shell, repositories: repositories, documents: documents, frameName: frameName)
    let e = Entry(window: window, shell: shell, panes: panes, set: self)
    window.delegate = e
    window.title = shell.vault?.root.lastPathComponent ?? "CodeBoard"
    panes.syncEverywhere = { [weak self] in self?.sync(reload: $0) }
    // a click on this window's board that goes to another board's card or question: there, in a window showing it
    panes.arriveElsewhere = { [weak self, weak e] board, arrival in
      guard let self, let e, let canvas = showing(board, besides: e)?.panes.shownCanvas else { return false }
      switch arrival {
      case .card(let c): canvas.arrive(at: c)
      case .question(let q): canvas.showQuestion(q)
      }
      return true
    }
    // collected with no board tab here: to the board of the latest used window that shows one
    panes.collectElsewhere = { [weak self, weak e] c in
      guard let self, let e else { return }
      others(than: e).lazy.compactMap(\.panes.shownCanvas).first?.collect(c)
    }
    // a source open in another window's reading pane is gone to there
    shell.sources.elsewhere = { [weak self, weak e] holds in
      guard let self, let e else { return nil }
      for o in others(than: e) {
        if let t = o.shell.reading.tabs.first(where: holds) { return (o.shell.reading, t.id) }
      }
      return nil
    }
    shell.tabDragging = tabDrag
    shell.reading.tabDragger = readingDrag
    // a window that shows only its reading pane closes with its last reading tab
    shell.reading.lastClosed = { [weak e] in
      guard let e, e.shell.readingOnly, e.shell.tabs.isEmpty else { return }
      e.window.close()
    }
    configure(panes)
    all.append(e)
    return e
  }

  /// Another window on the vault open, as `saved` left it, or (nil) beside the main window with the board it shows,
  /// on screen
  @discardableResult func open(_ saved: SavedWindow? = nil) -> Entry? {
    guard let e = make(saved, from: main, showing: true) else { return nil }
    present(e.window)
    return e
  }

  /// A window on the vault open, not on screen yet: as `saved` left it, or beside `from` and (`showing`) with a tab on
  /// the board `from` shows
  private func make(_ saved: SavedWindow?, from: Entry?, showing: Bool) -> Entry? {
    guard session.vault != nil else { return nil }
    let shell = Shell(session: session)
    prepare(shell)
    if let saved {
      shell.sidebarShown = saved.shell.sidebarShown
      if let w = saved.shell.sidebarWidth {
        shell.sidebarWidth = min(max(w, Shell.sidebarWidths.lowerBound), Shell.sidebarWidths.upperBound)
      }
    } else if let from {
      shell.sidebarShown = from.shell.sidebarShown
      shell.sidebarWidth = from.shell.sidebarWidth
    }
    shell.vaultOpened(restoring: saved?.shell)
    if saved == nil, let from {
      shell.expanded = from.shell.expanded
      if showing, let b = from.shell.current?.board { shell.show(b) }
    }
    shell.treeChanged()
    let e = add(shell)
    if let saved {
      place(e, saved)
    } else if let from {
      e.window.setFrame(from.window.frame.offsetBy(dx: 24, dy: -24), display: false)
      moved(e)
    }
    e.panes.sync()
    return e
  }

  // MARK: Board tabs between windows

  /// Board tab `tab` moved whole from `from` into `to` at `index`: its board, its history and crumbs, and its pane as it
  /// is (canvas, camera, selection, seat), so nothing is read or drawn again; what is being written in it ends first,
  /// kept. `to` selects it and takes the keys; `from` selects the one beside it, and closes when it has no tab left,
  /// board or reading
  func move(_ tab: Tab.ID, from: Entry, to: Entry, at index: Int) async {
    guard from !== to else { return }
    if let p = from.panes.panes[tab], p.canvas.isWriting { await p.canvas.endWriting() }
    guard all.contains(where: { $0 === from }), all.contains(where: { $0 === to }), let t = from.shell.take(tab)
    else { return }
    // the pane first: either window's sync would otherwise close it, or make the tab a new one
    if let pane = from.panes.handOver(tab) { to.panes.adopt(pane, for: tab) }
    to.shell.insert(t, at: index)
    from.panes.sync()
    to.panes.sync()
    focus(to.window)
    if from.shell.tabs.isEmpty, from.shell.reading.tabs.isEmpty { from.window.close() }
  }

  /// Board tab `tab` moved whole into a window of its own, at `frame` (nil: beside `from`, as New Window's), its
  /// sidebar and reading pane as New Window's; a window's only tab stays, there being nothing to split
  @discardableResult func moveToNewWindow(_ tab: Tab.ID, from: Entry, frame: CGRect?) async -> Entry? {
    guard from.shell.tabs.count > 1, from.shell.tabs.contains(where: { $0.id == tab }),
      let e = make(nil, from: from, showing: false)
    else { return nil }
    if let frame { e.window.setFrame(frame, display: false) }
    await move(tab, from: from, to: e, at: 0)
    present(e.window)
    return e
  }

  // MARK: Reading tabs between windows

  /// Reading tab `id` moved whole from `from` into `to`'s reading pane at `index`, with its view as it is (a web page
  /// not loaded again, signed in and scrolled as it was; a PDF on its page, its selection kept). `to` selects it and
  /// takes the keys; `from` selects the one beside it, and closes when nothing is left in it: no tab at all, or no
  /// reading tab in a window that shows only the reading pane
  func moveReading(_ id: ReadingTab.ID, from: Entry, to: Entry, at index: Int) {
    guard from !== to, all.contains(where: { $0 === from }), all.contains(where: { $0 === to }),
      from.shell.reading.tabs.contains(where: { $0.id == id }), let fv = readingView(of: from),
      let tv = readingView(of: to)
    else { return }
    // the view first: either pane view's sync would otherwise let it go, or make the tab a new one
    let handed = fv.handOver(id)
    guard let t = from.shell.reading.take(id) else { return }
    if let handed { tv.adopt(handed.view, handed.place, for: id) }
    to.shell.reading.insert(t, at: index)
    fv.sync()
    tv.sync()
    focus(to.window)
    tv.takeKeys()
    if from.shell.reading.tabs.isEmpty, from.shell.tabs.isEmpty || from.shell.readingOnly { from.window.close() }
  }

  /// Reading tab `id` moved whole into a window that shows only the reading pane, with no sidebar, at `frame` (nil:
  /// beside `from`, as wide as the reading pane it leaves), and when `tabX` is given moved sideways so that its tab
  /// begins there on screen; a reading-only window's only tab stays, there being nothing to split
  @discardableResult func moveReadingToNewWindow(
    _ id: ReadingTab.ID, from: Entry, frame: CGRect?, tabX: CGFloat? = nil
  ) -> Entry? {
    guard from.shell.reading.tabs.contains(where: { $0.id == id }),
      !(from.shell.readingOnly && from.shell.reading.tabs.count == 1),
      let e = make(nil, from: from, showing: false)
    else { return nil }
    e.shell.readingOnly = true
    e.shell.sidebarShown = false
    e.shell.reading.side = from.shell.reading.side
    e.shell.reading.width = from.shell.reading.width
    e.window.setFrame(frame ?? readingFrame(of: from).offsetBy(dx: 24, dy: -24), display: false)
    moveReading(id, from: from, to: e, at: 0)
    if let tabX {
      e.window.contentView?.layoutSubtreeIfNeeded()
      if let row = tabRow(of: e, .reading) {
        e.window.setFrameOrigin(
          CGPoint(x: e.window.frame.minX + tabX - row.minX - ShellTheme.stripPadding, y: e.window.frame.minY))
      }
    }
    present(e.window)
    return e
  }

  /// A window as wide as `e`'s reading panel and as tall as `e`, where `e` is, for its reading pane alone
  func readingFrame(of e: Entry) -> CGRect {
    let w = e.window.frame
    let pane = readingView(of: e).map { e.window.convertToScreen($0.convert($0.bounds, to: nil)).width }
    return CGRect(x: w.minX, y: w.minY, width: (pane ?? e.shell.reading.width) + 2 * ShellTheme.inset, height: w.height)
  }

  func readingView(of e: Entry) -> ReadingPaneView? {
    e.window.contentView.flatMap { Self.view($0, "ui-readingpane") } as? ReadingPaneView
  }

  // MARK: Tab rows

  /// The window whose tabs of `kind` hold `tab`
  func entry(holding tab: UUID, _ kind: TabKind = .board) -> Entry? {
    all.first { source(of: $0, kind).stripTabs.contains { $0.id == tab } }
  }

  func source(of e: Entry, _ kind: TabKind) -> any TabSource { kind == .board ? e.shell : e.shell.reading }

  /// Where a tab of `kind` dragged from another window would go in `e`'s row, nil when it is not over it
  func setDrop(_ index: Int?, in e: Entry, _ kind: TabKind) {
    switch kind {
    case .board: if e.shell.tabDrop != index { e.shell.tabDrop = index }
    case .reading: if e.shell.reading.tabDrop != index { e.shell.reading.tabDrop = index }
    }
  }

  /// A window's tab row of `kind` on screen. A window that shows only its reading pane has no board row: its reading
  /// tab's page stands for it, where a board tab let go brings the board panel back
  func tabRow(of e: Entry, _ kind: TabKind = .board) -> CGRect? {
    let id = kind == .reading ? "ui-readingtabs" : e.shell.readingOnly ? "ui-readingpane" : "ui-boardtabs"
    guard let row = e.window.contentView.flatMap({ Self.view($0, id) }), !row.isHiddenOrHasHiddenAncestor
    else { return nil }
    return e.window.convertToScreen(row.convert(row.bounds, to: nil))
  }

  private static func view(_ v: NSView, _ id: String) -> NSView? {
    if v.accessibilityIdentifier() == id { return v }
    for s in v.subviews { if let f = view(s, id) { return f } }
    return nil
  }

  /// The tab rows of `kind` of the windows on screen, frontmost first
  func tabRows(_ kind: TabKind = .board) -> [(entry: Entry, frame: CGRect)] {
    let z = NSApplication.shared.orderedWindows
    return all.filter { onScreen($0.window) }
      .sorted { (z.firstIndex(of: $0.window) ?? .max) < (z.firstIndex(of: $1.window) ?? .max) }
      .compactMap { e in tabRow(of: e, kind).map { (e, $0) } }
  }

  /// The window whose tab row of `kind` (of `rows`, frontmost first) is at `p` on screen, `slack` above and below it
  /// counting, and where in it a tab let go there goes
  func row(
    at p: CGPoint, slack: CGFloat, in rows: [(entry: Entry, frame: CGRect)], _ kind: TabKind = .board
  ) -> (entry: Entry, index: Int)? {
    guard let (e, r) = rows.first(where: { $0.frame.insetBy(dx: 0, dy: -slack).contains(p) }) else { return nil }
    // the tabs as the row lays them out (TabStrip): from its padding, each its width and 2 apart, scrolled sideways
    let source = source(of: e, kind)
    let tabs = source.stripTabs
    var x = r.minX + ShellTheme.stripPadding - source.stripScroll
    for (i, t) in tabs.enumerated() {
      let w = TabItem.width(of: t.title)
      if p.x < x + w / 2 { return (e, i) }
      x += w + 2
    }
    return (e, tabs.count)
  }

  // MARK: Screens

  /// The first window at launch, as `saved` left it. One saved with no frame of its own (nothing saved, or saved
  /// before there were several windows) takes the frame kept under `frameName` then, else the middle of the screen
  @discardableResult func addFirst(_ shell: Shell, saved: SavedWindow?, frameName: String = "main") -> Entry {
    let e = add(shell, frameName: saved?.frame == nil ? frameName : nil)
    if let saved { place(e, saved) } else { moved(e) }
    return e
  }

  /// A saved window where it goes for the screens there are now (ScreenPlaces.atLaunch); one saved with no frame stays
  /// where it was made
  func place(_ e: Entry, _ saved: SavedWindow) {
    guard let f = saved.frame else { return moved(e) }
    let (frame, home) = ScreenPlaces.atLaunch(frame: f, screen: saved.display, home: saved.home, screens: screens())
    e.window.setFrame(frame, display: false)
    e.home = home
    moved(e)
  }

  /// A window moved or resized: its new place, unless the screen it was on is gone (the system moving it off that)
  func moved(_ e: Entry) {
    guard e.windowed == nil else { return }
    let screens = screens()
    if let p = e.placed, !screens.contains(where: { $0.id == p.screen }) { return }
    e.placed = ScreenPlaces.screen(of: e.window.frame, in: screens).map {
      ScreenPlace(screen: $0.id, frame: e.window.frame)
    }
  }

  /// Screens came or went: each window whose screen is gone goes to one that is here and keeps its place as its home;
  /// one whose home screen is back goes back there (ScreenPlaces.screensChanged)
  func screensChanged() {
    let screens = screens()
    for e in all where e.windowed == nil {
      let r = ScreenPlaces.screensChanged(frame: e.window.frame, placed: e.placed, home: e.home, screens: screens)
      e.home = r.home
      if let f = r.frame { e.window.setFrame(f, display: true) }
      e.placed = ScreenPlaces.screen(of: e.window.frame, in: screens).map {
        ScreenPlace(screen: $0.id, frame: e.window.frame)
      }
    }
  }

  private func closed(_ e: Entry) {
    e.panes.leaveAll()
    all.removeAll { $0 === e }
    recent.removeAll { $0 === e }
  }

  // MARK: What is the app's

  /// The vault changed: the documents take in the disk once, then every window its tabs and canvases
  func sync(reload: Bool = false) {
    if reload { documents.diskChanged() }
    for e in all { e.panes.follow(reload: reload) }
    documents.keepFolderBoardsUp()
  }

  var isEditing: Bool { all.contains { $0.panes.isEditing } }

  /// Every window ends its writing (quitting, another vault)
  func endEditing() async {
    for e in all { await e.panes.endEditing() }
  }

  /// Every board written once, with where every window looks at it; the boards that could not be, by title, with why
  func flush() -> [(title: String, why: String)] {
    for e in all { e.panes.keepCameras() }
    return documents.flush()
  }

  /// Another vault: every window ends its writing, the others close, the boards are written and let go; the main
  /// window stays, for the vault to open in
  func closeAll() async {
    await endEditing()
    let keep = main
    for e in all where e !== keep { e.window.close() }
    await keep?.panes.close()
  }

  // MARK: Saved state

  static func saved(in defaults: UserDefaults) -> [SavedWindow] {
    let decoder = JSONDecoder()
    if let data = defaults.data(forKey: stateKey), let all = try? decoder.decode([SavedWindow].self, from: data) {
      return all
    }
    return defaults.data(forKey: oldStateKey).flatMap { try? decoder.decode(ShellState.self, from: $0) }.map {
      [SavedWindow(shell: $0)]
    } ?? []
  }

  /// Each window with a vault, in the order they were made; nothing when none is left (the last one closed: what it
  /// saved stays for the next launch)
  func save(in defaults: UserDefaults) {
    let windows = all.compactMap { e in
      e.shell.state.map {
        SavedWindow(shell: $0, frame: e.windowed ?? e.window.frame, display: e.placed?.screen, home: e.home)
      }
    }
    guard !windows.isEmpty, let data = try? JSONEncoder().encode(windows) else { return }
    defaults.set(data, forKey: Self.stateKey)
  }
}

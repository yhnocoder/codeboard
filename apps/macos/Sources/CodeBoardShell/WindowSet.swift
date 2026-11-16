import AppKit
import CodeBoardCanvas
import CodeBoardModel
import Observation

/// One window as saved: its shell's state and where it was, on which screen
struct SavedWindow: Codable, Equatable {
  var shell: ShellState
  var frame: CGRect?
  /// The screen's display number (NSScreenNumber)
  var screen: UInt32?
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
  /// Each shell before its window is made, and each window's panes once made (the app delegate's settings)
  @ObservationIgnored var prepare: (Shell) -> Void = { _ in }
  @ObservationIgnored var configure: (BoardPanes) -> Void = { _ in }
  @ObservationIgnored var repositories: RepositoriesModel?
  /// Puts a window made after the first on screen; a driver keeps it behind everything
  @ObservationIgnored var present: (NSWindow) -> Void = { $0.makeKeyAndOrderFront(nil) }
  static let stateKey = "windows"
  /// What one window saved before there were several
  static let oldStateKey = "shell"

  init(session: VaultSession = VaultSession()) {
    self.session = session
    documents = BoardDocuments(session: session)
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
  @discardableResult func add(_ shell: Shell) -> Entry {
    let (window, panes) = makeMainWindow(
      shell: shell, repositories: repositories, documents: documents, frameName: all.isEmpty ? "main" : nil)
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
    configure(panes)
    all.append(e)
    return e
  }

  /// Another window on the vault open, as `saved` left it, or (nil) beside the main window with the board it shows
  @discardableResult func open(_ saved: SavedWindow? = nil) -> Entry? {
    guard session.vault != nil else { return nil }
    let from = main
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
      if let b = from.shell.current?.board { shell.show(b) }
    }
    shell.treeChanged()
    let e = add(shell)
    if let f = saved?.frame, let s = saved?.screen, NSScreen.screens.contains(where: { $0.number == s }) {
      e.window.setFrame(f, display: false)
    } else if let from {
      e.window.setFrame(from.window.frame.offsetBy(dx: 24, dy: -24), display: false)
    }
    e.panes.sync()
    present(e.window)
    return e
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
      e.shell.state.map { SavedWindow(shell: $0, frame: e.window.frame, screen: e.window.screen?.number) }
    }
    guard !windows.isEmpty, let data = try? JSONEncoder().encode(windows) else { return }
    defaults.set(data, forKey: Self.stateKey)
  }
}

extension NSScreen {
  var number: UInt32? { (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value }
}

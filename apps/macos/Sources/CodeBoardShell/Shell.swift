import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardReading
import CodeBoardResources
import Observation
import TestGuard

/// A board tab: the board it shows and its own back / forward history, browser style, each board in it with where its
/// view was. Boards are held by id, so a board renamed or moved on disk stays in its tab.
public struct Tab: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public var board: BoardID
  public var back: [Visit] = []
  public var forward: [Visit] = []
  /// Where the board is to be shown from when it is next loaded (gone back or forward to it); nil: all of it in view
  public var arriving: Camera?

  /// The boards a sub-board was entered from, outermost first (main's breadcrumb): each its board, the sub-board card
  /// it was entered by and its camera then
  public var crumbs: [Crumb] {
    get { crumbList ?? [] }
    set { crumbList = newValue.isEmpty ? nil : newValue }
  }
  // optional on disk: tabs saved before crumbs read as having none
  private var crumbList: [Crumb]?

  public struct Visit: Codable, Equatable, Sendable {
    public var board: BoardID
    public var camera: Camera?
    public var crumbs: [Crumb] {
      get { crumbList ?? [] }
      set { crumbList = newValue.isEmpty ? nil : newValue }
    }
    private var crumbList: [Crumb]?

    public init(board: BoardID, camera: Camera? = nil, crumbs: [Crumb] = []) {
      self.board = board
      self.camera = camera
      self.crumbs = crumbs
    }

    enum CodingKeys: String, CodingKey {
      case board, camera
      case crumbList = "crumbs"
    }
  }

  public struct Crumb: Codable, Equatable, Sendable {
    public var board: BoardID
    public var frame: CardID
    public var camera: Camera?

    public init(board: BoardID, frame: CardID, camera: Camera?) {
      self.board = board
      self.frame = frame
      self.camera = camera
    }
  }

  public init(board: BoardID) {
    id = UUID()
    self.board = board
  }

  enum CodingKeys: String, CodingKey {
    case id, board, back, forward, arriving
    case crumbList = "crumbs"
  }
}

/// What is restored at relaunch; the window frame is the window's own autosave
public struct ShellState: Codable, Equatable, Sendable {
  public var vault: String
  public var tabs: [Tab]
  public var selected: Tab.ID?
  public var expanded: Set<String>
  public var sidebarShown: Bool
  /// nil in what was saved before the sidebar could be resized
  public var sidebarWidth: Double?
  /// nil in what was saved before the reading pane
  public var reading: ReadingPane.State?
  /// A window that shows only its reading pane (a reading tab dragged to where no tab row was); nil: not one
  public var readingOnly: Bool?
}

/// One window's state: its tabs, its sidebar and its reading pane, over the session the app's windows share (the vault,
/// its tree, the theme). Views derive from it; disk access happens outside and reaches it through `open(_:restoring:)`
/// and `apply(_:)`.
@MainActor @Observable public final class Shell {
  public let session: VaultSession
  public var vault: Vault? { session.vault }
  public var tree: VaultFolder? { session.tree }
  public var treeError: String? { session.treeError }
  public private(set) var tabs: [Tab] = [] {
    // a board tab in a window that showed only the reading pane: the board panel is back
    didSet { if !tabs.isEmpty, readingOnly { readingOnly = false } }
  }
  /// Only the reading pane shows, no board panel and no divider, until a board tab arrives (WindowSet)
  public internal(set) var readingOnly = false
  public private(set) var selected: Tab.ID?
  /// Folder paths shown open in the sidebar
  public var expanded: Set<String> = []
  public var sidebarShown = true
  /// Dragged at its edge, kept with the state
  public var sidebarWidth: CGFloat = 244
  public static let sidebarWidths: ClosedRange<CGFloat> = 180...480
  /// The pane beside the board: hidden until it is first used
  public let reading = ReadingPane()
  /// What the board asks about the sources its cards name (the reading pane's entries); the board panes hand it on
  public let sources: ReadingSources
  /// The last passage collected from the reading pane (`collect`)
  public private(set) var collected: Collected?
  /// Where a collected passage goes on: the board's side sets it
  @ObservationIgnored public var onCollect: ((Collected) -> Void)?
  public var machineFolder: URL? {
    get { session.machineFolder }
    set {
      session.machineFolder = newValue
      reading.machineFolder = newValue
    }
  }
  public var importing: Bool {
    get { session.importing }
    set { session.importing = newValue }
  }
  public var theme: Theme.ID {
    get { session.theme }
    set { session.theme = newValue }
  }
  public var dark: Bool { session.dark }
  /// Where the selected tab's view is (the board panel's canvas)
  public var cameraNow: (() -> Camera?)?
  /// Before the vault's files change from the sidebar: what open boards have not written yet is written
  public var beforeFiles: (() -> Void)?
  /// After they changed (the tree read again): open boards take it in
  public var afterFiles: (() -> Void)?
  /// A board's seal set from the sidebar or a ref (nil: the default); `done`: the popover closed, the last change is the
  /// one that counts (one undo step on an open board)
  public var setSeal: ((BoardID, Seal?, _ done: Bool) -> Void)?
  /// A subfolder renamed in the sidebar, before the tree is read again: its parent's folder board keeps its card where
  /// it was (the parent folder's path, the old name, the new)
  public var folderRenamed: ((String, String, String) -> Void)?
  /// A board or subfolder deleted or moved away from the sidebar, before the tree is read again: its folder's folder
  /// board lets its card go (the folder's path, the entry)
  public var entryLeft: ((String, FolderEntry) -> Void)?
  /// What is being renamed in the sidebar: a board or resource by id, a folder by path
  public var renaming: Renaming?
  public var trasher: Vault.Trasher {
    get { session.trasher }
    set { session.trasher = newValue }
  }
  public var pasteboard: NSPasteboard {
    get { session.pasteboard }
    set {
      session.pasteboard = newValue
      reading.pasteboard = newValue
    }
  }
  /// Asks which PDF files to add (Add PDF…): an open panel in a sheet on the main window (makeMainWindow); with no
  /// window to ask in, none
  @ObservationIgnored public var askPDFs: @MainActor () async -> [URL] = { [] }
  /// Add arXiv or DOI Paper… for a resource: a sheet on the main window (makeMainWindow) asking for the id or DOI,
  /// which adds it with `addPaper`; with no window, nothing
  @ObservationIgnored public var askArxiv: @MainActor (VaultResource) -> Void = { _ in }
  /// Asks a question before a delete, the first button the yes: a sheet on the main window (makeMainWindow); with no
  /// window to ask in, nothing is deleted
  @ObservationIgnored public var confirm: @MainActor (NSAlert) async -> Bool = { _ in false }
  /// Why the last change of the vault's files from the sidebar did not go through (a beep said so); nil when it did
  public internal(set) var fileError: String?
  /// The sidebar row under the pointer (`rowKey`)
  public var hoveredRow: String?
  /// The board whose seal is being edited, and where its popover is anchored
  public var sealEditing: BoardID?

  public enum Renaming: Equatable, Sendable {
    case board(BoardID)
    case folder(String)
    case resource(ResourceID)
  }

  public init(session: VaultSession = VaultSession()) {
    // in a test process: no menu, alert or panel ever comes up
    TestGuard.install()
    ReadingKinds.registerBuiltIn()
    WebReading.register(saving: Self.webSaving, scripts: Self.webScripts, translate: Self.webTranslate)
    self.session = session
    sources = ReadingSources(pane: reading)
    reading.makePop = { Self.annotationPop(act: $0, resized: $1) }
    reading.onCollect = { [weak self] in self?.collect($0) }
    reading.onOpenBoard = { [weak self] in self?.show($0) }
    session.join(self)
  }

  public var current: Tab? { tabs.first { $0.id == selected } }

  public var look: Theme { session.look }

  public func follow(_ appearance: NSAppearance) { session.follow(appearance) }

  public func board(_ id: BoardID) -> VaultBoard? { session.board(id) }

  /// Opens a vault; the state is restored only when it was saved for this vault. Tabs wait for the tree to be pruned.
  public func open(_ vault: Vault, restoring state: ShellState?) {
    session.open(vault)
    vaultOpened(restoring: state)
  }

  /// The session opened a vault, for every window: this one starts on it, with the state saved for it or with nothing
  func vaultOpened(restoring state: ShellState?) {
    guard let vault else { return }
    reading.vault = vault
    reading.entries = EntryIndex()
    if let state, state.vault == vault.root.path {
      tabs = state.tabs
      selected = state.selected.flatMap { id in tabs.contains { $0.id == id } ? id : nil } ?? tabs.first?.id
      expanded = state.expanded
      sidebarShown = state.sidebarShown
      if let r = state.reading { reading.restore(r) }
      readingOnly = state.readingOnly == true && tabs.isEmpty && !reading.tabs.isEmpty
    } else {
      tabs = []
      selected = nil
      expanded = []
      reading.closeAll()
      readingOnly = false
    }
  }

  public var state: ShellState? {
    vault.map {
      ShellState(
        vault: $0.root.path, tabs: tabs, selected: selected, expanded: expanded, sidebarShown: sidebarShown,
        sidebarWidth: Double(sidebarWidth), reading: reading.state, readingOnly: readingOnly ? true : nil)
    }
  }

  /// A fresh read of the tree, for every window. Boards gone from it leave every history, and a tab whose board is gone
  /// closes.
  public func apply(_ result: Result<VaultFolder, any Error>) {
    session.apply(result)
    if case .success = result { for s in session.shells { s.treeChanged() } }
  }

  /// The session's tree read again, for every window: this one's tabs and reading pane take it in
  func treeChanged() {
    guard let tree = session.tree else { return }
    for tab in tabs where session.board(tab.board) == nil { close(tab.id) }
    if let vault { reading.entries = EntryIndex(vault, tree) }
    // a resource's tab takes its new name, and closes when it is gone, as does any tab whose kind says so; its kind
    // hears every read too
    let resources = Dictionary(
      tree.allFolders.flatMap(\.resources).map { (Self.readingKey($0.id), $0.title) }, uniquingKeysWith: { a, _ in a })
    reading.follow { tab in
      guard let key = tab.key, key.hasPrefix("resource:") else { return ReadingKinds.follow(tab, in: reading) }
      guard let title = resources[key] else { return nil }
      _ = ReadingKinds.follow(tab, in: reading)
      return title
    }
    sources.sourcesChanged()
    // a crumb whose board is gone cuts the crumbs there: what is past it is no way back
    func kept(_ cs: [Tab.Crumb]) -> [Tab.Crumb] { Array(cs.prefix { session.board($0.board) != nil }) }
    for i in tabs.indices {
      tabs[i].back.removeAll { session.board($0.board) == nil }
      tabs[i].forward.removeAll { session.board($0.board) == nil }
      tabs[i].crumbs = kept(tabs[i].crumbs)
      for j in tabs[i].back.indices { tabs[i].back[j].crumbs = kept(tabs[i].back[j].crumbs) }
      for j in tabs[i].forward.indices { tabs[i].forward[j].crumbs = kept(tabs[i].forward[j].crumbs) }
    }
  }

  /// Shows a board in the current tab (its history grows), or in a new tab after the current one
  public func show(_ board: BoardID, newTab: Bool = false) {
    guard !newTab, let i = currentIndex else {
      let tab = Tab(board: board)
      tabs.insert(tab, at: currentIndex.map { $0 + 1 } ?? tabs.count)
      selected = tab.id
      return
    }
    guard tabs[i].board != board else { return }
    go(i, to: board, crumbs: [], camera: nil)
  }

  /// The board a sub-board card shows, entered from it in the current tab: this board joins the crumbs, with where its
  /// camera is (actions/subboards.ts enterFrame); on `through` the sub-board cards below it, each board on the way a
  /// crumb shown from its own camera when gone back to (host handlers.ts enterBoard with reveal)
  public func enter(
    _ board: BoardID, from frame: CardID, camera: Camera?, through: [(frame: CardID, board: BoardID)] = []
  ) {
    guard let i = currentIndex, tabs[i].board != board else { return }
    var crumbs = tabs[i].crumbs + [Tab.Crumb(board: tabs[i].board, frame: frame, camera: camera)]
    var to = board
    for hop in through {
      crumbs.append(Tab.Crumb(board: to, frame: hop.frame, camera: nil))
      to = hop.board
    }
    go(i, to: to, crumbs: crumbs, camera: nil)
  }

  /// Back to the crumb at `depth` (the parent when nil), shown from where it was left (leaveBoard)
  public func leave(to depth: Int? = nil) {
    guard let i = currentIndex, !tabs[i].crumbs.isEmpty else { return }
    let cs = tabs[i].crumbs
    let d = max(0, min(cs.count - 1, depth ?? cs.count - 1))
    go(i, to: cs[d].board, crumbs: Array(cs[..<d]), camera: cs[d].camera)
  }

  private func go(_ i: Int, to board: BoardID, crumbs: [Tab.Crumb], camera: Camera?) {
    tabs[i].back.append(Tab.Visit(board: tabs[i].board, camera: cameraNow?(), crumbs: tabs[i].crumbs))
    tabs[i].forward = []
    tabs[i].board = board
    tabs[i].crumbs = crumbs
    tabs[i].arriving = camera
  }

  /// The camera a tab's board was to be shown from has been used
  public func arrived(_ tab: Tab.ID) {
    if let i = tabs.firstIndex(where: { $0.id == tab }), tabs[i].arriving != nil { tabs[i].arriving = nil }
  }

  public func select(_ tab: Tab.ID) {
    if tabs.contains(where: { $0.id == tab }) { selected = tab }
  }

  /// The next tab to the right (or left, by -1), wrapping around
  public func selectTab(by offset: Int) {
    guard let i = currentIndex, tabs.count > 1 else { return }
    selected = tabs[(i + offset % tabs.count + tabs.count) % tabs.count].id
  }

  /// Closing the selected tab selects the one to its right, else the one to its left
  public func close(_ tab: Tab.ID) {
    guard let i = tabs.firstIndex(where: { $0.id == tab }) else { return }
    tabs.remove(at: i)
    if selected == tab { selected = tabs.isEmpty ? nil : tabs[min(i, tabs.count - 1)].id }
  }

  public func move(_ tab: Tab.ID, to index: Int) {
    guard let i = tabs.firstIndex(where: { $0.id == tab }) else { return }
    tabs.insert(tabs.remove(at: i), at: max(0, min(index, tabs.count)))
  }

  /// A tab taken out whole (to another window), the one beside it selected as closing it does
  func take(_ tab: Tab.ID) -> Tab? {
    guard let t = tabs.first(where: { $0.id == tab }) else { return nil }
    close(tab)
    return t
  }

  /// A tab from another window, whole, at `index`, selected
  func insert(_ tab: Tab, at index: Int) {
    tabs.insert(tab, at: max(0, min(index, tabs.count)))
    selected = tab.id
  }

  /// Where a board tab dragged from another window would go in this window's row, while it is over it
  public internal(set) var tabDrop: Int?
  /// What a board tab dragged out of the row tells (WindowSet's), and how far the row is scrolled sideways
  @ObservationIgnored var tabDragging: TabDragging?
  @ObservationIgnored var stripScroll: CGFloat = 0

  /// A tab in the reading pane titled `title` (a resource's name), the pane shown; the tab opened for the same `key`
  /// is gone to instead of a second
  public func openReadingTab(title: String, key: String) {
    reading.open(title, key: key)
  }

  /// A resource's tab (its row clicked in the sidebar), a list of its entries: opened, or gone to when it is open
  public func openResource(_ r: VaultResource) {
    reading.open(r.title, key: Self.readingKey(r.id), kind: "list", payload: ["resource": r.id.rawValue])
  }

  static func readingKey(_ id: ResourceID) -> String { "resource:" + id.rawValue }

  /// Whether the reading pane is showing this resource's list now: what its row in the sidebar marks (the board's row
  /// keeps the selection, the board being what the board side shows)
  public func readingShows(_ id: ResourceID) -> Bool {
    reading.shown && reading.tabs.first { $0.id == reading.selected }?.key == Self.readingKey(id)
  }

  /// A PDF in the reading pane (an entry's version, or a file that is an entry alone): opened, or gone to when it is
  /// open; nil when it is not in the vault
  @discardableResult public func openPDF(_ t: PDFTarget) -> ReadingTab.ID? { reading.openPDF(t) }

  /// A new web tab in the reading pane, on `url` or blank, shown with the keys (Web/ makes its view)
  public func openWeb(_ url: URL?) {
    reading.open(
      url?.host() ?? "New Tab", key: url.map(WebReading.key(for:)), kind: "web",
      payload: url.map { ["url": $0.absoluteString] } ?? [:])
  }

  /// A passage collected from the reading pane (its selection bar's Add to Board, ⌥↵): kept, and handed to the board's
  /// side, which takes it from here
  public func collect(_ c: Collected) {
    collected = c
    onCollect?(c)
  }

  public var canGoBack: Bool { current?.back.isEmpty == false }
  public var canGoForward: Bool { current?.forward.isEmpty == false }

  public func goBack() {
    guard let i = currentIndex, let to = tabs[i].back.popLast() else { return }
    tabs[i].forward.append(Tab.Visit(board: tabs[i].board, camera: cameraNow?(), crumbs: tabs[i].crumbs))
    tabs[i].board = to.board
    tabs[i].crumbs = to.crumbs
    tabs[i].arriving = to.camera
  }

  public func goForward() {
    guard let i = currentIndex, let to = tabs[i].forward.popLast() else { return }
    tabs[i].back.append(Tab.Visit(board: tabs[i].board, camera: cameraNow?(), crumbs: tabs[i].crumbs))
    tabs[i].board = to.board
    tabs[i].crumbs = to.crumbs
    tabs[i].arriving = to.camera
  }

  private var currentIndex: Int? { tabs.firstIndex { $0.id == selected } }
}

import AppKit
import CodeBoardCanvas
import CodeBoardModel
import Observation

/// A board tab: the board it shows and its own back / forward history, browser style, each board in it with where its
/// view was. Boards are held by id, so a board renamed or moved on disk stays in its tab.
public struct Tab: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public var board: BoardID
  public var back: [Visit] = []
  public var forward: [Visit] = []
  /// Where the board is to be shown from when it is next loaded (gone back or forward to it); nil: all of it in view
  public var arriving: Camera?

  public struct Visit: Codable, Equatable, Sendable {
    public var board: BoardID
    public var camera: Camera?

    public init(board: BoardID, camera: Camera? = nil) {
      self.board = board
      self.camera = camera
    }
  }

  public init(board: BoardID) {
    id = UUID()
    self.board = board
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
}

/// The app's state: the open vault and its tree, the tabs, the sidebar. Views derive from it; disk access happens outside
/// and reaches it through `open(_:restoring:)` and `apply(_:)`.
@MainActor @Observable public final class Shell {
  public private(set) var vault: Vault?
  public private(set) var tree: VaultFolder?
  /// Why the tree could not be read; the last good tree stays
  public private(set) var treeError: String?
  public private(set) var tabs: [Tab] = []
  public private(set) var selected: Tab.ID?
  /// Folder paths shown open in the sidebar
  public var expanded: Set<String> = []
  public var sidebarShown = true
  /// Dragged at its edge, kept with the state
  public var sidebarWidth: CGFloat = 244
  public static let sidebarWidths: ClosedRange<CGFloat> = 180...480
  public var importing = false
  /// The look every board is drawn in; app-wide, kept by the app delegate
  public var theme: Theme.ID = .warmInk
  /// Whether the Mac's appearance is dark: the app follows it (`follow(_:)`) and has no setting of its own
  public private(set) var dark = false
  private var byID: [BoardID: VaultBoard] = [:]
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
  /// What is being renamed in the sidebar: a board by id, a folder by path
  public var renaming: Renaming?
  /// Where deleted boards and folders go: the system Trash; tests give a stand-in
  public var trasher: Vault.Trasher = Vault.systemTrash
  /// Why the last change of the vault's files from the sidebar did not go through (a beep said so); nil when it did
  public internal(set) var fileError: String?
  /// The sidebar row under the pointer (`rowKey`)
  public var hoveredRow: String?
  /// The board whose seal is being edited, and where its popover is anchored
  public var sealEditing: BoardID?

  public enum Renaming: Equatable, Sendable {
    case board(BoardID)
    case folder(String)
  }

  public init() {}

  public var current: Tab? { tabs.first { $0.id == selected } }

  /// The theme in the appearance the app shows: what boards, the board panel and its glass are drawn in
  public var look: Theme { Theme.named(theme, dark: dark) }

  /// Takes the appearance the app is shown in (NSApp's effective appearance)
  public func follow(_ appearance: NSAppearance) {
    let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    if dark != self.dark { self.dark = dark }
  }

  public func board(_ id: BoardID) -> VaultBoard? { byID[id] }

  /// Opens a vault; the state is restored only when it was saved for this vault. Tabs wait for the tree to be pruned.
  public func open(_ vault: Vault, restoring state: ShellState?) {
    self.vault = vault
    tree = nil
    treeError = nil
    byID = [:]
    if let state, state.vault == vault.root.path {
      tabs = state.tabs
      selected = state.selected.flatMap { id in tabs.contains { $0.id == id } ? id : nil } ?? tabs.first?.id
      expanded = state.expanded
      sidebarShown = state.sidebarShown
    } else {
      tabs = []
      selected = nil
      expanded = []
    }
  }

  public var state: ShellState? {
    vault.map {
      ShellState(
        vault: $0.root.path, tabs: tabs, selected: selected, expanded: expanded, sidebarShown: sidebarShown,
        sidebarWidth: Double(sidebarWidth))
    }
  }

  /// A fresh read of the tree. Boards gone from it leave every history, and a tab whose board is gone closes.
  public func apply(_ result: Result<VaultFolder, any Error>) {
    switch result {
    case .failure(let error):
      treeError = String(describing: error)
    case .success(let tree):
      self.tree = tree
      treeError = nil
      byID = Dictionary(tree.allBoards.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
      for tab in tabs where byID[tab.board] == nil { close(tab.id) }
      for i in tabs.indices {
        tabs[i].back.removeAll { byID[$0.board] == nil }
        tabs[i].forward.removeAll { byID[$0.board] == nil }
      }
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
    tabs[i].back.append(Tab.Visit(board: tabs[i].board, camera: cameraNow?()))
    tabs[i].forward = []
    tabs[i].board = board
    tabs[i].arriving = nil
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

  public var canGoBack: Bool { current?.back.isEmpty == false }
  public var canGoForward: Bool { current?.forward.isEmpty == false }

  public func goBack() {
    guard let i = currentIndex, let to = tabs[i].back.popLast() else { return }
    tabs[i].forward.append(Tab.Visit(board: tabs[i].board, camera: cameraNow?()))
    tabs[i].board = to.board
    tabs[i].arriving = to.camera
  }

  public func goForward() {
    guard let i = currentIndex, let to = tabs[i].forward.popLast() else { return }
    tabs[i].back.append(Tab.Visit(board: tabs[i].board, camera: cameraNow?()))
    tabs[i].board = to.board
    tabs[i].arriving = to.camera
  }

  private var currentIndex: Int? { tabs.firstIndex { $0.id == selected } }
}

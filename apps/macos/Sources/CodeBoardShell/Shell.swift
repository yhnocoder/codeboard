import CodeBoardCanvas
import CodeBoardModel
import Foundation
import Observation

/// A board tab: the board it shows and its own back / forward history, browser style. Boards are held by id, so a board
/// renamed or moved on disk stays in its tab.
public struct Tab: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public var board: BoardID
  public var back: [BoardID] = []
  public var forward: [BoardID] = []

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
  public var importing = false
  /// The look every board is drawn in; app-wide, kept by the app delegate
  public var theme: Theme.ID = .warmInk
  private var byID: [BoardID: VaultBoard] = [:]

  public init() {}

  public var current: Tab? { tabs.first { $0.id == selected } }

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
      ShellState(vault: $0.root.path, tabs: tabs, selected: selected, expanded: expanded, sidebarShown: sidebarShown)
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
        tabs[i].back.removeAll { byID[$0] == nil }
        tabs[i].forward.removeAll { byID[$0] == nil }
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
    tabs[i].back.append(tabs[i].board)
    tabs[i].forward = []
    tabs[i].board = board
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
    tabs[i].forward.append(tabs[i].board)
    tabs[i].board = to
  }

  public func goForward() {
    guard let i = currentIndex, let to = tabs[i].forward.popLast() else { return }
    tabs[i].back.append(tabs[i].board)
    tabs[i].board = to
  }

  private var currentIndex: Int? { tabs.firstIndex { $0.id == selected } }
}

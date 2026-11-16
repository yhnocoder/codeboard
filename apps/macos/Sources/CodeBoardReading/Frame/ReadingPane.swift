import AppKit
import Observation

/// A tab of the reading pane: what it shows and the name on its tab. `key` is what it was opened for (a resource):
/// opening the same key again goes to this tab
public struct ReadingTab: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public var key: String?
  public var title: String
  public var content: Content

  /// What a tab shows; each kind makes its own view
  public enum Content: Codable, Equatable, Sendable {
    /// A blank page: the panel's paper
    case empty
  }

  public init(title: String, key: String? = nil, content: Content = .empty) {
    id = UUID()
    self.key = key
    self.title = title
    self.content = content
  }

  /// The SF Symbol before its title; nil: none
  public var icon: String? {
    switch content {
    case .empty: nil
    }
  }
}

extension ReadingTab.Content {
  /// The view the tab shows, made once when it opens and kept while it is open
  @MainActor func makeView() -> NSView {
    switch self {
    case .empty: NSView()
    }
  }
}

/// The reading pane beside the board: whether it is shown, on which side, how wide, its tabs. Per machine, kept with
/// the shell's state and never in the vault
@MainActor @Observable public final class ReadingPane {
  public var shown = false
  public var side = Side.right
  /// Dragged at the divider; the window keeps it within both panels' minimums (`fit`)
  public var width: CGFloat = 440
  public private(set) var tabs: [ReadingTab] = []
  public private(set) var selected: ReadingTab.ID?

  public enum Side: String, Codable, Sendable {
    case left, right

    public var other: Side { self == .left ? .right : .left }
  }

  public static let minWidth: CGFloat = 280
  /// What the board panel keeps beside it
  public static let boardMinWidth: CGFloat = 360

  /// The pane's width out of `room` (both panels, the gap between left out): `width` within both minimums; a room
  /// too narrow for both is shared in proportion to them
  public static func fit(_ width: CGFloat, in room: CGFloat) -> CGFloat {
    let both = minWidth + boardMinWidth
    guard room >= both else { return max(0, room * minWidth / both).rounded() }
    return min(max(width, minWidth), room - boardMinWidth).rounded()
  }

  public init() {}

  public struct State: Codable, Equatable, Sendable {
    public var shown: Bool
    public var side: Side
    public var width: Double
    public var tabs: [ReadingTab]
    public var selected: ReadingTab.ID?
  }

  public var state: State {
    State(shown: shown, side: side, width: Double(width), tabs: tabs, selected: selected)
  }

  public func restore(_ s: State) {
    shown = s.shown
    side = s.side
    width = s.width
    tabs = s.tabs
    selected = s.selected.flatMap { id in tabs.contains { $0.id == id } ? id : nil } ?? tabs.first?.id
  }

  /// Another vault: the tabs were the last one's
  public func closeAll() {
    tabs = []
    selected = nil
  }

  /// A tab titled `title` after the current one, selected, the pane shown; one opened for the same `key` is gone to
  /// instead
  @discardableResult public func open(_ title: String, key: String? = nil) -> ReadingTab.ID {
    shown = true
    if let key, let tab = tabs.first(where: { $0.key == key }) {
      selected = tab.id
      return tab.id
    }
    let tab = ReadingTab(title: title, key: key)
    tabs.insert(tab, at: currentIndex.map { $0 + 1 } ?? tabs.count)
    selected = tab.id
    return tab.id
  }

  public func select(_ tab: ReadingTab.ID) {
    if tabs.contains(where: { $0.id == tab }) { selected = tab }
  }

  /// The next tab to the right (or left, by -1), wrapping around
  public func selectTab(by offset: Int) {
    guard let i = currentIndex, tabs.count > 1 else { return }
    selected = tabs[(i + offset % tabs.count + tabs.count) % tabs.count].id
  }

  /// Closing the selected tab selects the one to its right, else the one to its left; the last one closed leaves the
  /// pane open, empty
  public func close(_ tab: ReadingTab.ID) {
    guard let i = tabs.firstIndex(where: { $0.id == tab }) else { return }
    tabs.remove(at: i)
    if selected == tab { selected = tabs.isEmpty ? nil : tabs[min(i, tabs.count - 1)].id }
  }

  public func move(_ tab: ReadingTab.ID, to index: Int) {
    guard let i = tabs.firstIndex(where: { $0.id == tab }) else { return }
    tabs.insert(tabs.remove(at: i), at: max(0, min(index, tabs.count)))
  }

  private var currentIndex: Int? { tabs.firstIndex { $0.id == selected } }
}

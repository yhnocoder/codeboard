import AppKit
import CodeBoardDiagnostics
import CodeBoardModel
import CodeBoardResources
import Observation

/// A tab of the reading pane: what it shows and the name on its tab. `key` is what it was opened for (a resource, a
/// PDF): opening the same key again goes to this tab
public struct ReadingTab: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public var key: String?
  public var title: String
  /// Which kind of view it shows (ReadingKinds); "" a blank page, as is a kind this build has not registered
  public var kind: String
  /// What its kind needs to show it again, saved with the tab
  public var payload: [String: String]

  public init(title: String, key: String? = nil, kind: String = "", payload: [String: String] = [:]) {
    id = UUID()
    self.key = key
    self.title = title
    self.kind = kind
    self.payload = payload
  }

  /// The SF Symbol before its title; nil: none
  @MainActor public var icon: String? { ReadingKinds.icon(of: kind) }

  private enum CodingKeys: String, CodingKey {
    case id, key, title, kind, payload
  }

  // a tab saved before tabs had kinds is a blank page, a resource's a list
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(UUID.self, forKey: .id)
    key = try c.decodeIfPresent(String.self, forKey: .key)
    title = try c.decode(String.self, forKey: .title)
    let resource = key?.hasPrefix("resource:") == true ? key.map { String($0.dropFirst(9)) } : nil
    kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? (resource == nil ? "" : "list")
    payload = try c.decodeIfPresent([String: String].self, forKey: .payload) ?? resource.map { ["resource": $0] } ?? [:]
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

  // What every tab's view reads and hands on, set by the shell
  /// The open vault
  @ObservationIgnored public var vault: Vault?
  /// Its entries, as last read with its tree
  @ObservationIgnored public var entries = EntryIndex()
  /// Where Copy puts text: the general pasteboard; tests give one of their own
  @ObservationIgnored public var pasteboard = NSPasteboard.general
  /// A passage taken to the board (Add to Board, ⌥↵)
  @ObservationIgnored public var onCollect: ((Collected) -> Void)?
  /// This machine's data of the app, never in the vault: each kind has a folder in it (ReadingContext.dataFolder)
  @ObservationIgnored public var machineFolder: URL?
  /// arXiv, where a paper's newer versions come from; tests give one that answers without the network
  @ObservationIgnored public var arxiv = Arxiv()
  /// This machine's translations (the shell makes them); nil: none, and no "+ 译文"
  @ObservationIgnored public var translations: Translations?
  /// The board's bar look in its theme now (the shell sets it); tabs' views follow it
  public var barLook = ReadingBarLook.warmInk(dark: false)

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

  /// A tab titled `title` showing `kind` (its view made from `payload`) after the current one, selected, the pane
  /// shown; one opened for the same `key` is gone to instead
  @discardableResult public func open(
    _ title: String, key: String? = nil, kind: String = "", payload: [String: String] = [:]
  ) -> ReadingTab.ID {
    Diag.event("reading.open", payload.merging(["kind": kind, "key": key ?? "", "title": title]) { a, _ in a })
    shown = true
    if let key, let tab = tabs.first(where: { $0.key == key }) {
      selected = tab.id
      return tab.id
    }
    let tab = ReadingTab(title: title, key: key, kind: kind, payload: payload)
    tabs.insert(tab, at: currentIndex.map { $0 + 1 } ?? tabs.count)
    selected = tab.id
    return tab.id
  }

  public func select(_ tab: ReadingTab.ID) {
    if let t = tabs.first(where: { $0.id == tab }) {
      Diag.event(
        "reading.select", t.payload.merging(["kind": t.kind, "key": t.key ?? "", "title": t.title]) { a, _ in a })
      selected = tab
    }
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

  /// What the tabs show changed: `title` gives each tab its title now, nil when what it shows is gone and it closes
  public func follow(_ title: (ReadingTab) -> String?) {
    for tab in tabs {
      guard let t = title(tab) else {
        close(tab.id)
        continue
      }
      if t != tab.title, let i = tabs.firstIndex(where: { $0.id == tab.id }) { tabs[i].title = t }
    }
  }

  /// A tab's view changed what it shows: its title, what it saves, the key it is gone to by; nil leaves each as it is,
  /// and an empty key clears the tab's. Its view stays
  public func update(_ tab: ReadingTab.ID, title: String? = nil, payload: [String: String]? = nil, key: String? = nil) {
    guard let i = tabs.firstIndex(where: { $0.id == tab }) else { return }
    if let title, title != tabs[i].title { tabs[i].title = title }
    if let payload, payload != tabs[i].payload { tabs[i].payload = payload }
    if let key, (key.isEmpty ? nil : key) != tabs[i].key { tabs[i].key = key.isEmpty ? nil : key }
  }

  public func move(_ tab: ReadingTab.ID, to index: Int) {
    guard let i = tabs.firstIndex(where: { $0.id == tab }) else { return }
    tabs.insert(tabs.remove(at: i), at: max(0, min(index, tabs.count)))
  }

  private var currentIndex: Int? { tabs.firstIndex { $0.id == selected } }
}

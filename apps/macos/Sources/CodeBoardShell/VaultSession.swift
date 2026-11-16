import AppKit
import CodeBoardCanvas
import CodeBoardModel
import Observation

/// What the app's windows share: the open vault and its tree, the theme and the appearance it is shown in. Each
/// window's shell reads it through; disk access happens outside and reaches it through `open(_:)` and `apply(_:)`.
@MainActor @Observable public final class VaultSession {
  public private(set) var vault: Vault?
  public private(set) var tree: VaultFolder?
  /// Why the tree could not be read; the last good tree stays
  public private(set) var treeError: String?
  /// This app's own data on this machine, never the vault's (Application Support/<its id>): the reading tabs' kinds
  /// keep theirs in it; nil: none (tests)
  @ObservationIgnored public var machineFolder: URL?
  public var importing = false
  /// The look every board is drawn in; app-wide, kept by the app delegate
  public var theme: Theme.ID = .warmInk
  /// Whether the Mac's appearance is dark: the app follows it (`follow(_:)`) and has no setting of its own
  public private(set) var dark = false
  private var byID: [BoardID: VaultBoard] = [:]
  /// Where deleted boards and folders go: the system Trash; tests give a stand-in
  public var trasher: Vault.Trasher = Vault.systemTrash
  /// Where Copy Path, and Copy in the reading pane, put text: the general pasteboard; tests give one of their own
  @ObservationIgnored public var pasteboard = NSPasteboard.general

  /// Every window's shell, each told of a fresh tree whichever window read it (`Shell.apply`)
  @ObservationIgnored private var joined: [Joined] = []
  private struct Joined {
    weak var shell: Shell?
  }

  public init() {}

  func join(_ shell: Shell) {
    joined.removeAll { $0.shell == nil }
    joined.append(Joined(shell: shell))
  }

  var shells: [Shell] { joined.compactMap(\.shell) }

  /// The theme in the appearance the app shows: what boards, the board panel and its glass are drawn in
  public var look: Theme { Theme.named(theme, dark: dark) }

  /// Takes the appearance the app is shown in (NSApp's effective appearance)
  public func follow(_ appearance: NSAppearance) {
    let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    if dark != self.dark { self.dark = dark }
  }

  public func board(_ id: BoardID) -> VaultBoard? { byID[id] }

  /// Opens a vault; its tree comes with the first read
  func open(_ vault: Vault) {
    self.vault = vault
    tree = nil
    treeError = nil
    byID = [:]
  }

  /// A fresh read of the tree; a failure keeps the last good one
  func apply(_ result: Result<VaultFolder, any Error>) {
    switch result {
    case .failure(let error):
      treeError = String(describing: error)
    case .success(let tree):
      self.tree = tree
      treeError = nil
      byID = Dictionary(tree.allBoards.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }
  }
}

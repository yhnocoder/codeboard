import AppKit
import CodeBoardWorkspace
import Foundation
import Observation
import os

/// What the sidebar's repositories block shows: the repositories added on this machine (the app's one `Repositories`),
/// the clones under way, the repository opened in place of the list with its file tree, and the block's height
@MainActor @Observable final class RepositoriesModel {
  /// A clone under way, or one that failed, its error on its row until dismissed
  struct Clone: Identifiable {
    let id = UUID()
    /// owner/name
    let name: String
    let key: String
    var error: String?
    var task: Task<Void, Never>?
  }

  struct Entry: Hashable, Sendable {
    let name: String
    let isFolder: Bool
  }

  @ObservationIgnored private let store: Repositories?
  private(set) var list: [Repository] = []
  private(set) var clones: [Clone] = []
  /// Why the block cannot work (no git, the list unreadable), said once in the block
  private(set) var problem: String?
  /// Why the last add or remove did not go through, under the header until the next one
  var notice: String?
  private(set) var opened: Repository?
  /// The opened repository's HEAD, short; nil until read, or when it is no git repository
  private(set) var head: String?
  /// The opened repository's folders shown open, relative to it
  private(set) var expanded: Set<String> = []
  /// What each folder listed has, by its path relative to the repository ("": the top)
  private(set) var children: [String: [Entry]] = [:]
  private(set) var selected: String?
  /// Set by dragging the line above the block; nil: the default
  private(set) var height: CGFloat?
  /// A file of the opened repository clicked (preview) or double-clicked (kept): the reading pane's to show
  /// The folder the user picks in the window's open panel (nil: none picked)
  @ObservationIgnored var askFolder: (@MainActor () async -> URL?)?
  @ObservationIgnored var onOpen: ((Repository, String, _ preview: Bool) -> Void)?
  @ObservationIgnored private let runner: any GitRunner
  @ObservationIgnored private let defaults: UserDefaults?
  @ObservationIgnored private var gitCheck: Task<Bool, Never>?
  private static let heightKey = "repositoriesHeight"
  private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "CodeBoard", category: "repositories")

  /// `folder`: the app's data folder; `defaults`: where the block's height is kept (nil: not kept)
  init(folder: URL, runner: any GitRunner, defaults: UserDefaults?) {
    self.runner = runner
    self.defaults = defaults
    do {
      store = try Repositories(folder: folder, git: GitCache(runner: runner))
    } catch {
      store = nil
      problem = "The list of repositories could not be read: \(error.localizedDescription)"
      Self.log.error("repositories.json unreadable: \(String(describing: error), privacy: .public)")
    }
    if let h = defaults?.object(forKey: Self.heightKey) as? Double { height = h }
    Task { await self.refresh() }
  }

  /// The list as the store has it (read when the block starts)
  func refresh() async {
    guard let store else { return }
    list = await store.all
    // only when there is something to use it on: without the developer tools every git run brings up the system's
    // install dialog
    if !list.isEmpty { _ = await gitWorks() }
  }

  /// git asked once a run: `git --version`
  private func gitWorks() async -> Bool {
    let runner = runner
    let check =
      gitCheck
      ?? Task {
        do {
          _ = try await runner.run(["--version"], in: "/", environment: [:])
          return true
        } catch {
          return false
        }
      }
    gitCheck = check
    let ok = await check.value
    if !ok && problem == nil { problem = Self.noGit }
    return ok
  }

  static let noGit =
    "Repositories need git, which is not installed. Install Apple's command line developer tools (xcode-select --install) or git from Homebrew, then open CodeBoard again."

  /// The app's: under its data folder, git found where a GUI app can find it, the height in the app's defaults
  static func forApp(folder: URL) -> RepositoriesModel {
    RepositoriesModel(folder: folder, runner: ProcessGitRunner(executable: findGit()), defaults: .standard)
  }

  /// The git a GUI app can run: its PATH lacks Homebrew's, and macOS's /usr/bin/git is only a stand-in that asks to
  /// install the developer tools, so it comes last
  nonisolated static func findGit() -> String? {
    let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
    let dirs = path.split(separator: ":").map(String.init).filter { $0 != "/usr/bin" }
    return (dirs + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]).map { $0 + "/git" }
      .first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  // MARK: The list

  /// owner/name for a clone, the folder's name for a folder
  static func name(_ r: Repository) -> String {
    if case .clone = r.kind, let gh = r.remote.flatMap({ try? GitHubRepo(address: $0) }) {
      return "\(gh.owner)/\(gh.name)"
    }
    return URL(filePath: r.path).lastPathComponent
  }

  func pickFolder() async {
    if let url = await askFolder?() { await addFolder(url.path(percentEncoded: false)) }
  }

  func addFolder(_ path: String) async {
    notice = nil
    guard let store, await gitWorks() else { return }
    do {
      _ = try await store.addFolder(path)
    } catch {
      notice = Self.words(error)
    }
    list = await store.all
  }

  /// Starts cloning, its row in the list at once; what is wrong with the address is returned (said where it was typed)
  /// and nothing starts
  func addGitHub(_ address: String, lightweight: Bool) -> String? {
    guard let store else { return problem }
    let gh: GitHubRepo
    do {
      gh = try GitHubRepo(address: address)
    } catch {
      return Self.words(error)
    }
    let key = repositoryKey("https://github.com/\(gh.owner)/\(gh.name)")
    if let have = list.first(where: { $0.remote.map(repositoryKey) == key }) {
      return Self.words(RepositoryError.alreadyAdded(have))
    }
    if clones.contains(where: { $0.key == key && $0.error == nil }) {
      return "\(gh.owner)/\(gh.name) is being cloned already"
    }
    notice = nil
    // tried again after it failed
    clones.removeAll { $0.key == key }
    var clone = Clone(name: "\(gh.owner)/\(gh.name)", key: key)
    let id = clone.id
    clone.task = Task {
      var failed: String?
      if await self.gitWorks() {
        do {
          _ = try await store.addGitHub(address, lightweight: lightweight)
        } catch let e as GitError where e == .cancelled {
        } catch {
          failed = Self.words(error)
        }
      } else {
        failed = Self.noGit
      }
      self.list = await store.all
      guard let i = self.clones.firstIndex(where: { $0.id == id }) else { return }
      if let failed {
        self.clones[i].error = failed
        self.clones[i].task = nil
      } else {
        self.clones.remove(at: i)
      }
    }
    clones.append(clone)
    return nil
  }

  /// Stops a clone (nothing of it stays), or dismisses a failed one's row
  func cancel(_ id: UUID) {
    guard let i = clones.firstIndex(where: { $0.id == id }) else { return }
    clones[i].task?.cancel()
    clones.remove(at: i)
  }

  /// Asked first: a clone's copy is deleted, a folder only forgotten
  func remove(_ r: Repository, confirm: @MainActor (NSAlert) async -> Bool) async {
    guard let store, await confirm(Self.removeQuestion(r)) else { return }
    notice = nil
    do {
      try await store.remove(r)
    } catch {
      notice = Self.words(error)
    }
    list = await store.all
    if let opened, !list.contains(where: { $0.path == opened.path }) { close() }
  }

  static func removeQuestion(_ r: Repository) -> NSAlert {
    let name = name(r)
    if case .clone = r.kind {
      return BoardPanes.destroying(
        "Remove “\(name)”?",
        "The copy CodeBoard downloaded is deleted from this Mac. You can add it again from GitHub.",
        "Remove")
    }
    return BoardPanes.destroying(
      "Remove “\(name)” from the list?", "Only the entry is forgotten. The folder and its files stay as they are.",
      "Remove")
  }

  /// In plain words; git's own when it said why
  static func words(_ error: any Error) -> String {
    switch error {
    case GitError.unavailable(_): noGit
    case GitError.cancelled: "Stopped."
    // git's first fatal line says why; the rest is advice for a terminal
    case RepositoryError.cloneFailed(let why):
      "The clone failed: "
        + (why.split(separator: "\n").first { $0.hasPrefix("fatal: ") }.map { String($0.dropFirst(7)) }
          ?? why.split(separator: "\n").first.map(String.init) ?? "git gave no reason")
    case let e as LocalizedError: e.errorDescription ?? error.localizedDescription
    default: error.localizedDescription
    }
  }

  // MARK: The opened repository

  /// Shows the repository's files in place of the list
  func open(_ r: Repository) async {
    opened = r
    head = nil
    expanded = []
    children = [:]
    selected = nil
    await list("")
    if let store, await gitWorks(), let h = try? await store.git.headOf(r.path), opened == r {
      head = String(h.prefix(7))
    }
  }

  struct TreeRow: Hashable {
    /// Relative to the repository
    let path: String
    let name: String
    let isFolder: Bool
    let depth: Int
  }

  /// The opened repository's rows as the tree shows them: each folder, then what is in it while it is open
  var rows: [TreeRow] {
    var out: [TreeRow] = []
    func walk(_ rel: String, _ depth: Int) {
      for e in children[rel] ?? [] {
        let path = rel.isEmpty ? e.name : rel + "/" + e.name
        out.append(TreeRow(path: path, name: e.name, isFolder: e.isFolder, depth: depth))
        if e.isFolder && expanded.contains(path) { walk(path, depth + 1) }
      }
    }
    walk("", 0)
    return out
  }

  func close() {
    opened = nil
    head = nil
    expanded = []
    children = [:]
    selected = nil
  }

  /// Opens or closes a folder of the opened repository; opened, it is listed again
  func toggle(_ rel: String) async {
    if expanded.remove(rel) == nil {
      expanded.insert(rel)
      await list(rel)
    }
  }

  func click(_ rel: String, preview: Bool) {
    guard let opened else { return }
    selected = rel
    onOpen?(opened, rel, preview)
  }

  /// Off the main actor: a folder of thousands of files lists without holding up a frame
  private func list(_ rel: String) async {
    guard let r = opened else { return }
    let base = URL(filePath: r.path, directoryHint: .isDirectory)
    let dir = rel.isEmpty ? base : base.appending(path: rel, directoryHint: .isDirectory)
    let entries = await Task.detached { Self.entries(of: dir) }.value
    guard opened == r else { return }
    children[rel] = entries
  }

  /// A folder's entries, folders first, each part in Finder's order; .git and Finder's .DS_Store left out, links not
  /// followed
  nonisolated static func entries(of dir: URL) -> [Entry] {
    let urls =
      (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
    return urls.filter { ![".git", ".DS_Store"].contains($0.lastPathComponent) }
      .map { u in
        Entry(
          name: u.lastPathComponent, isFolder: (try? u.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true)
      }
      .sorted { a, b in
        a.isFolder != b.isFolder ? a.isFolder : a.name.localizedStandardCompare(b.name) == .orderedAscending
      }
  }

  // MARK: Height

  /// The line above the block and the space it can be grabbed in
  static let handle: CGFloat = 8
  static let row: CGFloat = ShellTheme.rowHeight + 1

  /// Each side keeps about three rows: the block its header and two, the vault tree three
  static func clamp(_ h: CGFloat, room: CGFloat) -> CGFloat {
    let least = handle + 3 * row
    return max(least, min(h, room - 3 * row))
  }

  /// The block's height in a sidebar `room` tall: the dragged one; else the list's own (`content`), up to half, or
  /// half for an opened repository's files
  func shown(content: CGFloat, room: CGFloat) -> CGFloat {
    if let height { return Self.clamp(height, room: room) }
    let half = Self.clamp(room / 2, room: room)
    return opened == nil ? min(content, half) : half
  }

  func drag(to h: CGFloat, room: CGFloat) { height = Self.clamp(h.rounded(), room: room) }

  func dragEnded() {
    if let height { defaults?.set(Double(height), forKey: Self.heightKey) }
  }

  func restoreHeight() {
    height = nil
    defaults?.removeObject(forKey: Self.heightKey)
  }
}

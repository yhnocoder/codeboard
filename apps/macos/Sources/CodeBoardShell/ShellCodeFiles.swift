import CodeBoardReading
import CodeBoardWorkspace
import Foundation
import Observation

/// The repositories the window's code tabs and the sidebar's opened repository show, followed on disk, one watcher per
/// repository (RepoWatcher, shared with the version checks): files changed are read again by their tabs and analysed
/// again by the repository's name index, a commit moved is read again by the tabs' bars. Bursts are taken together
/// after the product's pauses (VersionPause), so a checkout of thousands of files reads a tab once. A repository
/// nothing shows any more is no longer watched. (No DefCache to forget: the Mac shell asks the name index, no language
/// server.)
@MainActor final class ShellCodeFiles {
  private weak var code: ShellCode?
  /// How long to wait (the tests' wait nothing)
  var pause: @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }
  /// By repository folder, as tabs name it: what stops its watcher (a no-op while it is being started)
  private var watching: [String: () -> Void] = [:]
  private var filesDue: Set<String> = []
  private var headsDue: Set<String> = []
  private var filesWait: Task<Void, Never>?
  private var headsWait: Task<Void, Never>?
  /// What is shown is being watched for a change
  private var armed = false

  init(code: ShellCode) { self.code = code }

  /// What is watched follows what is shown: the folders of the pane's code tabs and the sidebar's opened repository
  func follow() {
    guard let code else { return }
    let folders = Set(
      (code.pane?.codeFiles.map(\.repository) ?? []) + [code.repositories?.opened?.path].compactMap { $0 })
    for (f, stop) in watching where !folders.contains(f) {
      stop()
      watching[f] = nil
    }
    for f in folders where watching[f] == nil {
      watching[f] = {}
      Task { await watch(f) }
    }
    guard !armed else { return }
    armed = true
    withObservationTracking {
      _ = code.pane?.tabs
      _ = code.repositories?.opened
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        self?.armed = false
        self?.follow()
      }
    }
  }

  private func watch(_ folder: String) async {
    guard let code else { return }
    let r = code.repo(folder)
    let root = await r.info.value?.root ?? r.root
    let at = await RepoWatcher.place(root, git: code.git)
    guard watching[folder] != nil else { return }
    let git = code.git
    watching[folder] = RepoWatcher.listen(at.paths) { [weak self] paths in
      let heard = RepoWatcher.sort(paths, root: root, gitDir: at.gitDir)
      if heard.ignore { Task { await git.forgetIgnored() } }
      self?.heard(folder, heard)
    }
  }

  func heard(_ folder: String, _ h: RepoWatcher.Heard) {
    if !h.files.isEmpty {
      filesDue.formUnion(h.files)
      filesWait?.cancel()
      filesWait = Task { [weak self, pause] in
        await pause(VersionPause.recheck)
        guard !Task.isCancelled else { return }
        self?.filesChanged()
      }
    }
    if h.head {
      headsDue.insert(folder)
      headsWait?.cancel()
      headsWait = Task { [weak self, pause] in
        await pause(VersionPause.git)
        guard !Task.isCancelled else { return }
        self?.headsChanged()
      }
    }
  }

  /// The tabs of the files changed read them again; each repository's name index hears of its files, changed or gone
  private func filesChanged() {
    guard let code else { return }
    let paths = filesDue
    filesDue = []
    let indexes = code.repos.values.map { ($0.root + "/", $0.sources.lookup.index) }
    Task.detached {
      for (root, index) in indexes {
        for p in paths where p.hasPrefix(root) {
          if FileManager.default.fileExists(atPath: p) { await index.changed(p) } else { await index.removed(p) }
        }
      }
    }
    guard let pane = code.pane else { return }
    let files = pane.codeFiles.filter { paths.contains(code.repo($0.repository).root + "/" + $0.path) }
    guard !files.isEmpty else { return }
    NotificationCenter.default.post(name: CodeReading.filesChanged, object: pane, userInfo: ["files": files])
  }

  private func headsChanged() {
    let folders = headsDue
    headsDue = []
    guard let pane = code?.pane else { return }
    NotificationCenter.default.post(
      name: CodeReading.commitsChanged, object: pane, userInfo: ["repositories": Array(folders)])
  }
}

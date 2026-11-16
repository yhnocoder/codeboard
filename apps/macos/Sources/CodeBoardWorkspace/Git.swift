import CodeBoardAnalysis
import Foundation

// packages/host/src/git.ts: what the host asks git, and what one host remembers of git's answers. A git that is not
// available is thrown as GitError and never remembered, so that it is asked again once git is there.

/// A commit of git log --format=%H%x09%s%x09%as
public struct LogEntry: Hashable, Sendable {
  public var commit: String
  public var msg: String
  public var date: String

  public init(commit: String, msg: String, date: String) {
    self.commit = commit
    self.msg = msg
    self.date = date
  }
}

/// A worktree of a repository: its folder, the commit checked out there, its branch
public struct Worktree: Hashable, Sendable {
  public var dir: String
  public var head: String?
  public var branch: String?

  public init(dir: String, head: String? = nil, branch: String? = nil) {
    self.dir = dir
    self.head = head
    self.branch = branch
  }
}

public struct GitHubRepo: Hashable, Sendable {
  public var owner: String
  public var name: String
}

/// core's parseGitLog: the lines of git log --format=%H%x09%s%x09%as that start with a commit
public func parseGitLog(_ out: String) -> [LogEntry] {
  unitSplit(out, "\n").map { unitSplit($0, "\t") }
    .filter { isHex($0[0], 7...40) }
    .map { LogEntry(commit: $0[0], msg: $0.count > 1 ? $0[1] : "", date: $0.count > 2 ? $0[2] : "") }
}

private func isHex(_ s: String, _ length: ClosedRange<Int>) -> Bool {
  length.contains(s.utf8.count) && s.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
}

/// A full commit sha
func isSha(_ s: String) -> Bool { isHex(s, 40...40) }

/// /^[\w./~^@{}-]+$/: a ref git can be given without it reading an option
private func isRefName(_ s: String) -> Bool {
  !s.isEmpty
    && s.utf8.allSatisfy { c in
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || "_./~^@{}-".utf8.contains(c)
    }
}

private let githubUrl = JSRegex(#"github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$"#)
private let gitLogFormat = "--format=%H%x09%s%x09%as"

private func trimmed(_ s: String?) -> String? {
  guard let s else { return nil }
  let t = jsTrim(s)
  return t.isEmpty ? nil : t
}

// An actor: the answers asked for at once (every card of a board asks for its repository's root) share one git run
public actor GitCache {
  private struct Pending<T: Sendable>: Sendable {
    let id: Int
    let task: Task<Result<T, GitError>, Never>
  }

  public nonisolated let runner: any GitRunner
  /// Repository roots, git directories and common git directories, by kind and folder
  private var lookups: [String: Pending<String?>] = [:]
  private var ups: [String: Pending<String>] = [:]
  private var origins: [String: Pending<String?>] = [:]
  private var excluded: [String: Pending<Void>] = [:]
  private var shows = Lru<Pending<String?>>(200)
  private var ignored = Lru<Pending<Bool>>(2000)
  private var anc = Lru<Pending<Bool>>(500)
  private var next = 0

  public init(runner: any GitRunner = ProcessGitRunner()) {
    self.runner = runner
  }

  private func newId() -> Int {
    next += 1
    return next
  }

  // MARK: Repository lookups

  /// A lookup is remembered until forgetRepos (a git event, the workspace folders changed), "not in a repo" included:
  /// in a workspace that is no repo every lookup would start a git otherwise, and a later git init comes with a git
  /// event. Any other failure (the folder is gone, git failed) is nil but asked again next time
  private func lookup(_ kind: String, _ dir: String, _ args: [String], _ read: @escaping @Sendable (String) -> String?)
    async throws(GitError) -> String?
  {
    let k = "\(kind)\0\(dir)"
    if let p = lookups[k] { return try await p.task.value.get() }
    let id = newId()
    let p = Pending(id: id, task: Task { await self.runLookup(k, id, dir, args, read) })
    lookups[k] = p
    return try await p.task.value.get()
  }

  private func runLookup(_ k: String, _ id: Int, _ dir: String, _ args: [String], _ read: (String) -> String?) async
    -> Result<String?, GitError>
  {
    do throws(GitError) {
      // In English, to read why it failed
      let r = try await runner.run(args, in: dir, environment: ["LC_ALL": "C"])
      if case .exited(0, let out, _) = r { return .success(read(out)) }
      if case .exited(128, _, let err) = r, err.lowercased().contains("not a git repository") { return .success(nil) }
      if lookups[k]?.id == id { lookups[k] = nil }
      return .success(nil)
    } catch {
      if lookups[k]?.id == id { lookups[k] = nil }
      return .failure(error)
    }
  }

  /// The root of the git repository a folder is in (a submodule's own root for a file in it)
  public func repoRootOfDir(_ dir: String) async throws(GitError) -> String? {
    try await lookup("root", dir, ["rev-parse", "--show-toplevel"]) { trimmed($0).map(NodePath.normalize) }
  }

  public func repoRootOf(_ file: String) async throws(GitError) -> String? {
    try await repoRootOfDir(NodePath.dirname(file))
  }

  /// The absolute path of the .git folder (a submodule's is the outer repository's .git/modules/x)
  public func gitDirOf(_ root: String) async throws(GitError) -> String? {
    try await lookup("gitDir", root, ["rev-parse", "--absolute-git-dir"]) { trimmed($0) }
  }

  /// The git directory a repository's worktrees and submodule checkouts share (info/exclude is there). Asked from the
  /// root, so the relative path a git before 2.31 gives is relative to it
  public func commonDirOf(_ root: String) async throws(GitError) -> String? {
    try await lookup("common", root, ["rev-parse", "--git-common-dir"]) {
      trimmed($0).map { NodePath.resolve(root, $0) }
    }
  }

  /// The repositories changed (checkout, a branch made or deleted, a new origin, git init; the workspace folders
  /// changed): roots, git directories, upstream branches, origins and info/exclude lines written are asked again
  public func forgetRepos() {
    lookups = [:]
    ups = [:]
    origins = [:]
    excluded = [:]
  }

  // MARK: Files and commits

  /// A file's content at a commit; remembered when the commit is a full sha
  public func showFile(_ root: String, _ commit: String, _ rel: String) async throws(GitError) -> String? {
    let k = "\(root)\0\(commit)\0\(rel)"
    if let p = shows.get(k) { return try await p.task.value.get() }
    let args = ["show", "\(commit):\(rel)"]
    guard isSha(commit) else { return try await runner.output(root, args) }
    let id = newId()
    let p = Pending(id: id, task: Task { await self.runShow(k, id, root, args) })
    shows.set(k, p)
    return try await p.task.value.get()
  }

  private func runShow(_ k: String, _ id: Int, _ root: String, _ args: [String]) async -> Result<String?, GitError> {
    do throws(GitError) {
      return .success(try await runner.output(root, args))
    } catch {
      if shows.peek(k)?.id == id { shows.delete(k) }
      return .failure(error)
    }
  }

  /// Whether git ignores the file (generated build/ output): it is in no commit and never will be. Remembered until
  /// forgetIgnored: HEAD changed (a checkout may bring another .gitignore), .gitignore or .git/info/exclude changed
  public func isIgnored(_ root: String, _ rel: String) async throws(GitError) -> Bool {
    let k = "\(root)\0\(rel)"
    if let p = ignored.get(k) { return try await p.task.value.get() }
    let id = newId()
    let p = Pending(id: id, task: Task { await self.runIgnored(k, id, root, rel) })
    ignored.set(k, p)
    return try await p.task.value.get()
  }

  private func runIgnored(_ k: String, _ id: Int, _ root: String, _ rel: String) async -> Result<Bool, GitError> {
    do throws(GitError) {
      return .success(try await runner.status(root, ["check-ignore", "-q", "--", rel]) == 0)
    } catch {
      if ignored.peek(k)?.id == id { ignored.delete(k) }
      return .failure(error)
    }
  }

  public func forgetIgnored() { ignored.clear() }

  /// Whether commit a is an ancestor of commit b (or b). Between full shas the answer never changes: remembered when
  /// git answered (exit 0: yes, 1: no). A git error (the commit not fetched yet, the repository gone) is "no", asked
  /// again next time
  public func isAncestor(_ root: String, _ a: String, _ b: String) async throws(GitError) -> Bool {
    let k = "\(root)\0\(a)\0\(b)"
    if let p = anc.get(k) { return try await p.task.value.get() }
    let id = newId()
    let p = Pending(id: id, task: Task { await self.runAncestor(k, id, root, a, b) })
    if isSha(a) && isSha(b) { anc.set(k, p) }
    return try await p.task.value.get()
  }

  private func runAncestor(_ k: String, _ id: Int, _ root: String, _ a: String, _ b: String) async
    -> Result<Bool, GitError>
  {
    do throws(GitError) {
      let code = try await runner.status(root, ["merge-base", "--is-ancestor", a, b])
      if code != 0 && code != 1 && anc.peek(k)?.id == id { anc.delete(k) }
      return .success(code == 0)
    } catch {
      if anc.peek(k)?.id == id { anc.delete(k) }
      return .failure(error)
    }
  }

  // MARK: Remotes and branches

  public func origin(_ root: String) async throws(GitError) -> String? {
    if let p = origins[root] { return try await p.task.value.get() }
    let id = newId()
    let p = Pending(id: id, task: Task { await self.runOrigin(root, id) })
    origins[root] = p
    return try await p.task.value.get()
  }

  private func runOrigin(_ root: String, _ id: Int) async -> Result<String?, GitError> {
    do throws(GitError) {
      return .success(try await originUrl(root))
    } catch {
      if origins[root]?.id == id { origins[root] = nil }
      return .failure(error)
    }
  }

  /// The upstream branch: the one origin/HEAD names, else a local main or master, else HEAD
  public func upstreamRef(_ root: String) async throws(GitError) -> String {
    if let p = ups[root] { return try await p.task.value.get() }
    let id = newId()
    let p = Pending(id: id, task: Task { await self.runUpstream(root, id) })
    ups[root] = p
    return try await p.task.value.get()
  }

  private func runUpstream(_ root: String, _ id: Int) async -> Result<String, GitError> {
    do throws(GitError) {
      if let o = trimmed(try await runner.output(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])) {
        return .success(o)
      }
      for b in ["main", "master"] {
        if try await resolveRef(root, b) != nil { return .success(b) }
      }
      return .success("HEAD")
    } catch {
      if ups[root]?.id == id { ups[root] = nil }
      return .failure(error)
    }
  }

  /// Adds the line pattern under the comment note to the info/exclude of the repository dir is in (local, never
  /// committed); worktrees and submodules have theirs in the git directory they share. Outside a repository or when
  /// git or the file fails it does nothing; once per folder until forgetRepos
  public func excludeFromGit(_ dir: String, _ pattern: String, note: String) async throws(GitError) {
    let k = "\(dir)\0\(pattern)"
    if let p = excluded[k] { return try await p.task.value.get() }
    let id = newId()
    let p = Pending(id: id, task: Task { await self.runExclude(k, id, dir, pattern, note) })
    excluded[k] = p
    try await p.task.value.get()
  }

  private func runExclude(_ k: String, _ id: Int, _ dir: String, _ pattern: String, _ note: String) async
    -> Result<Void, GitError>
  {
    let common: String?
    do throws(GitError) {
      let root = try await repoRootOfDir(dir)
      common = root == nil ? nil : try await commonDirOf(root!)
    } catch {
      if excluded[k]?.id == id { excluded[k] = nil }
      return .failure(error)
    }
    guard let common else { return .success(()) }
    let f = NodePath.join(common, "info", "exclude")
    let t = FileManager.default.contents(atPath: f).map { String(decoding: $0, as: UTF8.self) } ?? ""
    if splitLines(t).contains(where: { jsEqual($0, pattern) }) { return .success(()) }
    let add = (!t.isEmpty && !t.hasSuffix("\n") ? "\n" : "") + "# \(note)\n\(pattern)\n"
    // Not written: git status shows the file
    try? FileManager.default.createDirectory(atPath: NodePath.dirname(f), withIntermediateDirectories: true)
    if let h = FileHandle(forWritingAtPath: f) {
      _ = try? h.seekToEnd()
      try? h.write(contentsOf: Data(add.utf8))
      try? h.close()
    } else {
      _ = FileManager.default.createFile(atPath: f, contents: Data(add.utf8))
    }
    return .success(())
  }

  // MARK: Not remembered

  /// The repository's HEAD commit, read every time: a remembered HEAD outlives a commit until the .git watcher has
  /// run, and a version check started in between would compare with the commit before
  public nonisolated func headOf(_ root: String) async throws(GitError) -> String? {
    trimmed(try await runner.output(root, ["rev-parse", "HEAD"]))
  }

  public nonisolated func resolveRef(_ root: String, _ ref: String) async throws(GitError) -> String? {
    guard isRefName(ref) else { return nil }
    return trimmed(try await runner.output(root, ["rev-parse", "--verify", "--quiet", "\(ref)^{commit}"]))
  }

  /// The commits that changed lines start...end (git log -L), else those that changed the file
  public nonisolated func logLines(
    _ root: String, _ rel: String, start: Int, end: Int, rev: String = "HEAD", n: Int = 30
  ) async throws(GitError) -> [LogEntry] {
    let out = try await runner.output(root, ["log", gitLogFormat, "-s", "-n\(n)", "-L\(start),\(end):\(rel)", rev])
    let l = out.map(parseGitLog) ?? []
    if !l.isEmpty { return l }
    return parseGitLog(try await runner.output(root, ["log", gitLogFormat, "-n\(n)", rev, "--", rel]) ?? "")
  }

  public nonisolated func commitInfo(_ root: String, _ commit: String) async throws(GitError) -> LogEntry? {
    parseGitLog(try await runner.output(root, ["log", "-1", gitLogFormat, commit]) ?? "").first
  }

  /// git worktree list: every worktree of the repository, root's own included, without bare ones and ones whose
  /// folder is gone (prunable). A submodule's main worktree is listed as its git directory (.git/modules/…): it is
  /// the folder its core.worktree names instead, or left out when there is none
  public func worktrees(_ root: String) async throws(GitError) -> [Worktree] {
    let out = try await runner.output(root, ["worktree", "list", "--porcelain"])
    let gd = try await commonDirOf(root)
    var list: [(w: Worktree, skip: Bool)] = []
    for l in unitSplit(out ?? "", "\n") {
      if l.hasPrefix("worktree ") {
        list.append((Worktree(dir: NodePath.normalize(String(l.dropFirst(9)))), false))
      } else if !list.isEmpty && l.hasPrefix("HEAD ") {
        list[list.count - 1].w.head = jsTrim(String(l.dropFirst(5)))
      } else if !list.isEmpty && l.hasPrefix("branch ") {
        let b = jsTrim(String(l.dropFirst(7)))
        list[list.count - 1].w.branch = b.hasPrefix("refs/heads/") ? String(b.dropFirst(11)) : b
      } else if !list.isEmpty && (l == "bare" || l.hasPrefix("prunable")) {
        list[list.count - 1].skip = true
      }
    }
    var res: [Worktree] = []
    for (w0, skip) in list where !skip {
      var w = w0
      if let gd, w.dir == gd {
        let cfg = ["config", "--file", NodePath.join(gd, "config"), "core.worktree"]
        guard let wt = trimmed(try await runner.output(root, cfg)) else { continue }
        w.dir = NodePath.resolve(gd, wt)
      }
      if !res.contains(where: { $0.dir == w.dir }) { res.append(w) }
    }
    return res
  }

  /// The local branches, last committed to first
  public nonisolated func branches(_ root: String, n: Int = 30) async throws(GitError) -> [String] {
    let out = try await runner.output(
      root, ["for-each-ref", "--sort=-committerdate", "--count=\(n)", "--format=%(refname:short)", "refs/heads"])
    return unitSplit(out ?? "", "\n").map { jsTrim($0) }.filter { !$0.isEmpty }
  }

  public nonisolated func githubRemote(_ root: String) async throws(GitError) -> GitHubRepo? {
    guard let m = githubUrl.exec(try await originUrl(root) ?? ""), let owner = m[1], let name = m[2] else { return nil }
    return GitHubRepo(owner: owner, name: name)
  }

  private nonisolated func originUrl(_ root: String) async throws(GitError) -> String? {
    trimmed(try await runner.output(root, ["remote", "get-url", "origin"]))
  }
}

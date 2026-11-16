import Foundation

// Where a code card's code is on this machine, from what its source recorded (FORMAT.md, source): the repository's
// remote URL, else the folder the VS Code extension read it in (checkout). The owner hands over the model's
// CodeSource's fields; this module does not know the model.

public enum RepoMatch: Hashable, Sendable {
  /// The commit is in this repository; root: its git root, which the card's path is relative to
  case found(Repository, root: String)
  /// The repository is here, but not the commit, fetching from its origin included
  case commitMissing(Repository)
  /// No repository added here has it: what the card gives to add one (address: its remote URL; folder: where it was
  /// read, still on this machine)
  case notAdded(address: String?, folder: String?)
}

extension Repositories {
  /// A git source's commit. A repository that has the URL but not the commit fetches it from its origin (a clone, or a
  /// folder with an origin) before saying it is missing. Without a URL: the repository the checkout folder's origin
  /// or path names, else any added repository that has the commit
  public func locate(repository: String?, commit: String, checkout: String?) async throws(GitError) -> RepoMatch {
    var isDir: ObjCBool = false
    var here: String?
    if let c = checkout, NodePath.isAbsolute(c), FileManager.default.fileExists(atPath: c, isDirectory: &isDir),
      isDir.boolValue
    {
      here = NodePath.resolve(c)
    }
    var address = repository
    if address == nil, let here, let root = try await git.repoRootOfDir(here) { address = try await git.origin(root) }
    let key = address.map(repositoryKey)
    let repos = all
    let named = repos.filter { r in (key != nil && r.remote.map(repositoryKey) == key) || r.path == here }
    // A ref git could read as an option is in no repository
    let asked = isRefName(commit)
    var roots: [(Repository, String)] = []
    for r in named.isEmpty && repository == nil ? repos : named {
      guard asked, let root = try await rootOf(r) else { continue }
      if try await has(root, commit) { return .found(r, root: root) }
      roots.append((r, root))
    }
    guard let first = named.first else { return .notAdded(address: address, folder: here) }
    for (r, root) in roots {
      _ = try await git.runner.status(root, ["fetch", "--quiet", "origin", commit])
      if try await has(root, commit) { return .found(r, root: root) }
    }
    return .commitMissing(first)
  }

  /// A file source's file (FORMAT.md: an absolute path, or one relative to the folder the extension had open): the
  /// path itself, else the first added repository folder that has it
  public func locateFile(_ path: String) -> String? {
    if NodePath.isAbsolute(path) { return FileManager.default.fileExists(atPath: path) ? path : nil }
    return all.map { NodePath.join($0.path, path) }.first { FileManager.default.fileExists(atPath: $0) }
  }

  private func rootOf(_ r: Repository) async throws(GitError) -> String? {
    if case .clone = r.kind { return r.path }
    return try await git.repoRootOfDir(r.path)
  }

  /// Not lazily fetched: a blobless clone would ask its origin for a commit it lacks one object at a time, and each
  /// clone looked through for a card without a URL would ask
  private func has(_ root: String, _ commit: String) async throws(GitError) -> Bool {
    let args = ["rev-parse", "--verify", "--quiet", "\(commit)^{commit}"]
    if case .exited(0, _, _) = try await git.runner.run(args, in: root, environment: ["GIT_NO_LAZY_FETCH": "1"]) {
      return true
    }
    return false
  }
}

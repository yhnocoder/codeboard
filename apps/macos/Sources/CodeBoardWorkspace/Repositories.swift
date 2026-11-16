import Foundation

// The repositories added on this machine: folders read in place, and GitHub repositories cloned into the app's own
// data folder. The list names absolute paths, so it is machine state, kept beside the clones and never in the vault.

/// A repository added on this machine
public struct Repository: Codable, Hashable, Sendable, Identifiable {
  public enum Kind: Codable, Hashable, Sendable {
    /// A folder on disk, read in place
    case folder
    /// Cloned from GitHub into the app's data folder; lightweight: blobless (contents fetched when read)
    case clone(lightweight: Bool)
  }

  public var kind: Kind
  /// The folder on this machine
  public var path: String
  /// A clone's GitHub address; a folder's origin when it was added (nil: not a git repository, or no origin)
  public var remote: String?

  public var id: String { path }
}

public enum RepositoryError: Error, Hashable, Sendable, LocalizedError {
  case notGitHub(String)
  case notAFolder(String)
  case alreadyAdded(Repository)
  /// The same repository is being cloned already
  case cloning(String)
  /// git's own words
  case cloneFailed(String)

  public var errorDescription: String? {
    switch self {
    case .notGitHub(let a): "\u{201C}\(a)\u{201D} is not the address of a GitHub repository (github.com/owner/name)"
    case .notAFolder(let p): "\(p) is not a folder"
    case .alreadyAdded(let r): "\(r.remote ?? r.path) is already added (\(r.path))"
    case .cloning(let a): "\(a) is being cloned already"
    case .cloneFailed(let why): "The clone failed: \(why)"
    }
  }
}

extension GitHubRepo {
  /// A repository's address as GitHub shows or git writes it: https://github.com/o/n, github.com/o/n,
  /// git@github.com:o/n.git, ssh://git@github.com/o/n, with .git, a trailing slash or a page below it (/tree/main)
  public init(address: String) throws(RepositoryError) {
    var s = address.trimmingCharacters(in: .whitespacesAndNewlines)
    if let cut = s.firstIndex(where: { $0 == "?" || $0 == "#" }) { s = String(s[..<cut]) }
    if s.hasPrefix("git@github.com:") {
      s = "github.com/" + s.dropFirst("git@github.com:".count)
    } else if let scheme = s.range(of: "://") {
      guard ["https", "http", "ssh", "git"].contains(s[..<scheme.lowerBound].lowercased()) else {
        throw .notGitHub(address)
      }
      s = String(s[scheme.upperBound...])
      if s.hasPrefix("git@") { s = String(s.dropFirst(4)) }
    }
    let parts = s.split(separator: "/").map(String.init)
    guard !s.hasPrefix("/"), parts.count >= 3, ["github.com", "www.github.com"].contains(parts[0].lowercased()) else {
      throw .notGitHub(address)
    }
    let name = parts[2].hasSuffix(".git") ? String(parts[2].dropLast(4)) : parts[2]
    // They name the clone's folder: nothing that could reach outside it
    guard parts[1].wholeMatch(of: /[A-Za-z0-9][A-Za-z0-9-]*/) != nil,
      name.wholeMatch(of: /[A-Za-z0-9._-]+/) != nil, name != ".", name != ".."
    else { throw .notGitHub(address) }
    owner = parts[1]
    self.name = name
  }
}

/// What two remote URLs of one repository have in common: no scheme or user, the scp form (host:path) as host/path, no
/// .git or trailing slash, the host in lower case; on GitHub, whose owners and names ignore case, all of it
public func repositoryKey(_ url: String) -> String {
  if let gh = try? GitHubRepo(address: url) { return "github.com/\(gh.owner)/\(gh.name)".lowercased() }
  var s = url.trimmingCharacters(in: .whitespacesAndNewlines)
  if let scheme = s.range(of: "://") {
    s = String(s[scheme.upperBound...])
  } else if !s.hasPrefix("/"), let colon = s.firstIndex(of: ":"), !s[..<colon].contains("/") {
    s.replaceSubrange(colon...colon, with: "/")
  }
  while s.hasSuffix("/") { s.removeLast() }
  if s.hasSuffix(".git") { s.removeLast(4) }
  guard !s.hasPrefix("/"), let slash = s.firstIndex(of: "/") else { return s }
  var host = s[..<slash]
  if let at = host.lastIndex(of: "@") { host = host[host.index(after: at)...] }
  return host.lowercased() + s[slash...]
}

/// The repositories added on this machine, kept in `<folder>/repositories.json`; clones are in `<folder>/repositories`
public actor Repositories {
  /// The app's data folder (Application Support/<its id>; a test's own folder)
  public nonisolated let folder: URL
  public nonisolated let git: GitCache
  public private(set) var all: [Repository]
  private var cloning: Set<String> = []

  private nonisolated var file: URL { folder.appending(path: "repositories.json") }
  private nonisolated var clones: URL { folder.appending(path: "repositories", directoryHint: .isDirectory) }

  /// Reads the list; none when there is no file yet. A file that cannot be read is thrown, never written over
  public init(folder: URL, git: GitCache) throws {
    self.folder = folder
    self.git = git
    let file = folder.appending(path: "repositories.json")
    all =
      FileManager.default.fileExists(atPath: file.path)
      ? try JSONDecoder().decode([Repository].self, from: Data(contentsOf: file)) : []
  }

  private func save() throws {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    try enc.encode(all).write(to: file, options: .atomic)
  }

  /// A folder read in place; its origin is read when it is in a git repository
  public func addFolder(_ path: String) async throws -> Repository {
    var isDir: ObjCBool = false
    guard NodePath.isAbsolute(path), FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue
    else { throw RepositoryError.notAFolder(path) }
    let path = NodePath.resolve(path)
    if let have = all.first(where: { $0.path == path }) { throw RepositoryError.alreadyAdded(have) }
    let root = try await git.repoRootOfDir(path)
    let remote = root == nil ? nil : try await git.origin(root!)
    // Asked again: another add may have come while git was asked
    if let have = all.first(where: { $0.path == path }) { throw RepositoryError.alreadyAdded(have) }
    let repo = Repository(kind: .folder, path: path, remote: remote)
    all.append(repo)
    try save()
    return repo
  }

  /// Clones a GitHub repository into `repositories/<owner>/<name>`; lightweight: commits only, file contents fetched
  /// when read. Cancelling the task stops git and leaves nothing behind.
  // ponytail: no progress; git's runner gives its output only at the end. A runner that streams stderr with --progress
  // is where it would come from
  public func addGitHub(_ address: String, lightweight: Bool) async throws -> Repository {
    let gh = try GitHubRepo(address: address)
    let remote = "https://github.com/\(gh.owner)/\(gh.name)"
    let key = repositoryKey(remote)
    if let have = all.first(where: { $0.remote.map(repositoryKey) == key }) {
      throw RepositoryError.alreadyAdded(have)
    }
    guard cloning.insert(key).inserted else { throw RepositoryError.cloning(remote) }
    defer { cloning.remove(key) }
    let parent = clones.appending(path: gh.owner, directoryHint: .isDirectory)
    let target = parent.appending(path: gh.name, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
    // What a clone stopped by a crash left: it is in no list
    try? FileManager.default.removeItem(at: target)
    let args = ["clone", "--quiet"] + (lightweight ? ["--filter=blob:none"] : []) + ["--", remote, target.path]
    let run: GitRun
    do {
      run = try await git.runner.run(args, in: parent.path, environment: [:])
    } catch {
      try? FileManager.default.removeItem(at: target)
      throw error
    }
    guard case .exited(0, _, _) = run else {
      try? FileManager.default.removeItem(at: target)
      guard case .exited(_, _, let err) = run else { throw RepositoryError.cloneFailed("git did not run") }
      throw RepositoryError.cloneFailed(err.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    let repo = Repository(kind: .clone(lightweight: lightweight), path: NodePath.resolve(target.path), remote: remote)
    all.append(repo)
    try save()
    return repo
  }

  /// Forgets the repository; a clone's folder is deleted too, only ever inside `repositories/`. A folder's files are
  /// never touched
  public func remove(_ repo: Repository) throws {
    guard let i = all.firstIndex(where: { $0.path == repo.path }) else { return }
    let inside = clones.standardizedFileURL.resolvingSymlinksInPath().path + "/"
    let at = URL(filePath: all[i].path).standardizedFileURL.resolvingSymlinksInPath()
    // Deleted before it is forgotten: a clone that could not be deleted stays listed
    if case .clone = all[i].kind, at.path.hasPrefix(inside), FileManager.default.fileExists(atPath: at.path) {
      try FileManager.default.removeItem(at: at)
      // the owner's folder with it once it holds no other clone: rmdir takes only an empty one
      let owner = at.deletingLastPathComponent().path
      if (owner + "/").hasPrefix(inside), owner + "/" != inside { rmdir(owner) }
    }
    all.remove(at: i)
    try save()
  }
}

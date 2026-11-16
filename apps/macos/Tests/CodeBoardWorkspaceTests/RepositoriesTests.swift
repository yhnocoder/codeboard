import CodeBoardWorkspace
import Foundation
import Synchronization
import Testing

/// GitHub on disk: its addresses are read as file:// ones under base, where fakeGitHub puts bare repositories, so a
/// clone goes through the code a real one does and never reaches the network
private final class DiskGitHub: GitRunner {
  let base: String
  let gate: Gate?
  let real = ProcessGitRunner()
  /// The folders git fetched in
  let fetched = Mutex([String]())

  init(_ base: String, gate: Gate? = nil) {
    self.base = base
    self.gate = gate
  }

  func run(_ args: [String], in dir: String, environment: [String: String]) async throws(GitError) -> GitRun {
    let prefix = "https://github.com/"
    let args = args.map { $0.hasPrefix(prefix) ? "file://\(base)/\($0.dropFirst(prefix.count))" : $0 }
    if args.first == "clone", let gate { await gate.wait() }
    if args.first == "fetch" { fetched.withLock { $0.append(dir) } }
    return try await real.run(args, in: dir, environment: environment)
  }
}

/// A repository at base/owner/name, bare and allowing blobless clones, and a work copy whose pushes reach it
private func fakeGitHub(_ base: String, _ owner: String, _ name: String) throws -> (work: String, head: String) {
  let work = try tempRepo(["f.py": "x = 1\n"])
  try FileManager.default.createDirectory(atPath: "\(base)/\(owner)", withIntermediateDirectories: true)
  try sh("\(base)/\(owner)", "clone", "-q", "--bare", work, name)
  try sh("\(base)/\(owner)/\(name)", "config", "uploadpack.allowFilter", "true")
  try sh(work, "remote", "add", "origin", "\(base)/\(owner)/\(name)")
  return (work, try sh(work, "rev-parse", "HEAD"))
}

/// A new commit, pushed to the fake GitHub
private func pushCommit(_ work: String) throws -> String {
  try write(work + "/f.py", "x = 2\n")
  try sh(work, "commit", "-qam", "two")
  try sh(work, "push", "-q", "origin", "main")
  return try sh(work, "rev-parse", "HEAD")
}

private func exists(_ p: String) -> Bool { FileManager.default.fileExists(atPath: p) }

@Suite struct GitHubAddressTests {
  @Test func readsTheAddressesGitHubShowsAndGitWrites() throws {
    for a in [
      "https://github.com/GeeeekExplorer/nano-vllm", "github.com/GeeeekExplorer/nano-vllm",
      "git@github.com:GeeeekExplorer/nano-vllm.git", "https://github.com/GeeeekExplorer/nano-vllm.git/",
      "https://github.com/GeeeekExplorer/nano-vllm/tree/main/nanovllm", "ssh://git@github.com/GeeeekExplorer/nano-vllm",
      "  https://www.github.com/GeeeekExplorer/nano-vllm?tab=readme-ov-file#install \n",
    ] {
      let r = try GitHubRepo(address: a)
      #expect(r.owner == "GeeeekExplorer" && r.name == "nano-vllm", "\(a)")
    }
  }

  @Test func refusesWhatNamesNoGitHubRepositoryOrAFolderOutsideItsOwn() {
    for a in [
      "", "https://gitlab.com/o/n", "github.com/o", "https://github.com.evil.example/o/n", "https://github.com/../n",
      "https://github.com/o/..", "https://github.com/o/.git", "file:///github.com/o/n", "/github.com/o/n",
      "github.com/-o/n",
    ] {
      #expect(throws: RepositoryError.notGitHub(a)) { try GitHubRepo(address: a) }
    }
  }
}

@Suite struct RepositoryKeyTests {
  @Test func aRepositorysRemotesHaveOneKeyHoweverTheyAreSpelt() {
    let github = [
      "https://github.com/Owner/Repo", "git@github.com:owner/repo.git", "ssh://git@github.com/OWNER/repo",
      "http://github.com/owner/Repo/",
    ]
    #expect(Set(github.map(repositoryKey)) == ["github.com/owner/repo"])
    let other = [
      "https://GitLab.example.com/Team/Repo.git", "git@gitlab.example.com:Team/Repo",
      "ssh://me@gitlab.example.com/Team/Repo/",
    ]
    #expect(Set(other.map(repositoryKey)) == ["gitlab.example.com/Team/Repo"])
    // Off GitHub a path's case may matter
    #expect(repositoryKey("https://gitlab.example.com/team/repo") != repositoryKey(other[0]))
    #expect(repositoryKey("https://github.com/owner/repo2") != repositoryKey(github[0]))
    #expect(repositoryKey("/srv/git/repo.git/") == "/srv/git/repo")
  }
}

@Suite struct RepositoriesTests {
  @Test func theListIsKeptAcrossLaunchesAndAFileThatCannotBeReadIsNeverWrittenOver() async throws {
    let (data, gh, plain) = (tempDir(), tempDir(), tempDir())
    let (work, _) = try fakeGitHub(gh, "o", "n")
    defer { remove(data, gh, plain, work) }
    let git = GitCache(runner: DiskGitHub(gh))
    let repos = try Repositories(folder: URL(filePath: data), git: git)
    let folder = try await repos.addFolder(work)
    let notGit = try await repos.addFolder(plain + "/")
    let clone = try await repos.addGitHub("https://github.com/o/n/tree/main", lightweight: true)
    #expect(folder.kind == .folder && folder.path == work && folder.remote == "\(gh)/o/n")
    #expect(notGit.kind == .folder && notGit.path == plain && notGit.remote == nil)
    #expect(clone.kind == .clone(lightweight: true) && clone.path == "\(data)/repositories/o/n")
    #expect(clone.remote == "https://github.com/o/n")
    #expect(try sh(clone.path, "config", "remote.origin.partialclonefilter") == "blob:none")
    #expect(try sh(clone.path, "rev-parse", "--is-shallow-repository") == "false")
    #expect(try await Repositories(folder: URL(filePath: data), git: git).all == [folder, notGit, clone])

    try write(data + "/repositories.json", "{not json")
    #expect(throws: (any Error).self) { try Repositories(folder: URL(filePath: data), git: git) }
    #expect(try String(contentsOfFile: data + "/repositories.json", encoding: .utf8) == "{not json")
  }

  @Test func removingAFolderForgetsItAndRemovingACloneDeletesOnlyItsOwnFolder() async throws {
    let (data, gh) = (tempDir(), tempDir())
    let (work, _) = try fakeGitHub(gh, "o", "n")
    defer { remove(data, gh, work) }
    let git = GitCache(runner: DiskGitHub(gh))
    let repos = try Repositories(folder: URL(filePath: data), git: git)
    let folder = try await repos.addFolder(work)
    let clone = try await repos.addGitHub("github.com/o/n", lightweight: false)
    try await repos.remove(folder)
    #expect(exists(work + "/f.py") && exists(work + "/.git"))
    try await repos.remove(clone)
    #expect(!exists(clone.path))
    #expect(exists("\(gh)/o/n/HEAD"))
    #expect(await repos.all.isEmpty)
    #expect(try await Repositories(folder: URL(filePath: data), git: git).all.isEmpty)

    // A list edited by hand: clones naming folders outside repositories/ are forgotten, their folders kept
    let outside = data + "/outside"
    try write(outside + "/keep.txt", "mine")
    try write(
      data + "/repositories.json",
      #"[{"kind":{"clone":{"lightweight":false}},"path":"\#(work)"},"#
        + #"{"kind":{"clone":{"lightweight":true}},"path":"\#(data)/repositories/o/../../outside"}]"#)
    let edited = try Repositories(folder: URL(filePath: data), git: git)
    for r in await edited.all { try await edited.remove(r) }
    #expect(await edited.all.isEmpty)
    #expect(exists(work + "/f.py") && exists(outside + "/keep.txt"))
  }

  @Test func aCloneThatFailsOrIsCancelledLeavesNothingAndARepositoryIsAddedOnce() async throws {
    let (data, gh) = (tempDir(), tempDir())
    let (work, _) = try fakeGitHub(gh, "o", "n")
    defer { remove(data, gh, work) }
    let gate = Gate()
    let repos = try Repositories(folder: URL(filePath: data), git: GitCache(runner: DiskGitHub(gh, gate: gate)))
    gate.open()
    do {
      _ = try await repos.addGitHub("github.com/o/missing", lightweight: true)
      Issue.record("a repository GitHub does not have was cloned")
    } catch RepositoryError.cloneFailed(let why) {
      #expect(!why.isEmpty)
    }
    #expect(!exists("\(data)/repositories/o/missing"))

    let held = Gate()
    let waiting = try Repositories(folder: URL(filePath: data), git: GitCache(runner: DiskGitHub(gh, gate: held)))
    let t = Task { try await waiting.addGitHub("github.com/o/n", lightweight: true) }
    await held.untilArrived()
    await #expect(throws: RepositoryError.cloning("https://github.com/o/n")) {
      try await waiting.addGitHub("git@github.com:o/n.git", lightweight: false)
    }
    t.cancel()
    held.open()
    await #expect(throws: GitError.cancelled) { try await t.value }
    #expect(!exists("\(data)/repositories/o/n"))
    #expect(await waiting.all.isEmpty)
    #expect(await repos.all.isEmpty)

    let clone = try await repos.addGitHub("github.com/o/n", lightweight: true)
    await #expect(throws: RepositoryError.alreadyAdded(clone)) {
      try await repos.addGitHub("git@github.com:O/N.git", lightweight: false)
    }
    await #expect(throws: RepositoryError.notAFolder(data + "/nope")) { try await repos.addFolder(data + "/nope") }
  }
}

@Suite struct LocateTests {
  @Test func aCardsRepositoryIsFoundHoweverItsURLIsSpeltAndOneNotHereIsOfferedByItsAddress() async throws {
    let (data, gh) = (tempDir(), tempDir())
    let (work, head) = try fakeGitHub(gh, "o", "n")
    defer { remove(data, gh, work) }
    let repos = try Repositories(folder: URL(filePath: data), git: GitCache(runner: DiskGitHub(gh)))
    let clone = try await repos.addGitHub("github.com/o/n", lightweight: true)
    #expect(
      try await repos.locate(repository: "git@github.com:O/N.git", commit: head, checkout: nil)
        == .found(clone, root: clone.path))
    #expect(
      try await repos.locate(repository: "https://github.com/o/other", commit: head, checkout: nil)
        == .notAdded(address: "https://github.com/o/other", folder: nil))
  }

  @Test func aMissingCommitIsFetchedFromOriginAndIsMissingOnlyWhenOriginHasNoneEither() async throws {
    let (data, gh, mine) = (tempDir(), tempDir(), tempDir())
    let (work, head) = try fakeGitHub(gh, "o", "n")
    defer { remove(data, gh, mine, work) }
    try sh(mine, "clone", "-q", "\(gh)/o/n", ".")
    let git = DiskGitHub(gh)
    let repos = try Repositories(folder: URL(filePath: data), git: GitCache(runner: git))
    let clone = try await repos.addGitHub("github.com/o/n", lightweight: true)
    let folder = try await repos.addFolder(mine)
    let later = try pushCommit(work)
    #expect(try await GitCache().resolveRef(mine, later) == nil)

    #expect(
      try await repos.locate(repository: "https://github.com/o/n", commit: later, checkout: nil)
        == .found(clone, root: clone.path))
    // By a fetch of its own, not git's lazy one for the missing object
    #expect(git.fetched.withLock { $0 } == [clone.path])
    #expect(
      try await repos.locate(repository: "\(gh)/o/n.git", commit: later, checkout: nil) == .found(folder, root: mine))
    // Fetched, not checked out: the user's folder is as it was
    #expect(try sh(mine, "rev-parse", "HEAD") == head)
    #expect(try String(contentsOfFile: mine + "/f.py", encoding: .utf8) == "x = 1\n")

    let nowhere = String(repeating: "de", count: 20)
    #expect(
      try await repos.locate(repository: "https://github.com/o/n", commit: nowhere, checkout: nil)
        == .commitMissing(clone))
  }

  @Test func withoutAURLTheCheckoutFolderOrTheCommitNamesTheRepository() async throws {
    let data = tempDir()
    let mine = try tempRepo(["a.py": "a = 1\n"])
    let origin = try tempRepo(["b.py": "b = 1\n"])
    let other = tempDir()
    defer { remove(data, mine, origin, other) }
    try sh(other, "clone", "-q", origin, ".")
    let repos = try Repositories(folder: URL(filePath: data), git: GitCache())
    let folder = try await repos.addFolder(mine)
    let head = try sh(mine, "rev-parse", "HEAD")
    #expect(try await repos.locate(repository: nil, commit: head, checkout: mine) == .found(folder, root: mine))
    // A folder relative to a VS Code workspace this machine does not know
    #expect(try await repos.locate(repository: nil, commit: head, checkout: "") == .found(folder, root: mine))
    #expect(
      try await repos.locate(repository: nil, commit: try sh(other, "rev-parse", "HEAD"), checkout: other)
        == .notAdded(address: origin, folder: other))
  }

  @Test func aFileSourceIsItsPathOrTheFirstAddedFolderThatHasIt() async throws {
    let data = tempDir()
    let a = tempDir()
    let b = tempDir()
    defer { remove(data, a, b) }
    try write(b + "/engine/x.py", "x\n")
    let repos = try Repositories(folder: URL(filePath: data), git: GitCache())
    _ = try await repos.addFolder(a)
    _ = try await repos.addFolder(b)
    #expect(await repos.locateFile("engine/x.py") == b + "/engine/x.py")
    #expect(await repos.locateFile(b + "/engine/x.py") == b + "/engine/x.py")
    #expect(await repos.locateFile("engine/y.py") == nil)
    #expect(await repos.locateFile(a + "/engine/x.py") == nil)
  }
}

import CodeBoardWorkspace
import Foundation
import Synchronization
import Testing

// packages/host/test/git.test.ts
@Suite struct GitAncestorTests {
  /// A repository with three commits and a clone that has only the first two
  private func repos() throws -> (r: String, clone: String, c1: String, c2: String, later: String) {
    let r = try tempRepo(["f.py": "x = 1\n"])
    let c1 = try sh(r, "rev-parse", "HEAD")
    try write(r + "/f.py", "x = 2\n")
    try sh(r, "commit", "-qam", "two")
    let c2 = try sh(r, "rev-parse", "HEAD")
    let clone = tempDir()
    try sh(clone, "clone", "-q", r, ".")
    try configure(clone)
    try write(r + "/f.py", "x = 3\n")
    try sh(r, "commit", "-qam", "three")
    return (r, clone, c1, c2, try sh(r, "rev-parse", "HEAD"))
  }

  @Test func answersAndRemembersBothYesAndNoForFullShas() async throws {
    let (r, clone, c1, c2, _) = try repos()
    defer { remove(r, clone) }
    let git = CountingGit()
    let cache = GitCache(runner: git)
    #expect(try await cache.isAncestor(r, c1, c2))
    #expect(try await !cache.isAncestor(r, c2, c1))
    #expect(try await cache.isAncestor(r, c1, c2))
    #expect(try await !cache.isAncestor(r, c2, c1))
    #expect(git.count("--is-ancestor") == 2)
  }

  @Test func asksAgainAfterGitFailedAndGetsTheRealAnswerOnceTheCommitIsFetched() async throws {
    let (r, clone, _, c2, later) = try repos()
    defer { remove(r, clone) }
    let git = CountingGit()
    let cache = GitCache(runner: git)
    // A bad object in the clone: exit 128
    #expect(try await !cache.isAncestor(clone, c2, later))
    try sh(clone, "fetch", "-q", "origin")
    #expect(try await cache.isAncestor(clone, c2, later))
    #expect(git.count("--is-ancestor") == 2)
  }

  @Test func doesNotRememberAnswersForAbbreviatedCommits() async throws {
    let (r, clone, c1, c2, _) = try repos()
    defer { remove(r, clone) }
    let git = CountingGit()
    let cache = GitCache(runner: git)
    #expect(try await cache.isAncestor(r, String(c1.prefix(7)), c2))
    #expect(try await cache.isAncestor(r, String(c1.prefix(7)), c2))
    #expect(git.count("--is-ancestor") == 2)
  }
}

// The repo lookups are remembered, "no repo" too, until a git event or a change of workspace folders (forgetRepos): a
// folder that becomes a repo later (git init) is found then, and a new origin is the upstream
@Suite struct GitRepoLookupTests {
  @Test func asksGitOnceForAFolderThatIsNoRepoAndFindsTheRepoMadeThereAfterAGitEvent() async throws {
    let d = tempDir()
    defer { remove(d) }
    let git = CountingGit()
    let cache = GitCache(runner: git)
    #expect(try await cache.repoRootOfDir(d) == nil)
    #expect(try await cache.repoRootOfDir(d) == nil)
    #expect(git.count("--show-toplevel") == 1)
    try gitInit(d)
    await cache.forgetRepos()
    #expect(try await cache.repoRootOfDir(d) == d)
  }

  @Test func doesNotRememberALookupThatFailedForAnotherReasonAFolderNotThereYetIsAskedAgain() async throws {
    let parent = tempDir()
    defer { remove(parent) }
    let d = parent + "/repo"
    let git = CountingGit()
    let cache = GitCache(runner: git)
    // No such folder: git never ran
    #expect(try await cache.repoRootOfDir(d) == nil)
    try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: false)
    try gitInit(d)
    // No git event in between
    #expect(try await cache.repoRootOfDir(d) == d)
    #expect(git.count("--show-toplevel") == 2)
  }

  @Test func takesANewOriginAsTheUpstreamAfterAGitEvent() async throws {
    let d = try tempRepo(["f.py": "x = 1\n"])
    defer { remove(d) }
    let cache = GitCache()
    #expect(try await cache.upstreamRef(d) == "main")
    try sh(d, "update-ref", "refs/remotes/origin/dev", "HEAD")
    try sh(d, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev")
    await cache.forgetRepos()
    #expect(try await cache.upstreamRef(d) == "origin/dev")
  }
}

// Scratch files are kept out of git status with a line in the repo's own info/exclude (local, never committed)
@Suite struct GitExcludeTests {
  private let pattern = ".cb-scratch-*"

  private func exclude(_ gitDir: String) -> String {
    FileManager.default.contents(atPath: gitDir + "/info/exclude").map { String(decoding: $0, as: UTF8.self) } ?? ""
  }

  private func count(_ t: String) -> Int { t.components(separatedBy: "\n").filter { $0 == pattern }.count }

  @Test func addsTheLineOnceFromASubfolderToo() async throws {
    let d = try tempRepo(["sub/f.py": "x = 1\n"])
    defer { remove(d) }
    let cache = GitCache()
    try await cache.excludeFromGit(d + "/sub", pattern, note: "scratch")
    await cache.forgetRepos()
    try await cache.excludeFromGit(d, pattern, note: "scratch")
    #expect(count(exclude(d + "/.git")) == 1)
    #expect(exclude(d + "/.git").contains("# scratch\n"))
  }

  @Test func writesAWorktreesLineIntoTheGitDirectoryTheWorktreesShare() async throws {
    let d = try tempRepo(["f.py": "x = 1\n"])
    let w = d + "-wt"
    defer { remove(w, d) }
    try sh(d, "worktree", "add", "-q", "-b", "side", w)
    try await GitCache().excludeFromGit(w, pattern, note: "scratch")
    #expect(count(exclude(d + "/.git")) == 1)
  }

  @Test func doesNothingOutsideARepoAndAddsTheLineOnceTheFolderBecameOneAndAGitEventCame() async throws {
    let d = tempDir()
    defer { remove(d) }
    let cache = GitCache()
    try await cache.excludeFromGit(d, pattern, note: "scratch")
    try gitInit(d)
    try await cache.excludeFromGit(d, pattern, note: "scratch")
    #expect(count(exclude(d + "/.git")) == 0)
    await cache.forgetRepos()
    try await cache.excludeFromGit(d, pattern, note: "scratch")
    #expect(count(exclude(d + "/.git")) == 1)
  }
}

// What the real runner does when git cannot be asked: no git, macOS's stub of it, a task cancelled while git runs
@Suite struct GitRunnerTests {
  /// An executable script standing in for git
  private func script(_ dir: String, _ body: String) throws -> String {
    let f = dir + "/git"
    // Written by a shell, not by this process: a file this process has open for writing is also open in any child
    // another test forks at that moment, and running it then fails as "text file busy"
    let sh = Process()
    sh.executableURL = URL(filePath: "/bin/sh")
    sh.arguments = ["-c", #"printf '%s\n' "$2" > "$1" && chmod 755 "$1""#, "sh", f, "#!/bin/sh\n" + body]
    try sh.run()
    sh.waitUntilExit()
    guard sh.terminationStatus == 0 else { throw CocoaError(.fileWriteUnknown) }
    return f
  }

  @Test func aGitThatIsNotThereIsAnErrorOfItsOwnAndNeverRemembered() async throws {
    let d = tempDir()
    defer { remove(d) }
    let none = ProcessGitRunner(executable: d + "/no-git")
    await #expect(throws: GitError.self) { try await none.run(["--version"], in: d, environment: [:]) }
    let missing = Missing()
    let cache = GitCache(runner: missing)
    for _ in 0..<2 {
      await #expect {
        _ = try await cache.repoRootOfDir(d)
      } throws: { e in
        if case .unavailable = e as? GitError { return true }
        return false
      }
    }
    #expect(missing.runs == 2)
  }

  @Test func macOSsGitWithoutTheDeveloperToolsIsNoGit() async throws {
    let d = tempDir()
    defer { remove(d) }
    let stub = try script(
      d, #"echo "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)" >&2; exit 1"#)
    await #expect {
      _ = try await ProcessGitRunner(executable: stub).run(["rev-parse", "HEAD"], in: d, environment: [:])
    } throws: { e in
      if case .unavailable(let why) = e as? GitError { return why.contains("invalid active developer path") }
      return false
    }
  }

  @Test func aFolderThatIsNotThereIsNoAnswerAndGitIsNotStarted() async throws {
    let d = tempDir()
    defer { remove(d) }
    let marker = d + "/ran"
    let stub = try script(d, "touch \(marker)")
    #expect(try await ProcessGitRunner(executable: stub).run([], in: d + "/gone", environment: [:]) == .failed)
    #expect(!FileManager.default.fileExists(atPath: marker))
  }

  @Test func givesStdoutStderrAndTheExitStatusWithTheEnvironmentAddedAndNoPrompt() async throws {
    let d = tempDir()
    defer { remove(d) }
    let stub = try script(d, #"echo "$1 $LC_ALL $GIT_TERMINAL_PROMPT $(pwd)"; echo oops >&2; exit 3"#)
    let r = try await ProcessGitRunner(executable: stub).run(["arg"], in: d, environment: ["LC_ALL": "C"])
    #expect(r == .exited(status: 3, stdout: "arg C 0 \(d)\n", stderr: "oops\n"))
  }

  @Test func readsAnOutputBiggerThanAPipeHoldsOnBothStreams() async throws {
    let d = try tempRepo(["big.txt": String(repeating: "0123456789abcdef\n", count: 40_000)])
    defer { remove(d) }
    let out = try await ProcessGitRunner().run(["show", "HEAD:big.txt"], in: d, environment: [:])
    guard case .exited(0, let stdout, _) = out else {
      Issue.record("\(out)")
      return
    }
    #expect(stdout.utf8.count == 17 * 40_000)
  }

  @Test func cancellingTheTaskStopsGit() async throws {
    let d = tempDir()
    defer { remove(d) }
    let started = d + "/started"
    let stub = try script(d, "touch \(started); exec sleep 600")
    let runner = ProcessGitRunner(executable: stub)
    let t = Task { try await runner.run([], in: d, environment: [:]) }
    while !FileManager.default.fileExists(atPath: started) { await Task.yield() }
    t.cancel()
    await #expect {
      _ = try await t.value
    } throws: { e in
      e as? GitError == .cancelled
    }
  }

  @Test func aTaskCancelledBeforeGitStartsDoesNotStartIt() async throws {
    let d = tempDir()
    defer { remove(d) }
    let marker = d + "/ran"
    let stub = try script(d, "touch \(marker)")
    let runner = ProcessGitRunner(executable: stub)
    let t = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await runner.run([], in: d, environment: [:])
    }
    await #expect {
      _ = try await t.value
    } throws: { e in
      e as? GitError == .cancelled
    }
    #expect(!FileManager.default.fileExists(atPath: marker))
  }
}

/// A git that is not installed, its runs counted
private final class Missing: GitRunner {
  private let count = Mutex(0)
  var runs: Int { count.withLock { $0 } }

  func run(_ args: [String], in dir: String, environment: [String: String]) async throws(GitError) -> GitRun {
    count.withLock { $0 += 1 }
    throw .unavailable("git was not found on PATH")
  }
}

// core's parseGitLog (packages/core/test/host.test.ts, small parsers)
@Test func parsesGitLog() {
  #expect(
    parseGitLog("abc1234\tfix\t2026-01-02\n\ndiff --git\n") == [
      LogEntry(commit: "abc1234", msg: "fix", date: "2026-01-02")
    ])
}

import CodeBoardAnalysis
import CodeBoardWorkspace
import Foundation
import Synchronization
import Testing

#if canImport(Darwin)
  import Darwin
#else
  import Glibc
#endif

/// The path with its links resolved, as git prints it (macOS's temporary folders are behind /var → /private/var)
func realPath(_ p: String) -> String {
  guard let r = realpath(p, nil) else { return p }
  defer { free(r) }
  return String(cString: r)
}

/// Commit times one minute apart, so that git's order by date does not depend on how fast a test runs
private let clock = Mutex(1_700_000_000)

struct GitFailed: Error, CustomStringConvertible {
  let description: String
}

/// git in dir; its stdout, trimmed. Fails the test when git fails
@discardableResult
func sh(_ dir: String, _ args: String...) throws -> String {
  let t = clock.withLock { t in
    t += 60
    return t
  }
  let p = Process()
  p.executableURL = URL(filePath: "/usr/bin/env")
  p.arguments = ["git", "-c", "protocol.file.allow=always"] + args
  p.currentDirectoryURL = URL(filePath: dir)
  p.environment = ProcessInfo.processInfo.environment.merging([
    "GIT_AUTHOR_DATE": "\(t) +0000", "GIT_COMMITTER_DATE": "\(t) +0000", "GIT_TERMINAL_PROMPT": "0",
  ]) { _, x in x }
  let out = Pipe()
  let err = Pipe()
  p.standardOutput = out
  p.standardError = err
  try p.run()
  let data = out.fileHandleForReading.readDataToEndOfFile()
  let errData = err.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  guard p.terminationStatus == 0 else {
    throw GitFailed(description: "git \(args.joined(separator: " ")): \(String(decoding: errData, as: UTF8.self))")
  }
  return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

/// A repository of its own in dir: on main, with an identity and no signing, whatever the machine's git config says
func gitInit(_ dir: String) throws {
  try sh(dir, "-c", "init.defaultBranch=main", "init", "-q")
  try configure(dir)
}

func configure(_ dir: String) throws {
  try sh(dir, "config", "user.name", "t")
  try sh(dir, "config", "user.email", "t@t")
  try sh(dir, "config", "commit.gpgsign", "false")
}

/// A new folder of its own, its links resolved
func tempDir() -> String {
  let d = FileManager.default.temporaryDirectory.appending(path: "cb-git-\(UUID().uuidString)").path
  try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
  return realPath(d)
}

/// A new repository with files, committed on main as "base" (the host tests' tempRepo)
func tempRepo(_ files: [String: String]) throws -> String {
  let r = tempDir()
  for (f, t) in files { try write(r + "/" + f, t) }
  try gitInit(r)
  try sh(r, "add", "-A")
  try sh(r, "commit", "-qm", "base")
  return r
}

func remove(_ dirs: String...) {
  for d in dirs { try? FileManager.default.removeItem(atPath: d) }
}

/// The real git, with the runs whose arguments match counted
final class CountingGit: GitRunner {
  let real = ProcessGitRunner()
  private let counts = Mutex([String: Int]())

  func run(_ args: [String], in dir: String, environment: [String: String]) async throws(GitError) -> GitRun {
    counts.withLock { c in
      for a in args { c[a, default: 0] += 1 }
    }
    return try await real.run(args, in: dir, environment: environment)
  }

  /// How many runs had this argument
  func count(_ arg: String) -> Int { counts.withLock { $0[arg] ?? 0 } }
  func reset() { counts.withLock { $0 = [:] } }
}

/// The real git, holding the next `git show` once armed until the test releases it
final class GatedGit: GitRunner {
  let real = ProcessGitRunner()
  let gate = Gate()
  private let armed = Mutex(false)

  func arm() { armed.withLock { $0 = true } }

  func run(_ args: [String], in dir: String, environment: [String: String]) async throws(GitError) -> GitRun {
    let hold =
      args.first == "show"
      && armed.withLock { a in
        defer { a = false }
        return a
      }
    if hold { await gate.wait() }
    return try await real.run(args, in: dir, environment: environment)
  }
}

/// A workspace of several roots on disk, the first one first
struct RootsWorkspace: CodeWorkspace {
  let roots: [String]

  func rootOf(_ abs: String) -> String? {
    roots.first { abs == $0 || abs.utf8.starts(with: ($0 + "/").utf8) }
  }

  func findFiles(_ query: FileQuery, max: Int) async -> [String] { [] }

  func readText(_ abs: String) async -> String? {
    FileManager.default.contents(atPath: abs).map { String(decoding: $0, as: UTF8.self) }
  }

  func openLanguage(_ abs: String) -> String? { nil }
  func log(_ level: LogLevel, _ text: String) {}
}

/// A host's sources over a workspace
func makeSources(_ ws: any CodeWorkspace, runner: any GitRunner = ProcessGitRunner(), githubDir: String = "")
  -> Sources
{
  let analysis = AnalysisCache()
  let lookup = CodeLookup(ws, analysis: analysis, index: NameIndex(ws, analysis: analysis, sched: Scheduler()))
  return Sources(lookup, git: GitCache(runner: runner), githubDir: githubDir)
}

/// A segment for the symbol qual of a file, as Add Function makes it (the host tests' card)
func card(_ s: Sources, _ abs: String, _ qual: String) async throws -> CodeSegment {
  let text = try #require(await s.lookup.readText(abs))
  let lang = s.lookup.langOf(abs)
  let sym = try #require(s.lookup.analysis.analysisOf(lang, text).symbols.first { $0.qual == qual })
  return try await s.makeSegment(
    id: "s-\(qual)", await s.locOfFile(abs), lines: text.components(separatedBy: "\n"), start: sym.start,
    end: sym.end, symbol: SymbolRef(qual: sym.qual, kind: sym.kind == .class ? .class : .function), lang: lang)
}

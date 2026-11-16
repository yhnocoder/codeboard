import AppKit
import CodeBoardWorkspace
import Foundation
import Synchronization
import Testing

@testable import CodeBoardShell

// The sidebar's repositories block through its state: what is added, cloned, stopped and removed on disk, the opened
// repository's files listed folder by folder, and the block's height kept within the sidebar

/// git in dir, failing the test when git fails; stdout trimmed
@discardableResult
private func git(_ dir: String, _ args: String...) throws -> String {
  let p = Process()
  p.executableURL = URL(filePath: "/usr/bin/env")
  p.arguments = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"] + args
  p.currentDirectoryURL = URL(filePath: dir)
  p.environment = ProcessInfo.processInfo.environment.merging(["GIT_TERMINAL_PROMPT": "0"]) { _, x in x }
  let out = Pipe()
  p.standardOutput = out
  p.standardError = Pipe()
  try p.run()
  let data = out.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  struct Failed: Error { let args: [String] }
  guard p.terminationStatus == 0 else { throw Failed(args: args) }
  return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

private func tempDir() -> String {
  let d = FileManager.default.temporaryDirectory.appending(path: "cb-repos-\(UUID().uuidString)")
  try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
  return d.resolvingSymlinksInPath().path
}

private func write(_ path: String, _ text: String) throws {
  try FileManager.default.createDirectory(
    atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
  try text.write(toFile: path, atomically: true, encoding: .utf8)
}

/// A repository with these files, committed
private func repo(_ files: [String: String]) throws -> String {
  let r = tempDir()
  for (f, t) in files { try write(r + "/" + f, t) }
  try git(r, "-c", "init.defaultBranch=main", "init", "-q")
  try git(r, "add", "-A")
  try git(r, "commit", "-qm", "base")
  return r
}

/// GitHub on disk: its addresses are file:// ones under base; `hold`: a clone waits there until it is cancelled
private final class DiskGitHub: GitRunner {
  let base: String
  let hold: Bool
  let real = ProcessGitRunner()
  let arrived = Mutex(false)

  init(_ base: String, hold: Bool = false) {
    self.base = base
    self.hold = hold
  }

  func run(_ args: [String], in dir: String, environment: [String: String]) async throws(GitError) -> GitRun {
    let prefix = "https://github.com/"
    let args = args.map { $0.hasPrefix(prefix) ? "file://\(base)/\($0.dropFirst(prefix.count))" : $0 }
    if args.first == "clone" && hold {
      arrived.withLock { $0 = true }
      // ends when the task is cancelled
      let (stream, _) = AsyncStream<Void>.makeStream()
      for await _ in stream {}
      throw .cancelled
    }
    return try await real.run(args, in: dir, environment: environment)
  }
}

/// No git on this Mac
private struct NoGit: GitRunner {
  func run(_ args: [String], in dir: String, environment: [String: String]) async throws(GitError) -> GitRun {
    throw .unavailable("git was not found on PATH")
  }
}

/// A bare repository at base/owner/name
private func fakeGitHub(_ base: String, _ owner: String, _ name: String) throws {
  let work = try repo(["f.py": "x = 1\n"])
  defer { try? FileManager.default.removeItem(atPath: work) }
  try FileManager.default.createDirectory(atPath: "\(base)/\(owner)", withIntermediateDirectories: true)
  try git("\(base)/\(owner)", "clone", "-q", "--bare", work, name)
  try git("\(base)/\(owner)/\(name)", "config", "uploadpack.allowFilter", "true")
}

private func remove(_ dirs: String...) {
  for d in dirs { try? FileManager.default.removeItem(atPath: d) }
}

@MainActor @Suite struct RepositoriesBlockTests {
  @Test func aCloneIsDeletedWhenRemovedAndAFolderOnlyForgottenEachAskedFirst() async throws {
    let (data, gh) = (tempDir(), tempDir())
    let folder = try repo(["a.py": "a\n"])
    defer { remove(data, gh, folder) }
    try fakeGitHub(gh, "o", "n")
    let m = RepositoriesModel(folder: URL(filePath: data), runner: DiskGitHub(gh), defaults: nil)
    await m.refresh()
    await m.addFolder(folder)
    #expect(m.addGitHub("https://github.com/o/n", lightweight: true) == nil)
    #expect(m.clones.map(\.name) == ["o/n"], "the clone's row is there at once")
    await m.clones.first?.task?.value
    #expect(m.clones.isEmpty && m.notice == nil)
    #expect(m.list.map(RepositoriesModel.name) == [URL(filePath: folder).lastPathComponent, "o/n"])
    let clone = m.list[1]
    #expect(FileManager.default.fileExists(atPath: clone.path + "/f.py"))

    var asked: [String] = []
    await m.remove(clone) { a in
      asked.append(a.informativeText)
      return false
    }
    #expect(m.list.count == 2 && FileManager.default.fileExists(atPath: clone.path), "Cancel keeps it")

    await m.open(clone)
    await m.remove(clone) { a in
      asked.append(a.informativeText)
      return true
    }
    #expect(m.list.map(\.path) == [folder])
    #expect(!FileManager.default.fileExists(atPath: clone.path), "its downloaded copy is deleted")
    #expect(m.opened == nil, "the opened repository removed: back to the list")

    await m.remove(m.list[0]) { a in
      asked.append(a.informativeText)
      return true
    }
    #expect(m.list.isEmpty)
    #expect(FileManager.default.fileExists(atPath: folder + "/a.py"), "a folder's files are never touched")
    #expect(asked[1].contains("deleted") && asked[2].contains("Only the entry is forgotten"))
  }

  @Test func aWrongOrTakenAddressIsSaidWhereItWasTypedAndNothingStarts() async throws {
    let (data, gh) = (tempDir(), tempDir())
    defer { remove(data, gh) }
    try fakeGitHub(gh, "o", "n")
    let m = RepositoriesModel(folder: URL(filePath: data), runner: DiskGitHub(gh), defaults: nil)
    #expect(m.addGitHub("https://gitlab.com/o/n", lightweight: true)?.contains("not the address") == true)
    #expect(m.clones.isEmpty)
    #expect(m.addGitHub("github.com/o/n", lightweight: false) == nil)
    #expect(m.addGitHub("git@github.com:o/n.git", lightweight: true)?.contains("being cloned already") == true)
    await m.clones.first?.task?.value
    #expect(m.addGitHub("https://github.com/O/N", lightweight: true)?.contains("already added") == true)
    #expect(m.clones.isEmpty && m.list.count == 1)
  }

  @Test func aCloneUnderWayIsStoppedAndLeavesNothingAndAFailedOneKeepsItsErrorUntilDismissed() async throws {
    let (data, gh) = (tempDir(), tempDir())
    defer { remove(data, gh) }
    try fakeGitHub(gh, "o", "n")
    let runner = DiskGitHub(gh, hold: true)
    let m = RepositoriesModel(folder: URL(filePath: data), runner: runner, defaults: nil)
    #expect(m.addGitHub("github.com/o/n", lightweight: true) == nil)
    let task = try #require(m.clones.first?.task)
    while !runner.arrived.withLock({ $0 }) { await Task.yield() }
    m.cancel(m.clones[0].id)
    #expect(m.clones.isEmpty, "gone from the list at once")
    await task.value
    #expect(m.list.isEmpty && m.notice == nil)
    #expect(!FileManager.default.fileExists(atPath: data + "/repositories/o/n"))

    let failing = RepositoriesModel(folder: URL(filePath: data), runner: DiskGitHub(gh), defaults: nil)
    #expect(failing.addGitHub("github.com/o/missing", lightweight: true) == nil)
    await failing.clones.first?.task?.value
    let row = try #require(failing.clones.first)
    #expect(row.error?.hasPrefix("The clone failed") == true && row.task == nil)
    #expect(failing.list.isEmpty)
    failing.cancel(row.id)
    #expect(failing.clones.isEmpty)
  }

  @Test func withoutGitTheBlockSaysSoAndAddsNothing() async throws {
    let (data, folder) = (tempDir(), tempDir())
    defer { remove(data, folder) }
    let m = RepositoriesModel(folder: URL(filePath: data), runner: NoGit(), defaults: nil)
    await m.addFolder(folder)
    #expect(m.list.isEmpty && m.problem == RepositoriesModel.noGit)
    #expect(m.addGitHub("github.com/o/n", lightweight: true) == nil)
    await m.clones.first?.task?.value
    #expect(m.clones.first?.error == RepositoriesModel.noGit && m.list.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: data + "/repositories.json"))
  }

  @Test func anOpenedRepositoryListsEachFolderWhenItIsOpenedFoldersFirstWithoutGit() async throws {
    let data = tempDir()
    let r = try repo([
      "b.py": "", "A.md": "", "src/z.py": "", "src/inner/deep.py": "", "docs/x.md": "", "file10.txt": "",
      "file9.txt": "",
    ])
    try FileManager.default.createDirectory(atPath: r + "/empty", withIntermediateDirectories: true)
    defer { remove(data, r) }
    let m = RepositoriesModel(folder: URL(filePath: data), runner: ProcessGitRunner(), defaults: nil)
    await m.addFolder(r)
    var opened: [(String, Bool)] = []
    m.onOpen = { _, rel, preview in opened.append((rel, preview)) }
    await m.open(m.list[0])
    #expect(m.head == String(try git(r, "rev-parse", "HEAD").prefix(7)))
    #expect(m.rows.map(\.name) == ["docs", "empty", "src", "A.md", "b.py", "file9.txt", "file10.txt"])
    #expect(m.children.keys.sorted() == [""], "a closed folder is not read")

    await m.toggle("src")
    await m.toggle("src/inner")
    #expect(
      m.rows.map { "\($0.depth) \($0.path)" }.prefix(6) == [
        "0 docs", "0 empty", "0 src", "1 src/inner", "2 src/inner/deep.py", "1 src/z.py",
      ])
    await m.toggle("src")
    #expect(!m.rows.contains { $0.path.hasPrefix("src/") })

    m.click("b.py", preview: true)
    m.click("b.py", preview: false)
    #expect(m.selected == "b.py" && opened.map(\.0) == ["b.py", "b.py"] && opened.map(\.1) == [true, false])
    m.close()
    #expect(m.opened == nil && m.rows.isEmpty)
  }

  @Test func theBlockKeepsThreeRowsAndTheTreeThreeAndItsDefaultIsItsListOrHalf() async throws {
    let data = tempDir()
    let r = tempDir()
    defer { remove(data, r) }
    let row = RepositoriesModel.row
    let least = RepositoriesModel.handle + 3 * row
    #expect(RepositoriesModel.clamp(10, room: 700) == least)
    #expect(RepositoriesModel.clamp(300, room: 700) == 300)
    #expect(RepositoriesModel.clamp(690, room: 700) == 700 - 3 * row)
    #expect(RepositoriesModel.clamp(300, room: 100) == least, "a sidebar too short: the block keeps its rows")

    let m = RepositoriesModel(folder: URL(filePath: data), runner: ProcessGitRunner(), defaults: nil)
    #expect(m.shown(content: 130, room: 700) == 130)
    #expect(m.shown(content: 600, room: 700) == 350, "a long list: half")
    await m.addFolder(r)
    await m.open(m.list[0])
    #expect(m.shown(content: 60, room: 700) == 350)
    m.drag(to: 1000, room: 700)
    #expect(m.height == 700 - 3 * row && m.shown(content: 60, room: 700) == 700 - 3 * row)
    m.restoreHeight()
    #expect(m.height == nil && m.shown(content: 60, room: 700) == 350)
  }
}

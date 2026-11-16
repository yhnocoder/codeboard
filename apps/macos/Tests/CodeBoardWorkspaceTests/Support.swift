import CodeBoardAnalysis
import CodeBoardWorkspace
import Foundation
import Synchronization

/// A folder of its own for a test, removed when the test is done
func withFolder<T>(_ body: (String) async throws -> T) async rethrows -> T {
  let root = FileManager.default.temporaryDirectory.appending(path: "cb-workspace-\(UUID().uuidString)").path
  try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(atPath: root) }
  return try await body(root)
}

func write(_ path: String, _ text: String) throws {
  try FileManager.default.createDirectory(
    atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
  try text.write(toFile: path, atomically: false, encoding: .utf8)
}

/// nano-vllm at the commit the analysis's fixtures have (CodeBoardAnalysisTests/Fixtures/nano-vllm, the same Python
/// files as examples/nano-vllm, which the Mac app's CI does not check out), copied into a folder of its own: tests make
/// files in it
func withNano<T>(_ body: (String) async throws -> T) async throws -> T {
  let nano = URL(filePath: #filePath).deletingLastPathComponent()
    .appending(path: "../CodeBoardAnalysisTests/Fixtures/nano-vllm").standardizedFileURL.path
  return try await withFolder { dir in
    let root = dir + "/nano-vllm"
    try FileManager.default.copyItem(atPath: nano, toPath: root)
    return try await body(root)
  }
}

/// A folder as the host's test workspace has it: editors' unsaved texts are set by the test, and the listings counted
/// (the index must not walk the workspace on every click)
final class TestWorkspace: CodeWorkspace {
  let folder: FolderWorkspace
  private let state = Mutex((finds: 0, unsaved: [String: String]()))

  init(_ root: String) { folder = FolderWorkspace(root: root) }

  var root: String { folder.root }
  var finds: Int { state.withLock { $0.finds } }
  func setUnsaved(_ abs: String, _ text: String?) { state.withLock { $0.unsaved[abs] = text } }

  func rootOf(_ abs: String) -> String? { folder.rootOf(abs) }

  func findFiles(_ query: FileQuery, max: Int) async -> [String] {
    state.withLock { $0.finds += 1 }
    return await folder.findFiles(query, max: max)
  }

  func readText(_ abs: String) async -> String? {
    if let t = state.withLock({ $0.unsaved[abs] }) { return t }
    return await folder.readText(abs)
  }

  func openLanguage(_ abs: String) -> String? { nil }
  func log(_ level: LogLevel, _ text: String) {}
}

/// A host's pieces for one index
struct Host {
  let ws: TestWorkspace
  let sched: Scheduler
  let index: NameIndex

  init(_ root: String, clock: any Clock<Duration> = ContinuousClock()) {
    ws = TestWorkspace(root)
    sched = Scheduler(clock: clock)
    index = NameIndex(ws, analysis: AnalysisCache(), sched: sched)
  }

  /// The files analysed so far
  func done() async -> Int { await index.indexedFiles().filter { $0.entries != nil }.count }
}

/// Lets a job wait until the test opens it, and the test wait until a job waits
final class Gate: Sendable {
  private let state = Mutex((open: false, waiting: [CheckedContinuation<Void, Never>](), arrived: 0))

  func wait() async {
    await withCheckedContinuation { c in
      let now = state.withLock { s in
        s.arrived += 1
        if !s.open { s.waiting.append(c) }
        return s.open
      }
      if now { c.resume() }
    }
  }

  func open() {
    for c in state.withLock({ s in
      s.open = true
      defer { s.waiting = [] }
      return s.waiting
    }) { c.resume() }
  }

  /// Returns once a job is waiting at the gate (or went through it)
  func untilArrived() async {
    while state.withLock({ $0.arrived }) == 0 { await Task.yield() }
  }
}

/// Some turns of the executor for work that should not happen, so that a test sees it if it does
func turns(_ n: Int) async {
  for _ in 0..<n { await Task.yield() }
}

/// Whether work ends within some turns (it keeps running after)
func settles(_ work: @escaping @Sendable () async -> Void) async -> Bool {
  let done = Mutex(false)
  let t = Task {
    await work()
    done.withLock { $0 = true }
  }
  await turns(30)
  _ = t
  return done.withLock { $0 }
}

/// A clock that moves only when the test moves it, as vitest's fake timers do
final class TestClock: Clock, Sendable {
  struct Instant: InstantProtocol {
    var offset: Duration
    func advanced(by d: Duration) -> Instant { Instant(offset: offset + d) }
    func duration(to other: Instant) -> Duration { other.offset - offset }
    static func < (a: Instant, b: Instant) -> Bool { a.offset < b.offset }
  }

  private struct Sleeper {
    let id: Int
    let deadline: Instant
    let wake: CheckedContinuation<Void, any Error>
  }

  private let state = Mutex((now: Instant(offset: .zero), sleepers: [Sleeper](), next: 0))

  var now: Instant { state.withLock { $0.now } }
  var minimumResolution: Duration { .zero }

  func sleep(until deadline: Instant, tolerance: Duration?) async throws {
    let id = state.withLock { s in
      s.next += 1
      return s.next
    }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, any Error>) in
        let early: Result<Void, any Error>? = state.withLock { s in
          if Task.isCancelled { return .failure(CancellationError()) }
          if deadline <= s.now { return .success(()) }
          s.sleepers.append(Sleeper(id: id, deadline: deadline, wake: c))
          return nil
        }
        if let early { c.resume(with: early) }
      }
    } onCancel: {
      let s = state.withLock { s in s.sleepers.firstIndex { $0.id == id }.map { s.sleepers.remove(at: $0) } }
      s?.wake.resume(throwing: CancellationError())
    }
  }

  func advance(by d: Duration) {
    let due = state.withLock { s in
      s.now = s.now.advanced(by: d)
      let now = s.now
      defer { s.sleepers.removeAll { $0.deadline <= now } }
      return s.sleepers.filter { $0.deadline <= now }
    }
    for s in due { s.wake.resume() }
  }

  /// Returns once n sleeps wait on the clock
  func untilSleeping(_ n: Int) async {
    while state.withLock({ $0.sleepers.count }) < n { await Task.yield() }
  }
}

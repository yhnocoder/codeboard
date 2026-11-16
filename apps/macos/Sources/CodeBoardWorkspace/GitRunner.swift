import Foundation
import Synchronization

// git is run as its command line, as the TypeScript host runs it, behind GitRunner: whoever calls git never starts a
// process itself, so a library can take its place.

/// git could not be asked at all: passed up to whoever can tell the user, never taken for an answer
public enum GitError: Error, Hashable, Sendable {
  /// git is not installed (not on PATH, or macOS's /usr/bin/git without the developer tools); why says which
  case unavailable(String)
  /// The task asking was cancelled; git was stopped
  case cancelled
}

/// How one run of git ended
public enum GitRun: Hashable, Sendable {
  case exited(status: Int32, stdout: String, stderr: String)
  /// git did not run in that folder (it is not there) or was killed by a signal: no answer, as Node's execFile errors
  case failed
}

public protocol GitRunner: Sendable {
  /// Runs git with args in dir; environment is added to the process's own
  func run(_ args: [String], in dir: String, environment: [String: String]) async throws(GitError) -> GitRun
}

extension GitRunner {
  /// stdout when git exited 0, else nil (git.ts's git)
  func output(_ dir: String, _ args: [String]) async throws(GitError) -> String? {
    if case .exited(0, let out, _) = try await run(args, in: dir, environment: [:]) { return out }
    return nil
  }

  /// The exit status; nil when git did not run or was killed (git.ts's gitExit)
  func status(_ dir: String, _ args: [String]) async throws(GitError) -> Int32? {
    if case .exited(let status, _, _) = try await run(args, in: dir, environment: [:]) { return status }
    return nil
  }
}

/// git on a Process. The process is waited for off Swift's concurrency threads; cancelling the task stops it
public struct ProcessGitRunner: GitRunner {
  /// The git to run; nil: the first git on PATH
  public let executable: String?

  public init(executable: String? = nil) {
    self.executable = executable
  }

  private func locate() -> String? {
    if let executable { return executable }
    let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
    return path.split(separator: ":").map { "\($0)/git" }.first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  public func run(_ args: [String], in dir: String, environment: [String: String]) async throws(GitError) -> GitRun {
    guard let exe = locate(), FileManager.default.isExecutableFile(atPath: exe) else {
      throw .unavailable("git was not found on PATH")
    }
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue else { return .failed }
    let p = Process()
    p.executableURL = URL(filePath: exe)
    p.arguments = args
    p.currentDirectoryURL = URL(filePath: dir, directoryHint: .isDirectory)
    // No terminal to answer a credential prompt: a fetch a partial clone starts on its own would wait for ever
    p.environment = ProcessInfo.processInfo.environment.merging(["GIT_TERMINAL_PROMPT": "0"]) { _, x in x }
      .merging(environment) { _, x in x }
    let out = Pipe()
    let err = Pipe()
    p.standardOutput = out
    p.standardError = err
    p.standardInput = FileHandle.nullDevice
    let job = Job(p, out: out.fileHandleForReading, err: err.fileHandleForReading)
    let end = await withTaskCancellationHandler {
      await withCheckedContinuation { c in DispatchQueue.global().async { c.resume(returning: job.wait()) } }
    } onCancel: {
      job.cancel()
    }
    switch end {
    case .cancelled: throw .cancelled
    case .notStarted(let why): throw .unavailable(why)
    case .signal: return .failed
    case .exit(let status, let stdout, let stderr):
      // macOS's /usr/bin/git without the developer tools runs xcrun, which says so and asks to install them
      if status != 0 && stderr.hasPrefix("xcrun: error:") { throw .unavailable(stderr) }
      return .exited(status: status, stdout: stdout, stderr: stderr)
    }
  }
}

private enum JobEnd: Sendable {
  case exit(Int32, String, String)
  case signal
  case cancelled
  case notStarted(String)
}

// Process and FileHandle are Sendable in swift-corelibs-foundation but not in every Apple SDK. The process is started
// and stopped under the job's lock, so that a cancel either comes before the start or stops what started, and only
// waited for elsewhere; each pipe is read by one thread
private struct Held: @unchecked Sendable {
  let process: Process
  let out: FileHandle
  let err: FileHandle
}

private final class Job: Sendable {
  private let held: Held
  private var process: Process { held.process }
  private let state = Mutex((started: false, cancelled: false))

  init(_ process: Process, out: FileHandle, err: FileHandle) {
    held = Held(process: process, out: out, err: err)
  }

  /// Blocks its thread until git is done
  func wait() -> JobEnd {
    let start = state.withLock { s -> String?? in
      if s.cancelled { return .some(nil) }
      do {
        try process.run()
      } catch {
        return .some("git could not be started: \(error.localizedDescription)")
      }
      s.started = true
      return .none
    }
    switch start {
    case .some(nil): return .cancelled
    case .some(let why?): return .notStarted(why)
    case .none: break
    }
    // Both pipes are read at once: git stops writing to one while the other is full
    let errData = Mutex(Data())
    let group = DispatchGroup()
    DispatchQueue.global().async(group: group) { [held] in
      let d = held.err.readDataToEndOfFile()
      errData.withLock { $0 = d }
    }
    let outData = held.out.readDataToEndOfFile()
    group.wait()
    process.waitUntilExit()
    if state.withLock({ $0.cancelled }) { return .cancelled }
    if process.terminationReason == .uncaughtSignal { return .signal }
    return .exit(
      process.terminationStatus, String(decoding: outData, as: UTF8.self),
      String(decoding: errData.withLock { $0 }, as: UTF8.self))
  }

  func cancel() {
    state.withLock { s in
      s.cancelled = true
      if s.started && process.isRunning { process.terminate() }
    }
  }
}

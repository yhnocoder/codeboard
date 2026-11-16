import Foundation

// Background work by priority, as packages/host/src/sched.ts has it: a click first, then the hover prefetch, then the
// board-open warm-up, then building the indexes. Lower priorities wait while higher ones run, but at most holdMax at a
// stretch, so a request stuck on a language server does not stop everything behind it.

public enum Prio: Int, Sendable, CaseIterable {
  case click, hover, warm, index
}

/// How long higher-priority work holds lower priorities back at a stretch (HOLD_MAX)
public let holdMax: Duration = .seconds(5)

// An actor: the stretches are shared by every caller, each of which awaits it anyway
public actor Scheduler {
  // A stretch of work at one priority: it starts with the first job when none is open and ends when all jobs that
  // joined it are done, or after holdMax. A job still running then counts only towards its own, already ended stretch.
  private final class Stretch {
    var jobs = 0
    var ended = false
    var waiting: [CheckedContinuation<Void, Never>] = []
    var timer: Task<Void, Never>?
  }

  private var open: [Stretch?] = Array(repeating: nil, count: Prio.allCases.count)
  private let clock: any Clock<Duration>

  /// clock: what holdMax is measured on
  public init(clock: any Clock<Duration> = ContinuousClock()) {
    self.clock = clock
  }

  /// Runs fn at priority p: lower priorities wait for it (see holdMax)
  public func run<T: Sendable>(_ p: Prio, _ fn: @Sendable () async throws -> T) async rethrows -> T {
    let s = stretch(p)
    s.jobs += 1
    defer {
      s.jobs -= 1
      if s.jobs == 0 { end(s, p) }
    }
    return try await fn()
  }

  private func stretch(_ p: Prio) -> Stretch {
    if let s = open[p.rawValue] { return s }
    let s = Stretch()
    open[p.rawValue] = s
    s.timer = Task { [clock] in
      guard (try? await clock.sleep(for: holdMax)) != nil else { return }
      end(s, p)
    }
    return s
  }

  private func end(_ s: Stretch, _ p: Prio) {
    s.timer?.cancel()
    if open[p.rawValue] === s { open[p.rawValue] = nil }
    s.ended = true
    for c in s.waiting { c.resume() }
    s.waiting = []
  }

  /// Returns once no work above priority p runs (at once when none does)
  public func clear(_ p: Prio) async {
    while let s = open[..<p.rawValue].lazy.compactMap({ $0 }).first {
      if !s.ended { await withCheckedContinuation { s.waiting.append($0) } }
    }
  }
}

import Foundation

/// The tests' watchdog: a test whose board (its rig, its window) has been open over `limit` is stuck, waiting on what
/// will never come; the process says which test it was and exits, so the run ends instead of hanging. The rigs say
/// when a test starts and ends; the watch runs on a thread of its own, so a main thread held up does not stop it.
package enum TestWatch {
  package static let limit: TimeInterval = 120

  nonisolated(unsafe) private static var running: (name: String, since: TimeInterval)?
  private static let lock = NSLock()

  /// A test began (its name as Swift Testing gives it)
  package static func started(_ name: String) {
    lock.withLock { running = (name, ProcessInfo.processInfo.systemUptime) }
    _ = watching
  }

  package static func ended() { lock.withLock { running = nil } }

  /// Over the limit: what to say, nil while within it
  package static func overrun(at now: TimeInterval) -> String? {
    lock.withLock {
      guard let r = running, now - r.since > limit else { return nil }
      return
        "watchdog: \(r.name) has run \(Int(now - r.since)) s, over the \(Int(limit)) s a test may take; the test process exits\n"
    }
  }

  private static let watching: Void = {
    let t = Thread {
      while true {
        Thread.sleep(forTimeInterval: 1)
        if let said = overrun(at: ProcessInfo.processInfo.systemUptime) {
          FileHandle.standardError.write(Data(said.utf8))
          FileHandle.standardOutput.write(Data(said.utf8))
          _exit(70)
        }
      }
    }
    t.name = "test watchdog"
    t.start()
  }()
}

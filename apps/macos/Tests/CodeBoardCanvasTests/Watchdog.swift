import Darwin
import Foundation

/// On CI only (CI or GITHUB_ACTIONS is "true"): a plain pthread, armed by the first test that touches it, that needs
/// nothing else of the process (no run loop, no queue, no task): it sleeps with nanosleep and writes with write(2), to
/// stderr and appended to $WATCHDOG_FILE (the workflow uploads it, in case the pipe is what is stuck). It says when it is
/// armed; if the run is still going two minutes on (a run takes well under one), every thread writes its own stack (a
/// signal each, backtrace_symbols_fd) and the process ends with a failure, so a hang names where each thread waits.
/// In-process only: nothing outside the process is inspected
enum Watchdog {
  static let started: Void = {
    let env = ProcessInfo.processInfo.environment
    guard env["CI"] == "true" || env["GITHUB_ACTIONS"] == "true" else { return }
    seconds = Int(env["WATCHDOG_SECONDS"] ?? "") ?? 120
    file = env["WATCHDOG_FILE"].map { open($0, O_WRONLY | O_CREAT | O_APPEND, 0o644) } ?? -1
    signal(SIGUSR2) { _ in
      var frames = [UnsafeMutableRawPointer?](repeating: nil, count: 64)
      let n = backtrace(&frames, 64)
      say("\n--- thread \(pthread_mach_thread_np(pthread_self())) ---\n")
      backtrace_symbols_fd(&frames, n, 2)
      if Watchdog.file >= 0 { backtrace_symbols_fd(&frames, n, Watchdog.file) }
    }
    var thread: pthread_t?
    pthread_create(
      &thread, nil,
      { _ in
        Watchdog.say("Watchdog armed: \(Watchdog.seconds) s\n")
        var left = timespec(tv_sec: Watchdog.seconds, tv_nsec: 0)
        var rest = timespec()
        while nanosleep(&left, &rest) != 0 { left = rest }
        Watchdog.say("\nWatchdog: the tests are still running \(Watchdog.seconds) s on; every thread's stack follows\n")
        var threads: thread_act_array_t?
        var count: mach_msg_type_number_t = 0
        if task_threads(mach_task_self_, &threads, &count) == KERN_SUCCESS, let threads {
          let me = pthread_mach_thread_np(pthread_self())
          for i in 0..<Int(count) where threads[i] != me {
            if let p = pthread_from_mach_thread_np(threads[i]) {
              pthread_kill(p, SIGUSR2)
              var pause = timespec(tv_sec: 0, tv_nsec: 100_000_000)
              nanosleep(&pause, nil)
            }
          }
        }
        Watchdog.say("\nWatchdog: ending the test process\n")
        exit(70)
      }, nil)
  }()

  nonisolated(unsafe) static var seconds = 120
  nonisolated(unsafe) static var file: Int32 = -1

  static func say(_ s: String) {
    s.withCString {
      _ = write(2, $0, strlen($0))
      if file >= 0 { _ = write(file, $0, strlen($0)) }
    }
  }
}

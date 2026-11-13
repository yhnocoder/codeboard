import Darwin
import Foundation

/// On CI only (CI=true): when the test run is still going this long after the first test that started it, every thread
/// of this process prints its own stack to stderr, once, so a hang in CI names where each thread waits. In-process: each
/// thread is sent a signal and writes its own backtrace; nothing outside the process is inspected
enum Watchdog {
  static let started: Void = {
    guard ProcessInfo.processInfo.environment["CI"] == "true" else { return }
    signal(SIGUSR2) { _ in
      var frames = [UnsafeMutableRawPointer?](repeating: nil, count: 64)
      let n = backtrace(&frames, 64)
      let header = "\n--- thread \(pthread_mach_thread_np(pthread_self())) ---\n"
      header.withCString { _ = write(2, $0, strlen($0)) }
      backtrace_symbols_fd(&frames, n, 2)
    }
    let t = Thread {
      Thread.sleep(forTimeInterval: Double(ProcessInfo.processInfo.environment["WATCHDOG_SECONDS"] ?? "") ?? 240)
      let note = "\nWatchdog: the tests are still running past the watchdog's limit; every thread's stack follows\n"
      note.withCString { _ = write(2, $0, strlen($0)) }
      var threads: thread_act_array_t?
      var count: mach_msg_type_number_t = 0
      guard task_threads(mach_task_self_, &threads, &count) == KERN_SUCCESS, let threads else { return }
      let me = pthread_mach_thread_np(pthread_self())
      for i in 0..<Int(count) where threads[i] != me {
        if let p = pthread_from_mach_thread_np(threads[i]) {
          pthread_kill(p, SIGUSR2)
          usleep(50_000)
        }
      }
    }
    t.start()
  }()
}

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
          Watchdog.say("\(count) threads\n")
          for i in 0..<Int(count) where threads[i] != me {
            Watchdog.stack(threads[i])
          }
        }
        Watchdog.say("\nWatchdog: ending the test process\n")
        exit(70)
      }, nil)
  }()

  /// Every frame of a thread of this process: suspended, its registers read, its frame-pointer chain followed (arm64
  /// keeps frame pointers), each return address named with dladdr, then resumed
  static func stack(_ t: thread_act_t) {
    var state = arm_thread_state64_t()
    var n = mach_msg_type_number_t(MemoryLayout<arm_thread_state64_t>.size / MemoryLayout<UInt32>.size)
    guard thread_suspend(t) == KERN_SUCCESS else { return }
    defer { thread_resume(t) }
    let r = withUnsafeMutablePointer(to: &state) {
      $0.withMemoryRebound(to: natural_t.self, capacity: Int(n)) { thread_get_state(t, ARM_THREAD_STATE64, $0, &n) }
    }
    guard r == KERN_SUCCESS else { return }
    var lines = "\n--- mach thread \(t) ---\n"
    func name(_ pc: UInt64) -> String {
      var info = Dl_info()
      guard pc != 0, dladdr(UnsafeRawPointer(bitPattern: UInt(pc)), &info) != 0 else { return String(pc, radix: 16) }
      let image = info.dli_fname.map { String(cString: $0).split(separator: "/").last.map(String.init) ?? "" } ?? ""
      let symbol = info.dli_sname.map { String(cString: $0) } ?? "?"
      return "\(image) \(symbol)"
    }
    // pc and lr, then the saved return addresses up the frame chain (pointer authentication bits stripped)
    let strip: (UInt64) -> UInt64 = { $0 & 0x0000_007F_FFFF_FFFF }
    lines += "  " + name(strip(state.__pc)) + "\n  " + name(strip(state.__lr)) + "\n"
    var fp = strip(state.__fp)
    for _ in 0..<48 where fp != 0 && fp % 8 == 0 {
      guard let frame = UnsafePointer<UInt64>(bitPattern: UInt(fp)) else { break }
      let next = strip(frame[0])
      let ret = strip(frame[1])
      if ret == 0 { break }
      lines += "  " + name(ret) + "\n"
      if next <= fp { break }
      fp = next
    }
    say(lines)
  }

  /// a line on stderr (unbuffered, so it is there however the process ends), on CI only
  static func trace(_ what: String, _ function: String = #function) {
    let env = ProcessInfo.processInfo.environment
    guard env["CI"] == "true" || env["GITHUB_ACTIONS"] == "true" else { return }
    say("trace \(function): \(what)\n")
  }

  nonisolated(unsafe) static var seconds = 120
  nonisolated(unsafe) static var file: Int32 = -1

  static func say(_ s: String) {
    s.withCString {
      _ = write(2, $0, strlen($0))
      if file >= 0 { _ = write(file, $0, strlen($0)) }
    }
  }
}

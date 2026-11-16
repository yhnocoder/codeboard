import AppKit
import CodeBoardDiagnostics
import Darwin
import Synchronization

/// A line of frames.jsonl: one display link callback on the recorded window
struct FrameRecord: Codable, Equatable, Sendable {
  var t: Double
  /// Since the frame before, ms
  var ms: Double
  /// Frames the screen showed between this callback and the one before that the app had no callback for
  var dropped: Int
}

/// A main thread stall: how long a block sent to it waited to run
struct StallRecord: Codable, Equatable, Sendable {
  var t: Double
  var ms: Double
}

/// A line of metrics.jsonl
struct MetricRecord: Codable, Equatable, Sendable {
  var t: Double
  /// Of one core, over the 250 ms before
  var cpu: Double
  var mainCPU: Double
  var footprintMB: Double
}

enum Frames {
  /// The frames the screen drew between two callbacks that had none of their own; `interval` the screen's frame time
  static func dropped(between dt: Double, interval: Double) -> Int {
    guard interval > 0 else { return 0 }
    return max(0, Int((dt / interval).rounded()) - 1)
  }
}

/// Frame times by a display link on the recorded window, and main thread stalls by a watchdog off it. Both only keep
/// numbers while recording; frames.jsonl is made at the end
@MainActor final class FrameLog: NSObject {
  private let t0: Double
  private let interval: Double
  private var link: CADisplayLink?
  private var last: Double?
  private(set) var frames: [FrameRecord] = []
  private let watchdog: Watchdog

  /// `refresh`: the screen's most frames per second (60, 120)
  init(view: NSView, refresh: Int, t0: Double) {
    self.t0 = t0
    interval = 1 / Double(max(1, refresh))
    watchdog = Watchdog(t0: t0)
    super.init()
    frames.reserveCapacity(refresh * 40)
    let l = view.displayLink(target: self, selector: #selector(step(_:)))
    let r = Float(refresh)
    l.preferredFrameRateRange = CAFrameRateRange(minimum: r, maximum: r, preferred: r)
    link = l
  }

  func start() {
    link?.add(to: .main, forMode: .common)
    watchdog.start()
  }

  func stop() -> [StallRecord] {
    link?.invalidate()
    link = nil
    return watchdog.stop()
  }

  @objc private func step(_ l: CADisplayLink) {
    let now = l.timestamp
    if let last {
      let dt = now - last
      frames.append(FrameRecord(t: now - t0, ms: dt * 1000, dropped: Frames.dropped(between: dt, interval: interval)))
    }
    last = now
  }
}

/// Every 10 ms a block is sent to the main queue; one that waits more than 50 ms to run is a stall
final class Watchdog: Sendable {
  static let threshold = 0.05
  private let t0: Double
  private let state = Mutex<(running: Bool, waiting: Bool, stalls: [StallRecord])>((false, false, []))
  private let queue = DispatchQueue(label: "bug-report.watchdog", qos: .userInteractive)

  init(t0: Double) { self.t0 = t0 }

  func start() {
    state.withLock { $0.running = true }
    tick()
  }

  func stop() -> [StallRecord] {
    state.withLock {
      $0.running = false
      return $0.stalls
    }
  }

  private func tick() {
    queue.asyncAfter(deadline: .now() + .milliseconds(10)) { [self] in
      let go = state.withLock { s -> Bool in
        guard s.running else { return false }
        if s.waiting { return true }
        s.waiting = true
        return true
      }
      guard go else { return }
      let sent = Diag.now()
      DispatchQueue.main.async { [self] in
        let waited = Diag.now() - sent
        state.withLock {
          $0.waiting = false
          if waited > Self.threshold { $0.stalls.append(StallRecord(t: sent - t0, ms: waited * 1000)) }
        }
      }
      tick()
    }
  }
}

/// CPU and memory every 250 ms, read off the main thread
final class Metrics: Sendable {
  private let t0: Double
  private let main: mach_port_t
  private let state = Mutex<(running: Bool, records: [MetricRecord], last: (t: Double, cpu: Double, main: Double)?)>(
    (false, [], nil))
  private let queue = DispatchQueue(label: "bug-report.metrics", qos: .utility)

  /// Made on the main thread: it takes the main thread's port
  @MainActor init(t0: Double) {
    self.t0 = t0
    main = mach_thread_self()
  }

  deinit { mach_port_deallocate(mach_task_self_, main) }

  func start() {
    state.withLock { $0.running = true }
    sample()
  }

  func stop() -> [MetricRecord] {
    state.withLock {
      $0.running = false
      return $0.records
    }
  }

  private func sample() {
    let now = Diag.now()
    let cpu = Self.processCPU()
    let mainCPU = Self.threadCPU(main)
    let footprint = Self.footprint()
    let go = state.withLock { s -> Bool in
      guard s.running else { return false }
      if let l = s.last, now > l.t {
        let dt = now - l.t
        s.records.append(
          MetricRecord(
            t: now - t0, cpu: Self.percent((cpu - l.cpu) / dt), mainCPU: Self.percent((mainCPU - l.main) / dt),
            footprintMB: (footprint / 1_048_576 * 10).rounded() / 10))
      }
      s.last = (now, cpu, mainCPU)
      return true
    }
    if go { queue.asyncAfter(deadline: .now() + .milliseconds(250)) { [self] in sample() } }
  }

  private static func percent(_ x: Double) -> Double { (x * 1000).rounded() / 10 }

  static func processCPU() -> Double {
    var u = rusage()
    getrusage(RUSAGE_SELF, &u)
    func s(_ t: timeval) -> Double { Double(t.tv_sec) + Double(t.tv_usec) / 1e6 }
    return s(u.ru_utime) + s(u.ru_stime)
  }

  static func threadCPU(_ thread: mach_port_t) -> Double {
    var info = thread_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        thread_info(thread, thread_flavor_t(THREAD_BASIC_INFO), $0, &count)
      }
    }
    guard kr == KERN_SUCCESS else { return 0 }
    func s(_ t: time_value_t) -> Double { Double(t.seconds) + Double(t.microseconds) / 1e6 }
    return s(info.user_time) + s(info.system_time)
  }

  static func footprint() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    return kr == KERN_SUCCESS ? Double(info.phys_footprint) : 0
  }
}

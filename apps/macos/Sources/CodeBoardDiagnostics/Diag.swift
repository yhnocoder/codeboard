import Foundation
import Synchronization

/// What the app says happened inside it while a bug report is being recorded (its app.jsonl). A call site is one line:
/// `Diag.event("edit", ["name": name])`. When nothing is recording the call is one relaxed load of a flag and nothing
/// else: the fields are an autoclosure, so they are never built.
public enum Diag {
  public struct Event: Sendable, Equatable {
    /// Seconds on the host clock (`Diag.now()`), the clock video frames and input events are stamped with
    public let t: Double
    public let name: String
    public let fields: [String: String]

    public init(t: Double, name: String, fields: [String: String]) {
      self.t = t
      self.name = name
      self.fields = fields
    }
  }

  private static let on = Atomic<Bool>(false)
  private static let events = Mutex<[Event]>([])
  /// Called with each event as it is recorded, on the thread that recorded it (the recorder follows board switches)
  private static let tap = Mutex<(@Sendable (Event) -> Void)?>(nil)

  public static var isRecording: Bool { on.load(ordering: .relaxed) }

  @inline(__always)
  public static func event(_ name: String, _ fields: @autoclosure () -> [String: String] = [:]) {
    guard on.load(ordering: .relaxed) else { return }
    record(Event(t: now(), name: name, fields: fields()))
  }

  private static func record(_ e: Event) {
    events.withLock { $0.append(e) }
    tap.withLock { $0 }?(e)
  }

  /// Starts keeping events (those kept before are dropped)
  public static func start(tap: (@Sendable (Event) -> Void)? = nil) {
    events.withLock {
      $0 = []
      $0.reserveCapacity(4096)
    }
    self.tap.withLock { $0 = tap }
    on.store(true, ordering: .relaxed)
  }

  /// Stops and hands over what was kept
  public static func stop() -> [Event] {
    on.store(false, ordering: .relaxed)
    tap.withLock { $0 = nil }
    return events.withLock {
      let out = $0
      $0 = []
      return out
    }
  }

  private static let timebase: Double = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return Double(info.numer) / Double(info.denom) / 1e9
  }()

  /// The host clock in seconds: mach_absolute_time, what NSEvent.timestamp, CADisplayLink and ScreenCaptureKit's sample
  /// times count in, so every file of a report lines up with the video
  public static func now() -> Double { Double(mach_absolute_time()) * timebase }
}

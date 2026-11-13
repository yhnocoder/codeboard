import CoreServices
import Foundation

/// Calls back on the main thread when anything under a folder changes, coalesced over 0.3 s
@MainActor final class VaultWatcher {
  private let onChange: @MainActor () -> Void
  private var stream: FSEventStreamRef?

  init(_ folder: URL, onChange: @escaping @MainActor () -> Void) {
    self.onChange = onChange
    var context = FSEventStreamContext(
      version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
    let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
      guard let info else { return }
      // The stream runs on the main queue (below)
      MainActor.assumeIsolated { Unmanaged<VaultWatcher>.fromOpaque(info).takeUnretainedValue().onChange() }
    }
    guard
      let stream = FSEventStreamCreate(
        nil, callback, &context, [folder.path] as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.3,
        FSEventStreamCreateFlags(kFSEventStreamCreateFlagNone))
    else { return }
    FSEventStreamSetDispatchQueue(stream, .main)
    FSEventStreamStart(stream)
    self.stream = stream
  }

  isolated deinit {
    guard let stream else { return }
    FSEventStreamStop(stream)
    FSEventStreamInvalidate(stream)
    FSEventStreamRelease(stream)
  }
}
